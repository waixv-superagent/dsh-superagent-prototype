/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
import { UserError } from './errors.ts'
import { isoTime, liveTicket } from './model.ts'
import type { Backend, ChannelRef, Decision, LinkedRelationKind, PipelineObservation, PolicyEffect, QuestionSection, ThreadRef, Ticket, TicketPipeline, TicketRepair, Trigger } from './model.ts'
import type { Candidate, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import type { PlanDecision, PlanOption, PlanTemplate, PlanVia } from './plan.ts'
import type { PriorityLevel, PriorityVia } from './priority.ts'
import type { IdleLevel } from './idle.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'
export type { PipelineObservation, PipelineState, TicketPipeline } from './model.ts'

/**
 * Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
 * Coordinates Intake, Evals, Tickets, Assignments, and Replies inside synchronous repository transactions while queuing side
 * effects through ports. Callers receive role-scoped `Pick` interfaces rather than the full engine.
 */
export class Engine {
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake
  constructor(private readonly options: EngineOptions) {
    this.repo = options.repo
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets, this.replies)
    this.intake = new Intake(options, this.tickets)
  }

  // Sources

  /**
   * A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads (to an
   * ended one only a person's message, which resumes it at once unless processing is paused, and to none a person stopped),
   * and queue it for Eval on its primary Thread unless a ticket's worker decides it (see `followupOwners`).
   * Triggers that arrive while an Eval of that Thread runs wait together for the next one.
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * Whether the Policy would admit a Trigger on its primary Thread now, as the Eval gate decides it. A Source asks before
   * acknowledging a message, so a receipt reaction never promises a reply the Policy will not make.
   */
  admissible(trigger: Trigger): boolean { return this.evals.admissible(trigger) }
  /**
   * A Source's request to make an open ticket follow one of its Threads, such as a pull request's, `own` when the ticket
   * opened it: the ticket subscribes to it, and a ready report ends it only once `followsDone` holds (see `Tickets.followsDone`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * A Source's request to move an open ticket's replies to `channel` and subscribe it to `thread`, such as a topic the
   * Source opened for the ticket; the ticket keeps the Channels it was accepted from.
   * @throws UserError when the ticket is unknown or has ended.
   */
  retarget(ticketId: string, channel: ChannelRef, thread: ThreadRef): Ticket {
    return this.repo.atomic(() => this.tickets.retarget(ticketId, channel, thread))
  }
  /**
   * A Source's fact that a Thread closed, such as its pull request's merge, at the time it happened. An open ticket that
   * follows it ends once it is done with the Threads it follows, unless work resumed since the close has not finished, or
   * its worker took up a person's message the ticket decides after its latest report.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // The clock

  /**
   * Requeues overdue Evals up to `REQUEUES` times before recording `unavailable` (undelivered Evals never expire), starts the
   * Evals of Threads whose queued Triggers wait, and resumes ended tickets a person's message reached while processing was
   * paused. While processing is paused, nothing expires: each Eval in progress notes when the pause began, and its deadline
   * moves forward by the pause's length once processing resumes. Each Eval and each ticket update takes one transaction.
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => { this.evals.due(thread, policy) })
    if (policy.paused) return
    // A P1 plan gate nobody answered stops its ticket: checked on every pass, since no message arrives for a timeout.
    this.repo.atomic(() => { this.tickets.expireGates(); this.tickets.expirePriorityAsks() })
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => { this.tickets.wake(ticket.id) })
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => { this.evals.start(thread.key, policy) })
    }
  }

  // The main Session

  /** The candidate of the Eval that holds a Trigger, as its assessor sees it; undefined while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's explicit
   * request the main Session routes. A proactive candidate is accepted only in `auto` mode with enabled rules its assessment
   * matched, and a Trigger that already started a ticket returns that ticket's Decision. An invalid stop is recorded as
   * `ignore`; one judged under an older Policy as `unavailable`.
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
   * mode or without enabled matching rules.
   */
  decide(triggerId: string, outcome: Outcome): Decision { return this.repo.atomic(() => this.evals.decide(triggerId, outcome)) }
  /**
   * Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it as an
   * Input with the routing note, and the Eval that holds the Trigger ends, since the ticket has it now; the other Triggers of
   * its batch wait for a fresh Eval. A note for an Input the worker already received goes out as a new Input, and so does a
   * message the ticket let go, read for context only, or had before it ended. An ended ticket resumes under its Mandate, at
   * once unless processing is paused.
   * @throws UserError for a ticket a person stopped, which withdrew its Mandate, or one whose Mandate the Policy no longer holds.
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // A message this ticket's worker handed back is not its work: attached here, no worker would decide it, and it could not be handed back again.
      const handedBack = this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }
  /**
   * Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
   * @returns whether the worker was asked.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where the person's message was
   * written, attention where the message that raised the question was, else, like a result, to the conversation the ticket
   * started in. A message queued before is not queued again (see `Replies.reply`).
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket that
   * is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // People, through the panel or the main Session

  /** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * Queue a stored Trigger for a fresh Eval, such as a person's replay; returns false while an Eval holds it.
   * @throws UserError when the trigger is unknown.
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * A person dismisses the problem an unavailable Decision shows: the overview lists it no more.
   * @throws UserError for a Decision that is unknown or not unavailable.
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
   * @returns whether a Subscription was dropped.
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
   * @throws UserError when the ticket is unknown.
   */
  stopTicket(ticketId: string, reason?: string): Ticket { return this.repo.atomic(() => this.tickets.stop(ticketId, reason)) }
  /**
   * A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
   * Assignment ends and a new one starts under the same Mandate.
   * @throws UserError when the ticket is unknown, has ended, or is not retryable.
   */
  retryTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId)) }
  /**
   * The host recovers a ticket whose worker stopped on a passing model or network failure: the stalled Assignment ends and a
   * new one starts, as a person's retry does, so an outage does not leave the ticket stopped until a person notices.
   * @throws UserError when the ticket is unknown, has ended, or is not retryable.
   */
  recoverTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId, 'recovered')) }
  /**
   * A person moves a ticket's work to another delivery environment: its stalled assignment ends and a new one starts with
   * `backend` recorded, so its worker continues in the channel the ticket belongs in.
   * @throws UserError when the ticket is unknown or has ended.
   */
  redispatchTicket(ticketId: string, backend: Backend, target?: string): Ticket { return this.repo.atomic(() => this.tickets.redispatch(ticketId, backend, target)) }
  /**
   * Records a person's confirmation that a delivered ticket may be submitted. It never submits: the person runs the submit.
   * @throws UserError when the ticket is unknown, ended, did not report a changelist, or was already confirmed.
   */
  confirmTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.confirm(ticketId)) }
  /**
   * Records a person's local verification of delivered work: a pending ticket ends as completed by a person, and an ended
   * completed ticket may be verified afterwards. It never submits.
   * @throws UserError when the ticket has nothing awaiting verification or was verified already.
   */
  verifyTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.verify(ticketId)) }
  /**
   * Records a follow-up observation about a delivered ticket's pipeline. A `merged` observation completes the ticket,
   * because the change is already in the mainline; a `blocked` one keeps it open for a person at the top of the pipeline lane.
   * @throws UserError when the ticket is unknown or has ended.
   */
  recordPipeline(ticketId: string, update: Omit<TicketPipeline, 'at'>): Ticket {
    return this.repo.atomic(() => this.tickets.recordPipeline(ticketId, update))
  }
  /**
   * The host's observation that a delivered change's pipeline moved: a failure to fix, a green review waiting for a person,
   * an approval, a manual blocker, or the submit. A new failure wakes the worker with the failing checks; the same failure
   * is not handed over twice; `merged` completes the ticket. The host polls Swarm and Jenkins, so no follow-up worker does.
   * @throws UserError when the ticket is unknown.
   */
  observePipeline(ticketId: string, observation: PipelineObservation): Ticket {
    return this.repo.atomic(() => this.tickets.observePipeline(ticketId, observation))
  }
  /**
   * A worker asked Swarm to rerun the current version's checks; the next failure of the same version wakes it once more.
   * @throws UserError when the ticket is unknown or has ended.
   */
  rerunPipeline(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.rerunPipeline(ticketId)) }
  /**
   * A person asks a blocked pipeline to be followed again after clearing the blocker; the host's watcher resumes polling it.
   * @throws UserError when the ticket is unknown or has ended.
   */
  resumePipeline(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.resumePipeline(ticketId)) }
  /**
   * A person closed a submitted change from its pipeline card: the autobuild after the submit needs nothing more, so the
   * ticket completes.
   * @throws UserError when the ticket is unknown or has ended.
   */
  closePipeline(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.closePipeline(ticketId)) }
  /**
   * A person's local check found a problem: records it and returns the ticket to implement with their words as the next
   * Assignment's first Input, so the worker fixes the delivered work.
   * @throws UserError when the ticket is not open and waiting for local verification.
   */
  reworkTicket(ticketId: string, note?: string): Ticket { return this.repo.atomic(() => this.tickets.rework(ticketId, note)) }
  /**
   * A worker submits its P1 plan, which then waits for a person: the fixed template with evidence for each line, or the
   * submission is refused. It may carry the proposed change as a real unified diff, which the card summarizes and the
   * panel renders. The ticket stays in its plan phase until the answer.
   * @throws UserError when the ticket is unknown or ended, its plan was approved already, a template line is missing, or
   * the attached diff is not a unified diff this panel can render.
   */
  submitPlan(ticketId: string, text: string, question?: string, options?: PlanOption[], sections?: QuestionSection[], template: PlanTemplate = 'fix',
    diff?: string, diffBase?: string): Ticket {
    return this.repo.atomic(() => this.tickets.submitPlan(ticketId, text, question, options, sections, template, diff, diffBase))
  }
  /**
   * A person's decision on a ticket's waiting plan: `1` approves it and moves the ticket to implement, `2` asks for another
   * direction, `3` stops the ticket. `option` is the card choice's label, recorded with the decision.
   * @throws UserError when the ticket is unknown or no plan of it waits for a decision.
   */
  decidePlan(ticketId: string, decision: PlanDecision, note?: string, via?: PlanVia, option?: string): Ticket {
    return this.repo.atomic(() => this.tickets.decidePlan(ticketId, decision, note, via, option))
  }
  /**
   * A person sets a ticket's priority, by a card button, a short reply, or the panel: the level becomes `human`, which no
   * assessment or default overwrites, and their answer settles the ticket's priority question. Only a person may set `P0`.
   * @throws UserError when the ticket is unknown or has ended.
   */
  decidePriority(ticketId: string, level: PriorityLevel, by: string, via: PriorityVia = 'feishu'): Ticket {
    return this.repo.atomic(() => this.tickets.decidePriority(ticketId, level, by, via))
  }
  /**
   * A person picks a ticket out of the idle pool into the attention pool: it becomes their `P1` and a worker between turns
   * starts again at once, so the pick is a scheduling action, not a label.
   * @throws UserError when the ticket is unknown or has ended.
   */
  promoteTicket(ticketId: string, level: PriorityLevel = 'P1', by: string, via: PriorityVia = 'panel'): Ticket {
    return this.repo.atomic(() => this.tickets.promote(ticketId, level, by, via))
  }
  /** The message a TAPD ticket's priority question went out as, so the panel can open that card. */
  priorityCardSent(ticketId: string, cardId: string): void { this.repo.atomic(() => { this.tickets.notePriorityCard(ticketId, cardId) }) }
  /** The idle depth at which a `P2`/`P3` ticket's work started, kept as the idle pool's trace and the daily budget's count. */
  idleLaunch(ticketId: string, level: IdleLevel): void { this.repo.atomic(() => { this.tickets.noteIdleLaunch(ticketId, level) }) }
  /**
   * A person's click on a question card: the answer becomes a message to the worker and clears the question.
   * @throws UserError when the ticket is unknown or ended, the question is gone, or the option is not offered.
   */
  answerAttention(ticketId: string, attentionId: string, option: string): Ticket {
    return this.repo.atomic(() => this.tickets.answerAttention(ticketId, attentionId, option))
  }
  /**
   * A person wrote the answer to a ticket's open question, such as in the panel: like a card's choice the answer becomes a
   * message to the worker and clears the question.
   * @throws UserError when the ticket is unknown or ended, the question is gone, or the answer is empty.
   */
  answerAttentionText(ticketId: string, attentionId: string, text: string): Ticket {
    return this.repo.atomic(() => this.tickets.answerAttentionText(ticketId, attentionId, text))
  }
  /**
   * A worker moves its ticket one phase forward: `verify` once implementation is done, `deliver` once verification passed.
   * @throws UserError when the ticket is unknown or ended, or the move skips a phase or goes back.
   */
  advancePhase(ticketId: string, phase: 'verify' | 'deliver'): Ticket { return this.repo.atomic(() => this.tickets.advancePhase(ticketId, phase)) }

  // The Executor

  /**
   * The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
   * @throws UserError when the ticket is unknown.
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. A fact about
   * an Assignment that no longer runs is dropped. Its worker reads each once its Session takes it into a step (`inputsRead`).
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * The Executor's fact that the worker's Session of an open ticket took the messages that carried Inputs into a step, from
   * which its model reads them: a report or the end of a turn after that counts them as read at the ticket's end.
   * @throws UserError when the ticket is unknown.
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended, after a report too. */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId) })
  }
  /** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed; the ticket shows it until a delivery succeeds. */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * A worker's request, through its Executor, to mark a Thread attached to its ticket unrelated, for `reason`: only that
   * ticket's Subscription drops, until a new Decision subscribes it again.
   * @throws UserError when the ticket is unknown, or for the Thread the ticket started on, one a Source bound it to (such as
   * its pull request's), or one it does not follow.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * An Executor's Subscription to a Thread it found related, for context: see `Tickets.followForContext` and `Thread.context`.
   * @returns false when the ticket already follows the Thread.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * An Executor's record of how its ticket relates to another ticket: see `Tickets.link`.
   * @returns false when the ticket recorded that relation already.
   * @throws UserError when either ticket is unknown, the ticket has ended, or it names itself.
   */
  link(ticketId: string, kind: LinkedRelationKind, otherId: string, reason: string): boolean {
    return this.repo.atomic(() => this.tickets.link(ticketId, kind, otherId, reason))
  }
  /**
   * A fact the main Session gives an open ticket's Executor: see `Tickets.note`.
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * An Executor's hand-back of a message that reached its ticket but asks for more than it: see `Evals.handback`.
   * @returns whether it was queued for Eval: false while another ticket still decides it, and for one this ticket did not decide (see `Evals.handback`).
   * @throws UserError when the ticket or trigger is unknown, the trigger did not reach the ticket, or the ticket already handed it back.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * Record a report on an open ticket's current Assignment. Its question for a person (`attention`) is asked, kept, or
   * cleared (`null` or a `ready` report), and a replaced attention question whose reply has not been sent yet is withdrawn
   * from the outbox. A `blocked` or `failed` report holds back automated inputs until a human message arrives. A `dropped`
   * report ends the ticket, and a `ready` report ends it: `completed` without followed Threads, else with the `followsDone`
   * outcome once `followsDone` holds.
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question that comes with a ready result or an
   * answer, or a question or answer that names a message that is not a person's or did not reach the ticket.
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * A person wrote in a ticket's worker Session: an ended ticket resumes, one whose worker's turn is over starts its next
   * Assignment, and one still working takes the message. DSH delivers the message into the Session itself, so no Source saw
   * it and there is no Trigger; the person's act is the authorization, under the ticket's unchanged Mandate, and no Decision
   * is recorded for it. A ticket a person stopped stays ended.
   * @returns whether the ticket took it: false when it is unknown, a person stopped it, processing is paused, or the Policy
   * no longer holds its Mandate (which refuses it, as `Tickets.wake` does).
   */
  wroteInSession(ticketId: string, text: string): boolean { return this.repo.atomic(() => this.tickets.wroteInSession(ticketId, text)) }
  /**
   * Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no Input reached its worker after that report, in which case it keeps its
   * Session and state and gets the Inputs that wait for it.
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
  }
  /**
   * The Executor's fact that a Ticket's state was provably inconsistent and the host repaired it: the repair is kept on the
   * ticket as the system's trace (I4), so the board can show what was handled without a person inspecting it.
   */
  repaired(ticketId: string, repair: Omit<TicketRepair, 'at'>): Ticket { return this.repo.atomic(() => this.tickets.recordRepair(ticketId, repair)) }
  /**
   * The Executor found a running Assignment with no live worker Session: restart it with a recovery note, or after repeated
   * repairs report the Ticket blocked for a person instead of looping.
   */
  repairAssignment(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.repairAssignment(ticketId, assignmentId) })
  }

  // Settings

  /**
   * The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress start again
   * under the new version.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** What Sources ask and tell the Engine. */
