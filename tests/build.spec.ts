/** The editor page's composed compile-and-launch runs (docs/021): configuration × target × platform under one slot. */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { BuildRunner, runSummary, type BuildRunnerHost, type BuildSelection } from '../src/app/build-runner.ts'
import { buildPage } from '../src/app/views/build.ts'
import { editorRunName } from '../src/core/editor-composition.ts'
import { UserError } from '../src/core/errors.ts'
import { KV } from '../src/kv.ts'

const T0 = Date.parse('2026-11-06T02:00:00.000Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'build-')); dirs.push(dir); return dir }
const fakeChild = (pid = 5_555) => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid }) as unknown as ChildProcess
const EDITOR: BuildSelection = { target: 'SunGameEditor', configuration: 'Development', platform: 'Win64' }

function memory() {
  const values = new Map<string, unknown>()
  return { get: <V>(key: string & { readonly __value?: V }) => values.get(key) as V | undefined,
    set: <V>(key: string & { readonly __value?: V }, value: V) => { values.set(key, value) } }
}

function harness(overrides: Partial<BuildRunnerHost> = {}) {
  const store = memory()
  const children: ChildProcess[] = []
  const spawned: { command: string; cwd: string }[] = []
  const host = {
    store, logDir: temp(), project: () => 'E:/Dev/Project/SunGame/SunGame.uproject', cwd: () => 'E:/Dev/Project/SunGame',
    targets: () => ['SunGame', 'SunGameEditor'], platforms: () => ['Win64'] as const,
    buildCommand: () => 'Build.bat <target> <platform> <configuration> -Project=<project>',
    launchCommand: () => 'start UnrealEditor.exe <project>',
    blocked: () => null as 'agent' | 'job' | null,
    taken: [] as { granted: boolean; owned: boolean }[], released: 0,
    takeSlot() { const value = { granted: true, owned: true }; this.taken.push(value); return value },
    releaseSlot() { this.released++ },
    now: () => T0,
    warn: () => {},
    spawn: (command: string, cwd: string) => { spawned.push({ command, cwd }); const child = fakeChild(); children.push(child); return child },
    kill: () => {},
    ...overrides,
  } as BuildRunnerHost & { taken: { granted: boolean; owned: boolean }[]; released: number }
  return { store, host, children, spawned, runner: new BuildRunner(host) }
}

it('composes Rider’s configuration × target × platform into one build-and-launch command', () => {
  const { host, children, spawned, runner } = harness()
  expect(editorRunName('SunGameEditor', 'Development')).toBe('Development Editor SunGame')
  expect(editorRunName('SunGame', 'Shipping')).toBe('Shipping Game SunGame')
  const run = runner.start(EDITOR)
  const project = '"E:/Dev/Project/SunGame/SunGame.uproject"'
  expect(spawned).toEqual([{ command: `Build.bat SunGameEditor Win64 Development -Project=${project} && start UnrealEditor.exe ${project}`,
    cwd: 'E:/Dev/Project/SunGame' }])
  expect(run).toMatchObject({ target: 'SunGameEditor', configuration: 'Development', platform: 'Win64',
    name: 'Development Editor SunGame', state: 'running', claimed: true, pid: 5_555 })
  expect(host.taken).toEqual([{ granted: true, owned: true }])
  ;(children[0]!.stdout as EventEmitter).emit('data', 'Building...\nResult: Succeeded\n')
  expect(runner.logTail(run.id)).toBe('Building...\nResult: Succeeded\n')
  children[0]!.emit('close', 0)
  expect(host.store.get(KV.build.runs)!.runs[0]).toMatchObject({ state: 'succeeded', exitCode: 0, summary: 'Result: Succeeded' })
  expect(host.released).toBe(1)
})

it('refuses a second run, an unknown target, configuration or platform, and missing templates', () => {
  const { host, runner } = harness()
  runner.start(EDITOR)
  expect(() => runner.start(EDITOR)).toThrow(UserError)
  expect(host.released).toBe(0)
  const invalid = harness()
  expect(() => invalid.runner.start({ ...EDITOR, target: 'NoSuchTarget' })).toThrow(/target/i)
  expect(() => invalid.runner.start({ ...EDITOR, configuration: 'Debug' as never })).toThrow(/configuration/i)
  expect(() => invalid.runner.start({ ...EDITOR, platform: 'Linux' as never })).toThrow(/platform/i)
  expect(invalid.children).toEqual([])
  // The composition needs both templates; an empty one refuses before anything is spawned or claimed.
  const missing = harness({ launchCommand: () => '' })
  expect(() => missing.runner.start(EDITOR)).toThrow(/launch/i)
  expect(missing.host.taken).toEqual([])
  expect(missing.children).toEqual([])
})

it('refuses while an agent holds the editor and when the slot is not granted', () => {
  const occupied = harness({ blocked: () => 'agent' })
  expect(() => occupied.runner.start(EDITOR)).toThrow(/agent/i)
  expect(occupied.host.taken).toEqual([])
  const refused = harness({ takeSlot: () => ({ granted: false, owned: false }) })
  expect(() => refused.runner.start(EDITOR)).toThrow(/did not become yours/i)
  expect(refused.children).toEqual([])
})

it('stops a run as cancelled and releases the slot once', () => {
  const { host, children, runner } = harness()
  const run = runner.start(EDITOR)
  runner.stop(run.id)
  expect(host.store.get(KV.build.runs)!.runs[0]!.stopping).toBe(true)
  children[0]!.emit('close', null)
  expect(host.store.get(KV.build.runs)!.runs[0]).toMatchObject({ state: 'cancelled', summary: 'stopped by a person' })
  expect(host.released).toBe(1)
})

it('marks a run left by a restarted host as interrupted and gives the slot back', () => {
  const { host, runner } = harness({ alive: () => true })
  host.store.set(KV.build.runs, { runs: [{ ...EDITOR, id: 'r1', name: 'Development Editor SunGame', command: 'x', state: 'running',
    startedAt: new Date(T0 - 60_000).toISOString(), summary: '', log: '', pid: 9_001, claimed: true }] })
  const killed: number[] = []
  ;(host as { kill?: (pid: number) => void }).kill = pid => { killed.push(pid) }
  expect(runner.tick()[0]).toMatchObject({ state: 'interrupted', exitCode: null })
  expect(killed).toEqual([9_001])
  expect(host.released).toBe(1)
})

it('keeps the composed command preview and the newest runs for the page', () => {
  const { store, runner } = harness()
  expect(runner.preview(EDITOR)).toContain('Build.bat SunGameEditor Win64 Development')
  runner.start(EDITOR)
  const runs = runner.read().slice(0, 6)
  expect(runs.map(run => run.name)).toEqual(['Development Editor SunGame'])
  expect(buildPage({ targets: runner.targets(), configurations: ['Development'], platforms: runner.platforms(),
    build: 'Build.bat', launch: 'start', runs, blocked: 'agent' })).toMatchObject({
    targets: ['SunGame', 'SunGameEditor'], platforms: ['Win64'], blocked: 'agent', active: null })
  expect(store.get(KV.build.runs)!.runs).toHaveLength(1)
})

it('reads a build verdict, else the last line and the exit code', () => {
  expect(runSummary('a\nResult: Succeeded\nb', 0)).toBe('Result: Succeeded')
  expect(runSummary('Compiled fine\nDone', 0)).toBe('exit 0 · Done')
  expect(runSummary('boom', 2)).toBe('exit 2 · boom')
})

