/** Whether a delivered change is in the running editor (docs/021): the timestamps, never a claim. */
import { describe, expect, it } from 'vitest'
import type { EditorProcess, EditorView } from '../src/app/editor.ts'
import { deliveryEditor } from '../src/app/editor-readiness.ts'
import type { EditorJob } from '../src/app/editor-schedule.ts'

const at = (minutes: number) => new Date(Date.parse('2026-11-06T04:00:00.000Z') + minutes * 60_000).toISOString()
const VIEW: EditorView = { holder: 'none', activity: 'unknown', since: null, pid: null, build: null, at: at(0) }
const editorRow = (pid: number, started: string): EditorProcess => ({ pid, name: 'unrealeditor', started })
const running = (started: string, pid = 42): EditorView => ({ ...VIEW, holder: 'person', activity: 'editing', since: started, pid,
  editors: [editorRow(pid, started)] })
const build = (minutes: { start: number; end: number }, directory = 'C:\\work\\a', state: EditorJob['state'] = 'succeeded'): EditorJob => ({
  id: `build-${minutes.start}`, kind: 'build', ticketIds: ['t'], directory, state, createdAt: at(minutes.start), startedAt: at(minutes.start),
  endedAt: at(minutes.end), summary: 'Result: Succeeded' })

describe('deliveryEditor', () => {
  it('cannot tell without a delivery time', () => {
    const view = deliveryEditor({ deliveredAt: undefined, directory: 'C:/work/a', editor: running(at(30)), jobs: [build({ start: 35, end: 40 })] })
    expect(view).toEqual({ state: 'unknown', editors: [at(30)] })
  })

  it('says the change was not built since it was delivered', () => {
    // The build predates the delivery, so its files cannot be the delivered ones.
    const view = deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(10)), jobs: [build({ start: 0, end: 5 })] })
    expect(view.state).toBe('build')
    expect(view.build).toMatchObject({ id: 'build-0', endedAt: at(5) })
  })

  it('does not count a successful build of another workspace', () => {
    const view = deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(30)),
      jobs: [build({ start: 0, end: 5 }), build({ start: 21, end: 25 }, 'C:/work/b')] })
    expect(view.state).toBe('build')
  })

  it('ignores a failed build, even when it ran after the delivery', () => {
    const view = deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(30)),
      jobs: [build({ start: 21, end: 25 }, 'C:/work/a', 'failed')] })
    expect(view.state).toBe('build')
  })

  it('names the newest successful build of the same workspace after the delivery', () => {
    const view = deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(50)),
      jobs: [build({ start: 21, end: 25 }), build({ start: 30, end: 40 }), build({ start: 0, end: 5 })] })
    expect(view.state).toBe('loaded')
    expect(view.build).toMatchObject({ id: 'build-30', startedAt: at(30), endedAt: at(40) })
  })

  it('matches the same workspace written with other separators and case', () => {
    const view = deliveryEditor({ deliveredAt: at(20), directory: 'C:\\Work\\A\\', editor: running(at(50)),
      jobs: [build({ start: 21, end: 25 }, 'c:/work/a')] })
    expect(view.state).toBe('loaded')
  })

  it('is loaded when the editor started after the build ended, and needs a restart when it started before', () => {
    const jobs = [build({ start: 21, end: 30 })]
    expect(deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(31)), jobs }).state).toBe('loaded')
    expect(deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(29)), jobs }).state).toBe('restart')
    // Exactly the build's end counts as loaded: the process starts after the tools finished writing.
    expect(deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: running(at(30)), jobs }).state).toBe('loaded')
  })

  it('says the editor is not running when a build is ready but no interactive editor is open', () => {
    const view = deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: VIEW, jobs: [build({ start: 21, end: 30 })] })
    expect(view.state).toBe('no-editor')
    expect(view.build).toMatchObject({ id: 'build-21' })
  })

  it('uses the newest editor when several are open', () => {
    const view: EditorView = { ...VIEW, holder: 'person', activity: 'editing', since: at(31),
      editors: [editorRow(42, at(31)), editorRow(43, at(10))] }
    expect(deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: view, jobs: [build({ start: 21, end: 30 })] }).state)
      .toBe('loaded')
  })

  it('falls back to the representative start of an older probe row', () => {
    const old: EditorView = { ...VIEW, holder: 'agent', activity: 'editing', since: at(31), pid: 42 }
    expect(deliveryEditor({ deliveredAt: at(20), directory: 'C:/work/a', editor: old, jobs: [build({ start: 21, end: 30 })] }).state)
      .toBe('loaded')
  })
})
