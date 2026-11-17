/**
 * The sidebar foot's update badge and its dialog: shows when the fork's branch has commits the installed build lacks, lists
 * them, prepares the build in a separate worktree while the running service stays untouched, and restarts into it only when a
 * person asks. Renders outside the panel, so the badge carries its own stylesheet and the dialog mounts the panel provider only
 * while open.
 */
import { useEffect, useRef, useState } from 'react'
import type { UpgradeRun, UpgradeStep, UpgradeView } from '../app/upgrade.ts'
import type { AppUpgradeRun, AppUpgradeView } from '../app/app-upgrade.ts'
import { caller, type ApiMessages } from './api.ts'
import { Button, Icon, Modal } from './controls.tsx'
import { PanelProvider, useAction, usePanel } from './provider.tsx'
import type { T } from './text.ts'
import { When } from './widgets.tsx'

/** The badge reads the cached view; the host fetches the branch on its own interval, so a minute is often enough. */
const BADGE_POLL_MS = 60_000
const DIALOG_POLL_MS = 2_000
/** The prepare and restart phases in progress; a prepared build waits for a person and is not active. */
const ACTIVE: readonly UpgradeRun['state'][] = ['preparing', 'waiting', 'switching']
const short = (sha: string | null | undefined) => sha ? sha.slice(0, 7) : '—'

/** Whether the badge shows for the desktop app track: a build is available, running, or needs a person. */
export function appBadgeShown(app: AppUpgradeView | undefined): boolean {
  if (!app?.enabled) return false
  const state = app.run?.state
  return app.available || state === 'preparing' || state === 'failed' || state === 'interrupted'
}

/** The badge's tone when only the desktop app track has news. */
function appBadgeTone(app: AppUpgradeView): 'update' | 'running' | 'problem' {
  const state = app.run?.state
  return state === 'preparing' ? 'running' : state === 'failed' || state === 'interrupted' ? 'problem' : 'update'
}

/** Whether the badge shows: an update is available, one runs, one is prepared, or the last one needs a person's eye. */
export function badgeShown(view: UpgradeView | undefined): boolean {
  if (!view?.enabled) return false
  const state = view.run?.state
  return view.available || (!!state && (ACTIVE.includes(state) || state === 'prepared' || ['failed', 'rolledBack', 'down'].includes(state)))
}
export function badgeTone(view: UpgradeView): 'update' | 'running' | 'problem' | 'ready' {
  const state = view.run?.state
  if (state && ACTIVE.includes(state)) return 'running'
  if (state === 'prepared' && view.prepared) return 'ready'
  if (state && ['failed', 'rolledBack', 'down'].includes(state) && !view.available) return 'problem'
  return 'update'
}

const plainMessages = (t: T): ApiMessages => ({ offline: t('offline'), notRunning: t('hostNotRunning'),
  serverError: status => t('serverError', { status }), requestFailed: status => t('requestFailed', { status }),
  setup: () => t('requestFailed', { status: 400 }), user: () => t('requestFailed', { status: 400 }) })

/** The footer action: a small dot-and-label button that opens the update dialog. */
export function UpgradeBadge({ t, wide }: { t: T; wide: boolean }) {
  const [view, setView] = useState<UpgradeView>()
  const [app, setApp] = useState<AppUpgradeView>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const call = caller(() => plainMessages(t))
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      call('GET upgrade').then(next => { if (active) setView(next) }, () => { /* Restarting or an older host: keep the last view. */ })
      call('GET app-upgrade').then(next => { if (active) setApp(next) }, () => { /* An older host has no desktop app track. */ })
        .finally(() => { if (active) timer = setTimeout(load, open ? DIALOG_POLL_MS : BADGE_POLL_MS) })
    }
    load()
    return () => { active = false; clearTimeout(timer) }
  }, [t, open])
  const pluginShown = badgeShown(view)
  if (!pluginShown && !appBadgeShown(app) && !open) return null
  const tone = pluginShown && view ? badgeTone(view) : app ? appBadgeTone(app) : 'update'
  const label = tone === 'running' ? t('upgradeBadgeRunning') : tone === 'problem' ? t('upgradeBadgeProblem')
    : tone === 'ready' ? t('upgradeBadgeReady') : t('upgradeBadge')
  return <>
    <button type="button" className="dt-upgrade-badge" data-tone={tone} data-wide={wide} title={label} aria-label={label}
      onClick={() => setOpen(true)}>
      <span className="dt-upgrade-dot" aria-hidden="true" />{wide && <span>{label}</span>}
    </button>
    {open && <PanelProvider t={t} interval={30_000}><UpgradeDialog view={view} onClose={() => setOpen(false)} onView={setView} /></PanelProvider>}
  </>
}

function stepState(step: UpgradeStep): 'running' | 'done' | 'failed' | 'skipped' { return step.state }
/**
 * The update dialog: what is new, the prepare button that builds without touching the running service, and the restart the
 * prepared build waits for; the steps of a running or the last update.
 */
