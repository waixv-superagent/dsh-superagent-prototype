/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, reprojectable, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, Backend, EngineForExecutor, Execution, Executor, IdleLevel, Mandate, PolicyEffect, Ticket, TicketInput,
  TicketRepair, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { deliveryKey, resolveDelivery } from '../app/delivery-targets.ts'
import { claimsWorkspace, conflicts, normalizePath, place, workspaceClient, type Active, type Peer, type Workspace } from './workspace.ts'
import { executionRoot, p4Prepare, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { MissingWorkerTools } from '../app/worker-tools.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'

const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 10_000
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5000
/** How often the Executor looks for provably inconsistent Ticket state, so a pass does not rescan it every two seconds. */
const REPROJECT_INTERVAL_MS = 30_000
/** True when an input comes from a person (a non-context human trigger, a direct text input such as a status request, or a
 * message they wrote in the worker's Session). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context
  : input?.kind === 'text' || input?.kind === 'session-resume'
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/** A stored Session that cannot be read: a corrupt log, a format error, or a failed resume. Another try meets it again. */
const SESSION_CORRUPT = /SessionQueryError|SessionFormatError|stored (?:log|session)[^.;]*\bis corrupt|resume failed for session/i
/**
 * True when the failure is a stored Session that cannot be read — a corrupt log, a format error or a failed resume — which a
 * later try meets again. A person must remove its session log (or give the Ticket a fresh Session); the host never retries it.
 */
export function corruptSession(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && /^session\/(?:query|format|corrupt|resume|parse)/i.test(code)) return true
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return SESSION_CORRUPT.test(text)
}
/**
 * The provider-neutral failure codes DeepSeek Harness retries: a later request may not meet the same failure. Its retry policy
 * routes on these codes, so the host does too (see `transient`).
 */
const PASSING_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])
/**
 * DeepSeek Harness codes for failures waiting for recovery would meet again: an exhausted account quota, a credential a person
 * must fix, a context window that does not grow, and images that must be offloaded first. The host never retries these by itself.
 */
const TERMINAL_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED', 'INVALID_ARGS', 'NO_ADAPTER'])
/**
 * True when an error represents a transient network or model-provider failure: DeepSeek Harness's retryable failure codes, an HTTP
 * 408, 429, or 5xx status, or a connection that was refused, reset, timed out, or could not resolve its host. A terminal code wins
 * over its message, so a quota or credential failure that quotes a status is not retried.
 */
