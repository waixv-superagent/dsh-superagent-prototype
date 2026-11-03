/**
 * The host's recovery from a passing outage of the model gateway or the network — the deployment's UPS. It keeps the control plane
 * alive: a main Session whose turn ended on such a failure is told to go on after a growing backoff, and one that disappeared is
 * created again. It also retries a Ticket whose worker stopped on the same kind of failure, so one outage does not leave every
 * Ticket waiting for a person. A Ticket a person already continued, a failure a later try would meet again (an exhausted account
 * quota, a credential, an oversized context) and paused processing are left alone; a failure chain past its last retry waits for a
 * person (see docs/003).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { latestAssignment, waitsForPerson, type EngineForWatchdog, type Ticket } from '../core/index.ts'
import { transient } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Sessions } from './sessions.ts'

/** The retry delays after a passing failure: 1, 2, 5, 10, 15 and 30 minutes, the last one repeated. */
export const RECOVERY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000] as const
/** How many automatic retries one failure chain gets before the host leaves it to a person: about four hours. */
export const RECOVERY_TRIES = 12
/** The heartbeat that looks for work to recover and keeps the main Session alive. */
const HEARTBEAT_MS = 10_000
/** How long a main Session retry waits while the Session runs or processing is paused. */
const LOOK_AGAIN_MS = 5_000
/** The longest failure text the host repeats in a message or a health detail. */
const MAX_MESSAGE = 300
/** Host dependencies used by `Watchdog`. */
export interface WatchdogHost {
  /** DeepSeek Harness's agents and their events, for the main Session. */
  readonly context: Context
  /** The open Tickets to scan; the watchdog filters them to a passing failure a worker stopped on. */
  readonly tickets: { open(): Ticket[] }
  readonly engine: Pick<EngineForWatchdog, 'recoverTicket'>
  /** The main Session: its id, the title it is created with, and the directory it runs in. */
  readonly master: { readonly id: string; readonly title: string; directory(): string }
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt'>
  /** The `watchdog` health entry. */
  readonly health: HealthEntry
  /** Whether processing is paused, which holds every recovery until it resumes. */
  paused(): boolean
  now?(): number
  /** One failed recovery is logged and does not stop the others. */
  warn?(message: string): void
}
/** One ticket's retries of a passing failure: how many it has had, the report they started from, and when the next is due. */
interface Recovery { attempts: number; reportAt: string; nextAt: number }
/** The main Session's failed turn: the next retry attempt and the failure it repeats. */
interface MasterFailure { attempts: number; message: string }
/** What the watchdog is recovering now, which the state API reports and the Feishu status card shows. */
export interface WatchdogStatus {
  /** Whether a passing failure is being recovered: a Ticket waits for or runs an automatic retry, or the main Session is retried. */
  readonly recovering: boolean
  /** Tickets whose worker stopped on a passing failure and that wait for, or run, an automatic retry. */
  readonly tickets: number
  /** Whether the main Session's failed turn is in its retry chain. */
  readonly master: boolean
  /** Whether the main Session's chain used its last try and waits for a person. */
  readonly gaveUp: boolean
  /** Whether the main Session is missing and could not be created again on the last look. */
  readonly missing: boolean
}

/**
 * Watches the main Session and the open Tickets for a passing model or network failure and retries them on its own. `start` begins
 * the heartbeat and event watches, `poll` runs one scan of the Tickets for tests and the heartbeat, and `masterTurnFailed` starts
 * the main Session's retry chain that a `session/event` turn end clears again.
 */
export class Watchdog {
  private timer?: ReturnType<typeof setInterval>
  private masterTimer?: ReturnType<typeof setTimeout>
  private readonly disposers: (() => void)[] = []
  /** The retry chain of each Ticket, by ticket id. */
  private readonly recovered = new Map<string, Recovery>()
  private masterFailure?: MasterFailure
  /** Whether the main Session is missing and creating it failed on the last look. */
  private masterDown = false
  /** Whether the main Session's retry chain used its last try and waits for a person. */
  private masterGaveUp = false
  private inFlight?: Promise<void>
  private started = false
  private stopped = false
  constructor(private readonly host: WatchdogHost) {}

