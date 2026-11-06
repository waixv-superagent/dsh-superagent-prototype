/**
 * The host side of local reproduction cases (docs/024): it starts one case's command in its folder, keeps the output in a
 * log, records how the run ended and which report it wrote, and stops it on a person's click or when its timeout passes.
 * Runs are sequential, because one script drives the open editor at a time; the record survives a host restart so a
 * person still sees how the last run ended.
 */
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { UserError } from '../core/errors.ts'
import { KV } from '../kv.ts'
import { inside, readReproCases, runSummary, spawnCase, type ReproCase } from './repro.ts'
import { killTree } from './editor-scheduler.ts'

/** How a run ended: a printed verdict never overrides what the process itself did. */
export type ReproRunState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
/** Who started a run: a person's click, or the night queue replaying a delivered ticket's case on its own (docs/029). */
export type ReproRunOrigin = 'person' | 'night'

/** One run of a local case; the state keeps the newest runs only, while every log stays on disk. */
export interface ReproRun {
  id: string
  caseId: string
  /** The case's display name at the time of the run, so a renamed or removed folder still reads. */
  caseName: string
  state: ReproRunState
  /** Absent on runs recorded before the night queue existed, which count as a person's. */
  origin?: ReproRunOrigin
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  /** The last output line, or the reason the command could not start. */
  summary: string
  /** The report file relative to the case folder, when the case declares one and the run wrote it. */
  report?: string
  /** The log file the host wrote the command's output to. */
  log: string
  pid?: number
}
export interface ReproState { runs: ReproRun[] }

/** How many runs the panel lists; older runs stay on disk as logs. */
export const VISIBLE_RUNS = 12
/** How much of a run's output a request reads: enough for the failing lines, small enough to answer quickly. */
export const LOG_TAIL = 32 * 1024
const MAX_RUNS = 40
const OUTPUT_TAIL = 64 * 1024

export interface ReproRunnerHost {
  readonly store: { get<V>(key: string & { readonly __value?: V }): V | undefined
    set<V>(key: string & { readonly __value?: V }, value: V): void }
  /** The directory the cases live in, read on every call so a changed editor project moves the list with it. */
  root(): string
  /** Where run logs go. */
  readonly logDir: string
  now?: () => number
  /** Replaces the child process in tests. */
  spawn?: (command: string, cwd: string) => ChildProcess
  /** Whether a process still runs; replaced in tests. */
  alive?: (pid: number) => boolean
  /** Stops a process tree; replaced in tests. */
  kill?: (pid: number) => void
  warn?: (message: string) => void
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Owns the runs of the local reproduction cases: see the file comment. */
export class ReproRunner {
  private readonly children = new Map<string, ChildProcess>()
  /** Why a running case is being stopped, so its end reads as a person's stop or as a timeout. */
  private readonly stopping = new Map<string, 'person' | 'timeout'>()
  /** The output collected for a run still in memory; a finished run's output is read from its log. */
  private readonly tails = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false
  constructor(private readonly host: ReproRunnerHost) {}

