/** Local reproduction cases (docs/024): reading a case folder, running one, and the report it leaves. */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inside, readReproCases, reproRoot, runSummary } from '../src/app/repro.ts'
import { ReproRunner, type ReproRunnerHost } from '../src/app/repro-runner.ts'
import { reproPage } from '../src/app/views/repro.ts'
import { KV } from '../src/kv.ts'

const T0 = Date.parse('2026-11-05T01:00:00.000Z')
const dirs: string[] = []
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'repro-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Writes one case folder with a manifest and the files a run's report or script needs. */
function caseFolder(root: string, id: string, manifest: unknown, files: Record<string, string> = {}): string {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'case.json'), JSON.stringify(manifest))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true })
    writeFileSync(join(directory, name), content)
  }
  return directory
}
function memory() {
  const values = new Map<string, unknown>()
  return { get: <V>(key: string & { readonly __value?: V }) => values.get(key) as V | undefined,
    set: <V>(key: string & { readonly __value?: V }, value: V) => { values.set(key, value) },
    atomic: <T>(operation: () => T) => operation() }
}
const fakeChild = (pid = 4_242) => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid }) as unknown as ChildProcess

interface Harness {
  root: string
  store: ReturnType<typeof memory>
  children: ChildProcess[]
  killed: number[]
  alive: Set<number>
  runner: ReproRunner
}
function harness(overrides: Partial<ReproRunnerHost> = {}): Harness {
  const root = temp()
  const store = memory()
  const children: ChildProcess[] = []
  const killed: number[] = []
  const alive = new Set<number>()
  const runner = new ReproRunner({ store, root: () => root, logDir: join(root, '.runs'), now: () => T0, warn: () => {},
    spawn: () => { const child = fakeChild(); children.push(child); return child },
    kill: pid => { killed.push(pid) }, ...overrides })
  return { root, store, children, killed, alive, runner }
}

describe('the case directory', () => {
  it('sits beside the configured editor project, and in the state directory without one', () => {
    expect(reproRoot('E:/sun_mainline/Development/Project/SunGame/SunGame.uproject', 'C:/state'))
      .toBe(join('E:/sun_mainline/Development/Project/SunGame', 'Saved', 'ReproTests'))
    expect(reproRoot('', 'C:/state')).toBe(join('C:/state', 'repro-tests'))
    expect(reproRoot('  ', 'C:/state')).toBe(join('C:/state', 'repro-tests'))
  })

  it('lists every case folder, reads its manifest, and names why a folder cannot run', () => {
    const root = temp()
    const good = caseFolder(root, 'pivot', { name: '急转复现', description: '转镜头时采样', command: 'py -3 run.py',
      report: 'reports/out.html', timeoutSeconds: 60 }, { 'reports/out.html': '<html></html>' })
    expect(good).toContain('pivot')
    caseFolder(root, 'draft', { command: '' })
    const brokenJson = join(root, 'broken')
    mkdirSync(brokenJson)
    writeFileSync(join(brokenJson, 'case.json'), '{ not json')
    const noManifest = join(root, 'empty')
    mkdirSync(noManifest)
    mkdirSync(join(root, '.hidden'))
    caseFolder(root, 'escape', { command: 'py run.py', report: '../outside.html' })
    const read = readReproCases(root)
    expect(read.problem).toBeUndefined()
    expect(read.cases.map(item => item.id)).toEqual(['broken', 'draft', 'empty', 'escape', 'pivot'])
    const pivot = read.cases.find(item => item.id === 'pivot')!
    expect(pivot).toMatchObject({ name: '急转复现', description: '转镜头时采样', command: 'py -3 run.py',
      report: 'reports/out.html', timeoutMs: 60_000 })
    expect(pivot.problem).toBeUndefined()
    expect(read.cases.find(item => item.id === 'draft')?.problem).toMatchObject({ code: 'invalidManifest' })
    expect(read.cases.find(item => item.id === 'broken')?.problem).toMatchObject({ code: 'invalidManifest' })
    expect(read.cases.find(item => item.id === 'empty')?.problem).toMatchObject({ code: 'missingManifest' })
    expect(read.cases.find(item => item.id === 'escape')?.problem).toMatchObject({ code: 'invalidReport' })
    // A folder without the manifest still lists under its own name, so a person can see what is missing.
    expect(read.cases.find(item => item.id === 'empty')).toMatchObject({ name: 'empty', timeoutMs: 20 * 60_000 })
  })

  it('reports a missing or unreadable directory instead of an empty list', () => {
    expect(readReproCases(join(temp(), 'absent')).problem).toMatchObject({ code: 'missing' })
  })

  it('keeps a report path inside the case folder and one line for the row', () => {
    const directory = temp()
    expect(inside(directory, 'reports/out.html')).toBe(join(directory, 'reports', 'out.html'))
    expect(inside(directory, '../out.html')).toBeUndefined()
    expect(inside(directory, '/etc/passwd')).toBeUndefined()
    expect(inside(directory, 'C:/Windows/win.ini')).toBeUndefined()
    expect(inside(directory, '')).toBeUndefined()
    expect(runSummary('\n started\nResult: ok \n\n')).toBe('Result: ok')
    expect(runSummary('')).toBe('')
  })
})

