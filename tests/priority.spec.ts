/**
 * Priority and idle: the rules that decide what a Ticket's level is and who may set it, the five-signal judgement of idle
 * time, the TAPD priority card, and the engine flows that record an answer or expire an unanswered question.
 */
import { describe, expect, it } from 'vitest'
import { Engine, IDLE_DEFAULTS, MemoryRepositories, defaultPriority, dailyIdleRoom, idleAdmits, idleState, localDay, priorityAnswer, priorityAskDeadline,
  priorityOfText, systemPriority, tapdSuggestion, ticketPriority, waitsForIdle, windowAt } from '../src/core/index.ts'
import type { Assignment, Candidate, GateResult, OutboundMessage, Policy, Ticket, Trigger } from '../src/core/index.ts'
import { IdleScheduler } from '../src/app/idle.ts'
import { SettingsSchema } from '../src/policy.ts'
import { priorityCard, priorityResolvedCard } from '../src/sources/feishu-card.ts'
import { priorityValue } from '../src/sources/feishu-cards.ts'
import type { Store } from '../src/app/store.ts'
import { startRuntime } from './fixtures/host.ts'

const TAPD_TRIGGER: Trigger = { id: 'tapd:1234567890000123456:1', source: 'tapd', threads: [{ source: 'tapd', id: 'bug-1' }],
  actor: { source: 'tapd', id: 'alice' }, human: true, addressed: 'direct', at: '2026-11-04T08:00:00.000Z', text: '崩溃：进入战斗黑屏',
  meta: { bugId: '1234567890000123456', shortId: '123456', status: 'new', priority: '紧急' } }
