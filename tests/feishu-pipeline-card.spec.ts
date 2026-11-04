import { describe, expect, it, vi } from 'vitest'
import type { OutboundMessage, PipelineCard, Ticket } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { browserLink, pipelineResultCard, pipelineStageCard } from '../src/sources/feishu-card.ts'
import { formChoices, handleCardAction, pipelineActionOf, type CardAction } from '../src/sources/feishu-cards.ts'
import { sendFeishu } from '../src/sources/feishu-channel.ts'

type Element = Record<string, unknown> & { tag: string; elements?: Element[]; columns?: { elements: Element[] }[] }
const flat = (elements: Element[]): Element[] => elements.flatMap(element => [element, ...flat(element.elements ?? []),
  ...flat((element.columns ?? []).flatMap(column => column.elements))])
const notice = (overrides: Partial<PipelineCard> = {}): PipelineCard => ({ ticketId: 't1'.padEnd(32, '0'), title: '修复跳跃', tone: 'waiting',
  heading: '检查已通过 · 待人工审核', lines: ['自动检查 11/11 通过'], links: [{ label: 'Swarm - 9', url: 'https://swarm/reviews/9' }], ...overrides })
const elementsOf = (card: Record<string, unknown>) => flat((card.body as { elements: Element[] }).elements)

describe('pipeline stage cards', () => {
  it('draws a coloured headline, the lines and a link button that opens the system browser', () => {
    const { card, text } = pipelineStageCard(notice(), '[Swarm - 9](https://swarm/reviews/9) 已通过，待人工审核。')
    expect((card.header as { template: string; title: { content: string } })).toMatchObject({ template: 'orange', title: { content: '检查已通过 · 待人工审核' } })
    const elements = elementsOf(card)
    expect(elements.some(element => element.tag === 'markdown' && element.content === '自动检查 11/11 通过')).toBe(true)
    const link = elements.find(element => element.tag === 'button')!
    expect((link.behaviors as { type: string; default_url: string }[])[0]).toMatchObject({ type: 'open_url',
      default_url: 'https://swarm/reviews/9?lk_jump_to_browser=true&lk_mobile_jump_to_browser=true' })
    expect(elements.some(element => element.tag === 'form')).toBe(false)
    expect(text).toContain('待人工审核')
  })
  it('offers a reviewer picker, package recipients, rerun and close only when the notice asks for them', () => {
    const { card } = pipelineStageCard(notice({ reviewers: [{ label: '张三', value: 'zhangsan' }], rerun: true }), 'x')
    const elements = elementsOf(card)
    const select = elements.find(element => element.tag === 'multi_select_static')!
    expect(select.options).toEqual([{ text: { tag: 'plain_text', content: '张三' }, value: 'zhangsan' }])
    const submit = elements.find(element => element.name === 'submit_reviewers')!
    expect(submit).toMatchObject({ form_action_type: 'submit', text: { content: '发到 Swarm' } })
    expect(elements.some(element => (element.text as { content?: string } | undefined)?.content === '重跑检查')).toBe(true)
    expect(elements.some(element => (element.text as { content?: string } | undefined)?.content === '关单')).toBe(false)
    const pkg = elementsOf(pipelineStageCard(notice({ tone: 'success', targets: [{ label: '编辑器群', value: 'oc_1' }], close: true }), 'x').card)
    expect(pkg.find(element => element.name === 'submit_send')).toBeTruthy()
    expect(pkg.find(element => (element.text as { content?: string } | undefined)?.content === '关单')?.confirm).toBeTruthy()
  })
  it('keeps a link without http as it was and does not repeat the browser switch', () => {
    expect(browserLink('feishu://applink/x')).toBe('feishu://applink/x')
    expect(browserLink('https://a/b?lk_jump_to_browser=true&q=1')).toBe('https://a/b?lk_jump_to_browser=true&q=1&lk_mobile_jump_to_browser=true')
  })
  it('replies with the card, remembers an actionable one, and falls back to the text when Feishu refuses it', async () => {
    const state: Record<string, unknown> = {}
    const lark = vi.fn(async (_args: string[]) => ({ data: { message_id: 'om_card' } }))
    const host = { commands: { lark }, state: { get: (key: string) => state[key], set: (key: string, value: unknown) => { state[key] = value } } } as never
    const message: OutboundMessage = { id: 'p1', channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
      text: '待人工审核', kind: 'reply', pipeline: notice({ reviewers: [{ label: '张三', value: 'zhangsan' }] }) }
    expect(await sendFeishu(host, message)).toBe('sent')
    const args = lark.mock.calls[0]![0]
    expect(args[args.indexOf('--msg-type') + 1]).toBe('interactive')
    expect(Object.keys(state['feishu-pipeline-cards'] as object)).toEqual(['om_card'])
    const refused = vi.fn(async (args: string[]) => { if (args.includes('interactive')) throw new Error('bad card'); return {} })
    const fallback = { commands: { lark: refused }, state: { get: () => undefined, set: () => {} } } as never
    expect(await sendFeishu(fallback, message)).toBe('sent')
    expect(refused.mock.calls.at(-1)![0]).toContain('post')
  })
})

