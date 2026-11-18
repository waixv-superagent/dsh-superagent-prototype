/**
 * Deploys a merged hot self-iteration change. A ticket whose change is `hot` ships by replacing this plugin's package, so
 * once its pull request merges the host runs the same two-phase update the panel offers — build the new commit, then restart
 * into it while no worker is mid-turn — and records the outcome on that ticket. A `package` change waits for a person to
 * build and install its desktop app instead (docs/006). The journal lives under the state directory, so a host that starts
 * after the restart keeps the deployment it was running and tells whether it landed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ticket, TicketDeploy } from '../core/model.ts'
import { ticketUpdateTrack } from '../core/update-track.ts'
import type { Upgrade } from './upgrade.ts'

/** One merged hot change waiting to be deployed, as the journal keeps it across a restart. */
export interface DeployEntry {
  ticketId: string
  state: TicketDeploy['state']
  at: string
  /** The commit the update builds, once the build started. */
  sha?: string
  /** Why it failed, in words a person can act on. */
  detail?: string
}
export interface DeployWatchHost {
  stateDir: string
  upgrade: Pick<Upgrade, 'enabled' | 'autoDeploy' | 'check' | 'prepare' | 'apply' | 'view'>
  /** Records the deployment on the ticket whose change it carries. */
  record(ticketId: string, deploy: TicketDeploy): void
  warn(message: string): void
  now?: () => number
}
/** How often a running deployment looks at the update it started. */
const POLL_MS = 15_000
/** A restart that waited this long for idle is reported instead of being asked to start again. */
const APPLY_GIVE_UP_MS = 10 * 60_000
/** How many finished deployments the journal keeps. */
const KEEP = 20
const TERMINAL = ['applied', 'failed'] as const

/**
 * Starts, follows and records the automatic update of a merged hot change. It never deploys a package change and never
 * touches one a person started otherwise: the panel's dialog keeps working as before, and a person's cancel wins.
 */
export class DeployWatch {
  private entries: DeployEntry[] = []
  private timer?: ReturnType<typeof setInterval>
  private driving = false
  private stopped = false
  private readonly now: () => number
  constructor(private readonly host: DeployWatchHost) {
    this.now = host.now ?? Date.now
    this.entries = this.read()
  }
  private get journal(): string { return join(this.host.stateDir, 'deploy', 'status.json') }
  private iso(): string { return new Date(this.now()).toISOString() }

