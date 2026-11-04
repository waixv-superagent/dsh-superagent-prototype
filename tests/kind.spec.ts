/** Ticket kinds (docs/020): the classification order, its derivation for older tickets, and its record at acceptance. */
import { describe, expect, it, vi } from 'vitest'
import { classifyTicket, Engine, MemoryRepositories, ticketKind } from '../src/core/index.ts'
import type { Assessor, Candidate, EngineOptions, Executor, Policy, Ticket, Trigger } from '../src/core/index.ts'

describe('classifyTicket', () => {
  it('takes the router\'s kind over every other rule', () => {
    expect(classifyTicket({ routed: 'inquiry', source: 'tapd', category: 'bug', backend: 'git', title: '修复崩溃' }))
      .toEqual({ kind: 'inquiry', source: 'router' })
  })
  it('makes a TAPD ticket a bug, and an escalation keeps its category', () => {
    expect(classifyTicket({ source: 'tapd', title: '【战斗】极限闪避无操作后选出停步动画' })).toEqual({ kind: 'bug', source: 'source' })
    expect(classifyTicket({ category: 'feature', backend: 'git', title: '修复回归' })).toEqual({ kind: 'feature', source: 'source' })
  })
  it('makes work in this deployment\'s own git repository self-iteration', () => {
    expect(classifyTicket({ source: 'feishu', backend: 'git', title: '执行看板状态与实际情况不一致' })).toEqual({ kind: 'self', source: 'source' })
  })
  it('reads the title for the rest: bug words first, then inquiry words, then a feature', () => {
    expect(classifyTicket({ source: 'feishu', backend: 'p4', title: '修复报 invalid Schema 的动画资产' })).toEqual({ kind: 'bug', source: 'rule' })
    // "排查" alone asks for an answer, but a title that also asks to fix it stays a bug.
    expect(classifyTicket({ source: 'feishu', backend: 'p4', title: '排查并修复跳跃卡住' })).toEqual({ kind: 'bug', source: 'rule' })
    expect(classifyTicket({ source: 'feishu', backend: 'p4', title: '评估 Swarm review 585177 是否必要' })).toEqual({ kind: 'inquiry', source: 'rule' })
    expect(classifyTicket({ source: 'feishu', title: 'Investigate the TDM report' })).toEqual({ kind: 'inquiry', source: 'rule' })
    expect(classifyTicket({ source: 'feishu', backend: 'p4', title: '重做跳跃实现：新增跳跃专用 LayeredMove' })).toEqual({ kind: 'feature', source: 'rule' })
  })
  it('does not read a word inside another as a bug', () => {
    expect(classifyTicket({ source: 'github', title: 'Add a prefix option' })).toEqual({ kind: 'feature', source: 'rule' })
  })
})

describe('ticketKind', () => {
  const stored = (fields: Partial<Ticket>) => ({ title: '安装 System Informer', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'alice' }, scope: '' }, ...fields }) as Ticket
  it('reads the kind recorded at acceptance', () => {
    expect(ticketKind(stored({ kind: 'inquiry', kindSource: 'router', title: '修复回归' }))).toEqual({ kind: 'inquiry', source: 'router' })
  })
  it('derives one for a ticket stored before kinds, from what it recorded', () => {
    expect(ticketKind(stored({}))).toEqual({ kind: 'feature', source: 'rule' })
    expect(ticketKind(stored({ category: 'bug' }))).toEqual({ kind: 'bug', source: 'source' })
    expect(ticketKind(stored({ execution: { name: 'n', directory: 'd', assignment: '', backend: 'git' } }))).toEqual({ kind: 'self', source: 'source' })
    expect(ticketKind(stored({ mandate: { ...stored({}).mandate, actor: { source: 'tapd', id: 'x' } } }))).toEqual({ kind: 'bug', source: 'source' })
  })
})

describe('acceptance', () => {
  function harness(prepareTicket?: EngineOptions['prepareTicket']) {
    const repo = new MemoryRepositories()
    const requests: Candidate[] = []
    const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
    const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
    const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000, revalidate: () => true, admitsInferred: () => true,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }) }
    const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor,
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, ...prepareTicket ? { prepareTicket } : {},
      now: () => '2026-11-04T00:00:00.000Z' })
    const receive = (id: string, source: string, text: string) => {
      const trigger: Trigger = { id, source, threads: [{ source, id: `t${id}` }], actor: { source, id: 'alice' }, human: true, at: '2026-11-04T00:00:00Z',
        text, meta: {} }
      engine.receive(trigger); engine.evaluateDue()
      return requests.at(-1)!
    }
    return { repo, engine, receive }
  }
  it('records a kind on every ticket it creates, the router\'s when the accept names one', () => {
    const h = harness()
    const first = h.receive('1', 'chat', 'please')
    const routed = h.engine.decide(first.triggers[0]!.id, { kind: 'accept', title: '修复回归', scope: 's', reason: 'r', ticketKind: 'inquiry', evalId: first.evalId })
    expect(h.repo.tickets.get(routed.ticketId!)).toMatchObject({ kind: 'inquiry', kindSource: 'router' })
    const second = h.receive('2', 'chat', 'please')
    const derived = h.engine.decide(second.triggers[0]!.id, { kind: 'accept', title: '修复回归', scope: 's', reason: 'r', evalId: second.evalId })
    expect(h.repo.tickets.get(derived.ticketId!)).toMatchObject({ kind: 'bug', kindSource: 'rule' })
  })
  it('classifies after the executor chose the delivery environment, and gives split parts their own kind', () => {
    const h = harness(ticket => ({ ...ticket, execution: { name: 'n', directory: 'd', assignment: '', backend: ticket.title.startsWith('看板') ? 'git' : 'p4' } }))
    const candidate = h.receive('1', 'chat', 'please')
    const decision = h.engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: '看板加分类筛选', scope: 's', reason: 'r', ticketKind: 'feature',
      parts: [{ title: '看板卡住告警', name: 'stuck-alert' }, { title: '分析昨天的失败', name: 'analyse-failures' }], evalId: candidate.evalId })
    expect(decision.ticketIds!.map(id => h.repo.tickets.get(id)!.kind)).toEqual(['feature', 'self', 'inquiry'])
  })
})
