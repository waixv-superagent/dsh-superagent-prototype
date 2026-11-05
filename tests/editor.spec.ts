/** Editor occupancy: the process-table derivation, the probe's parser, and the cached row the overview reads. */
import { describe, expect, it, vi } from 'vitest'
import { deriveEditor, Editor, parseEditorProcesses, type EditorProcess } from '../src/app/editor.ts'

const at = '2026-11-02T15:30:00.000Z'
const process = (pid: number, name: string, started: string | null = '2026-11-02T14:30:29.0000000Z'): EditorProcess => ({ pid, name, started })

describe('deriveEditor', () => {
  it('reads an empty process table as free, not as unknown', () => {
    expect(deriveEditor([], at)).toEqual({ holder: 'none', activity: 'unknown', since: null, pid: null, build: null, at })
  })
  it('treats an interactive editor as a person and keeps its process and start time', () => {
    // The process list goes with the row, so the scheduler can tell an editor an agent started from a person's.
    expect(deriveEditor([process(86916, 'unrealeditor')], at)).toEqual({ holder: 'person', activity: 'editing',
      since: '2026-11-02T14:30:29.0000000Z', pid: 86916, build: null, at, editors: [process(86916, 'unrealeditor')] })
  })
  it('treats a headless commandlet as an agent', () => {
    expect(deriveEditor([process(7, 'unrealeditor-cmd')], at)).toMatchObject({ holder: 'agent', activity: 'editing', pid: 7 })
  })
  it('prefers the interactive editor when a headless one is also running', () => {
    expect(deriveEditor([process(7, 'unrealeditor-cmd'), process(8, 'unrealeditor')], at)).toMatchObject({ holder: 'person', pid: 8 })
  })
  it('reads a build tool as occupying the editor even when no editor is open', () => {
    expect(deriveEditor([process(9, 'shadercompileworker')], at)).toEqual({ holder: 'build', activity: 'building',
      since: '2026-11-02T14:30:29.0000000Z', pid: 9, build: { pid: 9, since: '2026-11-02T14:30:29.0000000Z' }, at })
    // An editor that is also being built for stays the holder: the row keeps answering "who is using it".
    expect(deriveEditor([process(10, 'unrealbuildtool'), process(11, 'unrealeditor')], at)).toMatchObject({ holder: 'person',
      activity: 'building', build: { pid: 10, since: '2026-11-02T14:30:29.0000000Z' } })
  })
  it('takes the earliest UnrealBuildTool as the build start, and leaves the time unknown when a UBT reports none', () => {
    const view = deriveEditor([process(3, 'shadercompileworker', '2026-11-02T14:50:00.0000000Z'),
      process(2, 'unrealbuildtool', '2026-11-02T14:10:00.0000000Z'), process(4, 'shadercompileworker', null)], at)
    expect(view).toMatchObject({ holder: 'build', since: '2026-11-02T14:10:00.0000000Z',
      build: { pid: 2, since: '2026-11-02T14:10:00.0000000Z' } })
    expect(deriveEditor([process(5, 'unrealbuildtool', null)], at))
      .toMatchObject({ holder: 'build', since: null, pid: 5, build: { pid: 5, since: null } })
    // A shader worker starts after UBT; its known start must not make an unknown UBT start look known.
    expect(deriveEditor([process(6, 'unrealbuildtool', null), process(7, 'shadercompileworker', '2026-11-02T14:05:00.0000000Z')], at))
      .toMatchObject({ holder: 'build', since: null, pid: 6, build: { pid: 6, since: null } })
    // Compare instants, not ISO text: 22:10+08:00 (= 14:10Z) is earlier than 14:20Z though it sorts later as a string.
    expect(deriveEditor([process(8, 'unrealbuildtool', '2026-11-02T14:20:00.0000000Z'),
      process(9, 'unrealbuildtool', '2026-11-02T22:10:00+08:00')], at)).toMatchObject({ since: '2026-11-02T22:10:00+08:00',
      build: { pid: 9, since: '2026-11-02T22:10:00+08:00' } })
  })
  it('uses the earliest start time when several editors are open, and ignores rows without one', () => {
    const view = deriveEditor([process(1, 'unrealeditor', '2026-11-02T15:00:00.0000000Z'), process(2, 'unrealeditor', null),
      process(3, 'unrealeditor', '2026-11-02T14:00:00.0000000Z')], at)
    expect(view.since).toBe('2026-11-02T14:00:00.0000000Z')
    expect(view.holder).toBe('person')
  })
})

