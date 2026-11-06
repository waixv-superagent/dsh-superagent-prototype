/**
 * The shared editor's schedule as plain data (docs/021): one lease, a wait queue, the jobs the host runs for Tickets, and
 * the recent events a person reads on the overview. Every function here is pure, so the decisions are testable without a
 * process table, a clock or a database; `EditorScheduler` persists the result and runs the side effects.
 */
import type { EditorView } from './editor.ts'

/** What a Ticket needs the editor for; the overview shows it, and `build` requests are the ones a job batches. */
export const EDITOR_PURPOSES = ['build', 'restart', 'test', 'use'] as const
export type EditorPurpose = typeof EDITOR_PURPOSES[number]
/** The work the host itself runs for a Ticket: compile, restart the editor, or run an automation filter. */
export const EDITOR_JOB_KINDS = ['build', 'restart', 'test'] as const
export type EditorJobKind = typeof EDITOR_JOB_KINDS[number]

/** A lease lasts this long without a heartbeat; a worker asks for more when it starts a long step. */
export const DEFAULT_LEASE_MS = 15 * 60_000
/** The longest one acquire or heartbeat may ask for: a cold SunGame build takes about 40 minutes. */
export const MAX_LEASE_MS = 120 * 60_000
/** How long a preempted agent has to save and release before the overview calls it overdue. */
export const DRAIN_GRACE_MS = 5 * 60_000
const MAX_EVENTS = 200
const MAX_ENDED_JOBS = 30

/** Who holds the lease: a worker driving the editor itself, a job the host runs for Tickets, or a person who claimed it. */
export type LeaseHolder = { kind: 'agent'; ticketId: string } | { kind: 'job'; jobId: string; ticketIds: string[] } | { kind: 'person' }

export interface EditorLease {
  id: string
  holder: LeaseHolder
  purpose: EditorPurpose
  /** What the holder said it is doing, such as the test filter or "PIE 验证冲刺停止动画". */
  note: string
  acquiredAt: string
  heartbeatAt: string
  /** When the lease lapses without a heartbeat; a person's claim and a host job, which ends with its process, have none. */
  expiresAt: string | null
  /** A person asked the holder to yield; the holder saves and releases, nothing is killed. */
  draining?: { at: string; reason: string }
}

/** One wait in the queue: a worker's request, or a job waiting for its turn. */
export interface EditorRequest {
  id: string
  /** The Tickets waiting on it: one for a worker, one or more for a batched build. */
  ticketIds: string[]
  purpose: EditorPurpose
  note: string
  at: string
  /** A person moved it to the front; the front is ordered by when they did. */
  front?: string
  /** The job this wait starts once granted; absent for a worker that drives the editor itself. */
  jobId?: string
  /** How long the worker asked to hold it once granted. */
  ttlMs: number
  /** A person's claim waits at the very front for the current agent to drain. */
  person?: true
}

export type EditorJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface EditorJob {
  id: string
  kind: EditorJobKind
  /** Every Ticket the job covers; a batched build lists all whose requests it absorbed. */
  ticketIds: string[]
  /** The automation filter of a test job. */
  filter?: string
  /** The workspace the job runs in; builds batch only within one workspace, since each builds its own tree. */
  directory: string
  state: EditorJobState
  createdAt: string
  startedAt?: string
  endedAt?: string
  exitCode?: number | null
  /** One line a person and the worker read: the UBT verdict or the automation count. */
  summary?: string
  /** The log file the host wrote the command's output to. */
  log?: string
  /** The command line as configured, after placeholders; shown on hover. */
  command?: string
  /** The process the host started, so a job left running across a host restart still holds the editor until it exits. */
  pid?: number
  /** A person stopped it: the lease stays until the process has exited, so the next job never overlaps it. */
  stopping?: true
  /** A build folded into another waiting build of the same workspace; that job's result is this one's. */
  mergedInto?: string
}

export type EditorEventKind = 'queued' | 'granted' | 'released' | 'expired' | 'ended' | 'preempted' | 'claimed' | 'yielded'
  | 'cancelled' | 'front' | 'job' | 'bypass' | 'reclaimed' | 'kept'
