/** The gatekeeper (docs/021): the processes a lease owns, their reclamation when the heartbeat lapses, and the gated close. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorProcess, EditorView } from '../src/app/editor.ts'
import { freshProcesses, EditorGatekeeper, type EditorGatekeeperHost } from '../src/app/editor-gatekeeper.ts'
import { EditorScheduler } from '../src/app/editor-scheduler.ts'
import { KV } from '../src/kv.ts'
import type { Health } from '../src/sources/host.ts'

const T0 = Date.parse('2026-11-05T06:40:43.000Z')
const STARTED = new Date(T0 + 1_000).toISOString()
const free: EditorView = { holder: 'none', activity: 'unknown', since: null, pid: null, build: null, at: new Date(T0).toISOString() }
/** The probe sees the editor the lease started; without it the scheduler would forget the pid it was asked to keep. */
const open = (pid = 42, started = STARTED): EditorView => ({ holder: 'person', activity: 'editing', since: started, pid,
  build: null, at: new Date(T0).toISOString(), editors: [row(pid, 'unrealeditor', started)] })
const logDirs: string[] = []

function row(pid: number, name: string, started = STARTED): EditorProcess {
  return { pid, name, started, path: `E:\\sun_mainline\\Engine\\Binaries\\Win64\\${name}.exe` }
}

