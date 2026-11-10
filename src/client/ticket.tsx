/** Ticket detail page: stage and actions, Mandate details, undelivered/delivered Inputs, subscribed Threads, and Assignments. */
import { useState, type ReactNode } from 'react'
import { TicketNow } from './activity.tsx'
import { ApiError, usePoll, type TicketPageView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, Tag, type IconName } from './controls.tsx'
import { decisionMark, reportDot, ticketMark } from './marks.ts'
import { PlanDiffView } from './diff.tsx'
import { pipelineTrack, pipelineProgressText, pipelineSmokeFailed, pipelineStageLabel, pipelineStep, pipelineTrackLabel, pipelineTrackState, type PipelineView } from './pipeline.ts'
import { usePanel } from './provider.tsx'
import { STATE_TONE, reportHref } from './repro.tsx'
import { settingsRoute } from './route.ts'
import { Earlier, ThreadLine, automatedRuns } from './rows.tsx'
import { actorName, errorText, localized, readableMarkers, reasonLabel, valueLabel, when, type T } from './text.ts'
import { verifyLines } from '../core/verification.ts'
import { ActionLink, ConfirmButton, ExternalLink, Hint, KeyValues, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton,
  StageMark, VerificationChecks, When } from './widgets.tsx'

type Input = TicketPageView['inputs'][number]
function InputLine({ input, earlier = [] }: { input: Input; earlier?: { id: string; at: string; preview: string }[] }) {
  const { t, navigate } = usePanel()
  const trigger = input.kind === 'trigger' ? input.trigger : undefined
  return <li className="dt-row">
    <Dot state={input.delivered ? 'idle' : 'warning'} label={input.delivered ? t('inputDelivered') : t('inputUndelivered')} />
    <div className="dt-row-main">
      {trigger ? <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'trigger',
        id: trigger.thread, query: { trigger: trigger.id } })}>
        {actorName(t, trigger.actor)}{t('labelSeparator')}{readableMarkers(t, trigger.preview) || t('empty')}
      </button></div> : <div className="dt-row-title">{valueLabel(t, 'input', input.kind)}</div>}
      <div className="dt-row-meta">{input.kind === 'trigger' && <span>{valueLabel(t, 'input', input.kind)}</span>}<When
        at={input.at} /></div>
      {(input.kind === 'text' || input.kind === 'note' || input.kind === 'session-resume') && input.text
        && <div className="dt-row-quote"><MarkdownLite text={input.text} /></div>}
      {trigger?.handback && <Hint>{t('inputHandedBack', { reason: trigger.handback.reason })}</Hint>}
      <Earlier items={earlier} />
    </div>
  </li>
}
function InputList({ inputs }: { inputs: Input[] }) {
  const sender = (input: Input) => input.kind === 'trigger' && input.trigger && !input.trigger.human
    ? `${input.trigger.actor.source}:${input.trigger.actor.id}` : undefined
  const shown = (input: Input) => ({ id: input.id, at: input.at, preview: input.kind === 'trigger' ? input.trigger?.preview ?? '' : '' })
  return <ul className="dt-list">{automatedRuns(inputs, sender).map(run => <InputLine key={run.item.id} input={run.item}
    earlier={run.earlier.map(shown)} />)}</ul>
}

type HistoryState = 'idle' | 'ongoing' | 'done' | 'warning' | 'error'
interface HistoryEvent { key: string; at: string; state: HistoryState; title: string; sub?: string }
const reportState = (state: string): HistoryState => state === 'failed' ? 'error' : state === 'blocked' ? 'warning'
  : state === 'ready' ? 'done' : state === 'progress' ? 'ongoing' : 'idle'
/** Reads the Ticket's own records as a chronological run log: creation, follow-ups, each Assignment's start and report, and the end. */
function history(ticket: TicketPageView, t: T): HistoryEvent[] {
  const events: HistoryEvent[] = [{ key: 'created', at: ticket.createdAt, state: 'idle', title: t('timelineCreated') }]
  for (const input of ticket.inputs) {
    const trigger = input.kind === 'trigger' ? input.trigger : undefined
    // A note the orchestrator delivered carries what it said, not just the fact: a plan decision, a person's reply, a hand-off.
    const wrote = input.kind === 'trigger' ? undefined : input.text
    events.push({ key: `input-${input.id}`, at: input.at, state: input.delivered ? 'done' : 'warning',
      title: trigger ? `${actorName(t, trigger.actor)} · ${readableMarkers(t, trigger.preview) || t('empty')}`
        : wrote ? `${valueLabel(t, 'input', input.kind)}${t('labelSeparator')}${wrote.length > 160 ? `${wrote.slice(0, 160)}…` : wrote}`
          : valueLabel(t, 'input', input.kind),
      sub: input.delivered ? t('inputDelivered') : t('inputUndelivered') })
  }
  ticket.assignments.forEach((assignment, index) => {
    const number = index + 1
    if (assignment.startedAt) events.push({ key: `${assignment.id}-start`, at: assignment.startedAt, state: 'ongoing',
      title: t('assignmentNumber', { number }), sub: t('timelineRunStarted') })
    if (assignment.report) events.push({ key: `${assignment.id}-report`, at: assignment.report.at,
      state: reportState(assignment.report.state),
      title: t('timelineReport', { number, state: valueLabel(t, 'report', assignment.report.state) }), sub: assignment.report.summary })
    else if (assignment.endedAt && assignment.endedReason) events.push({ key: `${assignment.id}-ended`, at: assignment.endedAt, state: 'idle',
      title: t('timelineRunEnded', { number }), sub: reasonLabel(t, assignment.endedReason) })
  })
  // A person's back-move reopened a gate: the timeline says which one, why, and whether it came from the panel or a request.
  for (const reset of ticket.phaseResets) events.push({ key: `phase-${reset.at}-${reset.to}`, at: reset.at, state: 'warning',
    title: t('timelinePhaseReset', { from: valueLabel(t, 'phase', reset.from), to: valueLabel(t, 'phase', reset.to) }),
    sub: reset.reason ?? (reset.via === 'panel' ? t('phaseVia.panel') : t('phaseVia.conversation')) })
  if (ticket.ended) events.push({ key: 'ended', at: ticket.ended.at,
    state: ticket.ended.outcome === 'merged' || ticket.ended.outcome === 'completed' ? 'done'
      : ticket.ended.outcome === 'closed' ? 'warning' : 'idle',
    title: valueLabel(t, 'outcome', ticket.ended.outcome), sub: ticket.ended.reason ? reasonLabel(t, ticket.ended.reason) : undefined })
  return events.sort((a, b) => a.at.localeCompare(b.at)).slice(-16)
}
function History({ events }: { events: HistoryEvent[] }) {
  const { t } = usePanel()
  return <Section title={t('executionTimeline')} count={events.length}>
    <ol className="dt-history">{events.map(event => <li key={event.key} className="dt-history-item" data-state={event.state}>
      <span className="dt-history-time"><When at={event.at} /></span>
      <span className="dt-history-node" aria-hidden="true" />
      <div className="dt-history-body">
        <div className="dt-history-title">{event.title}</div>
        {event.sub && <div className="dt-history-sub">{event.sub}</div>}
      </div>
    </li>)}</ol>
  </Section>
}

