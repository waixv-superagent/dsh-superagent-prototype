/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TicketKind } from '../core/kind.ts'
import type { PlanDecision } from '../core/plan.ts'
import type { PriorityLevel } from '../core/priority.ts'
import type { ActivityView } from './activity.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { EditorPageView } from './views/editor.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketGraphView } from './views/graph.ts'
import type { ReproPageView } from './views/repro.ts'
import type { BuildPageView } from './views/build.ts'
import type { TicketListView, TicketSearchView } from './views/tickets.ts'
import type { UpgradeRun, UpgradeView } from './upgrade.ts'

export const TICKET_FILTERS = ['open', 'person', 'verify', 'unverified', 'working', 'idle', 'pipeline', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  /** Who holds the editor and for what, the queue and the host-run jobs, ue-mcp's view, the working Tickets, and what waits on a person. */
  'GET editor': { response: EditorPageView }
  /** A person claims or yields the shared editor, asks its holder to yield, reorders or drops a wait, or stops a job. */
  'POST editor/act': { body: { action: 'claim' | 'release' | 'yield' } | { action: 'preempt'; reason?: string }
    | { action: 'front' | 'cancel' | 'cancel-job'; id: string }; response: { done: true } }
  /** The local reproduction cases: what the directory holds, how the recent runs ended, and what holds the editor. */
  'GET repro': { response: ReproPageView }
  /** The person's compile-and-launch targets and their recent runs, for the editor page. */
  'GET build': { response: BuildPageView }
  /** A person runs one configured target (compile + launch) under the shared editor's slot. */
  'POST build/run': { body: { target: string }; response: { started: true } }
  /** A person stops the build-and-launch in flight. */
  'POST build/stop': { body: { run: string }; response: { stopped: true } }
  /** A person runs one local case; it starts as a host process against the editor that is already open. */
  'POST repro/run': { body: { case: string }; response: { started: true } }
  /** A person stops the local case that is running. */
  'POST repro/stop': { body: { run: string }; response: { stopped: true } }
  /** The last output of one run, for the page's output panel: bounded by the host, never a whole log. */
  'GET repro/log': { query: { run: string }; response: { text: string } }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  /** A person submits a request from the panel; it becomes a Web Source Trigger the main Session assesses, and its Thread is the request's own. */
  'POST requests': { body: { text: string }; response: { trigger_id: string; thread: string; state: 'stored' | 'duplicate' } }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  /** Sends a waiting Channel message again now, such as one held after its CLI refused it. */
  'POST outbox/:id/retry': { response: { retried: true } }
  /** Withdraws a waiting Channel message, so it is never sent. */
  'POST outbox/:id/withdraw': { response: { withdrawn: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter; kind?: TicketKind }; response: TicketListView }
  /** Ticket-first search for the Overview box, ordered by match strength rather than recency alone. */
  'GET tickets/search': { query: { q: string; limit?: number }; response: TicketSearchView }
  /** Every recent Ticket and how they relate, derived and recorded, for the overview's relation view; read-only. */
  'GET tickets/graph': { response: TicketGraphView }
  'GET tickets/:id': { response: TicketPageView }
  /** Live execution activity of the ticket's worker; the panel polls the summary collapsed and the reasoning text expanded. */
  'GET tickets/:id/activity': { response: ActivityView }
  'POST tickets/:id/retry': { response: { retried: true } }
  /** A person moves a ticket's work to another delivery environment; its stalled assignment ends and a new one starts there. */
  'POST tickets/:id/redispatch': { body: { backend: 'git' | 'p4'; target?: string }; response: { redispatched: true } }
  /** A person answers the waiting P1 plan from the ticket page, with no chat round-trip. */
  'POST tickets/:id/plan': { body: { decision: PlanDecision; note?: string }; response: { decided: true } }
  /** A person lifts a ticket out of the idle pool into the attention pool and starts its work; only a mainline level. */
  'POST tickets/:id/promote': { body: { level?: 'P0' | 'P1' }; response: { level: PriorityLevel } }
  /** A person sets a ticket's level without starting work: dropping a pooled Ticket on P2/P3 only parks it. */
  'POST tickets/:id/priority': { body: { level: PriorityLevel }; response: { level: PriorityLevel } }
  /** A person answers the ticket's open question from its page: one of its choices, or a written answer, and the worker continues. */
  'POST tickets/:id/answer': { body: { attentionId: string; option?: string; text?: string }; response: { answered: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  /** A person confirms a delivered ticket; running the submit stays theirs. */
  'POST tickets/:id/confirm': { response: { confirmed: true } }
  /** A person's local check of delivered work passed; an open ticket ends as completed by a person. */
  'POST tickets/:id/verify': { response: { verified: true } }
  /** A follow-up observation: `merged` completes the ticket, `blocked` puts it at the top of the pipeline lane for a person. */
  'POST tickets/:id/pipeline': { body: { state: 'running' | 'blocked' | 'merged'; url?: string; reason?: string; manual?: boolean;
    check?: string }; response: { updated: true; completed: boolean } }
  /** A person clears a pipeline blocker and starts the follow-up again. */
  'POST tickets/:id/pipeline/check': { response: { resumed: true } }
  /** A person's local check failed: the ticket returns to implement with their note as the next Input. */
  'POST tickets/:id/rework': { body: { note?: string }; response: { reworking: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  /** The installed build against the fork's branch, and the steps of a running or the last update. */
  'GET upgrade': { response: UpgradeView }
  /** Fetch the branch now instead of at the next interval. */
  'POST upgrade/check': { response: UpgradeView }
  /** Start the one-click update; `force` does not wait for running workers. */
  'POST upgrade': { body: { force?: boolean }; response: UpgradeRun }
  /** Give up an update that has not reached the switch. */
  'POST upgrade/cancel': { response: { cancelled: boolean } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
