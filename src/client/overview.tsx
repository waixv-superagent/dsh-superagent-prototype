/** Overview: the duty desk. One verdict, decision cards for Tickets waiting on a person, a running lane, and recently ended work. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { usePoll, type BillingView, type EditorRow, type Problem, type TicketRow, type TicketSearchView } from './api.ts'
import type { PriorityLevel } from '../core/priority.ts'
import { verifyLines } from '../core/verification.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { pipelineTrack, pipelineProgressText, pipelineSmokeFailed, pipelineStageLabel, pipelineStep, pipelineTrackState } from './pipeline.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { KindTag, ThreadChip } from './rows.tsx'
import { setupPage, settingsRoute, type BoardFocus, type Route } from './route.ts'
import { errorText, healthText, localized, reasonLabel, valueLabel, readableMarkers, type T } from './text.ts'
import { CheckSetupButton, ConfirmButton, LoadState, SetupMessage, VerificationChecks, When, clientHref, linkTarget } from './widgets.tsx'

/** "22:30" in the viewer's own clock; the row says since when, not a relative age that needs mental arithmetic. */
function clock(at: string | null): string {
  if (!at) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The editor row: the only place the panel says who holds the shared editor before an agent fights for it. */
function EditorLine({ editor }: { editor: EditorRow }) {
  const { t } = usePanel()
  const line = editor.holder === 'person' ? t('editorPerson')
    : editor.holder === 'agent' ? t('editorAgent')
    : editor.holder === 'build' ? t('editorBuild')
    : editor.holder === 'none' ? (editor.activity === 'building' ? t('editorEmptyBuilding') : t('editorEmpty'))
    : t('editorUnknown')
  const since = editor.holder === 'person' || editor.holder === 'agent' || editor.holder === 'build' ? clock(editor.since) : ''
  return <p className="dt-editor-line" data-holder={editor.holder} title={editor.detail}>
    {line}
    {since && <span className="dt-editor-since"> · {t('editorSince', { time: since })}</span>}
    {(editor.holder === 'person' || editor.holder === 'agent') && editor.activity === 'building'
      && <span className="dt-editor-since"> · {t('editorBuilding')}</span>}
  </p>
}

/** A money figure small enough that two decimals would read as zero still says something. */
function moneyText(value: number): string {
  if (value === 0) return '¥0.00'
  return value < 0.01 ? '<¥0.01' : `¥${value.toFixed(2)}`
}

/** A compact token count; the exact number is in the title when a person needs it. */
function tokensText(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * The billing strip: which route charged last, how many tokens the rolling hour consumed, and what that costs at the
 * routes' published prices. Tokens lead because they are the provider's actual usage; the money is a labelled estimate.
 */
function BillingStrip({ billing }: { billing: BillingView }) {
  const { t } = usePanel()
  const base = billing.configured.find(role => role.role === 'default')
  // A role on another provider is the incident this strip exists for; a different model on the same provider is ordinary.
  const overrides = billing.configured.filter(role => role.role !== 'default' && base && role.provider !== base.provider)
  const current = billing.current
  const recent = current.at !== null && Date.now() - current.at < 10 * 60_000
  const extra = Math.max(0, billing.routes.length - 1)
  const settled = billing.settled
  const quota = billing.quota
  // The gateway's settled bill is the figure a person pays; the local estimate only stands in when it cannot be read.
  const bars = settled
    ? settled.buckets.map(bucket => ({ at: bucket.at, value: bucket.cost, label: moneyText(bucket.cost) }))
    : billing.buckets.map(bucket => ({ at: bucket.at, value: bucket.tokens, label: `${tokensText(bucket.tokens)} tokens` }))
  const max = Math.max(0, ...bars.map(bar => bar.value))
  const latest = bars.findLastIndex(bar => bar.value > 0)
  const currentUsage = billing.routes.find(row => row.provider === current.provider && row.model === current.model)
  const currentUnpriced = !settled && !!currentUsage && currentUsage.tokens > 0 && currentUsage.cost === null
  const estimate = billing.total.cost !== null ? moneyText(billing.total.cost) : undefined
  const requests = settled ? settled.requests : billing.total.requests
  const top = billing.top
  const topDiffers = !!top && (top.provider !== current.provider || top.model !== current.model)
  const routesTitle = billing.routes.map(route => `${route.name} ${route.model}: ${tokensText(route.tokens)} tokens`
    + `${route.cost !== null ? ` ≈${moneyText(route.cost)}` : ''}`).join(' · ')
  const quotaTone = quota ? quota.remainingPercent < 10 ? 'danger' : quota.remainingPercent < 25 ? 'warn' : 'ok' : undefined
  return <section className="dt-billing" aria-label={t('billingTitle')} data-priced={billing.priced || !!settled || undefined}
    title={settled ? t('billingSettledNote') : t('billingSourceNote')}>
    <div className="dt-billing-now">
      <span className="dt-billing-label">{recent ? t('billingNow') : current.at !== null ? t('billingLast') : t('billingConfigured')}</span>
      <span className="dt-billing-provider" data-unpriced={currentUnpriced || undefined}>
        {current.name || current.provider || t('billingUnknown')}
      </span>
      {current.model && <span className="dt-billing-model">{current.model}</span>}
      {topDiffers && <span className="dt-billing-top" title={routesTitle}>
        {t('billingTop')} {top!.name} {top!.model}
        <span className="dt-billing-top-cost">{top!.cost !== null ? `≈${moneyText(top!.cost)}` : `${tokensText(top!.tokens)} tokens`}</span>
      </span>}
      {extra > 0 && <span className="dt-billing-more" title={routesTitle}>{t('billingMoreRoutes', { count: extra })}</span>}
      {overrides.map(role => <Tag key={role.role} tone="warning">
        {t('billingRoleOverride', { role: t(role.role === 'orchestrator' ? 'billingRoleEval' : 'billingRoleWorker'),
          provider: role.name || role.provider })}
      </Tag>)}
    </div>
    <div className="dt-billing-window">
      <span className="dt-billing-window-label">{t('billingWindow')}</span>
      <span className="dt-billing-tokens">{t('billingTokens', { tokens: tokensText(billing.total.tokens) })}</span>
      {settled
        ? <span className="dt-billing-money" data-source="gateway"
          title={settled.complete ? t('billingSettledNote') : t('billingSettledPartial')}>
          {moneyText(settled.cost)}{!settled.complete && '+'}
        </span>
        : estimate !== undefined
          ? <span className="dt-billing-money" data-source="estimate" title={t('billingEstimateNote')}>≈{estimate}</span>
          : <span className="dt-billing-money" data-unpriced>{t('billingUnpriced')}</span>}
      <span className="dt-billing-source" data-source={settled ? 'gateway' : 'estimate'}>
        {settled ? t('billingSettled') : t('billingEstimate')}
      </span>
      {!settled && billing.total.unpricedTokens > 0 && <span className="dt-billing-unpriced"
        title={t('billingUnpricedTokens', { tokens: tokensText(billing.total.unpricedTokens) })}>+</span>}
      <span className="dt-billing-spark" role="img"
        aria-label={t('billingSpark', { metric: t(settled ? 'billingCostMetric' : 'billingTokenMetric') })}>
        {bars.map((bar, index) => <span key={bar.at} className="dt-billing-bar" data-zero={bar.value === 0 || undefined}
          data-latest={index === latest || undefined} title={`${minuteText(bar.at)} · ${bar.label}`}
          style={{ height: `${max > 0 ? Math.max(8, Math.round(bar.value / max * 100)) : 8}%` }} />)}
      </span>
      <span className="dt-billing-requests">{requests > 0 ? t('billingRequests', { count: requests }) : t('billingNoUsage')}</span>
      {quota && <span className="dt-billing-quota" data-tone={quotaTone}
        title={t('billingQuotaNote', { remaining: moneyText(quota.remaining), limit: moneyText(quota.limit),
          end: quota.periodEnd ? new Date(quota.periodEnd).toLocaleString() : '—' })}>
        <span className="dt-billing-quota-label">{t('billingQuota')}</span>
        <span className="dt-billing-quota-meter" role="meter" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(quota.remainingPercent)} aria-label={t('billingQuota')}>
          <span className="dt-billing-quota-fill" style={{ width: `${quota.remainingPercent}%` }} />
        </span>
        <span className="dt-billing-quota-value">{Math.round(quota.remainingPercent)}%</span>
      </span>}
    </div>
  </section>
}

/** The local clock time of one strip minute, the label its bar's tooltip leads with. */
function minuteText(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}


function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  // The overview lists problems as compact rows: one line each, action on the right; the Source and settings pages carry the detail.
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-problem">
    <span className="dt-problem-dot" aria-hidden="true" />
    <div className="dt-problem-main">{route ? <button type="button" className="dt-problem-title"
      onClick={() => navigate(route)}>{title}</button> : <span className="dt-problem-title">{title}</span>}
      {detail && <div className="dt-problem-detail">{detail}</div>}
      {hint && <div className="dt-problem-detail dt-problem-hint">{hint}</div>}</div>
    {actions && <div className="dt-problem-actions">{actions}</div>}
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': {
      const { outgoing } = problem, source = valueLabel(t, 'source', outgoing.channel.source)
      if (!outgoing.refused) return row(t('problemReply', { source, attempts: outgoing.attempts }), raw(outgoing.error), undefined)
      // A refused reply waits for a person: retrying on a timer cannot help, so the row offers the two ways out.
      return row(t('problemReplyRefused', { source }), raw(outgoing.error), undefined, t('problemReplyRefusedHint'), <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST outbox/:id/retry', { id: outgoing.id })) }}>{t('retry')}</Button>
        <ConfirmButton variant="ghost" icon="dismiss" label={t('withdrawReply')} title={t('withdrawReplyTitle')}
          message={t('withdrawReplyConfirm', { text: outgoing.text })}
          onConfirm={async () => { await call('POST outbox/:id/withdraw', { id: outgoing.id }); await onChanged() }} />
      </>)
    }
  }
}

