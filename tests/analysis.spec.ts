/**
 * The idle pool's read-only analysis (docs/025): the instruction a worker reads, the brief its first message carries, the
 * verdict that sorts a pooled ticket, the scheduler's admission of an analysis and its hold once one finished, and the
 * Engine's report path that records the dossier without ending the ticket.
 */
import { describe, expect, it } from 'vitest'
import { MemoryRepositories, analysisAdvice, analysisAdviceFromSections, analysisBrief, analysisRunning, analysisSection, ticketStage, worthAttention,
  type Assignment, type Candidate, type GateResult, type OutboundMessage, type Policy, type Ticket, type Trigger } from '../src/core/index.ts'
import { Engine } from '../src/core/engine.ts'
import { IdleScheduler } from '../src/app/idle.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Store } from '../src/app/store.ts'

const ticketOf = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't-ticket', title: '一个工单', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v1',
  basis: { via: 'listed' }, actor: { source: 'tapd', id: 'alice' }, scope: 'fix' }, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-11-04T08:00:00.000Z', updatedAt: '2026-11-04T08:00:00.000Z', origin: { triggerId: 'x', triggerIds: ['x'] },
  priority: { level: 'P2', source: 'default', at: '2026-11-04T08:00:00.000Z', note: 'automatic' }, idle: { enteredAt: '2026-11-04T08:00:00.000Z' },
  ...overrides } as unknown as Ticket)
const pending = (id = 'a1'): Assignment[] => [{ id, state: 'pending', createdAt: '2026-11-04T08:00:00.000Z' }]

describe('the idle analysis instruction', () => {
  it('tells the worker it is read-only, which dossier to write, and that the verdict is the deliverable', () => {
    const text = analysisSection()
    expect(text).toContain('read-only')
    expect(text).toContain('结论')
    expect(text).toContain('理由')
    expect(text).toContain('Change nothing')
    expect(text).toContain('question card')
  })
  it('briefs the turn with its idle depth, the original assignment and the likely duplicates', () => {
    const brief = analysisBrief({ ticketId: 't1', title: '急转滑步', level: 'L3', assignment: '修一下急转滑步',
      related: [{ id: 't2', title: '急转朝向跳切', priority: 'P2', stage: 'working', summary: '已定位到过渡搜索' }] })
    expect(brief).toContain('L3')
    expect(brief).toContain('急转滑步')
    expect(brief).toContain('修一下急转滑步')
    expect(brief).toContain('t2')
    expect(brief).toContain('已定位到过渡搜索')
    // The guess must not read as a decision.
    expect(brief).toContain('verify them; a guess is not a decision')
  })
  it('leaves the duplicate heading out when the guess found none', () => {
    const brief = analysisBrief({ ticketId: 't1', title: 'x', level: 'L2', assignment: 'y' })
    expect(brief).not.toContain('Likely related tickets')
    expect(brief).toContain('y')
  })
  it('sorts a ticket by its verdict: only promote and merge are worth attention now', () => {
    const ready = (verdict: 'promote' | 'merge' | 'archive') => ticketOf({ idle: { enteredAt: 'x',
      analysis: { state: 'ready', assignmentId: 'a1', level: 'L3', startedAt: 'x', advice: { verdict, reason: 'r', at: 'x' } } } })
    expect(worthAttention(ready('promote'))).toBe(true)
    expect(worthAttention(ready('merge'))).toBe(true)
    expect(worthAttention(ready('archive'))).toBe(false)
    expect(worthAttention(ticketOf())).toBe(false)
    expect(analysisRunning(ready('promote'))).toBe(false)
    expect(analysisAdvice(ready('merge'))?.verdict).toBe('merge')
  })
  it('reads the verdict from the dossier report\'s sections, and records none without a reason', () => {
    expect(analysisAdviceFromSections([{ label: '结论', text: 'merge（并入 123456789abc）' }, { label: '理由', text: '同一个过渡搜索' },
      { label: '同类', text: '123456789abc、deadbeef0001' }, { label: '代价', text: '半天' }]))
      .toMatchObject({ verdict: 'merge', reason: '同一个过渡搜索', mergeWith: ['123456789abc', 'deadbeef0001'], cost: '半天' })
    expect(analysisAdviceFromSections([{ label: '结论', text: 'promote' }])).toBeUndefined()
    expect(analysisAdviceFromSections([{ label: '理由', text: '没有结论' }])).toBeUndefined()
    expect(analysisAdviceFromSections(undefined)).toBeUndefined()
  })
  it('keeps a finished analysis in the pool instead of the person lane', () => {
    const ready = ticketOf({ idle: { enteredAt: 'x', analysis: { state: 'ready', assignmentId: 'a1', level: 'L3', startedAt: 'x' } },
      assignments: [{ id: 'a1', state: 'running', createdAt: 'x', report: { state: 'ready', summary: 'dossier', at: 'x' } }] })
    expect(ticketStage(ready)).toEqual({ stage: 'idle' })
    // A person's newer message is the reason to look again: the ticket leaves the pool's wait.
    expect(ticketStage({ ...ready, undelivered: ['i1'] })).toEqual({ stage: 'person', action: 'review' })
    // A newer assignment is work again, whatever the analysis recorded before.
    expect(ticketStage({ ...ready, assignments: [{ id: 'a2', state: 'running', createdAt: 'x' }] })).toEqual({ stage: 'working' })
  })
})