describe('running a case', () => {
  it('starts the command in the case folder, keeps its output, records the report and the verdict', async () => {
    const host = harness()
    const folder = caseFolder(host.root, 'pivot', { name: '急转复现', command: 'py -3 run.py', report: 'reports/out.html' },
      { 'reports/out.html': '<html></html>' })
    const commands: { command: string; cwd: string }[] = []
    host.runner = new ReproRunner({ store: host.store, root: () => host.root, logDir: join(host.root, '.runs'), now: () => T0,
      warn: () => {}, spawn: (command, cwd) => { commands.push({ command, cwd }); const child = fakeChild(); host.children.push(child); return child },
      kill: pid => { host.killed.push(pid) } })
    const run = host.runner.run('pivot')
    expect(commands).toEqual([{ command: 'py -3 run.py', cwd: folder }])
    expect(run).toMatchObject({ caseId: 'pivot', caseName: '急转复现', state: 'running', pid: 4_242 })
    ;(host.children[0]!.stdout as EventEmitter).emit('data', 'step 1\nlast line\n')
    expect(host.runner.log(run.id)).toBe('step 1\nlast line\n')
    host.children[0]!.emit('close', 0)
    const [ended] = host.store.get(KV.repro.runs)!.runs
    expect(ended).toMatchObject({ state: 'succeeded', exitCode: 0, summary: 'last line', report: 'reports/out.html' })
    expect(ended!.endedAt).toBe(new Date(T0).toISOString())
    // The log on disk keeps what the memory held, so a finished run's output stays readable after a restart.
    await vi.waitFor(() => { expect(host.runner.log(run.id)).toBe('step 1\nlast line\n') })
  })

  it('marks a non-zero exit as failed and only records a report the run actually wrote', () => {
    const host = harness()
    caseFolder(host.root, 'boom', { command: 'py -3 run.py', report: 'reports/out.html' })
    const run = host.runner.run('boom')
    ;(host.children[0]!.stderr as EventEmitter).emit('data', 'Traceback: nope\n')
    host.children[0]!.emit('close', 1)
    expect(host.store.get(KV.repro.runs)!.runs[0]).toMatchObject({ state: 'failed', exitCode: 1, summary: 'Traceback: nope' })
    expect(host.store.get(KV.repro.runs)!.runs[0]!.report).toBeUndefined()
    expect(run.state).toBe('running')
  })

  it('refuses a second run while one is in flight, and an unknown or invalid case', () => {
    const host = harness()
    caseFolder(host.root, 'one', { command: 'py -3 run.py' })
    caseFolder(host.root, 'draft', { command: '' })
    expect(() => host.runner.run('absent')).toThrow(/Unknown reproduction case/)
    host.runner.run('one')
    expect(() => host.runner.run('one')).toThrow(/already running/)
    host.children[0]!.emit('close', 0)
    expect(() => host.runner.run('draft')).toThrow(/cannot run/)
  })

  it('stops the run a person clicks, and reads its end as cancelled', () => {
    const host = harness()
    caseFolder(host.root, 'one', { command: 'py -3 run.py' })
    const run = host.runner.run('one')
    host.runner.stop(run.id)
    expect(host.killed).toEqual([4_242])
    host.children[0]!.emit('close', null)
    expect(host.store.get(KV.repro.runs)!.runs[0]).toMatchObject({ state: 'cancelled', exitCode: null, summary: 'stopped by a person' })
    expect(() => host.runner.stop(run.id)).toThrow(/already ended/)
  })

  it('kills a case that runs past its timeout and says so', () => {
    vi.useFakeTimers()
    try {
      const host = harness()
      caseFolder(host.root, 'slow', { command: 'py -3 run.py', timeoutSeconds: 10 })
      const run = host.runner.run('slow')
      vi.advanceTimersByTime(10_000)
      expect(host.killed).toEqual([4_242])
      host.children[0]!.emit('close', null)
      expect(host.store.get(KV.repro.runs)!.runs[0]).toMatchObject({ state: 'failed', summary: 'stopped after 10s' })
      expect(run.state).toBe('running')
    } finally { vi.useRealTimers() }
  })

  it('stops a run a previous host left behind and keeps its verdict for the page', () => {
    const host = harness()
    caseFolder(host.root, 'one', { command: 'py -3 run.py' })
    host.alive.add(4_242)
    host.runner = new ReproRunner({ store: host.store, root: () => host.root, logDir: join(host.root, '.runs'), now: () => T0,
      warn: () => {}, alive: pid => host.alive.has(pid), kill: pid => { host.killed.push(pid) } })
    host.store.set(KV.repro.runs, { runs: [{ id: 'r1', caseId: 'one', caseName: 'one', state: 'running',
      startedAt: new Date(T0).toISOString(), summary: '', log: '', pid: 4_242 }] })
    host.runner.start()
    expect(host.killed).toEqual([4_242])
    expect(host.store.get(KV.repro.runs)!.runs[0]).toMatchObject({ state: 'interrupted', exitCode: null })
  })

  it('stops what it started when the host goes down', () => {
    const host = harness()
    caseFolder(host.root, 'one', { command: 'py -3 run.py' })
    host.runner.run('one')
    host.runner.dispose()
    expect(host.killed).toEqual([4_242])
  })
})

