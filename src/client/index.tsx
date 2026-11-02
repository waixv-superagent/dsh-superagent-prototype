/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { type ReactElement, useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import { Icon } from './controls.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'
import TICKET_LINK_STYLES from './ticket-link.css?raw'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'
const ROUTE_KEY = 'dsh-superagent/route'
const TICKET_LINK_STYLE_ID = 'dsh-superagent-ticket-link'

/** The header action renders outside the panel, where provider.tsx injects the panel stylesheet, so inject its own style once. */
function ensureTicketLinkStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(TICKET_LINK_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = TICKET_LINK_STYLE_ID
  style.textContent = TICKET_LINK_STYLES
  document.head.append(style)
}
ensureTicketLinkStyles()

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} openSession={openSession} deploymentForm={form} />
}

/** Shows the Ticket of a worker Session in the panel; the panel reads its route from sessionStorage when it mounts. */
function openTicket(ctx: ClientContext, ticketId: string): void {
  try {
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ route: { page: 'execution', id: ticketId }, stack: [] }))
  } catch (failure) { void failure /* Route memory is a convenience. */ }
  ctx.layout.selectPanel(PANEL_ID)
}

/** The Ticket id a worker Session executes, or undefined for any other Session. */
const ticketOf = (sessionId: SessionId): string | undefined =>
  String(sessionId).startsWith('worker-') ? String(sessionId).slice('worker-'.length) : undefined

/** Header action on a worker Session: jump to the Ticket that Session executes. */
function TicketLink({ ctx, sessionId, t }: { ctx: ClientContext; sessionId: SessionId; t: T }) {
  const ticketId = ticketOf(sessionId)
  if (!ticketId) return null
  return <button type="button" className="dt-header-ticket" title={t('ticketLinkHint')} onClick={() => openTicket(ctx, ticketId)}>
    <Icon name="review" size={14} />{t('ticketLink')}
  </button>
}

/** Sidebar row marker on a worker Session: the same jump, reachable from the Session list. */
function TicketMarker({ ctx, sessionId, t }: { ctx: ClientContext; sessionId: SessionId; t: T }) {
  const ticketId = ticketOf(sessionId)
  if (!ticketId) return null
  return (
    <span role="button" tabIndex={0} title={t('ticketLinkHint')} style={{ cursor: 'pointer' }}
      onClick={event => { event.stopPropagation(); openTicket(ctx, ticketId) }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); openTicket(ctx, ticketId) } }}>🛠️</span>
  )
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'layout']
/** Registers the panel, sidebar icon, worker-Session ticket link, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: `${ENTRY}:ticket`, order: 40, locale: NS,
  }, (props: { sessionId: SessionId; t: T }) => <TicketMarker ctx={ctx} sessionId={props.sessionId} t={props.t} />))
  // The Conversation package is not a dependency of this checkout, so its slot names are absent from the typed map.
  const slots = ctx.slots as unknown as {
    inject: (name: string, register: () => () => void) => void
    register: (options: Record<string, unknown>, component: (props: { sessionId: SessionId; t: T }) => ReactElement | null) => () => void
  }
  slots.inject('conversation.session.header.actions', () => slots.register({
    name: 'conversation.session.header.actions', id: `${ENTRY}:ticket`, order: 40, locale: NS,
  }, (props: { sessionId: SessionId; t: T }) => <TicketLink ctx={ctx} sessionId={props.sessionId} t={props.t} />))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
