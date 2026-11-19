import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { actionValue, attentionValue, formNote, grillAnswersOf, handleCardAction, priorityValue, type CardAction } from '../src/sources/feishu-cards.ts'

const PLAN_AT = '2026-09-23T00:00:00Z'
const ticket = (overrides: Partial<Ticket> = {}) => ({ id: 't1', title: 'Fix', mandate: { actor: { source: 'feishu', id: 'ou_1' } },
  plan: { text: '现象：x', at: PLAN_AT, waiting: true }, ...overrides }) as unknown as Ticket
type CardRef = { ticketId: string; planAt?: string; attentionId?: string; at?: string; askAt?: string; grillId?: string }
const ASKED = { id: 'att-1', question: '先上 A 还是先上 B？', options: ['先上 A', '先上 B'] }

function harness(plan: Ticket = ticket(), allowed: string[] = ['ou_1']) {
  const cards: Record<string, CardRef> = { om_1: { ticketId: 't1', planAt: PLAN_AT } }
  const asked: Record<string, CardRef> = { om_2: { ticketId: 't1', attentionId: 'att-1', at: PLAN_AT } }
  const priority: Record<string, CardRef> = { om_3: { ticketId: 't1', askAt: PLAN_AT } }
  const grill: Record<string, CardRef> = { om_4: { ticketId: 't1', grillId: 'g1', at: PLAN_AT } }
  const decidePlan = vi.fn()
  const answerAttention = vi.fn(() => plan)
  const answerGrill = vi.fn((_id: string, _grillId: string, answers: Record<string, number>) => ({ ...plan,
    grill: plan.grill ? { ...plan.grill, answeredAt: '2026-09-23T00:01:00Z',
      answers: plan.grill.questions.map(question => ({ questionId: question.id, option: answers[question.id]!, at: '2026-09-23T00:01:00Z', via: 'feishu' as const })) } : undefined }))
  const decidePriority = vi.fn(() => plan)
  const mayDecidePriority = vi.fn((_id: string, actor: string) => actor === 'ou_1')
  // The real rule: a Feishu ticket's own actor, else a person the Policy allows on Feishu (see source-context).
  const mayActOnCard = vi.fn((_id: string, actor: string) =>
    plan.mandate.actor.source === 'feishu' ? actor === plan.mandate.actor.id : allowed.includes(actor))
  const lark = vi.fn(async (_args: string[]) => '{}')
  const families: Record<string, unknown> = { 'feishu-plan-cards': cards, 'feishu-attention-cards': asked, 'feishu-priority-cards': priority,
    'feishu-grill-cards': grill }
  const ctx = {
    state: {
      get: (key: string) => families[key],
      set: (key: string, value: unknown) => {
        const target = key === 'feishu-plan-cards' ? cards : key === 'feishu-attention-cards' ? asked : key === 'feishu-priority-cards' ? priority
          : key === 'feishu-grill-cards' ? grill : undefined
        if (!target) return
        for (const id of Object.keys(target)) delete target[id]
        Object.assign(target, value)
      },
    },
    tickets: { get: (id: string) => id === 't1' ? plan : undefined }, decidePlan, answerAttention, answerGrill, decidePriority, mayDecidePriority, mayActOnCard,
    commands: { lark },
  } as unknown as SourceContext
  return { ctx, cards, asked, priority, grill, decidePlan, answerAttention, answerGrill, decidePriority, mayDecidePriority, mayActOnCard, lark }
}
const action = (overrides: Partial<CardAction> = {}): CardAction => ({ event_id: 'e1', operator_id: 'ou_1', message_id: 'om_1',
  token: 'tok', action_tag: 'button', action_value: JSON.stringify({ v: 1, decision: 'approve' }), ...overrides })
const attentionAction = (overrides: Partial<CardAction> = {}): CardAction => action({ message_id: 'om_2', action_tag: 'button',
  action_value: JSON.stringify({ v: 1, attention: 'att-1', choice: 0 }), ...overrides })

