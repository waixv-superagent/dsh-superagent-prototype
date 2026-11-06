/**
 * Editor page: who holds the Unreal Editor, which Tickets are working with their live tool, and what waits on a person.
 * The scheduler card is the one place a person acts on it: claim it, let agents use an open editor, ask the holder to yield,
 * or reorder the queue. Nothing here kills a person's editor.
 */
import { Fragment, useState, type MouseEvent } from 'react'
import { usePoll, type EditorPageView, type EditorRow, type EditorTicketRow, type EditorTimelineBand,
  type EditorTimelineRow, type EditorTimelineView, type TicketRow } from './api.ts'
import type { ApiRequest } from '../app/api.ts'
import { Button, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { ReproCard } from './repro.tsx'
import { settingsRoute, type BoardFocus, type Route } from './route.ts'
import { errorText, type T } from './text.ts'
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
  if (band.tone === 'lease') return band.label ? t(`editorPurpose.${band.label}` as 'editorPurpose.build') : t('editorTimelineLease')
  if (band.label) return band.label
  switch (band.tone) {
    case 'person': return t('editorTimelinePerson')
    case 'agent': return t('editorTimelineAgent')
    case 'unknown': return t('editorTimelineUnknown')
    case 'build': return t('editorTimelineBuild')
    case 'test': return t('editorTimelineTest')
    case 'tool': return t('editorTimelineTool')
    case 'wait': return t('editorTimelineWait')
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
    { tone: 'test', label: t('editorTimelineTest') }, { tone: 'lease', label: t('editorTimelineLease') },
    { tone: 'wait', label: t('editorTimelineWait') },
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
        {row.lease && <Tag tone={row.lease.state === 'holding' ? 'warning' : 'outline'} title={row.lease.state === 'holding' ? row.lease.note : undefined}>
          {row.lease.state === 'holding' ? t('editorRowHolding', { purpose: purposeLabel(t, row.lease.purpose) })
            : t('editorRowQueued', { purpose: purposeLabel(t, row.lease.purpose), position: row.lease.position })}</Tag>}
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

type Schedule = NonNullable<EditorPageView['schedule']>
type Purpose = Schedule['queue'][number]['purpose']
const purposeLabel = (t: T, purpose: Purpose) => t(`editorPurpose.${purpose}`)
const ticketNames = (tickets: { id: string; title: string }[]) => tickets.map(ticket => ticket.title).join('、')

/**
 * The lease's holder in one sentence: whose Ticket, doing what, since when; or why agents are held back.
 * A single holding Ticket makes the sentence itself the entry that opens it; several Tickets open one by one.
 */
function HolderSentence({ schedule }: { schedule: Schedule }) {
  const { t, navigate } = usePanel()
  const holder = schedule.holder
  if (holder?.kind === 'person') return <>{t('editorLeasePerson')}</>
  if (!holder) return <>{schedule.blocked === 'editor' ? t('editorLeaseBlockedEditor')
    : schedule.blocked === 'unknown' ? t('editorLeaseBlockedUnknown') : t('editorLeaseFree')}</>
  const tail = t('editorLeaseHolderTail', { purpose: purposeLabel(t, holder.purpose), time: clock(holder.since) })
  if (!holder.tickets.length) return <>{t('editorLeaseHostJob')}{tail}</>
  if (holder.tickets.length === 1) {
    const ticket = holder.tickets[0]!
    return <button type="button" className="dt-editor-holder-link" title={t('editorEntryOpen')}
      onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}{tail}</button>
  }
  return <>
    {holder.tickets.map((ticket, index) => <Fragment key={ticket.id}>
      {index > 0 && t('listSeparator')}
      <button type="button" className="dt-editor-holder-name" title={t('editorEntryOpen')}
        onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}</button>
    </Fragment>)}
    {tail}
  </>
}

/**
 * The scheduler card: the lease holder and its purpose, ue-mcp's reading of the editor, the wait queue in grant order,
 * and the jobs the host runs. A person's controls sit here because this is where they see who they would interrupt.
 */
