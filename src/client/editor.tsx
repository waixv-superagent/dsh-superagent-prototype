/**
 * Editor page: who holds the Unreal Editor, which Tickets are working with their live tool, and what waits on a person.
 * It only reports facts the host already holds; it never starts, stops or hands over the editor.
 */
import { useState } from 'react'
import { usePoll, type EditorPageView, type EditorRow, type EditorTicketRow, type EditorTimelineBand,
  type EditorTimelineRow, type EditorTimelineView, type TicketRow } from './api.ts'
import { Button, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import type { BoardFocus, Route } from './route.ts'
import type { T } from './text.ts'
import { LoadState, When } from './widgets.tsx'

/** A working Ticket without an update for this long reads as possibly stuck, as on the overview. */
const STUCK_MS = 10 * 60_000
/** MCP registers its tools as `mcp__<server>__<tool>`; the panel shows the server, which is what a person recognises. */
const MCP_NAME = /^mcp__(.+?)__(.+)$/
const ticketRoute = (id: string): Route => ({ page: 'execution', id })
const shortId = (id: string) => `#${id.slice(0, 8)}`
const minutesSince = (at: number) => Math.max(1, Math.round((Date.now() - at) / 60_000))
/** A short duration for the running tool. */
const seconds = (ms: number): string => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round(ms % 60_000 / 1000)}s`

/** The tool a person reads: an MCP call names its server and raw tool; a built-in keeps its name. */
function toolName(t: T, name: string): string {
  const match = MCP_NAME.exec(name)
  return match ? t('editorToolMcp', { server: match[1]!, tool: match[2]! }) : name
}

/** "22:30" in the viewer's own clock. */
function clock(at: string | null): string {
  if (!at) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function holderPhrase(t: T, editor: EditorRow | null): string {
  if (!editor) return t('editorReading')
  switch (editor.holder) {
    case 'person': return t('editorYouUsing')
    case 'agent': return t('editorAgentUsing')
    case 'build': return t('editorBuildUsing')
    case 'none': return editor.activity === 'building' ? t('editorFreeBuilding') : t('editorFree')
    default: return t('editorHolderUnknown')
  }
}

/** One hero count: a door to the board lane behind it, or plain text when that lane has nothing to show. */
function CountItem({ count, focus, tone, label }: { count: number; focus: BoardFocus
  tone?: 'live' | 'verify' | 'decide'; label: string }) {
  const { t, navigate } = usePanel()
  return count > 0
    ? <button type="button" className="dt-editor-count" data-count={focus} data-tone={tone} title={t('editorCountJump')}
      onClick={() => navigate({ page: 'editor', query: { view: 'board', focus } })}>{label}</button>
    : <span data-count={focus} data-tone={tone}>{label}</span>
}

function Hero({ data }: { data: EditorPageView }) {
  const { t } = usePanel()
  const { editor, build, counts, executor } = data
  const running = Math.max(0, counts.working - counts.queued)
  const since = editor && (editor.holder === 'person' || editor.holder === 'agent' || editor.holder === 'build')
    ? clock(editor.since) : ''
  const facts = [since && t('editorSince', { time: since }),
    editor?.activity === 'building' && (editor.holder === 'person' || editor.holder === 'agent')
      ? (build?.since ? t('editorBuildSince', { time: clock(build.since) }) : t('editorBuilding')) : '',
    build && !build.since ? t('editorBuildUnknownStart') : '',
    build?.since && build.included.length > 0 ? t('editorBuildIncludedCount', { count: build.included.length }) : '',
    build?.since && build.included.length === 0 && counts.verification > 0 ? t('editorBuildIncludedNone') : ''].filter(Boolean)
  const pid = !editor ? t('editorReading') : editor.pid ? t('editorPid', { pid: editor.pid })
    : editor.holder === 'none' ? t('editorNoProcess') : t('editorUnknownProcess')
  const pidLabel = editor?.holder === 'build' ? t('editorBuildProcess') : t('editorProcess')
  const slots = (executor?.maxWorkers ?? 0) > 0
    ? t('editorSlots', { running: executor.running })
    : t('editorSlotsUnknown')
  return <section className="dt-editor-hero" aria-labelledby="dt-editor-title" data-holder={editor?.holder ?? 'reading'}>
    <div className="dt-editor-hero-main">
      <p className="dt-eyebrow">{t('editorPageEyebrow')}</p>
      <h2 id="dt-editor-title" className="dt-editor-title" title={editor?.detail}>
        <span className="dt-editor-dot" data-holder={editor?.holder ?? 'reading'} aria-hidden="true" />
        <span>{t('editorPageTitle')}</span><span className="dt-editor-holder">{holderPhrase(t, editor)}</span>
      </h2>
      {facts.length > 0 && <p className="dt-editor-facts">{facts.join(' · ')}</p>}
      <p className="dt-editor-counts">
        <CountItem count={running} focus="working" tone={running > 0 ? 'live' : undefined}
          label={t('editorWorkingCount', { count: running })} />
        {counts.queued > 0 && <CountItem count={counts.queued} focus="queued"
          label={t('editorQueuedCount', { count: counts.queued })} />}
        <CountItem count={counts.verification} focus="verification" tone={counts.verification > 0 ? 'verify' : undefined}
          label={t('editorVerifyCount', { count: counts.verification })} />
        <CountItem count={counts.person} focus="person" tone={counts.person > 0 ? 'decide' : undefined}
          label={t('editorDecideCount', { count: counts.person })} />
      </p>
      <p className="dt-editor-sub">{t('editorPageSub')}</p>
    </div>
    <aside className="dt-editor-hero-side">
      <dl className="dt-editor-side-facts">
        <div><dt>{pidLabel}</dt><dd>{pid}</dd></div>
        <div><dt>{t('editorSlotsLabel')}</dt><dd>{slots}</dd></div>
        <div><dt>{t('editorProbe')}</dt><dd>{editor ? <When at={editor.at} /> : t('editorReading')}</dd></div>
      </dl>
    </aside>
  </section>
}

/** The label a band can show inside its span; Tickets are named by their lane, so their bands stay unlabeled. */
function bandLabel(t: T, band: EditorTimelineBand): string {
  if (band.label) return band.label
  switch (band.tone) {
    case 'person': return t('editorTimelinePerson')
    case 'agent': return t('editorTimelineAgent')
    case 'unknown': return t('editorTimelineUnknown')
    case 'build': return t('editorTimelineBuild')
    case 'test': return t('editorTimelineTest')
    case 'tool': return t('editorTimelineTool')
    default: return ''
  }
}

function TimelineBand({ band, from, span }: { band: EditorTimelineBand; from: number; span: number }) {
  const { t } = usePanel()
  const start = Date.parse(band.from)
  const end = Date.parse(band.to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const left = Math.min(100, Math.max(0, (start - from) / span * 100))
  const width = Math.min(100 - left, Math.max(0.4, (end - start) / span * 100))
  const label = bandLabel(t, band)
  const when = `${clock(band.from)}–${clock(band.to)}`
  return <span className="dt-editor-timeline-band" data-tone={band.tone}
    style={{ left: `${left}%`, width: `${width}%` }} title={[label, band.title, when].filter(Boolean).join(' · ')}>
    {label && width >= 8 && <span>{label}</span>}
  </span>
}

function TimelineLane({ label, title, bands, from, span, tone, ticketId }:
  { label: string; title?: string; bands: EditorTimelineBand[]; from: number; span: number; tone: EditorTimelineRow['tone'] | 'editor';
    ticketId?: string }) {
  const { navigate } = usePanel()
  const named = ticketId ? <button type="button" className="dt-editor-timeline-name" title={title}
    onClick={() => navigate(ticketRoute(ticketId))}>{label}</button>
    : <span className="dt-editor-timeline-name" title={title}>{label}</span>
  return <div className="dt-editor-timeline-row" data-tone={tone}>
    {named}
    <div className="dt-editor-timeline-lane">
      {bands.map(band => <TimelineBand key={band.id} band={band} from={from} span={span} />)}
      {!bands.length && <span className="dt-editor-timeline-blank" />}
      <span className="dt-editor-timeline-now" aria-hidden="true" />
    </div>
  </div>
}

/** The last-hour timeline: it answers "what was the editor busy with", not "when will my Ticket run". */
function Timeline({ timeline }: { timeline: EditorTimelineView }) {
  const { t } = usePanel()
  const from = Date.parse(timeline.from)
  const to = Date.parse(timeline.to)
  const span = to - from
  if (!Number.isFinite(from) || !Number.isFinite(to) || span <= 0) return null
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const tick = (fraction: number) => fraction === 1 ? t('editorTimelineNow')
    : clock(new Date(from + span * fraction).toISOString())
  const legend: { tone: EditorTimelineBand['tone']; label: string }[] = [
    { tone: 'person', label: t('editorTimelinePerson') }, { tone: 'agent', label: t('editorTimelineAgent') },
    { tone: 'run', label: t('editorTimelineRun') }, { tone: 'build', label: t('editorTimelineBuild') },
    { tone: 'test', label: t('editorTimelineTest') },
  ]
  return <section className="dt-editor-timeline" aria-labelledby="dt-editor-timeline-title">
    <header className="dt-editor-timeline-head">
      <div>
        <h3 id="dt-editor-timeline-title" className="dt-editor-timeline-title">{t('editorTimelineTitle')}</h3>
        <p className="dt-editor-timeline-sub">{t('editorTimelineSub')}</p>
      </div>
      <div className="dt-editor-timeline-legend" aria-hidden="true">
        {legend.map(item => <span key={item.tone} data-tone={item.tone}>{item.label}</span>)}
      </div>
    </header>
    <div className="dt-editor-timeline-axis">
      <span className="dt-editor-timeline-gutter" aria-hidden="true" />
      <div className="dt-editor-timeline-ticks">
        {ticks.map(fraction => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{tick(fraction)}</span>)}
      </div>
    </div>
    <div className="dt-editor-timeline-rows">
      <TimelineLane label={t('editorTimelineEditor')} bands={timeline.editor} from={from} span={span} tone="editor" />
      {timeline.workers.map(row => <TimelineLane key={row.id} label={row.short || shortId(row.ticketId)} title={row.label}
        bands={row.bands} from={from} span={span} tone={row.tone} ticketId={row.ticketId} />)}
    </div>
    {!timeline.editor.length && !timeline.workers.length && <p className="dt-editor-timeline-empty">{t('editorTimelineEmpty')}</p>}
    {timeline.hidden > 0 && <p className="dt-editor-timeline-note">{t('editorTimelineHidden', { count: timeline.hidden })}</p>}
    <p className="dt-editor-timeline-note">{t('editorTimelineNote')}</p>
  </section>
}

/** The recent calls a worker made, newest first; the row opens it so a person can see the tool and MCP behind a run. */
function ToolCalls({ activity }: { activity: EditorTicketRow['activity'] }) {
  const { t } = usePanel()
  const calls = activity.recent ?? []
  if (!calls.length) return <p className="dt-editor-tools-empty">{t('editorToolsEmpty')}</p>
  return <ol className="dt-editor-tools">
    {calls.map(call => <li key={`${call.at}-${call.name}`} className="dt-editor-tool">
      <span className="dt-editor-tool-time">{clock(new Date(call.at).toISOString())}</span>
      <span className="dt-editor-tool-name" title={call.name}>{toolName(t, call.name)}</span>
      {call.digest && <span className="dt-editor-tool-digest" title={call.digest}>{call.digest}</span>}
      <span className="dt-editor-tool-duration">{call.endedAt !== null ? seconds(Math.max(0, call.endedAt - call.at))
        : activity.live ? t('editorToolRunning') : t('editorToolUnfinished')}</span>
    </li>)}
  </ol>
}

function WorkingRow({ row }: { row: EditorTicketRow }) {
  const { t, navigate } = usePanel()
  const { ticket, activity, queued } = row
  const use = row.use ?? (row.usesEditor ? 'uses' : 'unknown')
  const [open, setOpen] = useState(false)
  const changed = activity.updatedAt || Date.parse(ticket.updatedAt)
  const at = Number.isFinite(changed) ? new Date(changed).toISOString() : undefined
  const stuck = !queued && Number.isFinite(changed) && Date.now() - changed > STUCK_MS
  const longStuck = stuck && Date.now() - changed > 24 * 60 * 60_000
  const state = queued ? 'queued' : activity.live ? 'live' : 'idle'
  const tool = activity.live ? activity.tool : null
  const calls = activity.recent ?? []
  const latest = ticket.summary.split(/\r?\n/)[0]?.trim() ?? ''
  const live = tool ? [toolName(t, tool.name), tool.digest, seconds(tool.elapsed)].filter(Boolean).join(' · ')
    // A worker the host has not seen since startup is still being prepared; one seen and no longer live ended its turn.
    : queued ? t('editorQueued') : activity.live || !activity.updatedAt ? t('editorPreparing') : t('editorTurnEnded')
  return <li className="dt-editor-run" data-state={state} data-stuck={stuck || undefined}>
    <span className="dt-editor-run-dot" aria-hidden="true" />
    <div className="dt-editor-run-main">
      <div className="dt-editor-run-head">
        <button type="button" className="dt-editor-run-title" onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}</button>
        {!queued && use !== 'unknown' && <span className="dt-editor-badge" data-uses={use === 'uses' || undefined}
          data-use={use} title={t('editorUsesEditorHint')}>
          {use === 'uses' ? t('editorUsesEditor') : t('editorNoEditor')}</span>}
      </div>
      <p className="dt-editor-run-meta">
        <span className="dt-mono">{shortId(ticket.id)}</span>
        <Tag tone={queued ? 'neutral' : 'info'}>{queued ? t('stage.queued') : t('stage.working')}</Tag>
        {ticket.assignments > 0 && <span>{t('editorAssignmentCount', { count: ticket.assignments })}</span>}
        <span className={stuck ? 'dt-editor-run-time dt-editor-run-stuck' : 'dt-editor-run-time'}>
          {stuck ? longStuck ? t('editorStuckLong') : t('editorStuck', { minutes: minutesSince(changed) })
            : <>{t('editorLastUpdate')} <When at={at} /></>}</span>
      </p>
      <p className="dt-editor-run-live" data-tool={tool ? true : undefined} title={tool ? live : undefined}>{live}</p>
      {calls.length > 0 && <div className="dt-editor-run-tools">
        <button type="button" className="dt-editor-tools-toggle" aria-expanded={open}
          onClick={() => setOpen(value => !value)}>{open ? t('editorToolsHide') : t('editorToolsToggle', { count: calls.length })}</button>
        {open && <ToolCalls activity={activity} />}
      </div>}
      {latest && <p className="dt-editor-run-summary" title={ticket.summary}>{latest}</p>}
    </div>
  </li>
}

function Working({ data }: { data: EditorPageView }) {
  const { t } = usePanel()
  const using = data.working.filter(row => row.use === 'uses' || row.usesEditor)
  const others = data.working.filter(row => !(row.use === 'uses' || row.usesEditor))
  const list = (rows: EditorTicketRow[]) => <ul className="dt-editor-list">
    {rows.map(row => <WorkingRow key={row.ticket.id} row={row} />)}</ul>
  return <section className="dt-editor-col" aria-labelledby="dt-editor-working">
    <header className="dt-editor-col-head">
      <h3 id="dt-editor-working" className="dt-editor-col-title">{t('editorWorkingTitle')}
        <span className="dt-editor-col-count">{data.working.length}</span></h3>
      <p className="dt-editor-col-sub">{t('editorWorkingSub')}</p>
    </header>
    {data.working.length ? <>
      <h4 className="dt-editor-working-group">{t('editorWorkingPrimary')}
        <span className="dt-editor-working-group-count">{using.length}</span></h4>
      {using.length ? list(using) : <p className="dt-editor-working-empty">{t('editorNoWorkingPrimary')}</p>}
      {others.length > 0 && <>
        <h4 className="dt-editor-working-group">{t('editorWorkingOthers')}
          <span className="dt-editor-working-group-count">{others.length}</span></h4>
        {list(others)}
      </>}
    </> : <div className="dt-editor-empty">
      <p>{t('editorNoWorking')}</p>
      {data.editor?.holder === 'person' && <p className="dt-editor-empty-sub">{t('editorNoWorkingPerson')}</p>}
    </div>}
  </section>
}

function WaitingRow({ ticket, verify, included }: { ticket: TicketRow; verify: boolean; included?: boolean }) {
  const { t, navigate } = usePanel()
  const delivery = ticket.delivery
  const fact = verify ? [delivery?.changelist !== undefined ? `CL ${delivery.changelist}` : '', delivery?.review ?? ''].filter(Boolean)
    .join(' · ') : ticketMark(t, ticket).label
  const at = verify ? ticket.verification?.at ?? ticket.ended?.at ?? ticket.updatedAt : ticket.updatedAt
  const note = ticket.note?.text ?? ''
  return <li className="dt-editor-wait" data-kind={verify ? 'verify' : 'decide'}>
    <div className="dt-editor-wait-main">
      <div className="dt-editor-wait-head">
        <button type="button" className="dt-editor-run-title"
          onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}</button>
        {included && <Tag tone="info" title={t('editorBuildIncludedHint')}>{t('editorBuildIncludedTag')}</Tag>}
      </div>
      <p className="dt-editor-run-meta">
        <span className="dt-mono">{shortId(ticket.id)}</span>
        {fact && <span className="dt-editor-wait-fact">{fact}</span>}
        <span className="dt-editor-run-time"><When at={at} /></span>
      </p>
      {note && <p className="dt-editor-run-summary" title={note}>{note}</p>}
    </div>
    <Button variant={verify ? 'primary' : 'outline'} size="sm" onClick={() => navigate(ticketRoute(ticket.id))}>
      {verify ? t('editorGoVerify') : t('editorGoHandle')}</Button>
  </li>
}

function Waiting({ data }: { data: EditorPageView }) {
  const { t } = usePanel()
  const total = data.verification.length + data.person.length
  const included = new Set(data.build?.included ?? [])
  return <section className="dt-editor-col dt-editor-rail" aria-labelledby="dt-editor-waiting">
    <header className="dt-editor-col-head">
      <h3 id="dt-editor-waiting" className="dt-editor-col-title">{t('editorWaitingTitle')}
        <span className="dt-editor-col-count">{total}</span></h3>
      <p className="dt-editor-col-sub">{t('editorWaitingSub')}</p>
    </header>
    {!total && <div className="dt-editor-empty">
      <p>{t('editorNothingWaiting')}</p>
      <p className="dt-editor-empty-sub">{t('editorNothingWaitingSub')}</p>
    </div>}
    {data.verification.length > 0 && <div className="dt-editor-group">
      <h4 className="dt-editor-group-title">{t('editorVerifyGroup')}<span className="dt-editor-col-count">{data.verification.length}</span></h4>
      <ul className="dt-editor-list">{data.verification.map(ticket =>
        <WaitingRow key={ticket.id} ticket={ticket} verify included={included.has(ticket.id)} />)}</ul>
    </div>}
    {data.person.length > 0 && <div className="dt-editor-group">
      <h4 className="dt-editor-group-title">{t('editorDecideGroup')}<span className="dt-editor-col-count">{data.person.length}</span></h4>
      <ul className="dt-editor-list">{data.person.map(ticket => <WaitingRow key={ticket.id} ticket={ticket} verify={false} />)}</ul>
    </div>}
  </section>
}

export function EditorPage() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET editor'), [])
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Hero data={data} />
    {data.timeline && <Timeline timeline={data.timeline} />}
    <div className="dt-editor-grid">
      <Working data={data} />
      <Waiting data={data} />
    </div>
    <p className="dt-editor-foot">{t('editorReadOnlyNote')}</p>
  </>
}
