/**
 * The host's stall alert: a Ticket whose worker has made no visible progress for a while, or that waited too long for a
 * worker slot, is said once in its conversation instead of waiting for a person to ask "what is it doing?". It never
 * changes a Ticket: it reads the open Tickets and the live worker activity, mirrors what it found into the `stall` health
 * entry and `/orchestrator/api/state`, and queues one short notice per stall.
 */
import { key, latestAssignment, ticketStage, type ChannelRef, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Settings } from '../policy.ts'
import type { ActivityView } from './activity.ts'

/** The heartbeat that looks for stalls; the thresholds are minutes, so a coarse look is enough. */
const HEARTBEAT_MS = 60_000
/** The longest title a notice repeats, so the message stays a short glance on a phone. */
const MAX_TITLE = 30
/** How many stalled Tickets the health detail and the state view name. */
const MAX_LISTED = 5
/**
 * How long one running tool call counts as progress. A build or a test run may take long; one that runs past this has
 * likely hung, which is exactly what a person should hear of.
 */
export const TOOL_GRACE_MS = 60 * 60_000

/** Host dependencies used by `StallWatch`. */
export interface StallWatchHost {
  /** The open Tickets to scan; the watch filters them to the ones working or queued. */
  readonly tickets: { open(): Ticket[] }
  readonly settings: () => Settings
  /** The live state of a Ticket's worker: its current tool call and when its Session last changed. */
  readonly activity: { read(ticketId: string): ActivityView }
  /** Whether the worker's turn ended and its shell jobs or subagents still run, which is work in progress, not a stall. */
  background(ticketId: string): boolean
  /** The conversation a Ticket's own messages go to, or undefined when it has none. */
  channel(ticket: Ticket): ChannelRef | undefined
  /** The text of the request that started the Ticket, which decides the notice's language. */
  request(ticket: Ticket): string
  readonly outbox: { send(message: OutboundMessage): void }
  /** The `stall` health entry. */
  readonly health: HealthEntry
  /** Whether processing is paused, which holds every alert: nothing is expected to progress then. */
  paused(): boolean
  now?(): number
  warn?(message: string): void
}

/** One Ticket the watch counts as stalled. */
export interface Stall {
  readonly ticketId: string
  readonly title: string
  /** `working`: the worker made no progress; `queued`: the Ticket waits for a worker slot. */
  readonly kind: 'working' | 'queued'
  /** Whole minutes since the last progress, or since it was queued. */
  readonly minutes: number
  /** The last tool the worker called, when the live activity still knows it. */
  readonly lastTool?: string
  /** Whether that tool call still runs: it has run past `TOOL_GRACE_MS`. */
  readonly toolRunning?: boolean
}

/** What the watch found on its last look, which the state API reports and the Feishu status card shows. */
export interface StallStatus {
  /** How many open Tickets are stalled now. */
  readonly tickets: number
  /** The first stalled Tickets, longest first. */
  readonly items: readonly Stall[]
}

/** The latest of several ISO times or millisecond stamps, in milliseconds; NaN when none parses. */
function latest(values: readonly (string | number | undefined)[]): number {
  let best = Number.NaN
  for (const value of values) {
    const ms = typeof value === 'number' ? (value > 0 ? value : Number.NaN) : value ? Date.parse(value) : Number.NaN
    if (Number.isFinite(ms) && !(ms <= best)) best = ms
  }
  return best
}

