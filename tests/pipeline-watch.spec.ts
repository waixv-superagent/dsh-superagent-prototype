import { describe, expect, it, vi } from 'vitest'
import { PipelineWatch, type PipelineWatchHost } from '../src/app/pipeline-watch.ts'
import type { PipelineReview, PipelineStatus } from '../src/app/pipeline.ts'
import type { PipelineObservation, Ticket } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'

const NOW = Date.parse('2026-11-03T00:00:00Z')
const settings = (p4: Record<string, unknown> = {}) => SettingsSchema.parse({ executor: { backend: 'p4', p4: {
  swarmUrl: 'https://swarm.example.com', user: 'agent', followupSeconds: 60, jenkinsToken: 'secret', ...p4 } } })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'ou' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-02T22:00:00Z', updatedAt: '2026-11-02T22:00:00Z',
  origin: { triggerId: 'x', triggerIds: ['x'] }, verification: { at: '2026-11-02T22:00:00Z', state: 'pending' },
  pipeline: { state: 'running', at: '2026-11-02T22:00:00Z' },
  execution: { name: 'w', directory: '/w', assignment: '', backend: 'p4', changelist: 123, review: '9' }, ...overrides })
const review = (overrides: Partial<PipelineReview> = {}): PipelineReview => ({ id: '9', state: 'needsReview', stateLabel: 'Needs Review',
  testStatus: 'pass', version: 3, change: 123, changedAt: Math.floor(NOW / 1000) - 60, commits: [], ...overrides })
const status = (overrides: Partial<PipelineStatus> = {}): PipelineStatus => ({ review: '9', url: 'https://swarm.example.com/reviews/9',
  verdict: 'pass', total: 2, pass: 2, fail: 0, running: 0, failures: [], pending: [], ai: { verdict: '结果: 审核通过✅', approved: true,
    advice: false, commentCount: 2 }, ...overrides })

function harness (tickets: Ticket[], checks: Partial<PipelineWatchHost['checks']> = {}, config: Record<string, unknown> = {},
  extra: { paused?: () => boolean } = {}) {
  const observations: [string, PipelineObservation][] = []
  const warnings: string[] = []
  const host: PipelineWatchHost = {
    tickets: { open: () => tickets }, settings: () => settings(config),
    engine: { observePipeline: (id, observation) => { observations.push([id, observation]); return tickets[0]! } },
    checks: {
      review: vi.fn(async () => review()),
      status: vi.fn(async () => status()),
      changeState: vi.fn(async () => 'pending' as const),
      jenkins: vi.fn(async () => ({ job: 'ClientBuild', build: '1', url: 'https://ci/1', errors: ['a.cpp:1:1: error: boom'], tail: [], truncated: false })),
      ...checks
    },
    ...(extra.paused ? { paused: extra.paused } : {}),
    warn: message => { warnings.push(message) },
    now: () => NOW
  }
  return { watch: new PipelineWatch(host), observations, warnings }
}

