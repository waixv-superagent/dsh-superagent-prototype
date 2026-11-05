/** Ticket list, ticket detail, mandate basis formatting, and executor load views. */
import { completedArchived, latestReport, liveTicket, pendingPlan, planLines, planTemplate, threadKey, ticketKind, ticketStage, type AcceptMode, type TicketKind, type AdmissionCell,
  type MandateBasis, type Ticket, type TicketStage } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import { KV } from '../../kv.ts'
import { feishuClientLink } from '../../sources/feishu-channel.ts'
import type { Store } from '../store.ts'
import { channelLink, decisionView, delivered, newestFirst, page, snapshot, threadFacts, threadSummary, threadTitle, ticketLine, ticketSummary,
  type Snapshot, type ViewHost } from './records.ts'
import { markdown, preview } from './text.ts'
import { feishuTrace } from './trace.ts'
import { ticketRelations } from './graph.ts'

export type BasisFact =
  | { name: 'addressed'; value: 'mention' | 'direct' } | { name: 'followup' } | { name: 'admission'; value: AdmissionCell } | { name: 'observation' }
  | { name: 'mode'; value: AcceptMode } | { name: 'rules'; value: { id: string; name: string }[] } | { name: 'sender'; value: string }
  | { name: 'legacyAuthority'; value: string } | { name: 'bot' }
/**
 * Extracts displayable mandate admission facts in reading order (omitting the receiving scope, which is stored
 * only for re-validation), marking pre-scope records that only have `authority` as `legacy`.
 */
export function basisFacts(basis: MandateBasis, rule: Snapshot['rule']): { facts: BasisFact[]; legacy: boolean } {
  const facts: BasisFact[] = []
  if (basis.sender) facts.push({ name: 'sender', value: basis.sender })
  if (basis.via === 'bot') facts.push({ name: 'bot' })
  if (basis.via !== 'followup' && basis.addressed) facts.push({ name: 'addressed', value: basis.addressed })
  // Imported bases already record their follow-up in `authority`.
  if (basis.via === 'followup' && !basis.authority) facts.push({ name: 'followup' })
  if (basis.via === 'admission') facts.push({ name: 'admission', value: basis.cell })
  const observation = basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot' ? basis.observation : undefined
  // Listed bot messages are inferred candidates regardless of where received, so only the accept mode is shown from `observation`.
  if (observation && basis.via !== 'bot') facts.push({ name: 'observation' })
  if (observation?.mode) facts.push({ name: 'mode', value: observation.mode })
  if (basis.rules?.length) facts.push({ name: 'rules', value: basis.rules.map(rule) })
  const authority = basis.via === 'followup' || basis.via === 'listed' ? basis.authority : undefined
  if (authority) facts.push({ name: 'legacyAuthority', value: authority })
  return { facts, legacy: authority !== undefined }
}
export function ticketList(host: ViewHost, stage: 'open' | TicketStage['stage'] | 'verify' | 'unverified', offset: number, limit: number,
  kind?: TicketKind) {
  const view = snapshot(host)
  const { store } = view
  const shown = (ticket: Ticket) => {
    if (stage === 'open') return liveTicket(ticket)
    if (stage === 'unverified' || stage === 'verify') {
      // Verification work is both a live gate and delivered Tickets that ended before the gate existed.
      const waiting = ticket.verification?.state !== 'passed' && delivered(ticket)
      const own = ticketStage(ticket)
      return stage === 'unverified' ? !liveTicket(ticket) && ticket.ended?.outcome === 'completed' && waiting
        : own.stage === 'person' && own.action === 'verify' || !liveTicket(ticket) && ticket.ended?.outcome === 'completed' && waiting
    }
    const own = ticketStage(ticket)
    return own.stage === stage
  }
  const tickets = (stage === 'ended' || stage === 'unverified' || stage === 'verify' ? store.tickets.list() : store.tickets.open())
    .filter(ticket => !completedArchived(ticket)).filter(shown).sort(newestFirst)
  // How many of the stage's tickets are of each kind, counted before the kind filter, so every kind pill shows its own total.
  const kinds: Partial<Record<TicketKind, number>> = {}
  for (const ticket of tickets) { const own = ticketKind(ticket).kind; kinds[own] = (kinds[own] ?? 0) + 1 }
  const result = page(kind ? tickets.filter(ticket => ticketKind(ticket).kind === kind) : tickets, offset, limit)
  return { ...result, kinds, items: result.items.map(ticket => ticketRow(view, ticket)) }
}
export type TicketListView = ReturnType<typeof ticketList>
/** Why a search hit matched, in data the panel can label without guessing: the field and the concrete value it saw. */
export type TicketMatch = { field: 'id' | 'changelist' | 'review' | 'title' | 'summary' | 'thread' | 'actor' | 'feishu'; text: string }
export type TicketSearchHit = { ticket: ReturnType<typeof ticketSummary>; match: TicketMatch; archived?: true }
/**
 * Finds Tickets by what a person remembers: an id, a changelist, a review, a title or summary phrase, a Thread, or the
 * requester. Results rank identifiers above text and recently updated work above stale work; archived Tickets stay
 * findable but carry `archived` so the panel can say why they are not on the board.
 */