function memory() {
  const values = new Map<string, unknown>()
  return { get: <V>(key: string) => values.get(key) as V | undefined, set: (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
    atomic: <T>(operation: () => T) => operation() }
}

interface Harness {
  store: ReturnType<typeof memory>
  scheduler: EditorScheduler
  gatekeeper: EditorGatekeeper
  state: { now: number; rows: readonly EditorProcess[] | null; alive: Set<number>; health: Health[]; view: EditorView | null }
  live: Set<string>
  killed: number[]
  notices: { ticketId: string; id: string; text: string }[]
  row(pid: number, name: string, started?: string): EditorProcess
  addRow(pid: number, name: string, started?: string): EditorProcess
}

function harness(): Harness {
  const store = memory()
  const logDir = mkdtempSync(join(tmpdir(), 'editor-gatekeeper-'))
  logDirs.push(logDir)
  const state = { now: T0, rows: [] as readonly EditorProcess[] | null, alive: new Set<number>(), health: [] as Health[],
    view: free as EditorView | null }
  const live = new Set(['a', 'b'])
  const killed: number[] = []
  const notices: { ticketId: string; id: string; text: string }[] = []
  const scheduler = new EditorScheduler({ store, live: id => live.has(id), editor: () => state.view, commands: () => ({ project: '', build: '', restart: '', test: '' }),
    logDir, notify: async () => {}, warn: () => {}, now: () => state.now })
  const host: EditorGatekeeperHost = { store, schedule: scheduler, rows: () => state.rows,
    alive: pid => state.alive.has(pid), kill: pid => { killed.push(pid); state.alive.delete(pid); if (state.rows) state.rows = state.rows.filter(value => value.pid !== pid) },
    live: id => live.has(id), notify: async (ticketId, id, text) => { notices.push({ ticketId, id, text }) },
    health: { get: () => state.health.at(-1), set: value => { state.health.push(value) }, release: () => {} },
    warn: () => {}, now: () => state.now }
  const gatekeeper = new EditorGatekeeper(host)
  const addRow = (pid: number, name: string, started = STARTED) => {
    const value = row(pid, name, started)
    state.rows = [...state.rows ?? [], value]
    return value
  }
  return { store, scheduler, gatekeeper, state, live, killed, notices, row, addRow }
}

afterEach(() => { while (logDirs.length) rmSync(logDirs.pop()!, { recursive: true, force: true }) })

describe('EditorGatekeeper', () => {
  it('keeps the editor a lease started when its heartbeat lapses, and tells the holder', async () => {
    const h = harness()
    expect(h.scheduler.acquire({ ticketId: 'a', purpose: 'use' }).state).toBe('granted')
    const leaseId = h.scheduler.read().lease!.id
    h.state.alive.add(42)
    h.addRow(42, 'unrealeditor')
    h.state.view = open()
    expect(h.gatekeeper.adopt('a', 42, 'editor', STARTED)).toBe(true)

    h.state.now = T0 + 16 * 60_000
    await h.gatekeeper.sweep()

    expect(h.killed).toEqual([])
    expect(h.scheduler.read().lease).toBeNull()
    const events = h.scheduler.read().events
    const expired = events.at(-2)!
    expect(expired).toMatchObject({ kind: 'expired', by: 'host', ticketIds: ['a'], purpose: 'use' })
    expect(expired.detail).toContain('heartbeat lapsed')
    expect(events.at(-1)).toMatchObject({ kind: 'kept', by: 'host', ticketIds: ['a'], detail: expect.stringContaining('kept 1 editor') })
    expect(h.scheduler.read().agentPids).toContain(42)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatchObject({ ticketId: 'a', id: `editor-reclaim:${leaseId}` })
    expect(h.notices[0]!.text).toContain('still running')
    expect(h.gatekeeper.status()).toMatchObject({ owned: 0, reclaimed: 0, kept: 1, sweeps: 1, lastReclaim: null })
  })

  it('keeps a live lease and its editor', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.state.alive.add(42)
    h.addRow(42, 'unrealeditor')
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)

    h.state.now = T0 + 60_000
    await h.gatekeeper.sweep()

    expect(h.killed).toEqual([])
    expect(h.gatekeeper.read().owned).toHaveLength(1)
    expect(h.scheduler.read().lease?.holder).toEqual({ kind: 'agent', ticketId: 'a' })
  })

  it('keeps the editor of an ended Ticket before its heartbeat would lapse', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.state.alive.add(42)
    h.addRow(42, 'unrealeditor')
    h.state.view = open()
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)
    h.live.delete('a')

    h.state.now = T0 + 60_000
    await h.gatekeeper.sweep()

    expect(h.killed).toEqual([])
    expect(h.scheduler.read().lease).toBeNull()
    const events = h.scheduler.read().events
    expect(events.at(-2)).toMatchObject({ kind: 'ended', ticketIds: ['a'] })
    expect(events.at(-1)).toMatchObject({ kind: 'kept', ticketIds: ['a'], detail: expect.stringContaining('the Ticket ended') })
    expect(h.notices).toHaveLength(0)
  })

  it('leaves the editor a Ticket released running for the next holder', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.state.alive.add(42)
    h.addRow(42, 'unrealeditor')
    h.state.view = open()
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)
    h.scheduler.release('a')

    await h.gatekeeper.sweep()

    expect(h.killed).toEqual([])
    expect(h.gatekeeper.read().owned).toEqual([])
    expect(h.scheduler.read().events.at(-1)).toMatchObject({ kind: 'kept', detail: expect.stringContaining('the lease ended') })
    expect(h.scheduler.read().agentPids).toContain(42)
    expect(h.gatekeeper.status()).toMatchObject({ kept: 1, reclaimed: 0 })
  })

  it('adopts an editor the guard never saw from the process table, and keeps it at the lapse', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.addRow(42, 'unrealeditor')
    h.state.alive.add(42)
    h.state.view = open()

    await h.gatekeeper.sweep()
    expect(h.gatekeeper.read().owned).toMatchObject([{ pid: 42, kind: 'editor', ticketId: 'a' }])
    expect(h.killed).toEqual([])

    h.state.now = T0 + 16 * 60_000
    await h.gatekeeper.sweep()
    expect(h.killed).toEqual([])
    expect(h.gatekeeper.status()).toMatchObject({ owned: 0, kept: 1, reclaimed: 0 })
  })

  it('re-keys the editor a Ticket saved across release and re-acquire instead of closing it', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.state.alive.add(42)
    h.addRow(42, 'unrealeditor')
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)
    h.scheduler.release('a')
    const again = h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    expect(again.state).toBe('granted')
    const newLease = h.scheduler.read().lease!.id

    await h.gatekeeper.sweep()

    expect(h.killed).toEqual([])
    expect(h.gatekeeper.read().owned).toHaveLength(1)
    expect(h.gatekeeper.read().owned[0]!.leaseId).toBe(newLease)
  })

  it('stops only the processes the closing Ticket owns, then gives the lease back', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.store.set(KV.editor.gatekeeper, { owned: [{ leaseId: 'someone-else', ticketId: 'b', pid: 99, kind: 'editor' as const,
      started: STARTED, expiresAt: null }], reclaimed: 0 })
    h.state.alive.add(42)
    h.state.alive.add(99)
    h.addRow(42, 'unrealeditor')
    h.addRow(99, 'unrealeditor')
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)

    expect(h.gatekeeper.close('a')).toEqual({ closed: 1 })

    expect(h.killed).toEqual([42])
    expect(h.gatekeeper.read().owned).toMatchObject([{ pid: 99, ticketId: 'b' }])
    expect(h.scheduler.read().lease).toBeNull()
    expect(() => h.gatekeeper.close('a')).toThrow(/does not hold/)
  })

  it('adopts an editor a previous agent lease left in agentPids, and keeps it at the lapse', async () => {
    const h = harness()
    // A tick of the scheduler first attributes the open editor to an agent; the lease is new (for example after a restart).
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    const schedule = h.scheduler.read()
    const started = new Date(T0 - 60_000).toISOString()
    schedule.agentPids = [42]
    h.store.set(KV.editor.schedule, schedule)
    h.addRow(42, 'unrealeditor', started)
    h.state.alive.add(42)
    h.state.view = open(42, started)

    await h.gatekeeper.sweep()
    expect(h.gatekeeper.read().owned).toMatchObject([{ pid: 42, ticketId: 'a', kind: 'editor' }])
    expect(h.killed).toEqual([])

    h.state.now = T0 + 16 * 60_000
    await h.gatekeeper.sweep()
    expect(h.killed).toEqual([])
    expect(h.gatekeeper.status()).toMatchObject({ owned: 0, kept: 1 })
  })

  it('keeps the editor but stops the build tools of the same lapsed lease', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.state.alive.add(42)
    h.state.alive.add(7)
    h.addRow(42, 'unrealeditor')
    h.addRow(7, 'unrealbuildtool')
    h.state.view = open()
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)
    h.gatekeeper.adopt('a', 7, 'build', STARTED)

    h.state.now = T0 + 16 * 60_000
    await h.gatekeeper.sweep()

    expect(h.killed).toEqual([7])
    expect(h.gatekeeper.status()).toMatchObject({ owned: 0, kept: 1, reclaimed: 1 })
    expect(h.scheduler.read().events.at(-1)!.detail).toEqual(expect.stringContaining('kept 1 editor(s) pid 42'))
    expect(h.scheduler.read().events.at(-1)!.detail).toEqual(expect.stringContaining('closed 1 process(es) pid 7'))
  })

  it('never adopts a process without a lease, and forgets a recycled pid instead of stopping it', async () => {
    const h = harness()
    expect(h.gatekeeper.adopt('a', 42, 'editor')).toBe(false)
    h.scheduler.acquire({ ticketId: 'a', purpose: 'use' })
    h.state.alive.add(42)
    h.addRow(42, 'unrealeditor')
    h.gatekeeper.adopt('a', 42, 'editor', STARTED)
    // The pid was reused by a process that is not the editor this lease started.
    h.state.rows = [h.row(42, 'unrealeditor', new Date(T0 + 30 * 60_000).toISOString())]
    h.state.now = T0 + 16 * 60_000
    await h.gatekeeper.sweep()
    expect(h.killed).toEqual([])
    expect(h.gatekeeper.read().owned).toEqual([])
  })

  it('waits for the first probe before closing anything', async () => {
    const h = harness()
    h.scheduler.acquire({ ticketId: 'a', purpose: 'test' })
    h.gatekeeper.adopt('a', 7, 'commandlet')
    h.state.alive.add(7)
    h.state.rows = null
    h.state.now = T0 + 16 * 60_000
    await h.gatekeeper.sweep()
    expect(h.killed).toEqual([])
    expect(h.gatekeeper.read().owned).toHaveLength(1)
    h.addRow(7, 'unrealeditor-cmd')
    h.state.now = T0 + 16 * 60_000 + 5_000
    await h.gatekeeper.sweep()
    expect(h.killed).toEqual([7])
  })
})