const FEISHU_MENTION: Trigger = { id: 'feishu:om_1', source: 'feishu', threads: [{ source: 'feishu', id: 'om_1' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, addressed: 'mention', at: '2026-11-04T08:00:00.000Z', text: '帮我看下这个回归', channel: { source: 'feishu', thread: 'om_1', address: { chatId: 'oc_team' } }, meta: {} }

describe('priority rules', () => {
  it('reads an explicit level from a person\'s words, and only an exact one as a short answer', () => {
    expect(priorityOfText('线上崩溃，P0')).toBe('P0')
    expect(priorityOfText('这个 p2 有空再看')).toBe('P2')
    expect(priorityOfText('不急，先排期')).toBe('P2')
    expect(priorityOfText('紧急')).toBe('P0')
    expect(priorityOfText('不紧急')).toBeUndefined()
    expect(priorityOfText('把这个页面按钮改一下')).toBeUndefined()
    expect(priorityAnswer('p1')).toBe('P1')
    expect(priorityAnswer('P3。')).toBe('P3')
    expect(priorityAnswer('紧急')).toBe('P0')
    expect(priorityAnswer('不急')).toBe('P2')
    expect(priorityAnswer('排期')).toBe('P2')
    expect(priorityAnswer('这个 p1 先做')).toBeUndefined()
    expect(priorityAnswer('1')).toBeUndefined()
  })
  it('gives a TAPD bug a question and P2 fallback, a person\'s mention P1, and an explicit word the person\'s own level', () => {
    expect(defaultPriority(TAPD_TRIGGER)).toEqual({ level: 'P2', source: 'default', note: 'automatic', ask: true })
    // A TAPD description is a report, not an instruction to the scheduler: a "P0" inside it never sets the level.
    expect(defaultPriority({ ...TAPD_TRIGGER, text: 'P0 紧急' })).toMatchObject({ ask: true, level: 'P2' })
    expect(defaultPriority(FEISHU_MENTION)).toEqual({ level: 'P1', source: 'default', note: 'human-mention' })
    expect(defaultPriority({ ...FEISHU_MENTION, text: '线上崩溃，P0' })).toEqual({ level: 'P0', source: 'human', note: 'explicit' })
    expect(defaultPriority({ ...FEISHU_MENTION, text: '不急，排期' })).toEqual({ level: 'P2', source: 'human', note: 'explicit' })
    expect(defaultPriority({ ...FEISHU_MENTION, human: false, addressed: undefined })).toEqual({ level: 'P2', source: 'default', note: 'automatic' })
  })
  it('never lets a system default set P0 or overwrite a person\'s level', () => {
    expect(systemPriority(undefined, { level: 'P0', source: 'default', note: 'automatic' }, '2026-11-04T09:00:00.000Z')).toBeUndefined()
    const human = { level: 'P0' as const, source: 'human' as const, at: '2026-11-04T08:10:00.000Z', by: 'ou_alice', via: 'feishu' as const }
    expect(systemPriority(human, { level: 'P2', source: 'default', note: 'ask-timeout' }, '2026-11-04T09:00:00.000Z')).toBeUndefined()
    expect(systemPriority({ level: 'P1', source: 'default', at: '2026-11-04T08:00:00.000Z', note: 'human-mention' },
      { level: 'P2', source: 'default', note: 'ask-timeout' }, '2026-11-04T09:00:00.000Z')).toEqual({ level: 'P2', source: 'default',
        at: '2026-11-04T09:00:00.000Z', note: 'ask-timeout' })
  })
  it('treats TAPD\'s own priority as a suggestion and a legacy ticket as mainline', () => {
    expect(tapdSuggestion({ meta: { priority: '紧急' } })).toBe('P1')
    expect(tapdSuggestion({ meta: { priority: '高' } })).toBe('P1')
    expect(tapdSuggestion({ meta: { priority: '中' } })).toBe('P2')
    expect(tapdSuggestion({ meta: { priority: '低' } })).toBe('P3')
    expect(tapdSuggestion({ meta: { priority: 'P0' } })).toBe('P1')
    expect(tapdSuggestion(undefined)).toBeUndefined()
    expect(ticketPriority({})).toBe('P1')
    expect(waitsForIdle('P2')).toBe(true)
    expect(waitsForIdle('P1')).toBe(false)
    expect(priorityAskDeadline('2026-11-04T08:00:00.000Z')).toBe('2026-11-04T08:30:00.000Z')
  })
})

describe('idle judgement', () => {
  const config = IDLE_DEFAULTS
  const at = (hour: number, minute = 0) => new Date(2026, 9, 4, hour, minute, 0)
  it('maps the configured windows, including the one that crosses midnight', () => {
    expect(windowAt(12 * 60, config.windows)?.level).toBe('L1')
    expect(windowAt(13 * 60 + 29, config.windows)?.level).toBe('L1')
    expect(windowAt(13 * 60 + 30, config.windows)).toBeUndefined()
    expect(windowAt(20 * 60, config.windows)?.level).toBe('L2')
    expect(windowAt(23 * 60, config.windows)?.level).toBe('L3')
    expect(windowAt(2 * 60, config.windows)?.level).toBe('L3')
    expect(windowAt(8 * 60, config.windows)).toBeUndefined()
  })
  it('requires a clear queue, capacity and the guard, then lets the window pick the depth', () => {
    const base = { now: at(20, 15), config, queuedMainline: false, capacitySince: at(20, 0).getTime(),
      lastHumanAt: at(19, 0).toISOString(), paused: false, openP0: false }
    expect(idleState(base)).toMatchObject({ level: 'L2', signals: { queue: true, capacity: true, window: true, human: true, guard: true } })
    expect(idleState({ ...base, queuedMainline: true })).toMatchObject({ signals: { queue: false } })
    expect(idleState({ ...base, queuedMainline: true }).level).toBeUndefined()
    expect(idleState({ ...base, capacitySince: at(20, 10).getTime() })).toMatchObject({ signals: { capacity: false } })
    expect(idleState({ ...base, capacitySince: at(20, 10).getTime() }).level).toBeUndefined()
    expect(idleState({ ...base, paused: true })).toMatchObject({ signals: { guard: false } })
    expect(idleState({ ...base, paused: true }).level).toBeUndefined()
    expect(idleState({ ...base, openP0: true })).toMatchObject({ signals: { guard: false } })
    expect(idleState({ ...base, openP0: true }).level).toBeUndefined()
    // The evening window with a person still talking falls back to the shallow level, which admits P2 only.
    expect(idleState({ ...base, lastHumanAt: at(20, 10).toISOString() })).toMatchObject({ level: 'L1' })
    // The night window ignores the person's quiet: they are meant to be asleep, and L3 runs with the guard clear.
    expect(idleState({ ...base, now: at(2, 0), capacitySince: at(1, 30).getTime(), lastHumanAt: at(1, 55).toISOString(), queuedMainline: false }))
      .toMatchObject({ level: 'L3' })
  })
  it('admits P2 at every depth and P3 only at L2/L3', () => {
    expect(idleAdmits('L1', 'P2')).toBe(true)
    expect(idleAdmits('L1', 'P3')).toBe(false)
    expect(idleAdmits('L2', 'P3')).toBe(true)
    expect(idleAdmits('L3', 'P3')).toBe(true)
    expect(idleAdmits(undefined, 'P2')).toBe(false)
    expect(idleAdmits(undefined, 'P1')).toBe(true)
    expect(dailyIdleRoom(5, config)).toBe(true)
    expect(dailyIdleRoom(6, config)).toBe(false)
    expect(localDay('2026-11-04T23:30:00.000Z')).toMatch(/^2026-11-0[45]$/)
  })
})

/** A ticket as the scheduler reads it; its assignment stage decides whether it counts as runnable. */
const ticketOf = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't-ticket', title: 'A ticket', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v1',
  basis: { via: 'listed' }, actor: { source: 'tapd', id: 'alice' }, scope: 'fix' }, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-11-04T08:00:00.000Z', updatedAt: '2026-11-04T08:00:00.000Z', origin: { triggerId: 'x', triggerIds: ['x'] },
  priority: { level: 'P2', source: 'default', at: '2026-11-04T08:00:00.000Z', note: 'automatic' }, idle: { enteredAt: '2026-11-04T08:00:00.000Z' },
  ...overrides } as unknown as Ticket)
