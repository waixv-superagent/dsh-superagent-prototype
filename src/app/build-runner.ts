/**
 * A person's compile-and-launch targets (docs/021): the editor page runs one configured target command as a host process,
 * one at a time, and shows its output. A run borrows the shared editor's slot: it refuses while an agent or a host job
 * holds it, claims the slot for the duration, and gives the slot back when the process ends. The target command performs
 * the whole compile-and-launch, so the panel never guesses an engine or a project layout.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { UserError } from '../core/errors.ts'
import { KV } from '../kv.ts'
import { fillCommand, killTree } from './editor-scheduler.ts'

/** How one run ended: a printed verdict never overrides what the process itself did. */
export type BuildRunState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
/** One configured target the person may launch: a name and the command that compiles and starts the editor. */
export interface BuildTarget { name: string; command: string }
/** One run of a target; the newest runs only, while every log stays on disk. */
export interface BuildRun {
  id: string
  target: string
  command: string
  state: BuildRunState
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  /** The last output line, or the reason the command could not start. */
  summary: string
  /** The log file the host wrote the command's output to. */
  log: string
  pid?: number
  /** This run took the person's editor slot, so ending it gives the slot back. */
  claimed?: true
  /** A person stopped it: the process is killed and its end reads as cancelled. */
  stopping?: true
}
export interface BuildState { runs: BuildRun[] }

/** How many runs the page lists; older runs stay on disk as logs. */
export const VISIBLE_BUILD_RUNS = 6
const MAX_RUNS = 20
const OUTPUT_TAIL = 32 * 1024
/** A compile-and-launch that outlives this is stopped; the host never leaves a build running forever. */
export const BUILD_TIMEOUT_MS = 30 * 60_000

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

export interface BuildRunnerHost {
  readonly store: { get<V>(key: string & { readonly __value?: V }): V | undefined; set<V>(key: string & { readonly __value?: V }, value: V): void }
  /** Where the run logs go. */
  readonly logDir: string
  /** The configured targets, read on each call so a settings save takes effect at once. */
  targets(): readonly BuildTarget[]
  /** The configured `.uproject`; `<project>` is replaced with it. */
  project(): string
  /** The directory a target command runs in: the project's directory, else the state directory. */
  cwd(): string
  /** Why an agent or a host job holds the editor now, or null when the person may use it. */
  blocked(): 'agent' | 'job' | null
  /** Take the person's editor slot; `owned` says this call created the claim, so only then is it given back. */
  takeSlot(): { granted: boolean; owned: boolean }
  releaseSlot(): void
  now?: () => number
  /** Replaces the child process in tests. */
  spawn?: (command: string, cwd: string) => ChildProcess
  /** Whether a process still runs; replaced in tests. */
  alive?: (pid: number) => boolean
  /** Stops a process tree; replaced in tests. */
  kill?: (pid: number) => void
  warn?: (message: string) => void
}

/** Owns the runs of the person's compile-and-launch targets: see the file comment. */
export class BuildRunner {
  private readonly children = new Map<string, ChildProcess>()
  private readonly tails = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false
  constructor(private readonly host: BuildRunnerHost) {}

