import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { messageIdOf, messageUrlOf, planCard, resolvedCard, reviseCard, sendCard, staleCard } from '../src/sources/feishu-card.ts'

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
    const { card } = planCard(ticket, PLAN, '2026-09-24T00:00:00Z')
    expect(card.schema).toBe('2.0')
    const header = card.header as { title: { content: string }; template: string }
    expect(header.title.content).toContain('待确认')
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
    const buttons = elements.find(item => item.tag === 'column_set')!.columns!
      .map(column => column.elements[0] as unknown as { text: { content: string }; behaviors: { value: { decision: string } }[] })
    expect(buttons.map(button => button.text.content)).toEqual(['通过', '改一下', '停'])
    expect(buttons.map(button => button.behaviors[0]!.value.decision)).toEqual(['approve', 'revise', 'stop'])
    expect(front).toContain('不答会自动停')
    expect(front).toContain('通过后')
  })
  it('carries a brief text version for the case Feishu refuses the card, pointing at the panel for the evidence', () => {
    const { text } = planCard(ticket, PLAN)
    for (const label of ['现象', '修复锚点', '影响面', '预算']) expect(text).toContain(label)
    expect(text).not.toContain('代码线：')
    expect(text).toContain('工单面板')
    expect(text).toContain('回 1 通过')
  })
  it('keeps < and > out of the command line, where cmd.exe would read them as redirections', () => {
    const plan = PLAN.replace('现象：翻页时头像闪一下', '现象：a < b 且构建点 N>=12345')
    const message = planCard({ id: ticket.id, title: '条件 a<b 的工单' }, plan, '2026-09-24T00:00:00Z')
    expect(JSON.stringify(message.card)).not.toMatch(/[<>]/)
    expect(message.text).not.toMatch(/[<>]/)
    expect(JSON.stringify(message.card)).toContain('a ＜ b')
  })
  it('asks for a new direction in a form, and records an answer on the card', () => {
    const revise = reviseCard(ticket).card
    expect(JSON.stringify(revise)).toContain('"tag":"form"')
    expect(JSON.stringify(revise)).toContain('"name":"note"')
    expect(JSON.stringify(revise)).toContain('submit_revise')
    expect(JSON.stringify(resolvedCard(ticket, 'approve').card)).toContain('已通过')
    expect(JSON.stringify(resolvedCard(ticket, 'revise', '走 B').card)).toContain('走 B')
    expect(JSON.stringify(resolvedCard(ticket, 'stop').card)).toContain('已停止')
    expect(JSON.stringify(staleCard(ticket).card)).toContain('已处理')
  })
})
describe('sending a card', () => {
  it('posts an interactive card with its idempotency key and returns the message id', async () => {
    const lark = vi.fn(async (_args: string[]) => JSON.stringify({ data: { message_id: 'om_1' } }))
    const id = await sendCard({ commands: { lark } as never }, 'oc_1', planCard(ticket, PLAN), 'plan-1')
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
    const id = await sendCard({ commands: { lark } as never }, 'oc_1', planCard(ticket, PLAN), 'plan-1')
    expect(id).toBe('om_text')
    expect(lark).toHaveBeenCalledTimes(2)
    const retry = lark.mock.calls[1]![0] as string[]
    expect(retry).toContain('--content')
    expect(retry[retry.indexOf('--msg-type') + 1]).toBe('post')
    expect(JSON.parse(retry[retry.indexOf('--content') + 1]!).zh_cn.content[0][0].text).toContain('回 1 通过')
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

