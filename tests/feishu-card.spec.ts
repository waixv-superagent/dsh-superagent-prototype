import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { attentionCard, attentionResolvedCard, attentionStaleCard, messageIdOf, messageUrlOf, planCard, resolvedCard, reviseCard, sendCard,
  staleCard } from '../src/sources/feishu-card.ts'

const PLAN = `现象：翻页时头像闪一下
代码线：Source/UI/AvatarList.cpp:42 — 复用控件时清空了纹理
资产线：已排除 — 头像纹理本身没有更新
配置线：已排除 — 该界面没有相关 cvar
修复锚点：Source/UI/AvatarList.cpp，1 个文件
影响面：只影响该列表，冲突风险低
验证方案：基线 3 例 → 改后 3 例
预算：编译 1 次，约 20 分钟`
const ticket = { id: 'a'.repeat(32), title: '翻页头像闪烁' } as Ticket
type Element = Record<string, unknown> & { tag: string; elements?: Element[]; columns?: { elements: Element[] }[] }

describe('P1 plan card', () => {
  it('leads with the finding, the fix and the cost, folds the evidence, and offers three buttons', () => {
    const { card } = planCard(ticket, { text: PLAN, deadline: '2026-09-24T00:00:00Z' })
    expect(card.schema).toBe('2.0')
    const header = card.header as { title: { content: string }; subtitle: { content: string }; template: string }
    // The chat list previews a card by its header title, so the title keeps the kind's prefix and adds what this card asks.
    expect(header.title.content).toContain('待确认')
    expect(header.title.content).toContain('开工')
    expect(header.template).toBe('blue')
    const elements = (card.body as { elements: Element[] }).elements
    const front = JSON.stringify(elements)
    expect(front).toContain('现象')
    expect(front).toContain('修复锚点')
    expect(front).toContain('影响面')
    expect(front).toContain('预算')
    // The evidence is behind the fold; only the panel's own title names the lines.
    expect(front).not.toContain('代码线：')
    const panel = elements.find(item => item.tag === 'collapsible_panel')!
    expect(panel.expanded).toBe(false)
    expect(JSON.stringify(panel)).toContain('代码线')
    expect(JSON.stringify(panel)).toContain('验证方案')
    const buttons = elements.filter(item => item.tag === 'column_set').at(-1)!.columns!
      .map(column => column.elements[0] as unknown as { text: { content: string }; behaviors: { value: { decision: string } }[] })
    expect(buttons.map(button => button.text.content)).toEqual(['通过', '改一下', '停'])
    expect(buttons.map(button => button.behaviors[0]!.value.decision)).toEqual(['approve', 'revise', 'stop'])
    expect(front).toContain('不答会自动停')
    expect(front).toContain('通过后')
    expect(elements.some(item => item.tag === 'hr')).toBe(true)
  })
  it('shows the plan key lines in full and folds only the evidence', () => {
    const long = `${'复用控件时清空了纹理，'.repeat(12)}所以闪烁。第二句也在正文里。`
    const plan = PLAN.replace('现象：翻页时头像闪一下', `现象：${long}`)
    const { card, text } = planCard({ id: ticket.id, title: '标题'.repeat(40) }, { text: plan })
    const elements = (card.body as { elements: Element[] }).elements
    const panel = elements.find(item => item.tag === 'collapsible_panel')!
    const outside = JSON.stringify(elements.filter(item => item !== panel))
    expect(outside).toContain('第二句也在正文里。')
    expect(outside).not.toContain('…')
    expect(text).toContain('第二句也在正文里。')
    // The fold carries the evidence, not a second copy of the key lines.
    expect(JSON.stringify(panel)).toContain('**代码线**')
    expect(JSON.stringify(panel)).toContain('**验证方案**')
    expect(JSON.stringify(panel)).not.toContain('第二句也在正文里。')
    const subtitle = (card.header as { subtitle: { content: string } }).subtitle.content
    expect(Array.from(subtitle.split(' · 工单')[0]!).length).toBeLessThanOrEqual(40)
    // The card's own wording adds nothing cmd.exe would re-read.
    expect(JSON.stringify(planCard(ticket, { text: PLAN, deadline: '2026-09-24T00:00:00Z' }).card)).not.toMatch(/[<>&|^!%]/)
  })
  it('shows a short line whole, without an ellipsis', () => {
    const { card } = planCard(ticket, { text: PLAN })
    const front = JSON.stringify((card.body as { elements: Element[] }).elements)
    expect(front).toContain('**现象**\\n翻页时头像闪一下')
    expect(front).toContain('**修复锚点**\\nSource/UI/AvatarList.cpp，1 个文件')
    expect(front).toContain('**预算**\\n编译 1 次，约 20 分钟')
  })
  it('renders the worker\'s own context sections when the conversation calls for another shape, still in the same card style', () => {
    const sections = [
      { label: '目标', text: '翻页时头像不再闪' },
      { label: '取舍', text: '复用现成控件，不加缓存层', fold: true },
    ]
    const message = planCard(ticket, { text: PLAN, question: '按这个取舍开工？', sections })
    const elements = (message.card.body as { elements: Element[] }).elements
    const front = JSON.stringify(elements)
    expect(front).toContain('**目标**\\n翻页时头像不再闪')
    expect(front).not.toContain('**现象**')
    const panel = elements.find(item => item.tag === 'collapsible_panel')!
    expect(JSON.stringify(panel)).toContain('补充 · 取舍')
    expect(JSON.stringify(panel)).toContain('复用现成控件，不加缓存层')
    expect(message.text).toContain('目标：翻页时头像不再闪')
    expect(message.text).toContain('取舍：复用现成控件，不加缓存层')
    expect(message.text).not.toContain('代码线：')
  })
  it('carries a brief text version for the case Feishu refuses the card, pointing at the panel for the evidence', () => {
    const { text } = planCard(ticket, { text: PLAN })
    for (const label of ['现象', '修复锚点', '影响面', '预算']) expect(text).toContain(label)
    expect(text).not.toContain('代码线：')
    expect(text).toContain('工单面板')
    expect(text).toContain('回 1 通过')
  })
  it('keeps < and > out of the command line, where cmd.exe would read them as redirections', () => {
    const plan = PLAN.replace('现象：翻页时头像闪一下', '现象：a < b 且构建点 N>=12345')
    const message = planCard({ id: ticket.id, title: '条件 a<b 的工单' }, { text: plan, deadline: '2026-09-24T00:00:00Z' })
    expect(JSON.stringify(message.card)).not.toMatch(/[<>]/)
    expect(message.text).not.toMatch(/[<>]/)
    expect(JSON.stringify(message.card)).toContain('a ＜ b')
  })
  it('asks for a new direction in a form that keeps the original question and plan', () => {
    const revise = reviseCard(ticket, { text: PLAN, question: '先上 A 还是先上 B？' }).card
    const body = JSON.stringify(revise)
    expect(body).toContain('"tag":"form"')
    expect(body).toContain('"name":"note"')
    expect(body).toContain('"input_type":"text"')
    expect(body).not.toContain('multiline_text')
    expect(body).toContain('submit_revise')
    expect(body).toContain('先上 A 还是先上 B？')
    expect(body).toContain('原方案')
    expect(body).toContain('返回方案')
    expect(body).toContain('贴图')
    expect(JSON.stringify(resolvedCard(ticket, 'approve').card)).toContain('已通过')
    expect(JSON.stringify(resolvedCard(ticket, 'revise', '走 B').card)).toContain('走 B')
    expect(JSON.stringify(resolvedCard(ticket, 'stop').card)).toContain('已停止')
    expect(JSON.stringify(staleCard(ticket).card)).toContain('已处理')
  })
  it('asks the worker question with the choices it wrote, and records the clicked label', () => {
    const message = planCard(ticket, { text: PLAN, question: '先上 A 还是先上 B？', options: [
      { label: '先上 A', decision: 'approve', note: '先上 A，再补 B' },
      { label: '先上 B', decision: 'revise', note: '走 B，先上工具链' },
      { label: '先不动', decision: 'stop' },
    ] })
    const elements = (message.card.body as { elements: Element[] }).elements
    expect(JSON.stringify(elements)).toContain('先上 A 还是先上 B？')
    const row = elements.filter(item => item.tag === 'column_set').at(-1)!
    const buttons = row.columns!.map(column => column.elements[0] as unknown as { text: { content: string }; behaviors: { value: Record<string, unknown> }[] })
    expect(buttons.map(button => button.text.content)).toEqual(['先上 A', '先上 B', '先不动'])
    expect(buttons[0]!.behaviors[0]!.value).toEqual({ v: 1, decision: 'approve', choice: 0 })
    expect(buttons[2]!.behaviors[0]!.value).toEqual({ v: 1, decision: 'stop', choice: 2 })
    expect(row.flex_mode).toBe('trisect')
    expect(message.text).toContain('选项：先上 A ｜ 先上 B ｜ 先不动')
    expect(JSON.stringify(resolvedCard(ticket, 'approve', '', '先上 A').card)).toContain('你选的是「先上 A」')
  })
})
describe('question card', () => {
  it('puts a worker question and its choices on a card whose buttons answer it', () => {
    const { card, text } = attentionCard('先上 A 还是先上 B？', 'att-1', ['先上 A', '先上 B'])
    const elements = (card.body as { elements: Element[] }).elements
    expect(JSON.stringify(elements)).toContain('先上 A 还是先上 B？')
    const row = elements.filter(item => item.tag === 'column_set').at(-1)!
    expect(row.flex_mode).toBe('bisect')
    const buttons = row.columns!.map(column => column.elements[0] as unknown as { text: { content: string }; behaviors: { value: Record<string, unknown> }[] })
    expect(buttons.map(button => button.text.content)).toEqual(['先上 A', '先上 B'])
    expect(buttons[0]!.behaviors[0]!.value).toEqual({ v: 1, attention: 'att-1', choice: 0 })
    expect(text).toContain('可选项：1. 先上 A')
    expect(JSON.stringify(attentionResolvedCard('先上 A 还是先上 B？', '先上 A', ticket.id).card)).toContain('你选了：**先上 A**')
    expect(JSON.stringify(attentionStaleCard(ticket.id).card)).toContain('已处理')
  })
  it('adds the worker\'s context sections to a question card, with its choices unchanged', () => {
    const { card, text } = attentionCard('这个取舍能不能定？', 'att-1', ['能定', '再改改'], 'a'.repeat(32), [
      { label: '现状', text: '两个方案都能过测试' },
      { label: '代价', text: '复用控件少一个缓存层', fold: true },
    ])
    const elements = (card.body as { elements: Element[] }).elements
    const front = JSON.stringify(elements.filter(item => item.tag !== 'collapsible_panel'))
    expect(front).toContain('**现状**\\n两个方案都能过测试')
    expect(front).not.toContain('**代价**')
    const panel = elements.find(item => item.tag === 'collapsible_panel')!
    expect(JSON.stringify(panel)).toContain('**代价**')
    const row = elements.filter(item => item.tag === 'column_set').at(-1)!
    expect(row.columns).toHaveLength(2)
    expect(text).toContain('现状：两个方案都能过测试')
    expect(text).toContain('可选项：1. 能定')
  })
})
describe('sending a card', () => {
  it('posts an interactive card with its idempotency key and returns the message id', async () => {
    const lark = vi.fn(async (_args: string[]) => JSON.stringify({ data: { message_id: 'om_1' } }))
    const id = await sendCard({ commands: { lark } as never }, 'oc_1', planCard(ticket, { text: PLAN }), 'plan-1')
    expect(id).toBe('om_1')
    const args = lark.mock.calls[0]![0] as string[]
    expect(args.slice(0, 6)).toEqual(['im', '+messages-send', '--chat-id', 'oc_1', '--msg-type', 'interactive'])
    expect(args).toContain('--content')
    expect(args).toContain('--idempotency-key')
    const card = JSON.parse(args[args.indexOf('--content') + 1]!) as { schema: string; body: unknown }
    expect(card.schema).toBe('2.0')
    expect(card).toHaveProperty('body')
  })
  it('falls back to the markdown text when Feishu refuses the card, so the question still reaches the person', async () => {
    const lark = vi.fn(async (args: string[]) => {
      if (args[args.indexOf('--msg-type') + 1] === 'interactive') throw new Error('bad card')
      return '{"data":{"message_id":"om_text"}}'
    })
    const id = await sendCard({ commands: { lark } as never }, 'oc_1', planCard(ticket, { text: PLAN }), 'plan-1')
    expect(id).toBe('om_text')
    expect(lark).toHaveBeenCalledTimes(2)
    const retry = lark.mock.calls[1]![0] as string[]
    expect(retry).toContain('--content')
    expect(retry[retry.indexOf('--msg-type') + 1]).toBe('post')
    expect(JSON.parse(retry[retry.indexOf('--content') + 1]!).zh_cn.content[0][0].text).toContain('回 1 通过')
  })
  it('replies in the ticket thread when the card belongs to one', async () => {
    const lark = vi.fn(async (_args: string[]) => JSON.stringify({ data: { message_id: 'om_2' } }))
    const id = await sendCard({ commands: { lark } as never }, 'oc_1', planCard(ticket, { text: PLAN }), 'plan-2', 'om_root')
    expect(id).toBe('om_2')
    const args = lark.mock.calls[0]![0] as string[]
    expect(args.slice(0, 6)).toEqual(['im', '+messages-reply', '--message-id', 'om_root', '--msg-type', 'interactive'])
    expect(args).toContain('--reply-in-thread')
    expect(args).toContain('--idempotency-key')
    expect(args).not.toContain('--chat-id')
  })
  it('reads a message id from an object or its JSON text, and none where there is none', () => {
    expect(messageIdOf({ data: { message_id: 'om_2' } })).toBe('om_2')
    expect(messageIdOf('{"message_id":"om_3"}')).toBe('om_3')
    expect(messageIdOf('not json')).toBeUndefined()
    expect(messageIdOf({})).toBeUndefined()
  })
  it('reads a link that opens the message itself, from either envelope', () => {
    expect(messageUrlOf({ data: { messages: [{ message_app_link: 'https://applink.feishu.cn/x' }] } })).toBe('https://applink.feishu.cn/x')
    expect(messageUrlOf('{"messages":[{"message_app_link":"https://applink.feishu.cn/y"}]}')).toBe('https://applink.feishu.cn/y')
    expect(messageUrlOf({ data: { messages: [] } })).toBeUndefined()
    expect(messageUrlOf('not json')).toBeUndefined()
  })
})

