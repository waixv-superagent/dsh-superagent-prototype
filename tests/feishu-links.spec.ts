import { describe, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { isMessageLink, feishuTopicLink } from '../src/sources/feishu-channel.ts'
import { fillLinks, threadLink } from '../src/sources/feishu-loops.ts'
import type { SourceContext } from '../src/sources/host.ts'

const chat = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'
const message = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=3'
const ref = { source: 'feishu', id: 'oc_1:om_root' }
const resolved = () => ({ data: { messages: [{ message_app_link: message }] } })
const lark = () => vi.fn(async () => resolved())

function context(options: {
  lark?: ReturnType<typeof lark>
  thread?: { url?: string } | undefined
  threads?: unknown[]
  describe?: ReturnType<typeof vi.fn>
  state?: Map<unknown, unknown>
} = {}): SourceContext {
  const threads = options.threads ?? []
  return {
    commands: { lark: options.lark ?? lark() },
    deployment: { feishu: { brand: 'feishu' } },
    state: {
      get: (key: unknown) => options.state?.get(key),
      set: (key: unknown, value: unknown) => { options.state?.set(key, value) },
    },
    threads: {
      get: () => options.thread ? { key: 'feishu:oc_1:om_root', meta: { ...options.thread } } : undefined,
      subscribed: () => threads,
      describe: options.describe ?? vi.fn(),
    },
  } as unknown as SourceContext
}

describe('Feishu message links', () => {
  it('tells a message link from a chat link', () => {
    expect(isMessageLink(message)).toBe(true)
    expect(isMessageLink(chat)).toBe(false)
    expect(isMessageLink('https://applink.feishu.cn/client/chat/open?openChatId=oc_1&position=8')).toBe(true)
    expect(isMessageLink(undefined)).toBe(false)
  })

  it('keeps the message link a thread already stores', async () => {
    const call = lark()
    expect(await threadLink(context({ lark: call, thread: { url: message } }), ref, undefined, 'oc_1')).toBe(message)
    expect(call).not.toHaveBeenCalled()
  })

  it('prefers the event\'s own AppLink over asking Feishu', async () => {
    const call = lark()
    const eventUrl = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1&position=2'
    expect(await threadLink(context({ lark: call, thread: { url: chat } }), ref, eventUrl, 'oc_1')).toBe(eventUrl)
    expect(call).not.toHaveBeenCalled()
  })

  it('asks Feishu for the thread root when the stored link only opens the chat', async () => {
    const call = lark()
    expect(await threadLink(context({ lark: call, thread: { url: chat } }), ref, undefined, 'oc_1')).toBe(message)
    expect(call).toHaveBeenCalledWith(['im', '+messages-mget', '--message-ids', 'om_root'])
  })

  it('falls back to the chat when Feishu cannot resolve the message', async () => {
    const call = vi.fn(async () => { throw new Error('recalled') })
    expect(await threadLink(context({ lark: call, thread: { url: chat } }), ref, undefined, 'oc_1')).toBe(chat)
  })

  it('fills the links cards and threads stored before their message was known', async () => {
    const state = new Map<unknown, unknown>()
    state.set(KV.feishu.attentionCards, {
      om_question: { ticketId: 't1', attentionId: 'a1', at: '2026-11-03T00:00:00.000Z' },
      om_answered: { ticketId: 't1', attentionId: 'a2', at: '2026-11-03T00:00:00.000Z', url: message },
    })
    state.set(KV.feishu.cards, { om_plan: { ticketId: 't1', planAt: '2026-11-03T00:00:00.000Z' } })
    const describe = vi.fn()
    const thread = { key: 'feishu:oc_1:om_root', ref, meta: { url: chat } }
    await fillLinks(context({ state, threads: [thread], describe }), new AbortController().signal)

    const attention = state.get(KV.feishu.attentionCards) as Record<string, { url?: string }>
    expect(attention.om_question?.url).toBe(message)
    expect(attention.om_answered?.url).toBe(message)
    expect((state.get(KV.feishu.cards) as Record<string, { url?: string }>).om_plan?.url).toBe(message)
    expect(describe).toHaveBeenCalledWith('feishu:oc_1:om_root', { url: message })
  })
})

describe('Feishu topic links', () => {
  // Feishu's own topic link: the root message's position, which a client resolves even before the topic has a reply.
  const topic = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1'
    + '&openchatid=oc_1&openthreadid=omt_1&thread_position=-1'
  it('opens a topic at its root message instead of the message a link names', () => {
    expect(feishuTopicLink({ url: message })).toBe(topic)
    // A chat link names no topic, so the topic is built from the chat and thread ids.
    expect(feishuTopicLink({ chatId: 'oc_1', threadId: 'omt_1', url: chat })).toBe(topic)
    expect(feishuTopicLink({ chatId: 'oc_1', threadId: 'omt_1' })).toBe(topic)
    // Lark keeps its own host.
    expect(feishuTopicLink({ chatId: 'oc_1', threadId: 'omt_1',
      url: 'https://applink.larksuite.com/client/chat/open?openChatId=oc_1' }))
      .toBe('https://applink.larksuite.com/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1'
        + '&openchatid=oc_1&openthreadid=omt_1&thread_position=-1')
    // Feishu's own topic link (both spellings, root position) is already what a person's client resolves.
    expect(feishuTopicLink({ chatId: 'oc_1', threadId: 'omt_1',
      url: 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1'
        + '&openchatid=oc_1&openthreadid=omt_1&thread_position=-1' })).toBe(topic)
    // Without a topic id a chat link still drops its position, so it opens the conversation at its newest message.
    expect(feishuTopicLink({ url: `${chat}&position=8` })).toBe(chat)
    // The client scheme is accepted too, so a link already converted by another view stays usable.
    expect(feishuTopicLink({ url: 'feishu://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=9' }))
      .toBe('feishu://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1'
        + '&openchatid=oc_1&openthreadid=omt_1&thread_position=-1')
    // A topic link whose chat id is unknown keeps the position it came with rather than losing the way in.
    expect(feishuTopicLink({ url: 'feishu://applink/client/thread/open?open_thread_id=omt_1&thread_position=2' }))
      .toBe('feishu://applink/client/thread/open?open_thread_id=omt_1&thread_position=2')
    // A stored link with a malformed escape still names its ids, so it is rebuilt instead of failing the view.
    expect(feishuTopicLink({ url: 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=2%' }))
      .toBe(topic)
    expect(feishuTopicLink({})).toBeUndefined()
  })
})