function Details({ icon, title, open = false, children }: { icon: IconName; title: ReactNode; open?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open)
  return <DisclosureRow icon={<Icon name={icon} />} title={title} open={shown} onToggle={() => setShown(!shown)}>
    <div className="dt-disclosure-body">{children}</div>
  </DisclosureRow>
}
function Assignments({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  const report = (state: string) => t('assignmentReportShort', { state: valueLabel(t, 'report', state) })
  return <ul className="dt-list">{ticket.assignments.slice().reverse().map((item, index) => <li key={item.id} className="dt-row">
    <Dot state={item.state === 'running' ? reportDot(item.report?.state) : 'idle'} label={valueLabel(t, 'assignment', item.state)} />
    <div className="dt-row-main">
      <div className="dt-row-title">{t('assignmentNumber', { number: ticket.assignments.length - index })}</div>
      <div className="dt-row-meta">
        {/* A running Assignment whose worker reported a non-progress state has ended its turn; show that report as its tag and end its span there. */}
        {item.turnEndedAt && item.report ? <Tag tone="neutral">{report(item.report.state)}</Tag> : <Tag tone={item.state === 'running'
          ? 'info'
          : 'neutral'}>{valueLabel(t, 'assignment', item.state)}</Tag>}
        {item.state !== 'running' && item.report && <span>{report(item.report.state)}</span>}
        <span>{t('assignmentSpan', { from: when(item.startedAt ?? item.createdAt, t('lang')), to: when(item.endedAt ?? item.turnEndedAt,
          t('lang')) || t('now') })}</span>
        {item.endedReason && <span>{reasonLabel(t, item.endedReason)}</span>}
      </div>
    </div>
    {item.ref && item.ref !== ticket.sessionId && <div className="dt-row-actions"><SessionButton variant="outline"
      sessionId={item.ref} /></div>}
  </li>)}</ul>
}
function MandateDetails({ ticket, actor }: { ticket: TicketPageView; actor: string }) {
  const { t, navigate } = usePanel()
  const { mandate, decision } = ticket
  const fact = (item: TicketPageView['basis']['facts'][number]): string => {
    if (item.name === 'legacyAuthority') return valueLabel(t, 'legacy', item.value)
    if (item.name === 'mode' || item.name === 'addressed') return valueLabel(t, item.name, item.value)
    if (item.name === 'admission') return valueLabel(t, 'admissionCell', item.value)
    if (item.name === 'rules') return item.value.map(rule => rule.name).join(t('listSeparator'))
    return item.name === 'sender' ? item.value : t('yes')
  }
  const { legacy } = ticket.basis
  // Omit `sender` when it matches `actor`, which is already shown on the status line.
  const facts = ticket.basis.facts.filter(item => !(item.name === 'sender' && item.value === actor))
  const direction = decision?.direction
  const rows: [string, ReactNode][] = decision ? [
    [t('term.trigger'), <button type="button" className="dt-trigger-link" onClick={() => navigate({ page: 'trigger', id: decision.thread,
      query: { trigger: decision.triggerIds[0] ?? '' } })}>
      <span className="dt-trigger-text">{readableMarkers(t, decision.preview) || t('empty')}</span>
      <span className="dt-row-meta"><span>{valueLabel(t, 'source', mandate.actor.source)} · {actor}</span><When at={decision.at} /></span>
    </button>],
    [t('term.decision'), <div className="dt-kv-stack">
      <span>{decisionMark(t, decision.outcome).label}</span>
      <Hint>{reasonLabel(t, decision.reason)}</Hint>
      {decision.rules.map(rule => <Hint key={rule.id}>{t(rule.matched ? 'ruleMatched' : 'ruleUnmatched', { rule: rule.name,
        reason: rule.reason })}</Hint>)}
      {direction && <Hint>{t('directionLine', { intent: t(direction.implementation_requested ? 'intentYes' : 'intentNo'),
        basis: valueLabel(t, 'targetBasis', direction.target_basis),
        design: t(direction.requires_design_decision ? 'designNeeded' : 'designNotNeeded') })} {t('directionEvidence',
          { evidence: direction.evidence })}</Hint>}
    </div>],
  ] : []
  const version = <button type="button" className="dt-textlink dt-mono" onClick={() => navigate(settingsRoute('eval',
    { version: mandate.policyVersion }))}>{mandate.policyVersion.slice(0, 8)}</button>
  return <Section title={t('mandateDetails')} icon="shield">
    <KeyValues rows={[...rows, [t('term.scope'), legacy ? t('legacyScopeShort') : mandate.scope || t('empty')],
      ...facts.map((item): [string, string] => [valueLabel(t, 'basis', item.name), fact(item)]),
      ...legacy ? [] : [[t('policyVersion'), version] as [string, ReactNode]]]} />
  </Section>
}

type PlanView = NonNullable<TicketPageView['plan']>
/** The plan writes one paragraph per label; splitting on its sentence marks turns the wall into scannable points. */
const planPoints = (text: string): string[] => text.split(/[；。]\s*/).map(point => point.trim()).filter(Boolean)
/**
 * A file the plan names, with the line range it cites and the plan's own sentences about it. The card lists what approving
 * the plan would touch, and each row opens to the changes the plan says happen there; the code itself is not in the plan.
 */
interface PlannedFile { path: string; range?: string; points: string[] }
const FILE = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:hpp|cpp|cc|cs|tsx|ts|jsx|js|py|ini|json|uproject|usf|ush|md|h|c)(?::\d+(?:-\d+)?)?/g
/**
 * Whether a plan sentence is about `file`: it may name the path, or only the stem a person writes mid-sentence
 * (`SkillRotateAPI` for `SkillRotateAPI.cpp`), which is how a fix's own line usually reads.
 */
const mentions = (text: string, file: PlannedFile): boolean => {
  if (text.includes(file.path)) return true
  const stem = (file.path.split('/').pop() ?? file.path).replace(/\.[^.]+$/u, '')
  return stem.length >= 4 && text.includes(stem)
}
/**
 * A point as a file row shows it: when a sentence covers many files, the table needs the part around this one, not
 * the whole paragraph repeated under every row.
 */
