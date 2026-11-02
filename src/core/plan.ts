/** The P1 plan gate (docs/012): a ticket's phases, the worker's fixed plan template, and the person's one-word decision. */
import { liveTicket, type Ticket } from './model.ts'

/** The phases a ticket passes, from the P1 plan gate to delivery; the submit after delivery stays a person's (P5). */
export type TicketPhase = 'plan' | 'implement' | 'verify' | 'deliver'
export const TICKET_PHASES: readonly TicketPhase[] = ['plan', 'implement', 'verify', 'deliver']
/** Where a person answered a plan: the Feishu card, the panel's ticket page, or the main Session. */
export type PlanVia = 'feishu' | 'panel' | 'session'
/** A worker's P1 plan: its fixed-template text, when it submitted it, and whether it still waits for a person. */
export interface Plan {
  text: string
  at: string
  /** A person's approval, which moves the ticket to implement. */
  approved?: { at: string; via?: PlanVia }
  /** What a person asked to change instead of approving, oldest first; the worker revises and submits again. */
  feedback?: { text: string; at: string; via?: PlanVia }[]
  /** True from a submission until a person answers it; the plan waits then and the worker may not change files. */
  waiting?: true
  /** When the gate stops the ticket if nobody answers (see `PLAN_GATE_HOURS`). */
  deadline?: string
}
/** The labels of the fixed plan template, in the order a worker writes them (docs/012 §2). */
export const PLAN_LABELS = ['现象', '代码线', '资产线', '配置线', '修复锚点', '影响面', '验证方案', '预算'] as const
/** The question a submitted plan asks, worded for a card, the panel, and the main Session alike. */
export const PLAN_QUESTION = 'P1 方案待确认'
/** How a person answers in plain chat when the card's buttons are unavailable; the panel and the card need no protocol. */
export const PLAN_REPLY_HINT = '回 1 通过 ｜ 回 2 换方向（附一句）｜ 回 3 停'
/** Hours a plan gate waits before it stops the ticket: a gate that nobody answered defaults to stop, never to continue. */
export const PLAN_GATE_HOURS = 24
export type PlanDecision = 'approve' | 'revise' | 'stop'
/**
 * A ticket's phase; tickets stored before the P1 gate existed count as implementing, so an upgrade does not block work that
 * a person already authorized.
 */
export const ticketPhase = (ticket: Pick<Ticket, 'phase'>): TicketPhase => ticket.phase ?? 'implement'
/** The plan while it waits for a person's decision; undefined once approved, while the worker revises it, and after the end. */
export const pendingPlan = (ticket: Pick<Ticket, 'plan' | 'ended'>): Plan | undefined =>
  liveTicket(ticket) && ticket.plan?.waiting && !ticket.plan.approved ? ticket.plan : undefined
/** Whether a plan's gate waited past its deadline at `now`. */
export const planOverdue = (ticket: Pick<Ticket, 'plan' | 'ended'>, now: string): boolean => {
  const plan = pendingPlan(ticket)
  return !!plan?.deadline && plan.deadline <= now
}
/** How a person's reply decides a waiting plan: `1` approves, `2` asks for another direction with the words after it, `3` stops. */
export function planDecision(text: string): { decision: PlanDecision; note: string } | undefined {
  const match = /^\s*(?:回\s*)?([123])(?!\d)\s*[.、:：,，]?\s*(.*)$/s.exec(text)
  if (!match) return undefined
  return { decision: match[1] === '1' ? 'approve' : match[1] === '2' ? 'revise' : 'stop', note: (match[2] ?? '').trim() }
}
/** The plan's lines as label and content, for the card and the panel; text before the first label is dropped. */
export function planLines(text: string): { label: string; text: string }[] {
  const lines: { label: string; text: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:[-*]\\s*)?(${PLAN_LABELS.join('|')})\\s*[：:]\\s*(.*)$`).exec(line)
    if (match) lines.push({ label: match[1]!, text: match[2]! })
    else if (lines.length) lines.at(-1)!.text += `\n${line}`
  }
  return lines.map(line => ({ ...line, text: line.text.trim() })).filter(line => line.text)
}
/** The labels the plan text leaves out: the gate refuses an incomplete plan rather than guess what it would have said. */
export const missingPlanLabels = (text: string): string[] => {
  const found = new Set(planLines(text).map(line => line.label))
  return PLAN_LABELS.filter(label => !found.has(label))
}
