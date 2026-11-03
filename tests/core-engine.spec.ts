import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, followupOwners, key, runningAssignment, ticketOutcome, ticketStage,
  waitsForPerson } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Outcome, Policy, Ticket, Trigger } from '../src/core/index.ts'

const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
interface Hooks {
  emit?: (event: { type: string; data: Record<string, unknown> }) => void
  prepareTicket?: EngineOptions['prepareTicket']
  reprepareTicket?: EngineOptions['reprepareTicket']
  pipelineFollowup?: EngineOptions['pipelineFollowup']
}
function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket, reprepareTicket, pipelineFollowup }: Hooks = {}) {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const withdrawn: string[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const deliveries = new Set<string>()
  /** Inputs the Executor handed to a running assignment, as [ticket id, input id]. */
  const delivered: [string, string][] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(ticket => { deliveries.add(ticket.id) }), stop: vi.fn(),
  }
  let version = 'v1', paused = false
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
    ...policyOverrides,
  }
  let clock = 0
  const scope: EngineOptions['scope'] = { scope: t => t.meta.blocked ? { listened: false, reason: 'chat not allowed' } : { listened: true, observed: false } }
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: id => { withdrawn.push(id) },
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued,
    ...emit ? { emit } : {}, ...prepareTicket ? { prepareTicket } : {}, ...reprepareTicket ? { reprepareTicket } : {},
    ...pipelineFollowup ? { pipelineFollowup } : {},
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() })
  /** Simulate the executor starting queued assignments (unless `launch` is false) and delivering pending ticket inputs. */
  function settle({ launch = true } = {}) {
    for (;;) {
      const next = launch ? launches.shift() : undefined
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) { delivered.push([ticketId, inputId]); engine.inputsDelivered(ticketId, assignment.id, [inputId]) }
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  /** Simulate the worker's Session taking the delivered Trigger Inputs it has not yet read into a step. */
  const read = (ticketId: string) => engine.inputsRead(ticketId, repo.tickets.get(ticketId)!.inputs.flatMap(input =>
    input.kind === 'trigger' && input.readAt === null ? [input.id] : []))
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return { repo, engine, outbox, withdrawn, requests, assessor, executor, delivered, settle, pump, read, decide,
    setVersion: (value: string) => { version = value }, setPaused: (value: boolean) => { paused = value }, tick: (seconds: number) => { clock += seconds } }
}
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1') {
  h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); h.pump()
  const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  h.settle()
  return decision
}