function around(text: string, path: string): string {
  if (Array.from(text).length <= 220) return text
  const at = text.indexOf(path)
  if (at < 0) return `${Array.from(text).slice(0, 219).join('')}…`
  const start = Math.max(0, at - 80), end = Math.min(text.length, at + path.length + 140)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
function plannedFiles(lines: { text: string }[]): PlannedFile[] {
  const files = new Map<string, PlannedFile>()
  for (const line of lines) {
    const points = planPoints(line.text)
    for (const match of line.text.matchAll(FILE)) {
      const [path = '', range] = match[0].split(/:(?=\d)/)
      const known = files.get(path) ?? { path, points: [] }
      if (range && !known.range) known.range = range
      for (const point of points) if (mentions(point, known) && !known.points.includes(point)) known.points.push(point)
      files.set(path, known)
    }
  }
  return [...files.values()].slice(0, 12).map(file => ({ ...file, points: file.points.map(point => around(point, file.path)) }))
}
/** The decision the plan waits for: the files and the finding first, the evidence behind one fold, and three buttons. */
function PlanGate({ plan, onDecide }: { plan: PlanView; onDecide: (decision: 'approve' | 'revise' | 'stop', note?: string)
  => Promise<void> }) {
  const { t } = usePanel()
  const [note, setNote] = useState('')
  const [revising, setRevising] = useState(false)
  const [evidence, setEvidence] = useState(false)
  const [opened, setOpened] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!plan.waiting) return null
  const line = (label: string) => plan.lines.find(item => item.label === label)?.text
  const files = plannedFiles(plan.lines.filter(item => ['现象', '修复锚点', '影响面', '预算'].includes(item.label)))
  const evidenceLines = plan.lines.filter(item => !['现象', '修复锚点', '影响面', '预算'].includes(item.label))
  const section = (label: string, title: string) => {
    const text = line(label)
    if (!text) return null
    const points = planPoints(text)
    return <div className="dt-plan-block" key={label}>
      <div className="dt-plan-block-head">{title}</div>
      {points.length > 1 ? <ul className="dt-plan-points">{points.map((point, index) =>
        <li key={index}><MarkdownLite text={point} /></li>)}</ul>
        : <div className="dt-plan-text"><MarkdownLite text={points[0] ?? text} /></div>}
    </div>
  }
  const act = async (decision: 'approve' | 'revise' | 'stop', text?: string) => {
    setBusy(true); setError(undefined)
    try { await onDecide(decision, text); setBusy(false) } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false)
    }
  }
  return <section className="dt-plan" aria-busy={busy}>
    <div className="dt-plan-head">
      <Icon name="decision" size={16} />
      <strong>{t('planTitle')}</strong>
      {plan.deadline && <span className="dt-plan-deadline"><Icon name="clock" size={12} />{t('planDeadline', {
        time: when(plan.deadline, t('lang')) })}</span>}
    </div>
    {plan.diff && <PlanDiffView diff={plan.diff} />}
    {!plan.diff && files.length > 0 && <div className="dt-plan-files">
      <div className="dt-plan-files-head"><Icon name="code" size={15} /><strong>{t('planFiles', { count: files.length })}</strong></div>
      <ul>{files.map(file => {
        const open = opened === file.path
        const [first] = file.points
        return <li key={file.path}>
          <button type="button" className="dt-plan-file" aria-expanded={open}
            onClick={() => setOpened(open ? undefined : file.path)}>
            <code>{file.path}</code>{file.range && <span className="dt-plan-range">:{file.range}</span>}
            <span className="dt-plan-chevron"><Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} /></span>
          </button>
          {open ? file.points.length > 0
            ? <ul className="dt-plan-points dt-plan-file-points">{file.points.map((point, index) =>
              <li key={index}><MarkdownLite text={point} /></li>)}</ul>
            : <div className="dt-plan-file-note">{t('planFileEmpty')}</div>
            : first && <div className="dt-plan-file-note">{first}</div>}
        </li>
      })}</ul>
      <div className="dt-plan-diff-missing">{t('planDiffMissing')}</div>
    </div>}
    {section('现象', t('planPhenomenon'))}
    {section('修复锚点', t('planAnchor'))}
    {section('影响面', t('planImpact'))}
    {section('预算', t('planBudget'))}
    {evidenceLines.length > 0 && <DisclosureRow icon={<Icon name="hash" size={14} />} title={t('planEvidence')} open={evidence}
      onToggle={() => setEvidence(!evidence)}>
      <div className="dt-plan-evidence">{evidenceLines.map(item => <div key={item.label} className="dt-plan-block">
        <div className="dt-plan-block-head">{item.label}</div>
        <ul className="dt-plan-points">{planPoints(item.text).map((point, index) =>
          <li key={index}><MarkdownLite text={point} /></li>)}</ul>
      </div>)}</div>
    </DisclosureRow>}
    <div className="dt-plan-next">
      <div className="dt-plan-block-head">{t('planAfter')}</div>
      <div className="dt-plan-text">{t('planAfterText', { files: files.length ? t('planAfterFiles', { count: files.length }) : '' })}</div>
      <div className="dt-plan-other">{t('planAfterOther')}</div>
    </div>
    {revising ? <div className="dt-plan-revise">
      <textarea className="dt-textarea" rows={3} value={note} placeholder={t('planNotePlaceholder')} autoFocus
        onChange={event => setNote(event.target.value)} />
      <div className="dt-plan-actions">
        <Button variant="primary" size="sm" disabled={busy || !note.trim()} onClick={() => act('revise', note)}>
          {t('planSubmitRevise')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRevising(false); setNote('') }}>
          {t('planCancel')}</Button>
      </div>
    </div> : <div className="dt-plan-actions">
      <Button variant="primary" size="sm" icon={<Icon name="decision" size={14} />} disabled={busy}
        onClick={() => act('approve')}>{t('planApprove')}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setRevising(true)}>{t('planRevise')}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('stop')}>{t('planStop')}</Button>
      <span className="dt-hint">{t('planApproveHint')}</span>
    </div>}
    {error && <p className="dt-plan-error">{t('planError', { error })}</p>}
  </section>
}
function waitedFor(t: T, at: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(at)) / 60_000))
  if (minutes < 60) return t('verifyMinutes', { minutes })
  const hours = Math.round(minutes / 60)
  return hours < 48 ? t('verifyWaitingHours', { hours }) : t('verifyWaitingDays', { days: Math.round(hours / 24) })
}

function reviewLabel(value: string): string {
  try {
    const url = new URL(value)
    const id = url.pathname.split('/').filter(Boolean).at(-1)
    return id ? `review ${id}` : value
  } catch {
    return value
  }
}
function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 360) ?? ''
}

/**
 * The reproduction entry of the acceptance page (docs/024): the worker's steps, the local case its verification package
 * names, and the person's own run button. A case runs against the editor that is already open, so the page never starts
 * one; the host's repro runner owns the run, the output and the report.
 */