export function UpgradeDialog({ view, onClose, onView }: { view: UpgradeView | undefined; onClose: () => void; onView: (view: UpgradeView) => void }) {
  const { t, call } = usePanel()
  const reload = async () => { onView(await call('GET upgrade')) }
  const check = useAction(async () => { onView(await call('POST upgrade/check')) })
  const prepare = useAction(async () => { await call('POST upgrade/prepare') }, { reload })
  const apply = useAction(async (force: boolean) => { await call('POST upgrade/apply', { body: { force } }) }, { reload })
  const cancel = useAction(async () => { await call('POST upgrade/cancel') }, { reload })
  const [app, setApp] = useState<AppUpgradeView>()
  const appRef = useRef<AppUpgradeView>()
  const buildApp = useAction(async () => { await call('POST app-upgrade/build') }, { reload: async () => { setApp(await call('GET app-upgrade')) } })
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      void call('GET app-upgrade').then((next) => {
        if (!active) return
        appRef.current = next
        setApp(next)
      }, () => { /* An older host has no app track; the section stays hidden. */ })
        .finally(() => {
          if (active) timer = setTimeout(load, appRef.current?.run?.state === 'preparing' ? 2_000 : 15_000)
        })
    }
    load()
    return () => { active = false; clearTimeout(timer) }
  }, [call])
  const run = view?.run ?? null
  const active = !!run && ACTIVE.includes(run.state)
  const prepared = view?.prepared ?? null
  // A build this host has moved past by hand has nothing left to restart into, though its steps and outcome stay readable.
  const canApply = !!prepared && prepared.sha !== view?.installed
  const canPrepare = !active && !prepared && !!view?.available && !view.blocked
  const canPrepareNewer = !active && !!prepared && !!view?.available && !view.blocked && view.remote.sha !== prepared.sha
  const running = view?.running ?? 0
  const footer = <>
    {!!run && ['preparing', 'waiting', 'prepared'].includes(run.state) && <Button variant="ghost" disabled={cancel.busy}
      onClick={() => { void cancel.run() }}>{t('upgradeCancel')}</Button>}
    {!active && <Button variant="ghost" icon={<Icon name="refresh" size={14} />} disabled={check.busy} onClick={() => { void check.run() }}>{t('upgradeCheck')}</Button>}
    {canPrepareNewer && <Button variant="outline" disabled={prepare.busy} onClick={() => { void prepare.run() }}>{t('upgradeReprepare')}</Button>}
    {canPrepare && <Button variant="primary" disabled={prepare.busy} onClick={() => { void prepare.run() }}>{t('upgradePrepare')}</Button>}
    {canApply && running > 0 && <Button variant="outline" disabled={apply.busy}
      onClick={() => { void apply.run(true) }}>{t('upgradeApplyNow')}</Button>}
    {canApply && <Button variant="primary" disabled={apply.busy}
      onClick={() => { void apply.run(false) }}>{running > 0 ? t('upgradeWhenIdle') : t('upgradeApply')}</Button>}
  </>
  return <Modal open onClose={onClose} title={t('upgradeTitle')} closeLabel={t('close')} className="dt-upgrade-modal" footer={footer}>
    {!view ? <p className="dt-hint">{t('loading')}</p> : <div className="dt-upgrade-body">
      <p className="dt-upgrade-versions">
        <span>{t('upgradeInstalled')} <code className="dt-mono">{short(view.installed)}</code></span>
        <span>{view.remote.ref} <code className="dt-mono">{short(view.remote.sha)}</code></span>
        {prepared && <span>{t('upgradePreparedVersion')} <code className="dt-mono">{short(prepared.sha)}</code></span>}
        {view.remote.checkedAt && <span className="dt-hint">{t('upgradeChecked')} <When at={view.remote.checkedAt} /></span>}
      </p>
      {view.remote.error && <p className="dt-error" role="alert">{t('upgradeFetchFailed')}: {view.remote.error}</p>}
      {view.blocked === 'dependencies' && <p className="dt-banner">{t('upgradeBlockedDependencies')}</p>}
      {!view.installed && view.remote.sha && <p className="dt-hint">{t('upgradeUnknownInstalled')}</p>}
      {prepared ? <p className="dt-hint">{canApply ? t('upgradePreparedHint', { sha: short(prepared.sha) }) : t('upgradePreparedCurrent')}</p>
        : view.available && !active ? <p className="dt-hint">{t('upgradePrepareHint')}</p> : null}
      {canApply && view.running > 0 && !active && <p className="dt-hint">{t('upgradeRunningHint', { count: view.running })}</p>}
      {view.behind.length > 0 && !active && <ul className="dt-upgrade-commits">
        {view.behind.map(commit => <li key={commit.sha}><code className="dt-mono">{short(commit.sha)}</code><span>{commit.subject}</span></li>)}
        {view.more && <li className="dt-hint">{t('upgradeMore')}</li>}
      </ul>}
      {!view.available && !run && <p className="dt-hint">{t('upgradeCurrent')}</p>}
      {run && <RunSteps run={run} />}
      <AppUpgradeSection view={app} building={buildApp.busy} onBuild={() => { void buildApp.run() }} />
    </div>}
  </Modal>
}