/** A scheduler over a fake store, with a movable clock so a slot can stay free for the configured minutes. */
function scheduler(tickets: Ticket[], options: { now?: Date; idle?: Record<string, unknown>; list?: Ticket[] } = {}) {
  const clock = { now: options.now ?? new Date(2026, 9, 4, 20, 11) }
  const store = {
    tickets: { open: () => tickets, list: () => options.list ?? tickets },
    settings: () => SettingsSchema.parse({ executor: { idle: options.idle ?? {} } }),
    read: { recentTriggers: () => [] },
  } as unknown as Pick<Store, 'tickets' | 'settings' | 'read'>
  return { gate: new IdleScheduler({ store, now: () => clock.now }), clock }
}

describe('the idle pool admits a read-only analysis', () => {
  /** Let a worker slot stay free past `slotFreeMin` inside the night window. */
  const night = () => {
    const started = scheduler([], { now: new Date(2026, 9, 4, 23, 30) })
    started.gate.observe(0, 3)
    started.clock.now = new Date(2026, 9, 4, 23, 41)
    return started
  }
  it('marks a pooled ticket\'s first idle launch as its analysis', () => {
    const { gate } = night()
    expect(gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 }))
      .toMatchObject({ admitted: true, level: 'L3', analysis: true })
  })
  it('admits a mainline ticket without an analysis, and a person\'s waiting message as the work itself', () => {
    const { gate } = scheduler([], { now: new Date(2026, 9, 4, 10, 0) })
    expect(gate.admission(ticketOf({ priority: { level: 'P1', source: 'human', at: 'x' }, assignments: pending() }), { running: 0, max: 3 }))
      .not.toHaveProperty('analysis')
    const waiting = ticketOf({ assignments: pending(), undelivered: ['i1'], inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'om_2', at: 'x', human: true }] })
    expect(gate.admission(waiting, { running: 0, max: 3 })).not.toHaveProperty('analysis')
  })
  it('holds a ticket whose analysis already finished until a person acts on the verdict', () => {
    const { gate } = night()
    const ready = ticketOf({ assignments: pending(), idle: { enteredAt: 'x',
      analysis: { state: 'ready', assignmentId: 'a0', level: 'L3', startedAt: 'x', endedAt: 'x' } } })
    expect(gate.admission(ready, { running: 0, max: 3 })).toMatchObject({ admitted: false, reason: expect.stringContaining('waits for a person') })
    const failed = ticketOf({ assignments: pending(), idle: { enteredAt: 'x',
      analysis: { state: 'failed', assignmentId: 'a0', level: 'L3', startedAt: 'x', endedAt: 'x' } } })
    expect(gate.admission(failed, { running: 0, max: 3 })).toMatchObject({ admitted: false, reason: expect.stringContaining('did not finish') })
  })
  it('starts the ordinary work again when the analysis is switched off', () => {
    const { gate, clock } = scheduler([], { now: new Date(2026, 9, 4, 23, 30), idle: { analysis: { enabled: false } } })
    gate.observe(0, 3)
    clock.now = new Date(2026, 9, 4, 23, 41)
    expect(gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).toMatchObject({ admitted: true, level: 'L3' })
    expect(gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).not.toHaveProperty('analysis')
  })
})