const pending = (): Assignment[] => [{ id: 'a1', state: 'pending', createdAt: '2026-11-04T08:00:00.000Z' }]

/** The scheduler over a fake store: its open tickets, all tickets and recent triggers are what the test states. */
function scheduler(open: Ticket[] = [], options: { list?: Ticket[]; now?: () => Date; triggers?: { human: boolean; at: string }[];
  idle?: Record<string, unknown> } = {}) {
  const store = {
    tickets: { open: () => open, list: () => options.list ?? open },
    settings: () => SettingsSchema.parse({ executor: { idle: options.idle ?? {} } }),
    read: { recentTriggers: () => options.triggers ?? [] },
  } as unknown as Pick<Store, 'tickets' | 'settings' | 'read'>
  return new IdleScheduler({ store, now: options.now ?? (() => new Date(2026, 9, 4, 20, 15)) })
}
/** A scheduler with a movable clock, so a test can let a worker slot stay free for minutes. */
function clocked(open: Ticket[] = [], options: { list?: Ticket[]; triggers?: { human: boolean; at: string }[]; idle?: Record<string, unknown> } = {}) {
  const clock = { now: new Date(2026, 9, 4, 20, 0, 0) }
  return { gate: scheduler(open, { ...options, now: () => clock.now }), clock }
}

