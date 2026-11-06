/** The night reproduction queue (docs/029): its window, the idle gate, one case a night, and the run it records. */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDLE_DEFAULTS, nightKey, type IdleLevel, type IdleState, type Ticket } from '../src/core/index.ts'
import { matchedReproCaseIds } from '../src/app/repro.ts'
import { NightRepro, type NightReproHost } from '../src/app/night-repro.ts'
import { ReproRunner } from '../src/app/repro-runner.ts'
import { IdleConfigSchema, type Settings } from '../src/policy.ts'

const dirs: string[] = []
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'night-repro-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A local wall-clock time, so the window checks do not depend on the machine's time zone. */
const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 10, day, hour, minute, 0, 0)
const iso = (date: Date): string => date.toISOString()

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return { id: 'deadbeef-ticket', title: '一个待验收工单', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v1',
    basis: { via: 'listed' }, actor: { source: 'tapd', id: 'alice' }, scope: 'fix' }, channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: iso(at(6, 21)), updatedAt: iso(at(6, 21)), origin: { triggerId: 'x', triggerIds: ['x'] },
    priority: { level: 'P2', source: 'default', at: iso(at(6, 21)), note: 'automatic' }, idle: { enteredAt: iso(at(6, 21)) },
    verification: { at: iso(at(6, 22)), state: 'pending' },
    execution: { name: 'night-repro', directory: 'C:/work', assignment: 'a', verification: 'Saved/ReproTests/demo-case' },
    ...overrides } as unknown as Ticket
}

/** Writes one runnable case folder, with a report the case writes when it runs. */
function caseFolder(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'case.json'), JSON.stringify({ name: id, description: 'night case', ...manifest }))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content)
  return directory
}

function memory() {
  const values = new Map<string, unknown>()
  return { get: <V>(key: string & { readonly __value?: V }) => values.get(key) as V | undefined,
    set: <V>(key: string & { readonly __value?: V }, value: V) => { values.set(key, value) } }
}
const fakeChild = (): ChildProcess => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4_242 }) as unknown as ChildProcess

function ticketsOf(items: readonly Ticket[]) {
  const byId = new Map(items.map(item => [item.id, item]))
  return { open: () => [...byId.values()].filter(item => !item.ended), list: () => [...byId.values()], save: (item: Ticket) => { byId.set(item.id, item) },
    get: (id: string) => byId.get(id) }
}
function settingsWith(repro: Partial<typeof IDLE_DEFAULTS.repro> = {}): Settings {
  return { executor: { idle: { ...IDLE_DEFAULTS, repro: { ...IDLE_DEFAULTS.repro, ...repro } } } } as unknown as Settings
}
const idleState = (level: IdleLevel | undefined): IdleState => ({ level,
  signals: { queue: !level, capacity: true, window: !!level, human: true, guard: true }, reason: 'test' })

interface Harness {
  root: string
  tickets: ReturnType<typeof ticketsOf>
  runner: ReproRunner
  night: NightRepro
  children: ChildProcess[]
  setNow(date: Date): void
  setLevel(level: IdleLevel | undefined): void
}
function harness(options: { items: Ticket[]; cases?: Record<string, Record<string, unknown>>; files?: Record<string, string>
  now?: Date; level?: IdleLevel | undefined; repro?: Partial<typeof IDLE_DEFAULTS.repro>; blocked?: 'agent' | 'job' | null; real?: boolean }): Harness {
  const root = temp()
  for (const [id, manifest] of Object.entries(options.cases ?? {})) caseFolder(root, id, manifest)
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const tickets = ticketsOf(options.items)
  const children: ChildProcess[] = []
  const store = memory()
  let now = options.now ?? at(7, 3)
  let level = 'level' in options ? options.level : 'L3'
  const runner = new ReproRunner({ store, root: () => root, logDir: join(root, '.runs'), now: () => now.getTime(), warn: () => {},
    ...options.real ? {} : { spawn: () => { const child = fakeChild(); children.push(child); return child }, kill: () => {} } })
  const night = new NightRepro({ store: { tickets, settings: () => settingsWith(options.repro) } as unknown as NightReproHost['store'],
    repro: runner, idle: { state: () => idleState(level) }, blocked: () => options.blocked ?? null, now: () => now, warn: () => {} })
  return { root, tickets, runner, night, children, setNow: date => { now = date }, setLevel: value => { level = value } }
}

