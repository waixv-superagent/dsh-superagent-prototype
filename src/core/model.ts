/** Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor. */
import type { Reason } from './reasons.ts'
import type { Plan, TicketPhase } from './plan.ts'
import type { IdleLevel } from './idle.ts'
import type { PriorityAsk, TicketPriority } from './priority.ts'
import type { TicketKind, TicketKindSource } from './kind.ts'

/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
export interface ActorRef { source: string; id: string }
/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
export interface ThreadRef { source: string; id: string }
/** Write-only address on a thread; the address format belongs to the source. */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** Stable key of a thread across the whole domain. */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
export interface Trigger {
  id: string
  source: string
  /** Every thread the trigger belongs to; the first (`threads[0]`) is the primary thread that hosts its evaluation. */
  threads: ThreadRef[]
  actor: ActorRef
  /** Source-declared: the event was written by a person rather than a bot, CI, or this agent. */
  human: boolean
  /** Source-declared: the sender addressed the agent, by mentioning it or in a direct message to it. */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** Source-native details for adapters; the core never interprets them. */
  meta: Record<string, unknown>
}

/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
export interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not resume
   * without its worker taking it up no longer counts.
   */
  fanout: string[]
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs. */
  context?: string[]
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it. */
  requeued?: true
  /** The tickets whose Executor handed it back as beyond the ticket, each once, with why; it goes to Eval once none decides it. */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket. */
  acked?: string[]
  at: string
}
/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions, as the Store and the core keep them. */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
 * an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
 * main Session may only stop the work on it.
 */
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
  const returned = new Set(disposition.handbacks?.map(item => item.ticketId))
  const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id))
  if (!reached.length || records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)) return []
  return reached.filter(id => {
    const ticket = records.tickets.get(id)
    return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))))
  })
}
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * Whether proactive candidates are assessed and accepted (`auto`), still assessed so Decisions record what they would accept
 * (`would_accept`) without accepting (`observe`), or not admitted (`off`).
 */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** Where a Mandate's Trigger was received: its Source, its receiving scope as the Source recorded it, and its admission row. */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks (see `docs/002`):
 * - `addressed`: a sender on the Source's list addressed the agent;
 * - `followup`: a message on a Thread that has tickets;
 * - `admission`: the cell of the receiving scope's admission row; `observation` when it made an inferred candidate under
 *   an accept mode;
 * - `listed`: accepted before Mandates recorded their basis, from a sender who must still be on the list; `authority` is
 *   what an earlier version recorded instead.
 * `sender` names the allowed sender at acceptance time, and `rules` the rules an assessment matched.
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop. */
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
)

/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** How the gate admitted it, for re-validation and audit. */
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** Active trigger evaluation on a thread; at most one exists per thread. */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  primary?: string
  strength: Strength
  /** Actor and gate basis of the strongest admissible trigger; they seed the mandate on accept. */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** Timestamp when the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  delivered?: string
  /** Expiration timestamp, counted from delivery (or from start until delivered); a processing pause shifts it forward by the pause duration. */
  deadline: string
  /** Timestamp when processing pause began; resuming shifts `deadline` forward by the pause duration; cleared on resume. */
  pausedAt?: string
}

/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** Time of the newest trigger on the thread. */
  lastAt?: string
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  subscriptions: string[]
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context, such as an Issue or another pull request
   * it found: its messages reach them, but grant nothing, and a person's message there resumes none of them that ended.
   */
  context?: string[]
  /** Keys of threads that shared a trigger with this one; context only. */
  correlated: string[]
  /** Triggers waiting for the next eval (debounce buffer). */
  pending: string[]
  evaluating?: Evaluation
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  expired?: number
  /**
   * Source-native attributes needed by channels or readers (for example a Feishu thread id). Its Source may also describe
   * the thread for people: `label`, a display name, and `facts`, a {@link ThreadFacts} map.
   */
  meta: Record<string, unknown>
}
/** Text in both interface languages, or the same text in both. */
export type Text = string | { zh: string; en: string }
/** One fact a Source states about its thread, such as an issue number or a CI result; `problem` marks one that needs a person. */
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** A thread's facts by id, ordered for display; each writer owns its fact ids. */
export type ThreadFacts = Record<string, ThreadFact>

