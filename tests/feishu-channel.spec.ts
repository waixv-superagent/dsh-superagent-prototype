import { describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { feishuClientLink, feishuPostContent, sendFeishu } from '../src/sources/feishu-channel.ts'

const message = (text: string): OutboundMessage => ({
  id: 'reply-1',
  channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
  text,
  kind: 'reply',
})

describe('Feishu outbound replies', () => {
  it('encodes Markdown as one post payload, so no literal newline survives in the argument', () => {
    const text = '昨晚三条都收尾了：\n1. 第一件：完成\n2. 第二件：完成\n\n现在没有在跑的工单。'
    const content = feishuPostContent(text)
    expect(content).not.toContain('\n')
    expect(JSON.parse(content)).toEqual({ zh_cn: { content: [[{ tag: 'md', text }]] } })
  })
  it('replies with the full multi-line text through --content post, not --markdown', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ ok: true }))
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    const text = '昨晚三条都收尾了：\n1. 代理测试：完成\n2. 私聊保留个人助理：完成\n\n现在没有在跑的工单。'
    expect(await sendFeishu(host, message(text))).toBe('sent')
    const args = lark.mock.calls[0]![0] as string[]
    expect(args.slice(0, 5)).toEqual(['im', '+messages-reply', '--message-id', 'om_1', '--msg-type'])
    expect(args[args.indexOf('--msg-type') + 1]).toBe('post')
    expect(args).not.toContain('--markdown')
    expect(args.every(argument => !argument.includes('\n'))).toBe(true)
    expect(JSON.parse(args[args.indexOf('--content') + 1]!)).toEqual({ zh_cn: { content: [[{ tag: 'md', text }]] } })
    expect(args[args.indexOf('--idempotency-key') + 1]).toBe('reply-1')
    expect(args).toContain('--reply-in-thread')
  })
  it('settles a reply whose target message never existed, instead of retrying it forever', async () => {
    const lark = vi.fn(async () => {
      throw new CliError('The request you send is not a valid {open_message_id} or not exists (99992354)', undefined, 1)
    })
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    expect(await sendFeishu(host, message('收到'))).toBe('gone')
  })
  // A `.cmd` shim re-runs the CLI with `%*`, so a `&` in the text cut the JSON and the tail executed as a command; `^` and
  // `!` vanish without an error. The argument now unicode-escapes those characters, so cmd reads none of them and Feishu's
  // JSON parser restores the original text — which is what keeps a URL's query string whole.
  it('escapes the characters the Windows wrapper reads as syntax, and restores the payload byte for byte', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ ok: true }))
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    const text = '收集&更新飘带动画List，进度 50%，2^3，好了!'
    await sendFeishu(host, message(text))
    const content = (lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--content') + 1]!
    expect(content).not.toMatch(/[<>&|^!%]/)
    expect(content).toContain('\\u0026')
    expect(JSON.parse(content).zh_cn.content[0][0].text).toBe(text)
  })
  it('keeps a link whole, so its & and % still open the thread it points at', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ ok: true }))
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    const link = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=om_2&position=12%2F34'
    await sendFeishu(host, message(`已开话题：${link}`))
    const content = (lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--content') + 1]!
    expect(content).not.toMatch(/[<>&|^!%]/)
    expect(JSON.parse(content).zh_cn.content[0][0].text).toContain(link)
  })
  it('keeps a link whole on a question card too', async () => {
    const lark = vi.fn(async (_args: string[]) => '{"data":{"message_id":"om_card"}}')
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    const link = 'https://example.feishu.cn/docx/AbCd?from=card&user_code=AB%2FCD'
    const asked = { ...message('这张卡里的链接能点吗？'), attention: { ticketId: 't1', attentionId: 'att-1', options: ['能', '不能'],
      sections: [{ label: '现状', text: `见 ${link}` }] } }
    expect(await sendFeishu(host, asked)).toBe('sent')
    const args = lark.mock.calls[0]![0] as string[]
    const content = args[args.indexOf('--content') + 1]!
    expect(content).not.toMatch(/[<>&|^!%]/)
    expect(JSON.stringify(JSON.parse(content))).toContain(link)
  })
  it('sends a question with choices as a card, and remembers its message id for the callback', async () => {
    const lark = vi.fn(async (_args: string[]) => '{"data":{"message_id":"om_card"}}')
    const saved: Record<string, unknown> = {}
    const host = { commands: { lark }, state: { get: () => undefined, set: (key: string, value: unknown) => { saved[key] = value } } } as never
    const asked = { ...message('先上 A 还是先上 B？'), attention: { ticketId: 't1', attentionId: 'att-1', options: ['先上 A', '先上 B'] } }
    expect(await sendFeishu(host, asked)).toBe('sent')
    const args = lark.mock.calls[0]![0] as string[]
    expect(args[args.indexOf('--msg-type') + 1]).toBe('interactive')
    const card = JSON.parse(args[args.indexOf('--content') + 1]!)
    expect(JSON.stringify(card)).toContain('先上 A 还是先上 B？')
    expect(JSON.stringify(card)).toContain('att-1')
    expect(saved['feishu-attention-cards']).toMatchObject({ om_card: { ticketId: 't1', attentionId: 'att-1' } })
  })
  it('remembers the question card\'s own message link, so the panel opens that question', async () => {
    const link = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=9'
    const lark = vi.fn(async (args: string[]) => args.includes('+messages-mget')
      ? { data: { messages: [{ message_app_link: link }] } }
      : { data: { message_id: 'om_card' } })
    const saved: Record<string, unknown> = {}
    const host = { commands: { lark }, state: { get: () => undefined, set: (key: string, value: unknown) => { saved[key] = value } } } as never
    const asked = { ...message('这个取舍能不能定？'), attention: { ticketId: 't1', attentionId: 'att-1', options: ['能定', '再改改'] } }
    expect(await sendFeishu(host, asked)).toBe('sent')
    expect(lark).toHaveBeenCalledWith(['im', '+messages-mget', '--message-ids', 'om_card'])
    expect(saved['feishu-attention-cards']).toMatchObject({ om_card: { ticketId: 't1', attentionId: 'att-1', url: link } })
  })
  it('keeps the answer even when the card link cannot be fetched', async () => {
    const lark = vi.fn(async (args: string[]) => {
      if (args.includes('+messages-mget')) throw new Error('mget failed')
      return { data: { message_id: 'om_card' } }
    })
    const saved: Record<string, unknown> = {}
    const host = { commands: { lark }, state: { get: () => undefined, set: (key: string, value: unknown) => { saved[key] = value } } } as never
    const asked = { ...message('这个取舍能不能定？'), attention: { ticketId: 't1', attentionId: 'att-1', options: ['能定', '再改改'] } }
    expect(await sendFeishu(host, asked)).toBe('sent')
    expect(saved['feishu-attention-cards']).toMatchObject({ om_card: { ticketId: 't1', attentionId: 'att-1' } })
  })
  it('turns an AppLink into the client scheme that skips Feishu\'s browser landing page', () => {
    expect(feishuClientLink('https://applink.feishu.cn/client/thread/open?open_thread_id=omt_1&thread_position=9'))
      .toBe('feishu://applink/client/thread/open?open_thread_id=omt_1&thread_position=9')
    expect(feishuClientLink('https://applink.larksuite.com/client/chat/open?openChatId=oc_1'))
      .toBe('lark://applink/client/chat/open?openChatId=oc_1')
    // Another Source's links stay ordinary web links.
    expect(feishuClientLink('https://github.com/acme/widgets/pull/42')).toBe('https://github.com/acme/widgets/pull/42')
  })
  it('carries the worker\'s context sections onto the question card', async () => {
    const lark = vi.fn(async (_args: string[]) => '{"data":{"message_id":"om_card"}}')
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    const asked = { ...message('这个取舍能不能定？'), attention: { ticketId: 't1', attentionId: 'att-1', options: ['能定', '再改改'],
      sections: [{ label: '现状', text: '两个方案都能过测试' }] } }
    expect(await sendFeishu(host, asked)).toBe('sent')
    const args = lark.mock.calls[0]![0] as string[]
    const card = JSON.parse(args[args.indexOf('--content') + 1]!)
    expect(JSON.stringify(card)).toContain('**现状**')
    expect(JSON.stringify(card)).toContain('两个方案都能过测试')
  })
  it('falls back to the text reply when Feishu rejects the question card', async () => {
    const lark = vi.fn(async (args: string[]) => {
      if (args[args.indexOf('--msg-type') + 1] === 'interactive') throw new Error('bad card')
      return '{}'
    })
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    const asked = { ...message('先上 A 还是先上 B？'), attention: { ticketId: 't1', attentionId: 'att-1', options: ['先上 A', '先上 B'] } }
    expect(await sendFeishu(host, asked)).toBe('sent')
    expect(lark).toHaveBeenCalledTimes(2)
    const args = lark.mock.calls[1]![0] as string[]
    expect(args[args.indexOf('--msg-type') + 1]).toBe('post')
    expect(JSON.parse(args[args.indexOf('--content') + 1]!).zh_cn.content[0][0].text).toContain('先上 A 还是先上 B？')
  })
})
