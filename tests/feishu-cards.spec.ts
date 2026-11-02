import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { actionValue, formNote, handleCardAction, type CardAction } from '../src/sources/feishu-cards.ts'

const PLAN_AT = '2026-09-23T00:00:00Z'
const ticket = (overrides: Partial<Ticket> = {}) => ({ id: 't1', title: 'Fix', mandate: { actor: { source: 'feishu', id: 'ou_1' } },
  plan: { text: '现象：x', at: PLAN_AT, waiting: true }, ...overrides }) as unknown as Ticket

function harness(plan: Ticket = ticket()) {
  const cards: Record<string, { ticketId: string; planAt: string }> = { om_1: { ticketId: 't1', planAt: PLAN_AT } }
  const decidePlan = vi.fn()
  const lark = vi.fn(async (_args: string[]) => '{}')
  const ctx = { state: { get: () => cards, set: (_key: string, value: typeof cards) => { for (const id of Object.keys(cards)) delete cards[id]
    Object.assign(cards, value) } },
  tickets: { get: (id: string) => id === 't1' ? plan : undefined }, decidePlan, commands: { lark } } as unknown as SourceContext
  return { ctx, cards, decidePlan, lark }
}
const action = (overrides: Partial<CardAction> = {}): CardAction => ({ event_id: 'e1', operator_id: 'ou_1', message_id: 'om_1',
  token: 'tok', action_tag: 'button', action_value: JSON.stringify({ v: 1, decision: 'approve' }), ...overrides })

describe('reading a card action', () => {
  it('takes only the known decisions and a string note, and nothing from a malformed value', () => {
    expect(actionValue('{"decision":"revise","note":" 走 B "}')).toEqual({ decision: 'revise', note: '走 B' })
    expect(actionValue('{"decision":"delete"}')).toBeUndefined()
    expect(actionValue('nope')).toBeUndefined()
    expect(formNote('{"note":" 走 C "}')).toBe('走 C')
    expect(formNote('')).toBe('')
  })
})

describe('handling a card action', () => {
  it('approves the plan its card asked about, then replaces the card with the decision', async () => {
    const { ctx, cards, decidePlan, lark } = harness()
    await handleCardAction(ctx, action())
    expect(decidePlan).toHaveBeenCalledWith('t1', 'approve', '', 'feishu')
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
    expect(decidePlan).toHaveBeenCalledWith('t1', 'revise', '走 B，先上工具链', 'feishu')
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
