/**
 * The ticket relation graph: every ticket as a node and how tickets relate as edges, for the panel's relation view.
 * `spawned` and same-thread edges are derived from the records; `supersedes`, `blocks` and `related` ones are what workers
 * recorded with `orchestrator_ticket_link` (see `Ticket.relations`); `similar` ones are guesses (see `similar.ts`).
 */
import { threadKey, ticketStage, type Ticket, type TicketRelationKind } from '../../core/index.ts'
import type { Store } from '../store.ts'
import type { ViewHost } from './records.ts'
import { threadTitle } from './records.ts'
import { similarEdges, type SimilarEdge } from './similar.ts'

/** Where an edge comes from: the records (`handback`, `split`, `thread`), a worker's link, or a guess (`fuzzy`). */
export type GraphEdgeVia = 'handback' | 'split' | 'thread' | 'link' | 'fuzzy'
export interface GraphEdge {
  /** The ticket the relation reads from: the parent of `spawned`, the one that supersedes or blocks, the older of a `similar` pair. */
  from: string
  to: string
  /** A relation, or `similar`: a likely relation nothing recorded, guessed from titles, shared modules or ids, and timing. */
  kind: TicketRelationKind | 'similar'
  via: GraphEdgeVia
  /** The worker's or the hand-back's reason, when it gave one; for a `similar` edge, the signals behind the guess. */
  reason?: string
  /** How sure a `similar` edge is, from its threshold up to 1; absent on the others. */
  strength?: number
  at: string
}
/** An edge that is a relation rather than a guess. */
type RelationEdge = GraphEdge & { kind: TicketRelationKind }
const isRelation = (edge: GraphEdge): edge is RelationEdge => edge.kind !== 'similar'
export interface GraphNode {
  id: string
  title: string
  /** `ticketStage`'s stage, which the panel colours. */
  stage: ReturnType<typeof ticketStage>['stage']
  outcome?: NonNullable<Ticket['ended']>['outcome']
  source: string
  createdAt: string
  /** When it ended, or undefined while it is open. */
  endedAt?: string
  /** The Thread it started on, which groups it into a lane. */
  thread: string
}
export interface GraphLane { key: string; title: string }
export interface TicketGraphView { nodes: GraphNode[]; edges: GraphEdge[]; lanes: GraphLane[]; total: number }

/** How many of the newest tickets the graph holds at most, so the view stays readable and cheap to lay out. */
export const GRAPH_LIMIT = 300

/**
 * The relation graph of the newest `limit` tickets: a ticket started from a message another ticket handed back is
 * `spawned` by it; tickets one Decision opened together, and tickets started on the same Thread, are `related`, chained
 * in creation order rather than all to all; recorded relations follow as their workers wrote them. Edges to a ticket
 * beyond the limit are left out. The `similar` guesses among the same tickets come last.
 */
