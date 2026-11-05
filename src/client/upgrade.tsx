/**
 * The sidebar foot's update badge and its dialog: shows when the fork's branch has commits the installed build lacks, lists
 * them, and runs the one-click update with its steps. Renders outside the panel, so the badge carries its own stylesheet and
 * the dialog mounts the panel provider only while open.
 */
import { useEffect, useState } from 'react'
import type { UpgradeRun, UpgradeStep, UpgradeView } from '../app/upgrade.ts'
import { caller, type ApiMessages } from './api.ts'
import { Button, Icon, Modal } from './controls.tsx'
import { PanelProvider, useAction, usePanel } from './provider.tsx'
import type { T } from './text.ts'
import { When } from './widgets.tsx'

/** The badge reads the cached view; the host fetches the branch on its own interval, so a minute is often enough. */
const BADGE_POLL_MS = 60_000
const DIALOG_POLL_MS = 2_000
const ACTIVE: readonly UpgradeRun['state'][] = ['preparing', 'waiting', 'switching']
const short = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : '—'

/** Whether the badge shows: an update is available, one runs, or the last one needs a person's eye. */
export function badgeShown(view: UpgradeView | undefined): boolean {
  if (!view?.enabled) return false
  const state = view.run?.state
  return view.available || (!!state && (ACTIVE.includes(state) || ['failed', 'rolledBack', 'down'].includes(state)))
}
export function badgeTone(view: UpgradeView): 'update' | 'running' | 'problem' {
  const state = view.run?.state
  if (state && ACTIVE.includes(state)) return 'running'
  if (state && ['failed', 'rolledBack', 'down'].includes(state) && !view.available) return 'problem'
  return 'update'
}

const plainMessages = (t: T): ApiMessages => ({ offline: t('offline'), notRunning: t('hostNotRunning'),
  serverError: status => t('serverError', { status }), requestFailed: status => t('requestFailed', { status }),
  setup: () => t('requestFailed', { status: 400 }), user: () => t('requestFailed', { status: 400 }) })

/** The footer action: a small dot-and-label button that opens the update dialog. */
export function UpgradeBadge({ t, wide }: { t: T; wide: boolean }) {
  const [view, setView] = useState<UpgradeView>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const call = caller(() => plainMessages(t))
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      call('GET upgrade').then(next => { if (active) setView(next) }, () => { /* Restarting or an older host: keep the last view. */ })
        .finally(() => { if (active) timer = setTimeout(load, open ? DIALOG_POLL_MS : BADGE_POLL_MS) })
    }
    load()
    return () => { active = false; clearTimeout(timer) }
  }, [t, open])
  if (!badgeShown(view) && !open) return null
  const tone = view ? badgeTone(view) : 'update'
  const label = tone === 'running' ? t('upgradeBadgeRunning') : tone === 'problem' ? t('upgradeBadgeProblem') : t('upgradeBadge')
  return <>
    <button type="button" className="dt-upgrade-badge" data-tone={tone} data-wide={wide} title={label} aria-label={label}
      onClick={() => setOpen(true)}>
      <span className="dt-upgrade-dot" aria-hidden="true" />{wide && <span>{label}</span>}
    </button>
    {open && <PanelProvider t={t} interval={30_000}><UpgradeDialog view={view} onClose={() => setOpen(false)} onView={setView} /></PanelProvider>}
  </>
}