describe('intake', () => {
  it('stores a trigger once and records source filtering', () => {
    const h = harness()
    expect(h.engine.receive(trigger('1'))).toBe('stored')
    expect(h.engine.receive(trigger('1'))).toBe('duplicate')
    expect(h.engine.receive(trigger('2', { meta: { blocked: true } }))).toBe('filtered')
    expect(h.repo.triggers.disposition('2')?.filtered).toEqual({ code: 'chat not allowed' })
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['1'])
  })
  it('records correlation for a trigger on several threads and evaluates only on the primary one', () => {
    const h = harness()
    h.engine.receive(trigger('1', { threads: [{ source: 'gh', id: 'pr-7' }, { source: 'gh', id: 'run-9' }] }))
    expect(h.repo.threads.get('gh:pr-7')).toMatchObject({ pending: ['1'], correlated: ['gh:run-9'] })
    expect(h.repo.threads.get('gh:run-9')).toMatchObject({ pending: [], correlated: ['gh:pr-7'] })
  })
})
describe('eval', () => {
  it('ignores at the gate without an assessor when nothing is admissible', async () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false })); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore', triggerIds: ['1'] })])
    expect(h.repo.triggers.disposition('1')?.decisionId).toBeDefined()
  })
  it('releases the assessor\'s state for every eval that ends, decided or not', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    expect(h.assessor.release).toHaveBeenCalledExactlyOnceWith(h.requests[0]!.evalId)
  })
  it('serializes evals per thread and debounces triggers that arrive meanwhile', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.pump()
    expect(h.requests).toHaveLength(1)
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['2', '3'])
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    h.pump()
    expect(h.requests[1]!.triggers.map(t => t.id)).toEqual(['2', '3'])
    expect(h.requests[1]!.strength).toBe('explicit')
  })
  it('accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment', async () => {
    const h = harness()
    const decision = accepted(h)
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ title: 'Fix', mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: member, scope: 'small' }, channels: [trigger('1').channel],
      origin: { triggerId: '1', triggerIds: ['1'] } })
    expect(ticket).not.toHaveProperty('ended')
    expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
    expect(h.repo.threads.get('chat:t1')?.subscriptions).toEqual([ticket.id])
    expect(h.outbox).toEqual([{ id: key('ack', '1'), channel: trigger('1').channel, text: 'ok', kind: 'acknowledgement', ticketId: ticket.id }])
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('chat answers the person, keeps the thread and creates no ticket', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'chat', reply: '这个字段是缓存，刷新页面就对了。', reason: 'question' })
    expect(decision).toMatchObject({ kind: 'chat', reason: [{ code: 'said', values: { text: 'question' } }], triggerIds: ['1'] })
    expect(decision.ticketId).toBeUndefined()
    expect(decision.escalation).toBeUndefined()
    expect(h.repo.tickets.list()).toEqual([])
    // 回复走答复渠道，不带工单；线程不订阅任何工单，因此下一条消息照常进 Eval。
    expect(h.outbox).toEqual([{ id: key('reply', '1', '这个字段是缓存，刷新页面就对了。'), channel: trigger('1').channel,
      text: '这个字段是缓存，刷新页面就对了。', kind: 'reply' }])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [], subscriptions: [] })
    h.engine.receive(trigger('2')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2'])
  })
  it('ignore stays silent: no reply and no ticket', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    expect(decision).toMatchObject({ kind: 'ignore', reason: [{ code: 'said', values: { text: 'chatter' } }] })
    expect(h.outbox).toEqual([])
    expect(h.repo.tickets.list()).toEqual([])
  })
  it('a chat carrying an escalation replies and creates its ticket in the same decision', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const escalation = { title: '修复导出崩溃', scope: '导出时报错', category: 'bug' as const, reason: '对话里确认是缺陷' }
    const decision = h.decide(h.requests[0]!, { kind: 'chat', reply: '我先修这条报错', reason: 'asked', escalation })
    expect(decision).toMatchObject({ kind: 'chat', escalation })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ title: '修复导出崩溃', category: 'bug', mandate: { strength: 'explicit', scope: '导出时报错' },
      origin: { triggerId: '1', triggerIds: ['1'] } })
    expect(h.repo.threads.get('chat:t1')?.subscriptions).toEqual([ticket.id])
    // 只有这一条回复，没有额外的接单确认；工单照常开工。
    expect(h.outbox).toEqual([{ id: key('reply', '1', '我先修这条报错'), channel: trigger('1').channel, text: '我先修这条报错', kind: 'reply' }])
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('decides a replayed chat carrying an escalation once, replying once and leaving one ticket', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const escalation = { title: '修复导出崩溃', scope: '导出时报错', category: 'bug' as const, reason: '对话里确认是缺陷' }
    const first = h.decide(h.requests[0]!, { kind: 'chat', reply: '我看看', reason: 'asked', escalation })
    const again = h.engine.decide('1', { kind: 'chat', reply: '我看看', reason: 'asked', escalation })
    expect(again.id).toBe(first.id)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.outbox).toHaveLength(1)
  })
  it('refuses to decide an eval that a later eval replaced, and decides the later one', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const first = h.requests[0]!
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2'); h.pump()
    const second = h.requests[1]!
    expect(() => h.decide(first, { kind: 'ignore', reason: 'chatter' })).toThrow('has finished or a later eval replaced it')
    expect(h.decide(second, { kind: 'ignore', reason: 'chatter' })).toMatchObject({ kind: 'ignore', evalId: second.evalId })
  })
  it('records an accept with its ticket, subscriptions and acknowledgement together, or none of them', async () => {
    const h = harness({}, { prepareTicket: () => { throw new Error('No directory for the ticket') } })
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    expect(() => h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })).toThrow('No directory')
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ evaluating: { id: evalId }, subscriptions: [] })
    expect(h.outbox).toEqual([])
  })
  it('records unavailable when the policy version changed during assessment', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.setVersion('v2')
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' })
    expect(decision.kind).toBe('unavailable')
    expect(h.repo.tickets.list()).toEqual([])
  })
  it('starts every pending eval in one step, so a second pump starts none of them again', () => {
    const h = harness()
    for (const [id, thread] of [['1', 'A'], ['2', 'B']] as const) h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }))
    expect(h.engine.evaluateDue()).toBeUndefined()
    h.engine.evaluateDue()
    expect(h.requests.map(candidate => candidate.thread.key)).toEqual(['chat:A', 'chat:B'])
  })
  it('counts an Eval\'s deadline from its delivery, queues its Triggers again twice when it expires, then records it unavailable', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    // A candidate the assessor's Session has not taken does not expire.
    h.tick(600); h.pump()
    expect(h.engine.candidate('1')?.evalId).toBe(h.requests[0]!.evalId)
    const deliver = () => { h.engine.candidateDelivered(h.requests.at(-1)!.evalId) }
    deliver()
    h.tick(59); h.pump()
    expect(h.requests).toHaveLength(1)
    // Expired, it records nothing and queues the Trigger for a fresh Eval, twice.
    h.tick(2); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.assessor.release).toHaveBeenCalledWith(h.requests[0]!.evalId)
    expect(h.requests.map(item => item.triggers.map(each => each.id))).toEqual([['1'], ['1']])
    deliver(); h.tick(61); h.pump()
    expect(h.requests).toHaveLength(3)
    // The third expiry is recorded unavailable.
    deliver(); h.tick(61); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'timeout' }] })])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('subscription fan-out', () => {
  it('delivers a person\'s later message on a subscribed thread to the live ticket as context, and not to Eval', async () => {
    const h = harness()
    const decision = accepted(h)
    const requests = h.requests.length
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: '2' })])
    expect(ticket.undelivered).toEqual([])
    expect(h.delivered).toEqual([[ticket.id, ticket.inputs[0]!.id]])
    expect(h.repo.triggers.disposition('2')).toEqual({ fanout: [ticket.id], at: expect.any(String) })
    // No Eval, so no Decision and no timeout, and the Thread's queue stays free for a new request.
    expect([h.requests.length, h.repo.threads.get('chat:t1')!.pending, h.repo.decisions.byThread('chat:t1').length]).toEqual([requests, [],
      1])
    h.tick(600); h.engine.evaluateDue()
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(1)
    // A bot's message there still goes to Eval, which the gate does not admit.
    h.engine.receive(trigger('3', { human: false })); h.pump()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['3'] })
  })
  it('keeps inputs undelivered until an assignment is running, and asks to launch one whose launch failed again', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
    h.settle({ launch: false })
    h.engine.receive(trigger('2')); h.engine.evaluateDue(); h.settle({ launch: false })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.undelivered).toHaveLength(1)
    expect(h.executor.deliver).not.toHaveBeenCalled()
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id); h.settle()
    expect(h.delivered).toEqual([[ticket.id, ticket.undelivered[0]!]])
  })
  it('keeps the delivery facts a report declares on the ticket execution, and drops none it omits', () => {
    const h = harness()
    const decision = accepted(h)
    const id = decision.ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', lease: ['Source/A'] } })
    h.engine.report(id, { state: 'progress', summary: 'shelved',
      delivery: { changelist: 123456, review: 'review/9', verification: 'Compile Result: Succeeded; Automation 19/19 passed' } })
    expect(h.repo.tickets.get(id)!.execution).toMatchObject({ lease: ['Source/A'], changelist: 123456, review: 'review/9',
      verification: 'Compile Result: Succeeded; Automation 19/19 passed' })
    h.engine.report(id, { state: 'progress', summary: 'still working', delivery: { changelist: 123456 } })
    expect(h.repo.tickets.get(id)!.execution).toMatchObject({ changelist: 123456, review: 'review/9' })
  })
  it('confirms a delivered changelist once, refuses one with nothing delivered, and never submits', () => {
    const h = harness()
    const decision = accepted(h)
    const id = decision.ticketId!
    expect(() => h.engine.confirmTicket(id)).toThrow(/no delivered changelist/)
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 123456 } })
    expect(h.engine.confirmTicket(id).confirmed).toMatchObject({ at: expect.any(String) })
    expect(h.repo.tickets.get(id)!.confirmed).toBeDefined()
    expect(() => h.engine.confirmTicket(id)).toThrow(/already confirmed/)
    // Confirming records the person's decision only: the ticket's changelist is untouched, so submitting stays theirs.
    expect(h.repo.tickets.get(id)!.execution?.changelist).toBe(123456)
  })
  it('opens local verification only for delivered work, follows its pipeline from the delivery, and completes on the submit', () => {
    const analysis = harness()
    const answer = accepted(analysis)
    // Analysis work has nothing to run locally: a ready report still ends the ticket as before.
    analysis.engine.report(answer.ticketId!, { state: 'ready', summary: 'answered in the thread' })
    expect(analysis.repo.tickets.get(answer.ticketId!)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })

    const h = harness()
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '' } })
    h.engine.report(id, { state: 'ready', summary: 'shelved and reviewed',
      delivery: { changelist: 123456, review: 'review/9', verification: 'Compile Result: Succeeded; Automation 19/19 passed' } })
    const waiting = h.repo.tickets.get(id)!
    expect(waiting.ended).toBeUndefined()
    expect(waiting.verification).toEqual({ at: expect.any(String), state: 'pending' })
    // The host follows the pipeline from delivery on; no person and no follow-up Assignment start it.
    expect(waiting.pipeline).toMatchObject({ state: 'running' })
    expect(ticketStage(waiting)).toEqual({ stage: 'pipeline', action: 'running' })
    expect(waiting.assignments).toHaveLength(1)

    // Returning it starts a fresh Assignment whose first Input is the person's note; the delivery evidence stays.
    h.engine.reworkTicket(id, 'PIE 里 Q 技能仍然会卡住')
    const reworking = h.repo.tickets.get(id)!
    expect(reworking.verification).toMatchObject({ state: 'failed', by: 'person', note: 'PIE 里 Q 技能仍然会卡住' })
    expect(reworking.phase).toBe('implement')
    expect(reworking.assignments).toHaveLength(2)
    expect(reworking.assignments.at(-1)).toMatchObject({ state: 'pending' })
    const returnNote = reworking.inputs.at(-1)
    expect(returnNote?.kind === 'text' && returnNote.text).toContain('PIE 里 Q 技能仍然会卡住')
    expect(h.executor.start).toHaveBeenCalledTimes(2)

    // The worker delivers again: the gate reopens and the pipeline observation restarts for the new content. Passing the
    // local check is recorded without ending the ticket and without another Assignment; only the submit ends it.
    h.engine.report(id, { state: 'ready', summary: 'fixed', delivery: { changelist: 123456 } })
    expect(h.repo.tickets.get(id)!.verification?.state).toBe('pending')
    const passed = h.engine.verifyTicket(id)
    expect(passed.ended).toBeUndefined()
    expect(passed.verification).toMatchObject({ state: 'passed', by: 'person' })
    expect(passed.pipeline).toMatchObject({ state: 'running' })
    expect(passed.assignments).toHaveLength(2)
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    const merged = h.engine.recordPipeline(id, { state: 'merged', check: 'CL submitted; review merged' })
    expect(merged.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(merged.verification).toMatchObject({ state: 'passed', by: 'person' })
    expect(merged.execution?.changelist).toBe(123456)
    expect(merged.confirmed).toBeUndefined()
    expect(() => h.engine.verifyTicket(id)).toThrow(/already recorded local verification/)
    expect(() => h.engine.reworkTicket(id, 'again')).toThrow(/Ticket has ended/)
  })
  it('follows a pipeline automatically: a new failure wakes the worker, green asks once, and the submit completes it', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 123456, review: 'review/9' } })
    h.engine.report(id, { state: 'ready', summary: 'delivered', delivery: { changelist: 123456, review: 'review/9' } })
    h.settle()
    const before = h.outbox.length

    h.engine.observePipeline(id, { kind: 'failure', signature: '12:fail', check: 'Swarm 检查失败：ClientBuild',
      detail: 'Swarm review review/9 的当前版本检查失败。\n失败项：\n- ClientBuild：https://ci/1' })
    const failed = h.repo.tickets.get(id)!
    expect(failed.pipeline).toMatchObject({ state: 'running', fixes: 1, observed: '12:fail' })
    expect(h.outbox.length).toBe(before)
    // The worker receives the failing check as a text Input, and the same signature is never handed over twice.
    const nudge = failed.inputs.at(-1)!
    expect(nudge.kind).toBe('text')
    expect(nudge.kind === 'text' ? nudge.text : '').toContain('ClientBuild')
    h.settle()
    expect(h.delivered.some(([, inputId]) => inputId === nudge.id)).toBe(true)
    h.engine.observePipeline(id, { kind: 'failure', signature: '12:fail', check: 'Swarm 检查失败：ClientBuild', detail: 'again' })
    expect(h.repo.tickets.get(id)!.inputs).toHaveLength(failed.inputs.length)
    expect(h.repo.tickets.get(id)!.pipeline?.fixes).toBe(1)

    // A green review waits for a person: blocked+manual, one message, no repeat on the next poll.
    h.engine.observePipeline(id, { kind: 'review', signature: '12:pass', check: 'Swarm 已通过，待人工审核', url: 'https://swarm/reviews/9' })
    const green = h.repo.tickets.get(id)!
    expect(green.pipeline).toMatchObject({ state: 'blocked', manual: true, check: 'Swarm 已通过，待人工审核' })
    expect(ticketStage(green)).toEqual({ stage: 'pipeline', action: 'blocked' })
    const asked = h.outbox.filter(message => message.text.includes('待人工审核'))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.text).toContain('[Swarm - 9](https://swarm/reviews/9)')
    h.engine.observePipeline(id, { kind: 'review', signature: '12:pass', check: 'Swarm 已通过，待人工审核', url: 'https://swarm/reviews/9' })
    expect(h.outbox.filter(message => message.text.includes('待人工审核'))).toHaveLength(1)
    // A local check recorded during the wait does not end the ticket and does not reopen the pipeline.
    h.engine.verifyTicket(id)
    expect(h.repo.tickets.get(id)!.pipeline).toMatchObject({ state: 'blocked', manual: true })
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()

    // Approval moves it to the submit pipeline; the submit ends the ticket as the pipeline's completion.
    h.engine.observePipeline(id, { kind: 'approved', signature: '12:approved', check: 'Swarm 已审核通过，等待提交' })
    expect(h.repo.tickets.get(id)!.pipeline).toMatchObject({ state: 'running' })
    expect(h.outbox.filter(message => message.text.includes('已审核通过')).length).toBe(1)
    const merged = h.engine.observePipeline(id, { kind: 'merged', check: 'CL 已提交入库' })
    expect(merged.ended).toMatchObject({ outcome: 'completed' })
    // The person's local evidence stays attributed to them; only an unverified change is credited to the pipeline.
    expect(merged.verification).toMatchObject({ state: 'passed', by: 'person' })
    expect(h.outbox.filter(message => message.text.includes('已提交入库'))).toHaveLength(0)
  })
  it('lets a worker ask for a rerun, and a still-failing result wakes it once more', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 123456, review: 'review/9' } })
    h.engine.report(id, { state: 'ready', summary: 'delivered', delivery: { changelist: 123456, review: 'review/9' } })
    h.engine.observePipeline(id, { kind: 'failure', signature: '12:fail', check: 'Swarm 检查失败：ClientBuild', detail: 'boom' })
    const rerun = h.engine.rerunPipeline(id)
    expect(rerun.pipeline).toMatchObject({ state: 'running', check: '已请求重跑检查，等待新结果', rerunAt: expect.any(String) })
    expect(rerun.pipeline?.observed).toBeUndefined()
    h.engine.observePipeline(id, { kind: 'failure', signature: '12:fail', check: 'Swarm 检查失败：ClientBuild', detail: 'still failing' })
    expect(h.repo.tickets.get(id)!.pipeline).toMatchObject({ fixes: 2, observed: '12:fail' })
    expect(h.repo.tickets.get(id)!.pipeline?.rerunAt).toBeUndefined()
    expect(h.repo.tickets.get(id)!.inputs.at(-1)?.kind).toBe('text')
    h.engine.observePipeline(id, { kind: 'merged', check: 'CL 已提交入库' })
    expect(() => h.engine.rerunPipeline(id)).toThrow(/Ticket has ended/)
  })
  it('credits the pipeline when it completes a change no person checked locally', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 123456 } })
    h.engine.report(id, { state: 'ready', summary: 'delivered', delivery: { changelist: 123456 } })
    const merged = h.engine.observePipeline(id, { kind: 'merged', check: 'CL 已提交入库' })
    expect(merged.ended).toMatchObject({ outcome: 'completed' })
    expect(merged.verification).toMatchObject({ state: 'passed', by: 'pipeline' })
  })
  it('lets an AI verdict that posts after a green review still wake the worker', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 123456, review: 'review/9' } })
    h.engine.report(id, { state: 'ready', summary: 'delivered', delivery: { changelist: 123456, review: 'review/9' } })
    h.engine.observePipeline(id, { kind: 'review', signature: '3:pass', check: 'Swarm 已通过，待人工审核' })
    expect(h.repo.tickets.get(id)!.pipeline).toMatchObject({ state: 'blocked', manual: true })
    const before = h.repo.tickets.get(id)!.inputs.length
    h.engine.observePipeline(id, { kind: 'failure', signature: '3:ai', check: 'AI 审核未通过', detail: '按 AI 建议修改' })
    const woken = h.repo.tickets.get(id)!
    expect(woken.pipeline).toMatchObject({ state: 'running', fixes: 1, observed: '3:ai' })
    expect(woken.inputs).toHaveLength(before + 1)
  })
  it('keeps a person\'s manual pipeline blocker until they resume it, and stops waking the worker', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 123456, review: 'review/9' } })
    h.engine.report(id, { state: 'ready', summary: 'delivered', delivery: { changelist: 123456, review: 'review/9' } })
    h.engine.observePipeline(id, { kind: 'blocked', signature: 'stuck', reason: '同一失败连跑两次仍不过；请在 Jenkins 重跑', check: '失败后没有新结果' })
    const blocked = h.repo.tickets.get(id)!
    expect(blocked.pipeline).toMatchObject({ state: 'blocked', manual: true, reason: expect.stringContaining('Jenkins') })
    expect(h.outbox.some(message => message.text.includes('需要人工：'))).toBe(true)
    const inputs = blocked.inputs.length
    h.engine.observePipeline(id, { kind: 'failure', signature: '13:fail', check: '又失败了', detail: 'detail' })
    expect(h.repo.tickets.get(id)!.pipeline).toMatchObject({ state: 'blocked', manual: true })
    expect(h.repo.tickets.get(id)!.inputs).toHaveLength(inputs)
    const spent = h.repo.tickets.get(id)!
    h.repo.tickets.save({ ...spent, pipeline: { ...spent.pipeline!, fixes: 2 } })
    const resumed = h.engine.resumePipeline(id)
    expect(resumed.pipeline).toMatchObject({ state: 'running' })
    expect(resumed.pipeline?.manual).toBeUndefined()
    // The person's decision grants a fresh set of automatic fix attempts.
    expect(resumed.pipeline?.fixes).toBeUndefined()
  })
  it('records a person\'s local verification on a completed ticket that ended before the gate existed', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.engine.stopTicket(id)
    expect(() => h.engine.verifyTicket(id)).toThrow(/no delivered work/)
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, ended: { at: '2026-10-01T00:00:00.000Z', by: 'executor', outcome: 'completed' },
      verification: undefined })
    const verified = h.engine.verifyTicket(id)
    expect(verified.verification).toMatchObject({ state: 'passed', by: 'person' })
    expect(verified.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })
  it('does not hand a bot\'s message to an ended ticket, and still assesses it', async () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('2', { human: false })); h.pump()
    // The Executor reads its threads again when it resumes, so bots and CI neither wake nor queue on an ended ticket.
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('resumes once however often it pumps, with the resume note ahead of the message, and drops what waited when the policy no longer holds the mandate', async () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    h.setVersion('v1')
    h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.ended).toBeDefined()
    h.engine.receive(trigger('3', { actor: guest })); h.pump(); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.inputs.filter(input => input.kind === 'resumed')).toHaveLength(1)
  })
  it('takes delivery reports only from the assignment that still runs the open ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.receive(trigger('2'))
    const input = key('input', ticketId, 'trigger', '2')
    h.engine.deliveryFailed(ticketId, assignment, 'Session busy')
    expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    h.engine.deliveryFailed(ticketId, 'another', 'other')
    h.engine.inputsDelivered(ticketId, 'another', [input])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [input], delivery: { error: 'Session busy' } })
    h.engine.inputsDelivered(ticketId, assignment, [input])
    expect(h.repo.tickets.get(ticketId)!.undelivered).toEqual([])
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    h.engine.receive(trigger('3')); h.engine.stopTicket(ticketId)
    h.engine.deliveryFailed(ticketId, assignment, 'late')
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
  it('unsubscribing a thread stops fan-out until a new decision subscribes it', async () => {
    const h = harness()
    const decision = accepted(h)
    expect(h.engine.unsubscribe('chat:t1')).toBe(true)
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([])
  })
  it('lets an Executor drop a thread attached to its ticket, keeping the thread\'s other tickets, but not its own threads', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = []
    const h = harness({}, { emit: event => events.push(event) })
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    // A follow-up of the second ticket goes to the first only once the second's worker hands it back.
    h.engine.handback(second, '3', 'It is about the first fix')
    h.engine.attach(first, '3')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second, first])
    h.engine.markUnrelated(first, 'chat:t2', 'about another fix')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second])
    expect(events.filter(event => event.type === 'thread.unsubscribed').map(event => event.data))
      .toEqual([{ threadKey: 'chat:t2', ticketId: first, by: 'executor', reason: 'about another fix' }])
    expect(() => h.engine.markUnrelated(first, 'chat:t2', 'again')).toThrow(new UserError('notFollowing'))
    expect(() => h.engine.markUnrelated(first, 'chat:t1', 'its own')).toThrow(new UserError('sourceThread'))
    h.engine.bindThread(first, { source: 'gh', id: 'pr-9' }, true)
    expect(() => h.engine.markUnrelated(first, 'gh:pr-9', 'its PR')).toThrow(new UserError('followedThread'))
  })
})
describe('resume and stop', () => {
  async function ended(h: ReturnType<typeof harness>, by: 'executor' | 'human') {
    const decision = accepted(h)
    if (by === 'executor') h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    else h.engine.stopTicket(decision.ticketId!)
    return decision.ticketId!
  }
  it('resumes an ended ticket on any person\'s message on its thread, under the same mandate and without a Decision', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    const decisions = h.repo.decisions.byThread('chat:t1').length
    // It resumes as the message arrives, before any Eval of it.
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    h.pump()
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.mandate.policyVersion).toBe('v1')
    expect(ticket.inputs.map(input => input.kind)).toEqual(['trigger', 'resumed'])
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    // The message still reaches Eval as a follow-up, but no reopen Decision is needed or possible.
    expect(h.repo.decisions.byThread('chat:t1').filter(decision => decision.kind !== 'ignore')).toHaveLength(decisions)
  })
  it('resumes an ended ticket an earlier version left with a person\'s message waiting, on the next pass', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const stored = h.repo.tickets.get(ticketId)!
    const input = { id: 'waiting', kind: 'trigger' as const, triggerId: '2', at: stored.updatedAt, human: true as const }
    h.repo.tickets.save({ ...stored, inputs: [...stored.inputs, input], undelivered: ['waiting'] })
    h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ kind: 'resumed' })]) })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
  })
  it('resumes an ended ticket at once when a person attaches a message to it', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const subject = h.engine.attach(ticketId, '2')
    expect(subject).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'pending' })] })
    expect(subject).not.toHaveProperty('ended')
  })
  it('keeps a ticket a person stopped ended: the stop withdrew its mandate', async () => {
    const h = harness()
    const ticketId = await ended(h, 'human')
    expect(h.executor.stop).toHaveBeenCalledOnce()
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('keeps a ticket ended when its mandate no longer passes the current policy', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.setVersion('revoked')
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
  })
  it('stops a live ticket only on an explicit instruction and ends it by the human', async () => {
    const h = harness()
    const decision = accepted(h)
    // Follow-ups that reached the ticket: the gate judges them when the main Session acts on one, a guest's as inferred.
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.engine.decide('2', { kind: 'stop', ticketId: decision.ticketId!, reason: 'x' })).toMatchObject({ kind: 'ignore',
      strength: 'inferred', reason: [{ code: 'stopNotExplicit' }] })
    h.engine.receive(trigger('3')); h.pump()
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'human said stop' }).kind).toBe('stop')
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.stop).toHaveBeenCalledOnce()
  })
})
describe('a merged pipeline after a resume', () => {
  /** A ticket whose delivered work passed the local check and whose pipeline a person then marked merged. */
  function merged(h: ReturnType<typeof harness>) {
    const id = accepted(h).ticketId!
    h.repo.tickets.save({ ...h.repo.tickets.get(id)!, execution: { name: 'w', directory: '/w', assignment: '' } })
    h.engine.report(id, { state: 'ready', summary: 'shelved', delivery: { changelist: 123456, review: 'https://review.test/9' } })
    h.engine.verifyTicket(id)
    return h.engine.recordPipeline(id, { state: 'merged', url: 'https://review.test/9' })
  }
  it('is history once a person\'s message resumes the ticket, not pipeline work again', () => {
    const h = harness()
    const ended = merged(h)
    expect(ended.ended).toMatchObject({ outcome: 'completed', reason: '流水线已入库' })
    h.engine.receive(trigger('2', { actor: guest }))
    const resumed = h.repo.tickets.get(ended.id)!
    expect(resumed).not.toHaveProperty('ended')
    expect(resumed.pipeline).toMatchObject({ state: 'merged' })
    // The round queues its new Assignment: pipeline/running is not what the stage reports any more.
    expect(ticketStage(resumed)).toEqual({ stage: 'working', action: 'queued' })
  })
  it('ends the resumed round on a report that delivers nothing new, and reopens the local check for new work', () => {
    const h = harness()
    const id = merged(h).id
    h.engine.receive(trigger('2', { actor: guest }))
    h.engine.report(id, { state: 'ready', summary: 'answered the question' })
    const answered = h.repo.tickets.get(id)!
    expect(answered.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(answered.verification).toMatchObject({ state: 'passed' })
    expect(answered.pipeline).toMatchObject({ state: 'merged' })

    // A later round that delivers new work reopens the local check and starts following the new change's pipeline.
    h.engine.receive(trigger('3', { actor: guest }))
    h.engine.report(id, { state: 'ready', summary: 'fixed more', delivery: { changelist: 654321 } })
    const redelivered = h.repo.tickets.get(id)!
    expect(redelivered).not.toHaveProperty('ended')
    expect(redelivered.pipeline).toMatchObject({ state: 'running' })
    expect(redelivered.verification).toMatchObject({ state: 'pending' })
    expect(ticketStage(redelivered)).toEqual({ stage: 'pipeline', action: 'running' })
  })
})
describe('follow-ups', () => {
  it('takes a follow-up an older version queued out of the queue without a Decision, and keeps one sent to Eval again', () => {
    const h = harness()
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.receive(trigger('3', { actor: guest }))
    // As an older version left them: both queued for Eval; a person sent the second there again.
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, pending: ['2', '3'] })
    h.engine.reevaluate('3'); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.decisions.byThread('chat:t1').flatMap(decision => decision.triggerIds)).toEqual(['1'])
  })
  it('decides a follow-up in a gate-only Eval beside the Eval its Thread has in progress, which goes on', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const evaluating = h.repo.threads.get('chat:t1')!.evaluating!
    h.engine.receive(trigger('3'))
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'stop it' })).toMatchObject({ kind: 'stop',
      triggerIds: ['3'] })
    expect(h.repo.threads.get('chat:t1')!.evaluating).toEqual(evaluating)
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })).toMatchObject({ kind: 'ignore', triggerIds: ['2'] })
  })
  it('leaves the Thread free for a later request that reaches no ticket', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    h.engine.stopTicket(decision.ticketId!, 'not needed')
    // The follow-up held no Eval while the ticket decided it, so the next request is assessed at once rather than after a
    // timeout, together with the follow-up, which the stop let go of before its worker took it up.
    h.engine.receive(trigger('3')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
})
describe('hand-back', () => {
  it('queues a message that reached a ticket for a fresh Eval with the gate\'s strength, once per ticket, and keeps the subscription',
    () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.engine.handback(ticketId, '2', 'A new request')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'explicit', triggers: [{ id: '2' }] })
    expect(h.repo.triggers.disposition('2')!.handbacks).toEqual([{ ticketId, reason: 'A new request', at: expect.any(String) }])
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })
    expect(() => h.engine.handback(ticketId, '2', 'Again')).toThrow(new UserError('handedBack'))
    expect(h.engine.handback(ticketId, '3', 'A guest asks for more')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred', triggers: [{ id: '3' }] })
    expect(h.repo.threads.get('chat:t1')!.subscriptions).toContain(ticketId)
    // Only a message that reached the ticket can go back.
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.handback(ticketId, '4', 'Not mine')).toThrow(new UserError('notReached'))
  })
  it('queues again no message the ticket did not decide: one a person sent to Eval, a bot\'s, or one on a Thread followed for context',
    () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.receive(trigger('2')); h.engine.reevaluate('2')
    h.engine.receive(trigger('3', { human: false })); h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] })); h.pump()
    for (const candidate of h.requests.slice(-2)) h.decide(candidate, { kind: 'ignore', reason: 'chat' })
    // Each went to Eval without the ticket, and its Decision stands.
    for (const id of ['2', '3', '4']) expect(h.engine.handback(ticketId, id, 'Not this ticket')).toBe(false)
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.threads.get('chat:issue')!.pending]).toEqual([[], []])
    // The hand-back is recorded all the same, so the main Session does not attach the message back.
    expect(h.repo.triggers.disposition('4')!.handbacks).toEqual([{ ticketId, reason: 'Not this ticket', at: expect.any(String) }])
    expect(() => h.engine.attach(ticketId, '4')).toThrow(new UserError('handedBackHere'))
  })
  it('leaves a message the main Session attached to a ticket to its worker, whose hand-back sends it to Eval', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    // Routed to the ticket, it is not new work as well.
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Y', scope: 'small', reason: 'requested' }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.handback(ticketId, '2', 'Asks for another change')).toBe(true)
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
})
describe('context threads and notes', () => {
  it('fans a Thread followed for context out to the live ticket, resumes no ended ticket from it, unless it was attached', async () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(true)
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(false)
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)!.inputs.map(input => input.kind === 'trigger' && input.triggerId)).toEqual(['2'])
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // Attached by the main Session, the Thread is the ticket's own, and a person's later message there resumes it.
    h.engine.attach(ticketId, '3'); h.settle()
    expect(h.repo.threads.get('chat:issue')).toMatchObject({ context: [] })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('counts a message on a Thread a ticket follows only for context as none of its follow-ups, and lifts no block with it', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [owner, follower], context: [follower] })
    expect(h.repo.tickets.get(follower)!.inputs.at(-1)).toMatchObject({ triggerId: '3', context: true })
    // On the follower's own Thread no longer: a message reaching only it goes to Eval, with the guest's that the stopped owner
    // let go of.
    h.engine.stopTicket(owner, 'done')
    h.engine.report(follower, { state: 'blocked', summary: 'needs a decision' })
    h.engine.receive(trigger('4')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3', '4'])
    expect(waitsForPerson(h.repo.tickets.get(follower)!)).toBe(true)
  })
  it('sends a message to Eval when the ticket it reached cannot resume and only a ticket following its Thread for context is left', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.report(owner, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('3')); h.setVersion('v1'); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [follower], context: [follower] })
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
  })
  it('gives an open ticket\'s worker a note as an Input of its own, held like automatic Input, and refuses one for an ended ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.note(ticketId, 'The other ticket renamed the API').inputs.at(-1)).toMatchObject({ kind: 'note',
      text: 'The other ticket renamed the API' })
    // A worker that reported blocked waits for a person: a note does not wake it.
    h.settle()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    const note = h.engine.note(ticketId, 'Ticket B changed the schema').inputs.at(-1)!
    h.settle()
    expect(h.delivered.map(([, id]) => id)).not.toContain(note.id)
    expect(h.repo.tickets.get(ticketId)!.inputs).toContainEqual(note)
    h.engine.stopTicket(ticketId, 'done')
    expect(() => h.engine.note(ticketId, 'Too late')).toThrow(new UserError('ticketEnded'))
  })
})
describe('follow-up owners', () => {
  const accept = { kind: 'accept' as const, title: 'Y', scope: 'small', reason: 'requested' }
  const decides = (...tickets: string[]) => new UserError('workerDecides', { tickets: tickets.join(', ') })
  it('lets the main Session take a follow-up as new work once it stopped the ticket on it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // "Stop this, and do Y instead": the stop ends the ticket that decided the message, so the request is the main Session's.
    h.engine.receive(trigger('2')); h.settle()
    expect(() => h.engine.decide('2', accept)).toThrow(decides(ticketId))
    expect(h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' }).kind).toBe('stop')
    // At the same moment, the accept is a Decision of its own beside the stop's.
    expect(h.engine.decide('2', accept)).toMatchObject({ kind: 'accept', triggerIds: ['2'] })
    expect(h.repo.decisions.byThread('chat:t1').filter(item => item.triggerIds.includes('2')).map(item => item.kind)).toEqual(['stop',
      'accept'])
  })
  it('sends a follow-up its worker never received to Eval when the ticket ends, by a report or a stop', () => {
    for (const end of ['report', 'stop'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2'))
      expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
      if (end === 'report') h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      else h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
      h.pump()
      expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2'])
    }
  })
  it('sends a follow-up its worker got since its last report to Eval when the ticket ends, unless it acknowledged it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    // The worker acknowledges one of two messages, and its final report was on its way before it took up the other.
    h.tick(1); h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
    // The ticket no longer counts as having reached it, so its candidate names no ticket that gave no reason.
    expect([h.repo.triggers.disposition('2')!.fanout, h.repo.triggers.disposition('3')!.fanout]).toEqual([[ticketId], []])
  })
  it('keeps a ticket open after its pull request merged while its worker is on a person\'s message it took up after its last report',
    () => {
    for (const taken of [true, false]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
      h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
      // A person asks for one more change, which the worker takes up or has not yet, and the pull request merges meanwhile.
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      if (taken) h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
      h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
      // One it has not taken up leaves the merge to end the ticket, and goes to Eval.
      expect([h.repo.tickets.get(ticketId)!.ended?.outcome, h.repo.threads.get('chat:t1')!.pending]).toEqual(taken ? [undefined, []]
        : ['merged', ['2']])
      // The worker's ready report ends it as the pull request did.
      if (taken) h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
      expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    }
  })
  it('gives a follow-up its ended ticket let go to that ticket again when the main Session attaches it there', () => {
    for (const resumed of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      // The ticket ends before its worker took up a person's message, which goes to Eval; a later message may resume it.
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (resumed) { h.tick(1); h.engine.receive(trigger('3')) }
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      // Its worker gets the message again, and an ended ticket resumes for it.
      const copies = h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')
      expect(h.delivered).toContainEqual([ticketId, copies[1]?.id])
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(trigger('2'), h.repo)).toEqual([ticketId])
    }
  })
  it('wakes an ended ticket for a message attached to it that its worker read only for context or before its last report', () => {
    for (const read of ['context', 'report'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      if (read === 'context') h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
      h.tick(1); h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: read === 'context' ? 'issue' : 't1' }] })); h.settle()
      // The worker reports after reading it and drops the ticket; a person sends a follow-up it had to Eval from the panel.
      h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'read it' })
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (read === 'report') h.engine.reevaluate('2')
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(h.repo.triggers.get('2')!, h.repo)).toEqual([ticketId])
    }
  })
  it('counts a question the final report answers as taken up, so it does not come back as a candidate beside its answer', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'It reads the config.', answers: '2' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [ticketId], acked: [ticketId] })
  })
  it('sends to Eval a message attached after its Eval was unavailable, once its ticket ends without taking it up', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
  it('counts an acknowledgement an earlier version queued without recording it on the message as taking the message up', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.outbox.push({ id: key('ack', '2'), channel: trigger('2').channel!, text: 'On it', kind: 'acknowledgement', ticketId })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.triggers.disposition('2')!.fanout]).toEqual([[], [ticketId]])
  })
  it('counts a message that resumed a ticket as taken up by the report that ends it again, unlike one that came later', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    // A person's thanks resumes the ticket, and its worker takes it into a step first, a moment after its Assignment started,
    // as the Executor delivers it; a request comes while it reports that nothing is left.
    h.tick(1); h.engine.receive(trigger('2'))
    h.tick(1); h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id)
    h.tick(1); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('sends a follow-up its ticket let go to Eval after a stop on it was refused, but not the one a stop ended it on', () => {
    // A guest's stop is refused, and the worker drops the ticket; a member's stop ends it, and the main Session, which stopped
    // it, decides the rest of the message itself.
    for (const actor of [guest, member]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2', { actor }))
      h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' })
      if (actor === guest) h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(actor === guest ? ['2'] : [])
    }
  })
  it('sends the message a stop ended a ticket on to Eval once another ticket it reached ends without taking it up', () => {
    const h = harness()
    const stopped = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(other, { source: 'chat', id: 't1' }, false)
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.decide('2', { kind: 'stop', ticketId: stopped, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    h.engine.report(other, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('hands the follow-ups on a thread a worker found unrelated back to Eval, with its reason', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    h.engine.receive(trigger('3', elsewhere)); h.settle()
    expect(() => h.engine.decide('3', accept)).toThrow(decides(ticketId))
    // The worker finds the attached thread is not its ticket's, and answers nothing there: the message the main Session
    // attached goes back with the later one, and each candidate says why.
    h.engine.markUnrelated(ticketId, 'chat:x', 'about something else')
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2', '3'])
    expect(h.repo.triggers.disposition('3')!.handbacks).toEqual([{ ticketId, reason: 'about something else', at: expect.any(String) }])
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
  it('keeps a follow-up two tickets reached with the one that did not hand it back, and queues it once neither decides it', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.handback(first, '2', 'another change'); h.pump()
    const second = h.decide(h.requests.at(-1)!, accept).ticketId!
    h.settle()
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    expect(h.repo.triggers.disposition('3')!.fanout).toEqual([first, second])
    expect(h.engine.handback(first, '3', 'for the other ticket')).toBe(false)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    // The main Session may neither take nor dismiss it while the second ticket's worker decides it.
    expect(() => h.engine.decide('3', accept)).toThrow(decides(second))
    expect(() => h.engine.decide('3', { kind: 'ignore', reason: 'chat' })).toThrow(decides(second))
    expect(h.engine.handback(second, '3', 'neither ticket')).toBe(true)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('lets an Eval an earlier version started on a follow-up decide it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.settle()
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'e-legacy', threadKey: 'chat:t1', triggerIds: ['2'], strength: 'explicit',
      actor: member, basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '2026-09-23T00:00:00Z', deadline: '2026-09-24T00:00:00Z' } })
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: 'e-legacy' })).toMatchObject({ kind: 'ignore',
      triggerIds: ['2'] })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('interrupted assignments', () => {
  it('starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it', () => {
    const h = harness()
    const interrupted = accepted(h).ticketId!
    const first = h.repo.tickets.get(interrupted)!.assignments[0]!
    const waiting = accepted(h, '2', 't2').ticketId!
    h.engine.report(waiting, { state: 'waiting', summary: 'done for now' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    vi.mocked(h.executor.start).mockClear(); vi.mocked(h.executor.deliver).mockClear()
    // The Executor reports each Assignment that was running; a fact about one that no longer runs is dropped.
    for (const id of [interrupted, waiting]) h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id)
    h.engine.assignmentInterrupted(interrupted, first.id)
    const ticket = h.repo.tickets.get(interrupted)!
    expect(ticket.assignments).toEqual([expect.objectContaining({ id: first.id, state: 'ended', endedReason: 'hostRestarted' }),
      expect.objectContaining({ state: 'pending' })])
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('The host restarted') })])
    expect(ticket.undelivered).toEqual([ticket.inputs[0]!.id])
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: interrupted }), ticket.assignments[1])
    // A worker that waits keeps its Session and gets what waits for it.
    expect(h.repo.tickets.get(waiting)!.assignments).toHaveLength(1)
    expect(h.executor.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: waiting }), expect.objectContaining({ state: 'running' }))
  })
  it('reminds a restarted worker what its ticket already reported', () => {
    const h = harness()
    const id = accepted(h).ticketId!
    h.engine.report(id, { state: 'progress', summary: 'the first half is in place' })
    const running = runningAssignment(h.repo.tickets.get(id)!)!
    h.engine.assignmentInterrupted(id, running.id)
    const note = h.repo.tickets.get(id)!.inputs.at(-1)!
    if (note.kind !== 'text') throw new Error('expected a text recovery note')
    expect(note.text).toContain('The host restarted')
    expect(note.text).toContain('Its last report was "progress": the first half is in place')
  })
  it('starts again a worker that reported but then got a person\'s message, which it was working on', () => {
    const h = harness()
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.report(other, { state: 'waiting', summary: 'done for now' })
    h.tick(1); h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] })); h.settle()
    const running = runningAssignment(h.repo.tickets.get(other)!)!
    expect(running.deliveredAt! > running.report!.at).toBe(true)
    h.engine.assignmentInterrupted(other, running.id)
    expect(h.repo.tickets.get(other)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  })
})
describe('pause', () => {
  it('lets no Eval expire while processing is paused, and moves its deadline on by the pause\'s length', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.candidateDelivered(h.requests[0]!.evalId)
    const deadline = Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)
    h.tick(30); h.setPaused(true); h.pump()
    // Paused past the deadline, the Eval waits.
    h.tick(300); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    h.setPaused(false); h.pump()
    expect(Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)).toBe(deadline + 300_000)
    h.tick(29); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    // Expired, it queues the Trigger again for a fresh Eval.
    h.tick(1); h.pump()
    expect(h.engine.candidate('1')?.evalId).not.toBe(h.requests[0]!.evalId)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('policy change', () => {
  it('tells only the live tickets a change bears on how it does, and restarts in-flight evals under the new version', async () => {
    const h = harness()
    const decision = accepted(h)
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const effect = { rules: [{ id: 'copy', name: 'Copy', change: 'changed' as const, instruction: 'Fix typos only.' }] }
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2', new Map([[decision.ticketId!, effect]]))
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed', from: 'v1', to: 'v2', effect })])
    expect(h.repo.tickets.get(other)!.inputs.filter(input => input.kind === 'policy-changed')).toEqual([])
    expect(h.repo.decisions.byThread('chat:t2')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })])
    expect(h.repo.threads.get('chat:t2')?.pending).toEqual(['2'])
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '2' })] })
    const told = h.repo.tickets.get(decision.ticketId!)!.inputs.find(input => input.kind === 'policy-changed')!
    expect(h.delivered).toEqual([[decision.ticketId, told.id]])
  })
  it('does not start evals while paused', async () => {
    const h = harness({ paused: true })
    h.engine.receive(trigger('1')); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
  })
})

