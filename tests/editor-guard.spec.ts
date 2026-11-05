/** The editor lease guard (docs/021): what a worker's shell command would launch or stop, and what the host does about it. */
import { describe, expect, it } from 'vitest'
import type { EditorProcess } from '../src/app/editor.ts'
import { EditorGuard, editorCommand, matchLaunch, type EditorGuardHost } from '../src/app/editor-guard.ts'

const T0 = Date.parse('2026-11-05T06:40:43.000Z')
const EDITOR = 'E:\\sun_mainline\\Development\\Project\\Engine\\Binaries\\Win64\\UnrealEditor.exe'
const HEADLESS = 'E:\\sun_mainline\\Development\\Project\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe'
const UBT = 'E:\\sun_mainline\\Development\\Project\\Engine\\Binaries\\DotNet\\UnrealBuildTool\\UnrealBuildTool.exe'
const PROJECT = 'E:\\sun_mainline\\Development\\Project\\SunGame\\SunGame.uproject'
const shell = (command: string) => JSON.stringify({ command })

interface Recorder {
  killed: number[]
  records: string[]
  notices: { ticketId: string; id: string; text: string }[]
  adopted: { ticketId: string; pid: number; kind: string; started: string | null }[]
}

function host(overrides: Partial<EditorGuardHost> = {}): EditorGuardHost & Recorder {
  const killed: number[] = []
  const records: string[] = []
  const notices: { ticketId: string; id: string; text: string }[] = []
  const adopted: { ticketId: string; pid: number; kind: string; started: string | null }[] = []
  const base: EditorGuardHost = {
    ticketOf: () => 't1', live: () => true, standing: () => ({ state: 'none' }), agentPids: () => [], known: () => [],
    processes: async () => [], kill: pid => { killed.push(pid) }, notify: async (ticketId, id, text) => { notices.push({ ticketId, id, text }) },
    adopt: (ticketId, pid, kind, started) => { adopted.push({ ticketId, pid, kind, started }) },
    record: (ticketId, detail) => { records.push(`${ticketId}: ${detail}`) }, warn: () => {}, now: () => T0, delay: async () => {},
  }
  return Object.assign({}, base, overrides, { killed, records, notices, adopted })
}

function row(pid: number, name: string, path: string, started = new Date(T0).toISOString()): EditorProcess {
  return { pid, name, started, path }
}

describe('editorCommand', () => {
  it('reads a PowerShell call operator, Start-Process and cmd /c as launches with their absolute path', () => {
    expect(editorCommand(`& "${EDITOR}" "${PROJECT}"`)).toEqual({
      launches: [{ kind: 'use', names: ['unrealeditor'], paths: [EDITOR] }], stop: null })
    expect(editorCommand(`Start-Process -FilePath "${EDITOR}" -ArgumentList "${PROJECT}"`))
      .toMatchObject({ launches: [{ kind: 'use', paths: [EDITOR] }] })
    expect(editorCommand(`cmd /c "${EDITOR}" "${PROJECT}"`)).toMatchObject({ launches: [{ kind: 'use', paths: [EDITOR] }] })
  })
  it('separates the headless editor and UnrealBuildTool, and finds a launch after another statement', () => {
    expect(editorCommand(`Write-Output 'go'; & "${HEADLESS}" "${PROJECT}" -nullrhi`))
      .toMatchObject({ launches: [{ kind: 'headless', names: ['unrealeditor-cmd'], paths: [HEADLESS] }] })
    expect(editorCommand(`& "${UBT}" SunGame Win64 Development -Project="${PROJECT}"`))
      .toMatchObject({ launches: [{ kind: 'build', names: ['unrealbuildtool'], paths: [UBT] }] })
  })
  it('accepts a bare program name but not a path that is only inspected', () => {
    expect(editorCommand('& UnrealEditor.exe "SunGame.uproject"')).toMatchObject({ launches: [{ kind: 'use', names: ['unrealeditor'], paths: [] }] })
    expect(editorCommand(`Get-Item "${EDITOR}" | Select-Object Length,LastWriteTime`)).toEqual({ launches: [], stop: null })
    expect(editorCommand(`Test-Path "${EDITOR}"`)).toEqual({ launches: [], stop: null })
    expect(editorCommand(`Get-Process -Name UnrealEditor`)).toEqual({ launches: [], stop: null })
  })
  it('reads a stop by process id and by image name', () => {
    expect(editorCommand('taskkill /F /PID 63748 2>&1')).toEqual({ launches: [], stop: { pids: [63748], all: false } })
    expect(editorCommand('taskkill /F /PID 76360 /PID 62068')).toEqual({ launches: [], stop: { pids: [76360, 62068], all: false } })
    expect(editorCommand('taskkill /F /IM UnrealEditor.exe')).toEqual({ launches: [], stop: { pids: [], all: true } })
    expect(editorCommand('Stop-Process -Id 101,102 -Force')).toEqual({ launches: [], stop: { pids: [101, 102], all: false } })
    expect(editorCommand('Stop-Process -Name UnrealEditor')).toEqual({ launches: [], stop: { pids: [], all: true } })
    expect(editorCommand('taskkill /F /PID 4242')).not.toBeNull()
    expect(editorCommand('Get-Process -Name UnrealEditor')).not.toHaveProperty('stop', { pids: [], all: false })
  })
})

