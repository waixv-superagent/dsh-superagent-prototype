import { describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { feishuPostContent, sendFeishu } from '../src/sources/feishu-channel.ts'

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
  // `!` vanish without an error. The argument must carry no character cmd reads twice.
  it('rewrites the characters the Windows wrapper reads as syntax, so the payload stays one argument', async () => {
    const lark = vi.fn(async (_args: string[]) => ({ ok: true }))
    const host = { commands: { lark }, state: { get: () => undefined, set: () => {} } } as never
    await sendFeishu(host, message('收集&更新飘带动画List，进度 50%，2^3，好了!'))
    const content = (lark.mock.calls[0]![0] as string[])[(lark.mock.calls[0]![0] as string[]).indexOf('--content') + 1]!
    expect(content).not.toMatch(/[<>&|^!%]/)
    expect(JSON.parse(content).zh_cn.content[0][0].text)
      .toBe('收集＆更新飘带动画List，进度 50％，2＾3，好了！')
  })
})