/**
 * 决定的结果：`accept` 建单，`chat` 是对话（保留线程、必须回复、默认不建单），`ignore` 保持安静不回复，
 * `stop` 停掉工单，`unavailable` 是评估没能完成。
 */
export type DecisionKind = 'ignore' | 'accept' | 'chat' | 'reopen' | 'stop' | 'unavailable'
/**
 * 闲聊里发现的、值得单独做的事：`chat` 决策可以携带它，在回复用户的同一轮里建一张工单。
 * 工单的标题、范围与类别取自这里，`reason` 说明为什么值得提单。
 */
export interface Escalation { title: string; scope: string; category: 'bug' | 'feature'; reason: string
  /** The configured repository or workspace the work belongs to; the executor resolves its delivery environment. */
  target?: string }
/** Outcome of one eval, recorded on the thread. */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  /** Every ticket this Decision opened: one for an ordinary accept, more when the message held 2–4 separable goals. */
  ticketIds?: string[]
  mandate?: Mandate
  /** 一条 chat 决策想建、并且已经建出来的单（没有它时 chat 只回复）。 */
  escalation?: Escalation
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  audit?: Record<string, unknown>
  /** A person dismissed the problem an unavailable Decision shows. */
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * What an Assignment reports: work is in progress (`progress`), its worker waits for a Trigger (`waiting`), a result is
 * ready (`ready`), a person must act to unblock or recover it (`blocked` or `failed`), or nothing is left to do (`dropped`).
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** Binding between a ticket and one executor instance. */
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy with Inputs since that report. */
  deliveredAt?: string
  /**
   * When a turn of its worker last ended with nothing left to run for it and nothing waiting for it: what its Session took
   * into a step before, the worker read.
   */
  idleAt?: string
}

export type TicketInput =
  /** A Trigger on one of its Threads, or attached to it; `human` when a person wrote it. */
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** It reached the ticket only on a Thread its Executor follows for context. */
    context?: true
    /**
     * When the worker's Session took the message that carried it into a step, from which its model reads it; `null` while
     * it waits in the Session. One delivered before reads were recorded has none, and counts as read from `deliveredAt`.
     */
    readAt?: string | null
    /** The Assignment it was last delivered to. */
    deliveredTo?: string
    /** When an earlier version handed it to the worker. */
    deliveredAt?: string }
  /** The Policy changed in a way that bears on the ticket, as `effect` says; Inputs written before effects have none. */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** A Decision reopened the ticket; written before ended tickets resumed on their own. */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate. */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  /** A person wrote in the Ticket's worker Session, which resumed it: `text` is what they wrote there. */
  | { id: string; kind: 'session-resume'; text: string; at: string }
  /** The host's own instruction, such as a status request; `person` marks one a person wrote, which the idle gate never holds. */
  | { id: string; kind: 'text'; text: string; at: string; person?: true }
  /** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed, with their instruction now, or no
 * longer apply; `proactive: false` once inferred work is no longer accepted, as when the accept mode leaves `auto`; and
 * `requesterAllowed: false` once the sender it is for, `requester`, a person or a bot, may no longer start work there.
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** How a ticket ended: with its result, with its pull request merged or closed unmerged, with nothing to do, or stopped by a person. */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** One context block a worker puts on a question card: its own label and text; `fold` puts it behind the detail tap. */
export interface QuestionSection { label: string; text: string; fold?: boolean }
/** One exact provider/model route, as DeepSeek Harness names a child Session's model. */
export interface ModelRoute { provider: string; model: string }
/** A person's recorded authorization for one route on a ticket, and the question it answered. */
export interface ModelGrant extends ModelRoute { at: string; attentionId: string }
/** The choices a model request's card offers; only the first one records an authorization. */
export const MODEL_APPROVAL_OPTIONS = ['允许', '不允许'] as const
/** A ticket's subagent model route, as people and models write it. */
export const modelRoute = (route: ModelRoute): string => `${route.provider}/${route.model}`
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
export interface Attention { id: string; question: string; /** The worker's choices, when it offers any; a card shows them and a click answers. */ options?: string[]; /** The context the worker adds, in its own order; absent keeps the card's default layout. */ sections?: QuestionSection[]; triggerId?: string
  /** The subagent model route this question asks the person to allow; absent on an ordinary question. */
  model?: ModelRoute }