/** Whether a request reads as Chinese: Han characters and no kana, the rule the PR-end notice uses too. */
const chinese = (text: string): boolean => /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
const short = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line
}
/** Square brackets and backticks in a title would read as Markdown in the notice. */
const plainTitle = (text: string): string => short(text).replace(/[[\]`*_]/g, '')

/**
 * The notice for one stall, at most three short lines: what is stalled and for how long, where it stands, and what a person
 * can do. It names facts the host has, never a guess about the cause.
 */
export function stallText(stall: Stall, ticket: Pick<Ticket, 'id'>, zh: boolean): string {
  const id = ticket.id.slice(0, 8)
  const title = plainTitle(stall.title)
  // A tool name such as mcp__ue__run_pie would read as emphasis without code marks.
  const tool = stall.lastTool ? `\`${stall.lastTool}\`` : ''
  if (zh) {
    const head = stall.kind === 'queued'
      ? `⚠️ 工单「${title}」已排队 ${stall.minutes} 分钟，还没开始执行。`
      : `⚠️ 工单「${title}」已 ${stall.minutes} 分钟没有进展。`
    const where = stall.kind === 'queued' ? '等执行槽位空出来。'
      : stall.toolRunning ? `工具 ${tool} 一直在运行，没有返回。`
      : stall.lastTool ? `最后一步：${tool}，之后没有新动作。` : '执行器没有新的动作或报告。'
    return [head, where, `可在面板重试或停止（工单 ${id}）。`].join('\n')
  }
  const head = stall.kind === 'queued'
    ? `⚠️ Ticket "${title}" has been queued for ${stall.minutes} min without starting.`
    : `⚠️ Ticket "${title}" has made no progress for ${stall.minutes} min.`
  const where = stall.kind === 'queued' ? 'It waits for a free worker slot.'
    : stall.toolRunning ? `Tool ${tool} is still running and has not returned.`
    : stall.lastTool ? `Last step: ${tool}, nothing since.` : 'Its worker has no new action or report.'
  return [head, where, `Retry or stop it on the panel (ticket ${id}).`].join('\n')
}

/**
 * Looks for stalled Tickets once a minute. A working Ticket is stalled when nothing it did — its Assignment starting, a
 * report, a turn ending, Inputs reaching it, any event of its worker Session — happened for `executor.stall.minutes`, while
 * no tool call of its worker runs and no background work of its ended turn does. A queued Ticket is stalled after
 * `executor.stall.queuedMinutes`. Each stall is announced once: its message id is the Ticket, its Assignment and the time
 * of its last progress, so the Outbox, which keeps receipts across restarts, never sends it twice; new progress starts a
 * new count. While processing is paused nothing is expected to progress, so nothing is announced.
 */
export class StallWatch {
  private timer?: ReturnType<typeof setInterval>
  private found: Stall[] = []
  private stopped = false
  constructor(private readonly host: StallWatchHost) {}

  start(): void {
    this.stopped = false
    if (this.timer) return
    this.timer = setInterval(() => { this.poll() }, HEARTBEAT_MS)
    this.timer.unref?.()
    this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  status(): StallStatus {
    return { tickets: this.found.length, items: this.found.slice(0, MAX_LISTED) }
  }

  /** One look: find the stalled Tickets, announce the new ones, and mirror them into the health entry. */
  poll(now = this.host.now?.() ?? Date.now()): Stall[] {
    if (this.stopped) return this.found
    const settings = this.host.settings().executor.stall
    const stalls: Stall[] = []
    if (!this.host.paused()) {
      for (const ticket of this.host.tickets.open()) {
        try {
          const found = this.check(ticket, now, settings)
          if (!found) continue
          stalls.push(found.stall)
          if (settings.notify) this.announce(ticket, found.stall, found.since)
        } catch (error) {
          this.host.warn?.(`stall check for ticket ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    this.found = stalls.sort((left, right) => right.minutes - left.minutes)
    this.refresh(now)
    return this.found
  }

  /** The stall of one Ticket and the time its count started, or undefined when it is not stalled. */
  private check(ticket: Ticket, now: number, settings: Settings['executor']['stall']): { stall: Stall; since: number } | undefined {
    const stage = ticketStage(ticket)
    if (stage.stage !== 'working') return undefined
    const assignment = latestAssignment(ticket)
    if (stage.action === 'queued') {
      const since = latest([assignment?.createdAt ?? ticket.createdAt])
      const minutes = Math.floor((now - since) / 60_000)
      if (!Number.isFinite(minutes) || minutes < settings.queuedMinutes) return undefined
      return { stall: { ticketId: ticket.id, title: ticket.title, kind: 'queued', minutes }, since }
    }
    const activity = this.host.activity.read(ticket.id)
    // A tool that runs, or the background work of a turn that ended, is work in progress; the Executor's own limit ends the
    // background work, and a tool past `TOOL_GRACE_MS` counts from when it started.
    if ((activity.tool && activity.tool.elapsed < TOOL_GRACE_MS) || this.host.background(ticket.id)) return undefined
    const toolStart = activity.tool ? now - activity.tool.elapsed : undefined
    const since = latest([assignment?.startedAt, assignment?.createdAt, assignment?.report?.at, assignment?.idleAt, assignment?.deliveredAt,
      activity.tool ? toolStart : activity.updatedAt])
    const minutes = Math.floor((now - since) / 60_000)
    if (!Number.isFinite(minutes) || minutes < settings.minutes) return undefined
    const last = activity.tool ?? activity.recent[0]
    return { stall: { ticketId: ticket.id, title: ticket.title, kind: 'working', minutes, ...last ? { lastTool: last.name } : {}, ...activity.tool ? { toolRunning: true } : {} }, since }
  }

  private announce(ticket: Ticket, stall: Stall, since: number): void {
    const channel = this.host.channel(ticket)
    if (!channel) return
    const assignment = latestAssignment(ticket)?.id ?? ''
    const text = stallText(stall, ticket, chinese(this.host.request(ticket)))
    this.host.outbox.send({ id: key('stall', ticket.id, assignment, stall.kind, String(since)), channel, text, kind: 'notice', ticketId: ticket.id })
  }

  private refresh(now: number): void {
    const at = new Date(now).toISOString()
    if (!this.found.length) {
      this.host.health.set({ state: 'ready', detail: 'No open ticket is stalled', at })
      return
    }
    const names = this.found.slice(0, MAX_LISTED).map(item => `${item.ticketId.slice(0, 8)} ${item.kind === 'queued' ? 'queued' : 'without progress'} `
      + `for ${item.minutes} min`)
    const more = this.found.length > MAX_LISTED ? `; ${this.found.length - MAX_LISTED} more` : ''
    this.host.health.set({ state: 'error', detail: `${this.found.length} ticket(s) stalled: ${names.join('; ')}${more}`, at })
  }
}
