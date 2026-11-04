/** Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { liveTicket, threadKey } from './model.ts'
import type { Decision, DecisionKind, Escalation, Evaluation, Mandate, MandateBasis, Strength, Thread, Trigger } from './model.ts'
import type { AssessmentOutcome, Candidate, Policy } from './ports.ts'
import { said, type Reason } from './reasons.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import type { Tickets } from './tickets.ts'

/** An outcome for the Eval that holds a Trigger; `evalId` names the Eval it was judged for, so a later Eval refuses it. */
export type Outcome = AssessmentOutcome & { evalId?: string }
/** What an Eval ends with, as its Decision records it. */
interface Finished { kind: DecisionKind; reason: Reason[]; audit?: Record<string, unknown>; ticketId?: string; ticketIds?: string[]; mandate?: Mandate; escalation?: Escalation }
/** 一次会建单的决策的收尾：accept，或携带了 escalation 的 chat（两者只差 kind 与 escalation）。 */
type Started = Omit<Finished, 'kind'> & { kind: 'accept' | 'chat' }
/** An outcome's reason: a code it carries, else the words its assessor or person wrote. */
const reasonOf = (reason: string | Reason): Reason[] => [typeof reason === 'string' ? said(reason) : reason]
const stronger = (a: Strength, b: Strength): Strength => a === 'explicit' || b === 'explicit' ? 'explicit' : 'inferred'
/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2

/**
 * Evals runs the Evals of Threads: it batches a Thread's queued Triggers into one Eval, takes its strength, actor, and basis
 * from the gate, asks the assessor, keeps its deadline through a pause, and records the Decision it ends with: accept, chat,
 * stop, ignore, or unavailable. It depends on Tickets to create the ticket an accept or an escalated chat decides and to end
 * the one a stop names, and on Replies to answer a chat; the Engine routes the main Session's decisions, people's replays,
 * worker handbacks, and the pass's Eval work here.
 */
