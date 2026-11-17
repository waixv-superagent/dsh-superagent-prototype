import { describe, expect, it, vi } from 'vitest'
import type { ChannelRef, Ticket } from '../src/core/index.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { openFeishuTopic, shortTicketId, topicText } from '../src/sources/feishu-topic.ts'
import { takeTopicLink, topicLinkLine } from '../src/sources/feishu-topic-link.ts'
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
const receipt: ChannelRef = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
/** The Source's KV state, as the topic opener and the receipt share it. */
const memory = () => {
  const values = new Map<string, unknown>()
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value) },
    keys: (prefix: string) => [...values.keys()].filter(key => key.startsWith(prefix)),
  }
}
type Memory = ReturnType<typeof memory>
const trigger = {
  id: 'trigger-1', source: 'feishu', at: '2026-11-03T00:00:00.000Z', text: '把话题改成工单简述',
  actor: { id: 'ou_1', name: '王怀扬' }, human: true, meta: {}, threads: [{ source: 'feishu', id: 'oc_dm:om_1' }],
  channel: { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } },
  url: 'https://applink.feishu.cn/client/message/open?message_id=om_1',
}
const context = (lark: ReturnType<typeof vi.fn>, retarget: ReturnType<typeof vi.fn>,
  describe: ReturnType<typeof vi.fn> = vi.fn(), patch: ReturnType<typeof vi.fn> = vi.fn(),
  notify: ReturnType<typeof vi.fn> = vi.fn(), state: Memory = memory()): SourceContext => ({
    config: () => ({ topicChat: 'oc_topic' }),
    triggers: { get: () => trigger },
    commands: { lark },
    tickets: { retarget },
    threads: { describe, patch },
    notify,
    state,
  }) as unknown as SourceContext
const stateOf = (value: Memory) => value as unknown as Parameters<typeof takeTopicLink>[0]
/** The topic link Feishu's client resolves: the root message's own position, carried in both query spellings. */
const topicLink = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_topic&open_thread_id=omt_topic'
  + '&openchatid=oc_topic&openthreadid=omt_topic&thread_position=-1'

