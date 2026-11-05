/**
 * The shared editor's gatekeeper (docs/021). The scheduler decides who holds the slot and the lease guard reads a
 * worker's shell commands, but neither owns the editor's operating-system processes: a heartbeat that stops, a Ticket
 * that ends or a person who preempts used to leave the editor or build running, and the queue moved on while the next
 * holder opened a second editor. The gatekeeper is the resident process that closes that gap. It takes ownership of
 * the editor, commandlet and build processes a lease starts (from the guard's exact match, or from the process table),
 * and on every sweep it stops the ones whose lease has lapsed — no heartbeat, Ticket ended or process reclaimed. It
 * also gives a holder one gated way to close its editor (`close`), so stopping is a host decision, not a script's.
 *
 * Only what the gatekeeper adopted is ever stopped, and only after the probe still shows the same process; a person's
 * editor, an editor a person yielded and a process whose pid was recycled are all left alone. The probe, the ue-mcp
 * bridge files and the job logs stay collection only; the gatekeeper never reads them for content.
 */
import { KV } from '../kv.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { EditorProcess } from './editor.ts'
import type { EditorLease } from './editor-schedule.ts'
import type { EditorScheduler } from './editor-scheduler.ts'

/**
 * How often the gatekeeper compares the lease with the process table. It is shorter than the scheduler's own tick so a
 * lapsed lease is reclaimed before the next holder can start a second editor; the process table is the candidate
 * editor's cached probe, so a sweep costs no PowerShell of its own.
 */
export const GATEKEEPER_SWEEP_MS = 5_000
/** Where a managed process may have started relative to its grant: the probe and the grant arrive a moment apart. */
const ADOPT_SLACK_MS = 5_000
/** Interactive editors, headless commandlets and build tools: the only processes a lease can own and the host may stop. */
const INTERACTIVE = 'unrealeditor'
const HEADLESS = 'unrealeditor-cmd'
const BUILD = 'unrealbuildtool'
const SHADER = 'shadercompileworker'
const STOPPABLE = new Set([INTERACTIVE, HEADLESS, BUILD, SHADER])

/** What a Ticket needed the editor for, as far as the owned process is concerned. */
export type OwnedKind = 'editor' | 'commandlet' | 'build'

/** One process a lease started; persisted so a heartbeat that stops after a host restart is still reclaimed. */
export interface OwnedProcess {
  /** The lease that owns it; a new grant has a new id, which is how a survivor is told from a stale one. */
  leaseId: string
  ticketId: string
  pid: number
  kind: OwnedKind
  /** The probe's start time when it was adopted; a pid whose start time changed is a recycled pid and is left alone. */
  started: string | null
  /** The lease's expiry when it was adopted, so a reclaim after the lease record is gone still knows about the heartbeat. */
  expiresAt: string | null
}

/** What the gatekeeper keeps: the processes it owns and how many it has reclaimed. */
export interface GatekeeperState {
  owned: OwnedProcess[]
  reclaimed: number
}

export const emptyGatekeeper = (): GatekeeperState => ({ owned: [], reclaimed: 0 })

/** What the gatekeeper needs from the host; every effect is injected so a test can watch the decisions. */
export interface EditorGatekeeperHost {
  readonly store: {
    get<V>(key: string & { readonly __value?: V }): V | undefined
    set<V>(key: string & { readonly __value?: V }, value: V): void
  }
  /** The schedule whose leases the gatekeeper enforces; `reclaim` records the event and grants the next waiter. */
  readonly schedule: Pick<EditorScheduler, 'read' | 'reclaim' | 'release'>
  /** The probe's latest rows, or null before the first probe finishes; a sweep never runs a probe of its own. */
  rows(): readonly EditorProcess[] | null
  alive(pid: number): boolean
  kill(pid: number): void
  live(ticketId: string): boolean
  notify(ticketId: string, id: string, text: string): Promise<void>
  /** The `editor-gatekeeper` health entry. */
  health: HealthEntry
  warn(message: string): void
  now?(): number
  /** Replaces the sweep interval in tests. */
  intervalMs?: number
}

