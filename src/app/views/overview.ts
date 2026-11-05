/** Overview view: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow. */
import { completedArchived, reasonText, ticketPriority, ticketStage, waitsForIdle, type Decision, type PriorityLevel, type Thread,
  type Ticket } from '../../core/index.ts'
import type { Health } from '../../sources/host.ts'
import type { SetupProblem } from '../../setup.ts'
import type { EditorView } from '../editor.ts'
import type { BillingView } from '../billing.ts'
import { anyoneAllowed } from '../../policy.ts'
import type { Store } from '../store.ts'
import { awaitingEval, dayAgo, delivered, newestFirst, ownersOf, snapshot, threadSummary, type ViewHost } from './records.ts'
import { sourceHealth, type HealthMap } from './sources.ts'
import { ticketRow, type ExecutorLoad } from './tickets.ts'
import { preview } from './text.ts'

/** Level order of the board: urgent first, then the mainline, then the pool. */
const LEVEL_RANK: Record<PriorityLevel, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
/** Machine rows lead with the most important work, then the most recently touched. */
const byLevel = (left: Ticket, right: Ticket): number =>
  LEVEL_RANK[ticketPriority(left)] - LEVEL_RANK[ticketPriority(right)] || newestFirst(left, right)
/** Pool rows lead with the level, then with the work that has waited longest, so nothing starves unseen. */
const oldestFirst = (left: Ticket, right: Ticket): number =>
  LEVEL_RANK[ticketPriority(left)] - LEVEL_RANK[ticketPriority(right)] || left.createdAt.localeCompare(right.createdAt)
/** Threads whose latest decision since `since` is an undismissed `unavailable` eval and that are neither evaluating nor queued. */
function unjudged(store: Store, since: string): { thread: Thread; decision: Decision }[] {
  const seen = new Set<string>()
  const queue = { store, owners: ownersOf(store) }
  return store.read.decisionsOfKinds(['unavailable'], 200).filter(decision => decision.at >= since).flatMap(decision => {
    if (seen.has(decision.threadKey)) return []
    seen.add(decision.threadKey)
    const thread = store.threads.get(decision.threadKey)
    if (!thread || thread.evaluating || awaitingEval(queue, thread).length || decision.dismissed) return []
    if (store.decisions.byThread(thread.key).at(-1)?.id !== decision.id) return []
    return [{ thread, decision }]
  })
}
/** Reports error health when any thread has an undismissed `unavailable` eval from the last hour without a newer decision or active eval. */
export function evalsHealth(store: Store, now = Date.now()): Health {
  const since = new Date(now - 3_600_000).toISOString()
  const open = unjudged(store, since)
  if (!open.length) return { state: 'ready', detail: 'No unavailable Eval in the last hour' }
  const latest = open[0]!.decision
  return { state: 'error', at: latest.at, detail: `${open.length} Eval(s) unavailable in the last hour without a later judgement; `
    + `the latest on ${latest.threadKey}: ${reasonText(latest.reason)}` }
}
/**
 * Builds the operator overview: active system problems, tickets awaiting human action, executor load, and 24-hour trigger flow.
 * @param setup - Setup problem to surface first (where setup stopped, or a Source paused by setup).
 * @param editor - The editor occupancy row, null until the first process probe finishes.
 */
