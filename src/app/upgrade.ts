/**
 * One-click update of dsh-superagent from its fork: notices when the configured branch moved past the installed build, builds
 * the new commit in a separate worktree, waits until no worker is mid-turn, then hands the switch to an external process
 * (`scripts/upgrade-switch.mjs`) that replaces the installed package, restarts the service and rolls back on failure.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { NO_UPGRADE, type UpgradeConfig } from '../deployment.ts'

const exec = promisify(execFile)
/** The installed package records the commit it was built from here; the switch writes it. */
export const BUILD_INFO = 'build-info.json'
/** A fetch or build step slower than this is stuck; a build here runs the whole test suite, which takes about a minute. */
const STEP_TIMEOUT_MS = 20 * 60_000
const FETCH_TIMEOUT_MS = 2 * 60_000
const MAX_COMMITS = 30
const LOG_TAIL = 4_000
/** A switch a starting host finds in progress is normally finalizing; only one this old has died without writing its outcome. */
const SWITCH_STALE_MS = 20 * 60_000

/** The steps of one update, in order; the last four run in the switch process after this host stopped. */
export const UPGRADE_STEPS = ['fetch', 'worktree', 'install', 'typecheck', 'test', 'build', 'pause', 'idle', 'stop', 'backup', 'replace',
  'start', 'rollback', 'restart', 'resume'] as const
export type UpgradeStepName = typeof UPGRADE_STEPS[number]
export interface UpgradeStep { name: UpgradeStepName; state: 'running' | 'done' | 'failed' | 'skipped'; detail: string; at: string }
export interface UpgradeCommit { sha: string; subject: string; author: string; at: string }
/**
 * The update an update action is running, or the last one's outcome. `done`, `rolledBack` and `down` come from the switch
 * process: the host that started an update is gone by then, and its successor reads them from the status file.
 */
export type UpgradeState = 'idle' | 'preparing' | 'waiting' | 'switching' | 'done' | 'failed' | 'rolledBack' | 'down' | 'cancelled'
export interface UpgradeRun {
  state: UpgradeState
  sha: string
  from: string | null
  startedAt: string
  endedAt?: string
  steps: UpgradeStep[]
  error: string | null
  rolledBack?: boolean
}
export interface UpgradeView {
  /** False when no checkout is configured: the panel shows no badge and offers nothing. */
  enabled: boolean
  /** The commit the running package was built from, or null when it records none (a build installed by hand). */
  installed: string | null
  remote: { ref: string; sha: string | null; checkedAt: string | null; error: string | null }
  /** Commits on the remote branch the installed build does not contain, newest first, at most 30. */
  behind: UpgradeCommit[]
  /** More commits than `behind` lists, or the installed commit is not an ancestor and the count is unknown. */
  more: boolean
  available: boolean
  /** Why an update cannot start now, such as a dependency change the switch cannot install. */
  blocked: string | null
  run: UpgradeRun | null
  running: number
}

