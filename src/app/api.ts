/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PlanDecision } from '../core/plan.ts'
import type { ActivityView } from './activity.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { EditorPageView } from './views/editor.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView, TicketSearchView } from './views/tickets.ts'

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
  /** Who holds the editor, which Tickets are working with their live tool, and what waits on a person; read-only. */
  'GET editor': { response: EditorPageView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
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
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  /** Ticket-first search for the Overview box, ordered by match strength rather than recency alone. */
  'GET tickets/search': { query: { q: string; limit?: number }; response: TicketSearchView }
  'GET tickets/:id': { response: TicketPageView }
  /** Live execution activity of the ticket's worker; the panel polls the summary collapsed and the reasoning text expanded. */
  'GET tickets/:id/activity': { response: ActivityView }
  'POST tickets/:id/retry': { response: { retried: true } }
  /** A person moves a ticket's work to another delivery environment; its stalled assignment ends and a new one starts there. */
  'POST tickets/:id/redispatch': { body: { backend: 'git' | 'p4'; target?: string }; response: { redispatched: true } }
  /** A person answers the waiting P1 plan from the ticket page, with no chat round-trip. */
  'POST tickets/:id/plan': { body: { decision: PlanDecision; note?: string }; response: { decided: true } }
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
