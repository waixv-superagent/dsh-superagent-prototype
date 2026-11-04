/**
 * What kind of work a ticket is — a feature, a bug, the agent's own iteration, or an inquiry — decided when it is
 * accepted, so a day's work can be counted and filtered by kind (docs/020). It is a label for reading the work, never
 * an authority: it grants nothing and changes no gate.
 */
import type { Ticket } from './model.ts'

/** `feature` something new is wanted; `bug` existing behavior is wrong; `self` the agent's own iteration; `inquiry` an answer, analysis or review. */
export const TICKET_KINDS = ['feature', 'bug', 'self', 'inquiry'] as const
export type TicketKind = typeof TICKET_KINDS[number]
/** Who decided a kind: the router that accepted the ticket, the Source or delivery target it came from, or the title rule. */
export type TicketKindSource = 'router' | 'source' | 'rule'
export interface TicketKindOf { kind: TicketKind; source: TicketKindSource }

/** Title words that mark existing behavior as wrong; checked before the inquiry words, so "排查并修复" stays a bug. */
const BUG = /修复|修一下|\bfix(?:es|ed)?\b|\bbug\b|报错|崩溃|闪退|卡住|卡死|不生效|没生效|失效|异常|错误|不一致|回归|\bcrash/i
/** Title words that ask for an answer rather than a change. */
const INQUIRY = /分析|评估|审查|审核|判断|排查|调研|研究|确认|定位|核对|复盘|诊断|为什么|为何|是否|对比|\breview\b|\binvestigate|\banaly[sz]e|\bassess/i

export interface KindInput {
  /** The kind the router named on its accept. */
  routed?: TicketKind
  /** The escalation's own category, the only label a ticket carried before kinds. */
  category?: 'bug' | 'feature'
  /** The Source the ticket was accepted from, such as `tapd`. */
  source?: string
  /** The ticket's delivery backend: `git` is this deployment's own repository, which is the agent's source (docs/020). */
  backend?: string
  title: string
}

/**
 * Classifies a ticket, first rule wins: the router's kind; a TAPD bug; an escalation's category; work in this deployment's
 * git repository, which is the agent itself; the title's bug words, then its inquiry words; and `feature` otherwise, so
 * every ticket has a kind.
 */
export function classifyTicket(input: KindInput): TicketKindOf {
  if (input.routed) return { kind: input.routed, source: 'router' }
  if (input.source === 'tapd') return { kind: 'bug', source: 'source' }
  if (input.category) return { kind: input.category, source: 'source' }
  if (input.backend === 'git') return { kind: 'self', source: 'source' }
  if (BUG.test(input.title)) return { kind: 'bug', source: 'rule' }
  if (INQUIRY.test(input.title)) return { kind: 'inquiry', source: 'rule' }
  return { kind: 'feature', source: 'rule' }
}

/**
 * A ticket's kind: the one recorded at acceptance, or, for a ticket stored before kinds existed, the same rules applied
 * to what it recorded, so old tickets count and filter like new ones without a migration.
 */
export function ticketKind(ticket: Pick<Ticket, 'kind' | 'kindSource' | 'category' | 'mandate' | 'execution' | 'title'>): TicketKindOf {
  if (ticket.kind) return { kind: ticket.kind, source: ticket.kindSource ?? 'rule' }
  return classifyTicket({ ...ticket.category ? { category: ticket.category } : {}, source: ticket.mandate.actor.source,
    ...ticket.execution?.backend ? { backend: ticket.execution.backend } : {}, title: ticket.title })
}