describe('reading a card action', () => {
  it('takes only the known decisions and a string note, and nothing from a malformed value', () => {
    expect(actionValue('{"decision":"revise","note":" 走 B "}')).toEqual({ decision: 'revise', note: '走 B' })
    expect(actionValue('{"decision":"approve","choice":1}')).toEqual({ decision: 'approve', note: '', choice: 1 })
    expect(actionValue('{"decision":"approve","choice":-1}')).toEqual({ decision: 'approve', note: '' })
    expect(actionValue('{"decision":"delete"}')).toBeUndefined()
    expect(actionValue('nope')).toBeUndefined()
    expect(actionValue('{"v":1,"back":true}')).toEqual({ back: true })
    expect(attentionValue('{"attention":"att-1","choice":1}')).toEqual({ attentionId: 'att-1', choice: 1 })
    expect(attentionValue('{"decision":"approve"}')).toBeUndefined()
    expect(attentionValue('{"attention":"att-1"}')).toBeUndefined()
    expect(attentionValue('{"attention":"att-1","choice":-1}')).toBeUndefined()
    expect(priorityValue('{"priority":"P2"}')).toEqual({ level: 'P2' })
    expect(priorityValue('{"priority":"p2"}')).toBeUndefined()
    expect(priorityValue('{"priority":"P9"}')).toBeUndefined()
    expect(formNote('{"note":" 走 C "}')).toBe('走 C')
    expect(formNote('{"note":"第一行\\n第二行\\n第三行\\n"}')).toBe('第一行\n第二行\n第三行')
    expect(formNote('')).toBe('')
  })
})

describe('handling a card action', () => {
  it('approves the plan its card asked about, then replaces the card with the decision', async () => {
    const { ctx, cards, decidePlan, lark } = harness()
    await handleCardAction(ctx, action())
    expect(decidePlan).toHaveBeenCalledWith('t1', 'approve', '', 'feishu', '')
    expect(cards.om_1).toBeUndefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(data.token).toBe('tok')
    expect(JSON.stringify(data.card)).toContain('已通过')
  })
  it('turns 改一下 into a form, and reads the form submit as the new direction', async () => {
    const { ctx, decidePlan, lark } = harness()
    await handleCardAction(ctx, action({ action_value: JSON.stringify({ v: 1, decision: 'revise' }) }))
    expect(decidePlan).not.toHaveBeenCalled()
    const form = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!).card
    expect(JSON.stringify(form)).toContain('"tag":"form"')
    await handleCardAction(ctx, action({ action_value: JSON.stringify({ v: 1, decision: 'revise' }),
      form_value: JSON.stringify({ note: '走 B，先上工具链' }) }))
    expect(decidePlan).toHaveBeenCalledWith('t1', 'revise', '走 B，先上工具链', 'feishu', '')
  })
  it('returns to the plan card from the form without deciding the plan', async () => {
    const { ctx, cards, decidePlan, lark } = harness()
    await handleCardAction(ctx, action({ action_value: JSON.stringify({ v: 1, back: true }) }))
    expect(decidePlan).not.toHaveBeenCalled()
    expect(cards.om_1).toBeDefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('待确认')
  })
  it('records the choice label, and a revise choice that carries its note decides without the form', async () => {
    const plan = ticket({ plan: { text: '现象：x', at: PLAN_AT, waiting: true, options: [
      { label: '先上 A', decision: 'approve', note: '先上 A，再补 B' },
      { label: '先上 B', decision: 'revise', note: '走 B，先上工具链' },
    ] } })
    const { ctx, decidePlan, lark } = harness(plan)
    const value = JSON.stringify({ v: 1, decision: 'revise', choice: 1 })
    await handleCardAction(ctx, action({ action_value: value }))
    expect(decidePlan).toHaveBeenCalledWith('t1', 'revise', '走 B，先上工具链', 'feishu', '先上 B')
    expect(lark).toHaveBeenCalledTimes(1)
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('先上 B')
  })
  it('reads a form submit that carries no button decision value', async () => {
    const { ctx, decidePlan } = harness()
    await handleCardAction(ctx, action({ action_tag: 'form_submit', action_value: undefined,
      form_value: JSON.stringify({ note: '走 B，先上工具链' }) }))
    expect(decidePlan).toHaveBeenCalledWith('t1', 'revise', '走 B，先上工具链', 'feishu', '')
  })
  it('answers a card whose plan no longer waits without touching the ticket, and forgets the card', async () => {
    const { ctx, cards, decidePlan, lark } = harness(ticket({ plan: { text: '现象：x', at: PLAN_AT, approved: { at: PLAN_AT } } }))
    await handleCardAction(ctx, action())
    expect(decidePlan).not.toHaveBeenCalled()
    expect(cards.om_1).toBeUndefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('已处理')
  })
  it('ignores a click from someone other than the ticket actor', async () => {
    const { ctx, decidePlan, mayActOnCard, lark } = harness()
    await handleCardAction(ctx, action({ operator_id: 'ou_2' }))
    expect(mayActOnCard).toHaveBeenCalledWith('t1', 'ou_2')
    expect(decidePlan).not.toHaveBeenCalled()
    expect(lark).not.toHaveBeenCalled()
  })
  it('lets a person the Policy allows decide a plan card for a ticket another Source started', async () => {
    // The panel, GitHub and TAPD have no Feishu actor, so the Source opens the ticket a topic and there the Policy's
    // allowed people decide its cards.
    const web = ticket({ mandate: { strength: 'explicit', basis: { via: 'listed' }, actor: { source: 'web', id: 'operator' } } as Ticket['mandate'] })
    const { ctx, cards, decidePlan, mayActOnCard, lark } = harness(web, ['ou_2'])
    await handleCardAction(ctx, action({ operator_id: 'ou_2' }))
    expect(mayActOnCard).toHaveBeenCalledWith('t1', 'ou_2')
    expect(decidePlan).toHaveBeenCalledWith('t1', 'approve', '', 'feishu', '')
    expect(cards.om_1).toBeUndefined()
    expect(lark).toHaveBeenCalledTimes(1)
  })
})