describe('Feishu ticket topics', () => {
  it('opens a topic named after the ticket and moves its replies there', async () => {
    const lark = vi.fn(async (args: string[]) => args[1] === '+messages-send'
      ? { message_id: 'om_topic', thread_id: 'omt_topic' }
      : { data: { messages: [{ message_id: 'om_topic', thread_id: 'omt_topic',
        message_app_link: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_topic' }] } })
    const retarget = vi.fn()
    const describe = vi.fn()
    const patch = vi.fn()
    const notify = vi.fn()
    await openFeishuTopic(context(lark, retarget, describe, patch, notify), ticket())

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
    // The original thread gets a back-link, so the person who wrote there finds the topic. It is a described link: the
    // long AppLink stays in the target, and people read a short label.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      id: 'topic-link-8b4722eb84a73a17d2b889adf1b7d43f',
      channel: trigger.channel,
      text: `已开话题：[「把话题改成工单简述」](${topicLink})`,
      kind: 'reply',
      ticketId: ticket().id,
    }))
  })

  it('folds the topic link into the receipt queued for the same ticket, so the thread gets one message', async () => {
    const lark = vi.fn(async (args: string[]) => args[1] === '+messages-send'
      ? { message_id: 'om_topic', thread_id: 'omt_topic' }
      : { data: { messages: [{ message_id: 'om_topic', thread_id: 'omt_topic',
        message_app_link: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_topic' }] } })
    const notify = vi.fn()
    const carried = ticket({ id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })
    const state = memory()
    const opening = openFeishuTopic(context(lark, vi.fn(), vi.fn(), vi.fn(), notify, state), carried, receipt)
    // The receipt is the message already queued for the accept; it waits for the topic instead of a second notice.
    expect(await takeTopicLink(stateOf(state), carried.id)).toEqual({
      url: topicLink, title: '把话题改成工单简述',
    })
    await opening
    expect(notify).not.toHaveBeenCalled()
  })

  it('posts its own notice when the receipt gave up waiting for the topic', async () => {
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    const lark = vi.fn(async (args: string[]) => {
      if (args[1] === '+messages-send') { await gate; return { message_id: 'om_topic', thread_id: 'omt_topic' } }
      return { data: { messages: [{ message_id: 'om_topic', thread_id: 'omt_topic',
        message_app_link: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_topic' }] } }
    })
    const notify = vi.fn()
    const waiting = ticket({ id: 'b1b2c3d4e5f60718293a4b5c6d7e8f90' })
    const state = memory()
    const opening = openFeishuTopic(context(lark, vi.fn(), vi.fn(), vi.fn(), notify, state), waiting, receipt)
    expect(await takeTopicLink(stateOf(state), waiting.id, 20)).toBeUndefined()
    release()
    await opening
    // The receipt went out without the link; the notice still tells the person where the conversation continues.
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: `已开话题：[「把话题改成工单简述」](${topicLink})`,
    }))
  })

  it('keeps the topic and still links it from its thread id when the link lookup fails', async () => {
    const lark = vi.fn(async (args: string[]) => {
      if (args[1] === '+messages-send') return { message_id: 'om_topic', thread_id: 'omt_topic' }
      throw new Error('lookup failed')
    })
    const retarget = vi.fn()
    const notify = vi.fn()
    await openFeishuTopic(context(lark, retarget, vi.fn(), vi.fn(), notify), ticket())
    expect(retarget).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      text: `已开话题：[「把话题改成工单简述」](${topicLink})`,
    }))
  })

  it('skips only the back-link when neither the topic link nor its thread id is known', async () => {
    const lark = vi.fn(async (args: string[]) => {
      if (args[1] === '+messages-send') return { message_id: 'om_topic' }
      throw new Error('lookup failed')
    })
    const retarget = vi.fn()
    const notify = vi.fn()
    await openFeishuTopic(context(lark, retarget, vi.fn(), vi.fn(), notify), ticket())
    expect(retarget).toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
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

  it('opens a topic for a ticket from another Source too, so its plan cards reach Feishu', async () => {
    const lark = vi.fn(async (args: string[]) => args[1] === '+messages-send'
      ? { message_id: 'om_topic', thread_id: 'omt_topic' }
      : { data: { messages: [{ message_id: 'om_topic', thread_id: 'omt_topic',
        message_app_link: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_topic' }] } })
    const retarget = vi.fn()
    const notify = vi.fn()
    const github = { ...trigger, source: 'github', channel: { source: 'github', thread: 'github:7', address: { number: '7' } },
      url: 'https://github.com/waixv-superagent/dsh-superagent-prototype/pull/7' }
    const ctx = { ...context(lark, retarget, vi.fn(), vi.fn(), notify), triggers: { get: () => github } } as unknown as SourceContext
    await openFeishuTopic(ctx, ticket())
    expect(retarget).toHaveBeenCalledWith(ticket().id, {
      source: 'feishu', thread: 'feishu:oc_topic', address: { chatId: 'oc_topic', messageId: 'om_topic' },
    }, { source: 'feishu', id: 'oc_topic:om_topic' })
    // A GitHub ticket has no Feishu thread to point back to; the topic itself is the way in.
    expect(notify).not.toHaveBeenCalled()
    const args = lark.mock.calls[0]![0] as string[]
    const content = JSON.parse(args[args.indexOf('--content') + 1]!)
    expect(content.zh_cn.content[0][0].text).toContain(github.url)
  })

  it('links the panel page in the topic root when the request has no page of its own', async () => {
    const lark = vi.fn(async (args: string[]) => args[1] === '+messages-send'
      ? { message_id: 'om_topic', thread_id: 'omt_topic' }
      : { data: { messages: [{ message_id: 'om_topic', thread_id: 'omt_topic',
        message_app_link: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_topic' }] } })
    const retarget = vi.fn()
    const describe = vi.fn()
    const web = { ...trigger, source: 'web', url: undefined, channel: { source: 'web', thread: 'web:t', address: { session: 's1' } } }
    const ctx = { ...context(lark, retarget, describe), config: () => ({ topicChat: 'oc_topic', panelUrl: 'https://panel.example' }),
      triggers: { get: () => web } } as unknown as SourceContext
    await openFeishuTopic(ctx, ticket())
    const link = `https://panel.example/?ticket=${ticket().id}`
    const args = lark.mock.calls[0]![0] as string[]
    expect(JSON.parse(args[args.indexOf('--content') + 1]!).zh_cn.content[0][0].text).toContain(link)
    expect(describe).toHaveBeenCalledWith('feishu:oc_topic:om_topic', expect.objectContaining({ url: link }))
  })

  it('keeps the ticket brief short and uses the original message link on the second line', () => {
    expect(shortTicketId(ticket())).toBe('8b4722eb')
    expect(topicText(ticket(), trigger.url)).toBe('「把话题改成工单简述」· 工单 8b4722eb\nhttps://applink.feishu.cn/client/message/open?message_id=om_1')
  })

  it('describes a topic link in a short label, so the long AppLink never shows in a message', () => {
    const url = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_topic&open_thread_id=omt_topic'
    const line = topicLinkLine('把 [开单] 和开话题两条通知合并成一条，并缩短话题的 feishu applink', url)
    const label = line.slice('已开话题：[「'.length, line.indexOf('」]('))
    expect(Array.from(label)).toHaveLength(24)
    expect(label).not.toMatch(/[[\]]/)
    expect(line.endsWith(`](${url})`)).toBe(true)
  })

  it('requires the topic chat to be listed with all messages, since replies there arrive without a mention', () => {
    expect(feishuKind.schema.safeParse({ topicChat: 'oc_topic' }).success).toBe(false)
    expect(feishuKind.schema.safeParse({ topicChat: 'oc_topic', chats: [{ chatId: 'oc_topic', listen: 'mentions' }] }).success).toBe(false)
    expect(feishuKind.schema.safeParse({ topicChat: 'oc_topic', chats: [{ chatId: 'oc_topic', listen: 'all' }] }).success).toBe(true)
    expect(feishuKind.schema.safeParse({}).success).toBe(true)
  })
})