const STUCK_MS = 10 * 60_000
/** How long the arrival ring holds before the board reads as plain again. */
const FOCUS_MS = 2_600
const minutesSince = (at: string) => Math.max(1, Math.round((Date.now() - Date.parse(at)) / 60_000))
/** Names how long a running Ticket has gone without an update, in the largest unit that still reads precisely. */
function staleLabel(t: T, at: string): string {
  const minutes = minutesSince(at)
  if (minutes < 60) return t('boardNoUpdate', { minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('boardNoUpdateHours', { hours })
  return t('boardNoUpdateDays', { days: Math.round(hours / 24) })
}
const ticketRoute = (id: string): Route => ({ page: 'execution', id })

function DecisionCard({ ticket, onChanged, focused }: { ticket: TicketRow; onChanged: () => Promise<void>; focused?: boolean }) {
  const { t, call, navigate } = usePanel()
  const mark = ticketMark(t, ticket)
  const action = ticket.stage === 'person' ? ticket.action : 'review'
  const open = () => navigate(ticketRoute(ticket.id))
  const after = async (request: Promise<unknown>) => { await request; await onChanged() }
  const body = ticket.note?.text ?? ticket.summary
  const thread = ticket.threads[0]
  return <article className="dt-deck-card dt-board-card" data-kind={action} data-board-focus={focused || undefined}>
    <header className="dt-deck-card-head">
      <span className="dt-deck-card-kind"><Icon name={mark.icon} size={13} />{mark.label}</span>
      <span className="dt-deck-card-when"><When at={ticket.updatedAt} /></span>
      <span className="dt-deck-card-id" title={ticket.id}>#{ticket.id.slice(0, 8)}</span>
    </header>
    <button type="button" className="dt-deck-card-title" onClick={open}>{ticket.title}</button>
    {body && <p className={ticket.note?.error ? 'dt-deck-card-body dt-deck-card-body-error' : 'dt-deck-card-body'}>{body}</p>}
    <div className="dt-deck-card-facts">
      <KindTag kind={ticket.kind} source={ticket.kindSource} />
      {thread && <ThreadChip thread={thread} />}
      {ticket.undelivered > 0 && <span className="dt-deck-card-fact">{t('ticketUndeliveredLabel')} {ticket.undelivered}</span>}
      {ticket.assignments > 1 && <span className="dt-deck-card-fact">{t('boardRunCount', { count: ticket.assignments })}</span>}
    </div>
    <footer className="dt-deck-card-foot">
      {action === 'review' && <Button variant="primary" size="sm" className="dt-deck-cta" icon={<Icon name="review" size={14} />}
        onClick={open}>{t('boardReview')}</Button>}
      {action === 'answer' && <Button variant="primary" size="sm" className="dt-deck-cta" icon={<Icon name="ask" size={14} />}
        onClick={open}>{t('boardAnswer')}</Button>}
      {action !== 'review' && action !== 'answer' && ticket.actions.retry && <ConfirmButton variant="outline" icon="refresh"
        label={t('retry')} title={t('retryTitle')} message={t('retryConfirm', { title: ticket.title })}
        onConfirm={() => after(call('POST tickets/:id/retry', { id: ticket.id }))} />}
      {action === 'answer' && ticket.reply && <a className="dt-btn dt-btn-outline dt-btn-sm" href={clientHref(ticket.reply.url)}
        {...linkTarget(clientHref(ticket.reply.url))}><span className="dt-btn-icon"><Icon name="message" size={14} /></span>
        {t('answerIn', { source: valueLabel(t, 'source', ticket.reply.source) })}</a>}
      {action !== 'review' && action !== 'answer' && <Button variant="ghost" size="sm" onClick={open}>{t('boardOpen')}</Button>}
      {ticket.actions.stop && <span className="dt-deck-card-foot-end"><ConfirmButton variant="ghost" icon="stop" label={t('stop')}
        title={t('stopConfirmTitle')} message={t('stopConfirm', { title: ticket.title })}
        onConfirm={() => after(call('POST tickets/:id/stop', { id: ticket.id }))} /></span>}
    </footer>
  </article>
}

/** A ticket's level, so the board can say which work is urgent, which is mainline and which is discretionary. */
function PriorityTag({ ticket }: { ticket: TicketRow }) {
  const { t } = usePanel()
  const tone = ticket.priority.level === 'P0' ? 'danger' : ticket.priority.level === 'P1' ? 'warning' : 'quiet'
  return <Tag tone={tone} title={ticket.priority.hint}>{t(`priorityWord.${ticket.priority.level}`)}</Tag>
}

function RunRow({ ticket, focus }: { ticket: TicketRow; focus?: BoardFocus }) {
  const { t, navigate } = usePanel()
  const queued = ticket.stage === 'working' && ticket.action === 'queued'
  const idle = ticket.stage === 'idle'
  const stuck = ticket.stage === 'working' && !queued && Date.now() - Date.parse(ticket.updatedAt) > STUCK_MS
  const state = idle ? 'idle' : queued ? 'queued' : 'working'
  const label = idle ? t('stage.idle') : queued ? t('stage.queued') : t('stage.working')
  const focused = focus === 'queued' ? queued : focus === 'working' && state === 'working'
  return <li className="dt-run" data-state={state} data-stuck={stuck || undefined} data-board-focus={focused || undefined}>
    <span className="dt-run-dot" aria-hidden="true" />
    <div className="dt-run-main">
      <button type="button" className="dt-run-title" onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}</button>
      <p className="dt-run-meta">
        <PriorityTag ticket={ticket} />
        <span className="dt-run-stage">{label}</span>
        {ticket.pool && !idle && !queued && <span className="dt-run-fact">{t('poolIdleRunning')}</span>}
        {ticket.assignments > 0 && <span className="dt-run-fact">{t('boardRunCount', { count: ticket.assignments })}</span>}
        <span className={stuck ? 'dt-run-time dt-run-time-stuck' : 'dt-run-time'}><When at={ticket.updatedAt} /></span>
      </p>
      {ticket.summary && <p className="dt-run-summary" title={ticket.summary}>{ticket.summary}</p>}
      {stuck && <p className="dt-run-alert">{staleLabel(t, ticket.updatedAt)}</p>}
    </div>
  </li>
}

/**
 * The levels a pooled Ticket may be dropped on, and what the drop means: `P0`/`P1` lift it into the attention pool and
 * start its work now; `P2`/`P3` only change its level, because a drag must never be a hidden "run now" (docs/019).
 */
const startsNow = (level: PriorityLevel): level is 'P0' | 'P1' => level === 'P0' || level === 'P1'

/** A waiting duration for a pool row, in the largest unit that still reads precisely. */
function poolAge(t: T, at: string): string {
  const minutes = minutesSince(at)
  if (minutes < 60) return t('verifyMinutes', { minutes })
  const hours = Math.round(minutes / 60)
  return hours < 48 ? t('verifyWaitingHours', { hours }) : t('verifyWaitingDays', { days: Math.round(hours / 24) })
}

/**
 * The idle pool as one quiet dock and a drawer it summons (docs/019): the board keeps its five lanes for what a person
 * owes, while the discretionary P2/P3 work waits behind a count. Inside the drawer a row is one line — drag it onto the
 * P0/P1 band to lift it into the attention pool and start it, or onto the P2/P3 sections to only change its level. The
 * same four levels are reachable from a row's menu and the keyboard, so dragging is an enhancement, never the only path.
 */
function IdleDock({ pool, parked, onChanged }: { pool: TicketRow[]; parked: TicketRow[]; onChanged: () => Promise<void> }) {
  const { t, call, notify, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [parkedOpen, setParkedOpen] = useState(false)
  const [menu, setMenu] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [failure, setFailure] = useState('')
  const [pressed, setPressed] = useState<string>()
  const [drag, setDrag] = useState<TicketRow>()
  const [ghost, setGhost] = useState<{ title: string; x: number; y: number }>()
  const [over, setOver] = useState<PriorityLevel>()
  const start = useRef<{ ticket: TicketRow; x: number; y: number }>()
  const moved = useRef(false)
  const apply = async (ticket: TicketRow, level: PriorityLevel) => {
    setBusy(ticket.id); setFailure('')
    try {
      if (startsNow(level)) await call('POST tickets/:id/promote', { id: ticket.id, body: { level } })
      else await call('POST tickets/:id/priority', { id: ticket.id, body: { level } })
      notify(startsNow(level) ? t('poolPromoted') : t('poolParkedLevel', { level: t(`priorityWord.${level}`) }))
      setMenu(undefined)
      await onChanged()
    } catch (reason) {
      setFailure(t('poolLevelFailed', { reason: errorText(reason) }))
    } finally { setBusy(undefined) }
  }
  const applyRef = useRef(apply)
  applyRef.current = apply
  // Escape closes the drawer, the same way it cancels a drag; focus stays where the person was.
  useEffect(() => {
    if (!open) return
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !start.current) setOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  // The listeners live on the window, not the row: a pointer that leaves the drawer must still end the drag, and a
  // cancelled drag (Escape) leaves the level untouched. `elementFromPoint` names the drop zone under the pointer.
  useEffect(() => {
    if (!pressed) return
    // jsdom has no layout, so `elementFromPoint` is absent in the panel's tests; a drag there simply finds no zone.
    const zone = (x: number, y: number): PriorityLevel | undefined => {
      const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) as HTMLElement | null : null
      return hit?.closest<HTMLElement>('[data-drop-level]')?.dataset.dropLevel as PriorityLevel | undefined
    }
    const move = (event: PointerEvent) => {
      const started = start.current
      if (!started) return
      if (!moved.current && Math.hypot(event.clientX - started.x, event.clientY - started.y) < 4) return
      moved.current = true
      event.preventDefault()
      setDrag(started.ticket)
      setGhost({ title: started.ticket.title, x: event.clientX, y: event.clientY })
      setOver(zone(event.clientX, event.clientY))
    }
    const up = (event: PointerEvent) => {
      const started = start.current
      const level = moved.current ? zone(event.clientX, event.clientY) : undefined
      start.current = undefined; moved.current = false
      setPressed(undefined); setDrag(undefined); setGhost(undefined); setOver(undefined)
      if (started && level) void applyRef.current(started.ticket, level)
    }
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      start.current = undefined; moved.current = false
      setPressed(undefined); setDrag(undefined); setGhost(undefined); setOver(undefined)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', cancel)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', cancel) }
  }, [pressed])
  const count = pool.length + parked.length
  if (!count) return null
  const begin = (ticket: TicketRow) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    start.current = { ticket, x: event.clientX, y: event.clientY }
    moved.current = false
    setPressed(ticket.id)
  }
  const row = (ticket: TicketRow) => <li key={ticket.id} className="dt-idle-row" data-level={ticket.priority.level}
    data-dragging={drag?.id === ticket.id || undefined} data-busy={busy === ticket.id || undefined}>
    <button type="button" className="dt-idle-handle" title={t('poolDragHandle', { title: ticket.title })}
      aria-label={t('poolDragHandle', { title: ticket.title })} onPointerDown={begin(ticket)}>
      <Icon name="grip" size={12} />
    </button>
    <button type="button" className="dt-idle-title" onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}</button>
    <span className="dt-idle-facts">
      <PriorityTag ticket={ticket} />
      <KindTag kind={ticket.kind} source={ticket.kindSource} />
      <span className="dt-idle-age">{poolAge(t, ticket.createdAt)}</span>
    </span>
    <button type="button" className="dt-idle-menu" aria-expanded={menu === ticket.id} aria-haspopup="menu"
      aria-label={t('poolMenu')} title={t('poolMenu')} onClick={() => setMenu(menu === ticket.id ? undefined : ticket.id)}>
      <Icon name="settings" size={13} />
    </button>
    {menu === ticket.id && <div className="dt-idle-pop" role="menu" aria-label={t('poolMenu')}>
      {(['P0', 'P1', 'P2', 'P3'] as const).map(level => <button key={level} type="button" role="menuitem"
        data-level={level} disabled={busy === ticket.id} onClick={() => { void apply(ticket, level) }}>
        <span className="dt-idle-pop-level">{t(`priorityWord.${level}`)}</span>
        <small>{startsNow(level) ? t('poolDropStart') : t('poolDropPark')}</small>
        {ticket.priority.level === level && <span className="dt-idle-pop-current" aria-hidden="true"><Icon name="check" size={12} /></span>}
      </button>)}
    </div>}
  </li>
  return <>
    <div className="dt-idle-dock">
      <button type="button" className="dt-idle-dock-button" aria-expanded={open} aria-controls="dt-idle-drawer"
        onClick={() => setOpen(value => !value)}>
        <Icon name="queue" size={14} />
        <span className="dt-idle-dock-title">{t('boardPoolDock', { count })}</span>
        <span className="dt-idle-dock-levels">{t('boardPoolDockLevels', { p2: pool.length, p3: parked.length })}</span>
        <span className="dt-idle-dock-hint">{t('boardPoolDockHint')}</span>
        <span className="dt-idle-dock-chevron" aria-hidden="true"><Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} /></span>
      </button>
    </div>
    {open && <aside id="dt-idle-drawer" className="dt-idle-drawer" role="complementary" aria-label={t('boardPoolTitle')}>
      <header className="dt-idle-drawer-head">
        <div>
          <h3 className="dt-idle-drawer-title">{t('boardPoolTitle')}<span className="dt-board-col-count">{count}</span></h3>
          <p className="dt-idle-drawer-sub">{t('boardPoolDrawerSub')}</p>
        </div>
        <button type="button" className="dt-idle-drawer-close" aria-label={t('poolDrawerClose')} title={t('poolDrawerClose')}
          onClick={() => setOpen(false)}><Icon name="close" size={14} /></button>
      </header>
      {failure && <p className="dt-idle-failure" role="alert">{failure}</p>}
      <div className="dt-idle-drawer-body">
        {pool.length > 0 && <section className="dt-idle-group" data-drop-level="P2" data-over={over === 'P2' || undefined}>
          <h4 className="dt-idle-group-title">{t('poolSection', { level: t('priorityWord.P2'), count: pool.length })}</h4>
          <ul className="dt-idle-list">{pool.slice(0, showAll ? pool.length : 8).map(row)}</ul>
          {pool.length > 8 && <button type="button" className="dt-idle-more" onClick={() => setShowAll(value => !value)}>
            {showAll ? t('poolShowLess') : t('poolShowMore', { count: pool.length - 8 })}
          </button>}
        </section>}
        {parked.length > 0 && <section className="dt-idle-group dt-idle-parked" data-drop-level="P3" data-over={over === 'P3' || undefined}
          data-open={parkedOpen || undefined}>
          <h4 className="dt-idle-group-title">
            <button type="button" className="dt-idle-group-toggle" aria-expanded={parkedOpen}
              onClick={() => setParkedOpen(value => !value)}>
              <span aria-hidden="true"><Icon name={parkedOpen ? 'chevron-up' : 'chevron-down'} size={11} /></span>
              {t('poolSection', { level: t('priorityWord.P3'), count: parked.length })}
            </button>
          </h4>
          {parkedOpen && <ul className="dt-idle-list">{parked.map(row)}</ul>}
        </section>}
      </div>
      <footer className="dt-idle-drawer-foot">{t('poolMenuHint')}</footer>
    </aside>}
    {drag && <>
      <div className="dt-idle-ghost" aria-hidden="true" style={{ left: ghost?.x ?? 0, top: ghost?.y ?? 0 }}>{ghost?.title ?? drag.title}</div>
      <div className="dt-dropband" role="group" aria-label={t('poolDropHint')}>
        <span className="dt-dropband-label">{t('poolDropHint')}</span>
        {(['P0', 'P1'] as const).map(level => <div key={level} className="dt-dropzone" data-drop-level={level}
          data-over={over === level || undefined} data-level={level}>
          <span className="dt-dropzone-code">{level}</span>
          <span className="dt-dropzone-text">{t(level === 'P0' ? 'poolDropP0' : 'poolDropP1')}<small>{t('poolDropStart')}</small></span>
        </div>)}
        <span className="dt-dropband-park">{t('poolDropPark')}</span>
      </div>
    </>}
  </>
}

