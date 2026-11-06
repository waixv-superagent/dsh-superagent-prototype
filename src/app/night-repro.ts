/**
 * The night reproduction queue (docs/029): while the deployment is idle inside the configured night window, the host
 * replays the local reproduction case of a delivered Ticket that waits for a person's local check. It starts one case at
 * a time, at most `perNight` cases a night, and only when the idle judgement says the machine is free — the shared editor
 * is not held by an agent or a host job, and no mainline Ticket is waiting for it.
 *
 * It is silent by construction: the class has no outbox, no Session prompt and no domain event, so a night run cannot wake
 * a person or the orchestrator. The run lands in the Ticket's `idle.repro` and in the same 复现用例 card a person's click
 * uses, so the result is already there when they come back in the morning.
 */
import { inWindow, minuteOfDay, nightKey, ticketStage, type IdleReproConfig, type Ticket,
  type TicketIdleRepro } from '../core/index.ts'
import type { ReproRun, ReproRunner } from './repro-runner.ts'
import { matchedReproCaseIds, readReproCases } from './repro.ts'
import type { IdleScheduler } from './idle.ts'
import type { Store } from './store.ts'

/** The heartbeat of the queue; a night run takes minutes, so a coarse look is enough. */
const HEARTBEAT_MS = 60_000

/** Host dependencies used by `NightRepro`. */
export interface NightReproHost {
  readonly store: Pick<Store, 'tickets' | 'settings'>
  /** The local case runner: the queue starts a case with it and reconciles the run it started. */
  readonly repro: Pick<ReproRunner, 'run' | 'tick' | 'root'>
  /** The five-signal judgement, so the queue only spends the editor when the machine is really idle. */
  readonly idle: Pick<IdleScheduler, 'state'>
  /** Why the shared editor may not be used now: an agent or a host job holds it (docs/024). */
  blocked(): 'agent' | 'job' | null
  now?(): Date
  warn?(message: string): void
}

/**
 * Starts at most one night case per heartbeat and reconciles the runs it already started. `start()` begins the heartbeat;
 * a caller with its own clock can call `tick()` directly, which is what the tests do.
 */
export class NightRepro {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  constructor(private readonly host: NightReproHost) {}

  /** Begins the heartbeat; the first look is immediate so a restarted host reconciles a run it left behind. */
  start(): void {
    if (this.timer) return
    this.look()
    this.timer = setInterval(() => { this.look() }, HEARTBEAT_MS)
    this.timer.unref?.()
  }
  /** Stops the heartbeat; the next host reconciles a run still in flight when it starts. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  /** One look: reconcile the runs already recorded, then start a case when the night allows one. */
  tick(): void {
    if (this.stopped) return
    const runs = this.host.repro.tick()
    this.reconcile(runs)
    const config = this.host.store.settings().executor.idle.repro
    if (!config.enabled) return
    const now = this.now()
    if (!inWindow(minuteOfDay(now), config.window.from, config.window.to)) return
    // One run at a time: the shared editor drives one case, and a second would fight the first (docs/024).
    if (runs.some(run => run.state === 'running')) return
    if (this.host.blocked()) return
    // The same five signals that hold back every idle launch: no mainline work, a free slot, the guard clear. A repro case
    // does not take a worker slot, but starting it while the mainline waits would still take the editor and the machine.
    if (!this.host.idle.state().level) return
    const night = nightKey(now, config.window)
    if (this.startedTonight(runs, night, config) >= config.perNight) return
    const next = this.nextTicket()
    if (!next) return
    this.startRun(next.ticket, next.caseId, night)
  }

  private now(): Date { return this.host.now?.() ?? new Date() }
  private warn(message: string): void { this.host.warn?.(`night repro: ${message}`) }
  private look(): void {
    try { this.tick() } catch (error) { this.warn(error instanceof Error ? error.message : String(error)) }
  }
  /** How many night-origin runs the current night already started, counted by the window's own date rather than midnight. */
  private startedTonight(runs: readonly ReproRun[], night: string, config: IdleReproConfig): number {
    return runs.filter(run => run.origin === 'night' && nightKey(new Date(run.startedAt), config.window) === night).length
  }
  /**
   * The delivered Ticket whose case the queue should replay: open, waiting for a person's local verification, with a
   * verification package that names a runnable local case, and not yet visited by the queue. The oldest pool entry first,
   * so a Ticket is not starved by newer deliveries.
   */
  private nextTicket(): { ticket: Ticket; caseId: string } | undefined {
    const found = readReproCases(this.host.repro.root())
    if (found.problem) return undefined
    const cases = found.cases.filter(item => !item.problem && !!item.command)
    if (!cases.length) return undefined
    return this.host.store.tickets.open()
      .filter(ticket => ticket.verification?.state === 'pending' && !!ticket.execution?.verification
        && !ticket.idle?.repro && ticketStage(ticket).stage !== 'working')
      .flatMap(ticket => {
        const [caseId] = matchedReproCaseIds(ticket.execution?.verification, cases, ticket.id)
        return caseId ? [{ ticket, caseId }] : []
      })
      .sort((left, right) => (left.ticket.idle?.enteredAt ?? left.ticket.createdAt).localeCompare(right.ticket.idle?.enteredAt ?? right.ticket.createdAt))[0]
  }
  /** Starts the case and records the run on the Ticket in one synchronous step, so a crash cannot leave the two apart. */
  private startRun(ticket: Ticket, caseId: string, night: string): void {
    let run: ReproRun
    try { run = this.host.repro.run(caseId, 'night') } catch (error) {
      // A person may have clicked the same case a moment before; the next heartbeat looks again.
      this.warn(error instanceof Error ? error.message : String(error))
      return
    }
    this.save(ticket, { caseId, runId: run.id, state: run.state, night, startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}), ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.summary ? { summary: run.summary } : {}), ...(run.report ? { report: run.report } : {}) })
  }
  /** Copies the final verdict of every run still marked running on its Ticket, so a person reads the run's own outcome. */
  private reconcile(runs: readonly ReproRun[]): void {
    for (const ticket of this.host.store.tickets.open()) {
      const recorded = ticket.idle?.repro
      if (recorded?.state !== 'running') continue
      const run = runs.find(item => item.id === recorded.runId)
      if (!run) {
        this.save(ticket, { ...recorded, state: 'interrupted', endedAt: this.now().toISOString(),
          summary: 'the run record is gone, so its output and verdict were lost' })
        continue
      }
      if (run.state === 'running') continue
      this.save(ticket, { ...recorded, state: run.state, ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}), ...(run.summary ? { summary: run.summary } : {}),
        ...(run.report ? { report: run.report } : {}) })
    }
  }
  /** Writes the night record on the Ticket, keeping the rest of the aggregate as it was read in this same synchronous step. */
  private save(ticket: Ticket, repro: TicketIdleRepro): void {
    this.host.store.tickets.save({ ...ticket, idle: { ...ticket.idle ?? { enteredAt: ticket.createdAt }, repro }, updatedAt: this.now().toISOString() })
  }
}