/** What a person does with a ticket the idle analysis sorted: put it in the attention pool, merge it into a duplicate, or let it sleep. */
export type AnalysisVerdict = 'promote' | 'merge' | 'archive'
/**
 * The actionable advice an idle analysis ends with. The analysis is read-only: this is the one decision it records, and a
 * person (or the board) still decides when the ticket runs. `mergeWith` names the tickets it likely duplicates; `cost` says
 * what promoting it would take, so attention can be weighed rather than merely offered.
 */
export interface AnalysisAdvice {
  verdict: AnalysisVerdict
  /** Why, in one sentence a person can check against the dossier. */
  reason: string
  /** Ticket ids the analysis believes describe the same problem; at most three, never the ticket itself. */
  mergeWith?: string[]
  /** What promoting it would cost, such as `约 2 小时实现 + 一次编辑器验证`; optional. */
  cost?: string
  at: string
}
/**
 * The read-only analysis a `P2`/`P3` ticket gets in an idle window (docs/025): `running` while its assignment runs, then
 * `ready` with the worker's dossier and verdict, or `failed` when the worker could not finish. A ticket whose analysis is
 * `ready` waits for a person; the idle gate never starts it again on its own.
 */
export interface TicketIdleAnalysis {
  state: 'running' | 'ready' | 'failed'
  /** The Assignment that ran it. */
  assignmentId: string
  /** The idle depth that admitted it. */
  level: IdleLevel
  startedAt: string
  endedAt?: string
  /** The verdict the worker recorded, absent when it reported no advice. */
  advice?: AnalysisAdvice
}
/** One state the host found provably inconsistent on an open ticket and repaired on its own, kept as the system's trace. */
export interface TicketRepair {
  at: string
  /** The invariant I4 checked: the Assignment, its launch, or the delivery of waiting Inputs. */
  invariant: 'assignment' | 'launch' | 'delivery'
  /** What the host did about it. */
  action: 'restart' | 'relaunch' | 'deliver'
  /** The Assignment the repair concerned, so its repeats are countable. */
  assignment?: string
  /** What the host found, in words a person can check. */
  detail: string
}
/** Ticket aggregate: an authorized work item with its assignments, channels, thread bindings, and inputs. */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** 这张单是缺陷还是需求；只有从 escalation 建出来的单才有，直接在路由里接的单不填。 */
  category?: 'bug' | 'feature'
  /**
   * Where the ticket runs: `P0`/`P1` with the mainline, `P2`/`P3` only in an idle window (see `core/priority.ts` and
   * `core/idle.ts`). Absent on tickets stored before priorities existed, which count as `P1` (`ticketPriority`).
   */
  priority?: TicketPriority
  /** The priority question a TAPD ticket asks before it may start; absent when the ticket never asked. */
  priorityAsk?: PriorityAsk
  /**
   * A `P2`/`P3` ticket waiting in the idle pool: when it entered, when and at which idle depth its work started, and the
   * read-only analysis it got in an idle window. The daily budget counts the tickets whose `launchedIn` falls on the
   * current day.
   */
  idle?: { enteredAt: string; launchedIn?: IdleLevel; launchedAt?: string; analysis?: TicketIdleAnalysis }
  /**
   * What kind of work it is, decided at acceptance (`core/kind.ts`): every ticket created since kinds exist has one; read
   * it through `ticketKind`, which derives it for older tickets. A label for counting and filtering, never an authority.
   */
  kind?: TicketKind
  /** Who decided `kind`: the router's accept, the Source or delivery target, or the title rule. */
  kindSource?: TicketKindSource
  /** The Channels of the messages it was accepted from. */
  channels: ChannelRef[]
  /** Where its replies go now; a Source may move them to a conversation it opened, such as a topic. */
  replyChannel?: ChannelRef
  /** When, by whom, and how the ticket ended, with a person's or the host's reason beyond the outcome; an open ticket has none. */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[]
  /**
   * Threads a Source made the ticket follow, such as its pull requests': a `ready` report ends the ticket only once
   * `followsDone` holds; the close that makes it hold ends the ticket with that outcome unless its work has not finished (see
   * `Tickets.unfinished`), and then its next `ready` or `dropped` report ends it.
   */
  follows?: Follow[]
  /** People's questions the worker answered, whose answers the main Session may send. */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** The Triggers it was accepted from: the one that started it, and the batch its Eval held. */
  origin: { triggerId: string; triggerIds: string[] }
  /** What its Executor chose: its short name, directory and assignment text. */
  execution?: Execution
  /** When a person confirmed the delivered changelist may be submitted; the submit itself stays theirs to run. */
  confirmed?: { at: string }
  /**
   * A person's local verification of delivered work. `pending` from the worker's `ready` report, when the ticket carries a
   * shelved changelist or review, until a person passes it or returns it; a passed one may also be recorded on an ended
   * completed ticket, so the board can say who checked it. Absent on analysis tickets and on work delivered before this gate.
   */
  verification?: TicketVerification
  /**
   * The follow-up after a person's local check: a delivered change is tracked through its review, pipeline and submit
   * until it is merged. A blocked pipeline that needs a person stays here instead of silently ending the ticket.
   */
  pipeline?: TicketPipeline
  /** The P1 gate: the worker's plan and the person's decision on it (see `core/plan.ts`). */
  plan?: Plan
  /** The phase the ticket is in, `plan` from its creation until a person approves its plan; absent on tickets stored before the gate. */
  phase?: TicketPhase
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  delivery?: { error: string; at: string }
  /**
   * The state inconsistencies the host repaired on its own (I4, see `reprojectable`), latest last; at most the last five.
   * They are the "system handled it" trace a person reads instead of inspecting the ticket.
   */
  repairs?: TicketRepair[]
  /**
   * Relations its worker recorded from this ticket to others, oldest first, one per kind and target (see
   * `Tickets.link`). A `spawned` relation is never stored: the panel derives it from the records (see `app/views/graph.ts`).
   */
  relations?: TicketRelation[]
}
/**
 * What one ticket is to another: `spawned` started it (derived, never stored), `supersedes` replaces its work, `blocks` holds
 * it back until this one lands, and `related` is context only.
 */