function ScheduleCard({ schedule, reload }: { schedule: Schedule; reload: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const act = useAction((body: ApiRequest<'POST editor/act'>['body']) => call('POST editor/act', { body }), { reload })
  const holder = schedule.holder
  const engine = schedule.engine
  const personHolds = holder?.kind === 'person'
  const personWaits = schedule.queue.some(request => request.person)
  // A row that names exactly one Ticket is itself the entry that opens it; its own buttons keep their action.
  const rowClick = (ticketId: string | undefined) => ticketId === undefined ? undefined : (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement | null)?.closest('button, a, input, textarea, select, .dt-editor-queue-actions')) return
    if (!(window.getSelection()?.isCollapsed ?? true)) return
    navigate(ticketRoute(ticketId))
  }
  const singleTicket = (tickets: { id: string }[]) => tickets.length === 1 ? tickets[0]!.id : undefined
  const ticket = (item: { id: string; title: string }) => <button key={item.id} type="button" className="dt-editor-run-title"
    onClick={() => navigate(ticketRoute(item.id))}>{item.title}</button>
  return <section className="dt-editor-schedule" aria-labelledby="dt-editor-schedule-title" data-holder={holder?.kind ?? (schedule.blocked ? 'blocked' : 'free')}>
    <header className="dt-editor-schedule-head">
      <div>
        <h3 id="dt-editor-schedule-title" className="dt-editor-col-title">{t('editorScheduleTitle')}</h3>
        <p className="dt-editor-schedule-holder"><HolderSentence schedule={schedule} /></p>
        {holder && holder.kind !== 'person' && <p className="dt-editor-run-meta">
          {holder.note && <span className="dt-editor-schedule-note" title={holder.note}>{holder.note}</span>}
          {holder.expiresAt && <span>{t('editorLeaseUntil', { time: clock(holder.expiresAt) })}</span>}
          {holder.draining && <Tag tone={holder.draining.overdue ? 'danger' : 'warning'} title={holder.draining.reason}>
            {holder.draining.overdue ? t('editorLeaseDrainOverdue') : t('editorLeaseDraining')}</Tag>}
        </p>}
      </div>
      <div className="dt-editor-schedule-actions">
        {personHolds || personWaits
          ? <Button variant="outline" size="sm" disabled={act.busy} onClick={() => { void act.run({ action: 'release' }) }}>{t('editorActRelease')}</Button>
          : schedule.blocked === 'editor'
            ? <Button variant="outline" size="sm" disabled={act.busy} onClick={() => { void act.run({ action: 'yield' }) }}
              title={t('editorActYieldHint')}>{t('editorActYield')}</Button>
            : <Button variant="outline" size="sm" disabled={act.busy} onClick={() => { void act.run({ action: 'claim' }) }}
              title={t('editorActClaimHint')}>{t('editorActClaim')}</Button>}
        {schedule.yielded && !personHolds && <Button variant="ghost" size="sm" disabled={act.busy}
          onClick={() => { void act.run({ action: 'claim' }) }}>{t('editorActTakeBack')}</Button>}
        {holder && holder.kind !== 'person' && !holder.draining && <Button variant="ghost" size="sm" disabled={act.busy}
          onClick={() => { void act.run({ action: 'preempt', reason: t('editorActPreemptReason') }) }}>{t('editorActPreempt')}</Button>}
      </div>
    </header>
    {engine && <p className="dt-editor-engine" data-tone={engine.summary.tone} title={engine.detail}>
      <span className="dt-editor-engine-label">{t('editorEngineLabel')}</span>
      <span>{engine.summary.text}</span>
      {engine.bridges.length > 0 && <span className="dt-editor-engine-meta">{t('editorEngineBridges', { count: engine.bridges.length })}</span>}
      {engine.writtenAt && <span className="dt-editor-engine-meta"><When at={engine.writtenAt} /></span>}
    </p>}
    <div className="dt-editor-schedule-body">
      <div>
        <h4 className="dt-editor-working-group">{t('editorQueueTitle')}<span className="dt-editor-working-group-count">{schedule.queue.length}</span></h4>
        {schedule.queue.length ? <ol className="dt-editor-queue">{schedule.queue.map(request => {
          const single = singleTicket(request.tickets)
          return <li key={request.id} className="dt-editor-queue-item" data-person={request.person || undefined}
            data-ticket={single} onClick={rowClick(single)}>
            <span className="dt-editor-queue-pos">{request.position}</span>
            <div className="dt-editor-run-main">
              <div className="dt-editor-run-head">
                {request.person ? <span>{t('editorQueuePerson')}</span> : request.tickets.map(ticket)}
                <Tag tone="outline">{purposeLabel(t, request.purpose)}</Tag>
                {request.front && <Tag tone="info">{t('editorQueueFront')}</Tag>}
              </div>
              <p className="dt-editor-run-meta">
                {request.note && <span className="dt-editor-schedule-note" title={request.note}>{request.note}</span>}
                <span>{t('editorQueueSince')} <When at={request.at} /></span>
              </p>
            </div>
            {!request.person && <span className="dt-editor-queue-actions">
              {request.position > 1 && <Button variant="ghost" size="sm" disabled={act.busy}
                onClick={() => { void act.run({ action: 'front', id: request.id }) }}>{t('editorActFront')}</Button>}
              <Button variant="ghost" size="sm" disabled={act.busy}
                onClick={() => { void act.run({ action: 'cancel', id: request.id }) }}>{t('editorActCancel')}</Button>
            </span>}
          </li>
        })}</ol> : <p className="dt-editor-working-empty">{t('editorQueueEmpty')}</p>}
      </div>
      <div>
        <h4 className="dt-editor-working-group">{t('editorJobsTitle')}<span className="dt-editor-working-group-count">{schedule.jobs.length}</span></h4>
        {schedule.jobs.length ? <ul className="dt-editor-jobs">{schedule.jobs.map(job => {
          const single = singleTicket(job.tickets)
          return <li key={job.id} className="dt-editor-job" data-state={job.state} data-ticket={single}
            onClick={rowClick(single)}>
            <div className="dt-editor-run-head">
              <span className="dt-editor-job-kind">{purposeLabel(t, job.kind)}</span>
              <Tag tone={job.state === 'succeeded' ? 'success' : job.state === 'failed' || job.state === 'interrupted' ? 'danger'
                : job.state === 'running' ? 'info' : 'outline'}>{t(`editorJobState.${job.state}`)}</Tag>
              {job.tickets.length > 1 && <Tag tone="info" title={ticketNames(job.tickets)}>{t('editorJobBatched', { count: job.tickets.length })}</Tag>}
              {job.state === 'running' && <Button variant="ghost" size="sm" disabled={act.busy}
                onClick={() => { void act.run({ action: 'cancel-job', id: job.id }) }}>{t('editorActStopJob')}</Button>}
            </div>
            <p className="dt-editor-run-meta">
              {job.tickets.slice(0, 3).map(ticket)}
              {job.filter && <span className="dt-mono" title={job.filter}>{job.filter}</span>}
              <span><When at={job.endedAt ?? job.startedAt ?? job.createdAt} /></span>
            </p>
            {job.summary && <p className="dt-editor-run-summary" title={job.command}>{job.summary}</p>}
          </li>
        })}</ul> : <p className="dt-editor-working-empty">{t('editorJobsEmpty')}</p>}
      </div>
    </div>
  </section>
}

