/** The editor schedule (docs/021): leases, the queue, a person's priority, batched builds, and the scheduler's job runs. */
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorView } from '../src/app/editor.ts'
import { engineSummary, parseEngineSnapshot, readEngineState } from '../src/app/editor-mcp.ts'
import { acquire, advance, emptySchedule, heartbeat, ordered, personAct, personBlock, release, standing, submitJob, updateJob,
  type EditorSchedule, type ScheduleContext } from '../src/app/editor-schedule.ts'
import { EditorScheduler, fillCommand, jobSummary } from '../src/app/editor-scheduler.ts'
import { KV } from '../src/kv.ts'

const T0 = Date.parse('2026-11-05T01:00:00.000Z')
const free: EditorView = { holder: 'none', activity: 'unknown', since: null, pid: null, build: null, at: new Date(T0).toISOString(), editors: [] }
const personEditor = (pid = 50, started = '2026-11-05T00:00:00.000Z'): EditorView => ({ holder: 'person', activity: 'editing', since: started,
  pid, build: null, at: new Date(T0).toISOString(), editors: [{ pid, name: 'unrealeditor', started }] })
/** Ids stay unique across calls, as the scheduler's random ids do. */
let next = 0
function context(overrides: Partial<ScheduleContext> = {}): ScheduleContext {
  return { now: T0, editor: free, live: () => true, id: () => `id${++next}`, ...overrides }
}

describe('acquire and release', () => {
  it('grants a free editor at once and queues the next Ticket behind it', () => {
    const first = acquire(emptySchedule(), { ticketId: 'a', purpose: 'test', note: 'Game.Smoke' }, context())
    expect(first.result.state).toBe('granted')
    expect(first.schedule.lease).toMatchObject({ holder: { kind: 'agent', ticketId: 'a' }, purpose: 'test', note: 'Game.Smoke' })
    const second = acquire(first.schedule, { ticketId: 'b', purpose: 'build' }, context({ id: () => 'q-b' }))
    expect(second.result).toMatchObject({ state: 'queued', position: 1 })
    // Releasing hands the editor to the waiter.
    const released = advance(release(second.schedule, 'a', context()), context())
    expect(released.granted?.holder).toEqual({ kind: 'agent', ticketId: 'b' })
    expect(released.schedule.events.map(item => item.kind)).toEqual(['queued', 'granted', 'queued', 'released', 'granted'])
  })

  it('refreshes a holder in place and keeps a waiter at its position', () => {
    const held = acquire(emptySchedule(), { ticketId: 'a', purpose: 'use' }, context()).schedule
    const again = acquire(held, { ticketId: 'a', purpose: 'test', ttlMs: 30 * 60_000 }, context({ now: T0 + 60_000 }))
    expect(again.result.state).toBe('granted')
    expect(again.schedule.lease).toMatchObject({ purpose: 'test', expiresAt: new Date(T0 + 31 * 60_000).toISOString() })
    const waiting = acquire(again.schedule, { ticketId: 'b', purpose: 'use' }, context()).schedule
    const twice = acquire(waiting, { ticketId: 'b', purpose: 'build', note: 'after sync' }, context())
    expect(twice.schedule.queue).toHaveLength(1)
    expect(twice.schedule.queue[0]).toMatchObject({ purpose: 'build', note: 'after sync' })
  })

  it('lapses a lease without a heartbeat and drops the waits and lease of an ended Ticket', () => {
    const held = acquire(emptySchedule(), { ticketId: 'a', purpose: 'use', ttlMs: 60_000 }, context()).schedule
    const beat = heartbeat(held, 'a', context({ now: T0 + 50_000 }), 120_000)
    expect(advance(beat, context({ now: T0 + 100_000 })).schedule.lease).not.toBeNull()
    const lapsed = advance(beat, context({ now: T0 + 200_000 })).schedule
    expect(lapsed.lease).toBeNull()
    expect(lapsed.events.at(-1)).toMatchObject({ kind: 'expired', ticketIds: ['a'] })
    expect(() => heartbeat(lapsed, 'a', context())).toThrow(/does not hold/)
    const both = acquire(held, { ticketId: 'b', purpose: 'use' }, context()).schedule
    const ended = advance(both, context({ live: id => id !== 'a' && id !== 'b' })).schedule
    expect(ended.lease).toBeNull()
    expect(ended.queue).toEqual([])
  })
})