export type TicketRelationKind = 'spawned' | 'supersedes' | 'blocks' | 'related'
/** The relation kinds a worker records with `orchestrator_ticket_link`; `spawned` comes from the records instead. */
export const LINKED_RELATION_KINDS = ['supersedes', 'blocks', 'related'] as const satisfies readonly TicketRelationKind[]
export type LinkedRelationKind = typeof LINKED_RELATION_KINDS[number]
/** A relation its worker recorded from the ticket that holds it to `ticketId`, with why. */
export interface TicketRelation { kind: LinkedRelationKind; ticketId: string; reason: string; at: string }
/**
 * A Thread a ticket follows, by its key: `own` when the ticket opened it, such as its own pull request, and when and how it
 * closed. `followsDone` holds once no Thread of its own is open, or, when the ticket has no `own` Thread, once every followed
 * Thread closed; the ticket then ends unless its work has not finished (see `Tickets.unfinished`).
 */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
/**
 * Where a ticket's worker runs. `lease` holds the path prefixes it may write, relative to its workspace: an empty lease
 * means the whole workspace, so the task center never runs it beside another ticket in the same workspace. The delivery
 * facts — `changelist`, `review`, `verification` — are what its latest report said it delivered.
 */
export interface Execution { name: string; directory: string; assignment: string; workspace?: string; lease?: string[]
  /** The delivery environment this ticket's work belongs in; absent keeps the deployment's configured backend. */
  backend?: Backend
  /** The configured repository or workspace the work belongs to, once an accept or a Source named one. */
  target?: string
  changelist?: number; review?: string; verification?: string
  /** The subagent model routes a person allowed on this ticket, each with the question it answered. */
  modelGrants?: ModelGrant[] }

