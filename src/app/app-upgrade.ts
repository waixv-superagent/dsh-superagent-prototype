/**
 * Desktop app update: check the DSH fork and the official upstream, and build a new installer from the configured checkout
 * when a person asks. The running app is never replaced here: a finished build waits for the person to quit the App, install
 * the new one, and relaunch, where the launch window reconnects or starts the Host again.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { UpgradeConfig } from '../deployment.ts'
import { parseCommits, systemRunner, type Runner, type UpgradeCommit } from './upgrade.ts'

/** The steps of one desktop app build, in order. */
export const APP_UPGRADE_STEPS = ['fetch', 'verify', 'build', 'locate'] as const
export type AppUpgradeStepName = typeof APP_UPGRADE_STEPS[number]
export interface AppUpgradeStep { name: AppUpgradeStepName; state: 'running' | 'done' | 'failed'; detail: string; at: string }
export type AppUpgradeRunState = 'preparing' | 'done' | 'failed' | 'interrupted'
export interface AppUpgradeRun {
  state: AppUpgradeRunState
  sha: string
  startedAt: string
  endedAt?: string
  steps: AppUpgradeStep[]
  error: string | null
  /** Absolute installer path once the build finished. */
  artifact: string | null
}
/** What the installed application records about the source it was built from. */
export interface AppInstalled { commit: string | null; version: string | null }
/** One remote branch the panel compares against. */
export interface AppRemoteView { ref: string; sha: string | null; checkedAt: string | null; error: string | null }
/** Why this host cannot build the checked out fork right now. */
export type AppUpgradeBlocked = 'disabled' | 'unchecked' | 'current' | 'dirty' | 'out-of-sync'
/** What the panel renders for the desktop app track. */
export interface AppUpgradeView {
  enabled: boolean
  installed: AppInstalled
  fork: AppRemoteView
  official: AppRemoteView
  /** Fork commits the installed build lacks, newest first. */
  behind: UpgradeCommit[]
  more: boolean
  /** Official commits the fork branch lacks, newest first, with their count when it is known. */
  officialAhead: { count: number | null; commits: UpgradeCommit[] }
  available: boolean
  blocked: AppUpgradeBlocked | null
  run: AppUpgradeRun | null
  /** A finished build whose installer still exists. */
  ready: { sha: string; artifact: string; builtAt: string } | null
}
/** What the desktop build needs from the host; tests pass fakes. */
export interface AppUpgradeHost {
  config: UpgradeConfig
  stateDir: string
  warn(message: string): void
  /** Defaults to this machine's git and pnpm. */
  run?: Runner
  now?: () => number
  /** Defaults to the packaged application's own manifest. */
  installed?: () => AppInstalled
  /** Defaults to the newest installer the desktop build wrote. */
  findArtifact?: (since: number) => string | undefined
}
/** A build request the checked state does not allow. */
export class AppUpgradeRefused extends Error {
  constructor(readonly code: AppUpgradeBlocked | 'running') { super(code) }
}

const MAX_COMMITS = 30
const MAX_OFFICIAL = 10
const FETCH_TIMEOUT_MS = 2 * 60_000
/** A full unsigned Windows package, including its dependency install and Electron download, may run for hours. */
const BUILD_TIMEOUT_MS = 3 * 60 * 60_000
const LOG_TAIL = 4_000
const tail = (text: string): string => text.length > LOG_TAIL ? `…${text.slice(-LOG_TAIL)}` : text
const isCommit = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{7,40}$/u.test(value)

/** Read the installed desktop application's own manifest, including the commit its build recorded. */
export function readInstalledApp(): AppInstalled {
  // Electron adds `resourcesPath`; the plugin's own types compile against plain Node.
  const resources = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath
  const candidates = [
    ...(resources === undefined || resources === '' ? [] : [join(resources, 'app.asar', 'package.json')]),
    join(dirname(process.execPath), 'resources', 'app.asar', 'package.json'),
  ]
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dshBuildCommit?: unknown; version?: unknown }
      return { commit: isCommit(manifest.dshBuildCommit) ? manifest.dshBuildCommit : null,
        version: typeof manifest.version === 'string' ? manifest.version : null }
    } catch { /* Try the next layout. */ }
  }
  return { commit: null, version: null }
}