describe('worker reports', () => {
  it('asks, keeps, replaces and clears the question for a person, and says which question a report replaced', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: 'Which color?', askedBy: '1' })
    expect(asked.attention).toMatchObject({ question: 'Which color?', triggerId: '1' })
    expect(h.engine.report(ticketId, { state: 'blocked', summary: 'still waiting' }).attention).toEqual(asked.attention)
    expect(h.withdrawn).toEqual([])
    const replaced = h.engine.report(ticketId, { state: 'progress', summary: 'other question', question: 'Which size?' })
    expect(replaced.attention).toMatchObject({ question: 'Which size?' })
    expect(replaced.attention).not.toHaveProperty('triggerId')
    // The replaced question is withdrawn from the outbox if its message has not gone out yet.
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id)])
    const cleared = h.engine.report(ticketId, { state: 'progress', summary: 'answered', question: null })
    expect(cleared).not.toHaveProperty('attention')
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id), key('attention-reply', replaced.attention!.id)])
  })
  it('offers the worker\'s choices on the question and turns a click into the person\'s answer', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: '先上 A 还是先上 B？',
      options: ['先上 A', '先上 B'], askedBy: '1' })
    expect(asked.attention).toMatchObject({ question: '先上 A 还是先上 B？', options: ['先上 A', '先上 B'] })
    // The main Session raises the question with its own attention reply; the ticket's choices travel with it to the channel.
    expect(h.engine.reply({ purpose: 'attention', ticketId, question: '先上 A 还是先上 B？', text: '先上 A 还是先上 B？' }).status).toBe('pending')
    expect(h.outbox.at(-1)).toMatchObject({ kind: 'reply', ticketId,
      attention: { ticketId, attentionId: asked.attention!.id, options: ['先上 A', '先上 B'] } })
    expect(() => h.engine.answerAttention(ticketId, asked.attention!.id, '先上 C'))
      .toThrowError(expect.objectContaining({ code: 'notAttentionOption' }))
    const answered = h.engine.answerAttention(ticketId, asked.attention!.id, '先上 A')
    expect(answered.attention).toBeUndefined()
    expect(answered.inputs.at(-1)).toMatchObject({ kind: 'text', text: '人对「先上 A 还是先上 B？」选了：先上 A' })
    expect(answered.undelivered).toContain(answered.inputs.at(-1)!.id)
    expect(() => h.engine.answerAttention(ticketId, asked.attention!.id, '先上 A'))
      .toThrowError(expect.objectContaining({ code: 'notAttention' }))
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x', options: ['先上 A', '先上 B'] }))
      .toThrowError(expect.objectContaining({ code: 'optionsWithoutQuestion' }))
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x', question: 'Q?', options: ['one'] }))
      .toThrowError(expect.objectContaining({ code: 'attentionOptions' }))
    // The answer is a person's message, so it is delivered rather than held as an automated note.
    h.settle()
    expect(h.delivered.map(([, id]) => id)).toContain(answered.inputs.at(-1)!.id)
  })
  it('puts the worker\'s context sections on the question card and refuses them without a question', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x', question: '这个取舍能不能定？',
      sections: [{ label: '', text: 'x' }] })).toThrowError(expect.objectContaining({ code: 'attentionSections' }))
    const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: '这个取舍能不能定？',
      options: ['能定', '再改改'], sections: [{ label: '现状', text: '两个方案都能过测试' }] })
    expect(asked.attention).toMatchObject({ question: '这个取舍能不能定？', sections: [{ label: '现状', text: '两个方案都能过测试' }] })
    h.engine.reply({ purpose: 'attention', ticketId, question: '这个取舍能不能定？', text: '这个取舍能不能定？' })
    expect(h.outbox.at(-1)).toMatchObject({ attention: { sections: [{ label: '现状', text: '两个方案都能过测试' }] } })
  })
  it('ends the ticket on a final report: dropped drops it, ready completes it unless it follows a Source\'s Thread that is open', () => {
    const outcome = (state: 'ready' | 'dropped' | 'failed', follows: boolean, closed = false) => {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Merge it?' })
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
      // Work resumed after both closed ends with its ready report, using the latest close outcome.
      if (closed) {
        h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'closed', '2026-09-22T00:00:00Z')
        h.engine.threadClosed({ source: 'gh', id: 'pr-10' }, 'merged', '2026-09-22T00:00:01Z')
      }
      h.engine.report(ticketId, { state, summary: 'done' })
      return h.repo.tickets.get(ticketId)!
    }
    expect(outcome('dropped', true)).toMatchObject({ ended: { by: 'executor', outcome: 'dropped' } })
    expect(outcome('dropped', true).ended).not.toHaveProperty('reason')
    expect(outcome('ready', false)).toMatchObject({ ended: { outcome: 'completed' } })
    expect(outcome('ready', false)).not.toHaveProperty('attention')
    expect(outcome('ready', true)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }, { thread: 'gh:pr-10', own: true }],
      assignments: [expect.objectContaining({ report: expect.objectContaining({ state: 'ready' }) })] })
    expect(outcome('ready', true)).not.toHaveProperty('ended')
    expect(outcome('ready', true)).not.toHaveProperty('attention')
    expect(outcome('ready', true, true)).toMatchObject({ ended: { outcome: 'merged' } })
    expect(outcome('failed', false)).toMatchObject({ attention: { question: 'Merge it?' } })
    expect(outcome('failed', false)).not.toHaveProperty('ended')
  })
  it('waits a change delivered as the Ticket\'s own pull request at the pipeline gate until the person merges it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR #9 已提交，等你审批合入' })
    // The delivered pull request, not a person's review of the work, is what remains.
    const waiting = h.repo.tickets.get(ticketId)!
    expect(waiting.ended).toBeUndefined()
    expect(ticketStage(waiting)).toEqual({ stage: 'pipeline', action: 'blocked' })
    // Approving and merging it there completes the Ticket, as the pull request's outcome says.
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // A pull request the Ticket only follows, such as the one it started from, still leaves a person's review of the work.
    const other = harness()
    const second = accepted(other).ticketId!
    other.engine.bindThread(second, { source: 'gh', id: 'pr-11' }, false)
    other.engine.report(second, { state: 'ready', summary: 'answered in the thread' })
    expect(ticketStage(other.repo.tickets.get(second)!)).toEqual({ stage: 'person', action: 'review' })
  })
  it('refuses a question with a result or an answer, and questions or answers that name no person\'s message of the ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { human: false, threads: [{ source: 'chat', id: 't1' }] }))
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const report = (extra: object) => () => h.engine.report(ticketId, { state: 'progress', summary: 'x', ...extra })
    expect(report({ state: 'ready', question: 'Q?' })).toThrow(new UserError('questionWithResult'))
    expect(report({ question: 'Q?', answers: '1' })).toThrow(new UserError('questionWithResult'))
    expect(report({ askedBy: '1' })).toThrow(new UserError('askerWithoutQuestion'))
    expect(report({ question: 'Q?', askedBy: '2' })).toThrow(new UserError('notAsker'))
    expect(report({ answers: '4' })).toThrow(new UserError('notAnswerable'))
    expect(report({ answers: '1' })()).toMatchObject({ answers: ['1'] })
  })
  it('refuses a report on an ended ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x' })).toThrow(new UserError('ticketEnded'))
  })
})
describe('outcomes', () => {
  it('records how a ticket ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId, 'Human asked to stop')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'Human asked to stop' })
    expect(ticketOutcome(h.repo.tickets.get(ticketId)!)).toBe('stopped')
    expect(ticketOutcome({})).toBeUndefined()
  })
})
describe('attach', () => {
  it('sends the routing note for a message the worker has, ends an Eval that holds only that message, and refuses a ticket a person stopped or the Policy no longer holds', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '2')])
    // The follow-up reached the ticket without an Eval, and is its worker's to judge; sent to Eval again by a person, it is judged there.
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.reevaluate('2')).toBe(true); h.pump()
    expect(h.engine.candidate('2')).toBeDefined()
    const attached = h.engine.attach(ticketId, '2', 'The guest asks for the same fix'); h.settle()
    expect(attached.inputs).toEqual([expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '2', note: 'The guest asks for the same fix' })])
    expect(h.delivered.map(([, input]) => input)).toEqual(attached.inputs.map(input => input.id))
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticketId } }] })
    // A note for a message that still waits for the worker goes out with it, as for one a person sent to Eval at once.
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5')
    expect(h.engine.attach(ticketId, '5', 'Same fix again').inputs.at(-1)).toMatchObject({ triggerId: '5', note: 'Same fix again' })
    h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('mandateRevoked'))
    h.setVersion('v1')
    const stopped = accepted(h, '3', 't3').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.attach(stopped, '2')).toThrow(new UserError('ticketStopped'))
    expect(() => h.engine.attach('missing', '2')).toThrow(new UserError('unknownTicket'))
  })
  it('ends the batch Eval of a message attached to a ticket and assesses the rest again, leaving the message to that ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.engine.receive(trigger('3', elsewhere)); h.pump()
    h.engine.attach(ticketId, '3'); h.pump()
    expect(h.repo.decisions.byThread('chat:x')).toEqual([expect.objectContaining({ kind: 'unavailable', triggerIds: ['2', '3'],
      reason: [{ code: 'routed', triggerId: '3', values: { ticket: ticketId } }] })])
    expect(h.engine.candidate('2')?.triggers.map(item => item.id)).toEqual(['2'])
    expect(followupOwners(h.repo.triggers.get('3')!, h.repo)).toEqual([ticketId])
    expect(() => h.engine.attach(other, '3')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
  })
  it('names missing things apart from refusals and fills in the values', () => {
    expect([new UserError('unknownTicket').missing, new UserError('ticketEnded').missing]).toEqual([true, false])
    expect(new UserError('notAdmissible', { reason: 'not_a_member' })).toMatchObject({ code: 'notAdmissible', values: { reason: 'not_a_member' }, message: 'Trigger is not admissible: not_a_member' })
  })
})
describe('direct decisions', () => {
  it('decides an explicit request no Eval holds in a direct Eval, refuses a proactive accept without matched rules, and accepts a Trigger once', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    const decision = h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'routed' })
    expect(decision).toMatchObject({ kind: 'accept', triggerIds: ['1'], strength: 'explicit' })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'routed' })).toEqual(decision)
    // A guest's follow-up reached that ticket without an Eval: its worker decides it, and only what the worker hands back can
    // become new work, under the gate's authority, inferred.
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticketId = decision.ticketId!
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['r1'] }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    h.engine.handback(ticketId, '2', 'A different fix')
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'proactive' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule',
      rules: ['r1'] })).toMatchObject({ kind: 'accept', strength: 'inferred' })
    expect(() => h.engine.decide('missing', { kind: 'ignore', reason: 'x' })).toThrow(new UserError('unknownTrigger'))
  })
  it('accepts an inferred candidate only on rules the Policy admits, whoever names them', () => {
    const h = harness({ admitsInferred: rules => rules.includes('enabled') })
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const candidate = h.requests.at(-1)!
    expect(() => h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['disabled'] })).toThrow(new UserError('notExplicit'))
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['enabled'] })).toMatchObject({ kind: 'accept' })
  })
  it('ends the Eval of a replayed Trigger that started a ticket, and returns that ticket\'s Decision for it', () => {
    const h = harness()
    const decision = accepted(h)
    h.tick(1)
    expect(h.engine.reevaluate('1')).toBe(true)
    h.pump()
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['1'],
      reason: [{ code: 'startedTicket', triggerId: '1', values: { ticket: decision.ticketId } }] })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(() => h.engine.reevaluate('missing')).toThrow(new UserError('unknownTrigger'))
  })
  it('keeps a replayed Trigger that started a ticket out of the Eval of the Triggers queued with it', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    // The member's replayed request lends the guest's message no authority.
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.engine.candidate('2')).toMatchObject({ strength: 'inferred', triggers: [{ id: '2' }] })
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
  })
  it('starts a ticket from a request accepted beside a replayed one, with its own origin and acknowledgement', () => {
    const h = harness()
    const first = accepted(h)
    h.tick(1); h.engine.receive(trigger('2')); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    const second = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed', acknowledgement: 'On it' })
    expect(second.ticketId).not.toBe(first.ticketId)
    expect(h.repo.tickets.get(second.ticketId!)!.origin).toEqual({ triggerId: '2', triggerIds: ['2'] })
    expect(h.outbox.find(message => message.id === key('ack', '2'))).toMatchObject({ text: 'On it', kind: 'acknowledgement' })
    // The replayed request still answers with the ticket it started.
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'again' })).toEqual(first)
  })

})
describe('automatic input', () => {
  it('holds back automatic Input from a worker that reported blocked or failed until a person\'s message arrives', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const bot = (id: string) => trigger(id, { human: false })
    h.engine.receive(bot('2'))
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    // Both pending and subsequent automated inputs stay queued on the ticket without waking the worker.
    h.engine.receive(bot('3')); h.settle()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], inputs: [expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '3' })] })
    expect(h.delivered).toEqual([])
    h.tick(1)
    h.engine.receive(trigger('4', { actor: guest })); h.engine.receive(bot('5')); h.settle()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '4'), key('input', ticketId, 'trigger', '5')])
  })
  it('stops waiting for a person on a person\'s message, a later report that is neither blocked nor failed, or a retry', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    expect(waitsForPerson(ticket())).toBe(true)
    expect(ticketStage(ticket())).toEqual({ stage: 'person', action: 'blocked' })
    // The worker has the person's reply, so the stale blocked report no longer holds the ticket.
    h.tick(1); h.engine.receive(trigger('2', { actor: guest })); h.settle()
    expect(waitsForPerson(ticket())).toBe(false)
    expect(ticketStage(ticket())).toEqual({ stage: 'working' })
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    expect(waitsForPerson(ticket())).toBe(true)
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'found a way' })
    expect(waitsForPerson(ticket())).toBe(false)
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId)
    expect(waitsForPerson(ticket())).toBe(false)
  })
  it('launches a failed launch again for a person\'s message, but not for a Policy change', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const ticketId = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' }).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'The prepare command failed' })
    vi.mocked(h.executor.start).mockClear()
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2')
    expect(h.executor.start).not.toHaveBeenCalled()
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticketId }), expect.objectContaining({ state: 'pending' }))
  })
})
describe('replies', () => {
  it('acknowledges a person\'s message that reached an open ticket once, and refuses others', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // The acknowledgement of the accept stays; a later request for one reuses it.
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '1', text: 'On it' })).toEqual({ id: key('ack', '1'), status: 'pending', reused: true })
    expect(h.outbox.map(message => message.text)).toEqual(['ok'])
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'Looking' })).toEqual({ id: key('ack', '2'), status: 'pending', reused: false })
    h.engine.receive(trigger('3', { human: false }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '3', text: 'x' })).toThrow(new UserError('ackNotPerson'))
    h.engine.receive(trigger('6', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '6', text: 'x' })).toThrow(new UserError('notReached'))
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'x' })).toThrow(new UserError('ackEnded'))
  })
  it('sends an answer only after the worker reported it, a result only for a ready ticket, and attention only for its current question', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = trigger('2', { actor: guest, channel: { source: 'chat', thread: 't1', address: { message: '2' } } })
    h.engine.receive(asked)
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toThrow(new UserError('noAnswer'))
    h.engine.report(ticketId, { state: 'progress', summary: 'Yes', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toMatchObject({ status: 'pending', reused: false })
    expect(h.outbox.at(-1)).toMatchObject({ channel: asked.channel, text: 'Yes', kind: 'reply' })
    expect(h.repo.tickets.get(ticketId)!.answers).toEqual([])
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Which color?', askedBy: '2' })
    expect(() => h.engine.reply({ purpose: 'attention', ticketId, question: 'Which size?', text: 'x' })).toThrow(new UserError('notAttention'))
    // Without an open question there is nothing to ask, whether or not a question is named.
    const quiet = accepted(h, '9', 't9').ticketId!
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, question: '', text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    const attention = h.repo.tickets.get(ticketId)!.attention!
    expect(h.engine.reply({ purpose: 'attention', ticketId, question: 'Which color?', text: 'Which color?' }).id).toBe(key('attention-reply', attention.id))
    // A question goes where the message that raised it was written.
    expect(h.outbox.at(-1)!.channel).toEqual(asked.channel)
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ status: 'pending' })
    expect(h.outbox.at(-1)!.channel).toEqual(trigger('1').channel)
  })
})
describe('ticket commands', () => {
  it('ends a ticket by the same rule on a close and on a ready report: once no PR it opened is open, as the latest of them ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // It started from someone's PR and opened its own.
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-5' }, false)
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-7' }, 'merged', '2026-09-23T00:00:00Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // A person's comment resumes it; its ready report ends it again as its own PR did, though the one it started from is open.
    h.tick(10); h.engine.receive(trigger('2', { threads: [{ source: 'gh', id: 'pr-5' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    h.engine.report(ticketId, { state: 'ready', summary: 'Answered' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // The PR it started from closing later changes nothing.
    h.engine.threadClosed({ source: 'gh', id: 'pr-5' }, 'closed', '2026-09-23T00:00:30Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // A ticket that opened no PR ends when the one it follows closes, as it did.
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-8' }, false)
    h.engine.report(other, { state: 'ready', summary: 'Pushed to their branch' })
    expect(h.repo.tickets.get(other)).not.toHaveProperty('ended')
    h.engine.threadClosed({ source: 'gh', id: 'pr-8' }, 'closed', '2026-09-23T00:01:00Z')
    expect(h.repo.tickets.get(other)!.ended).toMatchObject({ outcome: 'closed' })
  })
  it('stops following a Thread whose Subscription a person removes', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    expect(h.engine.unsubscribe('gh:pr-7')).toBe(true)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('follows')
    // Its ready report completes it, since it follows no Thread now.
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
  })
  it('follows a Source\'s Threads, and ends once no Thread of its own is open, unless resumed work has not finished', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const close = (id: string, outcome: 'merged' | 'closed', at: string) => {
      const open = h.repo.tickets.open().map(ticket => ticket.id)
      h.engine.threadClosed({ source: 'gh', id }, outcome, at)
      return open.filter(item => h.repo.tickets.get(item)!.ended)
    }
    expect(h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }] })
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
    expect(h.repo.threads.get('gh:pr-9')!.subscriptions).toEqual([ticketId])
    // The Thread it started from closes while its own is open: it records the close and works on.
    expect(close('pr-9', 'closed', '2026-09-23T00:00:00Z')).toEqual([])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ follows: [{ thread: 'gh:pr-9', closed: { outcome: 'closed' } }, { thread: 'gh:pr-10' }] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    // Its own closes too: it ends as that one did, when it did, once.
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([ticketId])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-23T00:00:01.000Z' } })
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([])
    expect(() => h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-11' }, true)).toThrow(new UserError('ticketEnded'))
    // A ticket retried after its PR closed but before the close was reported works on until it reports ready.
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-12' }, true)
    h.engine.report(other, { state: 'failed', summary: 'tests fail' })
    h.tick(10); h.engine.retryTicket(other)
    expect(close('pr-12', 'closed', '2026-09-23T00:00:05Z')).toEqual([])
    expect(h.repo.tickets.get(other)!.ended).toBeUndefined()
    h.engine.report(other, { state: 'ready', summary: 'done' })
    expect(h.repo.tickets.get(other)).toMatchObject({ ended: { outcome: 'closed' } })
  })

  it('retries a ticket that reported failed with a new Assignment, and asks only a waiting worker for its status', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
    expect(h.engine.requestStatus(ticketId)).toBe(false)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([])
    h.engine.report(ticketId, { state: 'waiting', summary: 'idle' })
    expect(h.engine.requestStatus(ticketId)).toBe(true)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('status-only') })])
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments).toEqual([expect.objectContaining({ state: 'ended', endedReason: 'retried' }), expect.objectContaining({ state: 'pending' })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: ticketId }), retried.assignments[1])
  })

  it('recovers a ticket its worker stopped on a passing failure with a new Assignment that records the host retried it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.recoverTicket(ticketId)).toThrow(new UserError('notRetryable'))
    h.engine.report(ticketId, { state: 'failed', summary: 'LlmError: 503: the gateway is unavailable' })
    const recovered = h.engine.recoverTicket(ticketId)
    expect(recovered.assignments).toEqual([expect.objectContaining({ state: 'ended', endedReason: 'recovered' }), expect.objectContaining({ state: 'pending' })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: ticketId }), recovered.assignments[1])
  })
})
describe('failed deliveries', () => {
  it('forgets a failed delivery once a new Assignment takes over or the ticket ends', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const failed = () => {
      h.engine.deliveryFailed(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id, 'Session busy')
      expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    }
    failed()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    failed()
    h.engine.stopTicket(ticketId)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
})
describe('problems', () => {
  it('dismisses the problem an unavailable Decision shows, and only such a Decision', () => {
    const h = harness()
    const decision = accepted(h)
    expect(() => h.engine.dismiss(decision.id)).toThrow(new UserError('unknownProblem'))
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const unavailable = h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    expect(h.engine.dismiss(unavailable.id)).toMatchObject({ kind: 'unavailable', dismissed: true })
    expect(h.repo.decisions.get(unavailable.id)).toMatchObject({ dismissed: true })
  })
})
describe('retry after a failed delivery', () => {
  it('starts a new Assignment for a ticket whose Input keeps failing to reach its worker, which takes the Input', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'tests fail' })
    // A person's answer goes to the failed worker, and delivering it fails.
    h.tick(5); h.engine.receive(trigger('2'))
    const answered = h.repo.tickets.get(ticketId)!
    expect(answered.undelivered).toHaveLength(1)
    h.engine.deliveryFailed(ticketId, runningAssignment(answered)!.id, 'Session gone')
    expect(ticketStage(h.repo.tickets.get(ticketId)!)).toEqual({ stage: 'person', action: 'delivery' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
    expect(retried).not.toHaveProperty('delivery')
    expect(retried.undelivered).toHaveLength(1)
  })
})
describe('Evals across Policy versions, revoked Mandates and mixed batches', () => {
  it('queues an Eval\'s batch again when it is decided under an older Policy, such as after an upgrade changed the version', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const candidate = h.requests.at(-1)!
    // An upgrade changes the version without a Policy change being reported.
    h.setVersion('v2')
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r' })).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: ['1'] })
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '1' })] })
  })
  it('queues a person\'s message for Eval when the only ticket it reached cannot resume under the Policy now, and says it reached none', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setVersion('revoked')
    h.tick(5); h.engine.receive(trigger('2'))
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
  })
  it('queues a person\'s message that waited out a pause for Eval when the ticket it reached cannot resume once the pause lifts', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setPaused(true)
    h.tick(5); h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
    h.setVersion('revoked'); h.setPaused(false); h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending.includes('2') || h.engine.candidate('2') !== undefined).toBe(true)
  })
  it('takes a new ticket\'s origin and acknowledgement from the admissible Trigger that gave its batch its strength', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci-bot' }, channel: { source: 'chat', thread: 'chat:t1', address: { message: 'bot' } } }))
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['1', '2'])
    const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r', acknowledgement: 'ok' })
    expect(h.repo.tickets.get(decision.ticketId!)!.origin).toEqual({ triggerId: '1', triggerIds: ['1', '2'] })
    expect(h.outbox).toEqual([expect.objectContaining({ id: key('ack', '1'), channel: trigger('1').channel })])
  })
})
describe('gaps', () => {
  it('takes a mixed batch\'s strength, actor and basis from its strongest admissible Trigger, the latest of equal strength', () => {
    // A guest's message is admitted as inferred, as on a Thread a ticket follows.
    const gate: Policy['gate'] = t => t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    for (const order of [['guest', 'alice'], ['alice', 'guest']]) {
      const h = harness({ gate })
      order.forEach((who, index) => { h.tick(1); h.engine.receive(trigger(String(10 + index), { actor: who === 'alice' ? member : guest })) })
      h.pump()
      const alice = String(10 + order.indexOf('alice'))
      expect(h.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ strength: 'explicit', actor: member, basis: { via: 'listed' }, primary: alice })
    }
    const named = harness({ gate: t => ({ admissible: true, strength: 'explicit', basis: { via: 'listed', sender: t.actor.id } }) })
    named.engine.receive(trigger('1', { actor: { source: 'chat', id: 'bob' } }))
    named.tick(1); named.engine.receive(trigger('2', { actor: { source: 'chat', id: 'carol' } }))
    named.pump()
    expect(named.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ actor: { id: 'carol' }, basis: { sender: 'carol' }, primary: '2' })
  })
  it('changes nothing and delivers nothing on a late start of an Assignment a retry replaced', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const first = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.retryTicket(ticketId)
    const before = h.repo.tickets.get(ticketId)!
    const delivered = h.delivered.length
    h.engine.assignmentStarted(ticketId, first); h.settle({ launch: false })
    expect(h.repo.tickets.get(ticketId)!.assignments).toEqual(before.assignments)
    expect(h.delivered).toHaveLength(delivered)
  })
  it('records a stop that names an unknown or ended ticket as ignored', () => {
    const h = harness()
    const ended = accepted(h).ticketId!
    h.engine.report(ended, { state: 'ready', summary: 'Done' })
    for (const [id, ticketId] of [['2', 'missing'], ['3', ended]] as const) {
      h.tick(1); h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: `t${id}` }] })); h.pump()
      expect(h.decide(h.requests.at(-1)!, { kind: 'stop', ticketId, reason: 'stop it' })).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopUnknown' }] })
    }
    expect(h.repo.tickets.get(ended)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })
  it('refuses a direct decision on a Trigger the gate does not admit, and leaves the queue as it was', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    const pending = h.repo.threads.get('chat:t1')!.pending
    expect(() => h.engine.decide('1', { kind: 'ignore', reason: 'noise' })).toThrow(new UserError('notAdmissible', { reason: 'not human' }))
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(pending)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
  it('refuses to retry a ticket a person stopped after its failed report', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
  })
  it('answers a question once, sends a result only for finished work, and the same result once', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'progress', summary: 'It reads the config.', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'It reads the config.' })).toMatchObject({ reused: false })
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Something else.' })).toThrow(new UserError('noAnswer'))
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    const sent = h.outbox.length
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: false })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: true })
    expect(h.outbox).toHaveLength(sent + 1)
    // A ticket whose PR closed unmerged, or that a person stopped, has no result to send.
    const closed = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(closed, { source: 'gh', id: 'pr-1' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'closed', '2026-09-23T00:01:00Z')
    expect(() => h.engine.reply({ purpose: 'result', ticketId: closed, text: 'x' })).toThrow(new UserError('notReady'))
    const stopped = accepted(h, '6', 't6').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.reply({ purpose: 'result', ticketId: stopped, text: 'x' })).toThrow(new UserError('notReady'))
  })
  it('keeps an Eval\'s deadline on a repeated delivery, refuses to queue a held Trigger again, and puts expired Triggers first', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    h.engine.candidateDelivered(evalId)
    const deadline = h.repo.threads.get('chat:t1')!.evaluating!.deadline
    h.tick(30); h.engine.candidateDelivered(evalId)
    expect(h.repo.threads.get('chat:t1')!.evaluating!.deadline).toBe(deadline)
    expect(h.engine.reevaluate('1')).toBe(false)
    // A Trigger that arrives meanwhile queues behind the expired one, and the fresh Eval takes both in that order.
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    h.tick(30); h.engine.evaluateDue()
    expect(h.repo.threads.get('chat:t1')!.evaluating!.triggerIds).toEqual(['1', '2'])
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('final review', () => {
  it('ignores an Eval an earlier version left holding only a Trigger that started a ticket, instead of recording it unavailable', () => {
    const h = harness()
    const decision = accepted(h)
    // An earlier version could leave an Eval holding the Trigger after it started a ticket.
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'old-eval', threadKey: 'chat:t1', triggerIds: ['1'], primary: '1', strength: 'explicit', actor: member,
      basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '', deadline: '2999-01-01T00:00:00.000Z' } })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'replayed' })).toEqual(decision)
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'startedTicket', triggerId: '1',
      values: { ticket: decision.ticketId } }] })
    expect(h.repo.decisions.byThread('chat:t1').some(item => item.kind === 'unavailable')).toBe(false)
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
  })
  it('clears the count of expired Evals when the gate ignores what a Thread queued', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    h.repo.threads.save({ ...h.repo.threads.get('chat:t1')!, expired: 1 })
    h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore' })])
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('final review: Policy transitions', () => {
  it('tells a worker of each Policy change that bears on its ticket, also of one that repeats an earlier transition', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const effect = { requesterAllowed: false as const }
    for (const [from, to] of [['A', 'B'], ['B', 'A'], ['A', 'B']]) { h.tick(1); h.engine.policyChanged(from!, to!, new Map([[ticketId, effect]])) }
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'policy-changed')).toHaveLength(3)
  })
})
describe('final review: Threads followed for context', () => {
  it('lets a worker acknowledge or ask no one on a Thread it follows only for context', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'side' })
    h.tick(1); h.engine.receive(trigger('5', { threads: [{ source: 'chat', id: 'side' }], channel: { source: 'chat', thread: 'side', address: { message: '5' } } }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '5', text: 'On it' })).toThrow(new UserError('notReached'))
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'A question', question: 'Which page?', askedBy: '5' })).toThrow(new UserError('notAsker'))
  })
})
describe('final review: close times', () => {
  it('records a Source\'s close time in the canonical form, and keeps the ticket\'s updatedAt moving forward', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-1' }, true)
    h.tick(30)
    const before = h.repo.tickets.get(ticketId)!.updatedAt
    // GitHub gives whole seconds, and the PR merged before the ticket's last change.
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'merged', '2026-09-23T00:00:05Z')
    const ended = h.repo.tickets.get(ticketId)!
    expect(ended.ended).toMatchObject({ at: '2026-09-23T00:00:05.000Z', outcome: 'merged' })
    expect(ended.follows).toEqual([{ thread: 'gh:pr-1', own: true, closed: { at: '2026-09-23T00:00:05.000Z', outcome: 'merged' } }])
    expect(ended.updatedAt >= before).toBe(true)
  })
})
describe('model-surface review', () => {
  it('resumes an ended ticket only on a person\'s message, not on a bot\'s that is attached to it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci' }, threads: [{ source: 'chat', id: 'ci' }] }))
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // A person's message resumes it, with what waited.
    h.tick(1); h.engine.receive(trigger('3'))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('follow-up review: turn ends', () => {
  const merge = (h: ReturnType<typeof harness>) => h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
  it('lets a merge send to Eval only the messages its worker had no turn to read after its ready report', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    // A person thanks the worker, which reads it in a turn and leaves it; another message comes after that turn.
    h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    merge(h)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('keeps a ticket open at a merge while its worker works on a message it took up, also after a progress report', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    // It answers another question in a progress report while it works on the message.
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Answered the other question' })
    merge(h)
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('ends a ticket whose close it deferred as the close did when its worker then drops the work', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    merge(h)
    h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing more to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('sends a message another ticket handed back to Eval when a stop on it ends the ticket that kept it', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    expect(h.engine.handback(second, '3', 'It is about the first fix')).toBe(false)
    h.engine.decide('3', { kind: 'stop', ticketId: first, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('gives a live ticket\'s worker again a message it had that a person sent to Eval and the main Session attached back', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.engine.reevaluate('2'); h.pump()
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')).toHaveLength(2)
  })
})
describe('follow-up review: turn ends and deliveries', () => {
  it('lets a stop send to Eval a message that waited for delivery when a turn ended, and reached the worker after', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // The turn ends while the message is on its way; it reaches the worker after, and a person stops the ticket in that turn.
    h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('follow-up review: delivery times', () => {
  it('lets a stop send to Eval a message that came before the worker\'s waiting report but reached the worker after it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // The Executor reports the worker waiting while the message is on its way; it reaches the worker after, and a person stops.
    h.tick(1); h.engine.report(ticketId, { state: 'waiting', summary: 'Waiting for input' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('routing review', () => {
  it('records two stops of one follow-up that reached two tickets, made in the same moment, as two Decisions', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    const stops = [first, second].map(ticketId => h.engine.decide('3', { kind: 'stop', ticketId, reason: 'asked to stop' }))
    expect(new Set(stops.map(stop => stop.id)).size).toBe(2)
    expect(stops.map(stop => h.repo.decisions.get(stop.id)?.ticketId)).toEqual([first, second])
    expect([first, second].map(id => h.repo.tickets.get(id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
  })
})

describe('what a worker read', () => {
  /** A ticket that ended, resumed by a person's message `2`, whose new Assignment started; its Inputs wait for delivery. */
  function resumed() {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.tick(1); h.engine.receive(trigger('2'))
    const assignmentId = h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id
    h.tick(1); h.engine.assignmentStarted(ticketId, assignmentId)
    const [note, message] = h.repo.tickets.get(ticketId)!.undelivered as [string, string]
    return { h, ticketId, assignmentId, note, message, pending: () => h.repo.threads.get('chat:t1')!.pending }
  }
  it('sends to Eval a message that woke a ticket and reached its worker only after a progress report, at a dropped report', () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // Delivering the message fails at first; the worker reports progress, and the retry hands the message over while it
    // writes that nothing is left.
    h.engine.inputsDelivered(ticketId, assignmentId, [note])
    h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual(['2'])
  })
  it('counts a message that woke a ticket as read by a later dropped report once its worker\'s Session took it into a step', () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // The Session takes it into the step its arrival starts, before the Executor records the delivery.
    h.engine.inputsRead(ticketId, [message])
    h.engine.inputsDelivered(ticketId, assignmentId, [note, message])
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual([])
  })
  it('sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('counts a message a retry delivered after a failure and a turn end as read by a dropped report only once a step took it', () => {
    for (const taken of [false, true]) {
      const { h, ticketId, assignmentId, note, message, pending } = resumed()
      h.engine.inputsDelivered(ticketId, assignmentId, [note])
      h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
      h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
      h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
      if (taken) h.read(ticketId)
      h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
      expect(pending()).toEqual(taken ? [] : ['2'])
    }
  })
  it('counts a message a step took before a restart cut its turn off as read only once the restarted worker reports', () => {
    for (const reported of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
      // The Assignment starts again with a recovery note, in the same Session, which holds the message.
      h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id); h.settle()
      if (reported) { h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Recovered' }) }
      h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(reported ? [] : ['2'])
    }
  })
})
describe('read claims review', () => {
  it('gives a retry\'s Assignment the messages the failed one had delivered but no step of its worker took', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputId = ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === '2')!.id
    expect(ticket().undelivered).toEqual([])
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'The turn broke.' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputId])
  })
})
describe('read claims review: retries', () => {
  it('gives a retry only what the Assignment it replaces had delivered and no step took, not what an earlier end let go of', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    // A follow-up reaches the worker, and the ticket ends before any step took it, which sends it to Eval.
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    // A person's message resumes the ticket; its worker reports blocked before a step took the message, and a person retries.
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('3')])
  })
})
describe('read claims review: restarts', () => {
  it('gives a restart\'s Assignment what the replaced one had delivered and no step took, and a retry of it gets it again', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    // The host restarts mid-work before a step took the message, which a cancel may have dropped: the new Assignment gets it.
    h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(ticket())!.id)
    expect(ticket().undelivered[0]).toBe(inputOf('2'))
    h.settle()
    // That Assignment blocks before a step took it, and a person retries: the retry's Assignment gets it too.
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('2')])
  })
})
describe('ignores from the card', () => {
  const said = (text: string) => ({ code: 'said', values: { text } })
  it('marks the ignore of an inferred candidate that no assessment judged, unlike an assessed one or an explicit candidate\'s', () => {
    const h = harness()
    accepted(h)
    // A guest's message sent to Eval is an inferred candidate, which the main Session ignores from its card.
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred' })
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'Plain chat.' }).reason).toEqual([{ code: 'ignoredFromCard' }, said('Plain chat.')])
    // An assessment's ignore keeps its rule judgments, without the mark.
    h.engine.receive(trigger('3', { actor: guest })); h.engine.reevaluate('3'); h.pump()
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'Plain chat.', audit: { rule_assessments: [] } }))
      .toMatchObject({ reason: [said('Plain chat.')], audit: { rule_assessments: [] } })
    // An explicit candidate is always routed from its card.
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 't9' }] })); h.pump()
    expect(h.engine.decide('4', { kind: 'ignore', reason: 'Thanks.' }).reason).toEqual([said('Thanks.')])
    // Accepting an inferred candidate still takes an assessment's matched rules.
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5'); h.pump()
    expect(() => h.engine.decide('5', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'chat' })).toThrow(new UserError('notExplicit'))
  })
})

