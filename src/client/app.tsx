/** Root panel shell: header with global search and glossary, top-level navigation tabs, and active route view. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { SearchView } from './api.ts'
import { Button, Dot, Icon, Input, Modal, Pill, SegmentedControl, SegmentedTabs } from './controls.tsx'
import type { DeploymentForm } from './deployment.tsx'
import { EditorPage } from './editor.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { ticketMark } from './marks.ts'
import { GLOSSARY, GLOSSARY_VALUES, en, zh, type DshSuperagentKey } from './locales.ts'
import { OverviewPage } from './overview.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { HOME, TABS, initialLocation, lastSettingsGroup, remember, routeLabel, settingsRoute, type BoardFocus, type HomeView,
  type Location, type Route, type Tab } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { SourceStatus } from './source.tsx'
import { actorName, errorText, reasonLabel, valueLabel, type T, readableMarkers } from './text.ts'
import { ThreadPage } from './thread.tsx'
import { TicketPage } from './ticket.tsx'
import { TriggerStatus } from './trigger.tsx'
import { When } from './widgets.tsx'

export interface AppProps {
  t: T; openSession: (sessionId: string) => Promise<void>
  deploymentForm: DeploymentForm
}

function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = usePanel()
  const chinese = t('tab.editor') === zh['tab.editor']
  const [own, other] = chinese ? [zh, en] : [en, zh]
  const heading = (group: keyof typeof GLOSSARY) => t(group === 'roles' ? 'glossaryGroup.roles' : `tab.${group}`)
  return <Modal className="dt-glossary-modal" open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')}
    description={t('glossaryIntro')} footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
    <div className="dt-glossary-body">
      <table className="dt-glossary">
        <thead><tr>
          <th>{t(chinese ? 'glossaryChinese' : 'glossaryEnglish')}</th><th>{t(chinese ? 'glossaryEnglish' : 'glossaryChinese')}</th>
          <th>{t('glossaryMeaning')}</th>
        </tr></thead>
        {Object.entries(GLOSSARY).map(([group, keys]) => <tbody key={group}>
          <tr><th colSpan={3} scope="rowgroup" className="dt-glossary-group">{heading(group as keyof typeof GLOSSARY)}</th></tr>
          {keys.map(key => <tr key={key}><td>{own[`term.${key}`]}</td><td>{other[`term.${key}`]}</td><td>{own[`meaning.${key}`]}</td></tr>)}
        </tbody>)}
      </table>
      <p className="dt-legend-title">{t('legendTitle')}</p>
      <ul className="dt-legend">{(['done', 'ongoing', 'warning', 'error', 'idle'] as const).map(state => <li key={state}>
        <Dot state={state} /><span>{t(`legend.${state}`)}</span>
      </li>)}</ul>
      <dl className="dt-values">{Object.entries(GLOSSARY_VALUES).map(([group, values]) => <div key={group} style={{ display: 'contents' }}>
        <dt>{own[`term.${group}` as DshSuperagentKey]}</dt>
        <dd>{values.map(key => `${own[key]} ${other[key]}`).join(' · ')}</dd>
      </div>)}</dl>
    </div>
  </Modal>
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (index < 0) return <>{text}</>
  return <>{text.slice(0, index)}<mark className="dt-mark">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
function Result({ name, open, children }: { name: ReactNode; open: (() => void) | undefined; children: ReactNode }) {
  return <li className="dt-row dt-link"><div className="dt-row-main">
    <div className="dt-row-title">{open ? <button type="button" className="dt-open" onClick={open}>{name}</button> : name}</div>
    <div className="dt-row-meta">{children}</div>
  </div></li>
}
const SEARCH_FILTERS = ['all', 'tickets', 'threads', 'triggers'] as const
type SearchFilter = typeof SEARCH_FILTERS[number]
/** How long typing settles before the header searches; Enter submits at once. */
const SEARCH_DEBOUNCE_MS = 250
/** A result's kind and Source together, so a row says both what it is and where it came from. */
function ResultKind({ kind, source }: { kind: string; source?: string }) {
  const { t } = usePanel()
  return <span>{[kind, valueLabel(t, 'source', source)].filter(Boolean).join(' · ')}</span>
}
function SearchResults({ result, query, filter, onFilter, onClose }: {
  result: SearchView; query: string; filter: SearchFilter; onFilter: (filter: SearchFilter) => void; onClose: () => void
}) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const tickets = filter === 'all' || filter === 'tickets' ? result.tickets : []
  const threads = filter === 'all' || filter === 'threads' ? result.threads : []
  const items = filter === 'all' || filter === 'triggers' ? result.items : []
  const any = result.items.length > 0 || result.threads.length > 0 || result.tickets.length > 0
  // A filter that hides every hit keeps its pills visible, so a person can switch back instead of retyping.
  const shown = tickets.length + threads.length + items.length
  const counts = { tickets: result.tickets.length, threads: result.threads.length, items: result.items.length }
  const go = (route: Route) => () => { onClose(); navigate(route) }
  return <div className="dt-search-results" role="region" aria-label={t('searchLabel')}>
    <div className="dt-search-head">
      <span className="dt-hint">{any ? t(result.items.length >= 20 ? 'searchFoundCapped' : 'searchFound', counts)
        : t(setup?.accounts?.feishu ? 'searchNone' : 'searchNoneGithub')}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')} onClick={onClose} />
    </div>
    {any && <div className="dt-filters dt-search-filters" role="group" aria-label={t('searchFilterLabel')}>
      {SEARCH_FILTERS.map(value => <Pill key={value} active={filter === value} onClick={() => onFilter(value)}>
        {t(`searchFilter.${value}`)}
      </Pill>)}
    </div>}
    {any && (shown === 0 ? <p className="dt-hint">{t('searchFilterNone')}</p> : <ul className="dt-list">
      {tickets.map(ticket => <Result key={ticket.id} name={<Highlight text={ticket.title} query={query} />}
        open={go({ page: 'execution', id: ticket.id })}>
        <ResultKind kind={t('term.ticket')} source={ticket.source} />
        <span>{ticket.stage === 'ended' ? t('ticket.ended') : ticketMark(t, ticket).label}</span>
      </Result>)}
      {threads.map(thread => <Result key={thread.key} name={readableMarkers(t, thread.title)} open={go({ page: 'trigger',
        id: thread.key })}>
        <ResultKind kind={t('term.thread')} source={thread.source} />
      </Result>)}
      {/* Filtered triggers have no Thread and display their filter reason instead of a link. */}
      {items.map(item => <Result key={item.id} name={<Highlight text={readableMarkers(t, item.preview) || t('empty')}
        query={query} />}
        open={item.filtered === undefined ? go({ page: 'trigger', id: item.threads[0]!, query: { trigger: item.id } }) : undefined}>
        <ResultKind kind={t('term.trigger')} source={item.source} />
        <span>{actorName(t, item.actor)}</span><When at={item.at} />
        {item.threadTitle && <span className="dt-ellipsis">{t('inThread', { thread: readableMarkers(t, item.threadTitle) })}</span>}
        {item.filtered !== undefined && <span>{t('searchFiltered', { reason: reasonLabel(t, item.filtered) })}</span>}
      </Result>)}
    </ul>)}
  </div>
}