describe('handling a priority card action', () => {
  const priorityAction = (overrides: Partial<CardAction> = {}): CardAction => action({ message_id: 'om_3',
    action_value: JSON.stringify({ v: 1, priority: 'P2' }), ...overrides })
  it('records the clicked level as the person\'s, replaces the card and drops the mapping', async () => {
    const { ctx, priority, decidePriority, mayDecidePriority, lark } = harness()
    await handleCardAction(ctx, priorityAction())
    expect(mayDecidePriority).toHaveBeenCalledWith('t1', 'ou_1')
    expect(decidePriority).toHaveBeenCalledWith('t1', 'P2', 'ou_1', 'feishu')
    expect(priority.om_3).toBeUndefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('已记录')
  })
  it('ignores a click from someone the Policy does not let decide, and an unknown level changes nothing', async () => {
    const { ctx, decidePriority, lark } = harness()
    await handleCardAction(ctx, priorityAction({ operator_id: 'ou_2' }))
    expect(decidePriority).not.toHaveBeenCalled()
    expect(lark).not.toHaveBeenCalled()
    await handleCardAction(ctx, priorityAction({ action_value: JSON.stringify({ v: 1, priority: 'P9' }) }))
    expect(decidePriority).not.toHaveBeenCalled()
  })
})

describe('handling a question card action', () => {
  it('records the clicked choice as the person\'s answer and closes the question', async () => {
    const { ctx, asked, answerAttention, lark } = harness(ticket({ attention: ASKED }))
    await handleCardAction(ctx, attentionAction())
    expect(answerAttention).toHaveBeenCalledWith('t1', 'att-1', '先上 A')
    expect(asked.om_2).toBeUndefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('已收到你的答复')
    expect(JSON.stringify(data.card)).toContain('先上 A')
  })
  it('answers a question that was already handled with the stale card, and forgets the card', async () => {
    const { ctx, asked, answerAttention, lark } = harness(ticket())
    await handleCardAction(ctx, attentionAction())
    expect(answerAttention).not.toHaveBeenCalled()
    expect(asked.om_2).toBeUndefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('已处理')
  })
  it('ignores a question card click from someone other than the ticket actor', async () => {
    const { ctx, answerAttention, lark } = harness(ticket({ attention: ASKED }))
    await handleCardAction(ctx, attentionAction({ operator_id: 'ou_2' }))
    expect(answerAttention).not.toHaveBeenCalled()
    expect(lark).not.toHaveBeenCalled()
  })
  it('lets a person the Policy allows answer a question card for a ticket another Source started', async () => {
    const web = ticket({ mandate: { strength: 'explicit', basis: { via: 'listed' }, actor: { source: 'tapd', id: '王怀扬' } } as Ticket['mandate'],
      attention: ASKED })
    const { ctx, asked, answerAttention, mayActOnCard } = harness(web, ['ou_2'])
    await handleCardAction(ctx, attentionAction({ operator_id: 'ou_2' }))
    expect(mayActOnCard).toHaveBeenCalledWith('t1', 'ou_2')
    expect(answerAttention).toHaveBeenCalledWith('t1', 'att-1', '先上 A')
    expect(asked.om_2).toBeUndefined()
  })
})

