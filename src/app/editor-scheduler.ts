/**
 * The shared editor's scheduler (docs/021): it keeps the lease, the wait queue and the job list in the ticket database,
 * grants the editor to the next waiter when it frees up, runs the build, restart and test jobs the host owns, and tells a
 * worker when its turn came or a person asked it to yield. The decisions themselves are the pure functions of
 * `editor-schedule.ts`; this class only persists, runs commands and delivers notices.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KV } from '../kv.ts'
import type { EditorView } from './editor.ts'
import { readEngineState, type EditorEngineState } from './editor-mcp.ts'
import { acquire, advance, emptySchedule, heartbeat, personAct, personBlock, reclaim, recordBypass, release, standing,
  submitJob, updateJob, type AcquireRequest, type AcquireResult, type EditorJob, type EditorJobKind, type EditorLease,
  type EditorSchedule, type PersonAction, type ScheduleContext } from './editor-schedule.ts'

/** The KV record the schedule lives in, so leases and waits survive a host restart. */
const EDITOR_SCHEDULE = KV.editor.schedule
const TICK_MS = 15_000
const OUTPUT_TAIL = 64 * 1024

export interface EditorCommands { project: string; build: string; restart: string; test: string }

export interface EditorSchedulerHost {
  readonly store: { get<V>(key: string & { readonly __value?: V }): V | undefined; set<V>(key: string & { readonly __value?: V }, value: V): void
    atomic<T>(operation: () => T): T }
  /** Whether a Ticket is open; an ended one loses its lease and its waits. */
  live(ticketId: string): boolean
  /** The probe's cached row; reading it refreshes the cache in the background. */
  editor(): EditorView | null
  commands(): EditorCommands
  /** Where job logs go. */
  readonly logDir: string
  /** Delivers one notice to a Ticket's worker, at most once per id. */
  notify(ticketId: string, id: string, text: string): Promise<void>
  warn(message: string): void
  now?: () => number
  /** Replaces the child process in tests. */
  spawn?: (command: string, cwd: string) => ChildProcess
  /** Replaces the ue-mcp file read in tests. */
  engine?: (project: string) => EditorEngineState
  /** Whether a process still runs; replaced in tests. */
  alive?: (pid: number) => boolean
  /** Stops a process tree; replaced in tests. */
  kill?: (pid: number) => void
}

/**
 * An automation filter a worker may hand the host: test names are words, dots, spaces, `+`, `-`, `:` and `/`. Anything
 * else, such as a quote, `&`, `|` or `%`, could end the command's own quoting and run what the configured command never named.
 */
export const SAFE_FILTER = /^[\w .+\-:/]{1,300}$/

/**
 * Placeholders a configured command may use. The project is quoted so a path with spaces stays one argument; the filter
 * goes in as is, usually inside the template's own quotes, which is why `submit` only lets a `SAFE_FILTER` through.
 */
export function fillCommand(template: string, values: { project: string; dir: string; filter?: string }): string {
  const quote = (value: string) => `"${value.replaceAll('"', '')}"`
  return template.replaceAll('<project>', quote(values.project)).replaceAll('<dir>', values.dir.replaceAll('"', ''))
    .replaceAll('<filter>', values.filter ?? '')
}

/** The one line a person and the worker read from a job's output: UBT's verdict, the automation counts, or the last line. */
export function jobSummary(kind: EditorJobKind, output: string, code: number | null): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (kind === 'build') {
    const verdict = [...lines].reverse().find(line => /Result:\s*(Succeeded|Failed)/i.test(line))
    if (verdict) return verdict.slice(0, 200)
  }
  if (kind === 'test') {
    const results = lines.filter(line => /Test Completed\.\s*Result=/.test(line))
    if (results.length) {
      const failed = results.filter(line => !/Result=\{?Success\}?/i.test(line)).length
      return `automation: ${results.length - failed} passed, ${failed} failed`
    }
  }
  return `exit ${code ?? 'killed'}${lines.length ? ` · ${lines.at(-1)!.slice(0, 160)}` : ''}`
}

/** Owns the schedule: see the file comment. */
export class EditorScheduler {
  private timer?: ReturnType<typeof setInterval>
  private readonly children = new Map<string, ChildProcess>()
  private readonly waiters = new Set<() => void>()
  private disposed = false
  constructor(private readonly host: EditorSchedulerHost) {}