describe('PipelineWatch', () => {
  it('checks open delivered p4 tickets and skips git, ended and merged pipelines', async () => {
    const p4 = ticket()
    const other = ticket({ id: 't2', execution: { name: 'w', directory: '/w', assignment: '', backend: 'git', review: '9' } })
    const merged = ticket({ id: 't3', pipeline: { state: 'merged', at: '' } })
    const ended = ticket({ id: 't4', ended: { at: '', by: 'human', outcome: 'stopped' } })
    const h = harness([p4, other, merged, ended])
    await h.watch.poll()
    expect(h.observations.map(([id]) => id)).toEqual(['t1'])
    expect(h.observations[0]![1]).toMatchObject({ kind: 'review', check: expect.stringContaining('待人工审核') })
  })
  it('turns a new failure into one worker Input with its checks and Jenkins errors, never twice', async () => {
    const failing: Ticket = { ...ticket(), pipeline: { state: 'running', at: '2026-11-02T22:00:00Z' } }
    const h = harness([failing], { review: vi.fn(async () => review({ testStatus: 'fail' })),
      status: vi.fn(async () => status({ verdict: 'fail', fail: 1, pass: 1, failures: [{ id: 1, title: 'ClientBuild', status: 'fail', url: 'https://ci/1' }],
        ai: { verdict: '结果: 审核不通过❌', approved: false, advice: true, commentCount: 3 } })) })
    await h.watch.poll()
    expect(h.observations[0]![1]).toMatchObject({ kind: 'failure', signature: '3:fail' })
    expect((h.observations[0]![1] as Extract<PipelineObservation, { kind: 'failure' }>).detail).toContain('ClientBuild')
    expect((h.observations[0]![1] as Extract<PipelineObservation, { kind: 'failure' }>).detail).toContain('boom')

    // The same review state now carries the recorded signature: it only waits, it does not wake the worker again.
    const seen = { ...failing, pipeline: { ...failing.pipeline!, observed: '3:fail', fixAt: new Date(NOW - 60_000).toISOString(),
      fixes: 1 } }
    const again = harness([seen], { review: vi.fn(async () => review({ testStatus: 'fail' })) })
    await again.watch.poll()
    expect(again.observations).toHaveLength(1)
    expect(again.observations[0]![1]).toMatchObject({ kind: 'running' })
  })
  it('stops after the configured automatic attempt limit and asks a person', async () => {
    const failing: Ticket = { ...ticket(), pipeline: { state: 'running', at: '2026-11-02T22:00:00Z', fixes: 3 } }
    const h = harness([failing], { review: vi.fn(async () => review({ testStatus: 'fail' })), status: vi.fn(async () => status({ verdict: 'fail' })) })
    await h.watch.poll()
    expect(h.observations[0]![1]).toMatchObject({ kind: 'blocked', check: expect.stringContaining('检查失败') })
    expect((h.observations[0]![1] as Extract<PipelineObservation, { kind: 'blocked' }>).reason).toContain('连续 3 次自动修复')
  })
  it('asks a person once for a green review, mentioning the AI advice', async () => {
    const h = harness([ticket()], { status: vi.fn(async () => status({ ai: { verdict: '结果: 审核通过✅', approved: true,
      advice: true, commentCount: 4 } })) })
    await h.watch.poll()
    expect(h.observations[0]![1]).toMatchObject({ kind: 'review', check: 'Swarm 已通过（AI 有修改建议），待人工审核' })
  })
  it('treats an AI verdict that is not 通过 as a failure even when every testrun passed', async () => {
    const h = harness([ticket()], { status: vi.fn(async () => status({ ai: { verdict: '结果: 审核不通过❌', approved: false,
      advice: true, commentCount: 4 } })) })
    await h.watch.poll()
    expect(h.observations[0]![1]).toMatchObject({ kind: 'failure', signature: '3:ai', check: expect.stringContaining('AI 审核未通过') })
  })
  it('moves an approved review to the submit stage and completes on commits', async () => {
    const approved = harness([ticket()], { review: vi.fn(async () => review({ state: 'approved' })) })
    await approved.watch.poll()
    expect(approved.observations[0]![1]).toMatchObject({ kind: 'approved' })

    const submitted = harness([ticket()], { review: vi.fn(async () => review({ state: 'approved', commits: [124] })) })
    await submitted.watch.poll()
    expect(submitted.observations[0]![1]).toMatchObject({ kind: 'merged' })
  })
  it('treats a review that disappeared with its changelist as submitted', async () => {
    const h = harness([ticket()], { review: vi.fn(async () => null), changeState: vi.fn(async () => 'missing' as const) })
    await h.watch.poll()
    expect(h.observations[0]![1]).toMatchObject({ kind: 'merged', check: 'CL 已提交入库' })
  })
  it('gives a new review a grace period, then reports a vanished review that left its CL pending', async () => {
    const fresh = harness([ticket({ pipeline: { state: 'running', at: new Date(NOW - 60_000).toISOString() } })],
      { review: vi.fn(async () => null), changeState: vi.fn(async () => 'pending' as const) })
    await fresh.watch.poll()
    expect(fresh.observations[0]![1]).toMatchObject({ kind: 'running', check: '等待 Swarm review 可读' })

    const old = harness([ticket({ pipeline: { state: 'running', at: new Date(NOW - 10 * 60_000).toISOString() } })],
      { review: vi.fn(async () => null), changeState: vi.fn(async () => 'pending' as const) })
    await old.watch.poll()
    expect(old.observations[0]![1]).toMatchObject({ kind: 'blocked', check: 'Swarm review 已不存在' })
  })
  it('reports a failure with no new result as stuck instead of letting the worker reshelve in circles', async () => {
    const stuck = ticket({ assignments: [{ id: 'a', state: 'running', createdAt: '', idleAt: new Date(NOW - 90 * 60_000).toISOString() }],
      pipeline: { state: 'running', at: new Date(NOW - 90 * 60_000).toISOString(), observed: '3:fail', fixes: 1,
        fixAt: new Date(NOW - 90 * 60_000).toISOString() } })
    const h = harness([stuck], { review: vi.fn(async () => review({ testStatus: 'fail' })) })
    await h.watch.poll()
    expect(h.observations[0]![1]).toMatchObject({ kind: 'blocked', check: '失败后没有新的流水线结果' })
    expect((h.observations[0]![1] as Extract<PipelineObservation, { kind: 'blocked' }>).reason).toContain('reshelve 内容没有变化时 Swarm 不会重跑')
  })
  it('is silent while paused or disabled, and keeps checking after one ticket fails', async () => {
    const paused = harness([ticket()], {}, {}, { paused: () => true })
    await paused.watch.poll()
    expect(paused.observations).toHaveLength(0)

    const disabled = harness([ticket()], {}, { followupSeconds: 0 })
    await disabled.watch.poll()
    expect(disabled.observations).toHaveLength(0)

    const two = ticket({ id: 't1' })
    const calls: string[] = []
    const h = harness([two, ticket({ id: 't2' })], { review: vi.fn(async id => {
      calls.push(String(id))
      if (calls.length === 1) throw new Error('network down')
      return review()
    }) })
    await h.watch.poll()
    expect(h.warnings[0]).toContain('network down')
    expect(h.observations.map(([id]) => id)).toEqual(['t2'])
  })
})
