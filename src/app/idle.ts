/**
 * The idle scheduler: the deployment's answer to "may this `P2`/`P3` ticket start now?". It reads the queue, the guard and
 * the newest human message from the store, remembers how long a worker slot has been free, and applies the configured daily
 * budget and idle concurrency so the idle pool never becomes a second mainline. The classification itself is
 * `core/idle.ts`; this class only supplies its inputs and keeps the little state a pass cannot recompute.
 */
import { dailyIdleRoom, idleAdmits, IDLE_ADMITS, idleState, localDay, priorityIsMainline, ticketPriority, ticketStage, waitsForIdle,
  type IdleConfig, type IdleLevel, type IdleState, type Ticket, type TicketInput } from '../core/index.ts'
import type { Store } from './store.ts'

/** What the scheduler reads; the clock is injectable so a test can place itself in a window. */
export interface IdleHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'read'>
  now?: () => Date
}
/** What a launch attempt asked and was told: whether the ticket may start, at which depth, whether as a read-only analysis, and why. */
export interface IdleAdmission { admitted: boolean; level?: IdleLevel; analysis?: true; reason: string }
/** Whether a ticket has runnable work now: a pending or running Assignment. */
const runnable = (ticket: Ticket): boolean => {
  const stage = ticketStage(ticket)
  return stage.stage === 'working'
}
/** Whether a person's message waits for this ticket, which starts at once rather than waiting for idle. */
const personWaiting = (ticket: Ticket): boolean => ticket.undelivered.some(id => {
  const input: TicketInput | undefined = ticket.inputs.find(item => item.id === id)
  return input?.kind === 'resumed' || input?.kind === 'session-resume' || (input?.kind === 'trigger' && !!input.human && !input.context)
    || (input?.kind === 'text' && !!input.person)
})
/** Whether a person just retried the ticket: the Assignment before the pending one ended as `retried`, not `recovered`. */
const retriedByPerson = (ticket: Ticket): boolean => ticket.assignments.length > 1 && ticket.assignments.at(-2)?.endedReason === 'retried'

/** Supplies the idle judgement to the Executor from the store and the configured `executor.idle` block. */
export class IdleScheduler {
  /** When a worker slot first stayed free after the mainline emptied; undefined while every slot is taken. */
  private capacitySince?: number
  constructor(private readonly host: IdleHost) {}
  /** The deployment's idle configuration, from the executor settings block. */
  config(): IdleConfig { return this.host.store.settings().executor.idle }
  private now(): Date { return this.host.now?.() ?? new Date() }
  /** The newest human message's arrival, if the deployment recorded one. */
  private lastHumanAt(): string | undefined { return this.host.store.read.recentTriggers(0, 30).find(trigger => trigger.human)?.at }
  /**
   * Records the worker load of a launch attempt: while every slot is taken the capacity clock is cleared, and the first
   * attempt with a free slot starts it, so a slot must stay free for `slotFreeMin` before it counts.
   */
  observe(running: number, max: number): void {
    if (max - running <= 0) { this.capacitySince = undefined; return }
    this.capacitySince ??= this.now().getTime()
  }
  /** The current idle depth and its five signals. */
  state(): IdleState {
    const settings = this.host.store.settings()
    const open = this.host.store.tickets.open()
    return idleState({ now: this.now(), config: settings.executor.idle,
      queuedMainline: open.some(ticket => priorityIsMainline(ticketPriority(ticket)) && runnable(ticket)),
      capacitySince: this.capacitySince, lastHumanAt: this.lastHumanAt(), paused: settings.paused,
      openP0: open.some(ticket => ticketPriority(ticket) === 'P0') })
  }
  /**
   * Whether a ticket's work may start now: mainline levels always, a pending priority question never, and `P2`/`P3` only at
   * a depth that admits them, within the idle concurrency and the daily budget. A person's message waiting for the ticket
   * starts it at once, because the person is the reason the system was holding back.
   *
   * With `analysis.enabled` (the default since docs/025) a pooled ticket's first idle launch is its read-only analysis, and
   * a ticket whose analysis already finished waits for a person instead of running again: the pool holds decisions, not a
   * second implementation queue. A person's message still starts the work itself.
   */
  admission(ticket: Ticket, load: { running: number; max: number }): IdleAdmission {
    this.observe(load.running, load.max)
    const config = this.config()
    const level = ticketPriority(ticket)
    if (!config.enabled) return { admitted: true, reason: 'the idle gate is off, so every ticket starts at once' }
    if (!waitsForIdle(level)) return { admitted: true, reason: `${level} runs with the mainline` }
    // A TAPD ticket asks its person before it may start; the answer or the timeout decides, never the idle window.
    if (ticket.priorityAsk?.state === 'pending') return { admitted: false, reason: 'waiting for the priority answer' }
    if (personWaiting(ticket)) return { admitted: true, reason: "a person's message waits for this worker" }
    if (retriedByPerson(ticket)) return { admitted: true, reason: 'a person retried the ticket' }
    // One read-only analysis per visit to the pool: once it produced a verdict, only a person decides what happens next, so
    // an automated follow-up cannot turn the pool into an unnoticed implementation queue.
    if (config.analysis.enabled) {
      if (ticket.idle?.analysis?.state === 'ready') return { admitted: false, reason: 'its idle analysis waits for a person to act on the verdict' }
      if (ticket.idle?.analysis?.state === 'failed') return { admitted: false, reason: 'its idle analysis did not finish; a person decides whether to run it again' }
    }
    const state = this.state()
    if (!state.level) return { admitted: false, reason: state.reason }
    if (!idleAdmits(state.level, level)) return { admitted: false, reason: `${state.level} admits ${IDLE_ADMITS[state.level]}, not ${level}` }
    const open = this.host.store.tickets.open()
    const idleRunning = open.filter(item => item.idle?.launchedIn && runnable(item)).length
    if (idleRunning >= config.analysisWorkers) return { admitted: false, reason: `the idle pool already runs ${idleRunning} of ${config.analysisWorkers} workers` }
    const today = localDay(this.now().toISOString())
    const launchedToday = this.host.store.tickets.list().filter(item => item.idle?.launchedAt && localDay(item.idle.launchedAt) === today).length
    if (!dailyIdleRoom(launchedToday, config)) return { admitted: false, reason: `the day's ${config.dailyItems} idle items are used` }
    // The pool's first launch is the read-only analysis; its worker records a verdict a person can act on (docs/025).
    return config.analysis.enabled
      ? { admitted: true, level: state.level, analysis: true, reason: `${state.reason}; the idle pool runs a read-only analysis` }
      : { admitted: true, level: state.level, reason: state.reason }
  }
}
