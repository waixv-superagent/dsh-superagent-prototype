import { describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { openFeishuTopic, shortTicketId, topicText } from '../src/sources/feishu-topic.ts'
import type { SourceContext } from '../src/sources/host.ts'

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: '8b4722eb84a73a17d2b889adf1b7d43f',
  title: '把话题改成工单简述',
  decisionId: 'd1',
  mandate: {} as Ticket['mandate'],
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
  ...overrides,
})
const trigger = {
  id: 'trigger-1', source: 'feishu', at: '2026-11-03T00:00:00.000Z', text: '把话题改成工单简述',
  actor: { id: 'ou_1', name: '王怀扬' }, human: true, meta: {}, threads: [{ source: 'feishu', id: 'oc_dm:om_1' }],
  channel: { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } },
  url: 'https://applink.feishu.cn/client/message/open?message_id=om_1',
}
const context = (lark: ReturnType<typeof vi.fn>, retarget: ReturnType<typeof vi.fn>,
  describe: ReturnType<typeof vi.fn> = vi.fn(), patch: ReturnType<typeof vi.fn> = vi.fn()): SourceContext => ({
    config: () => ({ topicChat: 'oc_topic' }),
    triggers: { get: () => trigger },
    commands: { lark },
    tickets: { retarget },
    threads: { describe, patch },
  }) as unknown as SourceContext

describe('Feishu ticket topics', () => {
  it('opens a topic named after the ticket and moves its replies there', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ message_id: 'om_topic', thread_id: 'omt_topic' }))
    const retarget = vi.fn()
    const describe = vi.fn()
    const patch = vi.fn()
    await openFeishuTopic(context(lark, retarget, describe, patch), ticket())

    const args = lark.mock.calls[0]![0] as string[]
    expect(args.slice(0, 7)).toEqual(['im', '+messages-send', '--chat-id', 'oc_topic', '--msg-type', 'post', '--content'])
    expect(args[args.indexOf('--idempotency-key') + 1]).toBe('topic-8b4722eb84a73a17d2b889adf1b7d43f')
    const content = JSON.parse(args[args.indexOf('--content') + 1]!)
    expect(content.zh_cn.content[0][0].text).toContain('「把话题改成工单简述」')
    expect(content.zh_cn.content[0][0].text).toContain('工单 8b4722eb')
    expect(content.zh_cn.content[0][0].text).toContain(trigger.url)

    expect(retarget).toHaveBeenCalledWith(ticket().id, {
      source: 'feishu', thread: 'feishu:oc_topic', address: { chatId: 'oc_topic', messageId: 'om_topic' },
    }, { source: 'feishu', id: 'oc_topic:om_topic' })
    expect(describe).toHaveBeenCalledWith('feishu:oc_topic:om_topic',
      expect.objectContaining({ label: '「把话题改成工单简述」· 工单 8b4722eb', url: trigger.url }))
    expect(patch).toHaveBeenCalledWith('feishu:oc_topic:om_topic', { threadId: 'omt_topic' })
  })

  it('leaves a ticket alone once its replies were moved, so a repeated event creates no second topic', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ message_id: 'om_other' }))
    const retarget = vi.fn()
    await openFeishuTopic(context(lark, retarget), ticket({
      replyChannel: { source: 'feishu', thread: 'feishu:oc_topic', address: { chatId: 'oc_topic', messageId: 'om_topic' } },
    }))
    expect(lark).not.toHaveBeenCalled()
    expect(retarget).not.toHaveBeenCalled()
  })

  it('does nothing without a configured topic chat', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ message_id: 'om_topic' }))
    const retarget = vi.fn()
    const ctx = { ...context(lark, retarget), config: () => ({}) } as unknown as SourceContext
    await openFeishuTopic(ctx, ticket())
    expect(lark).not.toHaveBeenCalled()
    expect(retarget).not.toHaveBeenCalled()
  })

  it('keeps the ticket brief short and uses the original message link on the second line', () => {
    expect(shortTicketId(ticket())).toBe('8b4722eb')
    expect(topicText(ticket(), trigger.url)).toBe('「把话题改成工单简述」· 工单 8b4722eb\nhttps://applink.feishu.cn/client/message/open?message_id=om_1')
  })

  it('requires the topic chat to be listed with all messages, since replies there arrive without a mention', () => {
    expect(feishuKind.schema.safeParse({ topicChat: 'oc_topic' }).success).toBe(false)
    expect(feishuKind.schema.safeParse({ topicChat: 'oc_topic', chats: [{ chatId: 'oc_topic', listen: 'mentions' }] }).success).toBe(false)
    expect(feishuKind.schema.safeParse({ topicChat: 'oc_topic', chats: [{ chatId: 'oc_topic', listen: 'all' }] }).success).toBe(true)
    expect(feishuKind.schema.safeParse({}).success).toBe(true)
  })
})
