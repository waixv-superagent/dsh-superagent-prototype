import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { actionValue, attentionValue, formNote, handleCardAction, type CardAction } from '../src/sources/feishu-cards.ts'

const PLAN_AT = '2026-09-23T00:00:00Z'
const ticket = (overrides: Partial<Ticket> = {}) => ({ id: 't1', title: 'Fix', mandate: { actor: { source: 'feishu', id: 'ou_1' } },
  plan: { text: '现象：x', at: PLAN_AT, waiting: true }, ...overrides }) as unknown as Ticket
type CardRef = { ticketId: string; planAt?: string; attentionId?: string; at?: string }
const ASKED = { id: 'att-1', question: '先上 A 还是先上 B？', options: ['先上 A', '先上 B'] }

function harness(plan: Ticket = ticket()) {
  const cards: Record<string, CardRef> = { om_1: { ticketId: 't1', planAt: PLAN_AT } }
  const asked: Record<string, CardRef> = { om_2: { ticketId: 't1', attentionId: 'att-1', at: PLAN_AT } }
  const decidePlan = vi.fn()
  const answerAttention = vi.fn(() => plan)
  const lark = vi.fn(async (_args: string[]) => '{}')
  const families: Record<string, unknown> = { 'feishu-plan-cards': cards, 'feishu-attention-cards': asked }
  const ctx = {
    state: {
      get: (key: string) => families[key],
      set: (key: string, value: unknown) => {
        const target = key === 'feishu-plan-cards' ? cards : key === 'feishu-attention-cards' ? asked : undefined
        if (!target) return
        for (const id of Object.keys(target)) delete target[id]
        Object.assign(target, value)
      },
    },
    tickets: { get: (id: string) => id === 't1' ? plan : undefined }, decidePlan, answerAttention, commands: { lark },
  } as unknown as SourceContext
  return { ctx, cards, asked, decidePlan, answerAttention, lark }
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
    expect(formNote('{"note":" 走 C "}')).toBe('走 C')
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
    const { ctx, decidePlan, lark } = harness()
    await handleCardAction(ctx, action({ operator_id: 'ou_2' }))
    expect(decidePlan).not.toHaveBeenCalled()
    expect(lark).not.toHaveBeenCalled()
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
})