describe('a person outranks agents', () => {
  it('holds agents back while an interactive editor no agent started is open, until the person yields it', () => {
    const editor = personEditor()
    const queued = acquire(emptySchedule(), { ticketId: 'a', purpose: 'test' }, context({ editor }))
    expect(queued.result).toMatchObject({ state: 'queued', position: 1 })
    expect(personBlock(queued.schedule, editor)).toBe('editor')
    const yielded = personAct(queued.schedule, { kind: 'yield' }, context({ editor })).schedule
    expect(yielded.yielded?.pids).toEqual([50])
    expect(advance(yielded, context({ editor })).granted?.holder).toEqual({ kind: 'agent', ticketId: 'a' })
    // The yield ends with the editor: a new interactive editor is the person's again.
    const closed = advance(yielded, context({ editor: free })).schedule
    expect(closed.yielded).toBeUndefined()
    expect(personBlock(closed, personEditor(77))).toBe('editor')
  })

  it('reads an editor started under an agent lease as the agent\'s, and an unreadable probe as a person', () => {
    const held = acquire(emptySchedule(), { ticketId: 'a', purpose: 'restart' }, context()).schedule
    const started = new Date(T0 + 30_000).toISOString()
    const editor = personEditor(88, started)
    const seen = advance(held, context({ now: T0 + 40_000, editor })).schedule
    expect(seen.agentPids).toEqual([88])
    expect(personBlock(release(seen, 'a', context()), editor)).toBeNull()
    expect(personBlock(emptySchedule(), null)).toBe('unknown')
    expect(personBlock(emptySchedule(), { ...free, holder: 'unknown' })).toBe('unknown')
  })

  it('lets a person claim: the agent drains, the claim waits first in line, and yields back to the queue', () => {
    let schedule: EditorSchedule = acquire(emptySchedule(), { ticketId: 'a', purpose: 'use' }, context()).schedule
    schedule = acquire(schedule, { ticketId: 'b', purpose: 'use' }, context()).schedule
    const claimed = personAct(schedule, { kind: 'claim' }, context())
    expect(claimed.drained?.holder).toEqual({ kind: 'agent', ticketId: 'a' })
    expect(claimed.schedule.lease?.draining?.reason).toBe('人要用编辑器')
    expect(ordered(claimed.schedule.queue)[0]?.person).toBe(true)
    const afterRelease = advance(release(claimed.schedule, 'a', context()), context())
    expect(afterRelease.granted?.holder).toEqual({ kind: 'person' })
    expect(afterRelease.schedule.lease?.expiresAt).toBeNull()
    expect(acquire(afterRelease.schedule, { ticketId: 'c', purpose: 'test' }, context()).result.state).toBe('queued')
    const done = advance(personAct(afterRelease.schedule, { kind: 'yield' }, context()).schedule, context())
    expect(done.granted?.holder).toEqual({ kind: 'agent', ticketId: 'b' })
  })

  it('moves a wait to the front, cancels one, and refuses a wait that is gone', () => {
    let schedule: EditorSchedule = acquire(emptySchedule(), { ticketId: 'a', purpose: 'use' }, context()).schedule
    let n = 0
    for (const id of ['b', 'c', 'd']) schedule = acquire(schedule, { ticketId: id, purpose: 'use' }, context({ now: T0 + ++n, id: () => `q-${id}` })).schedule
    expect(ordered(schedule.queue).map(request => request.ticketIds[0])).toEqual(['b', 'c', 'd'])
    schedule = personAct(schedule, { kind: 'front', requestId: 'q-d' }, context()).schedule
    expect(ordered(schedule.queue).map(request => request.ticketIds[0])).toEqual(['d', 'b', 'c'])
    expect(standing(schedule, 'b')).toMatchObject({ state: 'queued', position: 2 })
    schedule = personAct(schedule, { kind: 'cancel', requestId: 'q-b' }, context()).schedule
    expect(schedule.queue.map(request => request.ticketIds[0])).toEqual(['c', 'd'])
    expect(() => personAct(schedule, { kind: 'cancel', requestId: 'q-b' }, context())).toThrow(/no longer/)
  })
})