/** How long delivered work has waited for a person, in the largest unit that still reads precisely. */
function waitedFor(t: T, at: string): string {
  const minutes = minutesSince(at)
  if (minutes < 60) return t('verifyMinutes', { minutes })
  const hours = Math.round(minutes / 60)
  return hours < 48 ? t('verifyWaitingHours', { hours }) : t('verifyWaitingDays', { days: Math.round(hours / 24) })
}

/**
 * Delivered work waiting for a person's local check. The worker's own verification is evidence, not acceptance: this card
 * keeps the changelist, what the worker ran, and the two ways out — pass, or send it back with a reason — in one place.
 */
function VerifyCard({ ticket, onChanged, focused }: { ticket: TicketRow; onChanged: () => Promise<void>; focused?: boolean }) {
  const { t, call, notify, navigate } = usePanel()
  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = () => navigate(ticketRoute(ticket.id))
  const delivery = ticket.delivery
  const proof = delivery?.verification
  // A structured package leads with the one point the person must judge; the worker's check lines are its evidence, not
  // a confirmation, so the card never paints a prerequisite as "confirmed" (docs/012 §3.1).
  const judge = proof ? verifyLines(proof).find(item => item.label === '待你判断')?.text : undefined
  const backlog = ticket.state === 'ended'
  const rework = async () => {
    setBusy(true); setError('')
    try {
      await call('POST tickets/:id/rework', { id: ticket.id, body: { note } })
      notify(t('verifyReturned'))
      await onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <article className="dt-verify-card" data-board-focus={focused || undefined}>
    <header className="dt-verify-head">
      <span className="dt-verify-badge"><Icon name="review" size={13} />{t('verifyWorkerBadge')}</span>
      {backlog && <Tag tone="quiet">{t('verifyHistorical')}</Tag>}
      <span className="dt-verify-age">{t('verifyWaiting', { time: waitedFor(t, ticket.verification?.at ?? ticket.ended?.at
        ?? ticket.updatedAt) })}</span>
    </header>
    <button type="button" className="dt-verify-title" onClick={open}>{ticket.title}</button>
    {ticket.summary && <p className="dt-verify-summary">{ticket.summary}</p>}
    {(delivery?.changelist !== undefined || delivery?.review) && <div className="dt-verify-facts">
      {delivery?.changelist !== undefined && <span className="dt-verify-cl">CL {delivery.changelist}</span>}
      {delivery?.review && <span className="dt-verify-review">{delivery.review}</span>}
      {delivery?.lease.length ? <span className="dt-verify-scope">{t('verifyFiles', { count: delivery.lease.length })}</span> : null}
    </div>}
    {proof && <div className="dt-verify-proof">{judge
      ? <p className="dt-verify-judge-line"><span>{t('verifyJudgeTitle')}</span>{judge}</p>
      : <VerificationChecks text={proof} collapsible />}</div>}
    <footer className="dt-verify-foot">
      {(proof || delivery?.lease.length || delivery?.review) && <ConfirmButton variant="primary" icon="review"
        label={backlog ? t('verifyBackfillMark') : t('verifyPass')}
        title={backlog ? t('verifyBackfillTitle') : t('verifyPassTitle')}
        message={backlog ? t('verifyBackfillConfirm', { title: ticket.title, ref: [delivery?.changelist !== undefined ? `CL ${delivery.changelist}` : '', delivery?.review ?? ''].filter(Boolean).join(' · ') || t('verifyDeliveryRecord') })
          : t('verifyPassConfirm', { title: ticket.title })}
        onConfirm={async () => { await call('POST tickets/:id/verify', { id: ticket.id }); await onChanged() }} />}
      {!(proof || delivery?.lease.length || delivery?.review) && <span className="dt-hint">{t('verifyNoBasis')}</span>}
      {!backlog && <Button variant="outline" size="sm" onClick={() => setReturning(value => !value)}>{t('verifyReturn')}</Button>}
      <Button variant="ghost" size="sm" onClick={open}>{t('verifyOpen')}</Button>
    </footer>
    {returning && <div className="dt-verify-return">
      <label className="dt-verify-return-label" htmlFor={`rework-${ticket.id}`}>{t('verifyReturnPlaceholder')}</label>
      <textarea id={`rework-${ticket.id}`} className="dt-textarea dt-verify-return-input" rows={3} value={note}
        onChange={event => setNote(event.target.value)} />
      {error && <p className="dt-error" role="alert">{error}</p>}
      <div className="dt-verify-return-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void rework() }}>{t('verifyReturnSubmit')}</Button>
        <Button variant="ghost" size="sm" onClick={() => setReturning(false)}>{t('verifyReturnCancel')}</Button>
      </div>
    </div>}
  </article>
}

/**
 * A delivered ticket being followed through its review and pipeline. A blocked one that needs a person sits at the top of
 * the lane; a running one is still moving, so the card leans on the last check and the review link instead of a verdict.
 * `manual` separates "only your approval or submit remains" (a gold wait, not a failure) from a real block.
 */
function PipelineCard({ ticket, onChanged }: { ticket: TicketRow; onChanged: () => Promise<void> }) {
  const { t, call, notify, navigate } = usePanel()
  const pipeline = ticket.pipeline
  const blockedStage = ticket.stage === 'pipeline' && ticket.action === 'blocked'
  const failedSmoke = pipelineSmokeFailed(pipeline)
  const waiting = blockedStage && !!pipeline?.manual && !failedSmoke
  const blocked = blockedStage && (!pipeline?.manual || failedSmoke)
  const delivery = ticket.delivery
  const open = () => navigate(ticketRoute(ticket.id))
  const resume = async () => {
    await call('POST tickets/:id/pipeline/check', { id: ticket.id })
    notify(t('pipelineResumedNotice'))
    await onChanged()
  }
  const step = pipelineStep(pipeline)
  const progress = step === 'tests' || step === 'review' ? pipelineProgressText(t, pipeline?.progress) : undefined
  const stageUrl = pipeline?.stageUrl && /^https?:\/\//i.test(pipeline.stageUrl) ? pipeline.stageUrl : undefined
  return <article className="dt-pipeline-card" data-blocked={blocked || undefined} data-waiting={waiting || undefined}>
    <header className="dt-pipeline-head">
      <Tag tone={waiting ? 'warning' : blocked ? 'danger' : 'info'}>{pipelineStageLabel(t, pipeline)}</Tag>
      <span className="dt-pipeline-age"><When at={pipeline?.at ?? ticket.updatedAt} /></span>
    </header>
    <button type="button" className="dt-pipeline-title" onClick={open}>{ticket.title}</button>
    {pipeline && (pipeline.url || delivery?.review) && <div className="dt-pipeline-track" role="img" aria-label={t('pipelineSteps')}>
      {pipelineTrack(pipeline).map((key, index) => <span key={key} data-state={pipelineTrackState(step, index)} />)}
    </div>}
    {pipeline?.reason && <p className="dt-pipeline-reason">{pipeline.reason}</p>}
    {!pipeline?.reason && pipeline?.check && <p className="dt-pipeline-check">{pipeline.check}</p>}
    <div className="dt-pipeline-facts">
      {delivery?.changelist !== undefined && <span className="dt-verify-cl">CL {delivery.changelist}</span>}
      {progress && <span className="dt-pipeline-chip" title={progress}>{progress}</span>}
      {pipeline?.reason && pipeline?.check && <span className="dt-pipeline-chip" title={pipeline.check}>{pipeline.check}</span>}
      {stageUrl && <a className="dt-pipeline-link" href={stageUrl} target="_blank" rel="noreferrer"
        onClick={event => event.stopPropagation()}>{t('pipelineOpenStage')}</a>}
      {pipeline?.url && <a className="dt-pipeline-link" href={pipeline.url} target="_blank" rel="noreferrer"
        onClick={event => event.stopPropagation()}>{t('pipelineOpenReview')}</a>}
      {delivery?.review && !pipeline?.url && <span className="dt-pipeline-review">{delivery.review}</span>}
    </div>
    <footer className="dt-pipeline-foot">
      <Button variant={blockedStage ? 'primary' : 'outline'} size="sm" onClick={open}>{t(blockedStage ? 'pipelineHandle' : 'pipelineOpen')}</Button>
      {blockedStage && <Button variant="ghost" size="sm" onClick={() => { void resume() }}>{t('pipelineResume')}</Button>}
    </footer>
  </article>
}

/** An ended Ticket with its acceptance source: a person, the worker's own check, an analysis close, or nothing recorded. */
function EndedCard({ ticket }: { ticket: TicketRow }) {
  const { t, navigate } = usePanel()
  const provenance = ticket.provenance ?? (ticket.verification?.state === 'passed' ? 'person'
    : ticket.delivery?.verification ? 'agent' : 'none')
  const tone = provenance === 'person' || provenance === 'pipeline' ? 'success' : provenance === 'agent' ? 'warning' : 'quiet'
  return <li className="dt-ended2" data-outcome={ticket.ended?.outcome}>
    <button type="button" className="dt-ended2-title" onClick={() => navigate(ticketRoute(ticket.id))}>{ticket.title}</button>
    <div className="dt-ended2-meta">
      {ticket.ended?.outcome === 'completed' ? <>
        <Tag tone={tone}>{t(`verifyProvenance.${provenance}`)}</Tag>
        {ticket.delivery?.changelist !== undefined && <span className="dt-ended2-cl">CL {ticket.delivery.changelist}</span>}
      </> : <span className="dt-ended2-outcome">{valueLabel(t, 'outcome', ticket.ended?.outcome)}</span>}
      <span className="dt-ended2-time"><When at={ticket.ended?.at ?? ticket.updatedAt} /></span>
    </div>
  </li>
}

/** One vertical lane of the board: a fixed header, a scrollable list, and an optional "see all" link. */
function Lane({ tone, title, count, sub, action, empty, children }: {
  tone: 'decision' | 'verify' | 'run' | 'pipeline' | 'ended'; title: string; count: number; sub: string; action?: ReactNode; empty: string
  children?: ReactNode
}) {
  return <section className="dt-board-col" data-tone={tone} aria-label={title}>
    <header className="dt-board-col-head">
      <span className="dt-board-col-dot" aria-hidden="true" />
      <h2 className="dt-board-col-title">{title}</h2>
      <span className="dt-board-col-count">{count}</span>
      {action && <span className="dt-board-col-action">{action}</span>}
    </header>
    <p className="dt-board-col-sub">{sub}</p>
    <div className="dt-board-col-body">{count ? children : <p className="dt-board-empty">{empty}</p>}</div>
  </section>
}

function Figure({ label, value, onClick }: { label: string; value: ReactNode; onClick?: () => void }) {
  return <div className="dt-figure"><dt>{label}</dt><dd>{onClick
    ? <button type="button" className="dt-figure-link" onClick={onClick}>{value}</button>
    : value}</dd></div>
}

/**
 * The Overview's Ticket-first finder: people remember a title, an id, a CL, a review or the person who asked, not a menu.
 * Results stay in the page flow above the board, so a search never covers the lanes and the board does not jump under it.
 */
function TicketFinder() {
  const { t, call, navigate } = usePanel()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<TicketSearchView>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const latest = useRef(0)
  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) { latest.current++; setResult(undefined); setLoading(false); setError(''); return }
    const request = ++latest.current
    const timer = window.setTimeout(() => {
      setLoading(true)
      call('GET tickets/search', { query: { q: text, limit: 8 } }).then(value => {
        if (request !== latest.current) return
        setResult(value); setActive(0); setError('')
      }, reason => { if (request === latest.current) setError(reason instanceof Error ? reason.message : String(reason)) })
        .finally(() => { if (request === latest.current) setLoading(false) })
    }, /^\d+$/.test(text) ? 0 : 200)
    return () => window.clearTimeout(timer)
  }, [query, call])
  const hits = result?.tickets ?? []
  const choose = (id: string) => { setQuery(''); setResult(undefined); navigate({ page: 'execution', id }) }
  const key = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setQuery(''); setResult(undefined); return }
    if (!hits.length) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % hits.length) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index - 1 + hits.length) % hits.length) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(hits[active]!.ticket.id) }
  }
  const hint = query.trim().length < 2 ? t('ticketSearchHint') : loading ? t('ticketSearchLoading') : undefined
  return <section className="dt-finder" aria-label={t('ticketSearchLabel')}>
    <div className="dt-finder-box">
      <Input type="search" icon={<Icon name="search" size={15} />} value={query} placeholder={t('ticketSearchPlaceholder')}
        aria-label={t('ticketSearchLabel')} role="combobox" aria-expanded={hits.length > 0}
        aria-controls="dt-finder-results" aria-autocomplete="list" aria-activedescendant={hits[active] ? `dt-finder-${hits[active]!.ticket.id}` : undefined}
        onChange={event => setQuery(event.target.value)} onKeyDown={key} />
      {hint && <p className="dt-finder-hint">{hint}</p>}
      {error && <p className="dt-finder-error" role="alert">{error}</p>}
    </div>
    {query.trim().length >= 2 && result && <div className="dt-finder-results" id="dt-finder-results" role="listbox" aria-label={t('ticketSearchResults')}>
      <div className="dt-finder-head">
        <span>{t('ticketSearchFound', { count: result.total })}</span>
        {result.total > hits.length && <span>{t('ticketSearchShowing', { shown: hits.length, total: result.total })}</span>}
      </div>
      {hits.length === 0 ? <p className="dt-finder-empty">{t('ticketSearchNone')}</p> : <ul className="dt-finder-list">
        {hits.map((hit, index) => {
          const mark = ticketMark(t, hit.ticket)
          return <li key={hit.ticket.id} role="none">
            <button type="button" id={`dt-finder-${hit.ticket.id}`} role="option" aria-selected={index === active}
              className="dt-finder-row" data-active={index === active || undefined}
              onMouseEnter={() => setActive(index)} onClick={() => choose(hit.ticket.id)}>
              <span className="dt-finder-row-main">
                <span className="dt-finder-title">{hit.ticket.title}</span>
                <span className="dt-finder-meta">
                  <span className="dt-finder-id">#{hit.ticket.id.slice(0, 8)}</span>
                  <Tag tone={mark.tone}>{mark.label}</Tag>
                  {hit.archived && <Tag tone="quiet">{t('ticketSearchArchived')}</Tag>}
                  <span className="dt-finder-match">{t(`ticketSearchField.${hit.match.field}`)} · {hit.match.text}</span>
                </span>
              </span>
              <When at={hit.ticket.ended?.at ?? hit.ticket.updatedAt} />
            </button>
          </li>
        })}
      </ul>}
    </div>}
  </section>
}