export interface GatekeeperStatus {
  /** Live managed processes now. */
  owned: number
  /** Processes stopped after their lease lapsed, since the host's state was created. */
  reclaimed: number
  /** Sweeps completed since start. */
  sweeps: number
  lastSweep: string | null
  /** The last reclamation, as the overview would read it. */
  lastReclaim: { at: string; detail: string } | null
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The Ticket a lease belongs to; a person's claim and a multi-Ticket job have none for this purpose. */
function leaseTicket(lease: EditorLease | null): string | undefined {
  return lease?.holder.kind === 'agent' ? lease.holder.ticketId : undefined
}

/** Whether the process the probe reports now is still the one the gatekeeper adopted, not a recycled pid. */
export function sameProcess(rows: readonly EditorProcess[], owned: OwnedProcess): boolean {
  const row = rows.find(value => value.pid === owned.pid)
  if (!row || !STOPPABLE.has(row.name)) return false
  // A start time the probe could not report on either side is not a mismatch; the pid and the editor name still agree.
  return !owned.started || !row.started || owned.started === row.started
}

/**
 * The processes a lease has started but the guard did not hand over, read from the process table: an interactive
 * editor for `use`/`restart` (the same one-new-editor rule `advance` uses, so an ambiguous pair stays a person's), a
 * headless commandlet for `test`, and build tools for `build`. This is what makes the gatekeeper independent of the
 * shell text: a batch script, an MCP tool or a subagent that starts the editor is owned all the same.
 */
export function freshProcesses(lease: EditorLease, rows: readonly EditorProcess[], agentPids: readonly number[],
  yielded: readonly number[]): EditorProcess[] {
  const since = Date.parse(lease.acquiredAt) - ADOPT_SLACK_MS
  const fresh = (name: string) => rows.filter(row => row.name === name && row.started !== null
    && Date.parse(row.started) >= since && !yielded.includes(row.pid))
  switch (lease.purpose) {
    case 'use':
    case 'restart': {
      const editors = fresh(INTERACTIVE)
      const known = new Set([...agentPids, ...yielded])
      const others = rows.filter(row => row.name === INTERACTIVE && !known.has(row.pid) && !editors.some(value => value.pid === row.pid))
      // Two new editors, or an older one that is not the agent's, cannot be told apart; leave both alone.
      return editors.length === 1 && others.length === 0 ? editors : []
    }
    case 'test':
      return fresh(HEADLESS)
    case 'build':
      return rows.filter(row => (row.name === BUILD || row.name === SHADER) && row.started !== null && Date.parse(row.started) >= since)
  }
}

/** Owns the shared editor's processes and reclaims a lease whose heartbeat stopped. */
export class EditorGatekeeper {
  private timer?: ReturnType<typeof setInterval>
  private disposed = false
  private inFlight?: Promise<void>
  private readonly notified = new Set<string>()
  private sweeps = 0
  private lastSweep: string | null = null
  private lastReclaim: { at: string; detail: string } | null = null
  private lastError?: string
  constructor(private readonly host: EditorGatekeeperHost) {}

  private now(): number { return (this.host.now ?? Date.now)() }

  read(): GatekeeperState { return { ...emptyGatekeeper(), ...this.host.store.get(KV.editor.gatekeeper) } }

  private write(state: GatekeeperState): void {
    this.host.store.set(KV.editor.gatekeeper, { owned: state.owned, reclaimed: state.reclaimed })
  }

  /** What the panel's health entry and a status read report. */
  status(): GatekeeperStatus {
    return { owned: this.read().owned.length, reclaimed: this.read().reclaimed, sweeps: this.sweeps, lastSweep: this.lastSweep,
      lastReclaim: this.lastReclaim }
  }

  /** Begins the sweep loop and runs one sweep at once; a lapsed lease from before a restart is reclaimed then too. */
  start(): void {
    if (this.timer !== undefined) return
    this.disposed = false
    this.timer = setInterval(() => { void this.sweep() }, this.host.intervalMs ?? GATEKEEPER_SWEEP_MS)
    this.timer.unref?.()
    void this.sweep()
  }

