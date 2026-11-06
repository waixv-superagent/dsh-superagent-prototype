/**
 * The Executor's idle-pool bookkeeping: only a launch that started counts as an idle worker (docs/019). Reproduces the wedge
 * the live host hit on 2026-11-06 — a `P2` Ticket admitted at a window and then held by a later step (`Later`, retried)
 * stayed marked as an idle launch, which stopped its own retry and every other `P2`/`P3` Ticket — and the read-only analysis
 * record (docs/025) that must not outlive the attempt that never started.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Engine, MemoryRepositories, type Assignment, type GateResult, type OutboundMessage, type Policy, type Ticket } from '../src/core/index.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import { Later } from '../src/app/effects.ts'
import { SettingsSchema } from '../src/policy.ts'

const AT = '2026-11-06T04:00:00.000Z'

/** A `P2` Ticket queued for its first launch, as the idle pool leaves one while it waits. */
const ticket = (): Ticket => ({ id: 'idle-ticket', title: '步态滑步', decisionId: 'd',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'tapd', id: 'alice' }, scope: 'fix it' },
  channels: [], assignments: [{ id: 'a1', state: 'pending', createdAt: AT }], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
  origin: { triggerId: 'tapd:1:1', triggerIds: ['tapd:1:1'] }, priority: { level: 'P2', source: 'default', at: AT, note: 'automatic' },
  idle: { enteredAt: AT }, execution: { name: 'gait-slide', directory: 'C:/tmp/gait-slide', assignment: '' } } as unknown as Ticket)

/**
 * An Executor over the in-memory repositories, an Engine that records the pool's bookkeeping for real, and a captured launch
 * handler whose `launch` the test replaces: everything a held or started launch does before that point is still real.
 */
function harness () {
  const repo = new MemoryRepositories()
  repo.tickets.save(ticket())
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (): GateResult => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request: () => {}, release: () => {} },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: (_message: OutboundMessage) => {}, status: () => undefined, withdraw: () => {} },
    priorityAskMinutes: () => 30, now: () => AT })
  const settings = SettingsSchema.parse({ executor: { maxWorkers: 3 } })
  const handlers = new Map<string, (payload: never) => Promise<void>>()
  const effects = { handle: (kind: string, run: (payload: never) => Promise<void>) => { handlers.set(kind, run) }, enqueue: () => {}, pending: () => false }
  const context = new Context()
  context.reflect.provide('agents', { get: () => undefined })
  const host = { context, engine, repository: 'acme/widgets',
    store: { tickets: repo.tickets, triggers: repo.triggers, set: () => {}, settings: () => settings,
      atomic: (work: () => unknown) => work(), afterCommit: (work: () => unknown) => work() },
    effects, health: { get: () => undefined, set: () => {}, release: () => {} }, machine: { stateDir: 'C:/tmp' },
    lifetime: new AbortController().signal, sessions: {}, closing: () => false, paused: () => false, environment: () => [],
    sourceLink: async () => ({}), repliedTo: () => undefined,
    idleAdmission: () => ({ admitted: true, level: 'L2' as const, analysis: true, reason: 'the evening window, with a quiet person' }) } as unknown as ExecutorHost
  const executor = new DshExecutor(host)
  const launch = vi.spyOn(executor as unknown as { launch: (ticket: Ticket, assignment: Assignment) => Promise<void> }, 'launch')
  return { repo, handlers, launch, executor }
}

describe('idle launch bookkeeping', () => {
  it('leaves no idle record behind when the admitted launch is held, and records one when it starts', async () => {
    const h = harness()
    h.launch.mockRejectedValueOnce(new Later('Waiting for a free workspace slot'))
    await expect(h.handlers.get('launch')!({ ticketId: 'idle-ticket', assignmentId: 'a1' } as never)).rejects.toBeInstanceOf(Later)
    // The launch started nothing, so the pool counts no worker and spends none of the day's budget on it, and a later launch
    // of this Ticket will not read as the read-only analysis nobody ran.
    expect(h.repo.tickets.get('idle-ticket')!.idle).toEqual({ enteredAt: AT })
    expect(h.repo.tickets.get('idle-ticket')!.assignments.at(-1)!.state).toBe('pending')
    // The retry the effect queue makes is admitted again and now starts: the marker is there for the launch message, and the
    // record lands only once the worker runs.
    h.launch.mockImplementationOnce(async () => {
      expect(h.repo.tickets.get('idle-ticket')!.idle?.analysis).toMatchObject({ state: 'running', assignmentId: 'a1' })
      expect(h.repo.tickets.get('idle-ticket')!.idle?.launchedIn).toBeUndefined()
    })
    await h.handlers.get('launch')!({ ticketId: 'idle-ticket', assignmentId: 'a1' } as never)
    expect(h.repo.tickets.get('idle-ticket')!.idle).toMatchObject({ launchedIn: 'L2', launchedAt: expect.any(String),
      analysis: { state: 'running', assignmentId: 'a1' } })
  })

  it('drops the idle records of an Assignment that never started when the host resumes it', () => {
    const h = harness()
    const ticket = h.repo.tickets.get('idle-ticket')!
    // What the buggy build left on the live host: a launch record (and its analysis) on an Assignment that still waits.
    h.repo.tickets.save({ ...ticket, idle: { enteredAt: AT, launchedIn: 'L3', launchedAt: '2026-11-06T01:14:03.336Z',
      analysis: { state: 'running', assignmentId: 'a1', level: 'L3', startedAt: '2026-11-06T01:14:03.336Z' } } } as never)
    h.executor.resume()
    expect(h.repo.tickets.get('idle-ticket')!.idle).toEqual({ enteredAt: AT })
  })
})