  /** Begin following the deployments the journal kept; a finished one is reconciled against the running build first. */
  start(): void {
    if (this.stopped) return
    this.reconcile()
    this.timer = setInterval(() => { this.tick() }, POLL_MS)
    this.timer.unref?.()
    this.tick()
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  /**
   * A ticket ended: when its change was hot and merged, deploy it unless this deployment turned that off, the ticket was
   * already handled, or the update channel is not configured.
   */
  ended(ticket: Ticket): void {
    if (this.stopped || !this.host.upgrade.enabled || !this.host.upgrade.autoDeploy) return
    if (ticket.ended?.outcome !== 'merged') return
    if (ticketUpdateTrack(ticket)?.track !== 'hot') return
    if (this.entries.some(entry => entry.ticketId === ticket.id)) return
    this.entries.push({ ticketId: ticket.id, state: 'preparing', at: this.iso() })
    this.changed(this.entries.at(-1)!)
    void this.drive()
  }
  /** The deployment one ticket got, for a reader that asks; the ticket's own record is the source of truth. */
  entry(ticketId: string): DeployEntry | undefined { return this.entries.find(entry => entry.ticketId === ticketId) }
  /** Start the build of the oldest change that is still waiting; one update runs at a time, so the others wait their turn. */
  private async drive(): Promise<void> {
    if (this.driving || this.stopped) return
    const entry = this.entries.find(item => item.state === 'preparing')
    if (!entry) return
    this.driving = true
    try {
      await this.host.upgrade.check()
      if (this.stopped) return
      const view = this.host.upgrade.view()
      // The running build already is the newest remote commit, such as when a person updated while this waited.
      if (view.remote.sha !== null && view.remote.sha === view.installed) { this.settle(entry, 'applied', 'the running build already contains the merge'); return }
      if (view.remote.sha === null) { this.settle(entry, 'failed', view.remote.error ?? 'the update checkout has no remote commit to build'); return }
      if (view.blocked !== null) { this.settle(entry, 'failed', `the update cannot install itself (${view.blocked}); run the manual upgrade steps`); return }
      try {
        entry.sha = this.host.upgrade.prepare().sha
        this.changed(entry)
      } catch (error) {
        const code = (error as { code?: string }).code ?? String((error as Error).message ?? error)
        // A build already waiting is reused; another update running is waited for, and the next tick asks again.
        if (code === 'prepared') {
          const sha = this.host.upgrade.view().prepared?.sha
          if (sha) { entry.sha = sha; this.settle(entry, 'ready', '') }
          return
        }
        if (code === 'running') return
        if (code === 'current') { this.settle(entry, 'applied', 'the running build already contains the merge'); return }
        this.settle(entry, 'failed', `the update did not start: ${code}`)
      }
    } finally {
      this.driving = false
    }
  }
  /** Follow the update every waiting deployment started, and restart into it once its build is ready. */
  private tick(): void {
    if (this.stopped) return
    const view = this.host.upgrade.view()
    for (const entry of this.entries) {
      if ((TERMINAL as readonly string[]).includes(entry.state)) continue
      if (entry.sha !== undefined && view.installed === entry.sha) { this.settle(entry, 'applied', ''); continue }
      if (entry.state === 'preparing') {
        if (entry.sha === undefined) continue
        if (view.run?.sha !== entry.sha) { this.settle(entry, 'failed', 'the update this deployment started disappeared'); continue }
        if (['failed', 'down', 'rolledBack', 'cancelled'].includes(view.run.state)) {
          this.settle(entry, 'failed', view.run.error ?? 'the update did not finish')
          continue
        }
        if (view.run.state !== 'prepared') continue
        // The build is ready: the restart is the next step of this same tick, so a prepared build never waits for a poll.
        this.settle(entry, 'ready', '')
      }
      if (entry.state === 'ready') {
        try {
          this.host.upgrade.apply(false)
          this.settle(entry, 'applying', '')
        } catch (error) {
          const code = (error as { code?: string }).code ?? String((error as Error).message ?? error)
          if (code === 'missing-build') this.settle(entry, 'failed', 'the prepared build is gone; prepare it again from the panel')
          else if (code !== 'not-prepared') this.settle(entry, 'failed', `the restart did not start: ${code}`)
        }
        continue
      }
      if (entry.state === 'applying') {
        if (view.run?.state === 'prepared' && this.now() - Date.parse(entry.at) > APPLY_GIVE_UP_MS) {
          this.settle(entry, 'failed', view.run.error ?? 'the restart kept waiting for idle workers; restart from the panel when it suits')
        } else if (view.run && ['failed', 'down', 'rolledBack', 'cancelled'].includes(view.run.state)) {
          this.settle(entry, 'failed', view.run.error ?? 'the restart did not finish')
        }
        continue
      }
    }
    if (this.entries.some(entry => entry.state === 'preparing' && entry.sha === undefined)) void this.drive()
  }
  /** Read the journal a previous host left and tell whether the deployment it was running landed. */
  private reconcile(): void {
    if (!this.entries.length) return
    const view = this.host.upgrade.enabled ? this.host.upgrade.view() : undefined
    let changed = false
    for (const entry of this.entries) {
      if ((TERMINAL as readonly string[]).includes(entry.state) || !view) continue
      if (entry.sha !== undefined && view.installed === entry.sha) { this.settle(entry, 'applied', ''); changed = true; continue }
      if (entry.state === 'applying' && view.run && ['failed', 'down', 'rolledBack', 'cancelled'].includes(view.run.state)) {
        this.settle(entry, 'failed', view.run.error ?? 'the restart did not finish')
        changed = true
      }
    }
    if (changed) this.persist()
  }
  private settle(entry: DeployEntry, state: TicketDeploy['state'], detail: string): void {
    if (entry.state === state) return
    entry.state = state
    entry.at = this.iso()
    if (detail) entry.detail = detail
    this.changed(entry)
  }
  /** Persist one entry and record it on its ticket, so the board reads the deployment without this journal. */
  private changed(entry: DeployEntry): void {
    this.persist()
    // A journal entry can outlive its ticket record, such as after the database was rebuilt: keep the deployment and warn,
    // never fail the timer that follows it.
    try {
      this.host.record(entry.ticketId, { state: entry.state, at: entry.at, ...(entry.sha ? { sha: entry.sha } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}) })
    } catch (error) {
      this.host.warn(`dsh-superagent deployment for ticket ${entry.ticketId} was not recorded: ${String((error as Error).message ?? error)}`)
    }
  }
  private persist(): void {
    const finished = this.entries.filter(entry => (TERMINAL as readonly string[]).includes(entry.state)).slice(-KEEP)
    const waiting = this.entries.filter(entry => !(TERMINAL as readonly string[]).includes(entry.state))
    this.entries = [...finished, ...waiting]
    try {
      mkdirSync(dirname(this.journal), { recursive: true })
      writeFileSync(`${this.journal}.tmp`, JSON.stringify({ tickets: this.entries }, null, 2) + '\n')
      renameSync(`${this.journal}.tmp`, this.journal)
    } catch (error) {
      this.host.warn(`dsh-superagent deployment journal was not written: ${String((error as Error).message ?? error)}`)
    }
  }
  private read(): DeployEntry[] {
    try {
      const stored = JSON.parse(readFileSync(this.journal, 'utf8')) as { tickets?: unknown }
      if (!Array.isArray(stored.tickets)) return []
      return stored.tickets.filter((item): item is DeployEntry => typeof item === 'object' && item !== null
        && typeof (item as DeployEntry).ticketId === 'string' && typeof (item as DeployEntry).at === 'string'
        && ['preparing', 'ready', 'applying', 'applied', 'failed'].includes((item as DeployEntry).state))
    } catch { return [] }
  }
}