export function overview(host: ViewHost, health: HealthMap, policyVersionValue: string, load: ExecutorLoad, setup?: SetupProblem,
  editor?: EditorView | null) {
  const { store, sources } = host
  const view = snapshot(host)
  const settings = store.settings()
  const now = new Date().toISOString(), since = dayAgo()
  const evaluating = store.threads.active().filter(thread => thread.evaluating)
  const instances = sources.instances()
  const running = instances.filter(instance => instance.enabled && instance.installed).map(instance => sourceHealth(sources, instance, health))
  // Exclude source-owned and policy-sync health entries so only core runtime errors surface as `runtime-error`.
  const sourceParts = new Set(instances.flatMap(instance => sources.kind(instance.kind)?.health ?? []))
  const problems = [
    ...(setup ? [{ kind: 'setup' as const, ...setup }] : []),
    ...(running.length ? [] : [{ kind: 'no-source' as const }]),
    // Only allowed senders can originate work, so empty allowlists mean no request can ever become a ticket.
    ...(anyoneAllowed(settings) ? [] : [{ kind: 'no-allowed' as const }]),
    ...running.flatMap(source => source.health.filter(item => item.state === 'error').map(item => ({ kind: 'source-error' as const, source: { id: source.id, title: source.title, health: item } }))),
    ...(settings.paused ? [{ kind: 'executor-paused' as const }] : []),
    // Unavailable Evals behind the `evals` health entry are listed individually as `eval-unavailable` below; stalled Tickets
    // behind `stall` already carry their own "no update" mark in the board's running lane.
    ...Object.entries(health).filter(([name, item]) => item.state === 'error' && !sourceParts.has(name) && !name.startsWith('sync:')
      && name !== 'evals' && name !== 'stall')
      .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
    ...evaluating.filter(thread => thread.evaluating!.deadline < now)
      .map(thread => ({ kind: 'eval-overdue' as const, thread: threadSummary(view, thread) })),
    ...unjudged(store, since).map(({ thread, decision }) => ({ kind: 'eval-unavailable' as const, decisionId: decision.id,
      thread: threadSummary(view, thread), reason: decision.reason, triggerId: decision.triggerIds[0] ?? '' })),
    // A refused message waits for a person rather than a timer, so its row offers sending it again or withdrawing it.
    ...store.read.failingReplies().map(item => ({ kind: 'outgoing' as const, outgoing: { id: item.id, channel: item.channel,
      text: preview(item.text),
      attempts: item.attempts, error: item.error, refused: item.refused } })),
  ]
  const open = store.tickets.open().sort(newestFirst)
  const all = store.tickets.list()
  const completedAll = all.filter(ticket => ticket.ended?.outcome === 'completed')
  // A completed ticket leaves the board after its retention window; it stays queryable by id and search.
  const completed = completedAll.filter(ticket => !completedArchived(ticket, now))
  // Delivered work a person has not passed is verification work, even when the Ticket ended before the gate existed. It
  // leaves Recently ended for the verification lane, so "completed" never hides work still owed to a person.
  const awaiting = completed.filter(ticket => ticket.verification?.state !== 'passed' && delivered(ticket))
    .sort((left, right) => (left.verification?.at ?? left.ended?.at ?? '').localeCompare(right.verification?.at ?? right.ended?.at ?? ''))
  const awaitingIds = new Set(awaiting.map(ticket => ticket.id))
  const verification = [...open.filter(ticket => {
    const stage = ticketStage(ticket)
    return stage.stage === 'person' && stage.action === 'verify'
  }), ...awaiting]
  // The board's machine lane is the executor itself: a worker turn running now, or mainline work queued for a slot or the
  // next turn. Discretionary P2/P3 work between turns is the idle pool, never a running row (docs/019).
  const pooled = (ticket: Ticket) => waitsForIdle(ticketPriority(ticket))
  const working = open.filter(ticket => {
    const stage = ticketStage(ticket)
    return stage.stage === 'working' && (!pooled(ticket) || stage.action !== 'queued')
  }).sort(byLevel)
  const idle = open.filter(ticket => ticketStage(ticket).stage === 'idle' && !pooled(ticket)).sort(byLevel)
  // Only P2 is shown as work a person may pick up; P3 is 暂存 and stays a count until the person asks for it.
  const pool = open.filter(ticket => {
    if (!pooled(ticket)) return false
    const stage = ticketStage(ticket)
    return stage.stage === 'idle' || (stage.stage === 'working' && stage.action === 'queued')
  }).sort(oldestFirst)
  const parked = pool.filter(ticket => ticketPriority(ticket) === 'P3')
  // Pipeline work is after delivery: blocked tickets first, then the ones still being followed.
  const pipeline = open.filter(ticket => ticketStage(ticket).stage === 'pipeline')
    .sort((left, right) => Number(right.pipeline?.state === 'blocked') - Number(left.pipeline?.state === 'blocked')
      || (left.pipeline?.at ?? '').localeCompare(right.pipeline?.at ?? ''))
  const ended = all.filter(ticket => ticket.ended && !awaitingIds.has(ticket.id) && !completedArchived(ticket, now)).sort(newestFirst).slice(0, 6)
  const endedStats = { completed: completed.length, verified: completed.filter(ticket => ticket.verification?.state === 'passed').length,
    pending: awaiting.length,
    agent: completed.filter(ticket => ticket.execution?.verification).length,
    none: completed.filter(ticket => !ticket.execution?.verification).length,
    changelist: completed.filter(ticket => ticket.execution?.changelist !== undefined).length,
    archived: completedAll.length - completed.length }
  const stats = Object.values(store.read.triggerStats(since))
  const received = stats.reduce((sum, item) => sum + item.received, 0), filtered = stats.reduce((sum, item) => sum + item.filtered, 0)
  const judgement = store.read.flow(since)
  return {
    problems,
    person: open.filter(ticket => {
      const stage = ticketStage(ticket)
      return stage.stage === 'person' && stage.action !== 'verify'
    }).map(ticket => ticketRow(view, ticket)),
    verification: verification.map(ticket => ticketRow(view, ticket)),
    pipeline: pipeline.map(ticket => ticketRow(view, ticket)),
    working: working.map(ticket => ticketRow(view, ticket)),
    idle: idle.map(ticket => ticketRow(view, ticket)),
    pool: pool.filter(ticket => ticketPriority(ticket) === 'P2').map(ticket => ticketRow(view, ticket)),
    parked: parked.map(ticket => ticketRow(view, ticket)),
    ended: ended.map(ticket => ticketRow(view, ticket)),
    endedStats,
    executor: { ...load, maxWorkers: settings.executor.maxWorkers, idle: pool.length + idle.length },
    flow: { received, filtered, triggers: received - filtered, judged: judgement.judged, accepted: judgement.accepted,
      evaluating: evaluating.length, dropped: store.read.droppedSince(since) },
    editor: editor ?? null,
    policyVersion: policyVersionValue,
  }
}
export type OverviewView = ReturnType<typeof overview> & {
  /** The board's billing strip; absent when an older host serves the overview. */
  billing?: BillingView
}