  private now(): number { return (this.host.now ?? Date.now)() }
  private state(): BuildState { return this.host.store.get(KV.build.runs) ?? { runs: [] } }
  private write(runs: readonly BuildRun[]): void { this.host.store.set(KV.build.runs, { runs: runs.slice(0, MAX_RUNS) }) }
  private update(run: BuildRun): void { this.write([run, ...this.state().runs.filter(item => item.id !== run.id)]) }
  private alive(pid: number): boolean {
    if (this.host.alive) return this.host.alive(pid)
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  private kill(pid: number): void { (this.host.kill ?? killTree)(pid) }
  private warn(message: string): void { this.host.warn?.(`build runner: ${message}`) }

  /** The runs newest first, as the page shows them. */
  read(): BuildRun[] { return this.tick() }
  /** The configured targets, as the person sees them. */
  targets(): readonly BuildTarget[] { return this.host.targets() }
  /** Why the person may not start a run now, beyond a running build. */
  blocked(): 'agent' | 'job' | null { return this.host.blocked() }

  /**
   * Recovers after a restart: a run the host was running lost its output, so its process is stopped and the slot it held
   * is given back. Called on startup and on every panel poll.
   */
  tick(): BuildRun[] {
    if (this.disposed) return this.state().runs
    const runs = this.state().runs
    const now = new Date(this.now()).toISOString()
    const recovered: BuildRun[] = []
    const next = runs.map(run => {
      if (run.state !== 'running' || this.children.has(run.id)) return run
      if (run.pid && this.alive(run.pid)) this.kill(run.pid)
      const interrupted: BuildRun = { ...run, state: 'interrupted', exitCode: null, endedAt: now, summary: 'the host restarted while it ran' }
      recovered.push(interrupted)
      return interrupted
    })
    if (recovered.length) {
      this.write(next)
      // Only the runs this tick just recovered give a slot back: an already-interrupted record stays in the list.
      for (const run of recovered) if (run.claimed) this.host.releaseSlot()
    }
    return recovered.length ? next : runs
  }

  /**
   * Starts one target. Only one run is in flight, because the editor is single; an agent or host job holding the editor
   * refuses the run instead of fighting it. The command runs through the platform shell in the project's directory.
   */
  start(targetName: string): BuildRun {
    const runs = this.tick()
    if (runs.some(run => run.state === 'running')) throw new UserError('buildBusy')
    const target = this.host.targets().find(item => item.name === targetName)
    if (!target) throw new UserError('unknownBuildTarget', { target: targetName })
    if (!target.command.trim()) throw new UserError('buildTargetEmpty', { target: target.name })
    const blocked = this.host.blocked()
    if (blocked) throw new UserError(blocked === 'agent' ? 'buildBlockedAgent' : 'buildBlockedJob')
    const slot = this.host.takeSlot()
    if (!slot.granted) throw new UserError('buildEditorBusy')
    const command = fillCommand(target.command, { project: this.host.project(), dir: this.host.cwd() })
    const id = randomUUID().slice(0, 12)
    mkdirSync(this.host.logDir, { recursive: true })
    const log = join(this.host.logDir, `${id}.log`)
    const run: BuildRun = { id, target: target.name, command, state: 'running', startedAt: new Date(this.now()).toISOString(),
      summary: '', log, ...slot.owned ? { claimed: true as const } : {} }
    let child: ChildProcess
    try { child = (this.host.spawn ?? defaultSpawn)(command, this.host.cwd()) } catch (error) {
      const failed: BuildRun = { ...run, state: 'failed', endedAt: new Date(this.now()).toISOString(), exitCode: null,
        summary: `could not start: ${reason(error)}` }
      this.write([failed, ...runs])
      if (run.claimed) this.host.releaseSlot()
      return failed
    }
    this.children.set(id, child)
    this.tails.set(id, '')
    if (child.pid) run.pid = child.pid
    this.write([run, ...runs])
    const out = createWriteStream(log)
    out.on('error', error => this.warn(`could not write the log of ${id}: ${reason(error)}`))
    const collect = (chunk: Buffer | string) => {
      out.write(chunk)
      this.tails.set(id, ((this.tails.get(id) ?? '') + chunk.toString()).slice(-OUTPUT_TAIL))
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => { collect(`\n${reason(error)}\n`) })
    const timer = setTimeout(() => {
      if (!this.children.has(id)) return
      this.warn(`target ${target.name} ran past ${Math.round(BUILD_TIMEOUT_MS / 60_000)} minutes; stopping it`)
      if (child.pid) this.kill(child.pid)
    }, BUILD_TIMEOUT_MS)
    timer.unref?.()
    this.timers.set(id, timer)
    child.on('close', code => {
      clearTimeout(timer)
      this.timers.delete(id)
      out.end()
      this.children.delete(id)
      const output = this.tails.get(id) ?? ''
      this.tails.delete(id)
      const current = this.state().runs.find(item => item.id === id) ?? run
      const state: BuildRunState = current.stopping ? 'cancelled' : code === 0 ? 'succeeded' : 'failed'
      const summary = current.stopping ? 'stopped by a person' : runSummary(output, code)
      this.update({ ...run, state, exitCode: code, endedAt: new Date(this.now()).toISOString(), summary })
      if (run.claimed) this.host.releaseSlot()
    })
    return run
  }

  /** Stops the run in flight; a queued run does not exist, since only one runs at a time. */
  stop(runId: string): void {
    const run = this.tick().find(item => item.id === runId)
    if (!run) throw new UserError('unknownBuildRun', { run: runId })
    if (run.state !== 'running') throw new UserError('buildNotRunning')
    const child = this.children.get(runId)
    if (!child?.pid) {
      this.update({ ...run, state: 'interrupted', exitCode: null, endedAt: new Date(this.now()).toISOString(),
        summary: 'its process is already gone' })
      if (run.claimed) this.host.releaseSlot()
      return
    }
    this.update({ ...run, stopping: true, summary: 'stopping…' })
    this.kill(child.pid)
  }

  /** The last output of one run: from memory while it runs, else from its log. Unknown runs raise a user error. */
  logTail(runId: string, chars = OUTPUT_TAIL): string {
    const run = this.state().runs.find(item => item.id === runId)
    if (!run) throw new UserError('unknownBuildRun', { run: runId })
    const live = this.tails.get(runId)
    if (live !== undefined) return live.slice(-chars)
    try { return readFileSync(run.log, 'utf8').slice(-chars) } catch { return '' }
  }

  /** Stops what this host started; the persisted run lets the next host mark it interrupted. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const child of this.children.values()) if (child.pid) this.kill(child.pid)
    this.children.clear()
  }
}

/** The last meaningful line of a build: UBT's verdict when it says one, else the last non-empty line and the exit code. */
export function runSummary(output: string, code: number | null): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const verdict = [...lines].reverse().find(line => /Result:\s*(Succeeded|Failed)/i.test(line))
  if (verdict) return verdict.slice(0, 200)
  const last = lines.at(-1)?.slice(0, 160)
  return code === 0 ? `exit 0${last ? ` · ${last}` : ''}` : `exit ${code ?? 'killed'}${last ? ` · ${last}` : ''}`
}

function defaultSpawn(command: string, cwd: string): ChildProcess {
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
    : spawn('/bin/sh', ['-c', command], { cwd, detached: true })
}