function RunSteps({ run }: { run: UpgradeRun }) {
  const { t } = usePanel()
  const outcome = run.state === 'done' ? t('upgradeDone', { sha: short(run.sha) }) : run.state === 'rolledBack' ? t('upgradeRolledBack')
    : run.state === 'down' ? t('upgradeDown') : run.state === 'failed' ? t('upgradeFailed') : run.state === 'cancelled' ? t('upgradeCancelled')
    : run.state === 'switching' ? t('upgradeSwitching') : run.state === 'waiting' ? t('upgradeWaiting')
    : run.state === 'prepared' ? t('upgradePrepared') : t('upgradePreparing')
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

/** The desktop app track below the plugin update: fork/official versions, the build button, its steps and installer. */
function AppUpgradeSection({ view, building, onBuild }: { view: AppUpgradeView | undefined; building: boolean; onBuild: () => void }) {
  const { t } = usePanel()
  if (!view) return null
  const blocked = view.blocked
  const blockedText = blocked === 'dirty' ? t('appUpgradeBlockedDirty')
    : blocked === 'out-of-sync' ? t('appUpgradeBlockedOutOfSync', { sha: short(view.fork.sha) })
    : blocked === 'unchecked' ? t('appUpgradeBlockedUnchecked')
    : blocked === 'current' ? t('appUpgradeBlockedCurrent') : undefined
  const running = view.run?.state === 'preparing'
  const ready = view.ready
  return <section className="dt-app-upgrade">
    <h3>{t('appUpgradeTitle')}</h3>
    {!view.enabled ? <p className="dt-hint">{t('appUpgradeDisabled')}</p> : <>
      <p className="dt-upgrade-versions">
        <span>{t('appUpgradeInstalled')} <code className="dt-mono">{short(view.installed.commit)}</code></span>
        <span>{t('appUpgradeFork')} <code className="dt-mono">{view.fork.ref}@{short(view.fork.sha)}</code></span>
        <span>{t('appUpgradeOfficial')} <code className="dt-mono">{view.official.ref}@{short(view.official.sha)}</code></span>
      </p>
      {view.fork.error && <p className="dt-error" role="alert">{t('upgradeFetchFailed')}: {view.fork.error}</p>}
      {!view.installed.commit && <p className="dt-hint">{t('upgradeUnknownInstalled')}</p>}
      {view.officialAhead.count !== null && view.officialAhead.count > 0
        && <p className="dt-hint">{t('appUpgradeOfficialAhead', { count: view.officialAhead.count })}</p>}
      {view.available ? <p className="dt-hint">{t('appUpgradeAvailable')}</p> : <p className="dt-hint">{t('appUpgradeCurrent')}</p>}
      {view.available && (blockedText !== undefined
        ? <p className="dt-hint">{blockedText}</p>
        : <Button variant="primary" disabled={building || running} onClick={onBuild}>{ready ? t('appUpgradeRebuild') : t('appUpgradeBuild')}</Button>)}
      {running && <p className="dt-hint">{t('appUpgradeRunning')}</p>}
      {view.run && <AppRunSteps run={view.run} />}
      {ready && <>
        <p className="dt-upgrade-outcome">{t('appUpgradeReady')}</p>
        <p><code className="dt-mono">{ready.artifact}</code></p>
        <p className="dt-hint">{t('appUpgradeInstallHint')}</p>
      </>}
    </>}
  </section>
}

/** The build steps and outcome of one desktop app build. */
function AppRunSteps({ run }: { run: AppUpgradeRun }) {
  const { t } = usePanel()
  const outcome = run.state === 'done' ? t('appUpgradeDone') : run.state === 'failed' ? t('appUpgradeFailed')
    : run.state === 'interrupted' ? t('appUpgradeInterrupted') : t('appUpgradeRunning')
  return <div className="dt-upgrade-run" data-state={run.state === 'interrupted' ? 'failed' : run.state}>
    <p className="dt-upgrade-outcome" role="status">{outcome}</p>
    {run.error && <pre className="dt-upgrade-error">{run.error}</pre>}
    <ol className="dt-upgrade-steps">
      {run.steps.map(step => <li key={step.name} data-state={step.state}>
        <Icon name={step.state === 'done' ? 'check' : step.state === 'failed' ? 'alert' : 'running'} size={14} />
        <span>{t(`appUpgradeStep.${step.name}` as never)}</span>
        {step.detail && <span className="dt-hint">{step.detail}</span>}
      </li>)}
    </ol>
  </div>
}