describe('pipeline card actions', () => {
  const ticket = (overrides: Partial<Ticket> = {}) => ({ id: 't1', title: '修复跳跃', mandate: { actor: { source: 'feishu', id: 'ou_1' } },
    execution: { review: '9' }, pipeline: { state: 'blocked', at: '', submitted: { at: '' }, artifact: 'https://pkg/41.zip' }, ...overrides }) as unknown as Ticket
  function harness (current: Ticket = ticket()) {
    const cards: Record<string, unknown> = { om_p: { ticketId: 't1', at: new Date().toISOString() } }
    const families: Record<string, unknown> = { 'feishu-pipeline-cards': cards }
    const lark = vi.fn(async (_args: string[]) => '{}')
    const pipelineAction = vi.fn(async (_id: string, action: { kind: string; users?: string[] }) => ({ done: action.users ?? ['ClientBuild'] }))
    const ctx = {
      state: { get: (key: string) => families[key], set: (key: string, value: unknown) => { families[key] = value } },
      tickets: { get: (id: string) => id === 't1' ? current : undefined }, commands: { lark }, pipelineAction,
      mayActOnPipeline: (_id: string, actor: string) => actor === 'ou_1',
      pipelineChoices: () => ({ reviewers: [{ label: '张三', value: 'zhangsan' }], targets: [{ label: '编辑器群', value: 'oc_9' }, { label: '李四', value: 'ou_4' }] }),
    } as unknown as SourceContext
    return { ctx, lark, pipelineAction, families }
  }
  const click = (overrides: Partial<CardAction>): CardAction => ({ event_id: 'e', operator_id: 'ou_1', message_id: 'om_p', token: 'tok', ...overrides })
  const updated = (lark: ReturnType<typeof vi.fn>) => JSON.parse(String((lark.mock.calls.at(-1)![0] as string[]).at(-1))) as { card: { header: { title: { content: string } } } }

  it('reads the action from the button value or the submit button name, and the picked values', () => {
    expect(pipelineActionOf({ action_value: JSON.stringify({ pipeline: 'close' }) })).toBe('close')
    expect(pipelineActionOf({ action_name: 'submit_send' })).toBe('send')
    expect(pipelineActionOf({ action_value: '{"decision":"approve"}' })).toBeUndefined()
    expect(formChoices('{"choice":["a"," b "]}')).toEqual(['a', 'b'])
    expect(formChoices('{"choice":"a"}')).toEqual(['a'])
    expect(formChoices('nope')).toEqual([])
  })
  it('adds the picked reviewers on Swarm and replaces the card with who was added', async () => {
    const h = harness()
    await handleCardAction(h.ctx, click({ action_name: 'submit_reviewers', form_value: '{"choice":["zhangsan"]}' }))
    expect(h.pipelineAction).toHaveBeenCalledWith('t1', { kind: 'reviewers', users: ['zhangsan'] })
    expect(updated(h.lark).card.header.title.content).toBe('已发到 Swarm · 待审核')
  })
  it('sends the package to each picked person or chat, ignoring ones not listed, and closes on 关单', async () => {
    const h = harness()
    await handleCardAction(h.ctx, click({ action_name: 'submit_send', form_value: '{"choice":["oc_9","ou_4","oc_evil"]}' }))
    const sends = h.lark.mock.calls.map(call => call[0] as string[]).filter(args => args[1] === '+messages-send')
    expect(sends.map(args => [args[2], args[3]])).toEqual([['--chat-id', 'oc_9'], ['--user-id', 'ou_4']])
    expect(JSON.parse(sends[0]![sends[0]!.indexOf('--content') + 1]!).zh_cn.content[0][0].text).toContain('https://pkg/41.zip')
    await handleCardAction(h.ctx, click({ action_value: JSON.stringify({ v: 1, pipeline: 'close', ticket: 't1' }) }))
    expect(h.pipelineAction).toHaveBeenCalledWith('t1', { kind: 'close' })
    expect(h.families['feishu-pipeline-cards']).toEqual({})
  })
  it('ignores a click by someone else, and says why when Swarm refused', async () => {
    const h = harness()
    await handleCardAction(h.ctx, click({ operator_id: 'ou_2', action_value: JSON.stringify({ pipeline: 'close' }) }))
    expect(h.pipelineAction).not.toHaveBeenCalled()
    h.pipelineAction.mockRejectedValueOnce(new Error('Swarm refused to add reviewers: unknown participant id'))
    await handleCardAction(h.ctx, click({ action_name: 'submit_reviewers', form_value: '{"choice":["zhangsan"]}' }))
    expect(updated(h.lark).card.header.title.content).toBe('没有做成')
  })
  it('answers a click on an ended ticket without acting', async () => {
    const h = harness(ticket({ ended: { at: '', by: 'human', outcome: 'completed' } }))
    await handleCardAction(h.ctx, click({ action_value: JSON.stringify({ pipeline: 'rerun' }) }))
    expect(h.pipelineAction).not.toHaveBeenCalled()
    expect(updated(h.lark).card.header.title.content).toBe('已处理 · 工单已结束')
    expect(pipelineResultCard({ id: 't1', title: 'x' }, { ok: true, heading: 'h', line: 'l' }).text).toBe('h：l')
  })
})