export interface EditorEvent {
  at: string
  kind: EditorEventKind
  by: 'agent' | 'person' | 'host'
  ticketIds?: string[]
  purpose?: EditorPurpose
  detail?: string
}

export interface EditorSchedule {
  lease: EditorLease | null
  queue: EditorRequest[]
  jobs: EditorJob[]
  /** Newest last, bounded. */
  events: EditorEvent[]
  /**
   * Interactive editors a person said agents may use: the editor stays open, but its process no longer reads as a
   * person holding it. Dropped once none of these processes is running.
   */
  yielded?: { at: string; pids: number[] }
  /** Interactive editors that started under an agent's lease, which are therefore not a person's. */
  agentPids: number[]
}

export const emptySchedule = (): EditorSchedule => ({ lease: null, queue: [], jobs: [], events: [], agentPids: [] })

/** What the schedule needs from outside: the time, the probe's row, which Tickets still run, and fresh ids. */
export interface ScheduleContext {
  now: number
  editor: EditorView | null
  /** Whether a Ticket is still open; an ended Ticket's lease and waits go. */
  live: (ticketId: string) => boolean
  id: () => string
}

const iso = (ms: number) => new Date(ms).toISOString()
const clampTtl = (ms: number | undefined) => Math.min(MAX_LEASE_MS, Math.max(60_000, ms ?? DEFAULT_LEASE_MS))
function event(schedule: EditorSchedule, value: EditorEvent): void {
  schedule.events.push(value)
  if (schedule.events.length > MAX_EVENTS) schedule.events.splice(0, schedule.events.length - MAX_EVENTS)
}
function clone(schedule: EditorSchedule): EditorSchedule {
  return structuredClone({ ...emptySchedule(), ...schedule })
}

/** The interactive editors the probe sees, falling back to the representative pid for a row from an older probe. */
function interactivePids(editor: EditorView | null): number[] {
  if (!editor) return []
  if (editor.editors) return editor.editors.filter(process => process.name === 'unrealeditor').map(process => process.pid)
  return editor.holder === 'person' && editor.pid ? [editor.pid] : []
}

/**
 * Why an agent may not take the editor now, or null when it may. A person's claim, an unreadable probe, or an interactive
 * editor that neither an agent started nor a person yielded all read as a person using it: stopping an agent before it
 * fights a person is the safe answer, and the overview offers the person the button to yield.
 */
export function personBlock(schedule: EditorSchedule, editor: EditorView | null): 'claimed' | 'editor' | 'unknown' | null {
  if (schedule.lease?.holder.kind === 'person') return 'claimed'
  if (!editor || editor.holder === 'unknown') return 'unknown'
  const free = new Set([...schedule.agentPids, ...schedule.yielded?.pids ?? []])
  return interactivePids(editor).some(pid => !free.has(pid)) ? 'editor' : null
}

/**
 * The queue in the order it is granted: a person's claim, then what a person moved forward (the latest move first, so
 * "move to front" always puts that wait first), then first come first served.
 */