describe('parseEditorProcesses', () => {
  it('parses PowerShell\'s single object and its array form alike', () => {
    expect(parseEditorProcesses('{"id":1,"name":"UnrealEditor","started":"2026-11-02T14:30:29.0000000Z"}'))
      .toEqual([{ pid: 1, name: 'unrealeditor', started: '2026-11-02T14:30:29.0000000Z' }])
    expect(parseEditorProcesses('[{"id":1,"name":"UnrealEditor.exe","started":null},{"id":2,"name":"ShaderCompileWorker","started":null}]'))
      .toEqual([{ pid: 1, name: 'unrealeditor', started: null }, { pid: 2, name: 'shadercompileworker', started: null }])
  })
  it('reads an empty probe and drops rows the operating system reported incompletely', () => {
    expect(parseEditorProcesses('')).toEqual([])
    expect(parseEditorProcesses('[{"id":null,"name":"UnrealEditor"},{"id":3},{"name":"x"}]')).toEqual([])
    expect(parseEditorProcesses('[{"id":1,"name":"UnrealEditor","started":"not a date"}]'))
      .toEqual([{ pid: 1, name: 'unrealeditor', started: null }])
  })
})

describe('Editor cache', () => {
  it('starts a probe on the first read, then serves the cached row until the interval passes', async () => {
    let now = 1_000, calls = 0
    const editor = new Editor({ now: () => now, intervalMs: 100,
      probe: async () => { calls++; return [process(1, 'unrealeditor')] } })
    expect(editor.read()).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    expect(editor.read()).toMatchObject({ holder: 'person', pid: 1 })
    now += 99
    expect(editor.read()).toMatchObject({ holder: 'person' })
    expect(calls).toBe(1)
    now += 1
    editor.read()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  })
  it('reports a probe failure as unknown, which the panel treats as a person, and keeps the reason internal', async () => {
    const warn = vi.fn()
    const editor = new Editor({ probe: async () => { throw new Error('powershell missing') }, warn })
    await editor.refresh()
    expect(editor.read()).toMatchObject({ holder: 'unknown', activity: 'unknown', since: null, detail: '读取进程表失败，按人在用' })
    expect(warn).toHaveBeenCalledWith('editor probe failed: powershell missing')
  })
  it('does not replace the row after disposal', async () => {
    let release: (value: EditorProcess[]) => void = () => {}
    const probe = () => new Promise<EditorProcess[]>(resolve => { release = resolve })
    const editor = new Editor({ probe })
    const running = editor.refresh()
    editor.dispose()
    release([process(1, 'unrealeditor')])
    await running
    expect(editor.read()).toBeNull()
  })
  it('keeps the probe rows, with their paths, for the lease guard', async () => {
    const rows = [{ ...process(1, 'unrealeditor'), path: 'E:\\sun_mainline\\Development\\Project\\Engine\\Binaries\\Win64\\UnrealEditor.exe' },
      process(2, 'unrealbuildtool')]
    const editor = new Editor({ probe: async () => rows })
    await editor.refresh()
    expect(editor.last()).toEqual(rows)
  })
})

describe('parseEditorProcesses paths', () => {
  it('keeps a reported executable path and omits an unreported one', () => {
    expect(parseEditorProcesses('[{"id":1,"name":"UnrealEditor","started":null,"path":"E:\\\\sun_mainline\\\\UnrealEditor.exe"},'
      + '{"id":2,"name":"UnrealBuildTool","started":null,"path":""}]'))
      .toEqual([{ pid: 1, name: 'unrealeditor', started: null, path: 'E:\\sun_mainline\\UnrealEditor.exe' },
        { pid: 2, name: 'unrealbuildtool', started: null }])
  })
})