/** A complete P1 plan: every template line, in order (docs/012 §2). */
const PLAN = `现象：翻页时列表头像闪一下
代码线：Source/UI/AvatarList.cpp:42 — 复用控件时先清空了纹理
资产线：已排除 — 头像纹理本身没有更新
配置线：已排除 — 该界面没有相关 cvar 或 ini 开关
修复锚点：Source/UI/AvatarList.cpp，1 个文件，公共 UI 模块
影响面：只影响该列表，CL 冲突风险低
验证方案：基线跑 UI 自动化 3 例 → 改后同样 3 例 → 比对闪烁帧数
预算：编译 1 次，总时长约 20 分钟`
describe('P1 plan gate', () => {
  it('refuses an incomplete plan, and records a complete one as the waiting gate with its deadline', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.submitPlan(ticketId, '现象：闪一下\n代码线：AvatarList.cpp'))
      .toThrowError(expect.objectContaining({ code: 'planIncomplete' }))
    h.tick(1)
    const ticket = h.engine.submitPlan(ticketId, PLAN)
    expect(ticket.phase).toBe('plan')
    expect(ticket.plan).toMatchObject({ text: PLAN, waiting: true, deadline: '2026-09-24T00:00:01.000Z' })
    expect(ticket.plan!.approved).toBeUndefined()
    expect(ticket.attention?.question).toContain('方案待确认')
  })
  it('cards the worker\'s question and choices, refuses a choice set that is not a card\'s, and records the clicked label', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1)
    expect(() => h.engine.submitPlan(ticketId, PLAN, '先上 A 还是先上 B？', [{ label: '先上 A', decision: 'approve' }]))
      .toThrowError(expect.objectContaining({ code: 'planOptions' }))
    expect(() => h.engine.submitPlan(ticketId, PLAN, '   '))
      .toThrowError(expect.objectContaining({ code: 'planQuestion' }))
    const ticket = h.engine.submitPlan(ticketId, PLAN, '先上 A 还是先上 B？', [
      { label: '先上 A', decision: 'approve', note: '先上 A，再补 B' },
      { label: '先上 B', decision: 'revise', note: '走 B，先上工具链' },
      { label: '先不动', decision: 'stop' },
    ])
    expect(ticket.plan).toMatchObject({ question: '先上 A 还是先上 B？', options: [
      { label: '先上 A', decision: 'approve', note: '先上 A，再补 B' },
      { label: '先上 B', decision: 'revise', note: '走 B，先上工具链' },
      { label: '先不动', decision: 'stop' },
    ] })
    h.tick(1)
    const decided = h.engine.decidePlan(ticketId, 'approve', '', 'feishu', '先上 A')
    expect(decided.plan).toMatchObject({ approved: { option: '先上 A', via: 'feishu' } })
  })
  it('cards the worker\'s own context sections, and refuses sections that are not a card\'s', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1)
    expect(() => h.engine.submitPlan(ticketId, PLAN, '这个取舍能不能定？',
      [{ label: '能定', decision: 'approve' }, { label: '再改改', decision: 'revise' }],
      [{ label: '', text: 'x' }])).toThrowError(expect.objectContaining({ code: 'planSections' }))
    const ticket = h.engine.submitPlan(ticketId, PLAN, '这个取舍能不能定？',
      [{ label: '能定', decision: 'approve' }, { label: '再改改', decision: 'revise' }],
      [{ label: '现状', text: '两个方案都能过测试' }, { label: '代价', text: '复用控件少一个缓存层', fold: true }])
    expect(ticket.plan).toMatchObject({ sections: [
      { label: '现状', text: '两个方案都能过测试' },
      { label: '代价', text: '复用控件少一个缓存层', fold: true },
    ] })
  })
  it('approves a plan on a person\'s 1 without handing the digit to the worker, and moves the ticket to implement', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    h.tick(1); h.engine.receive(trigger('2', { text: '1' }))
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.phase).toBe('implement')
    expect(ticket.plan).toMatchObject({ approved: { at: '2026-09-23T00:00:02.000Z' } })
    expect(ticket.plan!.waiting).toBeUndefined()
    expect(ticket.attention).toBeUndefined()
    // The person's digit is the gate's decision, not a new message for the worker or a new Eval: it is acknowledged on the ticket.
    expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [ticketId], acked: [ticketId] })
    expect(h.repo.threads.get('chat:t1')?.pending).not.toContain('2')
    expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'text', text: expect.stringContaining('通过 P1 方案') })
  })
  it('does not read prose that begins with a digit as approving or stopping a plan', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    h.tick(1); h.engine.receive(trigger('2', { text: '3 个地方要改' }))
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.phase).toBe('plan')
    expect(ticket.plan).toMatchObject({ waiting: true })
    // It reaches the worker as ordinary work instead of ending the ticket and swallowing the review comment.
    expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'trigger', triggerId: '2' })
  })
  it('keeps a bare 1 ambiguous when two reached tickets both wait for a plan, and sends it to Eval to ask which', () => {
    const h = harness()
    const first = accepted(h, '1', 't1').ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.tick(1); h.engine.submitPlan(first, PLAN); h.engine.submitPlan(second, PLAN)
    h.tick(1); h.engine.receive(trigger('3', { text: '1', threads: [{ source: 'chat', id: 't1' }, { source: 'chat', id: 't2' }] }))
    for (const id of [first, second]) {
      const ticket = h.repo.tickets.get(id)!
      expect(ticket.phase).toBe('plan')
      expect(ticket.plan).toMatchObject({ waiting: true })
      expect(ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === '3')).toBe(false)
    }
  })
  it('takes a bare 1 in a fresh direct thread as the answer to the one plan that person has waiting', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    // A Feishu direct chat gives every message its own thread, so the answer reaches no ticket by subscription.
    h.tick(1); h.engine.receive(trigger('9', { text: '1', threads: [{ source: 'chat', id: 't9' }], meta: { direct: true } }))
    expect(h.repo.tickets.get(ticketId)!.phase).toBe('implement')
    expect(h.repo.triggers.disposition('9')).toMatchObject({ fanout: [], acked: [ticketId] })
  })
  it('takes an exact choice label a person types as the card choice, with that choice\'s own direction', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN, '先上 A 还是先上 B？', [
      { label: '先上 A', decision: 'approve', note: '先上 A，再补 B' },
      { label: '先上 B', decision: 'revise', note: '走 B，先上工具链' },
    ])
    h.tick(1); h.engine.receive(trigger('2', { text: '先上 A' }))
    expect(ticket().phase).toBe('implement')
    expect(ticket().plan).toMatchObject({ approved: { option: '先上 A' } })
    expect(h.repo.threads.get('chat:t1')?.pending).not.toContain('2')
  })
  it('takes 2 as another direction and 3 as a stop, and ignores a bot\'s digit', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    // A bot's "1" is not a person's decision: the gate keeps waiting and the message reaches the worker.
    h.tick(1); h.engine.receive(trigger('2', { text: '1', human: false }))
    expect(ticket().phase).toBe('plan')
    expect(ticket().plan!.waiting).toBe(true)
    // "2" changes direction with the note; the worker is told to revise and stays in the plan phase.
    h.tick(1); h.engine.receive(trigger('3', { text: '2 改成只在 DS 环境去重' }))
    expect(ticket().phase).toBe('plan')
    expect(ticket().plan).toMatchObject({ feedback: [{ text: '改成只在 DS 环境去重' }] })
    expect(ticket().plan!.waiting).toBeUndefined()
    expect(ticket().inputs.at(-1)).toMatchObject({ kind: 'text', text: expect.stringContaining('只在 DS 环境去重') })
    // A revised plan waits again; "3" stops the ticket as a person's stop.
    h.tick(1); h.engine.submitPlan(ticketId, `${PLAN}\n\n按反馈调整：只在 DS 环境去重。`)
    h.tick(1); h.engine.receive(trigger('4', { text: '3' }))
    expect(ticket().ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: expect.stringContaining('飞书') })
    // The stop answers the gate: a later resume must not reopen it.
    expect(ticket().plan!.waiting).toBeUndefined()
  })
  it('stops the ticket when nobody answers before the deadline: a gate never defaults to continue', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    h.tick(23 * 3600); h.pump()
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    h.tick(3601); h.pump()
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'executor', outcome: 'stopped', reason: expect.stringContaining('timed out') })
    expect(h.repo.tickets.get(ticketId)!.plan!.waiting).toBeUndefined()
  })
  it('moves one phase forward only, and deliver needs verification recorded', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    h.tick(1); h.engine.receive(trigger('2', { text: '1' }))
    // The Engine records `execution` from `prepareTicket`; a harness without one adds it here so delivery facts have a home.
    const stored = h.repo.tickets.get(ticketId)!
    h.repo.tickets.save({ ...stored, execution: { name: 'w', directory: '/w', assignment: 'a' } })
    expect(() => h.engine.advancePhase(ticketId, 'deliver')).toThrowError(expect.objectContaining({ code: 'phaseOutOfOrder' }))
    expect(h.engine.advancePhase(ticketId, 'verify').phase).toBe('verify')
    expect(() => h.engine.advancePhase(ticketId, 'deliver')).toThrowError(expect.objectContaining({ code: 'notDeliverable' }))
    expect(() => h.engine.advancePhase(ticketId, 'verify')).toThrowError(expect.objectContaining({ code: 'phaseOutOfOrder' }))
  })
  it('refuses a changelist or a ready report while the plan waits, and allows them in deliver', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.submitPlan(ticketId, PLAN)
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'shelved', delivery: { changelist: 7 } }))
      .toThrowError(expect.objectContaining({ code: 'notDeliverable' }))
    expect(() => h.engine.report(ticketId, { state: 'ready', summary: 'done' }))
      .toThrowError(expect.objectContaining({ code: 'notDeliverable' }))
    h.tick(1); h.engine.receive(trigger('2', { text: '1' }))
    const stored = h.repo.tickets.get(ticketId)!
    h.repo.tickets.save({ ...stored, execution: { name: 'w', directory: '/w', assignment: 'a' } })
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'verified', delivery: { verification: '3 例通过' } })
    h.engine.advancePhase(ticketId, 'verify'); h.engine.advancePhase(ticketId, 'deliver')
    expect(h.engine.report(ticketId, { state: 'progress', summary: 'shelved', delivery: { changelist: 7 } }))
      .toMatchObject({ execution: { changelist: 7 } })
  })
  it('leaves a ticket that never had a plan reporting as before', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.report(ticketId, { state: 'ready', summary: 'done' }).ended).toMatchObject({ outcome: 'completed' })
  })
})

