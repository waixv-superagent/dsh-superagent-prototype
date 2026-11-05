/**
 * The local reproduction cases card on the editor page (docs/024): what a local directory lists, the run a person clicks,
 * its live output and the report it wrote. A case runs against the editor that is already open, so clicking it again
 * re-runs the same case without restarting anything.
 */
import { useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Tag, type TagTone } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText, type T } from './text.ts'
import { ActionLink, When } from './widgets.tsx'

type Page = ApiResponse<'GET repro'>
type CaseRow = Page['cases'][number]
type RunRow = Page['runs'][number]
type CaseProblem = NonNullable<CaseRow['problem']>
type RootProblem = NonNullable<Page['problem']>

const STATE_TONE: Record<RunRow['state'], TagTone> = {
  running: 'info', succeeded: 'success', failed: 'danger', cancelled: 'outline', interrupted: 'warning',
}
const stateLabel = (t: T, state: RunRow['state']) => t(`reproState.${state}`)

/** Why a case cannot run, in the interface's language; the manifest's own complaint stays as the host wrote it. */
function caseProblemText(t: T, problem: CaseProblem): string {
  const text = t(`reproProblem.${problem.code}`)
  return problem.detail ? `${text} · ${problem.detail}` : text
}
/** Why the case directory itself could not be read. */
function rootProblemText(t: T, problem: RootProblem): string {
  const text = t(`reproRootProblem.${problem.code}`)
  return problem.detail ? `${text} · ${problem.detail}` : text
}
/** Where one report opens: inside the run's case folder, so its own relative images and styles load beside it. */
function reportHref(run: RunRow): string {
  return `/orchestrator/repro/file/${encodeURIComponent(run.id)}/${(run.report ?? '')
    .split('/').map(encodeURIComponent).join('/')}`
}

/** One run's last output, read when a person opens it: alive for the run in flight, else from its log. */
function RunOutput({ run }: { run: RunRow }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string>()
  const [failure, setFailure] = useState('')
  const [loading, setLoading] = useState(false)
  const toggle = async () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (text !== undefined) return
    setLoading(true)
    setFailure('')
    try { setText((await call('GET repro/log', { query: { run: run.id } })).text) } catch (error) { setFailure(errorText(error)) }
    finally { setLoading(false) }
  }
  return <div className="dt-repro-output">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => { void toggle() }}>
      {t(open ? 'reproHideOutput' : 'reproShowOutput')}</Button>
    {open && (loading ? <p className="dt-repro-output-note">{t('loading')}</p>
      : failure ? <p className="dt-repro-output-note" role="alert">{failure}</p>
      : <pre className="dt-repro-log">{text || t('reproNoOutput')}</pre>)}
  </div>
}

/** A run's one-line verdict: its state, when it ended, its exit code and the last output line. */
function RunLine({ run, showState = true }: { run: RunRow; showState?: boolean }) {
  const { t } = usePanel()
  return <p className="dt-repro-meta">
    {showState && <Tag tone={STATE_TONE[run.state]}>{stateLabel(t, run.state)}</Tag>}
    <When at={run.endedAt ?? run.startedAt} />
    {run.exitCode !== undefined && run.exitCode !== null && <span className="dt-mono">{t('reproExit', { code: String(run.exitCode) })}</span>}
    {run.summary && <span className="dt-repro-summary" title={run.summary}>{run.summary}</span>}
  </p>
}

