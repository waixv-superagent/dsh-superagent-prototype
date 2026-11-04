/** Editor page view: who holds the Unreal Editor, which Tickets are working with their live tool, and what waits on a person. */
import { completedArchived, ticketStage, type Ticket } from '../../core/index.ts'
import { mcpToolName, type Activity, type ActivityView } from '../activity.ts'
import type { EditorBuild, EditorView } from '../editor.ts'
import { engineSummary, type EditorEngineState } from '../editor-mcp.ts'
import { DRAIN_GRACE_MS, ordered, personBlock, type EditorEvent, type EditorJob, type EditorPurpose, type EditorSchedule } from '../editor-schedule.ts'
import { delivered, newestFirst, snapshot, type ViewHost } from './records.ts'
import { ticketRow } from './tickets.ts'

/** Tool names and arguments that start or drive the editor or a build; a display hint, never a scheduling input. */
const EDITOR_COMMAND = /UnrealEditor(?:-Cmd)?|CompileSunGame|UnrealBuildTool|ShaderCompileWorker|RunUAT|Build\.bat/i
/** Only a shell-like tool can run the command; a Read of a build script is not a build. */
const COMMAND_TOOL = /^(bash|pwsh|powershell|cmd|shell|exec|run|terminal|task|subprocess)/i
/** An MCP server whose name says it drives the editor; a display hint, like EDITOR_COMMAND. */
const EDITOR_MCP = /unreal|editor/i
/** Tools that cannot hold the editor, so the page can say "not using the editor" without guessing from a digest. */
const READ_ONLY_TOOL = /^(read|grep|glob|search|list|view|edit|write|patch|apply_patch|todo|webfetch|websearch)/i
/** A test run, as opposed to a compile, when it is recognisable from the tool's own command line. */
const TEST_COMMAND = /RunTests|Automation|Gauntlet|ExecCmds=.*(?:Automation|Test)|RunUAT.*Test/i
const NOT_LIVE: ActivityView = { live: false, updatedAt: 0, tool: null, recent: [] }
/** The timeline covers the last hour: long enough to show what a person has been doing, short enough to fit a row. */
const TIMELINE_MS = 60 * 60_000
/** A lane name has one narrow gutter; a title longer than this is shortened so the timeline keeps the width. */
const SHORT_TITLE_MAX = 12

/** How the current tool relates to the editor; `unknown` means the page should not claim either way. */
export type EditorUse = 'uses' | 'not' | 'unknown'

export interface EditorWorkingRow {
  ticket: ReturnType<typeof ticketRow>
  activity: ActivityView
  /** true when the Ticket is queued for a worker slot, not currently in a turn. */
  queued: boolean
  /** best-effort: the current tool/digest names an editor/build command; never used to block anything. */
  usesEditor: boolean
  /** The display badge: uses, provably does not, or the page has no opinion. */
  use: EditorUse
  /** Where the Ticket stands with the editor scheduler: holding it for a purpose, or waiting at a position. */
  lease?: { state: 'holding'; purpose: EditorPurpose; note: string; since: string } | { state: 'queued'; purpose: EditorPurpose; position: number }
}

/** How a worker's current tool relates to the editor; unknown when it is between tools or not a shell command. */
export function editorUse(activity: ActivityView): EditorUse {
  const tool = activity.tool
  if (!tool) return 'unknown'
  const mcp = mcpToolName(tool.name)
  if (mcp && EDITOR_MCP.test(mcp.server)) return 'uses'
  if (COMMAND_TOOL.test(tool.name) && EDITOR_COMMAND.test(tool.digest)) return 'uses'
  if (READ_ONLY_TOOL.test(tool.name)) return 'not'
  return 'unknown'
}

/**
 * The one-line name a timeline lane can show: the first clause of the title, cut at a clause boundary and a modest
 * character count. It is a label, not an identifier; the full title stays on the row and on hover.
 */
