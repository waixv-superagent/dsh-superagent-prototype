/** The P1 plan gate (docs/012): a ticket's phases, the worker's fixed plan template, and the person's one-word decision. */
import type { PlanDiff } from './diff.ts'
import { liveTicket, type QuestionSection, type Ticket } from './model.ts'

/** The phases a ticket passes, from the P1 plan gate to delivery; the submit after delivery stays a person's (P5). */
export type TicketPhase = 'plan' | 'implement' | 'verify' | 'deliver'
/** The kind of work a plan describes: a fix keeps the code/asset/config template, an analysis or a design choice uses a light one. */
export type PlanTemplate = 'fix' | 'analysis' | 'design'
export const TICKET_PHASES: readonly TicketPhase[] = ['plan', 'implement', 'verify', 'deliver']
/** Where a person answered a plan: the Feishu card, the panel's ticket page, or the main Session. */
export type PlanVia = 'feishu' | 'panel' | 'session'
/** A worker's P1 plan: its fixed-template text, when it submitted it, and whether it still waits for a person. */
export interface Plan {
  text: string
  at: string
  /** The template the text follows; absent means `fix`, so plans stored before templates stay readable. */
  template?: PlanTemplate
  /** A person's approval, which moves the ticket to implement. */
  approved?: { at: string; via?: PlanVia; option?: string }
  /** What a person asked to change instead of approving, oldest first; the worker revises and submits again. */
  feedback?: { text: string; at: string; via?: PlanVia; option?: string }[]
  /** True from a submission until a person answers it; the plan waits then and the worker may not change files. */
  waiting?: true
  /** When the gate stops the ticket if nobody answers (see `PLAN_GATE_HOURS`). */
  deadline?: string
  /** The worker's own question for the card, from the conversation; the card's standard wording when absent. */
  question?: string
  /** The choices the worker puts on the card; the standard three when absent, and at most four. */
  options?: PlanOption[]
  /**
   * The context the worker puts on the card, in its own order, when the fixed template does not fit the conversation;
   * absent keeps the standard 8-line layout, which stays the style reference for bug-fix and requirement plan cards.
   */
  sections?: QuestionSection[]
  /**
   * The code change the plan proposes, as the worker's real unified diff (`git diff -U3` / `p4 diff -du`, or the same
   * against an unapplied proposal made with read-only pipes). The card summarizes it and the panel renders the hunks
   * inline or side by side, so a person reviews code before approving instead of reading a description of it.
   */
  diff?: PlanDiff
}
/** The labels of the fix plan template, in the order a worker writes them (docs/012 §2). */
export const PLAN_LABELS = ['现象', '代码线', '资产线', '配置线', '修复锚点', '影响面', '验证方案', '预算'] as const
/** The light template for an investigation or analysis: what was asked, what was found, the evidence, what to do next. */
export const ANALYSIS_PLAN_LABELS = ['问题', '结论', '依据', '建议'] as const
/** The template for a design choice: the open question, the options with consequences, the evidence, and a recommendation. */
export const DESIGN_PLAN_LABELS = ['问题', '选项', '证据', '推荐'] as const
/** Every plan template's labels; a worker picks one when the default fix template does not fit the conversation. */
export const PLAN_TEMPLATES: Readonly<Record<PlanTemplate, readonly string[]>> = {
  fix: PLAN_LABELS, analysis: ANALYSIS_PLAN_LABELS, design: DESIGN_PLAN_LABELS,
}
/** The template a stored plan follows; plans written before templates existed are fixes. */
export const planTemplate = (plan: Pick<Plan, 'template'> | undefined): PlanTemplate => plan?.template ?? 'fix'
/** The question a submitted plan asks, worded for a card, the panel, and the main Session alike. */
export const PLAN_QUESTION = 'P1 方案待确认'
/** How a person answers in plain chat when the card's buttons are unavailable; the panel and the card need no protocol. */
export const PLAN_REPLY_HINT = '回 1 通过 ｜ 回 2 换方向（附一句）｜ 回 3 停'
/** Hours a plan gate waits before it stops the ticket: a gate that nobody answered defaults to stop, never to continue. */
export const PLAN_GATE_HOURS = 24
export type PlanDecision = 'approve' | 'revise' | 'stop'
/**
 * A choice a plan card offers: the label a person sees, the decision it records, and, for `revise`, the new direction that
 * records without the form. The decision set is the gate's own, so a worker words the buttons without changing what they do.
 */