describe('matchLaunch', () => {
  it('matches a process of the named path that started at or after the call', () => {
    expect(matchLaunch([row(42, 'unrealeditor', EDITOR)], { kind: 'use', names: ['unrealeditor'], paths: [EDITOR] }, T0)?.pid).toBe(42)
    // A process that was already running is someone else's, however coincidental the path.
    expect(matchLaunch([row(42, 'unrealeditor', EDITOR, new Date(T0 - 60_000).toISOString())],
      { kind: 'use', names: ['unrealeditor'], paths: [EDITOR] }, T0)).toBeUndefined()
    // The same program from another workspace is not the process this command started.
    expect(matchLaunch([row(42, 'unrealeditor', 'E:\\sun_agents\\Development\\Project\\Engine\\Binaries\\Win64\\UnrealEditor.exe')],
      { kind: 'use', names: ['unrealeditor'], paths: [EDITOR] }, T0)).toBeUndefined()
    // A bare command has no path to compare, so the name and the start time decide.
    expect(matchLaunch([row(7, 'unrealeditor-cmd', HEADLESS)], { kind: 'headless', names: ['unrealeditor-cmd'], paths: [] }, T0)?.pid).toBe(7)
  })
})

describe('EditorGuard', () => {
  it('stops the editor a worker started without the lease, records it and tells the worker once', async () => {
    const process = row(42, 'unrealeditor', EDITOR)
    const h = host({ processes: async () => [process] })
    new EditorGuard(h).observe('worker-t1', 'call-1', 'pwsh', shell(`& "${EDITOR}" "${PROJECT}"`))
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.killed).toEqual([42])
    expect(h.records).toEqual(['t1: started the shared editor without the lease: stopped unrealeditor (pid 42)'])
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatchObject({ ticketId: 't1', id: 'editor-bypass:call-1:use' })
    expect(h.notices[0]!.text).toContain('orchestrator_editor op=acquire')
  })
  it('leaves a launch that holds the lease alone', async () => {
    const h = host({ standing: () => ({ state: 'holding', purpose: 'use' }), processes: async () => [row(42, 'unrealeditor', EDITOR)] })
    new EditorGuard(h).observe('worker-t1', 'call-1', 'pwsh', shell(`& "${EDITOR}" "${PROJECT}"`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.killed).toEqual([])
    expect(h.records).toEqual([])
  })
  it('hands an allowed launch to the gatekeeper with the exact pid and start time', async () => {
    const started = new Date(T0 + 1_000).toISOString()
    const build = row(7, 'unrealbuildtool', UBT, started)
    const h = host({ standing: () => ({ state: 'holding', purpose: 'build' }), processes: async () => [build] })
    new EditorGuard(h).observe('worker-t1', 'call-1', 'pwsh', shell(`& "${UBT}" SunGame Win64 Development`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.adopted).toEqual([{ ticketId: 't1', pid: 7, kind: 'build', started }])
    expect(h.killed).toEqual([])
  })
  it('holds a build to a build lease, an editor to a use or restart lease, and a headless run to a test lease', async () => {
    const build = row(7, 'unrealbuildtool', UBT)
    const h = host({ standing: () => ({ state: 'holding', purpose: 'use' }), processes: async () => [build] })
    new EditorGuard(h).observe('worker-t1', 'call-1', 'pwsh', shell(`& "${UBT}" SunGame Win64 Development`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.killed).toEqual([7])
    // The notice names the lease the stopped command needed, so the retry is not refused again.
    expect(h.notices[0]!.text).toContain('purpose build')
    const allowed = host({ standing: () => ({ state: 'holding', purpose: 'build' }), processes: async () => [build] })
    new EditorGuard(allowed).observe('worker-t1', 'call-2', 'pwsh', shell(`& "${UBT}" SunGame Win64 Development`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(allowed.killed).toEqual([])
    // A test lease covers the headless commandlet an automation run uses, but not the interactive editor.
    const headless = row(8, 'unrealeditor-cmd', HEADLESS)
    const testLease = host({ standing: () => ({ state: 'holding', purpose: 'test' }), processes: async () => [headless] })
    new EditorGuard(testLease).observe('worker-t1', 'call-3', 'pwsh', shell(`& "${HEADLESS}" "${PROJECT}" -ExecCmds="Automation RunTests Game.Smoke"`))
    new EditorGuard(testLease).observe('worker-t1', 'call-4', 'pwsh', shell(`& "${EDITOR}" "${PROJECT}"`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(testLease.killed).toEqual([])
    const interactive = row(9, 'unrealeditor', EDITOR)
    const interactiveUnderTest = host({ standing: () => ({ state: 'holding', purpose: 'test' }), processes: async () => [interactive] })
    new EditorGuard(interactiveUnderTest).observe('worker-t1', 'call-5', 'pwsh', shell(`& "${EDITOR}" "${PROJECT}"`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(interactiveUnderTest.killed).toEqual([9])
    expect(interactiveUnderTest.notices[0]!.text).toContain('purpose use or restart')
  })
  it('does nothing when the command started no matching process', async () => {
    // The process was already running: the guard reports nothing, because a name alone is not a launch.
    const h = host({ processes: async () => [row(42, 'unrealeditor', EDITOR, new Date(T0 - 60_000).toISOString())] })
    new EditorGuard(h).observe('worker-t1', 'call-1', 'pwsh', shell(`& "${EDITOR}" "${PROJECT}"`))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.killed).toEqual([])
    expect(h.records).toEqual([])
    expect(h.notices).toEqual([])
  })
  it('ignores a session that is not a live worker, or a tool that cannot start a process', async () => {
    const processes = async () => [row(42, 'unrealeditor', EDITOR)]
    const other = host({ ticketOf: () => undefined, processes })
    new EditorGuard(other).observe('orchestrator', 'call-1', 'pwsh', shell(`& "${EDITOR}"`))
    const ended = host({ live: () => false, processes })
    new EditorGuard(ended).observe('worker-t1', 'call-1', 'pwsh', shell(`& "${EDITOR}"`))
    const read = host({ processes })
    new EditorGuard(read).observe('worker-t1', 'call-1', 'read', shell(`& "${EDITOR}"`))
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const h of [other, ended, read]) expect(h.killed).toEqual([])
  })
  it('reports a stop aimed at an editor the Ticket did not start, and allows its own after it released the lease', async () => {
    const editor = row(63748, 'unrealeditor', EDITOR, '2026-11-05T00:00:00.000Z')
    const h = host({ standing: () => ({ state: 'none' }), known: () => [editor] })
    new EditorGuard(h).observe('worker-t1', 'call-1', 'pwsh', shell('taskkill /F /PID 63748'))
    expect(h.records).toEqual(['t1: tried to stop pid 63748 without holding it'])
    expect(h.notices[0]).toMatchObject({ id: 'editor-stop:call-1' })
    // An editor the scheduler saw an agent open is not a person's, even after that Ticket released it to close it.
    const own = host({ standing: () => ({ state: 'none' }), known: () => [editor], agentPids: () => [63748] })
    new EditorGuard(own).observe('worker-t1', 'call-2', 'pwsh', shell('taskkill /F /PID 63748'))
    expect(own.records).toEqual([])
    const all = host({ known: () => [editor] })
    new EditorGuard(all).observe('worker-t1', 'call-3', 'pwsh', shell('taskkill /F /IM UnrealEditor.exe'))
    expect(all.records).toEqual(['t1: tried to stop every running editor without holding it'])
    // A pid that is not an editor process is a worker stopping its own job, not an editor stop.
    const other = host({ known: () => [editor] })
    new EditorGuard(other).observe('worker-t1', 'call-4', 'pwsh', shell('taskkill /F /PID 4242'))
    expect(other.records).toEqual([])
    expect(other.notices).toEqual([])
  })
  it('does not stop anything when the host is shutting down', async () => {
    const h = host({ processes: async () => [row(42, 'unrealeditor', EDITOR)] })
    const guard = new EditorGuard(h)
    guard.observe('worker-t1', 'call-1', 'pwsh', shell(`& "${EDITOR}"`))
    guard.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.killed).toEqual([])
  })
})
