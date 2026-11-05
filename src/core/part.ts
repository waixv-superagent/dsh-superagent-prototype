/** Shared base class and configuration for Engine domain parts. */
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Backend, Execution } from './model.ts'
import type { PipelineChoices } from './pipeline-notice.ts'
import type { Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Executor, Outbox, Policy, Repositories, SourceScope } from './ports.ts'

export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition. */
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  /**
   * Rebuilds the Execution of a ticket a person moves to another delivery environment (`Tickets.redispatch`), dropping the
   * instructions the previous environment had appended; without it the recorded execution keeps its assignment text.
   */
  reprepareTicket?: (ticket: Ticket, backend: Backend, target?: string) => Execution
  /** Local pipeline skill the worker's fix Assignment reads; empty uses the built-in instructions. */
  pipelineSkill?: string
  /** The Swarm base URL, so a pipeline observation gets a review link from a bare review id. */
  swarmUrl?: () => string
  /** Whether delivered work goes on to the host's pipeline follow-up: the p4 backend has one, a git backend has no Swarm/Jenkins stage. */
  pipelineFollowup?: (ticket: Ticket) => boolean
  /** The reviewers and package targets a pipeline card offers, from the deployment's p4 settings; none without it. */
  pipelineChoices?: () => PipelineChoices
  /** Minutes a `TAPD` ticket's priority question waits before the `P2` default applies; the deployment's `executor.idle.priorityAskMin`. */
  priorityAskMinutes?: () => number
  now?: () => string
  emit?: (event: DomainEvent) => void
}

/**
 * Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
 * Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
 */
export abstract class EnginePart {
  protected readonly repo: Repositories
  constructor(protected readonly options: EngineOptions) { this.repo = options.repo }
  protected now(): string { return this.options.now?.() ?? new Date().toISOString() }
  protected policy(): Policy { return this.options.policy() }
  /** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
  protected owners(trigger: Trigger): string[] { return followupOwners(trigger, this.repo) }
  /** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }
  /**
   * Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
   * ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
   * Eval or one on a Thread it follows for context, went to Eval without it.
   * @returns whether it was queued.
   */
  protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }
  /** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
  protected takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] })
    }
  }
  /** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
  protected queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }
  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }
  protected require(ticketId: string): Ticket { const ticket = this.repo.tickets.get(ticketId); if (!ticket) throw new UserError('unknownTicket'); return ticket }
  /** Returns the stored Thread or an unsaved empty Thread aggregate. */
  protected thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return this.repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} }
  }
  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : [] })
  }
  protected source(ticket: Ticket): Trigger | undefined { return this.repo.triggers.get(ticket.origin.triggerId) }
  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, k => this.repo.threads.get(k), context)
  }
}