export function ticketGraph(host: Pick<ViewHost, 'store'>, limit = GRAPH_LIMIT): TicketGraphView {
  const { store } = host
  const all = store.tickets.list()
  const tickets = all.slice(0, Math.max(1, limit)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const ids = new Set(tickets.map(ticket => ticket.id))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const add = (edge: GraphEdge) => {
    if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to)) return
    // A derived edge is dropped when the pair already has a stronger one, and the same relation is kept once.
    const pair = [edge.from, edge.to].sort().join('|')
    if (seen.has(`${edge.kind}|${edge.from}|${edge.to}`) || (edge.via !== 'link' && edge.kind === 'related' && seen.has(`any|${pair}`))) return
    seen.add(`${edge.kind}|${edge.from}|${edge.to}`); seen.add(`any|${pair}`)
    edges.push(edge)
  }
  const originThread = (ticket: Ticket) => {
    const trigger = store.triggers.get(ticket.origin.triggerId)
    return trigger ? threadKey(trigger.threads[0]!) : ticket.channels[0] ? `${ticket.channels[0].source}:${ticket.channels[0].thread}` : ''
  }
  // Spawned: the origin message had been handed back by another ticket's worker.
  for (const ticket of tickets) {
    const handbacks = store.triggers.disposition(ticket.origin.triggerId)?.handbacks ?? []
    for (const item of handbacks) add({ from: item.ticketId, to: ticket.id, kind: 'spawned', via: 'handback', reason: item.reason, at: ticket.createdAt })
  }
  // Recorded links come before the derived related edges, so a pair keeps the worker's word.
  for (const ticket of tickets) {
    for (const relation of ticket.relations ?? []) add({ from: ticket.id, to: relation.ticketId, kind: relation.kind, via: 'link',
      reason: relation.reason, at: relation.at })
  }
  // Split: one Decision opened several tickets.
  const byDecision = new Map<string, Ticket[]>()
  for (const ticket of tickets) byDecision.set(ticket.decisionId, [...byDecision.get(ticket.decisionId) ?? [], ticket])
  for (const group of byDecision.values()) chain(group, (from, to) => add({ from, to, kind: 'related', via: 'split', at: group[0]!.createdAt }))
  // Same Thread: tickets started on one conversation.
  const lanes = new Map<string, Ticket[]>()
  for (const ticket of tickets) { const key = originThread(ticket); lanes.set(key, [...lanes.get(key) ?? [], ticket]) }
  for (const group of lanes.values()) chain(group, (from, to, at) => add({ from, to, kind: 'related', via: 'thread', at }))
  edges.push(...similarOf(store, tickets, edges, originThread))
  const nodes = tickets.map((ticket): GraphNode => ({ id: ticket.id, title: ticket.title, stage: ticketStage(ticket).stage,
    ...ticket.ended ? { outcome: ticket.ended.outcome, endedAt: ticket.ended.at } : {},
    source: ticket.mandate.actor.source, createdAt: ticket.createdAt, thread: originThread(ticket) }))
  const laneList = [...lanes.keys()].map(key => {
    const thread = key ? store.threads.get(key) : undefined
    return { key, title: thread ? threadTitle(store, thread) : key }
  })
  return { nodes, edges, lanes: laneList, total: all.length }
}
/** The last guesses per store, with what they were computed from; the panel polls the graph, and most polls change nothing. */
const guesses = new WeakMap<object, { key: string; edges: SimilarEdge[] }>()
/** The `similar` edges among `tickets`, computed again only once a ticket changed or the set of tickets or edges did. */
function similarOf(store: Pick<Store, 'triggers'>, tickets: Ticket[], explicit: GraphEdge[], thread: (ticket: Ticket) => string): SimilarEdge[] {
  const updated = tickets.reduce((last, ticket) => ticket.updatedAt > last ? ticket.updatedAt : last, '')
  const key = [tickets.length, updated, tickets[0]?.id, tickets.at(-1)?.id, explicit.length].join('|')
  const cached = guesses.get(store)
  if (cached?.key === key) return cached.edges
  const edges = similarEdges(tickets.map(ticket => ({ ticket, thread: thread(ticket), message: store.triggers.get(ticket.origin.triggerId)?.text ?? '' })),
    explicit)
  guesses.set(store, { key, edges })
  return edges
}
/** Calls `link` for each consecutive pair of tickets in creation order. */
function chain(group: Ticket[], link: (from: string, to: string, at: string) => void): void {
  for (let index = 1; index < group.length; index++) link(group[index - 1]!.id, group[index]!.id, group[index]!.createdAt)
}
/**
 * One relation as a ticket's page lists it: the other ticket, the kind, and whether this ticket is where it reads from.
 * Guesses are not relations, so the page lists none.
 */
export interface TicketRelationView { ticket: { id: string; title: string; stage: GraphNode['stage'] }; kind: TicketRelationKind
  via: Exclude<GraphEdgeVia, 'fuzzy'>; outgoing: boolean; reason?: string }
/**
 * The relations of one ticket other than the same-Thread chain, which its page already shows as its Thread: whom it
 * spawned or was spawned by, the tickets split from one request with it, and what its worker or others recorded.
 */
export function ticketRelations(host: Pick<ViewHost, 'store'>, id: string): TicketRelationView[] {
  const graph = ticketGraph(host)
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  return graph.edges.filter(isRelation).filter(edge => edge.via !== 'thread' && (edge.from === id || edge.to === id)).map(edge => {
    const other = nodes.get(edge.from === id ? edge.to : edge.from)!
    return { ticket: { id: other.id, title: other.title, stage: other.stage }, kind: edge.kind, via: edge.via as TicketRelationView['via'],
      outgoing: edge.from === id,
      ...edge.reason ? { reason: edge.reason } : {} }
  })
}
