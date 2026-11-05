/**
 * The application side of the idle pool's read-only analysis (docs/025): it grounds an analysis in the tickets the
 * deterministic relation guess finds likely duplicates, and shapes the state a card or a board row shows. The analysis
 * itself is the worker's; the core owns its state and instructions.
 */
import { ANALYSIS_VERDICT_LABELS, analysisOf, analysisAdvice, latestReport, ticketPriority, ticketStage, threadKey,
  type AnalysisRelated, type AnalysisVerdict, type Ticket } from '../core/index.ts'
import { similarEdges } from './views/similar.ts'
import type { Store } from './store.ts'

/** How many tickets the guess reads: a bounded batch, not the whole history, so a launch stays cheap. */
const GUESS_LIMIT = 60

/** The thread a ticket started on, which the relation guess reads; an empty one when its origin is gone. */
function originThread(store: Pick<Store, 'triggers'>, ticket: Ticket): string {
  const trigger = store.triggers.get(ticket.origin.triggerId)
  return trigger ? threadKey(trigger.threads[0]!) : ticket.channels[0] ? `${ticket.channels[0].source}:${ticket.channels[0].thread}` : ''
}

/**
 * The tickets the relation graph's own deterministic guess finds most likely to describe the same problem as `ticket`,
 * strongest first. It is a guess for the analyst to verify, never a recorded relation and never a decision: the analysis
 * brief says so, and the verdict still names the ids it believes are duplicates.
 */
export function relatedForAnalysis(store: Pick<Store, 'tickets' | 'triggers'>, ticket: Ticket, limit = 3): AnalysisRelated[] {
  if (limit <= 0) return []
  const open = store.tickets.open().filter(item => item.id !== ticket.id)
  // The pool is what the analysis sorts; older ended tickets are history and would only dilute the batch's TF-IDF.
  const batch = [ticket, ...open.slice(0, GUESS_LIMIT)]
  const explicit = batch.flatMap(item => (item.relations ?? []).map(relation => ({ from: item.id, to: relation.ticketId })))
  const edges = similarEdges(batch.map(item => ({ ticket: item, thread: originThread(store, item),
    message: store.triggers.get(item.origin.triggerId)?.text ?? '' })), explicit)
  const byId = new Map(batch.map(item => [item.id, item]))
  return edges.filter(edge => edge.from === ticket.id || edge.to === ticket.id)
    .sort((left, right) => right.strength - left.strength)
    .slice(0, limit)
    .flatMap(edge => {
      const other = byId.get(edge.from === ticket.id ? edge.to : edge.from)
      if (!other) return []
      return [{ id: other.id, title: other.title, priority: ticketPriority(other), stage: ticketStage(other).stage,
        summary: latestReport(other)?.summary, score: edge.strength }]
    })
}

/** What a ticket's idle analysis is, as a card or a board row says it: its state and, once recorded, its verdict. */
export interface AnalysisView {
  state: 'running' | 'ready' | 'failed'
  verdict?: AnalysisVerdict
  /** The verdict's one-sentence reason, when it has one. */
  reason?: string
  /** What promoting the ticket would cost, when the analysis estimated it. */
  cost?: string
  /** The tickets the analysis believes are duplicates. */
  mergeWith?: string[]
  startedAt: string
  endedAt?: string
  /** How the verdict reads: 值得现在投入注意力 / 并入同类 / 先归档. */
  label?: string
}

/** The analysis state and verdict a card shows, or undefined when the ticket never entered the idle pool's analysis. */
export function analysisView(ticket: Pick<Ticket, 'idle'>): AnalysisView | undefined {
  const analysis = analysisOf(ticket)
  if (!analysis) return undefined
  const advice = analysisAdvice(ticket)
  return { state: analysis.state, startedAt: analysis.startedAt, ...analysis.endedAt ? { endedAt: analysis.endedAt } : {},
    ...advice ? { verdict: advice.verdict, reason: advice.reason, label: ANALYSIS_VERDICT_LABELS[advice.verdict],
      ...advice.mergeWith?.length ? { mergeWith: advice.mergeWith } : {}, ...advice.cost ? { cost: advice.cost } : {} } : {} }
}
