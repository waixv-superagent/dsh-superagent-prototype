/**
 * The idle pool's read-only analysis (docs/025). A `P2`/`P3` ticket that waits for an idle window gets one analysis run
 * before anyone spends implementation effort on it: the worker gathers the evidence a person would need, sorts the ticket
 * against its likely duplicates, and ends with an actionable verdict instead of another narrative brief. The verdict says
 * whether the ticket belongs in the attention pool (`promote`), is one of a class another ticket already represents
 * (`merge`), or sleeps (`archive`). The analysis never changes code, never sets a priority and never opens a delivery; a
 * person or the board acts on its verdict. The text here is the worker's instruction; the state lives on `Ticket.idle`.
 */
import type { AnalysisAdvice, AnalysisVerdict, QuestionSection, Ticket, TicketIdleAnalysis } from './model.ts'

/** The verdicts an analysis may record, strongest claim first. */
export const ANALYSIS_VERDICTS = ['promote', 'merge', 'archive'] as const
/** How each verdict reads on a board or in a card: what a person should do with the ticket. */
export const ANALYSIS_VERDICT_LABELS: Readonly<Record<AnalysisVerdict, string>> = {
  promote: '值得现在投入注意力',
  merge: '并入同类，看代表票',
  archive: '先归档，不值得现在看',
}
/** The dossier's sections, in the order the worker writes them; the report's summary is otherwise free text. */
export const ANALYSIS_SECTIONS = ['现象', '证据', '复现', '同类与框架', '建议动作', '代价与风险'] as const
/** The labels of the report sections that carry an analysis's verdict, so the tool schema stays the ordinary report's. */
export const ANALYSIS_ADVICE_LABELS = { verdict: '结论', reason: '理由', mergeWith: '同类', cost: '代价' } as const
/** The most a dossier should take in the report summary: enough to decide from, short enough to read in a minute. */
export const ANALYSIS_SUMMARY_CHARS = 1_200
/** The most related tickets an analysis preamble names; more would turn the guess into a reading list. */
export const ANALYSIS_RELATED = 3

/** A related ticket the deterministic relation guess found, as the analysis preamble shows it. */
export interface AnalysisRelated {
  id: string
  title: string
  priority: string
  /** The ticket's stage, as `ticketStage` says it (`working`, `idle`, `person`, …). */
  stage: string
  /** The latest report's first line, when it has one. */
  summary?: string
  /** The guess's strength, 0–1; the preamble does not show it but orders by it. */
  score?: number
}

/** The analysis of a ticket, if it ever had one. */
export const analysisOf = (ticket: Pick<Ticket, 'idle'>): TicketIdleAnalysis | undefined => ticket.idle?.analysis
/** Whether the ticket's current assignment runs its idle analysis: no writes and no delivery belong to it. */
export const analysisRunning = (ticket: Pick<Ticket, 'idle'>): boolean => analysisOf(ticket)?.state === 'running'
/** Whether the analysis finished and the ticket waits for a person to act on its verdict. */
export const analysisReady = (ticket: Pick<Ticket, 'idle'>): boolean => analysisOf(ticket)?.state === 'ready'
/** Whether an analysis was attempted and could not finish. */
export const analysisFailed = (ticket: Pick<Ticket, 'idle'>): boolean => analysisOf(ticket)?.state === 'failed'
/** The verdict the analysis recorded, if any. */
export const analysisAdvice = (ticket: Pick<Ticket, 'idle'>): AnalysisAdvice | undefined => analysisOf(ticket)?.advice
/**
 * Whether a ticket is worth a person's attention now: the analysis said `promote` or `merge`. Everything else stays out of
 * the attention pool, which is the point of the sort. A ticket nobody analyzed keeps its priority alone as the answer.
 */
export function worthAttention(ticket: Pick<Ticket, 'idle'>): boolean {
  const advice = analysisAdvice(ticket)
  return advice ? advice.verdict === 'promote' || advice.verdict === 'merge' : false
}

/**
 * The worker's idle-analysis section, appended to a worker's system prompt only while its assignment runs an analysis.
 * It overrides the delivery and handoff instructions for that turn: the dossier and its verdict are the deliverable.
 */