function ReproInline({ ticket, steps, onChanged }: { ticket: TicketPageView; steps?: string; onChanged: () => Promise<void> }) {
  const { t, call, notify, navigate } = usePanel()
  const [busy, setBusy] = useState<string>()
  const [failure, setFailure] = useState('')
  const repro = ticket.repro
  const run = async (caseId: string) => {
    setBusy(caseId); setFailure('')
    try {
      await call('POST repro/run', { body: { case: caseId } })
      notify(t('verifyReproStarted'))
      await onChanged()
    } catch (reason) { setFailure(errorText(reason)) } finally { setBusy(undefined) }
  }
  const stop = async (runId: string) => {
    setBusy(runId); setFailure('')
    try { await call('POST repro/stop', { body: { run: runId } }); await onChanged() }
    catch (reason) { setFailure(errorText(reason)) } finally { setBusy(undefined) }
  }
  const openEditor = () => navigate({ page: 'editor', query: { view: 'editor' } })
  return <div className="dt-verify-repro">
    <div className="dt-verify-repro-head">
      <h3>{t('verifyStepsTitle')}</h3>
      <span className="dt-verify-gate-tag">{t('verifyWorkerBadge')}</span>
    </div>
    {steps ? <p className="dt-verify-gate-prose">{steps}</p> : <Hint>{t('verifyNoSteps')}</Hint>}
    {repro && <>
      <div className="dt-verify-repro-head">
        <h3>{t('verifyReproTitle')}</h3>
        <span className="dt-verify-repro-note">{t('verifyReproMatched')}</span>
      </div>
      {repro.cases.length === 0
        ? <div className="dt-verify-repro-empty">
          <p>{t('verifyReproNone')}</p>
          <p className="dt-verify-repro-root"><code>{repro.root}</code></p>
          <div className="dt-verify-repro-actions">
            <button type="button" className="dt-board-more" onClick={openEditor}>{t('verifyReproOpen')} →</button>
          </div>
        </div>
        : repro.cases.map(item => {
          const rows = repro.runs.filter(row => row.caseId === item.id)
          const latest = rows[0]
          const live = repro.active?.caseId === item.id
          const disabled = busy !== undefined || repro.blocked !== null || Boolean(item.problem)
          return <div key={item.id} className="dt-verify-repro-case" data-state={latest?.state ?? 'idle'}>
            <div className="dt-verify-repro-case-head">
              <span className="dt-verify-repro-name" title={item.command}>{item.name}</span>
              {latest ? <Tag tone={STATE_TONE[latest.state]}>{t(`reproState.${latest.state}`)}</Tag>
                : <Tag tone="outline">{t('reproNeverRun')}</Tag>}
            </div>
            {item.description && <p className="dt-verify-repro-desc">{item.description}</p>}
            {item.command && <p className="dt-verify-repro-command"><code>{item.command}</code></p>}
            {latest && <p className="dt-verify-repro-meta">
              <When at={latest.endedAt ?? latest.startedAt} />
              {latest.exitCode !== undefined && latest.exitCode !== null && <span> · {t('verifyReproExit', { code: String(latest.exitCode) })}</span>}
              {latest.summary && <span className="dt-verify-repro-summary" title={latest.summary}> · {latest.summary}</span>}
            </p>}
            {live && <pre className="dt-verify-repro-log">{(repro.active?.tail ?? '').split(/\r?\n/).slice(-12).join('\n')
              || t('reproNoOutput')}</pre>}
            {item.problem && <p className="dt-verify-gate-warning">{t(`reproProblem.${item.problem.code}`)}</p>}
            <div className="dt-verify-repro-actions">
              {live
                ? <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => { void stop(repro.active!.runId) }}>{t('verifyReproStop')}</Button>
                : <Button variant="primary" size="sm" disabled={disabled} onClick={() => { void run(item.id) }}>{t('verifyReproRun')}</Button>}
              {latest?.report && <ActionLink href={reportHref(latest)} icon="review">{t('verifyReproReport')}</ActionLink>}
              <button type="button" className="dt-board-more" onClick={openEditor}>{t('verifyReproOpen')} →</button>
            </div>
          </div>
        })}
      {repro.blocked && <p className="dt-verify-gate-warning">{t('verifyReproBlocked')}</p>}
      {failure && <p className="dt-error" role="alert">{failure}</p>}
    </>}
  </div>
}

/**
 * The local verification gate: delivered work waits here until a person runs it on their machine. Passing records the
 * check and, while the Ticket is open, ends it as completed by a person; returning it sends the note back as a new Input.
 * The worker's own verification text stays visible as evidence, never as acceptance. A historical delivery is shown as a
 * backfill: what was recorded, what is missing, and — when there is nothing concrete to check — no pass button at all.
 */
