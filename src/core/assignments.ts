/** What the Executor and its workers report about the Assignments that run tickets. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { Assignment, QuestionSection, ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import { pendingPlan, validCardOptions, validQuestionSections, ticketPhase } from './plan.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
/**
 * What a worker delivered, as facts a board can show without reading prose: the shelved changelist its work is in, the
 * review opened on it, and the verification it ran with its result. Only the fields the worker reports are recorded.
 */
export interface DeliveryFacts {
  /** The shelved p4 changelist number. */
  changelist?: number
  /** The Swarm review id or URL opened for that changelist. */
  review?: string
  /** What was run and how it ended, such as `CompileProject.bat Result: Succeeded; Automation 19/19 passed`. */
  verification?: string
}
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  question?: string | null
  /** The choices a question card offers, in the order the worker wants them; 2–4 unique labels. */
  options?: string[]
  /** The context the question card adds, in the worker's own order; 1–6 sections. */
  sections?: QuestionSection[]
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  answers?: string
  /** What it delivered, which the ticket keeps on its execution so the board and a person's confirmation see it. */
  delivery?: DeliveryFacts
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, its delivery state and the ticket\'s records before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'
/**
 * The note a restarted Assignment starts from: the recovery instruction plus what its ticket already reported, so the resumed
 * worker neither redoes settled work nor submits again a plan a person may already have answered.
 */
function recoveryNote(ticket: Ticket, running: Assignment): string {
  const report = running.report
  if (!report) return RECOVERY_NOTE
  const summary = report.summary.replace(/\s+/g, ' ').trim()
  const last = `Its last report was "${report.state}": ${summary.length > 240 ? `${summary.slice(0, 240)}…` : summary}`
  const plan = pendingPlan(ticket) ? 'A P1 plan was waiting for a person when the host stopped: check whether it was answered before submitting it again.' : ''
  return plan ? `${RECOVERY_NOTE} ${last} ${plan}` : `${RECOVERY_NOTE} ${last}`
}

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
   * session and flushes any waiting undelivered inputs.
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', recoveryNote(ticket, running))
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
   * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * or a question/answer referencing a non-human or unreached trigger.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    // The P4 delivery facts belong to the deliver phase once a ticket went through the P1 gate: a plan not approved yet
    // refuses them, and so does an approved plan whose worker has not verified and entered deliver. Tickets that never had a
    // plan (the GitHub path) keep reporting as before.
    const phase = ticketPhase(ticket)
    const delivered = report.delivery?.changelist !== undefined || report.delivery?.review !== undefined
    const gated = ticket.plan !== undefined
    if ((delivered || report.state === 'ready') && (phase === 'plan' || gated && phase !== 'deliver')) throw new UserError('notDeliverable')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const options = report.options?.map(label => label.trim())
    if (options && (!report.question || !validCardOptions(options))) throw new UserError(report.question ? 'attentionOptions' : 'optionsWithoutQuestion')
    if (report.sections && (!report.question || !validQuestionSections(report.sections))) throw new UserError('attentionSections')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question,
      ...(options?.length ? { options } : {}), ...(report.sections?.length ? { sections: report.sections } : {}),
      ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const same = report.question === previous?.question && JSON.stringify(options ?? []) === JSON.stringify(previous?.options ?? [])
    const asked = report.question && !same ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    // Delivery facts live on the ticket's execution: the board, a person's confirmation and a later assignment all read them.
    if (report.delivery && ticket.execution) ticket.execution = { ...ticket.execution, ...report.delivery }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    // A ticket that follows Threads ends with them: a ready report ends it only once followsDone holds, with that outcome.
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // A dropped report after a close the ticket deferred ends it as the close did, which its final notice tells.
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    // Delivered code is not done because a worker says so: a shelved changelist or review opens the local verification gate,
    // where the ticket waits for the person who can run the build or PIE check. Analysis tickets, with no such delivery, end
    // as before. This is the fact the board shows as "待你验证", and it is why the ticket is not silently closed.
    const deliveredWork = ticket.execution?.changelist !== undefined || !!ticket.execution?.review
    // A merged pipeline is history: it ended the Ticket once, so this Assignment runs the round a person's later message
    // resumed (docs/003). That round does not repeat the merged delivery: a result that delivers nothing new ends it, and
    // one that delivers new work drops the observation so the local check and a fresh follow-up run as usual.
    const merged = ticket.pipeline?.state === 'merged'
    if (merged && delivered) { delete ticket.pipeline; this.repo.tickets.save(ticket) }
    else if (merged && outcome) { this.tickets.end(ticketId, 'executor', outcome, at); return this.require(ticketId) }
    // A pipeline follow-up may report a result after the local gate already passed: a ready report must not reopen the
    // verification gate, because there is nothing new for the person to check. The pipeline tool, not this report, ends it.
    const followup = ticket.verification?.state === 'passed' && !!ticket.pipeline
    if (outcome === 'completed' && deliveredWork && !followup) {
      ticket.verification = { at, state: 'pending' }
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
    } else if (outcome && !followup) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}