describe('idle scheduler', () => {
  const quiet = [{ human: true, at: new Date(2026, 9, 4, 19, 0).toISOString() }]
  it('holds P2 work until a slot stays free for the configured minutes, then admits it at the window\'s depth', () => {
    const { gate, clock } = clocked([], { triggers: quiet })
    gate.observe(0, 3)
    clock.now = new Date(2026, 9, 4, 20, 5, 0)
    expect(gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).toMatchObject({ admitted: false })
    clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).toMatchObject({ admitted: true, level: 'L2' })
  })
  it('holds P3 at the shallow level and admits it in the evening window', () => {
    const { gate, clock } = clocked([], { triggers: [{ human: true, at: new Date(2026, 9, 4, 11, 0).toISOString() }] })
    clock.now = new Date(2026, 9, 4, 12, 0, 0)
    gate.observe(0, 3)
    clock.now = new Date(2026, 9, 4, 12, 11, 0)
    expect(gate.admission(ticketOf({ priority: { level: 'P3', source: 'default', at: 'x', note: 'automatic' }, assignments: pending() }), { running: 0, max: 3 }))
      .toMatchObject({ admitted: false })
    const evening = clocked([], { triggers: quiet })
    evening.gate.observe(0, 3)
    evening.clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(evening.gate.admission(ticketOf({ priority: { level: 'P3', source: 'default', at: 'x', note: 'automatic' }, assignments: pending() }),
      { running: 0, max: 3 })).toMatchObject({ admitted: true, level: 'L2' })
  })
  it('never starts a TAPD ticket before its priority question is answered', () => {
    const { gate, clock } = clocked([], { triggers: quiet })
    gate.observe(0, 3)
    clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(gate.admission(ticketOf({ priorityAsk: { state: 'pending', at: 'x', deadline: '2026-11-04T08:30:00.000Z' }, assignments: pending() }),
      { running: 0, max: 3 })).toMatchObject({ admitted: false, reason: 'waiting for the priority answer' })
  })
  it('starts the ticket at once when a person\'s message waits for it, or when a person retried it', () => {
    const gate = scheduler([], { now: () => new Date(2026, 9, 4, 10, 0), triggers: [] })
    const waiting = ticketOf({ assignments: pending(), undelivered: ['i1'], inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'om_2', at: 'x', human: true }] })
    expect(gate.admission(waiting, { running: 0, max: 3 })).toMatchObject({ admitted: true })
    // A person's local check returned the work (its text input is theirs), and a retry they asked for, are both theirs.
    const rework = ticketOf({ assignments: pending(), undelivered: ['i2'], inputs: [{ id: 'i2', kind: 'text', text: 'retry it', at: 'x', person: true }] })
    expect(gate.admission(rework, { running: 0, max: 3 })).toMatchObject({ admitted: true })
    const retried = ticketOf({ assignments: [{ id: 'a0', state: 'ended', createdAt: 'x', endedReason: 'retried' }, ...pending()] })
    expect(gate.admission(retried, { running: 0, max: 3 })).toMatchObject({ admitted: true, reason: 'a person retried the ticket' })
  })
  it('holds everything while a P0 is open, one idle worker runs, or the day\'s budget is spent', () => {
    // A P0 with runnable work fails the queue signal; one waiting on a person is the guard's case, which blocks even then.
    const p0 = ticketOf({ id: 'p0', priority: { level: 'P0', source: 'human', at: 'x', by: 'ou_alice' }, assignments: pending() })
    const blocked = clocked([p0], { triggers: quiet })
    blocked.gate.observe(0, 3)
    blocked.clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(blocked.gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 }))
      .toMatchObject({ admitted: false, reason: 'a P0/P1 ticket still has runnable work' })
    const waitingP0 = ticketOf({ id: 'p0', priority: { level: 'P0', source: 'human', at: 'x', by: 'ou_alice' },
      assignments: [{ id: 'a', state: 'running', createdAt: 'x', report: { state: 'waiting', summary: 'looking', at: 'x' } }] })
    const guarded = clocked([waitingP0], { triggers: quiet })
    guarded.gate.observe(0, 3)
    guarded.clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(guarded.gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 }))
      .toMatchObject({ admitted: false, reason: 'an unresolved P0 ticket is open' })
    const running = ticketOf({ id: 'idle-1', idle: { enteredAt: 'x', launchedIn: 'L2', launchedAt: 'x' }, assignments: [{ id: 'a', state: 'running', createdAt: 'x' }] })
    const busy = clocked([running], { triggers: quiet })
    busy.gate.observe(0, 3)
    busy.clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(busy.gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).toMatchObject({ admitted: false })
    const today = new Date(2026, 9, 4, 9, 0).toISOString()
    const spent = Array.from({ length: 6 }, (_, index) => ticketOf({ id: `idle-${index}`, idle: { enteredAt: 'x', launchedIn: 'L2', launchedAt: today } }))
    const budget = clocked([], { triggers: quiet, list: spent })
    budget.gate.observe(0, 3)
    budget.clock.now = new Date(2026, 9, 4, 20, 11, 0)
    expect(budget.gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).toMatchObject({ admitted: false })
  })
  it('admits everything when the idle gate is switched off', () => {
    const gate = scheduler([], { now: () => new Date(2026, 9, 4, 10, 0), idle: { enabled: false } })
    expect(gate.admission(ticketOf({ assignments: pending() }), { running: 0, max: 3 })).toMatchObject({ admitted: true })
  })
})