  private now(): number { return (this.host.now ?? Date.now)() }
  private state(): ReproState { return this.host.store.get(KV.repro.runs) ?? { runs: [] } }
  private write(runs: readonly ReproRun[]): void { this.host.store.set(KV.repro.runs, { runs: runs.slice(0, MAX_RUNS) }) }
  /** Replaces one run in place, keeping the newest-first order the rest of the list already has. */
  private update(run: ReproRun): void {
    this.write([run, ...this.state().runs.filter(item => item.id !== run.id)])
  }
  private alive(pid: number): boolean {
    if (this.host.alive) return this.host.alive(pid)
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  private kill(pid: number): void { (this.host.kill ?? killTree)(pid) }
  private warn(message: string): void { this.host.warn?.(`repro runner: ${message}`) }

  /** The case directory, for the view and for the file routes that resolve a run's report inside it. */
  root(): string { return this.host.root() }

  /**
   * Recovers after a restart: a run the host was running lost its output and its report, so its process is stopped
   * rather than left to fight the next run. Called on startup and on every panel poll.
   */
  start(): void { this.tick() }
  tick(): ReproRun[] {
    if (this.disposed) return this.state().runs
    const runs = this.state().runs
    const now = new Date(this.now()).toISOString()
    let changed = false
    const next = runs.map(run => {
      if (run.state !== 'running' || this.children.has(run.id)) return run
      if (run.pid && this.alive(run.pid)) this.kill(run.pid)
      changed = true
      return { ...run, state: 'interrupted' as const, exitCode: null, endedAt: now,
        summary: 'the host restarted while it ran, so its output and report were lost' }
    })
    if (changed) this.write(next)
    return changed ? next : runs
  }

  /**
   * Starts one case. The command runs in its own folder through the platform shell, its output goes to a log, and the
   * case's declared report is recorded once the run wrote it. Only one run is in flight, because the editor is single.
   * `origin` records who asked: a person's click, or the night queue that replays a delivered Ticket's case by itself.
   */
  run(caseId: string, origin: ReproRunOrigin = 'person'): ReproRun {
    const runs = this.tick()
    if (runs.some(run => run.state === 'running')) throw new UserError('reproBusy')
    const root = this.host.root()
    const found = readReproCases(root).cases.find(item => item.id === caseId)
    if (!found) throw new UserError('unknownReproCase', { case: caseId })
    if (found.problem) throw new UserError('reproCaseInvalid', { case: found.id, reason: found.problem.code })
    if (!found.command) throw new UserError('reproCaseInvalid', { case: found.id, reason: 'missingManifest' })
    const id = randomUUID().slice(0, 12)
    const run: ReproRun = { id, caseId: found.id, caseName: found.name, state: 'running', origin,
      startedAt: new Date(this.now()).toISOString(), summary: '', log: '' }
    mkdirSync(this.host.logDir, { recursive: true })
    const log = join(this.host.logDir, `${id}.log`)
    run.log = log
    let child: ChildProcess
    try { child = (this.host.spawn ?? spawnCase)(found.command, found.directory) } catch (error) {
      const failed: ReproRun = { ...run, state: 'failed', endedAt: new Date(this.now()).toISOString(), exitCode: null,
        summary: `could not start: ${reason(error)}` }
      this.write([failed, ...runs])
      return failed
    }
    this.children.set(id, child)
    this.tails.set(id, '')
    if (child.pid) run.pid = child.pid
    this.write([run, ...runs])
    const out = createWriteStream(log)
    // A log that cannot be written is not a reason to lose the run: the verdict and its output still reach the page.
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
      this.stopping.set(id, 'timeout')
      this.warn(`case ${found.id} ran past ${Math.round(found.timeoutMs / 1_000)}s; stopping it`)
      if (child.pid) this.kill(child.pid)
    }, found.timeoutMs)
    timer.unref?.()
    this.timers.set(id, timer)
    child.on('close', code => {
      clearTimeout(timer)
      this.timers.delete(id)
      out.end()
      this.children.delete(id)
      const stopped = this.stopping.get(id)
      this.stopping.delete(id)
      const output = this.tails.get(id) ?? ''
      this.tails.delete(id)
      const state: ReproRunState = stopped === 'person' ? 'cancelled' : stopped === 'timeout' || code !== 0 ? 'failed' : 'succeeded'
      const report = this.report(found)
      this.update({ ...run, state, exitCode: code, endedAt: new Date(this.now()).toISOString(),
        summary: stopped === 'person' ? 'stopped by a person'
          : stopped === 'timeout' ? `stopped after ${Math.round(found.timeoutMs / 1_000)}s`
          : runSummary(output),
        ...report ? { report } : {} })
    })
    return run
  }

  /** Stops the run in flight; a queued run does not exist, since only one runs at a time. */
  stop(runId: string): void {
    const run = this.tick().find(item => item.id === runId)
    if (!run) throw new UserError('unknownReproRun', { run: runId })
    if (run.state !== 'running') throw new UserError('reproNotRunning', { run: runId })
    const child = this.children.get(runId)
    if (!child?.pid) {
      this.update({ ...run, state: 'interrupted', exitCode: null, endedAt: new Date(this.now()).toISOString(),
        summary: 'its process is already gone' })
      return
    }
    this.stopping.set(runId, 'person')
    this.kill(child.pid)
  }

  /** The last output of one run: from memory while it runs, else from its log. Unknown runs raise a user error. */
  log(runId: string, chars = LOG_TAIL): string {
    const run = this.state().runs.find(item => item.id === runId)
    if (!run) throw new UserError('unknownReproRun', { run: runId })
    const live = this.tails.get(runId)
    if (live !== undefined) return live.slice(-chars)
    try { return readFileSync(run.log, 'utf8').slice(-chars) } catch { return '' }
  }

  /** The report a case declares, when this run wrote it and it still sits inside the case folder. */
  private report(item: ReproCase): string | undefined {
    if (!item.report) return undefined
    const full = inside(item.directory, item.report)
    if (!full) return undefined
    try { return statSync(full).isFile() ? item.report.replaceAll('\\', '/') : undefined } catch { return undefined }
  }

  /** Stops what this host started and forgets its handles; the persisted runs let the next host reclaim them. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const child of this.children.values()) if (child.pid) this.kill(child.pid)
    this.children.clear()
  }
}