/** The directory the unsigned desktop build writes its installer into. */
export function appArtifactDirectory(checkout: string, configured: string): string {
  if (configured !== '') return isAbsolute(configured) ? configured : join(checkout, configured)
  return join(checkout, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts')
}

/**
 * The newest installer the build wrote at or after `since`.
 * @param checkout - DSH fork checkout.
 * @param configured - Configured artifact directory, or empty for the unsigned build default.
 * @param since - Build start in milliseconds.
 */
export function newestInstaller(checkout: string, configured: string, since: number): string | undefined {
  const directory = appArtifactDirectory(checkout, configured)
  try {
    return readdirSync(directory)
      .filter(name => name.toLowerCase().endsWith('.exe'))
      .map(name => resolve(directory, name))
      .filter(path => statSync(path).mtimeMs >= since)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
  } catch { return undefined }
}

/** Compare the fork, the official upstream and the installed application, and run one build at a time. */
export class AppUpgrade {
  private readonly config: UpgradeConfig
  private readonly run: Runner
  private readonly now: () => number
  private readonly installed: () => AppInstalled
  private readonly findArtifact: (since: number) => string | undefined
  private fork: AppRemoteView
  private official: AppRemoteView
  private behind: UpgradeCommit[] = []
  private more = false
  private officialAhead: AppUpgradeView['officialAhead'] = { count: null, commits: [] }
  private checkout: { head: string; dirty: boolean } | undefined
  private current: AppUpgradeRun | null
  private timer?: ReturnType<typeof setInterval>
  private checking?: Promise<void>
  private stopped = false

  /** @param host - Machine settings, state directory, and the effects of this machine. */
  constructor(private readonly host: AppUpgradeHost) {
    this.config = host.config
    this.run = host.run ?? systemRunner
    this.now = host.now ?? Date.now
    this.installed = host.installed ?? readInstalledApp
    this.findArtifact = host.findArtifact
      ?? (since => newestInstaller(this.config.appCheckout, this.config.appArtifacts, since))
    this.fork = { ref: `${this.config.appRemote}/${this.config.appBranch}`, sha: null, checkedAt: null, error: null }
    this.official = { ref: `${this.config.appOfficialRemote}/${this.config.appOfficialBranch}`, sha: null, checkedAt: null, error: null }
    this.current = this.readLast()
  }

  /** False when no DSH fork checkout is configured: the panel offers nothing and checks nothing. */
  get enabled(): boolean { return this.config.appCheckout !== '' }
  private get directory(): string { return join(this.host.stateDir, 'app-upgrade') }
  private get statusFile(): string { return join(this.directory, 'status.json') }
  private iso(): string { return new Date(this.now()).toISOString() }

  /** The last run, with one a previous host left mid-build marked as interrupted instead of staying forever `preparing`. */
  private readLast(): AppUpgradeRun | null {
    try {
      const run = JSON.parse(readFileSync(this.statusFile, 'utf8')) as AppUpgradeRun
      if (run.state !== 'preparing') return run
      return { ...run, state: 'interrupted', error: run.error ?? 'the host restarted while the build ran' }
    } catch { return null }
  }

  /** Begin the check timer; a check failure is shown in the view and retried at the next interval. */
  start(): void {
    if (!this.enabled) return
    void this.check()
    this.timer = setInterval(() => { void this.check() }, this.config.appIntervalMin * 60_000)
  }

  stop(): void { this.stopped = true; if (this.timer !== undefined) clearInterval(this.timer) }

  view(): AppUpgradeView {
    const installed = this.installed()
    const run = this.current
    const installedCommit = installed.commit
    const available = this.enabled && this.fork.sha !== null && this.fork.sha !== installedCommit
    return {
      enabled: this.enabled,
      installed,
      fork: this.fork,
      official: this.official,
      behind: this.behind,
      more: this.more,
      officialAhead: this.officialAhead,
      available,
      blocked: this.blockedState(installedCommit),
      run,
      ready: run?.state === 'done' && run.artifact !== null && existsSync(run.artifact)
        ? { sha: run.sha, artifact: run.artifact, builtAt: run.endedAt ?? run.startedAt }
        : null,
    }
  }

  /** Why a build cannot start now, or null when it can. */
  private blockedState(installedCommit = this.installed().commit): AppUpgradeBlocked | null {
    if (!this.enabled) return 'disabled'
    if (this.fork.sha === null) return 'unchecked'
    if (this.fork.sha === installedCommit) return 'current'
    if (this.checkout === undefined) return 'unchecked'
    if (this.checkout.dirty) return 'dirty'
    if (this.checkout.head !== this.fork.sha) return 'out-of-sync'
    return null
  }

  /** Fetch the fork and the official upstream and compare both with the installed build. */
  check(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve()
    return this.checking ??= this.fetchAndCompare().finally(() => { this.checking = undefined })
  }

  private git(args: string[], timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
    return this.run.command('git', ['-C', this.config.appCheckout, ...args], { cwd: this.config.appCheckout, timeoutMs })
  }

  private async fetchAndCompare(): Promise<void> {
    try {
      await this.git(['fetch', '--quiet', this.config.appRemote, this.config.appBranch])
      const sha = (await this.git(['rev-parse', `refs/remotes/${this.config.appRemote}/${this.config.appBranch}`])).trim()
      this.fork = { ...this.fork, sha, checkedAt: this.iso(), error: null }
      const installed = this.installed().commit
      if (sha !== installed) {
        const known = installed !== null && await this.git(['cat-file', '-e', `${installed}^{commit}`]).then(() => true, () => false)
        const range = known ? `${installed}..${sha}` : sha
        const commits = parseCommits(await this.git(['log', `--max-count=${MAX_COMMITS + 1}`, '--format=%H%x1f%s%x1f%an%x1f%cI', range]))
        this.more = !known || commits.length > MAX_COMMITS
        this.behind = commits.slice(0, MAX_COMMITS)
      } else {
        this.more = false
        this.behind = []
      }
      const head = (await this.git(['rev-parse', 'HEAD'])).trim()
      const dirty = (await this.git(['status', '--porcelain', '--untracked-files=normal'])).trim() !== ''
      this.checkout = { head, dirty }
    } catch (error) {
      this.fork = { ...this.fork, checkedAt: this.iso(), error: tail(String((error as Error).message ?? error)) }
    }
    try {
      await this.git(['fetch', '--quiet', this.config.appOfficialRemote, this.config.appOfficialBranch])
      const sha = (await this.git(['rev-parse', `refs/remotes/${this.config.appOfficialRemote}/${this.config.appOfficialBranch}`])).trim()
      this.official = { ...this.official, sha, checkedAt: this.iso(), error: null }
      if (this.fork.sha !== null) {
        const count = Number((await this.git(['rev-list', '--count', `${this.fork.sha}..${sha}`])).trim())
        const commits = parseCommits(await this.git(['log', `--max-count=${MAX_OFFICIAL}`, '--format=%H%x1f%s%x1f%an%x1f%cI',
          `${this.fork.sha}..${sha}`]))
        this.officialAhead = { count: Number.isSafeInteger(count) ? count : null, commits }
      }
    } catch (error) {
      this.official = { ...this.official, checkedAt: this.iso(), error: tail(String((error as Error).message ?? error)) }
    }
  }

  /**
   * Start one build of the checked fork commit in the configured checkout. The checkout must be clean and exactly at that
   * commit; a build never changes the branch or pulls on its own.
   * @returns the run the panel polls.
   * @throws AppUpgradeRefused when the checked state does not offer a build.
   */
  build(): AppUpgradeRun {
    if (this.current?.state === 'preparing') throw new AppUpgradeRefused('running')
    const blocked = this.blockedState()
    if (blocked !== null) throw new AppUpgradeRefused(blocked)
    const sha = this.fork.sha!
    const run: AppUpgradeRun = { state: 'preparing', sha, startedAt: this.iso(), steps: [], error: null, artifact: null }
    this.current = run
    this.persist(run)
    void this.buildRun(run).catch((error: unknown) => {
      this.host.warn(`desktop app update failed: ${String(error)}`)
      this.fail(run, String((error as Error).message ?? error))
    })
    return run
  }

  private async buildRun(run: AppUpgradeRun): Promise<void> {
    const started = this.now()
    try {
      await this.stage(run, 'fetch', async () => {
        await this.git(['fetch', '--quiet', this.config.appRemote, this.config.appBranch])
        return `${this.config.appRemote}/${this.config.appBranch}`
      })
      await this.stage(run, 'verify', async () => {
        const head = (await this.git(['rev-parse', 'HEAD'])).trim()
        if (head !== run.sha) throw new Error(`The checkout is at ${head.slice(0, 7)}, not ${run.sha.slice(0, 7)}`)
        const dirty = (await this.git(['status', '--porcelain', '--untracked-files=normal'])).trim()
        if (dirty !== '') throw new Error('The checkout has uncommitted changes')
        return run.sha.slice(0, 7)
      })
      await this.stage(run, 'build', async () => {
        await this.run.command(this.config.appPnpm || this.config.pnpm, ['run', this.config.appBuildScript],
          { cwd: this.config.appCheckout, timeoutMs: BUILD_TIMEOUT_MS, shell: process.platform === 'win32' })
        return this.config.appBuildScript
      })
      await this.stage(run, 'locate', async () => {
        const artifact = this.findArtifact(started)
        if (artifact === undefined) throw new Error('The build finished but no installer was found')
        run.artifact = artifact
        return artifact
      })
      if (run.state !== 'preparing') return
      run.state = 'done'
      run.endedAt = this.iso()
      this.persist(run)
    } catch (error) {
      this.fail(run, String((error as Error).message ?? error))
    }
  }

  private async stage(run: AppUpgradeRun, name: AppUpgradeStepName, work: () => Promise<string>): Promise<void> {
    const step: AppUpgradeStep = { name, state: 'running', detail: '', at: this.iso() }
    run.steps.push(step)
    this.persist(run)
    const detail = await work()
    Object.assign(step, { state: 'done', detail, at: this.iso() })
    this.persist(run)
  }

  private fail(run: AppUpgradeRun, error: string): void {
    run.state = 'failed'
    run.error = error
    run.endedAt = this.iso()
    const last = run.steps.at(-1)
    if (last?.state === 'running') Object.assign(last, { state: 'failed', detail: error, at: this.iso() })
    this.persist(run)
  }

  private persist(run: AppUpgradeRun): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.statusFile, `${JSON.stringify(run, null, 2)}\n`)
    } catch { /* The panel still shows the in-memory run. */ }
  }
}
