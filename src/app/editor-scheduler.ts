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
import { acquire, advance, emptySchedule, heartbeat, personAct, release, standing, submitJob, updateJob, type AcquireRequest,
  type AcquireResult, type EditorJob, type EditorJobKind, type EditorLease, type EditorSchedule, type PersonAction,
  type ScheduleContext } from './editor-schedule.ts'

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
}

/** Placeholders a configured command may use; values are quoted, so a path with spaces stays one argument. */
export function fillCommand(template: string, values: { project: string; dir: string; filter?: string }): string {
  const quote = (value: string) => `"${value.replaceAll('"', '')}"`
  return template.replaceAll('<project>', quote(values.project)).replaceAll('<dir>', values.dir.replaceAll('"', ''))
    .replaceAll('<filter>', quote(values.filter ?? ''))
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

  /** Recovers after a restart: a job that was running when the host stopped did not report, so it reads as interrupted. */
  start(): void {
    this.change(schedule => {
      let next = schedule
      for (const job of schedule.jobs.filter(item => item.state === 'running')) {
        next = updateJob(next, job.id, { state: 'interrupted', summary: 'the host restarted while it ran' }, this.context())
      }
      return { schedule: next }
    })
    this.timer = setInterval(() => { this.tick() }, TICK_MS)
    this.timer.unref?.()
  }
  /** Lapses leases, drops ended Tickets and grants the editor once it is free; the overview's poll and a timer both call it. */
  tick(): EditorSchedule {
    if (this.disposed) return this.read()
    try { return this.change(schedule => ({ schedule })).schedule } catch (error) {
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

  acquire(request: AcquireRequest): AcquireResult { return this.change((schedule, context) => acquire(schedule, request, context)).result }
  heartbeat(ticketId: string, ttlMs?: number, note?: string): EditorLease {
    return this.change((schedule, context) => ({ schedule: heartbeat(schedule, ticketId, context, ttlMs, note) })).schedule.lease!
  }
  release(ticketId: string, detail?: string): void { this.change((schedule, context) => ({ schedule: release(schedule, ticketId, context, detail) })) }
  standing(ticketId: string) { return standing(this.read(), ticketId) }

  /** Queues a host-run job; a build already waiting absorbs this Ticket so one compile serves every waiting change. */
  submit(ticketId: string, kind: EditorJobKind, directory: string, filter?: string): { job: EditorJob; merged: boolean } {
    const command = this.host.commands()[kind]
    if (!command) throw new Error(`no ${kind} command is configured for the editor; take the editor with op=acquire purpose=${kind} and run it yourself`)
    if (kind === 'test' && !filter?.trim()) throw new Error('a test job needs the automation filter to run')
    const result = this.change((schedule, context) => submitJob(schedule, { kind, ticketId, directory, ...filter ? { filter: filter.trim() } : {} }, context))
    return { job: result.schedule.jobs.find(job => job.id === result.job.id) ?? result.job, merged: result.merged }
  }
  job(id: string): EditorJob | undefined { return this.read().jobs.find(job => job.id === id) }

  /** A person's action from the overview: claim, yield, preempt, move a wait forward or cancel it. */
  act(action: PersonAction): EditorSchedule {
    const result = this.change((schedule, context) => personAct(schedule, action, context))
    const drained = result.drained
    if (result.cancelledJob) this.cancelJob(result.cancelledJob)
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
      log, command }, context) }))
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
      const current = this.job(job.id)
      if (current?.state === 'cancelled') return
      this.finish(job, code === 0 ? 'succeeded' : 'failed', code, jobSummary(job.kind, tail, code), log, command)
    })
  }

  private finish(job: EditorJob, state: 'succeeded' | 'failed', code: number | null, summary: string, log: string, command: string): void {
    const schedule = this.change((value, context) => ({ schedule: updateJob(value, job.id, { state, exitCode: code, summary, log, command }, context) })).schedule
    const ended = schedule.jobs.find(item => item.id === job.id) ?? job
    for (const ticketId of ended.ticketIds) {
      void this.host.notify(ticketId, `editor-job:${job.id}`, `The ${job.kind} job ${job.id} you queued ${state}: ${summary}. Log: ${log}`
        + `${ended.ticketIds.length > 1 ? ` (one run for ${ended.ticketIds.length} Tickets)` : ''}`)
        .catch(error => { this.host.warn(`editor job notice failed: ${String(error)}`) })
    }
  }

  /** Stops a running job's process tree, or marks a queued one cancelled. */
  cancelJob(id: string): void {
    const child = this.children.get(id)
    this.change((schedule, context) => ({ schedule: updateJob(schedule, id, { state: 'cancelled', summary: 'cancelled by a person' }, context) }))
    if (child?.pid) killTree(child.pid)
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
    : spawn('/bin/sh', ['-c', command], { cwd })
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* Already gone. */ } }
}