/** A delivery environment: this deployment's git source repository, or its Perforce depot. */
export type Backend = 'git' | 'p4'

/** Where a delivered ticket stands with the person's local check: waiting, passed, or returned for rework. */
export interface TicketVerification {
  at: string
  state: 'pending' | 'passed' | 'failed'
  /** Who answered the pending state; a `pending` one has none. */
  by?: 'person' | 'pipeline'
  /** The person's words when they returned the work or accepted it with a caveat. */
  note?: string
}
/** What the follow-up stage observed about a delivered change. */
export type PipelineState = 'running' | 'blocked' | 'merged'
/**
 * Where a delivered change stands in the Swarm submitter flow: its pre-approval checks, the person's review, the
 * pre-submit smoke Jenkins runs after approval, and the submit itself. The panel draws these as one four-step track, so a
 * person reads a ticket by stage rather than by parsing the last check sentence.
 */
export type PipelineStep = 'tests' | 'review' | 'smoke' | 'ready' | 'merged' | 'autobuild'
/** How many pre-approval checks a running review reports, so the panel can show `8/11` instead of just "running". */
export interface PipelineProgress { pass: number; running: number; fail: number; total: number }
/**
 * A delivered change's follow-up: the review and pipeline checks after delivery, and the submit that ends it. `blocked`
 * with `manual: true` is the case the agent must not paper over: a person has to act before it can proceed. `merged`
 * means the change is already in the mainline, so the ticket completes without waiting for another check.
 */
export interface TicketPipeline {
  state: PipelineState
  /** When this state was recorded. */
  at: string
  /** The fine stage of the Swarm submitter flow; absent on a pipeline recorded before the stage existed. */
  step?: PipelineStep
  /** The pre-approval checks' counts, when the review reports them. */
  progress?: PipelineProgress
  /** Where the current step itself runs, such as the Jenkins smoke build; `url` stays the review. */
  stageUrl?: string
  /** Where a person follows it, such as the review or CI URL. */
  url?: string
  /** Why it is blocked, in words a person can act on. */
  reason?: string
  /** False when the agent may retry on its own; a blocked pipeline that needs a person sets this true. */
  manual?: boolean
  /** The last observed check, short enough for a board card. */
  check?: string
  /** The review version and failure the follow-up last acted on, so the same failure is not handed to a worker twice. */
  observed?: string
  /** When the follow-up last looked at the pipeline. */
  seenAt?: string
  /** How many times a worker was woken to fix this pipeline. */
  fixes?: number
  /** When a worker was last woken for a failure, which bounds how long a stale result may wait. */
  fixAt?: string
  /** When a worker last asked Swarm to rerun checks, so a failure the rerun has not replaced yet is not a new failure. */
  rerunAt?: string
  /**
   * The submit, once it happened while an autobuild still has to report: the ticket stays open at step `autobuild` until the
   * build passes and a person sends its package or closes the ticket. `change` is the submitted changelist when Swarm named it.
   */
  submitted?: { at: string; change?: number }
  /** The autobuild's package link, which the person's "send" click forwards. */
  artifact?: string
}
/**
 * The structured content of one pipeline notice, so a chat Source can draw it as a card: a headline, one or two short lines,
 * the links to open and the actions a person may take there. `text` on the message stays the fallback.
 */
export interface PipelineCard {
  ticketId: string
  /** The ticket's title, the card's subtitle. */
  title: string
  /** `info` while it runs, `success` when a stage passed, `waiting` when a person acts, `danger` for a failure. */
  tone: 'info' | 'success' | 'waiting' | 'danger'
  heading: string
  lines: string[]
  links: { label: string; url: string }[]
  /** The review's reviewer choices on a review-waiting card; the value is the p4 account a click adds. */
  reviewers?: { label: string; value: string }[]
  /** The people and chats an autobuild package may be sent to; the value is a Feishu `ou_`/`oc_` id. */
  targets?: { label: string; value: string }[]
  /** Whether the card offers 关单, which ends the ticket as completed. */
  close?: boolean
  /** Whether the card offers 重跑, which asks Swarm to rerun the current version's failing checks. */
  rerun?: boolean
}
/**
 * One fact the host observed about a delivered change. A `failure` carries the detail a worker needs to fix it; `review`
 * is a green pipeline that waits for a person, `approved` is a review a person approved, and `merged` is the submit. The
 * optional `step`, `progress` and `stageUrl` are what the panel shows: the fine stage, how many checks passed, and where
 * the current step runs (a Jenkins smoke build, for instance).
 */