function Header({ masterId }: { masterId: string | undefined }) {
  const { t, call, openSession, notify } = usePanel()
  const [glossary, setGlossary] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchFilter>('all')
  const [result, setResult] = useState<{ query: string; value: SearchView }>()
  // Ignore responses from superseded or cleared search requests.
  const latest = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const close = useCallback(() => { latest.current++; window.clearTimeout(timer.current); setResult(undefined) }, [])
  const search = useCallback((text: string) => {
    const request = ++latest.current
    call('GET search', { query: { q: text } }).then(value => { if (request === latest.current) setResult({ query: text, value }) },
      failure => { if (request === latest.current) notify(errorText(failure)) })
  }, [call, notify])
  // Results follow the query once typing settles; Enter below searches at once instead of waiting.
  useEffect(() => {
    const text = query.trim()
    latest.current++
    window.clearTimeout(timer.current)
    if (!text) { setResult(undefined); return }
    timer.current = window.setTimeout(() => search(text), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer.current)
  }, [query, search])
  const searchForm = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!result) return
    const outside = (event: PointerEvent) => { if (!searchForm.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside) }
  }, [result, close])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    window.clearTimeout(timer.current)
    if (!text) { close(); return }
    search(text)
  }
  return <header className="dt-head">
    <div className="dt-head-title"><h1 className="dt-title">{t('title')}</h1></div>
    <div className="dt-toolbar">
      <form ref={searchForm} className="dt-search" role="search" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') close() }}>
        <Input type="search" icon={<Icon name="search" />} value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) close() }} />
        {result && <SearchResults result={result.value} query={result.query} filter={filter} onFilter={setFilter} onClose={close} />}
      </form>
      <Button variant="ghost" size="sm" icon={<Icon name="question" />} aria-label={t('glossary')} title={t('glossary')} aria-haspopup="dialog"
        onClick={() => setGlossary(true)} />
      <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={!masterId}
        onClick={() => { if (masterId) openSession(masterId).catch(failure => notify(errorText(failure))) }}>{t('openMaster')}</Button>
    </div>
    <Glossary open={glossary} onClose={() => setGlossary(false)} />
  </header>
}