  /** Begin the heartbeat and the main-Session watches; the first look runs at once. */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.disposers.push(this.host.context.on('agent/error', ({ agent, error }) => {
      if (agent.id === this.host.master.id) this.masterTurnFailed(error)
    }))
    // A turn that ended without an error means the conversation is not stuck on the failure.
    this.disposers.push(this.host.context.on('session/event', (session, event) => {
      if (session.id !== this.host.master.id || event.type !== 'turn/end') return
      const reason = (event.data as { reason?: { kind?: string } }).reason
      if (reason?.kind !== 'error') this.masterRecovered()
    }))
    this.timer = setInterval(() => { void this.tick() }, HEARTBEAT_MS)
    this.timer.unref?.()
    void this.tick()
  }

  /** Stop the heartbeat and the watches, and wait for a scan already running, so no recovery reaches a closed Store. */
  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.masterTimer !== undefined) clearTimeout(this.masterTimer)
    this.timer = undefined
    this.masterTimer = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
    this.masterFailure = undefined
    await this.inFlight
  }

  /** One heartbeat: make sure the main Session exists, then retry the Tickets whose backoff is due. */
  private tick(): void {
    if (this.stopped) return
    void this.ensureMaster()
    void this.poll()
  }

  /**
   * Retries every open Ticket whose worker stopped on a passing failure and whose backoff is due, oldest report first. A failed
   * attempt is logged and dropped from the chain; a chain past `RECOVERY_TRIES` waits for a person.
   */
  async poll(now = this.now()): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.stopped) return
    const work = Promise.resolve().then(() => { this.sweep(now) })
    this.inFlight = work
    try { await work } finally { if (this.inFlight === work) this.inFlight = undefined }
  }

  /** Creates the main Session again when it disappeared; returns whether it exists afterwards. */
  async ensureMaster(): Promise<boolean> {
    if (this.stopped) return false
    if (this.host.context.agents.get(this.host.master.id as SessionId)) {
      if (this.masterDown) { this.masterDown = false; this.refresh(this.now()) }
      return true
    }
    try {
      await this.host.sessions.ensure(this.host.master.id, this.host.master.directory(), this.host.master.title, 'orchestrator')
      this.masterDown = false
      return true
    } catch (error) {
      this.masterDown = true
      this.host.warn?.(`the main Session could not be created again: ${failureText(error)}`)
      this.refresh(this.now())
      return false
    }
  }

  /** Reports what is being recovered now, which `/orchestrator/api/state` carries and the Feishu status card shows. */
  status(): WatchdogStatus {
    const tickets = this.recovered.size, master = this.masterFailure !== undefined
    return { recovering: tickets > 0 || master, tickets, master, gaveUp: this.masterGaveUp, missing: this.masterDown }
  }

  /**
   * Starts or continues the main Session's retry chain after a turn failed for a passing reason. A later passing failure of the
   * same outage keeps the chain's count; a turn end that is not an error clears it (`masterRecovered`).
   */
  masterTurnFailed(error: unknown): void {
    if (this.stopped || !transient(error)) return
    this.masterGaveUp = false
    const failure = this.masterFailure
    if (failure) failure.message = failureText(error)
    else this.masterFailure = { attempts: 0, message: failureText(error) }
    if (this.masterTimer === undefined) this.armMaster(this.delay(this.masterFailure?.attempts ?? 0))
    this.refresh(this.now())
  }

  /** One due retry of the main Session: tell it to go on, or wait again while it runs or processing is paused. */
  private async masterAttempt(): Promise<void> {
    const failure = this.masterFailure
    if (this.stopped || !failure) return
    if (this.host.paused()) { this.armMaster(LOOK_AGAIN_MS); return }
    const agent = this.host.context.agents.get(this.host.master.id as SessionId)
    if (agent?.status === 'running') { this.armMaster(LOOK_AGAIN_MS); return }
    if (failure.attempts >= RECOVERY_TRIES) {
      this.host.warn?.(`the main Session still fails for a passing reason after ${failure.attempts} automatic retries; leaving it to a person`)
      this.masterFailure = undefined
      if (this.masterTimer !== undefined) clearTimeout(this.masterTimer)
      this.masterTimer = undefined
      this.masterGaveUp = true
      this.refresh(this.now())
      return
    }
    failure.attempts += 1
    const text = `Your last turn failed for a passing reason (${failure.message}). Continue with the work that reached you; the `
      + 'messages that arrived meanwhile are in your history. Do not repeat actions that already succeeded.'
    try {
      if (!agent) await this.ensureMaster()
      await this.host.sessions.prompt(this.host.master.id, `recover:master:${failure.attempts}`, text, 'queue')
    } catch (error) {
      this.host.warn?.(`the main Session could not be told to go on: ${failureText(error)}`)
    } finally {
      if (!this.stopped && this.masterFailure === failure) { this.armMaster(this.delay(failure.attempts)); this.refresh(this.now()) }
    }
  }

  /** Clears the main Session's retry chain: a turn ended as turns do, so the conversation is not stuck on the failure. */
  private masterRecovered(): void {
    if (!this.masterFailure && !this.masterGaveUp) return
    this.masterFailure = undefined
    this.masterGaveUp = false
    if (this.masterTimer !== undefined) clearTimeout(this.masterTimer)
    this.masterTimer = undefined
    this.refresh(this.now())
  }

  /** Arms one main-Session retry, replacing a later attempt already waiting. */
  private armMaster(ms: number): void {
    if (this.masterTimer !== undefined) clearTimeout(this.masterTimer)
    this.masterTimer = undefined
    if (this.stopped || !this.masterFailure) return
    const timer = setTimeout(() => { this.masterTimer = undefined; void this.masterAttempt() }, ms)
    timer.unref?.()
    this.masterTimer = timer
  }

  /** One scan of the open Tickets: keep or drop each retry chain, then recover the due ones. */
  private sweep(now: number): void {
    if (this.host.paused()) { this.refresh(now); return }
    const open = this.host.tickets.open()
    const openIds = new Set(open.map(ticket => ticket.id))
    for (const id of this.recovered.keys()) if (!openIds.has(id)) this.recovered.delete(id)
    for (const ticket of open) {
      const report = latestAssignment(ticket)?.report
      if (!report || report.state !== 'failed' || !waitsForPerson(ticket) || ticket.attention || ticket.delivery
        || !transient(report.summary)) {
        // A retry of ours that is still starting or running keeps its chain; any other state ends it.
        if (!this.retrying(ticket)) this.recovered.delete(ticket.id)
        continue
      }
      let recovery = this.recovered.get(ticket.id)
      if (!recovery || recovery.reportAt !== report.at) {
        // Our own earlier retry keeps the count; a person's retry or a first failure starts the chain again.
        const attempts = ticket.assignments.at(-2)?.endedReason === 'recovered' && recovery ? recovery.attempts : 0
        const failedAt = Date.parse(report.at)
        recovery = { attempts, reportAt: report.at, nextAt: Number.isNaN(failedAt) ? now : Math.max(now, failedAt + this.delay(attempts)) }
        this.recovered.set(ticket.id, recovery)
      }
      if (now < recovery.nextAt) continue
      if (recovery.attempts >= RECOVERY_TRIES) { this.recovered.delete(ticket.id); continue }
      try {
        this.host.engine.recoverTicket(ticket.id)
        recovery.attempts += 1
        recovery.nextAt = now + this.delay(recovery.attempts)
      } catch (error) {
        this.host.warn?.(`ticket ${ticket.id} could not be retried after a passing failure: ${failureText(error)}`)
        this.recovered.delete(ticket.id)
      }
    }
    this.refresh(now)
  }

  /** Whether the Ticket is running the assignment the host retried after a passing failure, which keeps that chain's count. */
  private retrying(ticket: Ticket): boolean {
    const latest = latestAssignment(ticket)
    return !!latest && !latest.report && (latest.state === 'pending' || latest.state === 'running')
      && ticket.assignments.at(-2)?.endedReason === 'recovered'
  }

  /** The backoff after `attempts` retries: the delay list, its last value repeated. */
  private delay(attempts: number): number {
    return RECOVERY_DELAYS_MS[Math.min(attempts, RECOVERY_DELAYS_MS.length - 1)]!
  }

  /** Mirrors the recovery state into the `watchdog` health entry: an error while recovery waits, ready when nothing does. */
  private refresh(now: number): void {
    const at = new Date(now).toISOString()
    const tickets = this.recovered.size, master = this.masterFailure
    const parts: string[] = []
    if (tickets) parts.push(`${tickets} ticket(s) stopped on a passing failure wait for an automatic retry`)
    if (master) parts.push(`the main Session is retried after a passing failure (attempt ${master.attempts + 1})`)
    if (this.masterDown) parts.push('the main Session is missing and could not be created again')
    if (this.masterGaveUp) parts.push('the main Session still failed for a passing reason after its last automatic retry and waits for a person')
    if (!parts.length) {
      this.host.health.set({ state: 'ready', detail: 'No passing model or network failure waits for automatic recovery', at })
      return
    }
    this.host.health.set({ state: 'error', detail: `Automatic recovery: ${parts.join('; ')}`, at })
  }

  private now(): number { return this.host.now?.() ?? Date.now() }
}
/** One failure's text on one line, bounded for a message or a health detail. */
function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
}