export function ordered(queue: readonly EditorRequest[]): EditorRequest[] {
  const rank = (request: EditorRequest) => request.person ? 0 : request.front ? 1 : 2
  return queue.slice().sort((left, right) => rank(left) - rank(right)
    || (right.front ?? '').localeCompare(left.front ?? '') || left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
}

/** Where a Ticket stands: holding, waiting at a position (1-based), or neither. */
export function standing(schedule: EditorSchedule, ticketId: string):
  { state: 'holding'; lease: EditorLease } | { state: 'queued'; position: number; request: EditorRequest } | { state: 'none' } {
  const lease = schedule.lease
  if (lease && (lease.holder.kind === 'agent' ? lease.holder.ticketId === ticketId : false)) return { state: 'holding', lease }
  const queue = ordered(schedule.queue)
  const index = queue.findIndex(request => !request.jobId && !request.person && request.ticketIds.includes(ticketId))
  return index >= 0 ? { state: 'queued', position: index + 1, request: queue[index]! } : { state: 'none' }
}

/**
 * Records that a worker's shell command opened, built or stopped the editor outside its lease (docs/021). It adds an
 * event for the person to see and grants or releases nothing itself; the scheduler's usual advance still runs with it.
 */
export function recordBypass(input: EditorSchedule, value: { ticketId: string; detail: string }, context: ScheduleContext): EditorSchedule {
  const schedule = clone(input)
  event(schedule, { at: iso(context.now), kind: 'bypass', by: 'agent', ticketIds: [value.ticketId],
    detail: value.detail.trim().slice(0, 300) })
  return schedule
}

/**
 * Keeps an interactive editor a lease opened after the lease ends (docs/021). The gatekeeper stops a lease's build and
 * commandlet processes when the lease goes, but an editor is the expensive part of the slot: it stays open and readable
 * to the next holder instead of making the next Ticket pay the load again. The pid stays in `agentPids`, so the probe's
 * "an editor is open" does not read as a person holding it and the next agent may use it; nothing here holds a lease.
 */
export function keepEditor(input: EditorSchedule, value: { pid: number; ticketId: string; detail?: string },
  context: ScheduleContext): EditorSchedule {
  const schedule = clone(input)
  const at = iso(context.now)
  if (!schedule.agentPids.includes(value.pid)) schedule.agentPids.push(value.pid)
  const detail = value.detail?.trim().slice(0, 300)
  event(schedule, { at, kind: 'kept', by: 'host', ticketIds: [value.ticketId], ...detail ? { detail } : {} })
  return schedule
}

/**
 * Ends a lease the gatekeeper reclaimed after the holder's heartbeat stopped (docs/021). The lease's processes are
 * stopped by the caller; this records the host's decision with the ending the reason implies and frees the slot so the
 * next waiter is granted. When another path already ended the lease (a release, or `advance` expiring it first), the
 * cleanup is still recorded, so the overview keeps why a process was closed.
 */
export function reclaim(input: EditorSchedule, leaseId: string, reason: string, context: ScheduleContext,
  ending: 'expired' | 'ended' | 'released' = 'expired'): { schedule: EditorSchedule; lease?: EditorLease } {
  const schedule = clone(input)
  const at = iso(context.now)
  const detail = reason.trim().slice(0, 300)
  const lease = schedule.lease?.id === leaseId && schedule.lease.holder.kind !== 'person' ? schedule.lease : undefined
  if (lease) {
    endLease(schedule, ending, 'host', at, detail)
    return { schedule, lease }
  }
  event(schedule, { at, kind: 'reclaimed', by: 'host', ...detail ? { detail } : {} })
  return { schedule }
}

function grant(schedule: EditorSchedule, request: EditorRequest, context: ScheduleContext): EditorLease {
  const at = iso(context.now)
  schedule.queue = schedule.queue.filter(item => item.id !== request.id)
  let ticketIds = request.ticketIds
  if (request.jobId) {
    const job = schedule.jobs.find(item => item.id === request.jobId)
    // A build reads the whole shared workspace, so every build still waiting gets the same one instead of its own.
    if (job?.kind === 'build') {
      const sameBuild = (other: EditorJob | undefined) => other?.kind === 'build' && other.directory === job.directory
      const merged = schedule.queue.filter(item => item.jobId && sameBuild(schedule.jobs.find(other => other.id === item.jobId)))
      for (const item of merged) {
        const other = schedule.jobs.find(value => value.id === item.jobId)!
        other.state = 'cancelled'
        other.endedAt = at
        other.summary = `merged into ${job.id}`
        other.mergedInto = job.id
        ticketIds = [...new Set([...ticketIds, ...item.ticketIds])]
      }
      schedule.queue = schedule.queue.filter(item => !merged.includes(item))
      job.ticketIds = ticketIds
    }
  }
  const holder: LeaseHolder = request.person ? { kind: 'person' } : request.jobId ? { kind: 'job', jobId: request.jobId, ticketIds }
    : { kind: 'agent', ticketId: request.ticketIds[0]! }
  const lease: EditorLease = { id: context.id(), holder, purpose: request.purpose, note: request.note, acquiredAt: at, heartbeatAt: at,
    expiresAt: request.person || request.jobId ? null : iso(context.now + request.ttlMs) }
  schedule.lease = lease
  event(schedule, { at, kind: request.person ? 'claimed' : 'granted', by: request.person ? 'person' : 'host',
    ...request.person ? {} : { ticketIds }, purpose: request.purpose, ...request.note ? { detail: request.note } : {} })
  return lease
}

function endLease(schedule: EditorSchedule, kind: 'released' | 'expired' | 'ended' | 'reclaimed', by: EditorEvent['by'], at: string, detail?: string): void {
  const lease = schedule.lease
  if (!lease) return
  schedule.lease = null
  const ticketIds = lease.holder.kind === 'agent' ? [lease.holder.ticketId] : lease.holder.kind === 'job' ? lease.holder.ticketIds : undefined
  event(schedule, { at, kind, by, ...ticketIds ? { ticketIds } : {}, purpose: lease.purpose, ...detail ? { detail } : {} })
}

/**
 * Brings the schedule up to date: drops the waits and leases of ended Tickets, lapses an expired lease, forgets editors
 * that are gone, records an editor that started under an agent's lease as the agent's, and grants the head of the queue
 * when nothing holds the editor and no person is using it.
 * @returns The schedule and the lease it granted, if any, so the caller can tell the worker or start the job.
 */
export function advance(input: EditorSchedule, context: ScheduleContext): { schedule: EditorSchedule; granted?: EditorLease } {
  const schedule = clone(input)
  const at = iso(context.now)
  const running = new Set(context.editor?.editors?.map(process => process.pid) ?? (context.editor?.pid ? [context.editor.pid] : []))
  const lease = schedule.lease
  if (lease?.holder.kind === 'agent' && !context.live(lease.holder.ticketId)) endLease(schedule, 'ended', 'host', at)
  else if (lease?.expiresAt && Date.parse(lease.expiresAt) <= context.now) endLease(schedule, 'expired', 'host', at)
  // An editor that started under a lease meant to open one (a restart job, or an agent restarting or using the editor) is
  // that holder's, so it does not lock the next agent out. Only a single new editor counts: when two appear, one may be a
  // person's, and an editor that cannot be told apart stays a person's.
  const opener = schedule.lease && (schedule.lease.holder.kind === 'job' ? schedule.lease.purpose === 'restart'
    : schedule.lease.holder.kind === 'agent' && (schedule.lease.purpose === 'restart' || schedule.lease.purpose === 'use'))
  if (opener && context.editor?.editors) {
    const since = Date.parse(schedule.lease!.acquiredAt)
    const fresh = context.editor.editors.filter(process => process.name === 'unrealeditor' && process.started
      && Date.parse(process.started) >= since - 5_000 && !schedule.agentPids.includes(process.pid)
      && !schedule.yielded?.pids.includes(process.pid))
    const others = context.editor.editors.filter(process => process.name === 'unrealeditor' && !fresh.includes(process)
      && !schedule.agentPids.includes(process.pid) && !schedule.yielded?.pids.includes(process.pid))
    if (fresh.length === 1 && !others.some(process => !process.started || Date.parse(process.started) >= since - 5_000)) schedule.agentPids.push(fresh[0]!.pid)
  }
  if (context.editor && context.editor.holder !== 'unknown') {
    schedule.agentPids = schedule.agentPids.filter(pid => running.has(pid))
    if (schedule.yielded) {
      const pids = schedule.yielded.pids.filter(pid => running.has(pid))
      schedule.yielded = pids.length ? { ...schedule.yielded, pids } : undefined
      if (!schedule.yielded) delete schedule.yielded
    }
  }
  schedule.queue = schedule.queue.filter(request => request.person || request.ticketIds.some(context.live))
  for (const job of schedule.jobs) {
    if (job.state === 'queued' && !schedule.queue.some(request => request.jobId === job.id)) {
      job.state = 'cancelled'
      job.endedAt = at
      job.summary ??= 'its Tickets ended'
    }
  }
  if (schedule.lease) return { schedule }
  const head = ordered(schedule.queue)[0]
  if (!head) return { schedule }
  if (!head.person && personBlock(schedule, context.editor)) return { schedule }
  return { schedule, granted: grant(schedule, head, context) }
}

export interface AcquireRequest { ticketId: string; purpose: EditorPurpose; note?: string; ttlMs?: number }
export type AcquireResult = { state: 'granted'; lease: EditorLease } | { state: 'queued'; position: number; request: EditorRequest }

/**
 * A worker asks for the editor. A holder refreshes its lease and purpose; a waiter keeps its place and updates its note;
 * anyone else joins the queue, and `advance` grants it at once when it is first and the editor is free.
 */
export function acquire(input: EditorSchedule, request: AcquireRequest, context: ScheduleContext):
  { schedule: EditorSchedule; result: AcquireResult; granted?: EditorLease } {
  let schedule = clone(input)
  const at = iso(context.now)
  const ttlMs = clampTtl(request.ttlMs)
  const note = (request.note ?? '').trim().slice(0, 300)
  const current = standing(schedule, request.ticketId)
  if (current.state === 'holding') {
    const lease = schedule.lease!
    lease.purpose = request.purpose
    if (note) lease.note = note
    lease.heartbeatAt = at
    lease.expiresAt = renewed(lease, context.now, ttlMs)
    return { schedule, result: { state: 'granted', lease } }
  }
  if (current.state === 'queued') {
    const item = schedule.queue.find(value => value.id === current.request.id)!
    item.purpose = request.purpose
    item.ttlMs = ttlMs
    if (note) item.note = note
  } else {
    schedule.queue.push({ id: context.id(), ticketIds: [request.ticketId], purpose: request.purpose, note, at, ttlMs })
    event(schedule, { at, kind: 'queued', by: 'agent', ticketIds: [request.ticketId], purpose: request.purpose, ...note ? { detail: note } : {} })
  }
  const advanced = advance(schedule, context)
  schedule = advanced.schedule
  const now = standing(schedule, request.ticketId)
  if (now.state === 'holding') return { schedule, result: { state: 'granted', lease: now.lease }, ...advanced.granted ? { granted: advanced.granted } : {} }
  if (now.state === 'queued') return { schedule, result: { state: 'queued', position: now.position, request: now.request },
    ...advanced.granted ? { granted: advanced.granted } : {} }
  throw new Error('the editor request was dropped because its Ticket ended')
}

/** A renewed expiry; a lease a person asked to yield cannot be pushed past the grace it was given to save and release. */
function renewed(lease: EditorLease, now: number, ttlMs: number): string {
  const until = now + ttlMs
  return iso(lease.draining ? Math.min(until, Date.parse(lease.draining.at) + DRAIN_GRACE_MS) : until)
}

/** The holder keeps its lease alive, optionally for a longer step. */
export function heartbeat(input: EditorSchedule, ticketId: string, context: ScheduleContext, ttlMs?: number, note?: string): EditorSchedule {
  const schedule = clone(input)
  const lease = schedule.lease
  if (!lease || lease.holder.kind !== 'agent' || lease.holder.ticketId !== ticketId) throw new Error('this Ticket does not hold the editor')
  lease.heartbeatAt = iso(context.now)
  lease.expiresAt = renewed(lease, context.now, clampTtl(ttlMs))
  if (note?.trim()) lease.note = note.trim().slice(0, 300)
  return schedule
}

/** A worker releases what it holds and leaves the queue; a Ticket that holds nothing gets an unchanged schedule. */
export function release(input: EditorSchedule, ticketId: string, context: ScheduleContext, detail?: string): EditorSchedule {
  const schedule = clone(input)
  const at = iso(context.now)
  const lease = schedule.lease
  if (lease?.holder.kind === 'agent' && lease.holder.ticketId === ticketId) endLease(schedule, 'released', 'agent', at, detail?.trim().slice(0, 300))
  const waiting = schedule.queue.filter(request => !request.jobId && !request.person && request.ticketIds.includes(ticketId))
  if (waiting.length) {
    schedule.queue = schedule.queue.filter(request => !waiting.includes(request))
    event(schedule, { at, kind: 'cancelled', by: 'agent', ticketIds: [ticketId] })
  }
  return schedule
}

/**
 * Queues a job the host will run once it holds the editor; a build already waiting absorbs this Ticket instead. A Ticket
 * that holds the editor itself hands it to its job, so its own lease never makes its job wait behind it; a lease a person
 * asked to yield is released instead, and the job waits its turn.
 */
export function submitJob(input: EditorSchedule, job: { kind: EditorJobKind; ticketId: string; directory: string; filter?: string },
  context: ScheduleContext):
  { schedule: EditorSchedule; job: EditorJob; merged: boolean; granted?: EditorLease } {
  const schedule = clone(input)
  const at = iso(context.now)
  const held = schedule.lease?.holder.kind === 'agent' && schedule.lease.holder.ticketId === job.ticketId ? schedule.lease : null
  const handover = held && !held.draining
  if (held) endLease(schedule, 'released', 'agent', at, handover ? `handed to its ${job.kind} job` : undefined)
  if (job.kind === 'build') {
    const waiting = schedule.jobs.find(item => item.kind === 'build' && item.state === 'queued' && item.directory === job.directory)
    if (waiting) {
      if (!waiting.ticketIds.includes(job.ticketId)) waiting.ticketIds.push(job.ticketId)
      const request = schedule.queue.find(item => item.jobId === waiting.id)
      if (request && !request.ticketIds.includes(job.ticketId)) request.ticketIds.push(job.ticketId)
      event(schedule, { at, kind: 'queued', by: 'agent', ticketIds: [job.ticketId], purpose: 'build', detail: `joins ${waiting.id}` })
      return { schedule, job: waiting, merged: true }
    }
  }
  const value: EditorJob = { id: context.id(), kind: job.kind, ticketIds: [job.ticketId], ...job.filter ? { filter: job.filter } : {},
    directory: job.directory, state: 'queued', createdAt: at }
  schedule.jobs.push(value)
  const purpose: EditorPurpose = job.kind
  const request: EditorRequest = { id: context.id(), ticketIds: [job.ticketId], purpose, note: job.filter ?? '', at, jobId: value.id, ttlMs: MAX_LEASE_MS }
  schedule.queue.push(request)
  event(schedule, { at, kind: 'queued', by: 'agent', ticketIds: [job.ticketId], purpose, ...job.filter ? { detail: job.filter } : {} })
  if (handover) return { schedule, job: value, merged: false, granted: grant(schedule, request, context) }
  return { schedule, job: value, merged: false }
}

/** Records a job's start or end; an ended job releases the lease it held and prunes old ended jobs. */
export function updateJob(input: EditorSchedule, jobId: string, patch: Partial<EditorJob>, context: ScheduleContext): EditorSchedule {
  const schedule = clone(input)
  const job = schedule.jobs.find(item => item.id === jobId)
  if (!job) return schedule
  Object.assign(job, patch)
  const at = iso(context.now)
  if (patch.state && patch.state !== 'running' && patch.state !== 'queued') {
    job.endedAt ??= at
    event(schedule, { at, kind: 'job', by: 'host', ticketIds: job.ticketIds, purpose: job.kind, detail: `${job.state}${job.summary ? `: ${job.summary}` : ''}` })
    if (schedule.lease?.holder.kind === 'job' && schedule.lease.holder.jobId === jobId) endLease(schedule, 'released', 'host', at)
    schedule.queue = schedule.queue.filter(request => request.jobId !== jobId)
  }
  const ended = schedule.jobs.filter(item => item.state !== 'queued' && item.state !== 'running')
  if (ended.length > MAX_ENDED_JOBS) {
    const drop = new Set(ended.slice(0, ended.length - MAX_ENDED_JOBS).map(item => item.id))
    schedule.jobs = schedule.jobs.filter(item => !drop.has(item.id))
  }
  return schedule
}

/** A person's actions on the overview; each is recorded as a person's event. */
export type PersonAction = { kind: 'claim' } | { kind: 'release' } | { kind: 'yield' } | { kind: 'preempt'; reason: string }
  | { kind: 'front'; requestId: string } | { kind: 'cancel'; requestId: string }

/**
 * Applies a person's action. Claiming takes a free editor at once or waits at the front while the agent drains;
 * yielding releases a claim and lets agents use the interactive editors that are open now; preempting asks the holder
 * to yield (a job is cancelled by the caller); front and cancel reorder or drop a wait.
 */
export function personAct(input: EditorSchedule, action: PersonAction, context: ScheduleContext):
  { schedule: EditorSchedule; drained?: EditorLease; cancelledJob?: string } {
  const schedule = clone(input)
  const at = iso(context.now)
  switch (action.kind) {
    case 'claim': {
      if (schedule.lease?.holder.kind === 'person') return { schedule }
      delete schedule.yielded
      if (!schedule.queue.some(request => request.person)) {
        schedule.queue.push({ id: context.id(), ticketIds: [], purpose: 'use', note: '', at, ttlMs: MAX_LEASE_MS, person: true })
      }
      if (schedule.lease && !schedule.lease.draining) {
        schedule.lease.draining = { at, reason: '人要用编辑器' }
        event(schedule, { at, kind: 'preempted', by: 'person', purpose: schedule.lease.purpose, detail: '人要用编辑器' })
        const drained = schedule.lease
        return { schedule: advance(schedule, context).schedule, drained,
          ...drained.holder.kind === 'job' ? { cancelledJob: drained.holder.jobId } : {} }
      }
      return { schedule: advance(schedule, context).schedule }
    }
    case 'release': {
      // Done with a claim: the claim ends, but an editor the person still has open stays theirs.
      if (schedule.lease?.holder.kind === 'person') endLease(schedule, 'released', 'person', at)
      schedule.queue = schedule.queue.filter(request => !request.person)
      return { schedule }
    }
    case 'yield': {
      if (schedule.lease?.holder.kind === 'person') endLease(schedule, 'released', 'person', at)
      schedule.queue = schedule.queue.filter(request => !request.person)
      const pids = interactivePids(context.editor).filter(pid => !schedule.agentPids.includes(pid))
      if (pids.length) schedule.yielded = { at, pids }
      event(schedule, { at, kind: 'yielded', by: 'person', ...pids.length ? { detail: `pid ${pids.join(', ')}` } : {} })
      return { schedule }
    }
    case 'preempt': {
      const lease = schedule.lease
      if (!lease || lease.holder.kind === 'person') return { schedule }
      lease.draining = { at, reason: action.reason.trim().slice(0, 300) || '人要求让出' }
      event(schedule, { at, kind: 'preempted', by: 'person', purpose: lease.purpose, detail: lease.draining.reason,
        ticketIds: lease.holder.kind === 'agent' ? [lease.holder.ticketId] : lease.holder.ticketIds })
      return { schedule, drained: lease, ...lease.holder.kind === 'job' ? { cancelledJob: lease.holder.jobId } : {} }
    }
    case 'front': {
      const request = schedule.queue.find(item => item.id === action.requestId)
      if (!request) throw new Error('that wait is no longer in the queue')
      request.front = at
      event(schedule, { at, kind: 'front', by: 'person', ticketIds: request.ticketIds, purpose: request.purpose })
      return { schedule }
    }
    case 'cancel': {
      const request = schedule.queue.find(item => item.id === action.requestId)
      if (!request) throw new Error('that wait is no longer in the queue')
      schedule.queue = schedule.queue.filter(item => item !== request)
      event(schedule, { at, kind: 'cancelled', by: 'person', ticketIds: request.ticketIds, purpose: request.purpose })
      return { schedule, ...request.jobId ? { cancelledJob: request.jobId } : {} }
    }
  }
}
