/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import { pendingPlan, planChoice, planDecision } from './plan.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  receive(received: Trigger): ReceiveResult {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
        // threads when it resumes), and a human-stopped ticket receives nothing because its Mandate was withdrawn.
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's one-word answer decides a waiting P1 plan instead of reaching its worker as ordinary work: `1` approves,
    // `2` asks for another direction, `3` stops. Several reached tickets waiting for a plan keep the message ambiguous, so
    // it reaches no worker and the Router asks which ticket; only exactly one waiting plan may consume it.
    const waiting = trigger.human
      ? [...reached].flatMap(([ticketId, { ticket }]) => {
        const plan = pendingPlan(ticket)
        const choice = plan ? planChoice(trigger.text, plan) : undefined
        const decision = plan ? planDecision(trigger.text) ?? choice : undefined
        return decision ? [{ ticketId, decision, option: choice?.option ?? '' }] : []
      })
      : []
    const decided = new Set<string>()
    // Several reached tickets waiting for a plan keep the message ambiguous: it reaches no worker, and the Router asks
    // which ticket the person meant instead of guessing.
    const ambiguous = waiting.length > 1
    if (!ambiguous) {
      for (const [ticketId, { ticket, context: followed }] of reached) {
        const answer = waiting.length === 1 && waiting[0]!.ticketId === ticketId ? waiting[0]! : undefined
        if (answer) { this.tickets.decidePlan(ticketId, answer.decision.decision, answer.decision.note, 'feishu', answer.option); decided.add(ticketId) }
        else if (!waiting.length) this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
          ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
      }
    }
    // A person may answer in a fresh thread, such as a Feishu direct chat where every message is its own thread: a bare
    // 1/2/3 that reached no ticket decides the one plan that person has waiting. Several waiting plans make it ambiguous.
    if (!decided.size && !fanout.length && trigger.human && trigger.meta.direct === true) {
      const decision = planDecision(trigger.text)
      const plans = decision ? this.repo.tickets.open().filter(ticket => pendingPlan(ticket)
        && ticket.mandate.actor.source === trigger.actor.source && ticket.mandate.actor.id === trigger.actor.id) : []
      if (plans.length === 1) {
        this.tickets.decidePlan(plans[0]!.id, decision!.decision, decision!.note, 'feishu')
        decided.add(plans[0]!.id)
      }
    }
    if (decided.size) this.repo.triggers.saveDisposition(trigger.id, { ...disposition, acked: [...decided] })
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped, that follow the
    // Thread for context, or that several waiting plans made ambiguous, and every bot's, goes to Eval.
    if (!decided.size && (ambiguous || !this.owners(trigger).length)) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