export function shortTitle(title: string): string {
  const first = (title.split(/\r?\n/)[0] ?? '').trim()
  if (!first) return ''
  const head = (first.split(/[：:，,、|｜—–]/)[0] ?? '').trim() || first
  const chars = Array.from(head)
  return chars.length > SHORT_TITLE_MAX ? `${chars.slice(0, SHORT_TITLE_MAX).join('')}…` : head
}

/** Whether a worker's current tool names an editor or build command; false when it is between tools. */
export function usesEditor(activity: ActivityView): boolean {
  return editorUse(activity) === 'uses'
}

export interface EditorExecutorLoad {
  /** Workers in an active turn, which occupy slots. */
  running: number
  /** Tickets waiting for a slot. */
  queued: number
  /** The configured slots; 0 when the page has no executor fact. */
  maxWorkers: number
}

/**
 * A running build and the Tickets a person could verify from it: a pending-verification Ticket whose delivery time
 * predates the build's start was already in the tree the build read. It is an inference from timestamps, never a
 * claim about what the build actually compiled.
 */
export interface EditorBuildView extends EditorBuild {
  /** IDs of the verification rows delivered before this build started; empty when its start time is unknown. */
  included: string[]
}

/** One span on the editor page's last-hour timeline; times are already clamped to the window. */
export interface EditorTimelineBand {
  id: string
  /** Who or what the span represents: the holder, a worker assignment, or the tool it is in. */
  tone: 'person' | 'agent' | 'unknown' | 'run' | 'idle' | 'build' | 'test' | 'tool' | 'lease' | 'wait'
  from: string
  to: string
  /** Tool name for a tool span; Tickets are named by their row. */
  label?: string
  /** The full command digest, shown on hover; never rendered as a tool result. */
  title?: string
}

/** One lane of the timeline: the editor itself, or one working Ticket. */
export interface EditorTimelineRow {
  id: string
  ticketId: string
  label: string
  /** The short name the lane shows; the label stays as the full title and on hover. */
  short: string
  tone: 'run' | 'idle'
  bands: EditorTimelineBand[]
}

export interface EditorTimeline {
  /** Start and end of the 60-minute window, ISO. */
  from: string
  to: string
  editor: EditorTimelineBand[]
  workers: EditorTimelineRow[]
  /** Working Tickets with no span in the window, so the page can say the lane is not the whole list. */
  hidden: number
}

/** What a live tool is doing to the editor, for the timeline's color: a test, a build, or some other command. */
function toolTone(tool: NonNullable<ActivityView['tool']>): 'build' | 'test' | 'tool' {
  if (TEST_COMMAND.test(tool.digest)) return 'test'
  if (COMMAND_TOOL.test(tool.name) && EDITOR_COMMAND.test(tool.digest)) return 'build'
  return 'tool'
}

const iso = (ms: number): string => new Date(ms).toISOString()
/** Parse a time and clamp it into the window; null when it is missing or unreadable. */
function clamp(at: string | undefined | null, from: number, to: number): number | null {
  if (!at) return null
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return null
  return Math.min(Math.max(ms, from), to)
}

/**
 * The lease spans of the last hour per Ticket, from the scheduler's own events: a grant opens one, the release, expiry or
 * end closes it, and a lease still held runs to now. A wait is drawn from its queue time to its grant or to now.
 */