describe('the night key', () => {
  it('names the evening a night belongs to, not the calendar date after midnight', () => {
    const window = IDLE_DEFAULTS.repro.window
    expect(nightKey(at(6, 21), window)).toBe('2026-11-06')
    expect(nightKey(at(7, 3), window)).toBe('2026-11-06')
    expect(nightKey(at(7, 7, 59), window)).toBe('2026-11-06')
    expect(nightKey(at(7, 12), window)).toBe('2026-11-07')
  })
})

describe('the night queue', () => {
  it('stays out of the day even with a delivered ticket and a runnable case', () => {
    const night = harness({ items: [ticket()], cases: { 'demo-case': { command: 'node run.js' } }, now: at(7, 12) })
    night.night.tick()
    expect(night.children).toHaveLength(0)
    expect(night.tickets.get('deadbeef-ticket')?.idle?.repro).toBeUndefined()
  })

  it('waits while the idle judgement holds, or while an agent or host job holds the editor', () => {
    const busy = harness({ items: [ticket()], cases: { 'demo-case': { command: 'node run.js' } }, level: undefined })
    busy.night.tick()
    expect(busy.children).toHaveLength(0)

    const held = harness({ items: [ticket()], cases: { 'demo-case': { command: 'node run.js' } }, blocked: 'agent' })
    held.night.tick()
    expect(held.children).toHaveLength(0)
  })

  it('starts the verification case of a delivered pooled ticket, records it on the ticket, and reconciles its verdict', () => {
    const night = harness({ items: [ticket()], cases: { 'demo-case': { command: 'node run.js' } } })
    night.night.tick()
    expect(night.children).toHaveLength(1)
    const started = night.tickets.get('deadbeef-ticket')!
    expect(started.idle?.repro).toMatchObject({ caseId: 'demo-case', state: 'running', night: '2026-11-06' })
    const run = night.runner.tick()[0]!
    expect(run).toMatchObject({ caseId: 'demo-case', origin: 'night' })
    ;(night.children[0]!.stdout as EventEmitter).emit('data', 'played the case\n')
    night.children[0]!.emit('close', 0)
    night.night.tick()
    expect(night.tickets.get('deadbeef-ticket')?.idle?.repro).toMatchObject({ caseId: 'demo-case', state: 'succeeded',
      exitCode: 0, summary: 'played the case' })
    // Only one case a night (the default perNight), so the reconciled run does not start another one.
    expect(night.children).toHaveLength(1)
  })

  it('actually runs the case and leaves its report where the acceptance page reads it', async () => {
    const night = harness({ items: [ticket()], real: true,
      cases: { 'demo-case': { command: 'node run.js', report: 'report.txt' } },
      files: { 'demo-case/run.js': 'require("fs").writeFileSync("report.txt", "night replay ok")' } })
    night.night.tick()
    await vi.waitFor(() => { expect(night.runner.tick()[0]?.state).toBe('succeeded') }, { timeout: 15_000 })
    night.night.tick()
    const recorded = night.tickets.get('deadbeef-ticket')!.idle!.repro!
    expect(recorded).toMatchObject({ caseId: 'demo-case', state: 'succeeded', exitCode: 0, report: 'report.txt' })
    expect(readFileSync(join(night.root, 'demo-case', 'report.txt'), 'utf8')).toBe('night replay ok')
    expect(existsSync(join(night.root, '.runs', `${recorded.runId}.log`))).toBe(true)
  })

  it('does not revisit a ticket, skips tickets that are not awaiting verification, and runs another night', () => {
    const seen = ticket({ id: 'deadbeef-seen', idle: { enteredAt: iso(at(5, 21)), repro: { caseId: 'demo-case', runId: 'r1',
      state: 'succeeded', night: '2026-11-05', startedAt: iso(at(5, 22)) } } })
    // A pooled ticket with no delivered change (its analysis, or nothing yet) has no case to replay.
    const unverified = ticket({ id: 'deadbeef-unverified', verification: undefined })
    const night = harness({ items: [seen, unverified], cases: { 'demo-case': { command: 'node run.js' } } })
    night.night.tick()
    expect(night.children).toHaveLength(0)
    // The same ticket's case may run again on a later night only through a person's click, never the queue.
    night.setNow(at(8, 3))
    night.night.tick()
    expect(night.children).toHaveLength(0)
  })

  it('runs up to perNight cases, oldest pool entry first', () => {
    const older = ticket({ id: 'deadbeef-older', idle: { enteredAt: iso(at(6, 20)) }, execution: { name: 'x', directory: 'x', assignment: 'a',
      verification: 'Saved/ReproTests/demo-case' } })
    const newer = ticket({ id: 'deadbeef-newer', idle: { enteredAt: iso(at(6, 21)) } })
    const night = harness({ items: [newer, older], cases: { 'demo-case': { command: 'node run.js' } }, repro: { perNight: 2 } })
    night.night.tick()
    expect(night.runner.tick()[0]?.origin).toBe('night')
    expect(night.runner.tick()[0]?.caseId).toBe('demo-case')
    expect(night.tickets.get('deadbeef-older')?.idle?.repro?.state).toBe('running')
    ;(night.children[0]!.stdout as EventEmitter).emit('data', 'ok\n')
    night.children[0]!.emit('close', 0)
    night.night.tick()
    expect(night.tickets.get('deadbeef-newer')?.idle?.repro?.state).toBe('running')
    expect(night.children).toHaveLength(2)
    // The first ticket's verdict was reconciled, not overwritten by the second start.
    expect(night.tickets.get('deadbeef-older')?.idle?.repro).toMatchObject({ state: 'succeeded', summary: 'ok' })
  })

  it('marks a run the host restarted or lost as interrupted instead of leaving it running forever', () => {
    const waiting = ticket({ idle: { enteredAt: iso(at(6, 20)), repro: { caseId: 'demo-case', runId: 'gone', state: 'running',
      night: '2026-11-06', startedAt: iso(at(6, 23)) } } })
    const night = harness({ items: [waiting], cases: { 'demo-case': { command: 'node run.js' } } })
    night.night.tick()
    expect(night.tickets.get('deadbeef-ticket')?.idle?.repro).toMatchObject({ state: 'interrupted' })
  })

  it('skips a case folder that cannot run, and reports nothing to a person', () => {
    const night = harness({ items: [ticket()], cases: { 'demo-case': { command: '' } } })
    night.night.tick()
    expect(night.children).toHaveLength(0)
  })
})

describe('the case matching and the settings shape', () => {
  it('matches the same case the acceptance page shows: a folder named in the package, or the ticket prefix', () => {
    const cases = [{ id: '20261106-abc_demo' }, { id: 'deadbeef-other' }, { id: 'unrelated' }]
    expect(matchedReproCaseIds('Saved/ReproTests/20261106-abc_demo', cases, 'ffffffff')).toEqual(['20261106-abc_demo'])
    expect(matchedReproCaseIds(undefined, cases, 'deadbeef-1234')).toEqual(['deadbeef-other'])
    expect(matchedReproCaseIds('none', cases, 'ffffffff')).toEqual([])
  })

  it('defaults the night block without breaking settings saved before it existed', () => {
    expect(IdleConfigSchema.parse({}).repro).toEqual({ enabled: true, window: { from: '20:00', to: '08:00' }, perNight: 1 })
    const parsed = IdleConfigSchema.parse({ repro: { enabled: false, window: { from: '21:00', to: '06:00' }, perNight: 2 } })
    expect(parsed.repro).toEqual({ enabled: false, window: { from: '21:00', to: '06:00' }, perNight: 2 })
  })
})