/** One case: its name, the latest run, the run button, its report, and the output of the run in flight. */
function CaseCard({ item, runs, active, blocked, busy, onRun, onStop }: {
  item: CaseRow; runs: RunRow[]; active: Page['active']; blocked: boolean; busy: { run: boolean; stop: boolean }
  onRun: (id: string) => void; onStop: (id: string) => void
}) {
  const { t } = usePanel()
  const latest = runs[0]
  const older = runs.slice(1)
  const running = latest?.state === 'running'
  const live = active?.caseId === item.id
  const disabled = !!item.problem || blocked || busy.run || (!!active && !live)
  return <li className="dt-repro-case" data-state={latest?.state ?? 'idle'}>
    <div className="dt-repro-case-head">
      <span className="dt-repro-case-name" title={item.command}>{item.name}</span>
      {item.problem ? <Tag tone="danger">{t('reproCaseBroken')}</Tag>
        : latest ? <Tag tone={STATE_TONE[latest.state]}>{stateLabel(t, latest.state)}</Tag> : <Tag tone="outline">{t('reproNeverRun')}</Tag>}
      <span className="dt-repro-case-actions">
        {!item.problem && (running
          ? <Button variant="outline" size="sm" disabled={busy.stop} onClick={() => onStop(latest.id)}>{t('reproStop')}</Button>
          : <Button variant="outline" size="sm" disabled={disabled} onClick={() => onRun(item.id)}>{t('reproRun')}</Button>)}
        {latest?.report && <ActionLink href={reportHref(latest)} icon="review">{t('reproReport')}</ActionLink>}
      </span>
    </div>
    {item.description && <p className="dt-repro-desc">{item.description}</p>}
    {item.problem && <p className="dt-repro-problem">{caseProblemText(t, item.problem)}</p>}
    {latest && <RunLine run={latest} showState={false} />}
    {live && <pre className="dt-repro-log dt-repro-live">{active?.tail || t('reproNoOutput')}</pre>}
    {latest && !live && <RunOutput run={latest} />}
    {older.length > 0 && <details className="dt-repro-history">
      <summary>{t('reproHistory', { count: older.length })}</summary>
      <ul className="dt-repro-history-list">{older.map(run => <li key={run.id}>
        <RunLine run={run} />
        {run.report && <ActionLink href={reportHref(run)} icon="review">{t('reproReport')}</ActionLink>}
        <RunOutput run={run} />
      </li>)}</ul>
    </details>}
  </li>
}

/**
 * The card: the directory, why it may be unavailable, and one row per case. Running and stopping are the person's own
 * actions on the host; the page never asks a worker or the main Session to do them.
 */
export function ReproCard() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET repro'), [])
  const run = useAction((id: string) => call('POST repro/run', { body: { case: id } }), { reload })
  const stop = useAction((id: string) => call('POST repro/stop', { body: { run: id } }), { reload })
  if (!data) return <section className="dt-repro" aria-labelledby="dt-repro-title">
    <header className="dt-repro-head"><h3 id="dt-repro-title" className="dt-editor-col-title">{t('reproTitle')}</h3></header>
    <p className="dt-hint">{error ? errorText(error) : t('loading')}</p>
  </section>
  const byCase = new Map<string, RunRow[]>()
  for (const row of data.runs) byCase.set(row.caseId, [...byCase.get(row.caseId) ?? [], row])
  const blocked = data.blocked !== null
  return <section className="dt-repro" aria-labelledby="dt-repro-title" data-blocked={data.blocked ?? undefined}>
    <header className="dt-repro-head">
      <div>
        <h3 id="dt-repro-title" className="dt-editor-col-title">{t('reproTitle')}
          <span className="dt-editor-col-count">{data.cases.length}</span></h3>
        <p className="dt-editor-col-sub">{t('reproSub')}</p>
        <p className="dt-repro-path" title={data.root}><span>{t('reproRootLabel')}</span><code>{data.root}</code></p>
      </div>
      {error && <p className="dt-repro-problem" role="alert">{errorText(error)}</p>}
    </header>
    {blocked && <p className="dt-repro-blocked">{t(data.blocked === 'agent' ? 'reproBlockedAgent' : 'reproBlockedJob')}</p>}
    {data.problem && <p className="dt-repro-problem">{rootProblemText(t, data.problem)}</p>}
    {data.cases.length === 0
      ? <p className="dt-repro-empty">{t('reproEmpty')}</p>
      : <ul className="dt-repro-list">{data.cases.map(item => <CaseCard key={item.id} item={item} runs={byCase.get(item.id) ?? []}
        active={data.active} blocked={blocked} busy={{ run: run.busy, stop: stop.busy }}
        onRun={id => { void run.run(id) }} onStop={id => { void stop.run(id) }} />)}</ul>}
  </section>
}