function leaseSpans(schedule: EditorSchedule | undefined, fromMs: number, nowMs: number): Map<string, EditorTimelineBand[]> {
  const spans = new Map<string, EditorTimelineBand[]>()
  if (!schedule) return spans
  const push = (ticketId: string, band: EditorTimelineBand) => { spans.set(ticketId, [...spans.get(ticketId) ?? [], band]) }
  const open = new Map<string, { at: number; purpose?: EditorPurpose }>()
  const waits = new Map<string, number>()
  const close = (ticketId: string, at: number) => {
    const start = open.get(ticketId)
    if (!start) return
    open.delete(ticketId)
    const from = Math.max(start.at, fromMs)
    if (at > from) push(ticketId, { id: `${ticketId}-lease-${start.at}`, tone: 'lease', from: iso(from), to: iso(at), label: start.purpose })
  }
  const closeWait = (ticketId: string, at: number) => {
    const start = waits.get(ticketId)
    if (start === undefined) return
    waits.delete(ticketId)
    const from = Math.max(start, fromMs)
    if (at > from) push(ticketId, { id: `${ticketId}-wait-${start}`, tone: 'wait', from: iso(from), to: iso(at) })
  }
  for (const item of schedule.events) {
    const at = Date.parse(item.at)
    if (!Number.isFinite(at)) continue
    for (const ticketId of item.ticketIds ?? []) {
      if (item.kind === 'queued' && !waits.has(ticketId)) waits.set(ticketId, at)
      if (item.kind === 'granted') { closeWait(ticketId, at); open.set(ticketId, { at, ...item.purpose ? { purpose: item.purpose } : {} }) }
      if (item.kind === 'released' || item.kind === 'expired' || item.kind === 'ended') close(ticketId, at)
      if (item.kind === 'cancelled') closeWait(ticketId, at)
    }
  }
  for (const ticketId of [...open.keys()]) close(ticketId, nowMs)
  const waiting = new Set(schedule.queue.flatMap(request => request.ticketIds))
  for (const ticketId of [...waits.keys()]) if (waiting.has(ticketId)) closeWait(ticketId, nowMs)
  return spans
}

/** * The last-hour timeline: one lane for the editor process and one lane per working Ticket, built only from recorded
 * start/end times and the live tool's elapsed time. It shows what happened, not an estimate of what comes next.
 */
function timeline(nowMs: number, editor: EditorView | null, staged: { ticket: Ticket; stage: ReturnType<typeof ticketStage> }[],
  activity: Map<string, ActivityView>, schedule?: EditorSchedule): EditorTimeline {
  const fromMs = nowMs - TIMELINE_MS
  const leases = leaseSpans(schedule, fromMs, nowMs)
  const to = iso(nowMs)
  const editorBands: EditorTimelineBand[] = []
  if (editor?.since && (editor.holder === 'person' || editor.holder === 'agent')) {
    const start = clamp(editor.since, fromMs, nowMs)
    if (start !== null && start < nowMs) editorBands.push({ id: 'editor', tone: editor.holder, from: iso(start), to })
  }
  // A build's own start bounds which delivered changes it contains; the holder's start is a different question.
  if (editor?.build?.since) {
    const start = clamp(editor.build.since, fromMs, nowMs)
    if (start !== null && start < nowMs) editorBands.push({ id: 'build', tone: 'build', from: iso(start), to,
      title: editor.build.since })
  }
  const rows: EditorTimelineRow[] = []
  for (const { ticket, stage } of staged) {
    if (stage.stage !== 'working') continue
    const live = activity.get(ticket.id) ?? NOT_LIVE
    const bands: EditorTimelineBand[] = []
    for (const assignment of ticket.assignments) {
      const start = clamp(assignment.startedAt, fromMs, nowMs)
      const end = clamp(assignment.endedAt ?? assignment.idleAt ?? to, fromMs, nowMs)
      if (start === null || end === null || end <= start) continue
      const running = assignment.state === 'running' && !assignment.endedAt && !assignment.idleAt
      bands.push({ id: assignment.id, tone: running ? 'run' : 'idle', from: iso(start), to: iso(end) })
    }
    bands.push(...leases.get(ticket.id) ?? [])
    const tool = live.live ? live.tool : null
    if (tool) {
      const start = clamp(iso(nowMs - tool.elapsed), fromMs, nowMs)
      if (start !== null && start < nowMs) bands.push({ id: `${ticket.id}-tool`, tone: toolTone(tool), from: iso(start),
        to, label: tool.name, title: tool.digest })
    }
    if (!bands.length) continue
    bands.sort((left, right) => left.from.localeCompare(right.from))
    rows.push({ id: ticket.id, ticketId: ticket.id, label: ticket.title,
      short: shortTitle(ticket.title) || `#${ticket.id.slice(0, 8)}`, tone: live.live ? 'run' : 'idle', bands })
  }
  rows.sort((left, right) => Number(right.tone === 'run') - Number(left.tone === 'run')
    || (right.bands.at(-1)?.to ?? '').localeCompare(left.bands.at(-1)?.to ?? '') || left.label.localeCompare(right.label))
  const workers = rows.slice(0, 6)
  return { from: iso(fromMs), to, editor: editorBands, workers, hidden: rows.length - workers.length }
}