/** A minimal engine over the in-memory repositories: every trigger is admitted and accepted, and the clock is fixed. */
function engineHarness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (): GateResult => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request: candidate => { requests.push(candidate) }, release: () => {} },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: (_message: OutboundMessage) => {}, status: () => undefined, withdraw: () => {} },
    priorityAskMinutes: () => 30, now: () => '2026-11-04T08:00:00.000Z' })
  const trigger = (id: string): Trigger => ({ id, source: 'tapd', threads: [{ source: 'tapd', id: `bug-${id}` }], actor: { source: 'tapd', id: 'alice' },
    human: true, addressed: 'direct', at: '2026-11-04T08:00:00.000Z', text: '崩溃：进入战斗黑屏', meta: { bugId: id, shortId: id } })
  const accept = (id = '1'): Ticket => {
    const source = trigger(id)
    engine.receive(source); engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(source.id, { kind: 'accept', title: source.text, scope: 'fix the bug', reason: 'a person asked', evalId: candidate.evalId })
    return repo.tickets.get(decision.ticketId!)!
  }
  return { engine, repo, accept }
}

describe('the engine records an analysis without ending the ticket', () => {
  it('starts an analysis, records its verdict with the dossier, and leaves the ticket waiting for a person', () => {
    const h = engineHarness()
    const ticket = h.accept()
    const assignment = ticket.assignments.at(-1)!
    h.engine.startIdleAnalysis(ticket.id, assignment.id, 'L3')
    expect(h.repo.tickets.get(ticket.id)!.idle?.analysis).toMatchObject({ state: 'running', assignmentId: assignment.id, level: 'L3' })
    const reported = h.engine.report(ticket.id, { state: 'ready', summary: '现象：… 证据：… 建议动作：推进',
      sections: [{ label: '结论', text: 'promote' }, { label: '理由', text: '能在 2 小时内修完' }] })
    expect(reported.ended).toBeUndefined()
    expect(reported.idle?.analysis).toMatchObject({ state: 'ready', endedAt: '2026-11-04T08:00:00.000Z' })
    expect(reported.idle?.analysis?.advice).toMatchObject({ verdict: 'promote', reason: '能在 2 小时内修完' })
    expect(reported.assignments.at(-1)?.report?.state).toBe('ready')
    // A ready analysis report never opens the local verification gate: it delivered nothing to verify.
    expect(reported.verification).toBeUndefined()
  })
  it('lets a ready dossier pass a p4 ticket\'s plan phase, but refuses delivery from an analysis', () => {
    const h = engineHarness()
    const ticket = h.accept()
    const assignment = ticket.assignments.at(-1)!
    const stored = h.repo.tickets.get(ticket.id)!
    stored.phase = 'plan'
    h.repo.tickets.save(stored)
    h.engine.startIdleAnalysis(ticket.id, assignment.id, 'L3')
    expect(h.engine.report(ticket.id, { state: 'ready', summary: '只读结论' }).idle?.analysis?.state).toBe('ready')
    // The analysis is settled: a later report cannot add advice to it (the plan phase refuses its ready result first).
    expect(() => h.engine.report(ticket.id, { state: 'ready', summary: '又一份',
      sections: [{ label: '结论', text: 'archive' }, { label: '理由', text: '晚了' }] })).toThrow(/deliver phase|running idle analysis/)
    const other = h.accept('2')
    const assignmentId = other.assignments.at(-1)!.id
    h.engine.startIdleAnalysis(other.id, assignmentId, 'L3')
    expect(() => h.engine.report(other.id, { state: 'ready', summary: '带交付', delivery: { changelist: 123 } })).toThrow(/read-only idle analysis/)
  })
  it('records a failed analysis so the pool does not retry it by itself', () => {
    const h = engineHarness()
    const ticket = h.accept()
    const assignmentId = ticket.assignments.at(-1)!.id
    h.engine.startIdleAnalysis(ticket.id, assignmentId, 'L2')
    const blocked = h.engine.report(ticket.id, { state: 'blocked', summary: '需要看现场日志' })
    expect(blocked.ended).toBeUndefined()
    expect(blocked.idle?.analysis?.state).toBe('failed')
  })
  it('refuses a verdict when no analysis runs, or when it names an unknown duplicate', () => {
    const h = engineHarness()
    const ticket = h.accept()
    const assignmentId = ticket.assignments.at(-1)!.id
    expect(() => h.engine.report(ticket.id, { state: 'ready', summary: 'x',
      sections: [{ label: '结论', text: 'promote' }, { label: '理由', text: 'x' }] })).toThrow(/running idle analysis/)
    h.engine.startIdleAnalysis(ticket.id, assignmentId, 'L3')
    expect(() => h.engine.report(ticket.id, { state: 'ready', summary: 'x',
      sections: [{ label: '结论', text: 'merge' }, { label: '理由', text: 'x' }, { label: '同类', text: 'deadbeef0000' }] }))
      .toThrow(/Unknown ticket deadbeef0000/)
  })
})
