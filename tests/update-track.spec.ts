/** Update tracks (docs/020): the recorded track, the agent's own default, and the work this host does not deploy. */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, ticketUpdateTrack } from '../src/core/index.ts'
import type { Assessor, Candidate, EngineOptions, Executor, Policy, Ticket, Trigger } from '../src/core/index.ts'

const stored = (fields: Partial<Ticket>) => ({ title: '安装 System Informer', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
  actor: { source: 'feishu', id: 'alice' }, scope: '' }, ...fields }) as Ticket

describe('ticketUpdateTrack', () => {
  it('reads the track recorded at accept or in the worker\'s report', () => {
    expect(ticketUpdateTrack(stored({ kind: 'feature', kindSource: 'router', update: { track: 'package', source: 'router', at: 'x' } })))
      .toEqual({ track: 'package', source: 'router' })
    expect(ticketUpdateTrack(stored({ kind: 'self', kindSource: 'source', update: { track: 'package', source: 'worker', at: 'x' } })))
      .toEqual({ track: 'package', source: 'worker' })
  })
  it('defaults the agent\'s own work to hot, because this repository\'s package carries it', () => {
    expect(ticketUpdateTrack(stored({ kind: 'self', kindSource: 'source' }))).toEqual({ track: 'hot', source: 'rule' })
    expect(ticketUpdateTrack(stored({ execution: { name: 'n', directory: 'd', assignment: '', backend: 'git' } })))
      .toEqual({ track: 'hot', source: 'rule' })
  })
  it('has no track for work in another repository, which this host does not deploy', () => {
    expect(ticketUpdateTrack(stored({ category: 'bug' }))).toBeUndefined()
    expect(ticketUpdateTrack(stored({ execution: { name: 'n', directory: 'd', assignment: '', backend: 'p4' }, title: '修复崩溃' }))).toBeUndefined()
  })
})

describe('recording the track', () => {
  function harness() {
    const repo = new MemoryRepositories()
    const requests: Candidate[] = []
    const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
    const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
    const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000, revalidate: () => true, admitsInferred: () => true,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }) }
    const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor,
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      prepareTicket: ticket => ({ ...ticket, execution: { name: 'n', directory: 'd', assignment: '', backend: 'git' } }),
      now: () => '2026-11-04T00:00:00.000Z' } satisfies EngineOptions)
    const receive = (id: string): Candidate => {
      const trigger: Trigger = { id, source: 'chat', threads: [{ source: 'chat', id: `t${id}` }], actor: { source: 'chat', id: 'alice' },
        human: true, at: '2026-11-04T00:00:00Z', text: 'please', meta: {} }
      engine.receive(trigger); engine.evaluateDue()
      return requests.at(-1)!
    }
    return { repo, engine, receive }
  }
  it('records what the router named when it accepted the ticket', () => {
    const h = harness()
    const candidate = h.receive('1')
    const decision = h.engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: '热更单', scope: 's', reason: 'r', updateTrack: 'package', evalId: candidate.evalId })
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ update: { track: 'package', source: 'router' } })
  })
  it('lets the worker\'s report decide the track, keeping it on the ticket', () => {
    const h = harness()
    const candidate = h.receive('1')
    const decision = h.engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: '热更单', scope: 's', reason: 'r', evalId: candidate.evalId })
    const id = decision.ticketId!
    h.engine.report(id, { state: 'ready', summary: 'done', update: 'hot' })
    expect(h.repo.tickets.get(id)).toMatchObject({ update: { track: 'hot', source: 'worker' } })
  })
})