type AcceptanceView = NonNullable<TicketPageView['acceptance']>
type EditorState = AcceptanceView['editor']['state']
/** The state line and its tooltip: what the timestamps in `acceptance.editor` mean, in one glance. */
const EDITOR_STATE: Record<EditorState, { label: 'verifyEditorLoaded' | 'verifyEditorRestart' | 'verifyEditorBuild'
  | 'verifyEditorNoEditor' | 'verifyEditorUnknown'; hint: 'verifyEditorLoadedHint' | 'verifyEditorRestartHint'
  | 'verifyEditorBuildHint' | 'verifyEditorNoEditorHint' | 'verifyEditorUnknownHint'; tone: 'success' | 'warning' | 'info' | 'outline' }> = {
  loaded: { label: 'verifyEditorLoaded', hint: 'verifyEditorLoadedHint', tone: 'success' },
  restart: { label: 'verifyEditorRestart', hint: 'verifyEditorRestartHint', tone: 'warning' },
  build: { label: 'verifyEditorBuild', hint: 'verifyEditorBuildHint', tone: 'warning' },
  'no-editor': { label: 'verifyEditorNoEditor', hint: 'verifyEditorNoEditorHint', tone: 'info' },
  unknown: { label: 'verifyEditorUnknown', hint: 'verifyEditorUnknownHint', tone: 'outline' },
}
function VerificationGate({ ticket, onChanged }: { ticket: TicketPageView; onChanged: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = ticket.verification?.state === 'pending'
  const backlog = ticket.state === 'ended' && ticket.ended?.outcome === 'completed' && ticket.actions.verify
  if (!pending && !backlog) return null
  const delivery = ticket.delivery
  const scope = delivery?.lease ?? []
  const proof = delivery?.verification
  const review = delivery?.review
  const reviewHref = review && /^https?:\/\//i.test(review) ? review : undefined
  const reviewText = review ? reviewLabel(review) : ''
  const deliveredRef = [delivery?.changelist !== undefined ? `CL ${delivery.changelist}` : '', reviewText].filter(Boolean).join(' · ')
  const acceptance = ticket.acceptance
  const editorState = acceptance ? EDITOR_STATE[acceptance.editor.state] : undefined
  const target = acceptance ? [acceptance.workspace.backend, acceptance.workspace.target, acceptance.workspace.client
    ? `${t('verifyClient')} ${acceptance.workspace.client}` : ''].filter(Boolean).join(' · ') : ''
  // A changelist number alone is not inspectable from this page: it gives no diff and no check. Only a file list, a
  // review, or the worker's verification count as a basis for recording a pass. Historically ended Tickets often lost
  // the lease; then the card must say so instead of pretending that a CL number is something to verify.
  const hasBasis = scope.length > 0 || Boolean(review) || Boolean(proof)
  const brief = firstLine(ticket.summary)
  const blocks = proof ? verifyLines(proof) : []
  const block = (label: string) => blocks.find(item => item.label === label)?.text ?? ''
  // A four-block package is the shape the worker instructions ask for; anything shorter keeps the old line list.
  const structured = blocks.length >= 2
  const judge = block('待你判断')
  const prereq = block('版本与前置')
  const steps = block('复现步骤')
  const evidence = block('预期与证据')
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
  return <section className="dt-verify-gate" data-state={pending ? 'pending' : 'backlog'} data-package={structured || undefined}
    aria-labelledby="dt-verify-gate-title">
    <header className="dt-verify-gate-head">
      <span className="dt-verify-gate-icon" aria-hidden="true"><Icon name="review" size={16} /></span>
      <div className="dt-verify-gate-titles">
        <h2 id="dt-verify-gate-title" className="dt-verify-gate-title">{pending ? t('verifyGateTitle') : t('verifyBackfillTitle')}
          {pending && <span className="dt-verify-gate-age">{t('verifyWaiting', { time: waitedFor(t, ticket.verification?.at ?? ticket.updatedAt) })}</span>}</h2>
        <p className="dt-verify-gate-sub">{pending ? t('verifyGateSub') : t('verifyBacklogHint')}</p>
      </div>
      <span className="dt-verify-gate-state">{backlog ? t('verifyHistorical') : t('verifyWorkerBadge')}</span>
    </header>
    {acceptance && editorState && <div className="dt-verify-editor" data-state={acceptance.editor.state} title={t(editorState.hint)}>
      <span className="dt-verify-editor-dot" aria-hidden="true" />
      <span className="dt-verify-editor-state">{t(editorState.label)}</span>
      <span className="dt-verify-editor-detail">{!acceptance.editor.build || acceptance.editor.state === 'build'
        || acceptance.editor.state === 'unknown' ? t('verifyEditorNoBuild')
        : acceptance.editor.state === 'no-editor' ? t('verifyEditorBuilt', { build: when(acceptance.editor.build.endedAt, t('lang')) })
        : t('verifyEditorDetail', { build: when(acceptance.editor.build.endedAt, t('lang')),
          editor: acceptance.editor.editors[0] ? when(acceptance.editor.editors[0], t('lang')) : t('verifyEditorNoProcess') })}</span>
    </div>}
    {structured && judge && <div className="dt-verify-gate-judge">
      <span className="dt-verify-gate-tag">{t('verifyJudgeTitle')}</span>
      <p className="dt-verify-gate-judge-text">{judge}</p>
    </div>}
    <div className="dt-verify-gate-grid">
      <div className="dt-verify-gate-main">
        <dl className="dt-verify-gate-facts">
          <div><dt>CL</dt><dd className="dt-mono">{delivery?.changelist ?? '—'}</dd></div>
          <div><dt>Swarm review</dt><dd>{review
            ? reviewHref ? <ExternalLink href={reviewHref}>{reviewText}</ExternalLink> : <span className="dt-mono">{reviewText}</span>
            : '—'}</dd></div>
          <div><dt>{t('verifyDeliveredLabel')}</dt><dd>{when(ticket.verification?.at ?? ticket.updatedAt, t('lang'))} · {t('verifyRound', {
            round: ticket.assignments.length })}</dd></div>
          <div><dt>{t('verifyScope')}</dt><dd>{scope.length ? t('verifyFiles', { count: scope.length }) : t('verifyScopeUnknown')}</dd></div>
          {acceptance && <div className="dt-verify-fact-wide"><dt>{t('verifyWorkspaceLabel')}</dt><dd className="dt-mono dt-wrap" title={acceptance.workspace.directory}>
            {acceptance.workspace.directory || t('empty')}</dd></div>}
          {acceptance && target && <div className="dt-verify-fact-wide"><dt>{t('verifyTargetLabel')}</dt><dd className="dt-wrap" title={target}>{target}</dd></div>}
        </dl>
        {brief && <div className="dt-verify-gate-brief">
          <span>{t('verifyLastReport')}</span>
          <p>{brief}</p>
        </div>}
        {structured && <ReproInline ticket={ticket} steps={steps || undefined} onChanged={onChanged} />}
        <div className="dt-verify-gate-scope">
          <h3>{t('verifyFilesTitle')}</h3>
          {scope.length ? <ul className="dt-verify-file-list">
            {scope.slice(0, 6).map((path, index) => <li key={index} className="dt-mono">{path}</li>)}
            {scope.length > 6 && <li className="dt-hint">+{scope.length - 6}</li>}
          </ul> : <p className="dt-verify-gate-warning">{t('verifyNoFilesRecorded')}</p>}
        </div>
        {structured
          ? <>
            {evidence && <div className="dt-verify-gate-evidence">
              <div className="dt-verify-gate-evidence-head"><h3>{t('verifyEvidenceSection')}</h3>
                <span className="dt-verify-gate-tag">{t('verifyWorkerBadge')}</span></div>
              <p className="dt-verify-gate-prose">{evidence}</p>
            </div>}
            <details className="dt-verify-original"><summary>{t('verifyOriginalPackage')}</summary>
              <p className="dt-mono">{proof}</p></details>
          </>
          : <div className="dt-verify-gate-evidence">
            <div className="dt-verify-gate-evidence-head"><h3>{t('verifyEvidenceTitle')}</h3>
              {proof && <span className="dt-verify-gate-tag">{t('verifyWorkerBadge')}</span>}</div>
            {proof ? <>
              <p className="dt-verify-gate-disclaimer">{t('verifyEvidenceNote')}</p>
              <VerificationChecks text={proof} />
              <details className="dt-verify-original"><summary>{t('verifyOriginal')}</summary>
                <p className="dt-mono">{proof}</p></details>
            </> : <Hint>{t('verifyNoEvidence')}</Hint>}
          </div>}
      </div>
      <aside className="dt-verify-gate-side">
        {structured && prereq && <div className="dt-verify-gate-prereq">
          <h3>{t('verifyPrereqTitle')}</h3>
          <p>{prereq}</p>
        </div>}
        <h3>{t('verifyWhatToDoTitle')}</h3>
        <ol className="dt-verify-steps">
          <li>{scope.length ? t('verifyStepDiff') : t('verifyStepNoScope')}</li>
          <li>{proof ? t('verifyStepRerun') : t('verifyStepNoEvidence')}</li>
          <li>{backlog ? t('verifyStepBackfill') : t('verifyStepRecord')}</li>
        </ol>
        {!hasBasis && <p className="dt-verify-gate-warning">{t('verifyNoBasis')}</p>}
        {reviewHref && <ActionLink href={reviewHref} icon="review">{t('verifyOpenReview')}</ActionLink>}
        <p className="dt-verify-gate-note">{t('verifyGateAfter')}</p>
      </aside>
    </div>
    {returning && <div className="dt-verify-gate-return">
      <label className="dt-verify-return-label" htmlFor="dt-verify-rework">{t('verifyReturnPlaceholder')}</label>
      <textarea id="dt-verify-rework" className="dt-textarea dt-verify-return-input" rows={3} value={note}
        onChange={event => setNote(event.target.value)} />
      {error && <p className="dt-error" role="alert">{error}</p>}
      <div className="dt-verify-return-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void rework() }}>{t('verifyReturnSubmit')}</Button>
        <Button variant="ghost" size="sm" onClick={() => setReturning(false)}>{t('verifyReturnCancel')}</Button>
      </div>
    </div>}
    <footer className="dt-verify-gate-foot">
      {hasBasis && <ConfirmButton variant="primary" icon="review" label={backlog ? t('verifyBackfillMark') : t('verifyPass')}
        title={backlog ? t('verifyBackfillTitle') : t('verifyPassTitle')}
        message={backlog ? t('verifyBackfillConfirm', { title: ticket.title, ref: deliveredRef || t('verifyDeliveryRecord') })
          : t('verifyPassConfirm', { title: ticket.title })}
        onConfirm={async () => { await call('POST tickets/:id/verify', { id: ticket.id }); notify(t('verifyPassed')); await onChanged() }} />}
      {!hasBasis && <p className="dt-verify-gate-warning">{t('verifyNoBasis')}</p>}
      {pending && <Button variant="outline" size="sm" onClick={() => setReturning(value => !value)}>{t('verifyReturn')}</Button>}
      {ticket.sessionId && <SessionButton variant="ghost" sessionId={ticket.sessionId} />}
    </footer>
  </section>
}
/**
 * The four steps of the Swarm submitter flow, with the one this pipeline is on: a person reads "it is in the pre-submit
 * smoke" without parsing the last check sentence. A blocked pipeline marks its current step in the danger tone.
 */
function PipelineTrack ({ pipeline }: { pipeline: PipelineView }) {
  const { t } = usePanel()
  const step = pipelineStep(pipeline)
  const blocked = pipeline.state === 'blocked' && !pipeline.manual
  const waiting = pipeline.state === 'blocked' && !!pipeline.manual
  return <ol className="dt-pipe-steps" aria-label={t('pipelineSteps')}>
    {pipelineTrack(pipeline).map((key, index) => {
      const state = pipelineTrackState(step, index)
      return <li key={key} className="dt-pipe-step" data-state={state} data-tone={state === 'current'
        ? blocked ? 'danger' : waiting ? 'warning' : 'info' : undefined}
        aria-current={state === 'current' ? 'step' : undefined}>
        <span className="dt-pipe-step-dot" aria-hidden="true">{state === 'done' && <Icon name="check" size={9} />}</span>
        <span className="dt-pipe-step-label">{t(pipelineTrackLabel(key))}</span>
      </li>
    })}
  </ol>
}

/**
 * The follow-up after local verification: a delivered change is tracked through its review and pipeline until it is in the
 * mainline. A blocked pipeline says what a person must do; a waiting-only pipeline (manual) is a person's approval or
 * submit, not a failure, so it reads as a gold wait. An already merged one completes the Ticket instead of asking for
 * another check.
 */
function PipelineGate({ ticket, onChanged }: { ticket: TicketPageView; onChanged: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const pipeline = ticket.pipeline
  if (!pipeline || ticket.state === 'ended') return null
  const failedSmoke = pipelineSmokeFailed(pipeline)
  const blocked = pipeline.state === 'blocked' && (!pipeline.manual || failedSmoke)
  const waiting = pipeline.state === 'blocked' && !!pipeline.manual && !failedSmoke
  const review = pipeline.url ?? ticket.delivery?.review
  const reviewHref = review && /^https?:\/\//i.test(review) ? review : undefined
  const stageUrl = pipeline.stageUrl && /^https?:\/\//i.test(pipeline.stageUrl) ? pipeline.stageUrl : undefined
  const progress = pipelineStep(pipeline) === 'tests' || pipelineStep(pipeline) === 'review'
    ? pipelineProgressText(t, pipeline.progress) : undefined
  return <section className="dt-pipeline-gate" data-blocked={blocked || undefined} data-waiting={waiting || undefined}
    aria-labelledby="dt-pipeline-gate-title">
    <header className="dt-pipeline-gate-head">
      <span className="dt-pipeline-gate-icon" aria-hidden="true"><Icon name="review" size={15} /></span>
      <div className="dt-pipeline-gate-titles">
        <h2 id="dt-pipeline-gate-title" className="dt-pipeline-gate-title">{t(waiting ? 'pipelineGateWaitingTitle'
          : blocked ? 'pipelineGateBlockedTitle' : 'pipelineGateTitle')}</h2>
        <p className="dt-pipeline-gate-sub">{t(waiting ? 'pipelineGateWaitingSub'
          : blocked ? 'pipelineGateBlockedSub' : 'pipelineGateSub')}</p>
      </div>
      <Tag tone={waiting ? 'warning' : blocked ? 'danger' : 'info'}>{pipelineStageLabel(t, pipeline)}</Tag>
    </header>
    {review && <PipelineTrack pipeline={pipeline} />}
    {progress && <p className="dt-pipe-progress">{progress}</p>}
    <dl className="dt-pipeline-gate-facts">
      <div><dt>{t('pipelineState')}</dt><dd>{pipelineStageLabel(t, pipeline)}</dd></div>
      <div><dt>{t('pipelineLastCheck')}</dt><dd>{pipeline.check || t('pipelineNoCheck')}</dd></div>
      <div><dt>CL</dt><dd>{ticket.delivery?.changelist !== undefined ? ticket.delivery.changelist : t('empty')}</dd></div>
      <div><dt>review</dt><dd>{reviewHref ? <a href={reviewHref} target="_blank" rel="noreferrer">{reviewLabel(review!)}</a>
        : review || t('empty')}</dd></div>
    </dl>
    {pipeline.reason && <p className="dt-pipeline-gate-reason">{pipeline.reason}</p>}
    <footer className="dt-pipeline-gate-foot">
      <ConfirmButton variant="primary" label={t('pipelineMarkMerged')} title={t('pipelineMarkMergedTitle')}
        message={t('pipelineMarkMergedConfirm', { title: ticket.title })}
        onConfirm={async () => { await call('POST tickets/:id/pipeline', { id: ticket.id, body: { state: 'merged',
          ...(review ? { url: review } : {}) } }); notify(t('pipelineMergedNotice')); await onChanged() }} />
      {pipeline.state === 'blocked' && <Button variant="outline" size="sm" onClick={async () => {
        await call('POST tickets/:id/pipeline/check', { id: ticket.id })
        notify(t('pipelineResumedNotice')); await onChanged()
      }}>{t('pipelineResume')}</Button>}
      {stageUrl && <ActionLink href={stageUrl}>{t(pipelineStep(pipeline) === 'autobuild' ? 'pipelineOpenAutobuild' : 'pipelineOpenStage')}</ActionLink>}
      {reviewHref && <ActionLink href={reviewHref}>{t('pipelineOpenReview')}</ActionLink>}
    </footer>
  </section>
}

/** One related Ticket: how it relates, read from this Ticket's side, and where the relation came from. */
function RelationLine({ relation }: { relation: TicketPageView['relations'][number] }) {
  const { t, navigate } = usePanel()
  return <li className="dt-row dt-link"><div className="dt-row-main">
    <div className="dt-row-title">
      <Tag tone={relation.kind === 'blocks' ? 'warning' : relation.kind === 'supersedes' ? 'info' : 'outline'}>
        {t(relation.outgoing ? `relation.${relation.kind}` : `relationIn.${relation.kind}`)}</Tag>
      <button type="button" className="dt-open" onClick={() => navigate({ page: 'execution', id: relation.ticket.id })}>
        {relation.ticket.title}</button>
    </div>
    <div className="dt-row-meta">
      <span>{t(`relationVia.${relation.via}`)}</span>
      {relation.ticket.stage === 'ended' && <span>{t('ticket.ended')}</span>}
      {relation.reason && <span className="dt-ellipsis">{relation.reason}</span>}
    </div>
  </div></li>
}

/**
 * The worker's open question, answered in place: each choice is one click, and any question also takes a written answer.
 * The answer reaches the worker as its next input, as a click on a Feishu card does, so answering no longer needs Feishu.
 */
function AttentionAnswer({ ticket, onChanged }: { ticket: TicketPageView; onChanged: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const attention = ticket.attention!
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = attention.options ?? []
  const answer = async (body: { option?: string; text?: string }) => {
    setBusy(true); setError('')
    try {
      await call('POST tickets/:id/answer', { id: ticket.id, body: { attentionId: attention.id, ...body } })
      setNote('')
      notify(t('answerSent'))
      await onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <div className="dt-answer">
    {options.length > 0 && <div className="dt-answer-options">
      {options.map(option => <Button key={option} variant="outline" size="sm" disabled={busy}
        onClick={() => { void answer({ option }) }}>{option}</Button>)}
    </div>}
    <textarea className="dt-textarea" rows={2} value={note} disabled={busy}
      placeholder={t(options.length ? 'answerPlaceholderOptions' : 'answerPlaceholder')}
      onChange={event => setNote(event.target.value)} />
    <div className="dt-answer-actions">
      <Button variant="primary" size="sm" disabled={busy || !note.trim()} onClick={() => { void answer({ text: note.trim() }) }}>
        {t('answerSend')}</Button>
      <span className="dt-hint">{t('answerHint')}</span>
      {error && <span className="dt-error" role="alert">{error}</span>}
    </div>
  </div>
}

/**
 * A person's move of a live ticket back one of its earlier phases, opened from the status line: the note says why, the
 * chosen gate reopens, and the worker is told what changed. Only earlier phases are offered, so the gates keep their order
 * and nothing moves forward without the worker proving the step (docs/031).
 */
function PhaseBack({ ticket, onChanged, onClose }: { ticket: TicketPageView; onChanged: () => Promise<void>; onClose: () => void }) {
  const { t, call, notify } = usePanel()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const move = async (phase: 'plan' | 'implement') => {
    setBusy(phase); setError('')
    try {
      await call('POST tickets/:id/phase', { id: ticket.id, body: { phase, ...note.trim() ? { note: note.trim() } : {} } })
      setNote(''); onClose(); notify(t('phaseResetDone'))
      await onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(undefined) }
  }
  return <section className="dt-banner dt-phase-back" aria-label={t('phaseBack')}>
    <span className="dt-banner-label">{t('phaseBack')}</span>
    <p className="dt-hint">{t('phaseBackHint')}</p>
    <textarea className="dt-textarea" rows={2} value={note} placeholder={t('phaseBackNote')} disabled={busy !== undefined}
      onChange={event => setNote(event.target.value)} />
    <div className="dt-banner-actions">
      {ticket.phaseBack.map(phase => <Button key={phase} variant="outline" size="sm" disabled={busy !== undefined}
        onClick={() => { void move(phase) }}>{phase === 'plan' ? t('phaseBackPlan') : t('phaseBackImplement')}</Button>)}
      <Button variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
    </div>
    {error && <p className="dt-error" role="alert">{error}</p>}
  </section>
}

export function TicketPage({ id }: { id: string }) {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id', { id }), [id])
  const [phaseBack, setPhaseBack] = useState(false)
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  if (!data) return <><PageHead
    title={t('term.ticket')} />{error instanceof ApiError && error.missing ? <Hint>{t('ticketNotFound')}</Hint> : <LoadState
      error={error} loading />}</>
  const status = ticketMark(t, data)
  const actor = actorName(t, data.mandate.actor)
  const { legacy } = data.basis
  const undelivered = data.inputs.filter(input => !input.delivered)
  const failedText = /^(?:\w+Error|Error)\b[:：]/.test(data.summary)
  const failed = data.stage === 'person' && data.action === 'failed'
  const opening = data.threads.find(thread => thread.url)
  const ended = data.ended && (() => {
    const outcome = valueLabel(t, 'outcome', data.ended.outcome), reason = reasonLabel(t, data.ended.reason), time = when(data.ended.at,
      t('lang'))
    return reason ? t('endedAt', { time, outcome, reason }) : t('endedAtShort', { time, outcome })
  })()
  return <>
    <PageHead title={data.title}>
      {opening?.url && <ActionLink href={opening.url}>{t('openThread', { source: valueLabel(t, 'source', opening.source) })}</ActionLink>}
      {data.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/retry', { id }))} />}
      {data.actions.confirm && <ConfirmButton variant="outline" label={t('confirmDelivery')} title={t('confirmTitle')}
        message={t('confirmConfirm', { title: data.title, cl: String(data.delivery?.changelist ?? '') })}
        onConfirm={() => after(call('POST tickets/:id/confirm', { id }))} />}
      {data.sessionId && <SessionButton variant="outline" sessionId={data.sessionId} />}
      {data.sessionId && <Button variant="ghost" size="sm" icon={<Icon name="copy" size={14} />} title={t('copySession')}
        onClick={() => { void navigator.clipboard.writeText(data.sessionId!).then(() => notify(t('copied'))) }} />}
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-row-meta dt-status-line">
      <StageMark state={status.dot} icon={status.icon} label={status.label} />
      <LabelValue label={t('ticketMandateLabel')} value={valueLabel(t, 'strength', data.mandate.strength)} />
      <LabelValue label={t('ticketActorLabel')} value={`${valueLabel(t, 'source', data.mandate.actor.source)} · ${actor}`} />
      <LabelValue label={t('ticketUpdatedLabel')} value={when(data.updatedAt, t('lang'))} />
      <LabelValue label={t('ticketPhaseLabel')} value={valueLabel(t, 'phase', data.phase)} />
      {data.phaseBack.length > 0 && <Button variant="ghost" size="sm" onClick={() => setPhaseBack(value => !value)}>{t('phaseBack')}</Button>}
    </div>
    {phaseBack && data.phaseBack.length > 0 && <PhaseBack ticket={data} onChanged={reload} onClose={() => setPhaseBack(false)} />}
    {ended && <Hint>{ended}</Hint>}
    {/* The P1 gate: the decision is taken here, and the evidence opens in place instead of sending the person to Feishu. */}
    {data.plan?.waiting && <PlanGate plan={data.plan} onDecide={async (decision, note) => {
      await call('POST tickets/:id/plan', { id, body: { decision, ...note ? { note } : {} } })
      await reload()
    }} />}
    {/* The P2 gate: delivered work is not done until a person has run it locally. It outranks the submit banner below. */}
    <VerificationGate ticket={data} onChanged={reload} />
    <PipelineGate ticket={data} onChanged={reload} />
    {data.verification?.state === 'passed' && data.state === 'ended' && <div className="dt-verified-strip">
      <Icon name="check" size={14} />
      <span>{data.verification.by === 'pipeline'
        ? t('pipelineMergedAt', { time: when(data.verification.at, t('lang')) })
        : t('verifyVerifiedAt', { time: when(data.verification.at, t('lang')) })}</span>
      <span className="dt-verified-note">{data.verification.by === 'pipeline' ? t('pipelineMergedNote') : t('verifyVerifiedNote')}</span>
    </div>}
    {/* Legacy delivery banner for Tickets without a verification gate: what the worker shelved, and the submit a person runs themselves. */}
    {data.delivery?.changelist !== undefined && !data.verification && <div className="dt-banner">
      <span className="dt-banner-label">{t('confirmTitle')}</span>
      <span>{t('confirmChangelist', { cl: String(data.delivery.changelist) })}</span>
      {data.delivery.review && <span className="dt-mono">{data.delivery.review}</span>}
      {data.delivery.verification && <span>{data.delivery.verification}</span>}
      {data.confirmed && <span>{t('confirmedAt', { at: when(data.confirmed.at, t('lang')) })}</span>}
      <div className="dt-banner-actions">
        <Hint>{t('confirmHint')}</Hint>
        <code className="dt-mono">{`p4 submit -c ${data.delivery.changelist}`}</code>
      </div>
    </div>}
    {data.attention && !data.plan?.waiting && <div className="dt-banner"><span className="dt-banner-label">{t('attentionPrefix')}</span><MarkdownLite
      text={data.attention.question} />
      <AttentionAnswer ticket={data} onChanged={reload} />
      {data.reply && <div className="dt-banner-actions">
        <ActionLink href={data.reply.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source', data.reply.source) })}</ActionLink>
      </div>}</div>}
    {data.stage === 'working' && <TicketNow id={data.id} queued={data.action === 'queued'} updatedAt={data.updatedAt}
      startedAt={data.assignments.filter(assignment => assignment.startedAt).at(-1)?.startedAt} summary={data.summary} />}
    {/* Ordinary progress stays in the Session/Channels; only a report that halted work (blocked/failed) is shown here.
        A report is markdown: rendering it in a paragraph collapsed every line break into one unreadable block. An
        error message keeps the monospace banner so its text stays byte-for-byte recognisable. */}
    {data.actions.retry && data.summary && (failedText
      ? <p className={`dt-banner${failed ? ' dt-danger' : ''} dt-mono`}>
        <span className="dt-banner-label">{t(failed ? 'failedPrefix' : 'blockedPrefix')}</span>{data.summary}
      </p>
      : <section className="dt-report" data-tone={failed ? 'danger' : 'warning'}>
        <div className="dt-report-head">
          <Icon name={failed ? 'alert' : 'blocked'} size={14} />{t(failed ? 'failedPrefix' : 'blockedPrefix')}
        </div>
        <MarkdownLite text={data.summary} />
      </section>)}
    {data.deliveryError && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('deliveryFailedPrefix')}</span>{data.deliveryError}
    </p>}
    {data.stage === 'person' && data.action === 'review' && data.summary && <section className="dt-report">
      <div className="dt-report-head"><Icon name="review" size={14} />{t('reportReady')}</div>
      <MarkdownLite text={data.summary} />
    </section>}
    <History events={history(data, t)} />
    <MandateDetails ticket={data} actor={actor} />
    {undelivered.length > 0 && <Section title={t('undeliveredInputs')} count={undelivered.length}>
      <Hint>{data.deliveryError ? t('inputRetryHint') : data.paused ? t('inputPausedHint') : t('inputWaitingHint')}</Hint>
      <InputList inputs={undelivered} />
    </Section>}
    {data.relations.length > 0 && <Section title={t('relatedTickets')} count={data.relations.length}>
      <ul className="dt-list">{data.relations.map(relation => <RelationLine key={`${relation.kind}${relation.ticket.id}${relation.outgoing}`}
        relation={relation} />)}</ul>
    </Section>}
    {data.threads.length > 0 && <Section title={t('subscribedThreads')} count={data.threads.length}>
      <ul className="dt-list">{data.threads.map(thread => <ThreadLine key={thread.key} thread={thread} ticketId={data.id}
        context={thread.context} />)}</ul>
    </Section>}
    <div className="dt-details">
      {/* A single Assignment adds nothing beyond the status line; list Assignments only once work has been resumed or handed over. */}
      {data.assignments.length > 1 && <Details icon="queue" title={`${t('term.assignment')} · ${data.assignments.length}`} open><Assignments
        ticket={data} /></Details>}
      {data.environment.length > 0 && <Details icon="settings" title={t('term.environment')}>
        <table className="dt-table"><tbody>{data.environment.map(variable => <tr key={variable.key} title={localized(t,
          variable.description)}>
          <td className="dt-mono">{variable.key}</td><td className="dt-mono">{variable.value || <span
            className="dt-hint">{t('empty')}</span>}</td>
        </tr>)}</tbody></table>
      </Details>}
      <Details icon="message" title={t('term.channel')}>
        <ul className="dt-plain-list">{data.channels.map((item, index) => <li key={index}>
          <ExternalLink href={item.url} icon={item.source === 'github' ? 'pull' : 'message'}>{localized(t, item.label)}</ExternalLink>
        </li>)}</ul>
      </Details>
      {data.inputs.length > undelivered.length && <Details icon="inbox" title={t('deliveredInputs',
        { count: data.inputs.length - undelivered.length })}>
        <InputList inputs={data.inputs.filter(input => input.delivered)} />
      </Details>}
      <Details icon="hash" title={t('identifiers')}>
        <KeyValues rows={[[t('ticketId'), <span className="dt-mono">{data.id}</span>], [t('executionDirectory'), <span
          className="dt-mono">{data.directory ?? t('empty')}</span>],
          ...legacy && data.mandate.scope ? [[t('legacyAssignment'), <span
            className="dt-mono dt-clamp">{data.mandate.scope}</span>] as [string, ReactNode]] : []]} />
      </Details>
    </div>
    {data.actions.stop && <div className="dt-danger-zone">
      <span className="dt-hint">{t('stopHint')}</span>
      <ConfirmButton variant="outline" label={t('stop')} title={t('stopConfirmTitle')} message={t('stopConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/stop', { id }))} />
    </div>}
  </>
}