export function analysisSection(): string {
  return `## idle analysis
This assignment runs a read-only idle analysis, not implementation: the ticket is in the idle pool and a person has not
spent attention on it yet. Treat the assignment brief as the subject to investigate, not as work to finish.
- Change nothing. The host refuses file edits, shell commands that change a workspace, and p4/git mutations; do not open a
  pull request or changelist, do not submit a plan (the plan and phase tools are refused too), and do not ask a person a
  question card: the verdict and the dossier are what a person reads later.
- Investigate cheaply and honestly. Read the origin message, its thread, the code a fix would touch, and the existing
  reports and repro cases; do not start an editor, a build or a long job only to fill a section, and say which evidence you
  could not verify.
- Compare with the related tickets the brief names, and with what the ticket's own thread and reports show. If three or
  more describe one root cause, say so once and name the representative; do not write a separate dossier per duplicate.
- Finish with \`orchestrator_report\` state \`ready\`. The summary is the dossier: ${ANALYSIS_SECTIONS.join(' / ')};
  keep it under about ${ANALYSIS_SUMMARY_CHARS} characters. Put the verdict in that report's \`sections\`: label
  \`结论\` = promote|merge|archive, \`理由\` = one checkable sentence, \`同类\` = the duplicate ticket ids (optional), and
  \`代价\` = what promoting it would take (optional). Report \`blocked\` only when the analysis itself cannot proceed.`
}

/**
 * The verdict a report's `sections` carry, as the idle analysis writes it: `结论` is promote/merge/archive, `理由` the one
 * sentence why, `同类` the duplicate ids and `代价` what promoting it would cost. A report whose verdict or reason is
 * missing records no advice at all, rather than a half-read one. The ordinary report tool schema is reused, so the verdict
 * costs the worker's prompt no new field.
 */
export function analysisAdviceFromSections(sections: readonly QuestionSection[] | undefined): Omit<AnalysisAdvice, 'at'> | undefined {
  const text = (label: (typeof ANALYSIS_ADVICE_LABELS)[keyof typeof ANALYSIS_ADVICE_LABELS]): string | undefined =>
    sections?.find(section => section.label.trim() === label)?.text.trim() || undefined
  const verdictText = text(ANALYSIS_ADVICE_LABELS.verdict)?.toLowerCase() ?? ''
  const verdict = verdictText.match(/\b(promote|merge|archive)\b/)?.[1] as AnalysisVerdict | undefined
  const reason = text(ANALYSIS_ADVICE_LABELS.reason)
  if (!verdict || !reason) return undefined
  // The ids a dossier names are 12-character ticket ids; anything else in 同类 is prose the worker should not have written.
  const mergeWith = [...new Set((text(ANALYSIS_ADVICE_LABELS.mergeWith) ?? '').match(/\b[0-9a-f]{12}\b/g) ?? [])]
  const cost = text(ANALYSIS_ADVICE_LABELS.cost)
  return { verdict, reason: reason.slice(0, 300), ...mergeWith.length ? { mergeWith } : {}, ...cost ? { cost: cost.slice(0, 160) } : {} }
}

/** One line a dossier's latest report contributes to a related-ticket entry. */
function firstLine(text: string | undefined): string | undefined {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line ? (line.length > 160 ? `${line.slice(0, 160)}…` : line) : undefined
}

/**
 * The first message of an idle analysis: what this assignment is, the original brief as its subject, and the tickets the
 * relation guess finds likely duplicates. The worker's system prompt carries `analysisSection`; this message keeps the
 * turn's concrete context. `assignment` is the ticket's ordinary brief, unchanged, so a later implementation reads it too.
 */
export function analysisBrief(input: { ticketId: string; title: string; level: string; assignment: string; related?: readonly AnalysisRelated[] }): string {
  const related = input.related ?? []
  return `This ticket 「${input.title}」 is in the idle pool and runs in this idle window as a read-only analysis (idle depth ${input.level}). Do not
implement it: gather what a person would need to decide whether it is worth attention, then report the dossier and its
verdict as the idle-analysis instructions say.

Assignment (the subject, not an instruction to change code):
${input.assignment.trim() || '(none recorded; infer the subject from the ticket and its origin message)'}
${related.length ? `
Likely related tickets, from the relation graph's own guess (verify them; a guess is not a decision):
${related.map(item => `- ${item.id}「${item.title}」 ${item.priority} / ${item.stage}${item.summary ? ` — ${firstLine(item.summary)}` : ''}`).join('\n')}
` : ''}`
}