describe('the page view', () => {
  it('carries the folder, the cases, the runs and what holds the editor, without an absolute case path', () => {
    const root = temp()
    const directory = caseFolder(root, 'pivot', { name: '急转复现', command: 'py -3 run.py', report: 'reports/out.html' })
    const found = readReproCases(root)
    const view = reproPage({ root, cases: found.cases, runs: [{ id: 'r1', caseId: 'pivot', caseName: '急转复现', state: 'succeeded',
      startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 1_000).toISOString(), exitCode: 0, summary: 'ok',
      report: 'reports/out.html', log: join(root, '.runs', 'r1.log') }], active: { runId: 'r2', caseId: 'pivot', tail: 'step' },
      blocked: 'job' })
    expect(view.root).toBe(root)
    expect(view.blocked).toBe('job')
    expect(view.active).toEqual({ runId: 'r2', caseId: 'pivot', tail: 'step' })
    expect(view.cases[0]).toMatchObject({ id: 'pivot', name: '急转复现', command: 'py -3 run.py', report: 'reports/out.html' })
    expect(view.cases[0]).not.toHaveProperty('directory')
    expect(directory).toContain('pivot')
    expect(view.runs[0]).toMatchObject({ state: 'succeeded', exitCode: 0, report: 'reports/out.html' })
    expect(view.runs[0]).not.toHaveProperty('log')
  })
})