describe('freshProcesses', () => {
  it('reads one new interactive editor under a use lease, and leaves two ambiguous ones alone', () => {
    const lease = { id: 'l', holder: { kind: 'agent' as const, ticketId: 'a' }, purpose: 'use' as const, note: '', acquiredAt: new Date(T0).toISOString(),
      heartbeatAt: new Date(T0).toISOString(), expiresAt: null }
    expect(freshProcesses(lease, [row(42, 'unrealeditor')], [], []).map(value => value.pid)).toEqual([42])
    expect(freshProcesses(lease, [row(42, 'unrealeditor'), row(43, 'unrealeditor')], [], [])).toEqual([])
    expect(freshProcesses(lease, [row(42, 'unrealeditor')], [], [42])).toEqual([])
    // An editor that started before the lease is someone else's, however close.
    expect(freshProcesses(lease, [row(42, 'unrealeditor', new Date(T0 - 60_000).toISOString())], [], [])).toEqual([])
  })

  it('reads build tools for a build lease and a headless commandlet for a test lease', () => {
    const lease = (purpose: 'build' | 'test') => ({ id: 'l', holder: { kind: 'agent' as const, ticketId: 'a' }, purpose, note: '',
      acquiredAt: new Date(T0).toISOString(), heartbeatAt: new Date(T0).toISOString(), expiresAt: null })
    expect(freshProcesses(lease('build'), [row(7, 'unrealbuildtool'), row(8, 'shadercompileworker'), row(42, 'unrealeditor')], [], [])
      .map(value => value.pid)).toEqual([7, 8])
    expect(freshProcesses(lease('test'), [row(9, 'unrealeditor-cmd'), row(42, 'unrealeditor')], [], []).map(value => value.pid)).toEqual([9])
  })
})
