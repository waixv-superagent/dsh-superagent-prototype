/** Typed panel routes, route parser, and sessionStorage location history. */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import { TICKET_KINDS, type TicketKind } from '../core/kind.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

export const TABS = ['editor', 'source', 'trigger', 'eval', 'execution', 'settings'] as const
export type Tab = typeof TABS[number]
export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
/** The two views the 概览 tab switches between: the editor page and the duty-desk board. */
export const HOME_VIEWS = ['editor', 'board'] as const
export type HomeView = typeof HOME_VIEWS[number]
/**
 * The editor hero counts that open the board at the Tickets behind them. A one-shot arrival cue, not a board filter:
 * the board rings the matching cards once and then drops it, so the same board stays usable by hand afterwards.
 */
export const BOARD_FOCUS = ['working', 'queued', 'verification', 'person'] as const
export type BoardFocus = typeof BOARD_FOCUS[number]
export type Route = { page: 'editor'; id?: undefined; query?: { view?: HomeView; focus?: BoardFocus } }
  | { page: 'source'; id?: undefined; query?: undefined }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter; kind?: TicketKind } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }
export const HOME: Route = { page: 'editor' }
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized query filters or removed tabs (such as the legacy `policy` tab). */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    // The old top-level Agent-status tab is now the board view of 概览; a stored route opens the same board.
    case 'overview': return { page: 'editor', query: { view: 'board' } }
    case 'editor': return { page, query: compact({ view: pick(HOME_VIEWS, query?.view), focus: pick(BOARD_FOCUS, query?.focus) }) }
    case 'source': return { page }
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    case 'eval': return { page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter),
      kind: pick(TICKET_KINDS, query?.kind) }) }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version') }) } }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
/**
 * `?view=board` (or the legacy `?page=overview`) opens the duty-desk board directly, as the Feishu status card links to it;
 * `?ticket=<id>` opens that ticket's page, as each bot message a ticket sends in Feishu links back to it.
 */
function linkedRoute(): Route | undefined {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  const ticket = params.get('ticket')?.trim()
  if (ticket && /^[0-9a-f]{32}$/i.test(ticket)) return { page: 'execution', id: ticket.toLowerCase() }
  if (params.get('view') === 'board' || params.get('page') === 'overview') return { page: 'editor', query: { view: 'board' } }
  return undefined
}
export function initialLocation(): Location {
  const linked = linkedRoute()
  if (linked) return { route: linked, stack: [] }
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