/** What the update needs from the host; the Runtime passes its own pieces, tests pass fakes. */
export interface UpgradeHost {
  config: UpgradeConfig
  stateDir: string
  /** Executor sessions in an active turn or with jobs still running; an update waits for zero. */
  activeCount(): number
  paused(): boolean
  pause(paused: boolean): Promise<unknown>
  /** The loopback URL of this host's management API, which the switch polls. */
  url(): string | undefined
  /** Stop this host process so the switch can replace its files; the switch waits for this pid to exit. */
  exit(): void
  warn(message: string): void
  /** Defaults to the git, pnpm and process effects of this machine. */
  run?: Runner
  now?: () => number
}
export interface Runner {
  /** Runs a command and resolves its stdout, or rejects with its output. */
  command(file: string, args: string[], options: { cwd: string; timeoutMs: number; shell?: boolean }): Promise<string>
  /** Starts the switch process detached from this one, so it outlives this host. */
  detach(file: string, args: string[], options: { cwd: string; log: string }): void
  read(path: string): string | undefined
  write(path: string, text: string): void
  exists(path: string): boolean
}
/** The git, pnpm and process effects of this machine. */
export const systemRunner: Runner = {
  command: async (file, args, { cwd, timeoutMs, shell }) => {
    try {
      const { stdout } = await exec(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 << 20, windowsHide: true, shell: shell ?? false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' } })
      return stdout
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string }
      throw new Error(tail(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.trim() || String(failure.message ?? error)))
    }
  },
  detach: (file, args, { cwd, log }) => {
    mkdirSync(dirname(log), { recursive: true })
    if (process.platform === 'win32') {
      // A child of this process stays in its job object, which a launcher may close with the process; WMI starts the switch
      // under its own provider host instead, so it outlives the host it replaces.
      const line = `cmd /d /s /c "${[file, ...args].map(quote).join(' ')} >> ${quote(log)} 2>&1"`
      const script = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(line)}; CurrentDirectory = ${psQuote(cwd)} } | Out-Null`
      // An encoded command reaches PowerShell without another round of command-line quoting.
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd, windowsHide: true, stdio: 'ignore' })
      child.unref()
      return
    }
    const out = openLog(log)
    const child = spawn(file, args, { cwd, detached: true, windowsHide: true, stdio: ['ignore', out, out] })
    child.unref()
  },
  read: path => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
  write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) },
  exists: path => existsSync(path),
}
function openLog(path: string): 'ignore' | number {
  try { return openSync(path, 'a') } catch { return 'ignore' }
}

/** Windows paths cannot contain a double quote, so wrapping is enough. */
const quote = (value: string): string => `\"${value}\"`
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const tail = (text: string): string => text.length > LOG_TAIL ? `…${text.slice(-LOG_TAIL)}` : text
/** The package directory this module runs from: `lib/` of the installed package, or `src/app/` of a checkout under test. */
export function packageRoot(from = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from)
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return resolve(dirname(from), '..')
}
/** The commit an installed package records, or null for one installed by hand. */
export function installedCommit(read: (path: string) => string | undefined, install: string): string | null {
  const text = read(join(install, BUILD_INFO))
  if (!text) return null
  try {
    const sha = (JSON.parse(text) as { sha?: unknown }).sha
    return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
  } catch { return null }
}
/** Parse `git log --format=%H%x1f%s%x1f%an%x1f%cI` output. */
export function parseCommits(text: string): UpgradeCommit[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).flatMap(line => {
    const [sha, subject, author, at] = line.split('\x1f')
    return sha && /^[0-9a-f]{40}$/.test(sha) ? [{ sha, subject: subject ?? '', author: author ?? '', at: at ?? '' }] : []
  })
}
/**
 * Whether the dependencies changed between two commits. The switch replaces only the package's own files and keeps the
 * profile's installed `node_modules`, so a build with new dependencies would start against the old ones.
 */
export function dependenciesChanged(diff: string): boolean {
  return diff.split('\n').some(path => ['package.json', 'pnpm-lock.yaml'].includes(path.trim()))
}
/** True when a dependency diff of package.json touches only fields the switch does not depend on. */
export function onlyVersionFields(before: string, after: string): boolean {
  try {
    const keys = ['dependencies', 'peerDependencies', 'optionalDependencies', 'engines'] as const
    const a = JSON.parse(before) as Record<string, unknown>, b = JSON.parse(after) as Record<string, unknown>
    return keys.every(key => JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null))
  } catch { return false }
}

/**
 * Checks for and runs updates of this installation. Runs on its own timer, never inside a pass; an update holds processing
 * paused from the moment it waits for workers until the switch resumes it, and keeps an existing pause in place.
 */
