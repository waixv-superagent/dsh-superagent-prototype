/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
import type { ChannelRef, PlanDecision, PlanVia, PriorityLevel, PriorityVia, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger,
  TriggerDisposition } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}
export interface SourceHost {
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  /**
   * Whether the Policy admits a Trigger on its primary Thread now, evaluated before its Eval runs. Sources use it to
   * acknowledge only messages the bot will take up, such as with a receipt reaction.
   */
  admissible(trigger: Trigger): boolean
  /**
   * Whether this Trigger's person may control the whole deployment from the conversation, such as pausing processing:
   * true only for a person on the Policy's allowed list for the Trigger's Source.
   */
  mayControl(trigger: Trigger): boolean
  /**
   * Pauses or resumes processing on a person's command from this Source's own conversation, the same switch the panel's
   * Pause control sets; returns whether processing is paused now. It applies even while paused, which is how a resume
   * command gets through, and records the save under the `command` origin.
   */
  pauseProcessing(paused: boolean): Promise<boolean>
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Moves an open ticket's replies to `channel` and subscribes it to `thread`, such as a topic the Source opened for it. */
    retarget(id: string, channel: ChannelRef, thread: ThreadRef): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined
    /** What the domain did with a Trigger: where it went, and whether an Eval or a ticket still holds it. */
    disposition(id: string): TriggerDisposition | undefined }
  notify(message: OutboundMessage): void
  /**
   * A person's answer to a waiting plan through this Source's own UI, such as a card button: recorded without a Trigger,
   * a Decision, or an Eval, since the person's act is the authorization and the plan already carries the evidence.
   * @throws UserError when the ticket is unknown or its plan no longer waits.
   */
  decidePlan(ticketId: string, decision: PlanDecision, note?: string, via?: PlanVia, option?: string): Ticket
  /**
   * A person's click on one of the choices a question card offers: the answer becomes the person's message to the worker
   * and the question closes.
   * @throws UserError when the ticket is unknown or ended, the question is gone, or the option is not offered.
   */
  answerAttention(ticketId: string, attentionId: string, option: string): Ticket
  /**
   * A person's click on a TAPD ticket's priority card: the level is recorded as theirs, which no assessment or default
   * overwrites, without a Trigger, Decision or Eval. `by` is the Source identity of the person who clicked.
   * @throws UserError when the ticket is unknown or has ended.
   */
  decidePriority(ticketId: string, level: PriorityLevel, by: string, via?: PriorityVia): Ticket
  /**
   * Whether a person may decide a ticket's priority through this Source's UI: a ticket this Source started is decided by its
   * own actor, and a ticket another Source started (TAPD has no UI of its own) by a person the Policy allows on this Source.
   */
  mayDecidePriority(ticketId: string, actor: string): boolean
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)