/** The scheduler's facts the page shows: who holds the editor and for what, who waits, the jobs, and ue-mcp's reading. */
export interface EditorScheduleView {
  holder: { kind: 'agent' | 'job' | 'person'; purpose: EditorPurpose; note: string; since: string; expiresAt: string | null
    tickets: { id: string; title: string }[]; jobId?: string; draining: { at: string; reason: string; overdue: boolean } | null } | null
  queue: { id: string; position: number; purpose: EditorPurpose; note: string; at: string; person: boolean; front: boolean
    tickets: { id: string; title: string }[]; jobId?: string }[]
  /** Running and queued jobs first, then the latest ended ones. */
  jobs: (EditorJob & { tickets: { id: string; title: string }[] })[]
  /** Newest first, at most 12. */
  events: (EditorEvent & { tickets: { id: string; title: string }[] })[]
  /** Why agents are held back right now, or null when one may take it. */
  blocked: 'claimed' | 'editor' | 'unknown' | null
  /** A person let agents use the editor that is open; the page offers to take it back. */
  yielded: boolean
  engine: (EditorEngineState & { summary: { tone: 'ok' | 'busy' | 'blocked' | 'off'; text: string } }) | null
}

/** The scheduler's part of the page, with Ticket titles resolved so the panel never shows a bare id. */
export function scheduleView(host: ViewHost, schedule: EditorSchedule, editor: EditorView | null, engine: EditorEngineState | null,
  nowMs = Date.now()): EditorScheduleView {
  const named = (ids: readonly string[]) => ids.map(id => ({ id, title: host.store.tickets.get(id)?.title ?? `#${id.slice(0, 8)}` }))
  const lease = schedule.lease
  const holder: EditorScheduleView['holder'] = lease ? {
    kind: lease.holder.kind, purpose: lease.purpose, note: lease.note, since: lease.acquiredAt, expiresAt: lease.expiresAt,
    tickets: named(lease.holder.kind === 'agent' ? [lease.holder.ticketId] : lease.holder.kind === 'job' ? lease.holder.ticketIds : []),
    ...lease.holder.kind === 'job' ? { jobId: lease.holder.jobId } : {},
    draining: lease.draining ? { ...lease.draining, overdue: nowMs - Date.parse(lease.draining.at) > DRAIN_GRACE_MS } : null,
  } : null
  const queue = ordered(schedule.queue).map((request, index) => ({ id: request.id, position: index + 1, purpose: request.purpose,
    note: request.note, at: request.at, person: !!request.person, front: !!request.front, tickets: named(request.ticketIds),
    ...request.jobId ? { jobId: request.jobId } : {} }))
  const open = schedule.jobs.filter(job => job.state === 'queued' || job.state === 'running')
  const ended = schedule.jobs.filter(job => job.state !== 'queued' && job.state !== 'running').slice(-6).reverse()
  return { holder, queue, jobs: [...open, ...ended].map(job => ({ ...job, tickets: named(job.ticketIds) })),
    events: schedule.events.slice(-12).reverse().map(item => ({ ...item, tickets: named(item.ticketIds ?? []) })),
    blocked: personBlock(schedule, editor), yielded: !!schedule.yielded,
    engine: engine ? { ...engine, summary: engineSummary(engine) } : null }
}

/** Where one Ticket stands with the scheduler, for its working row. */
function ticketStanding(schedule: EditorSchedule, ticketId: string): EditorWorkingRow['lease'] | undefined {
  const lease = schedule.lease
  if (lease?.holder.kind === 'agent' && lease.holder.ticketId === ticketId) return { state: 'holding', purpose: lease.purpose, note: lease.note, since: lease.acquiredAt }
  if (lease?.holder.kind === 'job' && lease.holder.ticketIds.includes(ticketId)) return { state: 'holding', purpose: lease.purpose, note: lease.note, since: lease.acquiredAt }
  const index = ordered(schedule.queue).findIndex(request => request.ticketIds.includes(ticketId))
  return index >= 0 ? { state: 'queued', purpose: ordered(schedule.queue)[index]!.purpose, position: index + 1 } : undefined
}