export function transient(error: unknown): boolean {
  // A corrupt stored Session is not a passing failure however a wrapper words it, such as a RemoteError with a 500 status.
  if (corruptSession(error)) return false
  const value = error as { code?: unknown; status?: unknown } | undefined
  const code = typeof value?.code === 'string' ? value.code : undefined
  if (code !== undefined) {
    if (PASSING_CODES.has(code)) return true
    if (TERMINAL_CODES.has(code)) return false
  }
  if (typeof value?.status === 'number') return value.status === 408 || value.status === 429 || value.status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String(code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted' | 'repaired' | 'repairAssignment' | 'idleLaunch'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** The GitHub repository this deployment watches, one of the configured delivery targets; empty without a GitHub Source. */
  readonly repository: string
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'pending'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds' | 'workerToolGap'>
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
  /**
   * Whether a `P2`/`P3` ticket may start now under the idle five-signal judgement; absent starts every ticket at once.
   * A refusal holds the launch (it retries later) instead of failing the assignment.
   */
  idleAdmission?(ticket: Ticket, load: { running: number; max: number }): { admitted: boolean; level?: IdleLevel; reason: string }
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, delivery environment, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string, backend: Backend = settings.executor.backend, target?: string): Execution {
  // escalation 建的单可能没有英文短名：按类别取一个，目录名仍由票号后缀保证唯一。
  const name = ticketWorktreeName(outcome.name ?? (ticket.category === 'bug' ? 'fix' : 'feature'), ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  // Shared workspaces are the task center's, so the worker learns its lease from its environment and its peers from the
  // launch message (see 011 Task center).
  const sharing = sharingInstructions(settings, backend)
  const lease = (outcome.paths ?? []).map(normalizePath).filter(Boolean)
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment: assignment + sharing, lease, backend,
    ...(target ? { target } : {}) }
}
/**
 * The delivery instructions a worker gets for its ticket's environment, composed at each launch so a ticket moved to
 * another environment (see `Tickets.redispatch`) reads the channel it now belongs in. The target recorded at accept
 * chose that environment, so a worker never re-checks the channel at P1. Under p4 the worker delivers by shelving a
 * changelist, because the mainline is read-only for it.
 */
export function deliveryInstructions(backend: Backend): string {
  return backend === 'p4'
    ? '\nDeliver as one shelved changelist: p4 change -i, p4 reopen -c <CL> for the edits, p4 shelve -c <CL>, '
      + 'then p4 describe -S <CL> and open the Swarm review. After you change something, reshelve the same changelist with -f. '
      + 'A reshelve with no content change opens no new review version and triggers no Swarm rerun, so never reshelve just to rerun: '
      + 'call orchestrator_pipeline_rerun to rerun the current version\'s failing checks, and report blocked if Swarm has no failing check to rerun. '
      + 'The host follows the review itself after your ready report: it reads the testruns and AI verdict, and when a failure is '
      + 'yours to fix it wakes you with the failing checks and Jenkins errors. Fix it in this workspace and reshelve; do not start '
      + 'a polling subagent of your own. '
      + 'After shelving, keep your files and edits in the workspace: do not p4 revert them, so the change stays available for the '
      + 'person to test and for the next round. Once a person has submitted the changelist (p4 describe -S <CL> no longer says '
      + '*pending*) and you continue on those files, p4 sync them to the submitted revision and start a new changelist for the follow-up '
      + 'work: p4 change -i, then p4 edit -c <new CL> <files>, or p4 reopen -c <new CL> <files> if they are still open. Never reuse the '
      + 'submitted changelist. '
      + 'Never run p4 submit: the mainline is read-only for you and a person submits the change. '
      + 'If this Ticket came from TAPD, start the changelist description with the TAPD short id '
      + '(DSH_SUPERAGENT_TAPD_SHORT_ID when set, otherwise the bug page\'s short number) followed by a space and a title: '
      + 'never the long bug id or a URL. '
      + 'Report the delivery\'s facts with the report: changelist=<CL>, swarm_review=<id or URL>, and verification= as the four '
      + 'blocks 版本与前置 / 复现步骤 / 预期与证据 / 待你判断; a ready report missing a block is refused, and an unrun rehearsal says so honestly.'
    : ''
}
/** The prefix every sharing instruction block starts with, so a moved ticket can drop the previous one. */
const SHARING_PREFIX = '\nYou share this workspace'
/**
 * The task center's sharing rules for a worker in a shared workspace, which learns its lease from its environment and its
 * peers from the launch message (see 011 Task center). Under p4 it also keeps to a changelist of its own.
 */
export function sharingInstructions(settings: Settings, backend: Backend): string {
  if (!settings.executor.workspaces.length) return ''
  return SHARING_PREFIX + ', and its p4 client, with other tickets. Write only under your lease: DSH_SUPERAGENT_LEASE holds '
    + 'its paths, and the launch message\'s `peers` names who else is here and what they write. Read anything. If the change needs '
    + 'a file outside your lease, do not take it: report the need and stop, so the work can be widened or split.'
    + (backend === 'p4'
      ? ' Keep your edits in a changelist of your own and never touch a peer\'s: p4 change -i, then p4 reopen -c <your CL> for the '
        + 'files you edit. Never run p4 sync of the whole workspace, p4 revert without -c, or a revert of another changelist. Shelving '
        + 'leaves your edits in the shared tree: keep them there.' : '')
}
/**
 * Removes the delivery and sharing instructions a launch appends, leaving what the accept wrote, so a ticket moved to another
 * delivery environment reads only that environment's instructions on its next launch.
 */
export function baseAssignment(text: string): string {
  const sharing = text.indexOf(SHARING_PREFIX)
  const withoutSharing = sharing < 0 ? text : text.slice(0, sharing)
  const delivery = withoutSharing.indexOf(deliveryInstructions('p4'))
  return delivery < 0 ? withoutSharing : withoutSharing.slice(0, delivery)
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** What a worker reads when the host retried its ticket after a passing model or network failure, not a person. */
const RECOVERED = 'The host retried this ticket automatically after a passing model or network failure. Continue the assignment from '
  + 'the current worktree, git history and PR state; do not repeat completed work.'
/** What a worker reads when a person wrote in its Session and that resumed the ticket it works on. */
const RESUMED_IN_SESSION = 'This ticket ended earlier and this person, writing in its Session, resumed it under the same mandate: '
  + 'its tools and reports work again. Continue with what they asked and report ready when it is done; if they ask for work '
  + 'beyond this ticket\'s scope, report a question or a blocker instead of extending it.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'session-resume') return RESUMED_IN_SESSION
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * The limit is per delivery environment (see `deliveryKey`): the superagent repository and the SunGame p4 depot run their
 * own workers without holding each other's slots, and a workspace pool still adds its own slots per physical workspace.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot of
 * one environment, and allows one extra slot there for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots per delivery environment.
   * @param partition - Returns the delivery environment a ticket belongs to; tickets with the same key share one limit.
   * @param waiting - Returns the ticket IDs that may launch or wake, so an environment with only queued work still counts.
   */
  constructor(private readonly running: () => string[], private readonly max: () => number,
    private readonly partition: (ticketId: string) => string = () => '', private readonly waiting: () => string[] = () => []) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** Number of slots in use in one delivery environment, including launch reservations. */
  usedIn(key: string): number { return this.idsIn(key, true).size }
  private idsIn(key: string, includeLaunch: boolean): Set<string> {
    const ids = new Set(this.running().filter(ticketId => this.partition(ticketId) === key))
    for (const [ticketId, by] of this.starting) if ((includeLaunch || by !== 'launch') && this.partition(ticketId) === key) ids.add(ticketId)
    return ids
  }
  /** How many launches may run concurrently: the free slots summed over the environments that have work or workers. */
  launches(): number {
    // A launch reservation is the launch queue's own accounting, so counting it again would shrink the queue twice.
    const keys = new Set([...this.running(), ...this.starting.keys(), ...this.waiting()].map(ticketId => this.partition(ticketId)))
    let room = 0
    for (const key of keys) room += Math.max(0, this.max() - this.idsIn(key, false).size)
    return keys.size ? room : this.max()
  }
  /**
   * Reserves a startup slot for `ticketId` in its delivery environment; idempotent if it already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()` in that environment.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.usedIn(this.partition(ticketId)) >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** The workspace each launched ticket runs in, by ticket, so a placement can see its peers. Recomputed on every launch. */
  private readonly placements = new Map<string, string>()
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  private readonly resuming = new Set<string>()
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  /** When the last state reprojection ran, so the pass's every-two-second schedule does not rescan the board each time. */
  private lastReproject = 0
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers,
      // Each repository or depot runs its own workers, and an open ticket that is still queued reserves its environment's capacity.
      ticketId => deliveryKey(host.store.settings(), this.host.repository, host.store.tickets.get(ticketId)),
      () => host.store.tickets.open().map(ticket => ticket.id))
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const settings = this.host.store.settings()
    // The accept may name the delivery target its work belongs to; otherwise the Source, then the deployment's configured
    // backend, decides. A ticket is never left to a person to route: the target is one of the installation's configured ones.
    const delivery = resolveDelivery({ settings, repository: this.host.repository, source: sourceTrigger(this.host, ticket)?.source,
      target: outcome.target })
    const prepared = { ...ticket, execution: ticketExecution(ticket, outcome, settings, this.host.machine.stateDir, delivery.backend, delivery.target) }
    // The p4 pipeline gates code changes behind the P1 plan: its tickets start in the plan phase (docs/012). The GitHub path
    // keeps the phases it had, so an upgrade does not change how its workers report.
    return delivery.backend === 'p4' ? { ...prepared, phase: 'plan' as const } : prepared
  }
  /**
   * Rebuilds the Execution of a ticket a person moved to another delivery environment: its assignment keeps what the accept
   * wrote and drops the instructions of the environment it left, so its next launch composes the new one's, and its target
   * becomes that environment's configured one.
   */
  rePrepare(ticket: Ticket, backend: Backend, target?: string): Execution {
    const settings = this.host.store.settings()
    const resolved = (target?.trim() || (backend === 'git' ? this.host.repository : settings.executor.p4.depot)).trim()
    const execution = ticket.execution ?? { name: '', directory: '', assignment: '' }
    const next: Execution = { ...execution, assignment: baseAssignment(execution.assignment), backend }
    if (resolved) next.target = resolved
    else delete next.target
    return next
  }
  /**
   * Runs the configured `executor.prepare` command for a new workspace in its parent directory with the ticket's execution
   * environment variables, then verifies the directory as the worker sees it.
   * A pooled workspace prepares once, for the workspace rather than the ticket: its p4 client is named after the workspace and
   * rooted at its directory, so every ticket placed in it shares that one client and its own changelist only.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private async prepareDirectory(ticket: Ticket, directory = ticket.execution?.directory ?? '', pooled?: Workspace): Promise<void> {
    await mkdir(dirname(directory), { recursive: true })
    const settings = this.host.store.settings()
    // A custom prepare command always wins; under the p4 backend an empty one means "make the workspace a Perforce one",
    // which only applies to a pooled workspace. A Ticket outside the pool has no p4 client, so it just gets its directory.
    const command = settings.executor.prepare.trim() || (this.backendOf(ticket) === 'p4' && pooled ? p4Prepare() : '')
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    if (pooled) Object.assign(env, { DSH_SUPERAGENT_DIR: directory,
      DSH_SUPERAGENT_P4_CLIENT: workspaceClient(pooled, settings.executor.p4.clientTemplate) })
    // The prepare command runs through `sh`, which reads a backslash path as an escape, not as a directory separator.
    if (process.platform === 'win32' && env.DSH_SUPERAGENT_DIR) env.DSH_SUPERAGENT_DIR = env.DSH_SUPERAGENT_DIR.replaceAll('\\', '/')
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** The worker load the idle judgement reads: slots in use across running workers and launch reservations, and the limit. */
  load(): { running: number; max: number } {
    return { running: this.slots.used(), max: this.host.store.settings().executor.maxWorkers }
  }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    // A P2/P3 ticket waits for an idle window instead of competing with the mainline (see `core/idle.ts`): the launch is
    // held, not failed, and retries until the five signals break its way or a person moves it to P0/P1.
    const admission = this.host.idleAdmission?.(ticket, this.load())
    if (admission && !admission.admitted) throw new Later(`Waiting for an idle window: ${admission.reason}`)
    this.slots.reserve(ticketId, 'launch')
    try {
      // Record which depth let the ticket start, so the idle pool's daily budget and the board can say why it ran now.
      if (admission?.level) this.host.engine.idleLaunch(ticketId, admission.level)
      await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`)
    }
    catch (error) {
      // Shutdown or pause re-queues the launch for resume, and transient network/provider errors retry with backoff.
      // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
      // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
      // ticket is marked failed and waits until new human input or an explicit retry arrives.
      if (this.host.closing() || error instanceof Later) throw error
      // A worker whose profile no longer resolves the tools it needs is a defect for a person, not a passing failure:
      // report it blocked at the first message instead of starting a worker that silently cannot work.
      if (error instanceof MissingWorkerTools) { this.launchBlocked(ticketId, assignmentId, error.message); return }
      // A Session the host could not open even after the bounded reopen is a corrupt-store failure: `retries` refuses it
      // (see `corruptSession`) and `launchFailed` reports it with the repair hint, never retrying it without limit.
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work ends with a cancel, which would drop what is delivered meanwhile.
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // Recreate the worker session if it was externally deleted.
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          // A corrupt stored Session never accepts the Input: stop delivering to it and leave the Ticket, with the repair
          // hint, to a person instead of retrying the delivery forever.
          if (corruptSession(error)) { this.failed(ticketId, String(error)); return }
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // Its shell jobs and subagents stop with it, also those of a worker that ends its own turn.
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox))
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
   * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
   */
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Marks a ticket blocked after a launch found a defect a person must fix, and relays the reason to the main Session. */
  private launchBlocked(ticketId: string, assignmentId: string, summary: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.blocked(ticketId, summary)
  }
  /** Records a `blocked` report on the ticket and relays it to the main Session in one transaction. */
  private blocked(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'blocked', summary })
      this.relay(resultRelay(updated, 'blocked', summary))
    })
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    // A corrupt stored Session never heals on its own: its report names the fix, and neither the host nor the main Session
    // should retry it (the Watchdog's `transient` already refuses to).
    const text = corruptSession(summary) && !summary.includes('does not retry this automatically')
      ? `${summary} The stored Session is corrupt; a person must remove its session log or use a fresh Session id. `
        + 'The host does not retry this automatically.'
      : summary
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary: text })
      this.relay(resultRelay(updated, 'failed', text))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  /**
   * Where a ticket's worker runs, who else runs there, and — under the p4 backend — the one client that workspace owns.
   * Without a task-center pool that is the ticket's own directory and no peers; with one, the first workspace that has a free
   * slot and no running lease overlapping this ticket's lease (see 011 Task center), and the peers already working in it.
   * A pooled ticket works directly in the workspace's tree, not in a subdirectory of it, because that tree is the p4 client
   * root its peers share; what keeps them apart is the lease and their own changelists. A ticket that named no paths never
   * enters the pool and keeps its own directory, so an analysis ticket neither holds the tree nor waits for it.
   * @throws Later when every free slot conflicts, which re-queues the launch until a peer delivers or stops.
   */
  private placeWorkspace(ticket: Ticket, fallback: string): { directory: string; workspace?: Workspace; peers: Peer[] } {
    const pool = this.host.store.settings().executor.workspaces
    if (!pool.length) return { directory: fallback, peers: [] }
    const lease = ticket.execution?.lease ?? []
    // A Ticket that named no paths is read-only toward the shared tree: it runs in its own directory, so it never waits
    // for a workspace slot and never makes a code Ticket wait for it (011 Task center).
    if (!claimsWorkspace(lease)) return { directory: fallback, peers: [] }
    // A peer holds its lease while an assignment runs, from the placement until delivery ends it, so a ticket that is still
    // starting is seen as a peer and two launches cannot claim one slot of a one-slot workspace at the same time.
    const active: Active[] = this.host.store.tickets.open()
      .filter(other => other.id !== ticket.id && this.placements.has(other.id) && runningAssignment(other))
      .map(other => ({ workspace: this.placements.get(other.id)!, lease: other.execution?.lease ?? [] }))
    const chosen = place(pool, active, lease)
    if (!chosen) {
      const waiting = conflicts(active, lease).length
      throw new Later(waiting ? `Waiting for ${waiting} ticket(s) writing the same paths` : 'Waiting for a free workspace slot')
    }
    this.placements.set(ticket.id, chosen.id)
    const peers = this.host.store.tickets.open()
      .filter(other => other.id !== ticket.id && this.placements.get(other.id) === chosen.id && runningAssignment(other))
      .map(other => ({ ticket_id: other.id, title: other.title, lease: other.execution?.lease ?? [] }))
    return { directory: chosen.directory, workspace: chosen, peers }
  }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const { directory: workspace, workspace: pooled, peers } = this.placeWorkspace(ticket, ticket.execution?.directory ?? '')
    if (!current()) return
    // Prepare the workspace directory once; an existing directory counts as already prepared, including worktrees created before `prepare` commands existed.
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket, workspace, pooled)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // Sessions decorates a Session when DSH creates it, and another listener may have done it first: re-check the tool
    // face here so a worker never starts with none of the tools it needs, whatever order the listeners ran in.
    const gap = this.host.sessions.workerToolGap(agent)
    if (gap.length) throw new MissingWorkerTools(gap)
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // A message put back for this Assignment may still wait in the Session, kept by a restart's cancel or persisted across a
    // crash, where this launch's message would take it into a step beside the copy delivered next: that copy is the only one.
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const previous = ticket.assignments.at(-2)?.endedReason
    const retried = previous === 'retried' ? { note: RETRIED } : previous === 'recovered' ? { note: RECOVERED } : {}
    const assignmentText = (ticket.execution?.assignment ?? '') + deliveryInstructions(this.backendOf(ticket))
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...(peers.length ? { peers } : {}), ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...(peers.length ? { peers } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** The delivery environment a ticket's work belongs in: what its execution recorded, else the deployment's configured backend. */
  private backendOf(ticket: Ticket): Backend { return ticket.execution?.backend ?? this.host.store.settings().executor.backend }
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // A person's message typed into a worker's Session, which the ticket does not record.
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // The Inputs a message of dsh-superagent's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /**
   * Repairs provable state inconsistencies on open tickets (I4, see `reprojectable`): a running Assignment with no live
   * worker, a pending one whose launch effect is gone, or waiting Inputs whose delivery effect is gone. Called by each pass,
   * throttled, and never on a state a worker reported. Each repair is recorded on the ticket as the system's trace; the main
   * Session is not woken for a state the system handled itself.
   */
  reproject(now = Date.now()): void {
    if (this.host.closing() || this.host.paused()) return
    if (now - this.lastReproject < REPROJECT_INTERVAL_MS) return
    this.lastReproject = now
    for (const ticket of this.host.store.tickets.open()) {
      const decision = reprojectable(ticket, { active: id => this.workerActive(id), launching: id => this.host.effects.pending('launch', id),
        delivering: id => this.host.effects.pending('delivery', id) }, now)
      if (!decision) continue
      if (decision.action === 'blocked') { this.blocked(ticket.id, decision.reason); continue }
      // A restart is the core's own repair and keeps the worker Session and its history; the other two re-queue a lost effect,
      // after which the effect queue takes over again.
      if (decision.action === 'restart') { this.host.engine.repairAssignment(ticket.id, decision.assignment.id); continue }
      const repair: Omit<TicketRepair, 'at'> = { invariant: decision.invariant, action: decision.action,
        assignment: decision.assignment.id, detail: decision.detail }
      this.host.engine.repaired(ticket.id, repair)
      if (decision.action === 'relaunch') this.start(ticket, decision.assignment)
      else this.deliver(ticket, decision.assignment)
    }
  }
  /** Whether a ticket's worker Session is loaded and still runs its turn or the background work of its turn. */
  private workerActive(ticketId: string): boolean {
    const agent = this.host.context.agents.get(workerSessionId(ticketId) as SessionId)
    return agent !== undefined && (agent.status === 'running' || this.settling.has(ticketId))
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<void>): Promise<void> {    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // Wait while processing is paused or no wake slot is free.
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(idle.id)
    // The ticket while the Assignment that went idle runs it.
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this idle, and until the worker runs again or the Assignment ends.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
      // wake it, go on.
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
