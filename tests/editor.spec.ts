/** Editor occupancy: the process-table derivation, the probe's parser, and the cached row the overview reads. */
import { describe, expect, it, vi } from 'vitest'
import { deriveEditor, Editor, parseEditorProcesses, type EditorProcess } from '../src/app/editor.ts'

const at = '2026-11-02T15:30:00.000Z'
const process = (pid: number, name: string, started: string | null = '2026-11-02T14:30:29.0000000Z'): EditorProcess => ({ pid, name, started })

describe('deriveEditor', () => {
  it('reads an empty process table as free, not as unknown', () => {
    expect(deriveEditor([], at)).toEqual({ holder: 'none', activity: 'unknown', since: null, pid: null, at })
  })
  it('treats an interactive editor as a person and keeps its process and start time', () => {
    expect(deriveEditor([process(86916, 'unrealeditor')], at)).toEqual({ holder: 'person', activity: 'editing', since: '2026-11-02T14:30:29.0000000Z', pid: 86916, at })
  })
  it('treats a headless commandlet as an agent', () => {
    expect(deriveEditor([process(7, 'unrealeditor-cmd')], at)).toMatchObject({ holder: 'agent', activity: 'editing', pid: 7 })
  })
  it('prefers the interactive editor when a headless one is also running', () => {
    expect(deriveEditor([process(7, 'unrealeditor-cmd'), process(8, 'unrealeditor')], at)).toMatchObject({ holder: 'person', pid: 8 })
  })
  it('reports a build tool as building, with or without an editor', () => {
    expect(deriveEditor([process(9, 'shadercompileworker')], at)).toEqual({ holder: 'none', activity: 'building', since: null, pid: null, at })
    expect(deriveEditor([process(10, 'unrealbuildtool'), process(11, 'unrealeditor')], at)).toMatchObject({ holder: 'person', activity: 'building' })
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
})