export type PipelineObservation =
  | { kind: 'running'; check: string; url?: string; signature?: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string }
  | { kind: 'review'; check: string; url?: string; signature?: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string }
  | { kind: 'approved'; check: string; url?: string; signature?: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string }
  | { kind: 'failure'; check: string; url?: string; signature: string; detail: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string }
  | { kind: 'blocked'; check: string; reason: string; url?: string; signature?: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string
    /** What kind of wait it is, for the notice's headline; absent reads as a generic manual blocker. */
    topic?: PipelineBlockTopic }
  | { kind: 'merged'; check?: string; url?: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string
    /** The submitted changelist, when Swarm named it. */
    change?: number
    /** True when the deployment follows an autobuild after the submit: the ticket then stays open at step `autobuild`. */
    autobuild?: boolean }
  /** The autobuild after a submit: running, passed with its package link, failed, or not started within the wait. */
  | { kind: 'autobuild'; result: 'running' | 'passed' | 'failed' | 'timeout'; check: string; signature: string; url?: string
    stageUrl?: string; artifact?: string; step?: PipelineStep; progress?: PipelineProgress }
/** Why a pipeline waits for a person: no result at all, a failure that got no new result, the fix attempts used up, a failed pre-submit, or a vanished review. */
export type PipelineBlockTopic = 'noResult' | 'stuck' | 'attempts' | 'smokeFailed' | 'reviewGone'
/** How many days a completed ticket stays on the board before it is archived. */
export const COMPLETED_RETENTION_DAYS = 7
/** Whether a completed ticket is past its board retention and should be treated as archived. */
export const completedArchived = (ticket: Pick<Ticket, 'ended'>, now = new Date().toISOString()): boolean =>
  ticket.ended?.outcome === 'completed'
  && Date.parse(ticket.ended.at) + COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000 <= Date.parse(now)
/** Whether a ticket is open: it has not ended. */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** Whether a delivered ticket waits for a person's local verification. */
export const awaitsVerification = (ticket: Pick<Ticket, 'verification'>): boolean =>
  ticket.verification?.state === 'pending'
/** How a ticket ended. */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
export function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context = true): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id)
  return trigger.threads.some(ref => {
    const current = thread(threadKey(ref))
    return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id))
  }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))))
}
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * Whether Inputs reached the Assignment's worker at or after its report, so it has been busy with newer work since: the test
 * the Executor itself uses to decide a report no longer holds a handoff or an interrupted Assignment back.
 */
export function busySinceReport(assignment: Assignment | undefined): boolean {
  const report = assignment?.report
  return !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
}
/**
 * The latest Report while it still speaks for the Ticket, or undefined once it is history. Inputs that reached its worker
 * after it supersede it, and a person's message lifts a blocked or failed one (`waitsForPerson`): the Executor continues the
 * work by itself in exactly those cases, so the Ticket is working again rather than waiting on the old report. Only the
 * latest Assignment's own Report can speak for the Ticket, so a retry or a re-dispatch reads as working until it reports.
 */
export function currentReport(ticket: Ticket): Assignment['report'] {
  const assignment = latestAssignment(ticket)
  const report = assignment?.report
  if (!report) return undefined
  if (report.state === 'blocked' || report.state === 'failed') return waitsForPerson(ticket) ? report : undefined
  return busySinceReport(assignment) ? undefined : report
}
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  const fromPerson = (input: Ticket['inputs'][number]) => input.kind === 'trigger'
    ? !!input.human && !input.context : input.kind === 'session-resume'
  return !ticket.inputs.some(input => fromPerson(input) && input.at > report.at)
}