export function ticketSearch(host: ViewHost, query: string, limit = 8) {
  const value = query.trim()
  if (!value) return { tickets: [] as TicketSearchHit[], total: 0 }
  const view = snapshot(host)
  const { store } = view
  const lower = value.toLowerCase()
  const bare = lower.replace(/^#/, '')
  const terms = lower.split(/\s+/).filter(Boolean)
  const cl = /^(?:cl\s*)?#?(\d{4,})$/i.exec(value)?.[1]
  const reviewNumber = /(?:^|\/)(\d{3,})\/?$/.exec(value)?.[1]
  // A Feishu message, topic or chat a person pasted leads straight to its tickets: the bot's own message first, then the
  // topic, then the chat; the hit shows the Feishu id it matched.
  const traced = new Map(feishuTrace(store, value).map(hit => [hit.ticket.id, hit]))
  const best = (ticket: Ticket): { score: number; match: TicketMatch } | undefined => {
    let found: { score: number; match: TicketMatch } | undefined
    const consider = (score: number, field: TicketMatch['field'], text: string) => {
      if (!found || score > found.score) found = { score, match: { field, text } }
    }
    const trace = traced.get(ticket.id)
    if (trace) consider(trace.via === 'message' ? 950 : trace.via === 'topic' ? 850 : 650, 'feishu', trace.id)
    if (ticket.id.toLowerCase() === bare || bare.length >= 6 && ticket.id.toLowerCase().startsWith(bare)) {
      consider(1000, 'id', `#${ticket.id.slice(0, 8)}`)
    }
    if (cl && ticket.execution?.changelist === Number(cl)) consider(900, 'changelist', `CL ${ticket.execution.changelist}`)
    const review = ticket.execution?.review
    if (review) {
      const reviewLower = review.toLowerCase()
      if (reviewLower === lower || reviewLower.includes(lower) || reviewNumber && reviewLower.includes(reviewNumber)) {
        consider(800, 'review', review)
      }
    }
    const title = ticket.title.toLowerCase()
    if (terms.every(term => title.includes(term))) consider(500 + (title.includes(lower) ? 40 : 0), 'title', value)
    const summary = latestReport(ticket)?.summary ?? ''
    if (summary && terms.every(term => summary.toLowerCase().includes(term))) {
      consider(300, 'summary', preview(summary, 80))
    }
    const threadKeys = [...(ticket.follows ?? []).map(follow => follow.thread), ...view.threadsOf(ticket.id).map(thread => thread.key)]
    for (const key of threadKeys) {
      const thread = store.threads.get(key)
      const titleText = thread ? threadTitle(store, thread) : key
      if (key.toLowerCase().includes(lower) || titleText.toLowerCase().includes(lower)) consider(700, 'thread', titleText)
    }
    const trigger = store.triggers.get(ticket.origin.triggerId)
    const actor = trigger ? view.actor(trigger.actor, trigger.human) : undefined
    if (actor) {
      const name = typeof actor.name === 'string' ? actor.name : actor.name?.zh || actor.name?.en || ''
      if (actor.id.toLowerCase().includes(lower) || name.toLowerCase().includes(lower)) consider(600, 'actor', name || actor.id)
    }
    return found
  }
  const hits = store.tickets.list().flatMap(ticket => {
    const found = best(ticket)
    return found ? [{ ticket, ...found }] : []
  }).sort((left, right) => right.score - left.score || right.ticket.updatedAt.localeCompare(left.ticket.updatedAt))
  return { total: hits.length, tickets: hits.slice(0, Math.max(1, Math.min(limit, 20))).map(({ ticket, match }) =>
    ({ ticket: ticketSummary(ticket), match, ...completedArchived(ticket) ? { archived: true as const } : {} })) }
}
export type TicketSearchView = ReturnType<typeof ticketSearch>
/**
 * The message the ticket's open question was asked in: the current attention message's own link when it is known (a card or
 * a plain text question alike), else the latest plan card's; undefined when neither link is known.
 */
function questionUrl(view: Snapshot, ticket: Pick<Ticket, 'id' | 'attention'>): string | undefined {
  const attention = ticket.attention
  if (attention) {
    // A question may have been sent more than once, such as a card replaced by its text fallback: the newest message is
    // what the person should land on.
    const asked = Object.values(view.store.get(KV.feishu.attentionCards) ?? {})
      .filter(ref => ref.ticketId === ticket.id && ref.attentionId === attention.id && ref.url)
      .sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
    if (asked[0]?.url) return asked[0].url
  }
  const cards = view.store.get(KV.feishu.cards) ?? {}
  return Object.values(cards).find(ref => ref.ticketId === ticket.id && ref.url)?.url
}
/** The open Feishu topic a ticket's conversation lives in: the right conversation even when the question's message is unknown. */
function topicAnswerUrl(view: Snapshot, ticket: Pick<Ticket, 'id'>): string | undefined {
  for (const thread of view.threadsOf(ticket.id)) {
    if (thread.ref.source !== 'feishu') continue
    const url = threadFacts(view.store, thread).url
    if (url) return url
  }
  return undefined
}
/** Where a person answers a ticket waiting on them: the question's message when known, else its topic, else its chat. */
function answerLink(view: Snapshot, ticket: Ticket, stage: TicketStage['stage']) {
  if (stage !== 'person') return undefined
  const channel = ticket.channels[0]
  const link = channel ? channelLink(view, channel) : undefined
  const url = questionUrl(view, ticket) ?? topicAnswerUrl(view, ticket) ?? link?.url
  if (!url) return link
  // The panel opens the client directly, so answering does not leave Feishu's landing page behind as a browser tab.
  return { ...(link ?? { source: 'feishu' as const, label: { zh: '飞书消息', en: 'Feishu message' } }), url: feishuClientLink(url) }
}
export function ticketRow(view: Snapshot, ticket: Ticket) {
  const line = ticketLine(view, ticket)
  const reply = answerLink(view, ticket, line.stage)
  return { ...line, ...reply ? { reply } : {} }
}
/** Executor slot utilization: `running` worker Sessions in an active turn (which occupy slots and are interrupted by a restart), and tickets `queued` for a slot. */
export interface ExecutorLoad { running: number; queued: number }
export function executorLoad(store: Store, running: number): ExecutorLoad {
  const queued = (ticket: Ticket) => { const stage = ticketStage(ticket); return stage.stage === 'working' && stage.action === 'queued' }
  return { running, queued: store.tickets.open().filter(queued).length }
}
/** The plan a ticket carries, split into lines so the panel can lead with the decision and keep the evidence behind one fold. */
function planView(ticket: Ticket) {
  const plan = ticket.plan
  if (!plan) return undefined
  const template = planTemplate(plan)
  return { text: plan.text, template, lines: planLines(plan.text, template), at: plan.at, waiting: !!pendingPlan(ticket),
    ...plan.question ? { question: plan.question } : {}, ...plan.options?.length ? { options: plan.options } : {},
    ...plan.sections?.length ? { sections: plan.sections } : {},
    ...plan.deadline ? { deadline: plan.deadline } : {}, ...plan.approved ? { approved: plan.approved } : {},
    ...plan.feedback?.length ? { feedback: plan.feedback } : {} }
}
export function ticketDetail(host: ViewHost, id: string) {
  const { store } = host
  const ticket = store.tickets.get(id)
  if (!ticket) return undefined
  const view = snapshot(host)
  const { stage } = ticketStage(ticket)
  const decision = store.decisions.get(ticket.decisionId)
  const input = (value: Ticket['inputs'][number]) => {
    const trigger = value.kind === 'trigger' ? store.triggers.get(value.triggerId) : undefined
    const handback = trigger && store.triggers.disposition(trigger.id)?.handbacks?.find(item => item.ticketId === id)
    const shown = trigger && { id: trigger.id, actor: view.actor(trigger.actor, trigger.human), human: trigger.human,
      preview: preview(trigger.text), thread: threadKey(trigger.threads[0]!),
      ...handback ? { handback: { reason: handback.reason, at: handback.at } } : {} }
    const text = (value.kind === 'text' || value.kind === 'note' || value.kind === 'session-resume') && value.text
      ? { text: markdown(value.text) } : {}
    return { ...value, ...text, delivered: !ticket.undelivered.includes(value.id), ...shown ? { trigger: shown } : {} }
  }
  // Pass `human = false` for bot-originated mandates so the Source kind still labels the actor as a bot if removed from the policy list.
  const human = ticket.mandate.basis.via !== 'bot'
  return { ...ticketLine(view, ticket), mandate: { ...ticket.mandate, actor: view.actor(ticket.mandate.actor, human) },
    basis: basisFacts(ticket.mandate.basis, view.rule), paused: store.settings().paused,
    channels: ticket.channels.map(channel => channelLink(view, channel)),
    reply: answerLink(view, ticket, stage),
    plan: planView(ticket),
    decision: decision ? decisionView(view, decision) : undefined,
    // Every started Assignment ran in the ticket's one worker Session. A running assignment whose worker reported a non-progress state has finished its turn unless a human response resumed the ticket.
    assignments: ticket.assignments.map(assignment => ({ ...assignment, ...assignment.startedAt ? { ref: workerSessionId(ticket.id) } : {},
      ...assignment.state === 'running' && assignment.report && assignment.report.state !== 'progress' && stage !== 'working'
        ? { turnEndedAt: assignment.report.at } : {} })),
    inputs: ticket.inputs.slice().reverse().map(input),
    relations: ticketRelations(host, id),
    // Threads followed for context only (e.g., related issues) grant no authority and are marked with `context: true`.
    threads: view.threadsOf(id).map(thread => ({ ...threadSummary(view, thread),
      ...thread.context?.includes(id) ? { context: true as const } : {} })) }
}
export type TicketDetailView = NonNullable<ReturnType<typeof ticketDetail>>