/** 概览 owns two views: the board (the default, since the duty desk is what a person opens most) and the editor page. */
function HomePage({ view, focus }: { view?: HomeView; focus?: BoardFocus }) {
  const { t, navigate } = usePanel()
  const board = view !== 'editor'
  return <>
    <div className="dt-home-switch">
      <SegmentedControl options={[{ value: 'editor', label: t('homeViewEditor') },
        { value: 'board', label: t('homeViewBoard') }]} value={board ? 'board' : 'editor'} label={t('homeViewLabel')}
        onChange={next => navigate(next === 'board' ? { page: 'editor' } : { page: 'editor', query: { view: 'editor' } })} />
    </div>
    {board ? <OverviewPage focus={focus} /> : <EditorPage />}
  </>
}

function Pages({ route, openTab, deploymentForm }: { route: Route; openTab: (tab: Tab) => void; deploymentForm: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error, reload } = usePanelData()
  // Keep the active tab scrolled into view on narrow screens when routes change via links.
  useEffect(() => { document.getElementById(`dt-tab-${route.page}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [route.page])
  const waiting = error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>
  const page = (() => {
    switch (route.page) {
      case 'editor': return <HomePage view={route.query?.view} focus={route.query?.focus} />
      case 'source': return <SourceStatus />
      case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
        : <TriggerStatus filter={route.query?.filter ?? 'subscribed'} />
      case 'eval': return <EvalStatus filter={route.query?.filter ?? 'work'} window={route.query?.window}
        paused={!!state?.paused} />
      case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
        : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} kind={route.query?.kind} state={state} reload={reload} /> : waiting
      case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query} state={state}
        deploymentForm={deploymentForm} /> : waiting
    }
  })()
  return <div className="dt-page">
    <div className="dt-column">
      <Header masterId={state?.masterId} />
      {error && state && <p className="dt-error" role="status">{error.message}</p>}
      <SegmentedTabs className="dt-tabs" label={t('pagesLabel')} value={route.page} onChange={openTab}
        items={TABS.map(value => ({ value, label: t(`tab.${value}`), id: `dt-tab-${value}`, panelId: 'dt-page' }))} />
      <main id="dt-page" role="tabpanel" aria-labelledby={`dt-tab-${route.page}`} className="dt-main">{page}</main>
    </div>
  </div>
}

/** Root panel component managing route history and shared panel state. */
export function App({ t, openSession, deploymentForm }: AppProps) {
  const [location, setLocation] = useState(initialLocation)
  useEffect(() => { remember(location) }, [location])
  // Preserve the last opened settings group across navigation so the Settings tab reopens at it.
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  /** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
  const navigate = useCallback((route: Route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  const back = useCallback(() => move(current => ({ route: current.stack.at(-1) ?? HOME, stack: current.stack.slice(0, -1) })), [move])
  const openTab = useCallback((tab: Tab) => move(current => ({ stack: [], route: tab === 'settings'
    ? settingsRoute(lastSettingsGroup(current)) : { page: tab, id: undefined } })), [move])
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} backLabel={routeLabel(t, location.stack.at(-1) ?? HOME)}>
    <Pages route={location.route} openTab={openTab} deploymentForm={deploymentForm} />
  </PanelProvider>
}