/** A minimal engine over the in-memory repositories: every trigger is admitted, and the clock moves by `tick`. */
function engineHarness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const launches: [Ticket, Assignment][] = []
  const outbox: OutboundMessage[] = []
  let clock = Date.parse('2026-11-04T08:00:00.000Z')
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (): GateResult => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy,
    assessor: { request: candidate => { requests.push(candidate) }, release: () => {} },
    executor: { start: (ticket, assignment) => { launches.push([ticket, assignment]) }, deliver: () => {}, stop: () => {} },
    outbox: { send: message => { outbox.push(message) }, status: () => undefined, withdraw: () => {} },
    priorityAskMinutes: () => 30, now: () => new Date(clock).toISOString() })
  /** Accept a trigger, as the main Session would, and return the ticket it started. */
  const accept = (trigger: Trigger): Ticket => {
    engine.receive(trigger); engine.evaluateDue()
    const candidate = requests.at(-1)!
    const decision = engine.decide(trigger.id, { kind: 'accept', title: trigger.text, scope: 'fix the bug', reason: 'a person asked', evalId: candidate.evalId })
    return repo.tickets.get(decision.ticketId!)!
  }
  return { engine, repo, launches, outbox, accept, tick: (seconds: number) => { clock += seconds * 1000 } }
}

describe('priority in the engine', () => {
  it('starts a TAPD ticket with a pending question, P2 as the fallback and an idle entry', () => {
    const h = engineHarness()
    const ticket = h.accept(TAPD_TRIGGER)
    expect(ticket.priority).toMatchObject({ level: 'P2', source: 'default', note: 'automatic' })
    expect(ticket.priorityAsk).toMatchObject({ state: 'pending', deadline: '2026-11-04T08:30:00.000Z' })
    expect(ticket.idle).toEqual({ enteredAt: '2026-11-04T08:00:00.000Z' })
    expect(h.launches).toHaveLength(1)
  })
  it('applies the P2 default once the question expires, and only once', () => {
    const h = engineHarness()
    const ticket = h.accept(TAPD_TRIGGER)
    h.tick(31 * 60)
    h.engine.evaluateDue()
    const expired = h.repo.tickets.get(ticket.id)!
    expect(expired.priorityAsk).toMatchObject({ state: 'expired', settledAt: '2026-11-04T08:31:00.000Z' })
    expect(expired.priority).toMatchObject({ level: 'P2', source: 'default', note: 'ask-timeout' })
    h.tick(60)
    h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticket.id)!.priorityAsk?.state).toBe('expired')
  })
  it('records a person\'s level from a short reply, settles the question and consumes the message', () => {
    const h = engineHarness()
    const ticket = h.accept(TAPD_TRIGGER)
    const reply: Trigger = { id: 'feishu:om_2', source: 'feishu', threads: [{ source: 'tapd', id: 'bug-1' }], actor: { source: 'tapd', id: 'alice' },
      human: true, at: '2026-11-04T08:05:00.000Z', text: 'p1', channel: { source: 'feishu', thread: 'om_2', address: { chatId: 'oc_team' } }, meta: {} }
    h.engine.receive(reply)
    const answered = h.repo.tickets.get(ticket.id)!
    expect(answered.priority).toMatchObject({ level: 'P1', source: 'human', by: 'alice', via: 'feishu' })
    expect(answered.priorityAsk).toMatchObject({ state: 'answered', by: 'alice' })
    expect(answered.idle).toBeUndefined()
    expect(answered.inputs.some(input => input.kind === 'trigger' && input.triggerId === reply.id)).toBe(false)
    expect(h.repo.triggers.disposition(reply.id)?.acked).toEqual([ticket.id])
  })
  it('takes P0 only from a person, and a later default cannot downgrade it', () => {
    const h = engineHarness()
    const ticket = h.accept(TAPD_TRIGGER)
    h.engine.decidePriority(ticket.id, 'P0', 'alice', 'feishu')
    expect(h.repo.tickets.get(ticket.id)!.priority).toMatchObject({ level: 'P0', source: 'human' })
    h.tick(31 * 60)
    h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticket.id)!.priority).toMatchObject({ level: 'P0', source: 'human' })
  })
  it('records which idle depth let a P2 ticket start, and keeps a person\'s level out of the idle pool', () => {
    const h = engineHarness()
    const ticket = h.accept(TAPD_TRIGGER)
    h.engine.idleLaunch(ticket.id, 'L1')
    expect(h.repo.tickets.get(ticket.id)!.idle).toMatchObject({ launchedIn: 'L1', enteredAt: '2026-11-04T08:00:00.000Z' })
    h.engine.decidePriority(ticket.id, 'P2', 'alice', 'panel')
    expect(h.repo.tickets.get(ticket.id)!.idle).toMatchObject({ enteredAt: expect.any(String) })
    h.engine.decidePriority(ticket.id, 'P1', 'alice', 'panel')
    expect(h.repo.tickets.get(ticket.id)!.idle).toBeUndefined()
  })
})