export interface PlanOption {
  label: string
  decision: PlanDecision
  /** A revise option's new direction; absent means the option opens the form so the person writes one. */
  note?: string
  /** What choosing this option means and costs, shown under the choice so a label alone never hides the consequence. */
  description?: string
}
/** The card's question when the worker does not write one; the gate's own question stays `PLAN_QUESTION` for plain replies. */
export const PLAN_CARD_QUESTION = '这版方案能不能开工'
/** How many choices a card shows, and how long each label may be before the row no longer reads as buttons. */
export const PLAN_OPTION_LIMITS = { min: 2, max: 4, label: 24, description: 160 } as const
/** The same bounds for a question card's choice labels. */
export const CARD_OPTION_LIMITS = PLAN_OPTION_LIMITS
/** Whether labels are 2–4, unique, non-empty and short enough for a button row. */
export const validCardOptions = (options: readonly string[]): boolean =>
  options.length >= CARD_OPTION_LIMITS.min && options.length <= CARD_OPTION_LIMITS.max
  && new Set(options).size === options.length
  && options.every(label => label.trim().length > 0 && Array.from(label).length <= CARD_OPTION_LIMITS.label)
/** Whether plan choices are valid labels and, when asked, each carries the consequence it would have. */
export const validPlanOptions = (options: readonly PlanOption[], requireDescription = false): boolean =>
  validCardOptions(options.map(option => option.label.trim()))
  && options.every(option => !requireDescription || (option.description?.trim().length ?? 0) > 0)
  && options.every(option => Array.from(option.description?.trim() ?? '').length <= PLAN_OPTION_LIMITS.description)
/** How many context blocks a question card shows, and how long each label and its text may be. */
export const QUESTION_SECTION_LIMITS = { min: 1, max: 6, label: 20, text: 800 } as const
/** Whether context sections are 1–6, each a short unique label and its own non-empty text. */
export const validQuestionSections = (sections: readonly QuestionSection[]): boolean =>
  sections.length >= QUESTION_SECTION_LIMITS.min && sections.length <= QUESTION_SECTION_LIMITS.max
  && new Set(sections.map(section => section.label.trim())).size === sections.length
  && sections.every(section => section.label.trim().length > 0 && Array.from(section.label).length <= QUESTION_SECTION_LIMITS.label
    && section.text.trim().length > 0 && Array.from(section.text).length <= QUESTION_SECTION_LIMITS.text)
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
export function planDecision(text: string): { decision: PlanDecision; note: string; option?: string } | undefined {
  const match = /^\s*(?:回\s*)?([123])(?!\d)\s*[.、:：,，]?\s*(.*)$/s.exec(text)
  if (!match) return undefined
  const rest = (match[2] ?? '').trim()
  if (match[1] === '2') return { decision: 'revise', note: rest }
  // Only a bare number, or the number with its own label, approves or stops: ordinary prose that happens to start with a
  // digit ("3 个地方要改", "1 点前别动") must reach the worker as a message, not end or approve the gate.
  const label = match[1] === '1' ? /^(?:通过|可以|开工|ok|approve|go)$/i : /^(?:停|停止|stop)$/i
  if (rest && !label.test(rest)) return undefined
  return { decision: match[1] === '1' ? 'approve' : 'stop', note: '' }
}
/** How an exact choice label from the card decides the plan; a revise label's own note is the direction it records. */
export function planChoice(text: string, plan: Pick<Plan, 'options'> | undefined): { decision: PlanDecision; note: string; option: string } | undefined {
  const answer = text.trim()
  const choice = plan?.options?.find(option => option.label === answer)
  return choice ? { decision: choice.decision, note: choice.note ?? '', option: choice.label } : undefined
}
/** The plan's lines as label and content, for the card and the panel; text before the first label is dropped. */
export function planLines(text: string, template: PlanTemplate = 'fix'): { label: string; text: string }[] {
  const labels = PLAN_TEMPLATES[template]
  const lines: { label: string; text: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:[-*]\\s*)?(${labels.join('|')})\\s*[：:]\\s*(.*)$`).exec(line)
    if (match) lines.push({ label: match[1]!, text: match[2]! })
    else if (lines.length) lines.at(-1)!.text += `\n${line}`
  }
  return lines.map(line => ({ ...line, text: line.text.trim() })).filter(line => line.text)
}
/** The labels the plan text leaves out: the gate refuses an incomplete plan rather than guess what it would have said. */
export const missingPlanLabels = (text: string, template: PlanTemplate = 'fix'): string[] => {
  const found = new Set(planLines(text, template).map(line => line.label))
  return PLAN_TEMPLATES[template].filter(label => !found.has(label))
}