describe('host-run jobs', () => {
  it('merges builds of one workspace into one run, and keeps another workspace\'s build apart', () => {
    let schedule: EditorSchedule = acquire(emptySchedule(), { ticketId: 'x', purpose: 'use' }, context()).schedule
    const first = submitJob(schedule, { kind: 'build', ticketId: 'a', directory: 'E:/sun' }, context({ id: () => 'j1' }))
    const second = submitJob(first.schedule, { kind: 'build', ticketId: 'b', directory: 'E:/sun' }, context())
    expect(second.merged).toBe(true)
    expect(second.job.ticketIds).toEqual(['a', 'b'])
    const other = submitJob(second.schedule, { kind: 'build', ticketId: 'c', directory: 'E:/other' }, context({ id: () => 'j2' }))
    expect(other.merged).toBe(false)
    schedule = advance(release(other.schedule, 'x', context()), context()).schedule
    expect(schedule.lease?.holder).toEqual({ kind: 'job', jobId: 'j1', ticketIds: ['a', 'b'] })
    schedule = updateJob(schedule, 'j1', { state: 'succeeded', summary: 'Result: Succeeded' }, context())
    expect(schedule.lease).toBeNull()
    expect(advance(schedule, context()).schedule.lease?.holder).toMatchObject({ kind: 'job', jobId: 'j2' })
  })

  it('folds a waiting build queued in parallel into the build that is granted', () => {
    let schedule: EditorSchedule = acquire(emptySchedule(), { ticketId: 'x', purpose: 'use' }, context()).schedule
    schedule = submitJob(schedule, { kind: 'test', ticketId: 'a', directory: 'E:/sun', filter: 'Game.Smoke' }, context({ id: () => 't1' })).schedule
    schedule = submitJob(schedule, { kind: 'build', ticketId: 'b', directory: 'E:/sun' }, context({ id: () => 'b1' })).schedule
    // A second build job created before the first merged in (as two submits racing would) is absorbed at grant time.
    schedule.jobs.push({ id: 'b2', kind: 'build', ticketIds: ['c'], directory: 'E:/sun', state: 'queued', createdAt: new Date(T0).toISOString() })
    schedule.queue.push({ id: 'qb2', ticketIds: ['c'], purpose: 'build', note: '', at: new Date(T0 + 5).toISOString(), jobId: 'b2', ttlMs: 60_000 })
    schedule = personAct(schedule, { kind: 'front', requestId: ordered(schedule.queue).find(item => item.jobId === 'b1')!.id }, context()).schedule
    schedule = advance(release(schedule, 'x', context()), context()).schedule
    expect(schedule.lease?.holder).toEqual({ kind: 'job', jobId: 'b1', ticketIds: ['b', 'c'] })
    expect(schedule.jobs.find(job => job.id === 'b2')).toMatchObject({ state: 'cancelled', summary: 'merged into b1' })
    expect(schedule.queue.map(item => item.jobId)).toEqual(['t1'])
  })
})

describe('commands and summaries', () => {
  it('fills placeholders with quoted values', () => {
    expect(fillCommand('ue.cmd <project> -ExecCmds="Automation RunTests <filter>" -cwd <dir>',
      { project: 'E:/a b/Game.uproject', dir: 'E:/sun', filter: 'Game.Smoke' }))
      .toBe('ue.cmd "E:/a b/Game.uproject" -ExecCmds="Automation RunTests "Game.Smoke"" -cwd E:/sun')
  })
  it('reads UBT\'s verdict and the automation counts, never a passing summary without evidence', () => {
    expect(jobSummary('build', 'warning X\nResult: Succeeded\nTotal time 3s', 0)).toBe('Result: Succeeded')
    expect(jobSummary('test', 'LogAutomationController: Test Completed. Result={Success} Name={A}\nLogAutomationController: Test Completed. Result={Fail} Name={B}', 1))
      .toBe('automation: 1 passed, 1 failed')
    expect(jobSummary('test', 'no tests ran', 0)).toBe('exit 0 · no tests ran')
  })
})