describe('redispatch', () => {
  it('moves a stalled ticket into another delivery environment and starts a new assignment there', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'waiting', summary: 'waiting for the channel decision' })
    vi.mocked(h.executor.start).mockClear()
    const before = h.repo.tickets.get(ticketId)!.assignments.length
    h.engine.redispatchTicket(ticketId, 'git')
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.execution?.backend).toBe('git')
    expect(ticket.assignments).toHaveLength(before + 1)
    expect(ticket.assignments.at(-1)!.state).toBe('pending')
    expect(ticket.assignments.at(-2)).toMatchObject({ state: 'ended', endedReason: 'redispatched' })
    expect(ticket.phase).toBe('implement')
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticketId }), expect.objectContaining({ state: 'pending' }))
    expect(ticket.undelivered).toHaveLength(1)
    expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'text', text: expect.stringContaining('git 通道') })
  })
  it('keeps a plan that waits for a person when the channel moves, so a move does not answer the P1 gate', () => {
    const h = harness()
    const ticketId = accepted(h, '3').ticketId!
    h.engine.redispatchTicket(ticketId, 'p4')
    h.tick(1)
    h.engine.submitPlan(ticketId, PLAN)
    h.engine.redispatchTicket(ticketId, 'git')
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.execution?.backend).toBe('git')
    expect(ticket.phase).toBe('plan')
    expect(ticket.plan).toMatchObject({ waiting: true })
    h.engine.decidePlan(ticketId, 'approve', '', 'feishu')
    expect(h.repo.tickets.get(ticketId)!.phase).toBe('implement')
  })
  it('refuses an unknown ticket, an ended one, and gates a p4 dispatch behind the plan phase', () => {
    const h = harness()
    expect(() => h.engine.redispatchTicket('nope', 'git')).toThrow(new UserError('unknownTicket'))
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.redispatchTicket(ticketId, 'git')).toThrow(new UserError('ticketEnded'))
    const other = accepted(h, '2').ticketId!
    h.engine.redispatchTicket(other, 'p4')
    expect(h.repo.tickets.get(other)!.phase).toBe('plan')
  })
  it('rebuilds the assignment through the executor hook when one is wired', () => {
    // The executor owns the environment instructions that the assignment carries, so it rebuilds them for the move.
    const h = harness({}, { reprepareTicket: (ticket, backend) => ({
      ...(ticket.execution ?? { name: '', directory: '', assignment: '' }), assignment: 'base', backend }) })
    const ticketId = accepted(h).ticketId!
    h.engine.redispatchTicket(ticketId, 'git')
    expect(h.repo.tickets.get(ticketId)!.execution).toMatchObject({ assignment: 'base', backend: 'git' })
  })
})
