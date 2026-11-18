/** Automatic deployment of a merged hot change (docs/006): what starts it, what it waits for, and what it records. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeployWatch, type DeployWatchHost } from '../src/app/deploy-watch.ts'
import type { Upgrade, UpgradeRun, UpgradeView } from '../src/app/upgrade.ts'
import type { Ticket, TicketDeploy } from '../src/core/index.ts'

const A = 'a'.repeat(40), B = 'b'.repeat(40)

/** The update service the watcher drives, with the steps a test advances by hand. */
class FakeUpgrade {
  enabled = true
  autoDeploy = true
  installed: string | null = A
  remoteSha: string | null = B
  blocked: string | null = null
  run: UpgradeRun | null = null
  preparedSha: string | null = null
  applied = 0
  prepareError: string | null = null
  async check (): Promise<void> {}
  prepare (): UpgradeRun {
    if (this.prepareError) throw Object.assign(new Error(this.prepareError), { code: this.prepareError })
    const run: UpgradeRun = { state: 'preparing', sha: this.remoteSha ?? B, from: this.installed, startedAt: '2026-11-18T00:00:00.000Z', steps: [], error: null }
    this.run = run
    this.preparedSha = run.sha
    return run
  }
  apply (): UpgradeRun {
    this.applied++
    this.run = { ...(this.run as UpgradeRun), state: 'waiting' }
    return this.run
  }
  view (): UpgradeView {
    return { enabled: this.enabled, installed: this.installed, remote: { ref: 'origin/main', sha: this.remoteSha, checkedAt: null, error: null },
      behind: [], more: false, available: true, blocked: this.blocked, run: this.run,
      prepared: this.preparedSha ? { sha: this.preparedSha } : null, running: 0 }
  }
}

const ticket = (fields: Partial<Ticket> = {}): Ticket => ({ id: 't1', title: 'ship it', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z',
  origin: { triggerId: 'tr', triggerIds: ['tr'] }, kind: 'self', kindSource: 'source',
  ended: { at: '2026-11-18T01:00:00.000Z', by: 'executor', outcome: 'merged' }, ...fields }) as Ticket

const dirs: string[] = []
function harness (journal?: unknown) {
  const stateDir = mkdtempSync(join(tmpdir(), 'deploy-watch-'))
  dirs.push(stateDir)
  if (journal) {
    mkdirSync(join(stateDir, 'deploy'), { recursive: true })
    writeFileSync(join(stateDir, 'deploy', 'status.json'), JSON.stringify(journal))
  }
  const upgrade = new FakeUpgrade()
  const recorded: [string, TicketDeploy][] = []
  const watch = new DeployWatch({ stateDir, upgrade: upgrade as unknown as DeployWatchHost['upgrade'],
    record: (ticketId, deploy) => { recorded.push([ticketId, deploy]) }, warn: () => {} })
  return { stateDir, upgrade, recorded, watch }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('deploying a merged hot change', () => {
  it('prepares the new commit, restarts into it once ready, and records that it landed', async () => {
    const h = harness()
    h.watch.start()
    h.watch.ended(ticket())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.upgrade.preparedSha).toBe(B)
    expect(h.watch.entry('t1')).toMatchObject({ state: 'preparing', sha: B })
    h.upgrade.run = { ...(h.upgrade.run as UpgradeRun), state: 'prepared' }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.upgrade.applied).toBe(1)
    h.upgrade.installed = B
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'applied', sha: B })
    h.watch.stop()
  })
  it('leaves the ticket applied when the running build already carries the merge', async () => {
    const h = harness()
    h.upgrade.installed = B
    h.watch.start()
    h.watch.ended(ticket())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'applied' })
    expect(h.upgrade.preparedSha).toBeNull()
    h.watch.stop()
  })
  it('leaves a package change, a closed pull request and a non-self ticket alone', async () => {
    const h = harness()
    h.watch.start()
    h.watch.ended(ticket({ update: { track: 'package', source: 'worker', at: '2026-11-18T00:30:00.000Z' } }))
    h.watch.ended(ticket({ id: 't2', ended: { at: '2026-11-18T01:00:00.000Z', by: 'executor', outcome: 'closed' } }))
    h.watch.ended(ticket({ id: 't3', kind: 'bug', kindSource: 'router', title: '修复崩溃' }))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.watch.entry('t1')).toBeUndefined()
    expect(h.watch.entry('t2')).toBeUndefined()
    expect(h.watch.entry('t3')).toBeUndefined()
    expect(h.upgrade.preparedSha).toBeNull()
    h.watch.stop()
  })
  it('does nothing when the deployment turned automatic updates off', async () => {
    const h = harness()
    h.upgrade.autoDeploy = false
    h.watch.start()
    h.watch.ended(ticket())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.watch.entry('t1')).toBeUndefined()
    expect(h.upgrade.preparedSha).toBeNull()
    h.watch.stop()
  })
})

describe('what the deployment records', () => {
  it('records a build that failed', async () => {
    const h = harness()
    h.watch.start()
    h.watch.ended(ticket())
    await vi.advanceTimersByTimeAsync(0)
    h.upgrade.run = { ...(h.upgrade.run as UpgradeRun), state: 'failed', error: 'pnpm test failed' }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'failed', detail: 'pnpm test failed' })
    expect(h.upgrade.applied).toBe(0)
    h.watch.stop()
  })
  it('reports a dependency change the switch cannot install instead of trying', async () => {
    const h = harness()
    h.upgrade.blocked = 'dependencies'
    h.watch.start()
    h.watch.ended(ticket())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'failed' })
    expect(h.upgrade.preparedSha).toBeNull()
    h.watch.stop()
  })
  it('reports a restart that kept waiting for idle workers', async () => {
    const h = harness()
    h.watch.start()
    h.watch.ended(ticket())
    await vi.advanceTimersByTimeAsync(0)
    h.upgrade.run = { ...(h.upgrade.run as UpgradeRun), state: 'prepared' }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.upgrade.applied).toBe(1)
    h.upgrade.run = { ...(h.upgrade.run as UpgradeRun), state: 'prepared', error: '2 workers were still running after 30 minutes' }
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'failed', detail: '2 workers were still running after 30 minutes' })
    h.watch.stop()
  })
})

describe('a host that restarts during the switch', () => {
  it('reads its deployment journal and tells whether the build landed', async () => {
    const h = harness({ tickets: [{ ticketId: 't1', state: 'applying', at: '2026-11-18T00:00:00.000Z', sha: B }] })
    h.upgrade.installed = B
    h.watch.start()
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'applied', sha: B })
    h.watch.stop()
  })
  it('records a switch that rolled back', async () => {
    const h = harness({ tickets: [{ ticketId: 't1', state: 'applying', at: '2026-11-18T00:00:00.000Z', sha: B }] })
    h.upgrade.run = { state: 'rolledBack', sha: B, from: A, startedAt: '2026-11-18T00:00:00.000Z', steps: [], error: 'the new version did not start' }
    h.watch.start()
    expect(h.recorded.at(-1)?.[1]).toMatchObject({ state: 'failed', detail: 'the new version did not start' })
    h.watch.stop()
  })
})