export function OverviewPage({ focus }: { focus?: BoardFocus }) {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  // The hero counts are one-shot doors: ring the Tickets they counted, then drop both the ring and the route cue so a
  // later reload or back step does not replay it. The cue never filters the board.
  const [mark, setMark] = useState<BoardFocus | undefined>(focus)
  const scrolled = useRef<BoardFocus | undefined>(undefined)
  useEffect(() => {
    setMark(focus)
    if (!focus) return
    const timer = window.setTimeout(() => {
      setMark(undefined)
      navigate({ page: 'editor', query: { view: 'board' } }, true)
    }, FOCUS_MS)
    return () => window.clearTimeout(timer)
  }, [focus, navigate])
  useEffect(() => {
    if (!mark || scrolled.current === mark || !data) return
    const first = document.querySelector<HTMLElement>('.dt-board [data-board-focus]')
    if (!first) return
    scrolled.current = mark
    // A person who asked the system to reduce motion still gets the ring, just without the travel to it.
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    first.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }, [mark, data])
  // The board is a horizontal scroller once the page is narrower than five lanes: track which edges still hide a lane
  // so the CSS mask can show that it scrolls, the same cue the tab bar uses.
  const boardScroll = useRef<HTMLDivElement>(null)
  const [boardMore, setBoardMore] = useState<'start' | 'end' | 'both'>()
  const measureBoard = useCallback(() => {
    const element = boardScroll.current
    if (!element) return
    const start = element.scrollLeft > 1, end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setBoardMore(start && end ? 'both' : start ? 'start' : end ? 'end' : undefined)
  }, [])
  useEffect(() => {
    measureBoard()
    if (!boardScroll.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureBoard)
    observer.observe(boardScroll.current)
    return () => observer.disconnect()
  }, [measureBoard, data])
  if (!data) return <LoadState error={error} loading />
  const person = data.person
  const verification = data.verification ?? []
  const pipeline = data.pipeline ?? []
  const blockedPipeline = pipeline.filter(ticket => ticket.stage === 'pipeline' && ticket.action === 'blocked'
    && (!ticket.pipeline?.manual || pipelineSmokeFailed(ticket.pipeline))).length
  const working = data.working ?? []
  const idle = data.idle ?? []
  const pool = data.pool ?? []
  const parked = data.parked ?? []
  const ended = data.ended ?? []
  const endedStats = data.endedStats ?? { completed: 0, verified: 0, pending: 0, agent: 0, none: 0, changelist: 0 }
  const needs = person.length + verification.length
  const running = working.length + idle.length
  const backlog = verification.filter(ticket => ticket.state === 'ended').length
  const stuck = working.filter(ticket => !(ticket.stage === 'working' && ticket.action === 'queued')
    && Date.now() - Date.parse(ticket.updatedAt) > STUCK_MS).length
  const oldest = verification.map(ticket => ticket.verification?.at ?? ticket.ended?.at).filter((at): at is string => !!at)
    .sort((left, right) => left.localeCompare(right))[0]
  const note = [running > 0 ? t('boardRunningPart', { count: running }) : '', pool.length + parked.length > 0
    ? t('boardPoolPart', { count: pool.length + parked.length }) : '', stuck > 0 ? t('boardStuckPart', { count: stuck }) : '',
    oldest ? t('boardOldestVerify', { time: waitedFor(t, oldest) }) : ''].filter(Boolean).join(' · ')
  const openTickets = () => navigate({ page: 'execution', query: { filter: 'open' } })
  return <>
    {error && <LoadState error={error} loading={false} />}

    <section className="dt-verdict" aria-labelledby="dt-verdict-title">
      <div className="dt-verdict-main">
        <p className="dt-eyebrow">{t('boardEyebrow')}</p>
        <h2 id="dt-verdict-title" className="dt-verdict-title" data-quiet={needs === 0 || undefined}>
          {verification.length > 0 && <>
            <span className="dt-verdict-n">{verification.length}</span>{t('boardVerifyTail')}
          </>}
          {verification.length > 0 && person.length > 0 && <span className="dt-verdict-sep" aria-hidden="true">·</span>}
          {person.length > 0 && <>
            <span className="dt-verdict-dec">{person.length}</span>{t('boardDecisionTail')}
          </>}
          {needs === 0 && t('boardAllClear')}
        </h2>
        <p className="dt-verdict-sub">{needs ? note || t('boardRunningEmpty') : t('boardAllClearSub', { count: running })}</p>
        {data.editor && <EditorLine editor={data.editor} />}
      </div>
      <dl className="dt-figures">
        <Figure label={t('boardReceivedStat')} value={data.flow.received} />
        <Figure label={t('boardJudgedStat')} value={data.flow.judged}
          onClick={() => navigate({ page: 'eval', query: { window: '24h' } })} />
        <Figure label={t('boardAcceptedStat')} value={data.flow.accepted}
          onClick={() => navigate({ page: 'eval', query: { window: '24h' } })} />
        <Figure label={t('boardRunningStat')} value={setup?.problem ? '—' : data.executor.running}
          onClick={setup?.problem ? undefined : () => navigate({ page: 'execution' })} />
      </dl>
      {setup?.problem && <p className="dt-verdict-note">{t('executorWaitingSetup')}</p>}
    </section>

    <TicketFinder />

    {data.problems.length > 0 && <details className="dt-problems">
      <summary className="dt-problems-head"><span className="dt-problems-title">{t('problems')}</span>
        <span className="dt-problems-count">{data.problems.length}</span>
        <span className="dt-problems-chevron" aria-hidden="true"><Icon name="chevron-down" size={12} /></span></summary>
      <ul className="dt-problems-list">{data.problems.slice(0, 4).map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
      {data.problems.length > 4 && <p className="dt-problem-more">{t('boardMoreProblems', { count: data.problems.length - 4 })}</p>}
    </details>}

    {data.billing && <BillingStrip billing={data.billing} />}

    <IdleDock pool={pool} parked={parked} onChanged={reload} />

    <div className="dt-board-scroll" ref={boardScroll} data-more={boardMore} onScroll={measureBoard}>
      <section className="dt-board" aria-label={t('boardNeedsTitle')}>
        <Lane tone="decision" title={t('boardDecisionTitle')} count={person.length} sub={t('boardDecisionSub')}
          empty={t('boardDecisionEmpty')}
          action={person.length ? <button type="button" className="dt-board-more" onClick={() => navigate({ page: 'execution', query: { filter: 'person' } })}>
            {t('boardAllNeeds', { count: person.length })} →</button> : undefined}>
          <div className="dt-board-stack">{person.map(ticket => <DecisionCard key={ticket.id} ticket={ticket} onChanged={reload}
            focused={mark === 'person'} />)}</div>
        </Lane>

        <Lane tone="verify" title={t('boardVerifyTitle')} count={verification.length} sub={t('boardVerifySub')}
          empty={t('boardVerifyEmpty')}
          action={verification.length ? <button type="button" className="dt-board-more" onClick={() => navigate({ page: 'execution', query: { filter: 'verify' } })}>
            {t('boardAllNeeds', { count: verification.length })} →</button> : undefined}>
          {backlog > 0 && <div className="dt-backlog">
            <p className="dt-backlog-line">{t('verifyBacklogPending', { count: backlog })}</p>
            {endedStats.completed > 0 && <p className="dt-backlog-detail">{t('verifyBacklogDetail', { agent: endedStats.agent,
              none: endedStats.none, cl: endedStats.changelist })}</p>}
          </div>}
          <div className="dt-board-stack">{verification.map(ticket => <VerifyCard key={ticket.id} ticket={ticket} onChanged={reload}
            focused={mark === 'verification'} />)}</div>
        </Lane>

        <Lane tone="run" title={t('boardRunning')} count={running} sub={t('boardRunningSub')} empty={t('boardRunningEmpty')}
          action={running ? <button type="button" className="dt-board-more" onClick={openTickets}>{t('boardOpen')} →</button> : undefined}>
          <ul className="dt-runlist">{working.map(ticket => <RunRow key={ticket.id} ticket={ticket} focus={mark} />)}
            {idle.map(ticket => <RunRow key={ticket.id} ticket={ticket} focus={mark} />)}</ul>
        </Lane>

        <Lane tone="pipeline" title={t('boardPipelineTitle')} count={pipeline.length} sub={t('boardPipelineSub')}
          empty={t('boardPipelineEmpty')}
          action={pipeline.length ? <button type="button" className="dt-board-more" onClick={() => navigate({ page: 'execution', query: { filter: 'pipeline' } })}>
            {t('boardAllNeeds', { count: pipeline.length })} →</button> : undefined}>
          {blockedPipeline > 0 && <div className="dt-pipeline-alert" role="status">
            <Tag tone="danger">{t('pipelineBlockedCount', { count: blockedPipeline })}</Tag>
            <span className="dt-pipeline-alert-sub">{t('pipelineBlockedSub')}</span>
          </div>}
          <div className="dt-board-stack">{pipeline.map(ticket => <PipelineCard key={ticket.id} ticket={ticket} onChanged={reload} />)}</div>
        </Lane>

        <Lane tone="ended" title={t('boardEnded')} count={ended.length} sub={t('boardEndedSub')} empty={t('boardEndedEmpty')}
          action={<button type="button" className="dt-board-more" onClick={() => navigate({ page: 'execution', query: { filter: 'ended' } })}>
            {t('boardAll')} →</button>}>
          <ul className="dt-ended2-list">{ended.map(ticket => <EndedCard key={ticket.id} ticket={ticket} />)}</ul>
        </Lane>
      </section>
    </div>
  </>
}