export class Evals extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /**
   * Whether the Policy would admit this Trigger on its primary Thread now, as the Eval gate decides it. A Source asks
   * before acknowledging a message, so a receipt reaction never promises a reply the Policy will not make.
   */
  admissible(trigger: Trigger): boolean {
    const thread = this.thread(trigger.threads[0]!)
    return this.policy().gate(trigger, thread, this.ticketsOnThread(thread)).admissible
  }

  /**
   * Expire a Thread's Eval past its deadline (see `expire`), unless processing is paused: then the Eval notes when the
   * processing pause began, and once processing resumes its deadline moves forward by the pause's length. An Eval whose
   * candidate has not reached the assessor's Session does not expire.
   */
  due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating
    if (!evaluation || (policy.paused && evaluation.pausedAt)) return
    const now = this.now()
    if (policy.paused) evaluation.pausedAt = now
    else if (evaluation.pausedAt) {
      evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString()
      delete evaluation.pausedAt
    } else if (evaluation.delivered && evaluation.deadline <= now) { this.expire(thread); return }
    else return
    this.repo.threads.save(thread)
  }
  /** An Eval's candidate reached the assessor's Session: its deadline counts from now. */
  delivered(evalId: string, policy: Policy): void {
    const thread = this.repo.threads.active().find(item => item.evaluating?.id === evalId)
    if (!thread?.evaluating || thread.evaluating.delivered) return
    const now = this.now()
    thread.evaluating.delivered = now
    thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString()
    this.repo.threads.save(thread)
  }
  /**
   * An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
   * assessor does not drop requests; after that it is recorded unavailable.
   */
  private expire(thread: Thread): void {
    const expired = (thread.expired ?? 0) + 1
    if (expired > REQUEUES) { this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [{ code: 'timeout' }] }); return }
    const { id, triggerIds } = thread.evaluating!
    delete thread.evaluating
    thread.expired = expired
    thread.pending = [...triggerIds, ...thread.pending.filter(item => !triggerIds.includes(item))]
    this.repo.threads.save(thread)
    this.options.assessor.release?.(id)
  }
  /** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
  start(threadKeyValue: string, policy: Policy): void {
    const thread = this.repo.threads.get(threadKeyValue)!
    const at = this.now()
    // A person's follow-up a ticket still decides is that ticket's: one an older version queued leaves the queue without a Decision.
    const delivered = (id: string) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger && this.owners(trigger).length > 0
    }
    if (thread.pending.some(delivered)) {
      const followups = thread.pending.filter(delivered)
      thread.pending = thread.pending.filter(id => !followups.includes(id))
      this.repo.threads.save(thread)
      for (const triggerId of followups) this.emit('trigger.followup', { triggerId })
      if (!thread.pending.length) return
    }
    // Triggers that already originated a ticket cannot lend authority to a new evaluation or spawn a duplicate ticket.
    const accepted = this.started(thread.key)
    const started = thread.pending.filter(id => accepted.has(id))
    const startedTicket = (id: string): Reason => ({ code: 'startedTicket', triggerId: id, values: { ticket: accepted.get(id)!.ticketId! } })
    if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at)
    const triggers = thread.pending.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const tickets = this.ticketsOnThread(thread)
    const reasons: Reason[] = []
    let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets)
      if (!gate.admissible) { reasons.push({ code: gate.reason, triggerId: trigger.id }); continue }
      const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at
      const weaker = !strongest || stronger(strongest.strength, gate.strength) !== strongest.strength
      if (weaker || later) strongest = { trigger, strength: gate.strength, basis: gate.basis }
    }
    if (!strongest) {
      if (thread.pending.length) this.ignore(thread, [...thread.pending], reasons.length ? reasons : [{ code: 'noAdmissible' }], policy, at)
      this.repo.threads.save(thread)
      return
    }
    const evalId = key('eval', thread.key, policy.version, at, ...thread.pending)
    const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString()
    const { strength, trigger: { actor }, basis } = strongest
    thread.evaluating = { id: evalId, threadKey: thread.key, triggerIds: thread.pending, primary: strongest.trigger.id, strength, actor, basis,
      policyVersion: policy.version, startedAt: at, deadline }
    thread.pending = []
    this.repo.threads.save(thread)
    for (const trigger of triggers) {
      this.repo.triggers.saveDisposition(trigger.id, { ...(this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at }), evalId })
    }
    this.emit('eval.started', { evalId, threadKey: thread.key, triggerIds: thread.evaluating.triggerIds, strength: strongest.strength })
    this.options.assessor.request(this.candidateOf(thread))
  }
  /** The candidate of the Eval that holds `triggerId`, or undefined while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined {
    const thread = this.holding(triggerId)
    return thread && this.candidateOf(thread)
  }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or a candidate is built into a ticket (an accept,
   * or a chat carrying an escalation) outside `auto` mode or without enabled matching rules.
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const held = this.holding(triggerId)
    if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError('evalFinished', { eval: outcome.evalId })
    // Prevent a replayed trigger that already created a ticket from spawning a second one, an escalated chat's ticket included.
    const earlier = outcome.kind === 'accept' || outcome.kind === 'chat' ? this.started(threadKey(trigger.threads[0]!)).get(triggerId) : undefined
    if (earlier) {
      // Only an Eval started by an earlier version can still hold it; reassess the remaining triggers without it, or ignore it if alone.
      const others = held?.evaluating?.triggerIds.filter(id => id !== triggerId) ?? []
      if (held && others.length) this.reassess(held, { code: 'acceptedBefore', values: { trigger: triggerId } }, [triggerId])
      else if (held) {
        this.finish(held, held.evaluating!, { kind: 'ignore', reason: [{ code: 'startedTicket', triggerId, values: { ticket: earlier.ticketId! } }] })
      }
      return earlier
    }
    // A follow-up that reached a ticket is its worker's to judge: the main Session may only stop the work on it.
    if (outcome.kind !== 'stop') this.leftToWorkers(trigger)
    const thread = held ?? this.thread(trigger.threads[0]!)
    const evaluation = held?.evaluating ?? this.directEval(thread, trigger, outcome.kind, outcome.kind === 'stop' ? outcome.ticketId : undefined)
    // 建单要授权：accept 与带 escalation 的 chat 一样，inferred 候选只在命中的启用规则和 auto 模式下建单。
    const rules = outcome.kind === 'accept' || outcome.kind === 'chat' ? outcome.rules ?? [] : []
    const startsTicket = outcome.kind === 'accept' || (outcome.kind === 'chat' && !!outcome.escalation)
    if (startsTicket && evaluation.strength !== 'explicit' && !this.policy().admitsInferred(rules)) {
      throw new UserError('notExplicit')
    }
    return this.decideEval(thread, evaluation, outcome)
  }
  /**
   * Queue a stored Trigger for a fresh Eval on its primary Thread and emit `trigger.requeued`; returns false while an Eval holds it.
   * @throws UserError when the Trigger is unknown.
   */
  reevaluate(triggerId: string): boolean {
    if (!this.requeue(triggerId)) return false
    this.emit('trigger.requeued', { triggerId })
    return true
  }
  /** Queue a Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
  private requeue(triggerId: string): boolean {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (this.holding(triggerId)) return false
    this.queueForEval(trigger)
    const disposition = this.repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.now() }
    this.repo.triggers.saveDisposition(triggerId, { ...disposition, requeued: true })
    return true
  }
  /**
   * Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a fresh Eval
   * when the ticket decided it and no other ticket still does (see `handBack`): the gate judges it as any message on its
   * Thread, and its candidate carries the reasons, so no requeue notice comes before it. The ticket keeps its Subscription,
   * and hands a Trigger back once.
   * @returns whether it was queued: false while another ticket decides it, and for one the ticket did not decide.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.require(ticketId)
    if (!ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId)) throw new UserError('notReached')
    if (this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)) throw new UserError('handedBack')
    return this.handBack(ticketId, this.repo.triggers.get(triggerId)!, reason)
  }
  /**
   * Marks an `unavailable` Decision dismissed so the overview lists it no more.
   * @throws UserError when the Decision is unknown or not `unavailable`.
   */
  dismiss(decisionId: string): Decision {
    const decision = this.repo.decisions.get(decisionId)
    if (decision?.kind !== 'unavailable') throw new UserError('unknownProblem')
    decision.dismissed = true
    this.repo.decisions.save(decision)
    return decision
  }
  /** Take a Trigger out of its Thread's queue because it was routed by hand. */
  withdraw(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))
    if (!thread?.pending.includes(trigger.id)) return
    thread.pending = thread.pending.filter(id => id !== trigger.id)
    this.repo.threads.save(thread)
  }
  /**
   * End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers too
   * queues them again for a fresh Eval without it.
   */
  routed(triggerId: string, ticketId: string): void {
    const held = this.holding(triggerId)
    const reason: Reason = { code: 'routed', values: { ticket: ticketId } }
    if (held?.evaluating?.triggerIds.length === 1) this.finish(held, held.evaluating, { kind: 'ignore', reason: [reason] })
    else if (held) this.reassess(held, { ...reason, triggerId }, [triggerId])
  }
  /** Start the Evals in progress again under the new Policy version, and say that it changed. */
  policyChanged(from: string, to: string): void {
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.reassess(thread, { code: 'policyChanged' })
    this.emit('policy.changed', { from, to })
  }
  /** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
  private reassess(thread: Thread, reason: Reason, without: string[] = []): Decision {
    const ids = thread.evaluating!.triggerIds.filter(id => !without.includes(id))
    const decision = this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [reason] })
    const current = this.repo.threads.get(thread.key)!
    current.pending = [...ids, ...current.pending.filter(id => !ids.includes(id))]
    this.repo.threads.save(current)
    return decision
  }
  /** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
  private holding(triggerId: string): Thread | undefined {
    const trigger = this.repo.triggers.get(triggerId)
    const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]!))
    return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : undefined
  }
  private candidateOf(thread: Thread): Candidate {
    const evaluation = thread.evaluating!
    const triggers = evaluation.triggerIds.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const { id: evalId, strength, policyVersion } = evaluation
    return { evalId, thread, triggers, strength, policyVersion, tickets: this.ticketsOnThread(thread) }
  }
  /**
   * Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue. Its id
   * differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
   */
  private ignore(thread: Thread, ids: string[], reason: Reason[], policy: Policy, at: string): void {
    const evaluation = { id: key('eval', thread.key, 'ignored', policy.version, at, ...ids), threadKey: thread.key, triggerIds: ids, strength: 'inferred' as const,
      actor: { source: thread.ref.source, id: '' }, basis: { via: 'followup' as const }, policyVersion: policy.version, startedAt: at, deadline: at }
    this.record(thread, evaluation, { kind: 'ignore', reason })
    thread.pending = thread.pending.filter(id => !ids.includes(id))
    delete thread.expired
  }
  /**
   * The Decisions of the Triggers whose primary Thread is `threadKey` that created a ticket, by Trigger: what each one
   * started. An accept always does, and a chat only when it carried an escalation. An Eval and its Decision run on its
   * Triggers' primary Thread, so the Thread's Decisions, read by their index, hold them all.
   */
  private started(threadKey: string): Map<string, Decision> {
    const started = new Map<string, Decision>()
    for (const decision of this.repo.decisions.byThread(threadKey)) {
      if (!decision.ticketId || (decision.kind !== 'accept' && decision.kind !== 'chat')) continue
      for (const id of decision.triggerIds) if (!started.has(id)) started.set(id, decision)
    }
    return started
  }
  /**
   * A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as on a follow-up that reached a
   * ticket. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the queue.
   * Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
   */
  private directEval(thread: Thread, trigger: Trigger, kind: AssessmentOutcome['kind'], ticketId?: string): Evaluation {
    const policy = this.policy()
    const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const at = this.now()
    if (thread.pending.includes(trigger.id)) { thread.pending = thread.pending.filter(id => id !== trigger.id); this.repo.threads.save(thread) }
    const id = key('eval', thread.key, 'direct', trigger.id, kind, ...ticketId ? [ticketId] : [], at)
    return { id, threadKey: thread.key, triggerIds: [trigger.id], primary: trigger.id,
      strength: gate.strength, actor: trigger.actor, basis: gate.basis, policyVersion: policy.version, startedAt: at, deadline: at }
  }
  /** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
  private decideEval(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    // Requeue if Policy changed without a live policyChanged call (such as across an upgrade or restart).
    if (this.policy().version !== evaluation.policyVersion) {
      if (thread.evaluating?.id === evaluation.id) return this.reassess(thread, { code: 'policyChanged' })
      return this.finish(thread, evaluation, { kind: 'unavailable', reason: [{ code: 'policyChanged' }], ...audit })
    }
    // An inferred candidate ignored without an assessment, from its card, says so beside the reason given.
    const unassessed = outcome.kind === 'ignore' && evaluation.strength !== 'explicit' && !outcome.audit ? [{ code: 'ignoredFromCard' }] : []
    if (outcome.kind === 'ignore' || outcome.kind === 'unavailable') return this.finish(thread, evaluation, { kind: outcome.kind,
      reason: [...unassessed, ...reasonOf(outcome.reason)], ...audit })
    if (outcome.kind === 'chat') return this.chat(thread, evaluation, outcome)
    if (outcome.kind === 'stop') {
      const ticket = this.repo.tickets.get(outcome.ticketId)
      if (!ticket || !liveTicket(ticket)) return this.finish(thread, evaluation, { kind: 'ignore', reason: [{ code: 'stopUnknown' }],
        ...audit })
      if (evaluation.strength !== 'explicit') return this.finish(thread, evaluation, { kind: 'ignore',
        reason: [{ code: 'stopNotExplicit' }], ...audit })
      const decision = this.finish(thread, evaluation, { kind: 'stop', reason: reasonOf(outcome.reason), ticketId: ticket.id, ...audit })
      this.tickets.end(ticket.id, 'human', 'stopped', this.now(), typeof outcome.reason === 'string' ? outcome.reason : undefined)
      return decision
    }
    return this.accept(thread, evaluation, outcome)
  }
  /** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
  private accept(thread: Thread, evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    return this.startTicket(thread, evaluation, outcome, { kind: 'accept', reason: reasonOf(outcome.reason), ...audit })
  }
  /**
   * 记一条 chat 决策：线程保留、不建工单，但必须给出回复。带 escalation 时，同一轮里再走 accept 的建单路径建一张单，
   * 决策仍是 chat 并记下 escalate 的内容。
   * 回复排在建单之后，但同在一个事务里：建单失败时两者一起回滚，不会出现"建了单却没答复"。
   */
  private chat(thread: Thread, evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'chat' }>): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    const decision = outcome.escalation
      ? this.escalate(thread, evaluation, outcome, outcome.escalation, audit)
      : this.finish(thread, evaluation, { kind: 'chat', reason: reasonOf(outcome.reason), ...audit })
    // 回复发给这条触发的人：Eval 的 primary 是给这批触发授权的那条，旧记录回退到最后一条。
    const trigger = this.repo.triggers.get(evaluation.primary ?? evaluation.triggerIds.at(-1)!)
    if (trigger) this.replies.converse(trigger, outcome.reply)
    return decision
  }
  /** 带 escalation 的 chat：把 escalation 转成一份 accept 的工作描述，交给与 accept 相同的建单路径。 */
  private escalate(thread: Thread, evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'chat' }>,
    escalation: Escalation, audit: Record<string, unknown>): Decision {
    const work: Extract<AssessmentOutcome, { kind: 'accept' }> = { kind: 'accept', title: escalation.title, scope: escalation.scope,
      category: escalation.category, reason: escalation.reason, ...(outcome.name ? { name: outcome.name } : {}),
      ...(escalation.target ? { target: escalation.target } : {}), ...(outcome.rules ? { rules: outcome.rules } : {}) }
    return this.startTicket(thread, evaluation, work, { kind: 'chat', reason: reasonOf(outcome.reason), ...audit, escalation })
  }
  /**
   * accept 与带 escalation 的 chat 共用的建单路径：按 Eval 的授权记 Mandate，先把决策记下，再让 Tickets 建工单。
   * @param started 决策的内容，只有 kind 与是否带 escalation 不同。
   */
  private startTicket(thread: Thread, evaluation: Evaluation, work: Extract<AssessmentOutcome, { kind: 'accept' }>,
    started: Started): Decision {
    const at = this.now()
    const { strength, policyVersion, actor } = evaluation
    const basis = { ...evaluation.basis, ...(work.rules ? { rules: work.rules } : {}) }
    const mandate: Mandate = { strength, policyVersion, basis, actor, scope: work.scope }
    const parts = work.parts ?? []
    // One Decision opens the primary ticket and one ticket per further goal, so a message with several separable goals
    // becomes sub-tickets instead of making one worker hand the extra goals back. Only the primary carries the receipt.
    const ticketIds = [key('ticket', evaluation.id), ...parts.map((_, index) => key('ticket', evaluation.id, 'part', String(index)))]
    const decision = this.finish(thread, evaluation, { ...started, mandate, ticketId: ticketIds[0]!, ticketIds })
    const primary = { ...work }
    delete primary.parts
    this.tickets.create(ticketIds[0]!, decision.id, mandate, evaluation, primary, at)
    for (const [index, part] of parts.entries()) {
      this.tickets.create(ticketIds[index + 1]!, decision.id, mandate, evaluation, { ...work, ...part, acknowledgement: undefined, parts: undefined }, at)
    }
    return decision
  }
  /** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
  private finish(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const decision = this.record(thread, evaluation, outcome)
    // Direct (gate-only) evaluations do not clear the thread's active evaluation.
    if (thread.evaluating?.id !== evaluation.id) return decision
    delete thread.evaluating; delete thread.expired
    this.repo.threads.save(thread)
    this.options.assessor.release?.(evaluation.id)
    return decision
  }
  private record(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const at = this.now()
    const decision: Decision = { id: key('decision', evaluation.id), evalId: evaluation.id, threadKey: thread.key, triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion, at, kind: outcome.kind, reason: outcome.reason, strength: evaluation.strength,
      ...(outcome.ticketId ? { ticketId: outcome.ticketId } : {}), ...(outcome.ticketIds?.length ? { ticketIds: outcome.ticketIds } : {}),
      ...(outcome.mandate ? { mandate: outcome.mandate } : {}),
      ...(outcome.escalation ? { escalation: outcome.escalation } : {}), ...(outcome.audit ? { audit: outcome.audit } : {}) }
    this.repo.decisions.save(decision)
    for (const id of evaluation.triggerIds) {
      const disposition = this.repo.triggers.disposition(id) ?? { fanout: [], at }
      this.repo.triggers.saveDisposition(id, { ...disposition, evalId: evaluation.id, decisionId: decision.id })
    }
    this.emit('decision.recorded', { decisionId: decision.id, kind: decision.kind, threadKey: thread.key })
    return decision
  }
}