describe('priority card', () => {
  it('offers the four levels, the deadline and the P2 default, and parses a click', () => {
    const message = priorityCard({ id: 'ticket-1', title: '崩溃：进入战斗黑屏' }, { deadline: '2026-11-04T08:30:00.000Z' },
      { shortId: '123456', status: 'new', tapdPriority: '紧急', suggestion: 'P1', reason: 'TAPD 自带优先级只作建议' })
    const buttons = (message.card as { body: { elements: { columns?: { elements: { behaviors?: { value: { priority?: string } }[] }[] }[] }[] } }).body.elements
      .flatMap(element => element.columns ?? []).flatMap(column => column.elements)
    expect(buttons.map(button => button.behaviors?.[0]?.value.priority)).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(message.text).toContain('默认 P2')
    expect(message.text).toContain('p0')
    expect(priorityValue(JSON.stringify({ priority: 'P2' }))).toEqual({ level: 'P2' })
    expect(priorityValue(JSON.stringify({ priority: 'P9' }))).toBeUndefined()
    expect(priorityValue('not json')).toBeUndefined()
    expect(priorityResolvedCard({ id: 'ticket-1', title: 'x' }, 'P1').text).toContain('P1')
  })
})

describe('the idle gate in the running host', () => {
  it('holds a P2 ticket whose priority question is pending instead of failing its launch', async () => {
    const at = new Date().toISOString()
    const ticketId = 't-seeded', assignmentId = 'a-seeded'
    const host = await startRuntime(store => {
      // The shared fixture turns the gate off for its other tests; this one puts it back on.
      const settings = store.settings()
      store.saveSettings({ ...settings, executor: { ...settings.executor, idle: { ...settings.executor.idle, enabled: true } } })
      store.triggers.save({ id: 'tapd:seed:1', source: 'tapd', threads: [{ source: 'tapd', id: 'seed' }], actor: { source: 'tapd', id: 'alice' },
        human: true, addressed: 'direct', at, text: 'seeded bug', meta: { bugId: 'seed', shortId: '1' } })
      store.tickets.save({ id: ticketId, title: 'Seeded TAPD bug', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v1',
        basis: { via: 'listed' }, actor: { source: 'tapd', id: 'alice' }, scope: 'seed' }, channels: [], assignments: [{ id: assignmentId, state: 'pending', createdAt: at }],
        inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: 'tapd:seed:1', triggerIds: ['tapd:seed:1'] },
        priority: { level: 'P2', source: 'default', at, note: 'automatic' },
        priorityAsk: { state: 'pending', at, deadline: new Date(Date.parse(at) + 3_600_000).toISOString() }, idle: { enteredAt: at } } as never)
    })
    try {
      await host.runtime.idle()
      await host.runtime.pump()
      await host.runtime.idle()
      const ticket = host.runtime.store.tickets.get(ticketId)!
      // The launch was held, not failed: the assignment still waits and its effect is still queued for a later attempt.
      expect(ticket.assignments.at(-1)?.state).toBe('pending')
      expect(ticket.assignments.at(-1)?.report).toBeUndefined()
      expect(ticket.idle?.launchedIn).toBeUndefined()
      expect(host.runtime.effects.pending('launch', assignmentId)).toBe(true)
      expect(host.runtime.idlePool.admission(ticket, { running: 0, max: 3 })).toMatchObject({ admitted: false, reason: 'waiting for the priority answer' })
      // A person's level releases it at once, since mainline work never waits for an idle window.
      host.runtime.engine.decidePriority(ticketId, 'P1', 'alice', 'panel')
      expect(host.runtime.idlePool.admission(host.runtime.store.tickets.get(ticketId)!, { running: 0, max: 3 })).toMatchObject({ admitted: true })
    } finally { await host.stop() }
  })
})