  /** Stops the loop and waits for a sweep already running, so no close reaches a closed Store. */
  async stop(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  /**
   * Takes ownership of one process a Ticket's lease started. The guard calls this with the exact pid it matched to the
   * worker's shell command; the sweep calls it for what the process table shows. A Ticket that does not hold the editor
   * owns nothing.
   */
  adopt(ticketId: string, pid: number, kind: OwnedKind, started: string | null = null): boolean {
    if (this.disposed || !Number.isInteger(pid) || pid <= 0) return false
    const lease = this.host.schedule.read().lease
    if (!lease || leaseTicket(lease) !== ticketId) return false
    const state = this.read()
    const known = state.owned.find(value => value.pid === pid)
    if (known) {
      // The same Ticket re-acquired the editor with its process still open: the new lease owns it now, not the old one.
      known.leaseId = lease.id
      known.ticketId = ticketId
      known.expiresAt = lease.expiresAt
      known.started = started ?? known.started
    } else {
      state.owned.push({ leaseId: lease.id, ticketId, pid, kind, started, expiresAt: lease.expiresAt })
    }
    this.write(state)
    return true
  }

  /**
   * A holder closes the editor it started and gives the lease back. The gatekeeper stops only the processes this
   * Ticket's current lease owns, so a stale or a person's editor is never a target; the caller must hold the lease.
   */
  close(ticketId: string): { closed: number } {
    const lease = this.host.schedule.read().lease
    if (!lease || leaseTicket(lease) !== ticketId) throw new Error('this Ticket does not hold the editor')
    const rows = this.host.rows()
    const state = this.read()
    let closed = 0
    state.owned = state.owned.filter(owned => {
      const mine = owned.leaseId === lease.id && owned.ticketId === ticketId
      if (!mine) return true
      // An empty probe has not seen the process yet; the holder's exact adoption is still the right pid to stop.
      if (this.host.alive(owned.pid) && (!rows?.length || sameProcess(rows, owned))) {
        this.host.kill(owned.pid)
        closed++
      }
      return false
    })
    this.write(state)
    this.host.schedule.release(ticketId, closed ? `closed ${closed} process(es) it started` : 'closed by its holder')
    this.refreshHealth()
    return { closed }
  }

  /**
   * One sweep: adopt what the current agent lease started, then stop the processes whose lease is gone or whose
   * heartbeat lapsed, record the reclamation, tell a live holder what happened, and let the scheduler grant the next
   * waiter. A person's claim is never a reclaim target. Nothing is killed before the probe has seen the process, so a
   * stale pid after a restart is not mistaken for an editor.
   */
  async sweep(): Promise<void> {
    if (this.disposed) return
    if (this.inFlight) return this.inFlight
    const work = Promise.resolve().then(() => { this.sweepOnce() })
    this.inFlight = work
    try { await work } catch (error) {
      this.warn(`the sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { if (this.inFlight === work) this.inFlight = undefined }
  }

  private sweepOnce(): void {
    const now = this.now()
    const schedule = this.host.schedule.read()
    const rows = this.host.rows()
    const state = this.read()
    let dirty = false
    const reclaim = new Map<string, { ticketId: string; reason: string; pids: number[] }>()
    const kept: OwnedProcess[] = []

    if (rows) {
      const lease = schedule.lease
      if (lease && lease.holder.kind === 'agent') {
        for (const row of freshProcesses(lease, rows, schedule.agentPids, schedule.yielded?.pids ?? [])) {
          if (state.owned.some(owned => owned.pid === row.pid)) continue
          const kind: OwnedKind = row.name === INTERACTIVE ? 'editor' : row.name === HEADLESS ? 'commandlet' : 'build'
          state.owned.push({ leaseId: lease.id, ticketId: lease.holder.ticketId, pid: row.pid, kind, started: row.started,
            expiresAt: lease.expiresAt })
          dirty = true
        }
        // An editor a previous agent lease or a host restart job opened still reads as the agent's in `agentPids`. The
        // current holder owns it too, so a released or lapsed editor left open is closed instead of outliving its slot.
        if (lease.purpose === 'use' || lease.purpose === 'restart') {
          const ownedPids = new Set(state.owned.map(owned => owned.pid))
          for (const row of rows) {
            if (row.name !== INTERACTIVE || ownedPids.has(row.pid) || !schedule.agentPids.includes(row.pid)
              || schedule.yielded?.pids.includes(row.pid)) continue
            state.owned.push({ leaseId: lease.id, ticketId: lease.holder.ticketId, pid: row.pid, kind: 'editor',
              started: row.started, expiresAt: lease.expiresAt })
            dirty = true
          }
        }
      }
    }

    for (const owned of state.owned) {
      const current = schedule.lease
      // A worker that released and acquired again keeps the interactive editor it already started; the new lease owns
      // it. A build or commandlet does not survive its lease that way: those end with the work that asked for them.
      if (current && current.id !== owned.leaseId && owned.kind === 'editor' && leaseTicket(current) === owned.ticketId
        && this.host.live(owned.ticketId) && this.host.alive(owned.pid)) {
        owned.leaseId = current.id
        owned.expiresAt = current.expiresAt
        kept.push(owned)
        dirty = true
        continue
      }
      if (!this.host.alive(owned.pid)) { dirty = true; continue }
      const reason = this.lapsed(schedule.lease, owned, now)
      if (!reason) { kept.push(owned); continue }
      // Nothing has looked at the process table yet: keep it for the next sweep instead of guessing.
      if (!rows) { kept.push(owned); continue }
      // The probe no longer shows the process the gatekeeper adopted (gone, or a recycled pid); it is not its to stop.
      if (!sameProcess(rows, owned)) { dirty = true; continue }
      this.host.kill(owned.pid)
      state.reclaimed += 1
      dirty = true
      const group = reclaim.get(owned.leaseId) ?? { ticketId: owned.ticketId, reason, pids: [] }
      group.pids.push(owned.pid)
      reclaim.set(owned.leaseId, group)
    }
    state.owned = kept
    if (dirty) this.write(state)

    for (const [leaseId, value] of reclaim) {
      const what = `${value.pids.length} process(es) pid ${value.pids.join(', ')}`
      const detail = `closed ${what} after ${value.reason}`
      const ending = value.reason === 'the heartbeat lapsed' ? 'expired' : value.reason === 'the Ticket ended' ? 'ended' : 'released'
      this.host.schedule.reclaim(leaseId, detail, ending)
      this.lastReclaim = { at: iso(now), detail }
      if (value.reason === 'the heartbeat lapsed' && this.host.live(value.ticketId) && !this.notified.has(leaseId)) {
        this.notified.add(leaseId)
        void this.host.notify(value.ticketId, `editor-reclaim:${leaseId}`,
          `Your shared editor lease lapsed without a heartbeat, so the gatekeeper closed the ${what} it started. `
          + 'Acquire the editor again if the work still needs it, and heartbeat during long steps.').catch(error => {
          this.host.warn(`editor reclaim notice failed: ${String(error)}`)
        })
      }
    }
    if (reclaim.size) this.refreshHealth()
    this.finishSweep(now)
  }

  /** Why this owned process must be closed now, or null while its lease still holds the slot. */
  private lapsed(lease: EditorLease | null, owned: OwnedProcess, now: number): string | null {
    if (lease?.id === owned.leaseId) {
      // A person's claim holds every agent process back; the scheduler drains and lapses the agent's own lease first.
      if (lease.holder.kind === 'person') return null
      if (lease.expiresAt !== null && Date.parse(lease.expiresAt) <= now) return 'the heartbeat lapsed'
      if (lease.holder.kind === 'agent' && !this.host.live(lease.holder.ticketId)) return 'the Ticket ended'
      return null
    }
    // The owning lease is no longer the current one: it was released, ended or replaced.
    if (owned.expiresAt !== null && Date.parse(owned.expiresAt) <= now) return 'the heartbeat lapsed'
    if (!this.host.live(owned.ticketId)) return 'the Ticket ended'
    return 'the lease ended'
  }

  private finishSweep(now: number): void {
    this.sweeps += 1
    this.lastSweep = iso(now)
    // A sweep that completed clears the last failure; the health entry stops reporting an old error.
    this.lastError = undefined
    this.refreshHealth()
  }

  /** Mirrors what is owned into the `editor-gatekeeper` health entry; a lapsed sweep is an error. */
  private refreshHealth(): void {
    const { owned, reclaimed } = this.read()
    const at = iso(this.now())
    const parts = [`${owned} process(es) of the shared editor belong to a lease`, `${reclaimed} reclaimed`]
    if (this.lastSweep) parts.push(`last sweep ${this.lastSweep}`)
    if (this.lastError) {
      this.host.health.set({ state: 'error', detail: `The editor gatekeeper's last sweep failed: ${this.lastError}`, at })
      return
    }
    this.host.health.set({ state: 'ready', detail: `Editor gatekeeper: ${parts.join('; ')}`, at })
  }

  private warn(message: string): void {
    this.lastError = message
    this.refreshHealth()
    this.host.warn(message)
  }
}