export function editorPage(host: ViewHost, activity: Pick<Activity, 'read'>, editor: EditorView | null,
  executor: EditorExecutorLoad = { running: 0, queued: 0, maxWorkers: 0 },
  scheduler?: { schedule: EditorSchedule; engine: EditorEngineState | null }) {
  const { store } = host
  const view = snapshot(host)
  const nowMs = Date.now()
  const now = iso(nowMs)
  const open = store.tickets.open().sort(newestFirst)
  // Mirrors the overview's verification lane: a live gate first, then delivered completed Tickets a person has not passed.
  const awaiting = store.tickets.list().filter(ticket => ticket.ended?.outcome === 'completed' && !completedArchived(ticket, now)
    && ticket.verification?.state !== 'passed' && delivered(ticket))
    .sort((left, right) => (left.verification?.at ?? left.ended?.at ?? '').localeCompare(right.verification?.at ?? right.ended?.at ?? ''))
  const staged = open.map(ticket => ({ ticket, stage: ticketStage(ticket) }))
  const activityById = new Map<string, ActivityView>()
  const read = (ticket: Ticket): ActivityView => {
    try { return activity.read(ticket.id) } catch { return NOT_LIVE }
  }
  const working = staged.filter(({ stage }) => stage.stage === 'working').map(({ ticket, stage }, index) => {
    const live = read(ticket)
    activityById.set(ticket.id, live)
    const queued = stage.stage === 'working' && stage.action === 'queued'
    const standing = scheduler ? ticketStanding(scheduler.schedule, ticket.id) : undefined
    // Holding the lease is the strongest evidence a Ticket uses the editor; the tool guess only fills in without one.
    const use = standing?.state === 'holding' ? 'uses' : editorUse(live)
    return { index, row: { ticket: ticketRow(view, ticket), activity: live, queued, usesEditor: use === 'uses', use,
      ...standing ? { lease: standing } : {} } }
  }).sort((left, right) => Number(right.row.activity.live) - Number(left.row.activity.live)
    || Number(left.row.queued) - Number(right.row.queued)
    || right.row.ticket.updatedAt.localeCompare(left.row.ticket.updatedAt) || left.index - right.index)
    .map(({ row }): EditorWorkingRow => row)
  const person = staged.filter(({ stage }) => stage.stage === 'person' && stage.action !== 'verify')
    .map(({ ticket }) => ticketRow(view, ticket))
  const verificationTickets = [...staged.filter(({ stage }) => stage.stage === 'person' && stage.action === 'verify').map(({ ticket }) => ticket),
    ...awaiting]
  const verification = verificationTickets.map(ticket => ticketRow(view, ticket))
  const buildStart = editor?.build?.since ? Date.parse(editor.build.since) : NaN
  const build: EditorBuildView | null = editor?.build ? { ...editor.build,
    // The delivery time is the pending-verification stamp or, for an already ended Ticket, when it ended; a last
    // modification time is not a delivery and must not be guessed from.
    included: Number.isFinite(buildStart) ? verificationTickets
      .filter(ticket => {
        const deliveredAt = Date.parse(ticket.verification?.at ?? ticket.ended?.at ?? '')
        return Number.isFinite(deliveredAt) && deliveredAt <= buildStart
      }).map(ticket => ticket.id) : [] } : null
  const schedule = scheduler ? scheduleView(host, scheduler.schedule, editor, scheduler.engine, nowMs) : null
  return { editor, build, working, person, verification, executor, schedule,
    timeline: timeline(nowMs, editor, staged, activityById, scheduler?.schedule),
    counts: { working: working.length, queued: working.filter(row => row.queued).length, person: person.length,
      verification: verification.length } }
}
export type EditorPageView = ReturnType<typeof editorPage>