function stepState(step: UpgradeStep): 'running' | 'done' | 'failed' | 'skipped' { return step.state }
/** The update dialog: what is new, the update button, and the steps of a running or the last update. */
export function UpgradeDialog({ view, onClose, onView }: { view: UpgradeView | undefined; onClose: () => void; onView: (view: UpgradeView) => void }) {
  const { t, call } = usePanel()
  const reload = async () => { onView(await call('GET upgrade')) }
  const check = useAction(async () => { onView(await call('POST upgrade/check')) })
  const begin = useAction(async (force: boolean) => { await call('POST upgrade', { body: { force } }) }, { reload })
  const cancel = useAction(async () => { await call('POST upgrade/cancel') }, { reload })
  const run = view?.run ?? null
  const active = !!run && ACTIVE.includes(run.state)
  const footer = <>
    {active && run.state !== 'switching' && <Button variant="ghost" disabled={cancel.busy} onClick={() => { void cancel.run() }}>{t('upgradeCancel')}</Button>}
    {!active && <Button variant="ghost" icon={<Icon name="refresh" size={14} />} disabled={check.busy} onClick={() => { void check.run() }}>{t('upgradeCheck')}</Button>}
    {!active && view?.available && !view.blocked && view.running > 0 && <Button variant="outline" disabled={begin.busy}
      onClick={() => { void begin.run(true) }}>{t('upgradeNow')}</Button>}
    {!active && view?.available && !view.blocked && <Button variant="primary" disabled={begin.busy}
      onClick={() => { void begin.run(false) }}>{view.running > 0 ? t('upgradeWhenIdle') : t('upgradeStart')}</Button>}
  </>
  return <Modal open onClose={onClose} title={t('upgradeTitle')} closeLabel={t('close')} className="dt-upgrade-modal" footer={footer}>
    {!view ? <p className="dt-hint">{t('loading')}</p> : <div className="dt-upgrade-body">
      <p className="dt-upgrade-versions">
        <span>{t('upgradeInstalled')} <code className="dt-mono">{short(view.installed)}</code></span>
        <span>{view.remote.ref} <code className="dt-mono">{short(view.remote.sha)}</code></span>
        {view.remote.checkedAt && <span className="dt-hint">{t('upgradeChecked')} <When at={view.remote.checkedAt} /></span>}
      </p>
      {view.remote.error && <p className="dt-error" role="alert">{t('upgradeFetchFailed')}: {view.remote.error}</p>}
      {view.blocked === 'dependencies' && <p className="dt-banner">{t('upgradeBlockedDependencies')}</p>}
      {!view.installed && view.remote.sha && <p className="dt-hint">{t('upgradeUnknownInstalled')}</p>}
      {view.available && view.running > 0 && !active && <p className="dt-hint">{t('upgradeRunningHint', { count: view.running })}</p>}
      {view.behind.length > 0 && !active && <ul className="dt-upgrade-commits">
        {view.behind.map(commit => <li key={commit.sha}><code className="dt-mono">{short(commit.sha)}</code><span>{commit.subject}</span></li>)}
        {view.more && <li className="dt-hint">{t('upgradeMore')}</li>}
      </ul>}
      {!view.available && !run && <p className="dt-hint">{t('upgradeCurrent')}</p>}
      {run && <RunSteps run={run} />}
    </div>}
  </Modal>
}

function RunSteps({ run }: { run: UpgradeRun }) {
  const { t } = usePanel()
  const outcome = run.state === 'done' ? t('upgradeDone', { sha: short(run.sha) }) : run.state === 'rolledBack' ? t('upgradeRolledBack')
    : run.state === 'down' ? t('upgradeDown') : run.state === 'failed' ? t('upgradeFailed') : run.state === 'cancelled' ? t('upgradeCancelled')
    : run.state === 'switching' ? t('upgradeSwitching') : run.state === 'waiting' ? t('upgradeWaiting') : t('upgradePreparing')
  return <div className="dt-upgrade-run" data-state={run.state}>
    <p className="dt-upgrade-outcome" role="status">{outcome}</p>
    {run.error && <pre className="dt-upgrade-error">{run.error}</pre>}
    <ol className="dt-upgrade-steps">
      {run.steps.map(step => <li key={step.name} data-state={stepState(step)}>
        <Icon name={step.state === 'done' ? 'check' : step.state === 'failed' ? 'alert' : step.state === 'running' ? 'running' : 'minus'} size={14} />
        <span>{t(`upgradeStep.${step.name}` as never)}</span>
        {step.name === 'idle' && step.state === 'running' && step.detail && <span className="dt-hint">{t('upgradeIdleWaiting', { count: step.detail })}</span>}
      </li>)}
    </ol>
  </div>
}