export type EngineForSources = Pick<Engine, 'receive' | 'admissible' | 'bindThread' | 'retarget' | 'threadClosed' | 'decidePlan' | 'answerAttention' | 'decidePriority'
  | 'rerunPipeline' | 'closePipeline'>
/** What the main Session asks of the Engine. */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'>
/** What people ask of the Engine, through the panel or the main Session. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'redispatchTicket' | 'confirmTicket' | 'verifyTicket' | 'recordPipeline' | 'resumePipeline'
  | 'reworkTicket' | 'decidePlan' | 'decidePriority' | 'promoteTicket' | 'answerAttention' | 'answerAttentionText' | 'reevaluate' | 'unsubscribe' | 'dismiss'>
/** What Settings tells the Engine. */
export type EngineForSettings = Pick<Engine, 'policyChanged'>
/** What the Executor tells the Engine, and what its workers ask of it. */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'repaired' | 'repairAssignment' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'link' | 'reply'
  | 'submitPlan' | 'advancePhase' | 'redispatchTicket' | 'recordPipeline' | 'rerunPipeline' | 'idleLaunch'>
/** What the host's pipeline watcher tells the Engine. */
export type EngineForPipeline = Pick<Engine, 'observePipeline'>
/** What the host's watchdog tells the Engine: it recovers a ticket its worker stopped on a passing failure. */
export type EngineForWatchdog = Pick<Engine, 'recoverTicket'>