/**
 * The person's compile-and-launch entry (docs/021): pick a configured target and the host runs its command under the
 * shared editor's slot. The panel never starts the editor itself; the command does the compile and the launch, and the
 * card shows the run's own output, exit code and the last runs.
 */
function BuildCard() {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET build'), [])
  const [picked, setPicked] = useState('')
  const run = useAction((target: string) => call('POST build/run', { body: { target } }), { reload })
  const stop = useAction((id: string) => call('POST build/stop', { body: { run: id } }), { reload })
  const chosen = data?.targets.some(item => item.name === picked) ? picked : data?.targets[0]?.name ?? ''
  const chosenCommand = data?.targets.find(item => item.name === chosen)?.command
  const active = data?.active
  const blocked = data?.blocked ?? null
  const stateTone = (state: string) => state === 'succeeded' ? 'success' as const : state === 'failed' ? 'danger' as const
    : state === 'running' ? 'info' as const : state === 'interrupted' ? 'warning' as const : 'outline' as const
  return <section className="dt-build" aria-labelledby="dt-build-title" data-blocked={blocked ?? undefined}>
    <header className="dt-build-head">
      <div>
        <h3 id="dt-build-title" className="dt-editor-col-title">{t('buildTitle')}</h3>
        <p className="dt-editor-col-sub">{t('buildSub')}</p>
      </div>
      {error && <p className="dt-build-problem" role="alert">{errorText(error)}</p>}
    </header>
    {!data ? <p className="dt-build-empty">{t('loading')}</p>
      : data.targets.length === 0
        ? <div className="dt-build-empty">
          <p>{t('buildNoTargets')}</p>
          <Button variant="outline" size="sm" onClick={() => navigate(settingsRoute('execution'))}>{t('buildConfigure')}</Button>
        </div>
        : <>
          <div className="dt-build-controls">
            <label className="dt-build-label" htmlFor="dt-build-target">{t('buildTargetLabel')}</label>
            <select id="dt-build-target" className="dt-select dt-build-select" value={chosen} disabled={!!active}
              onChange={event => setPicked(event.target.value)}>
              {data.targets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            {active
              ? <Button variant="outline" size="sm" disabled={stop.busy} onClick={() => { void stop.run(active.runId) }}>{t('buildStop')}</Button>
              : <Button variant="primary" size="sm" disabled={run.busy || blocked !== null}
                title={blocked ? t(blocked === 'agent' ? 'buildBlockedAgent' : 'buildBlockedJob') : undefined}
                onClick={() => { void run.run(chosen) }}>{t('buildRun')}</Button>}
            {active && <Tag tone="info">{t('buildRunning')}</Tag>}
          </div>
          {chosenCommand && <p className="dt-build-command" title={chosenCommand}><code>{chosenCommand}</code></p>}
          {blocked && !active && <p className="dt-build-blocked">{t(blocked === 'agent' ? 'buildBlockedAgent' : 'buildBlockedJob')}</p>}
          {active && <div className="dt-build-active">
            <p className="dt-build-active-line"><Tag tone="info">{t('buildRunning')}</Tag><span>{active.target}</span></p>
            <pre className="dt-build-log">{active.tail.split(/\r?\n/).slice(-16).join('\n') || t('buildNoOutput')}</pre>
          </div>}
          {data.runs.length > 0 && <ul className="dt-build-runs">{data.runs.map(row => <li key={row.id} data-state={row.state}>
            <Tag tone={stateTone(row.state)}>{t(`buildState.${row.state}`)}</Tag>
            <span className="dt-build-run-target" title={row.summary}>{row.target}</span>
            <When at={row.endedAt ?? row.startedAt} />
            <span className="dt-build-run-summary" title={row.summary}>{row.summary}</span>
            {row.exitCode !== undefined && row.exitCode !== null && <span className="dt-mono">{t('buildExit', { code: String(row.exitCode) })}</span>}
          </li>)}</ul>}
        </>}
  </section>
}

export function EditorPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET editor'), [])
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Hero data={data} />
    {data.schedule && <ScheduleCard schedule={data.schedule} reload={reload} />}
    <BuildCard />
    <ReproCard />
    {data.timeline && <Timeline timeline={data.timeline} />}
    <div className="dt-editor-grid">
      <Working data={data} />
      <Waiting data={data} />
    </div>
    <p className="dt-editor-foot">{t(data.schedule ? 'editorScheduleNote' : 'editorReadOnlyNote')}</p>
  </>
}