describe('handling a structured grill submit', () => {
  const GRILL = { id: 'g1', at: PLAN_AT, answers: [], questions: [
    { id: 'q1', title: '状态放哪', question: '放 ActionState 还是 ANS 实例？', options: ['ActionState', 'ANS 实例'], recommended: 0 },
    { id: 'q2', title: '序列化时机', question: '只在需要时序列化？', options: ['是', '否'], recommended: 0 },
  ] }
  const submit = (overrides: Partial<CardAction> = {}): CardAction => action({ message_id: 'om_4', action_tag: 'form_submit',
    action_value: undefined, form_value: JSON.stringify({ q1: '0', q2: '1' }), ...overrides })
  it('records every answer together and replaces the card with what was chosen', async () => {
    const { ctx, grill, answerGrill, lark } = harness(ticket({ grill: GRILL }))
    await handleCardAction(ctx, submit())
    expect(answerGrill).toHaveBeenCalledWith('t1', 'g1', { q1: 0, q2: 1 }, 'feishu')
    expect(grill.om_4).toBeUndefined()
    const data = JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!)
    expect(JSON.stringify(data.card)).toContain('已收齐')
    expect(JSON.stringify(data.card)).toContain('状态放哪：ActionState')
  })
  it('keeps the form and records nothing when a question is missing, and treats an answered grill as handled', async () => {
    const { ctx, answerGrill, lark } = harness(ticket({ grill: GRILL }))
    await handleCardAction(ctx, submit({ form_value: JSON.stringify({ q1: '0' }) }))
    expect(answerGrill).not.toHaveBeenCalled()
    expect(lark).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(JSON.parse((lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!).card)).toContain('还差一个选择')

    const answered = harness(ticket({ grill: { ...GRILL, answeredAt: '2026-09-23T00:01:00Z' } }))
    await handleCardAction(answered.ctx, submit())
    expect(answered.answerGrill).not.toHaveBeenCalled()
    expect(answered.grill.om_4).toBeUndefined()
    expect(JSON.stringify(JSON.parse((answered.lark.mock.calls[0]![0] as string[])[(answered.lark.mock.calls[0]![0] as string[]).indexOf('--data') + 1]!).card)).toContain('已处理')
  })
  it('reads only a complete set of real option values', () => {
    const questions = GRILL.questions
    expect(grillAnswersOf(JSON.stringify({ q1: '0', q2: '1' }), questions)).toEqual({ q1: 0, q2: 1 })
    expect(grillAnswersOf(JSON.stringify({ q1: '0', q2: '9' }), questions)).toBeUndefined()
    expect(grillAnswersOf(JSON.stringify({ q1: '0' }), questions)).toBeUndefined()
    expect(grillAnswersOf('nope', questions)).toBeUndefined()
  })
})