  private now(): number { return (this.host.now ?? Date.now)() }
  private context(): ScheduleContext {
    return { now: this.now(), editor: this.host.editor(), live: id => this.host.live(id), id: () => randomUUID().slice(0, 12) }
  }
  read(): EditorSchedule { return { ...emptySchedule(), ...this.host.store.get(EDITOR_SCHEDULE) ?? {} } }
  private write(schedule: EditorSchedule): void { this.host.store.set(EDITOR_SCHEDULE, schedule) }
  /** Runs one decision against the stored schedule, persists it, and acts on a lease it granted. */
  private change<T extends { schedule: EditorSchedule; granted?: EditorLease }>(decide: (schedule: EditorSchedule, context: ScheduleContext) => T): T {
    const result = this.host.store.atomic(() => {
      const value = decide(this.read(), this.context())
      const advanced = value.granted ? { schedule: value.schedule } : advance(value.schedule, this.context())
      this.write(advanced.schedule)
      return { ...value, schedule: advanced.schedule, granted: value.granted ?? ('granted' in advanced ? advanced.granted : undefined) }
    })
    if (result.granted) this.granted(result.granted, result.schedule)
    for (const wake of [...this.waiters]) wake()
    return result
  }

  private alive(pid: number): boolean {
    if (this.host.alive) return this.host.alive(pid)
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  private kill(pid: number): void { (this.host.kill ?? killTree)(pid) }

  /**
   * Recovers after a restart. A job that was running when the host stopped lost its output and its report, so its process
   * is stopped; it keeps the editor until that process has exited, so the next job never builds over it.
   */
  start(): void {
    const orphans: number[] = []
    this.change((schedule, context) => {
      let next = schedule
      for (const job of schedule.jobs.filter(item => item.state === 'running')) {
        if (job.pid && this.alive(job.pid)) {
          orphans.push(job.pid)
          next = updateJob(next, job.id, { stopping: true, summary: 'the host restarted while it ran; stopping it' }, context)
        } else next = updateJob(next, job.id, { state: 'interrupted', summary: 'the host restarted while it ran' }, context)
      }
      return { schedule: next }
    })
    for (const pid of orphans) this.kill(pid)
    this.timer = setInterval(() => { this.tick() }, TICK_MS)
    this.timer.unref?.()
  }
  /** Lapses leases, drops ended Tickets and grants the editor once it is free; the overview's poll and a timer both call it. */
  tick(): EditorSchedule {
    if (this.disposed) return this.read()
    try {
      // A job this host no longer has a handle to (left from before a restart) ends once its process is gone.
      const gone = this.read().jobs.filter(job => job.state === 'running' && !this.children.has(job.id) && (!job.pid || !this.alive(job.pid)))
      for (const job of gone) {
        this.end(job.id, job.stopping ? 'cancelled' : 'interrupted', null, job.stopping ? 'stopped after the host restarted' : 'the host restarted while it ran')
      }
      return this.change(schedule => ({ schedule })).schedule
    } catch (error) {
      this.host.warn(`editor schedule tick failed: ${error instanceof Error ? error.message : String(error)}`)
      return this.read()
    }
  }
  /** What ue-mcp's bridge files say, or null when no project is configured. */
  engine(): EditorEngineState | null {
    const project = this.host.commands().project
    if (!project) return null
    return (this.host.engine ?? readEngineState)(project)
  }
  /** The probe's cached row the scheduler decides on, so a worker's status can name the editors a person has open. */
  view(): EditorView | null {
    return this.host.editor()
  }
  /** Why agents may not take the editor now (a person's claim or open editor, an unreadable probe), or null when free. */
  blocked(): 'claimed' | 'editor' | 'unknown' | null {
    return personBlock(this.read(), this.host.editor())
  }
  /** Records a worker's attempt to use or stop the editor outside its lease; the lease guard calls this (docs/021). */
  noteBypass(ticketId: string, detail: string): void {
    this.change((schedule, context) => ({ schedule: recordBypass(schedule, { ticketId, detail }, context) }))
  }
  /**
   * Ends a lease the gatekeeper reclaimed after its processes were stopped (docs/021), so the slot frees up and the
   * next waiter is granted. The ending kind keeps the overview's lease span closing on the event it already understands;
   * a lease another path already ended keeps a cleanup record on the timeline.
   */
  reclaim(leaseId: string, reason: string, ending: 'expired' | 'ended' | 'released' = 'expired'): void {
    this.change((schedule, context) => ({ schedule: reclaim(schedule, leaseId, reason, context, ending).schedule }))
  }

  acquire(request: AcquireRequest): AcquireResult { return this.change((schedule, context) => acquire(schedule, request, context)).result }
  heartbeat(ticketId: string, ttlMs?: number, note?: string): EditorLease {
    return this.change((schedule, context) => ({ schedule: heartbeat(schedule, ticketId, context, ttlMs, note) })).schedule.lease!
  }
  release(ticketId: string, detail?: string): void { this.change((schedule, context) => ({ schedule: release(schedule, ticketId, context, detail) })) }
  standing(ticketId: string) { return standing(this.read(), ticketId) }

  /** Queues a host-run job; a build already waiting absorbs this Ticket so one compile serves every waiting change. */
  submit(ticketId: string, kind: EditorJobKind, directory: string, filter?: string): { job: EditorJob; merged: boolean } {
    if (!directory.trim()) throw new Error('this Ticket has no workspace directory for a host job to run in')
    if (/[&|<>^%"\r\n]/.test(directory)) throw new Error('the workspace path holds a character the command line would read as syntax')
    const command = this.host.commands()[kind]
    if (!command) throw new Error(`no ${kind} command is configured for the editor; take the editor with op=acquire purpose=${kind} and run it yourself`)
    if (kind === 'test' && !filter?.trim()) throw new Error('a test job needs the automation filter to run')
    if (filter?.trim() && !SAFE_FILTER.test(filter.trim())) throw new Error('the filter may hold only letters, digits, spaces and . _ + - : /')
    const result = this.change((schedule, context) => submitJob(schedule, { kind, ticketId, directory, ...filter ? { filter: filter.trim() } : {} }, context))
    return { job: result.schedule.jobs.find(job => job.id === result.job.id) ?? result.job, merged: result.merged }
  }
  job(id: string): EditorJob | undefined { return this.read().jobs.find(job => job.id === id) }
  /** The job whose result is this one's: itself, or the build it was folded into. */
  resolved(id: string): EditorJob | undefined {
    const jobs = this.read().jobs
    let job = jobs.find(item => item.id === id)
    for (let hops = 0; job?.mergedInto && hops < 10; hops++) job = jobs.find(item => item.id === job!.mergedInto) ?? job
    return job
  }

  /** A person's action from the overview: claim, yield, preempt, move a wait forward or cancel it. */
  act(action: PersonAction): EditorSchedule {
    const result = this.change((schedule, context) => personAct(schedule, action, context))
    const drained = result.drained
    // The wait is gone already when a person removed it, so its job may have ended with it.
    if (result.cancelledJob && ['queued', 'running'].includes(this.job(result.cancelledJob)?.state ?? '')) this.cancelJob(result.cancelledJob)
    if (drained?.holder.kind === 'agent') {
      const reason = drained.draining?.reason ?? '人要求让出'
      void this.host.notify(drained.holder.ticketId, `editor-drain:${drained.id}`, `A person asked you to yield the shared editor: ${reason}. `
        + 'Save, stop at the next safe point, and call orchestrator_editor with op=release; acquire it again later if the work still needs it.')
        .catch(error => { this.host.warn(`editor drain notice failed: ${String(error)}`) })
    }
    return result.schedule
  }

  /** Waits until `done` holds, the schedule changes enough to satisfy it, or the time runs out; for a tool that blocks on a grant. */
  async waitFor<T>(check: () => T | undefined, ms: number, signal?: AbortSignal): Promise<T | undefined> {
    const first = check()
    if (first !== undefined || ms <= 0) return first
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: T | undefined) => {
        this.waiters.delete(wake)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        resolve(value)
      }
      const wake = () => { const value = check(); if (value !== undefined) finish(value) }
      const aborted = () => { finish(undefined) }
      this.waiters.add(wake)
      timer = setTimeout(() => { finish(check()) }, ms)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  private granted(lease: EditorLease, schedule: EditorSchedule): void {
    if (lease.holder.kind === 'agent') {
      void this.host.notify(lease.holder.ticketId, `editor-grant:${lease.id}`, `The shared editor is yours now for ${lease.purpose}`
        + `${lease.note ? ` (${lease.note})` : ''}, until ${lease.expiresAt}. Heartbeat with orchestrator_editor op=heartbeat during long steps `
        + 'and release it as soon as you are done.').catch(error => { this.host.warn(`editor grant notice failed: ${String(error)}`) })
    } else if (lease.holder.kind === 'job') {
      const job = schedule.jobs.find(item => item.id === (lease.holder as { jobId: string }).jobId)
      if (job) this.run(job)
    }
  }

  private run(job: EditorJob): void {
    const commands = this.host.commands()
    const template = commands[job.kind]
    const command = fillCommand(template, { project: commands.project, dir: job.directory, ...job.filter ? { filter: job.filter } : {} })
    mkdirSync(this.host.logDir, { recursive: true })
    const log = join(this.host.logDir, `${job.id}.log`)
    const out = createWriteStream(log)
    let tail = ''
    let child: ChildProcess
    try {
      child = (this.host.spawn ?? defaultSpawn)(command, job.directory)
    } catch (error) {
      this.finish(job, 'failed', null, `could not start: ${error instanceof Error ? error.message : String(error)}`, log, command)
      return
    }
    this.children.set(job.id, child)
    this.change((schedule, context) => ({ schedule: updateJob(schedule, job.id, { state: 'running', startedAt: new Date(context.now).toISOString(),
      log, command, ...child.pid ? { pid: child.pid } : {} }, context) }))
    const collect = (chunk: Buffer | string) => {
      out.write(chunk)
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => { collect(`\n${error.message}\n`) })
    child.on('close', code => {
      out.end()
      this.children.delete(job.id)
      // A stopped job reads as cancelled, never as its exit code: a killed build is no verdict on the change.
      if (this.job(job.id)?.stopping) this.end(job.id, 'cancelled', code, 'stopped by a person')
      else this.end(job.id, code === 0 ? 'succeeded' : 'failed', code, jobSummary(job.kind, tail, code), log, command)
    })
  }

  private finish(job: EditorJob, state: 'failed', code: number | null, summary: string, log: string, command: string): void {
    this.end(job.id, state, code, summary, log, command)
  }

  /** Records a job's end, which frees the editor, and tells every Ticket it covered. */
  private end(id: string, state: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', code: number | null, summary: string, log?: string,
    command?: string): void {
    const schedule = this.change((value, context) => ({ schedule: updateJob(value, id, { state, exitCode: code, summary,
      ...log ? { log } : {}, ...command ? { command } : {} }, context) })).schedule
    const ended = schedule.jobs.find(item => item.id === id)
    if (!ended) return
    for (const ticketId of ended.ticketIds) {
      void this.host.notify(ticketId, `editor-job:${id}`, `The ${ended.kind} job ${id} you queued ${state}: ${summary}.`
        + `${ended.log ? ` Log: ${ended.log}` : ''}${ended.ticketIds.length > 1 ? ` (one run for ${ended.ticketIds.length} Tickets)` : ''}`)
        .catch(error => { this.host.warn(`editor job notice failed: ${String(error)}`) })
    }
  }

  /**
   * A person stops a job. A queued one is dropped at once; a running one is marked stopping and its process tree killed,
   * and it keeps the editor until the process has exited, so the next build never starts over a compile still writing.
   */
  cancelJob(id: string): void {
    const job = this.job(id)
    if (!job || (job.state !== 'queued' && job.state !== 'running')) throw new Error('that job has already ended')
    if (job.state === 'queued') { this.end(id, 'cancelled', null, 'cancelled by a person'); return }
    if (job.stopping) return
    this.change((schedule, context) => ({ schedule: updateJob(schedule, id, { stopping: true, summary: 'stopping…' }, context) }))
    const pid = this.children.get(id)?.pid ?? job.pid
    if (pid) this.kill(pid)
  }

  /** The text of a job's log tail, for a worker that wants the error lines. */
  logTail(id: string, chars = 4000): string {
    const job = this.job(id)
    if (!job?.log) return ''
    try { return readFileSync(job.log, 'utf8').slice(-chars) } catch { return '' }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    for (const wake of [...this.waiters]) wake()
  }
}

function defaultSpawn(command: string, cwd: string): ChildProcess {
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
    // Its own process group, so stopping it reaches every process the command started.
    : spawn('/bin/sh', ['-c', command], { cwd, detached: true })
}

/** Stops a process and everything it started: a lease guard or a cancelled job must leave no editor behind it. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* Already gone. */ } }
}