export class Upgrade {
  private readonly config: UpgradeConfig
  private readonly run: Runner
  private readonly now: () => number
  private readonly install: string
  private readonly root: string
  private remote: UpgradeView['remote']
  private behind: UpgradeCommit[] = []
  private more = false
  private blocked: string | null = null
  private current: UpgradeRun | null = null
  private timer?: ReturnType<typeof setInterval>
  private checking?: Promise<void>
  private cancelled = false
  private stopped = false
  constructor(private readonly host: UpgradeHost) {
    this.config = { ...NO_UPGRADE, ...host.config }
    this.run = host.run ?? systemRunner
    this.now = host.now ?? Date.now
    this.root = packageRoot()
    this.install = this.config.install || this.root
    this.remote = { ref: `${this.config.remote}/${this.config.branch}`, sha: null, checkedAt: null, error: null }
    this.current = this.readLast()
  }
  get enabled(): boolean { return this.config.checkout !== '' }
  private get dir(): string { return join(this.host.stateDir, 'upgrade') }
  private get statusFile(): string { return join(this.dir, 'status.json') }
  private iso(): string { return new Date(this.now()).toISOString() }
  /** The last switch outcome its process wrote, which survives the restart that ended the host that started it. */
  private readLast(): UpgradeRun | null {
    const text = this.run.read(this.statusFile)
    if (!text) return null
    try {
      const run = JSON.parse(text) as UpgradeRun
      // A host that starts while the switch is still finalizing finds `switching` and must not call it dead: the switch
      // starts this host and only then writes the outcome. One this old really has ended without a word.
      if (run.state !== 'switching') return run
      const started = Date.parse(run.startedAt)
      if (Number.isFinite(started) && this.now() - started > SWITCH_STALE_MS) {
        return { ...run, state: 'down', error: run.error ?? 'The switch process stopped before it finished' }
      }
      return run
    } catch { return null }
  }
  start(): void {
    if (!this.enabled) return
    // Record this host's pid for the switch, so a rollback can stop a host a start script launched.
    try { this.run.write(join(this.dir, 'host.pid'), `${process.pid}\n`) } catch { /* Only the rollback of a later switch reads it. */ }
    void this.check()
    this.timer = setInterval(() => { void this.check() }, this.config.intervalMin * 60_000)
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer) }

  view(): UpgradeView {
    // While a switch is finishing, the file it writes is the source of truth: this host started before the switch wrote
    // its outcome, so a cached `switching` must give way to the final state.
    if (this.current?.state === 'switching') {
      const latest = this.readLast()
      if (latest && latest.state !== 'switching') this.current = latest
    }
    const installed = installedCommit(this.run.read, this.install)
    const busy = !!this.current && ['preparing', 'waiting', 'switching'].includes(this.current.state)
    return { enabled: this.enabled, installed, remote: this.remote, behind: this.behind, more: this.more,
      available: this.enabled && !!this.remote.sha && this.remote.sha !== installed && !busy,
      blocked: this.blocked, run: this.current, running: this.host.activeCount() }
  }

  /** Fetch the branch and list what the installed build lacks; concurrent calls share one fetch. */
  check(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve()
    return this.checking ??= this.fetchAndCompare().finally(() => { this.checking = undefined })
  }
  private git(args: string[], timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
    return this.run.command('git', ['-C', this.config.checkout, ...args], { cwd: this.config.checkout, timeoutMs })
  }
  private async fetchAndCompare(): Promise<void> {
    const ref = this.remote.ref
    try {
      await this.git(['fetch', '--quiet', this.config.remote, this.config.branch])
      const sha = (await this.git(['rev-parse', `refs/remotes/${ref}`])).trim()
      const installed = installedCommit(this.run.read, this.install)
      let behind: UpgradeCommit[] = [], more = false, blocked: string | null = null
      if (sha !== installed) {
        const known = installed ? await this.git(['cat-file', '-e', `${installed}^{commit}`]).then(() => true, () => false) : false
        const range = known ? `${installed}..${sha}` : sha
        behind = parseCommits(await this.git(['log', `--max-count=${MAX_COMMITS + 1}`, '--format=%H%x1f%s%x1f%an%x1f%cI', range]))
        more = !known || behind.length > MAX_COMMITS
        behind = behind.slice(0, MAX_COMMITS)
        if (known && dependenciesChanged(await this.git(['diff', '--name-only', installed!, sha]))) {
          const before = await this.git(['show', `${installed!}:package.json`]), after = await this.git(['show', `${sha}:package.json`])
          const lockChanged = (await this.git(['diff', '--name-only', installed!, sha, '--', 'pnpm-lock.yaml'])).trim() !== ''
          if (lockChanged || !onlyVersionFields(before, after)) blocked = 'dependencies'
        }
      }
      this.remote = { ref, sha, checkedAt: this.iso(), error: null }
      Object.assign(this, { behind, more, blocked })
    } catch (error) {
      this.remote = { ...this.remote, checkedAt: this.iso(), error: tail(String((error as Error).message ?? error)) }
    }
  }

  /**
   * Start an update to the remote commit last checked. Returns at once; the panel polls `view()` for its steps.
   * @param force - skip waiting for running workers; they restart with a recovery note.
   */
  begin(force = false): UpgradeRun {
    if (!this.enabled) throw new UpgradeRefused('disabled')
    if (this.current && ['preparing', 'waiting', 'switching'].includes(this.current.state)) throw new UpgradeRefused('running')
    const sha = this.remote.sha
    if (!sha) throw new UpgradeRefused('unchecked')
    if (this.blocked) throw new UpgradeRefused(this.blocked)
    const from = installedCommit(this.run.read, this.install)
    if (sha === from) throw new UpgradeRefused('current')
    this.cancelled = false
    const run: UpgradeRun = this.current = { state: 'preparing', sha, from, startedAt: this.iso(), steps: [], error: null }
    void this.prepareAndSwitch(run, force).catch(error => {
      this.host.warn(`dsh-superagent update failed: ${String(error)}`)
      this.fail(run, String((error as Error).message ?? error))
    })
    return run
  }
  /** Give up an update that has not reached the switch; a pause it set is lifted again. */
  async cancel(): Promise<boolean> {
    const run = this.current
    if (!run || !['preparing', 'waiting'].includes(run.state)) return false
    this.cancelled = true
    run.state = 'cancelled'
    run.endedAt = this.iso()
    if (this.pausedByUs) { this.pausedByUs = false; await this.host.pause(false).catch(() => {}) }
    return true
  }
  private pausedByUs = false
  private step(run: UpgradeRun, name: UpgradeStepName, state: UpgradeStep['state'], detail = ''): void {
    const found = run.steps.find(step => step.name === name)
    if (found) Object.assign(found, { state, detail, at: this.iso() })
    else run.steps.push({ name, state, detail, at: this.iso() })
  }
  private fail(run: UpgradeRun, error: string): void {
    if (run.state === 'cancelled') return
    run.state = 'failed'; run.error = error; run.endedAt = this.iso()
    const last = run.steps.at(-1)
    if (last?.state === 'running') Object.assign(last, { state: 'failed', detail: error })
    if (this.pausedByUs) { this.pausedByUs = false; void this.host.pause(false).catch(() => {}) }
  }
  private async stage(run: UpgradeRun, name: UpgradeStepName, work: () => Promise<string | void>): Promise<void> {
    if (this.cancelled) throw new Error('cancelled')
    this.step(run, name, 'running')
    const detail = await work()
    this.step(run, name, 'done', detail ?? '')
  }
  private async prepareAndSwitch(run: UpgradeRun, force: boolean): Promise<void> {
    const worktree = join(this.dir, 'build')
    const pnpm = (args: string[]) => this.run.command(this.config.pnpm, args, { cwd: worktree, timeoutMs: STEP_TIMEOUT_MS,
      shell: process.platform === 'win32' })
    try {
      await this.stage(run, 'fetch', async () => { await this.git(['fetch', '--quiet', this.config.remote, this.config.branch]) })
      await this.stage(run, 'worktree', async () => {
        // A detached worktree of the exact commit: the checkout's own working tree and branch are never touched.
        await this.git(['worktree', 'remove', '--force', worktree]).catch(() => {})
        await this.git(['worktree', 'prune'])
        await this.git(['worktree', 'add', '--detach', '--force', worktree, run.sha])
        return worktree
      })
      await this.stage(run, 'install', async () => { await pnpm(['install', '--frozen-lockfile']) })
      await this.stage(run, 'typecheck', async () => { await pnpm(['typecheck']) })
      await this.stage(run, 'test', async () => { await pnpm(['test']) })
      await this.stage(run, 'build', async () => { await pnpm(['build']) })
    } catch (error) {
      if (!this.cancelled) this.fail(run, String((error as Error).message ?? error))
      return
    }
    if (this.cancelled) return
    run.state = 'waiting'
    const wasPaused = this.host.paused()
    this.step(run, 'pause', 'running')
    if (!wasPaused) { await this.host.pause(true); this.pausedByUs = true }
    this.step(run, 'pause', 'done', wasPaused ? 'already paused' : '')
    this.step(run, 'idle', 'running')
    const deadline = this.now() + this.config.idleTimeoutMin * 60_000
    while (!force && this.host.activeCount() > 0) {
      if (this.cancelled || this.stopped) return
      if (this.now() > deadline) { this.fail(run, `${this.host.activeCount()} workers were still running after ${this.config.idleTimeoutMin} minutes`); return }
      this.step(run, 'idle', 'running', String(this.host.activeCount()))
      await new Promise(done => setTimeout(done, 2_000))
    }
    if (this.cancelled) return
    this.step(run, 'idle', 'done', force ? 'forced' : '')
    const url = this.host.url()
    if (!url) { this.fail(run, 'The management API has no loopback address the switch could check'); return }
    const plan = { sha: run.sha, from: run.from, source: worktree, install: this.install, stateDir: this.host.stateDir,
      backup: join(this.dir, 'backup'), statusFile: this.statusFile, log: join(this.dir, 'switch.log'), url, pid: process.pid, wasPaused,
      holdFile: this.config.holdFile, start: this.startCommand(), startedAt: run.startedAt, steps: run.steps }
    const planFile = join(this.dir, 'plan.json')
    this.run.write(planFile, JSON.stringify(plan, null, 2) + '\n')
    run.state = 'switching'
    this.step(run, 'stop', 'running')
    this.run.write(this.statusFile, JSON.stringify(run, null, 2) + '\n')
    // Hand off: the switch runs from the new build's own script, so an update can fix the switch too.
    this.run.detach(process.execPath, [join(worktree, 'scripts', 'upgrade-switch.mjs'), planFile], { cwd: this.dir, log: plan.log })
    this.pausedByUs = false
    // Give the panel a poll to see `switching` before this process goes.
    setTimeout(() => { this.host.exit() }, 1_500)
  }
  /** The command that starts the service again: the configured one, or this very process's command line. */
  private startCommand(): { command?: string; argv?: string[]; cwd: string } {
    if (this.config.startCommand) return { command: this.config.startCommand, cwd: this.config.checkout }
    return { argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd() }
  }
}

/** A refused update request; `code` words why in the panel. */
export class UpgradeRefused extends Error {
  constructor(readonly code: string) { super(`Update refused: ${code}`) }
}