describe('ue-mcp bridge state', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  it('reads the newest snapshot of a running editor and its live bridges, and flags a blocking dialog', () => {
    const root = mkdtempSync(join(tmpdir(), 'ue-mcp-'))
    dirs.push(root)
    const bridge = join(root, 'Saved', 'UE_MCP_Bridge')
    mkdirSync(join(bridge, 'instances'), { recursive: true })
    const at = new Date(T0).toISOString()
    writeFileSync(join(bridge, 'status.json'), JSON.stringify({ phase: 'ready', pid: 7, gameThreadTicking: true, gameThreadStalledSeconds: 0,
      modal: { title: 'Save changes?', message: 'Unsaved', buttons: ['Save', 'Don\'t Save'] }, compiling: { shaders: 0, assets: 0 },
      handler: null, writtenAt: at }))
    writeFileSync(join(bridge, 'instances', '7.json'), JSON.stringify({ pid: 7, port: 51240, state: 'listening', startedAt: at }))
    writeFileSync(join(bridge, 'instances', '9.json'), JSON.stringify({ pid: 9, port: 51241, state: 'listening', startedAt: at }))
    const state = readEngineState(join(root, 'Game.uproject'), T0 + 1000, pid => pid === 7)
    expect(state).toMatchObject({ source: 'status.json', phase: 'ready', pid: 7, stale: false,
      modal: { title: 'Save changes?', blocking: true }, bridges: [{ pid: 7, port: 51240 }] })
    expect(engineSummary(state)).toEqual({ tone: 'blocked', text: 'dialog: Save changes?' })
    expect(readEngineState(join(root, 'Game.uproject'), T0 + 1000, () => false).source).toBe('none')
  })
  it('says why nothing was read and calls an old snapshot stale', () => {
    expect(readEngineState('').detail).toMatch(/no project/)
    expect(readEngineState(join(tmpdir(), 'missing-project', 'Game.uproject')).detail).toMatch(/not deployed/)
    const old = parseEngineSnapshot({ phase: 'ready', writtenAt: new Date(T0).toISOString() }, T0 + 120_000)
    expect(old.stale).toBe(true)
    expect(engineSummary({ ...old, bridges: [] }).tone).toBe('off')
    expect(engineSummary({ ...parseEngineSnapshot({ phase: 'loading map', slowTask: { name: 'Loading', fraction: 0.4 },
      writtenAt: new Date(T0).toISOString() }, T0), bridges: [] })).toEqual({ tone: 'busy', text: 'Loading 40%' })
  })
})

describe('EditorScheduler', () => {
  const memory = () => {
    const values = new Map<string, unknown>()
    return { get: <V>(key: string) => values.get(key) as V | undefined, set: (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      atomic: <T>(operation: () => T) => operation() }
  }
  const fakeChild = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 0 }) as unknown as ChildProcess

  it('runs a granted build once for every waiting Ticket and tells each its result', async () => {
    const notices: [string, string][] = []
    const children: ChildProcess[] = []
    const logDir = mkdtempSync(join(tmpdir(), 'editor-jobs-'))
    const scheduler = new EditorScheduler({ store: memory(), live: () => true, editor: () => free, logDir, warn: () => {},
      commands: () => ({ project: '', build: 'build.bat <dir>', restart: '', test: '' }),
      notify: async (ticketId, _id, text) => { notices.push([ticketId, text]) },
      spawn: () => { const child = fakeChild(); children.push(child); return child } })
    scheduler.acquire({ ticketId: 'x', purpose: 'use' })
    scheduler.submit('a', 'build', 'E:/sun')
    expect(scheduler.submit('b', 'build', 'E:/sun').merged).toBe(true)
    expect(() => scheduler.submit('a', 'restart', 'E:/sun')).toThrow(/no restart command/)
    scheduler.release('x')
    expect(children).toHaveLength(1)
    const running = scheduler.read().jobs[0]!
    expect(running).toMatchObject({ state: 'running', ticketIds: ['a', 'b'], command: 'build.bat E:/sun' })
    const waited = scheduler.waitFor(() => { const job = scheduler.job(running.id); return job?.state === 'succeeded' ? job : undefined }, 5_000)
    ;(children[0]!.stdout as EventEmitter).emit('data', 'Result: Succeeded\n')
    children[0]!.emit('close', 0)
    expect(await waited).toMatchObject({ state: 'succeeded', summary: 'Result: Succeeded', exitCode: 0 })
    expect(scheduler.read().lease).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(notices.filter(([, text]) => text.includes('succeeded')).map(([id]) => id)).toEqual(['a', 'b'])
    scheduler.dispose()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('marks a job that was running when the host stopped as interrupted, and asks a drained agent to release', async () => {
    const store = memory()
    const notices: string[] = []
    const host = { store, live: () => true, editor: () => free, logDir: tmpdir(), warn: () => {},
      commands: () => ({ project: '', build: '', restart: '', test: '' }), notify: async (_ticket: string, id: string) => { notices.push(id) } }
    const before = new EditorScheduler(host)
    before.acquire({ ticketId: 'a', purpose: 'use' })
    const schedule = before.read()
    schedule.jobs.push({ id: 'j', kind: 'build', ticketIds: ['a'], directory: 'E:/sun', state: 'running', createdAt: new Date(T0).toISOString() })
    store.set(KV.editor.schedule, schedule)
    const after = new EditorScheduler(host)
    after.start()
    expect(after.job('j')).toMatchObject({ state: 'interrupted' })
    after.act({ kind: 'preempt', reason: 'need PIE' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(after.read().lease?.draining?.reason).toBe('need PIE')
    expect(notices.some(id => id.startsWith('editor-drain:'))).toBe(true)
    after.dispose()
  })
})
