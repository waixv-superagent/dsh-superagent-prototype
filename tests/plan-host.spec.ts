import { describe, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { notifyChat, notifyPlan, type PlanHost } from '../src/app/plan.ts'

const ticket = { id: 'a'.repeat(32), title: 'Fix', origin: { triggerId: 't1', triggerIds: ['t1'] } } as Ticket
function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return { id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'c1' }], actor: { source: 'feishu', id: 'u1' }, human: true,
    at: '2026-09-23T00:00:00Z', text: 'fix it', channel: { source: 'feishu', thread: 'c1', address: { chatId: 'oc_dm' } }, meta: { direct: true }, ...overrides }
}
function makeHost({ config = {} as Record<string, unknown>, source = trigger(), enabled = true, send = vi.fn(async (_args: string[]) => '{"data":{"message_id":"om_9"}}') } = {}) {
  const warn = vi.fn()
  const cards: Record<string, { ticketId: string; planAt: string; url?: string }> = {}
  const host: PlanHost = {
    store: { settings: () => ({ sources: { feishu: { enabled: true, config } } }), triggers: { get: (id: string) => id === 't1' ? source : undefined },
      get: () => cards, set: (_key: string, value: typeof cards) => { Object.assign(cards, value) } } as never,
    sources: { instance: () => ({ enabled }) as never },
    commands: { lark: send } as never,
    warn,
  }
  return { host, warn, send, cards }
}
describe('where a plan card goes', () => {
  it('uses the private chat the Feishu Source names before anything else', () => {
    expect(notifyChat({ settings: () => ({ sources: { feishu: { config: { notifyChat: 'oc_named' } } } }),
      triggers: { get: () => trigger() } } as never, ticket)).toBe('oc_named')
  })
  it('falls back to the direct chat the ticket started in, and to nothing for a group', () => {
    const store = (source: Trigger) => ({ settings: () => ({ sources: {} }), triggers: { get: () => source } }) as never
    expect(notifyChat(store(trigger()), ticket)).toBe('oc_dm')
    expect(notifyChat(store(trigger({ meta: { direct: false } })), ticket)).toBeUndefined()
    expect(notifyChat(store(trigger({ source: 'github' })), ticket)).toBeUndefined()
  })
})
describe('notifying a waiting plan', () => {
  const plan = { text: '现象：x\n代码线：y', at: '2026-09-23T00:00:00Z', waiting: true as const }
  it('sends the card, keyed by the plan so a retry does not post it twice', async () => {
    const { host, send } = makeHost()
    expect(await notifyPlan(host, { ...ticket, plan })).toBe('om_9')
    expect((send.mock.calls[0]![0] as string[]).slice(0, 4)).toEqual(['im', '+messages-send', '--chat-id', 'oc_dm'])
  })
  it('replies in the ticket topic when its replies moved there', async () => {
    const { host, send } = makeHost()
    const moved = { ...ticket, replyChannel: { source: 'feishu' as const, thread: 'feishu:oc_topic',
      address: { chatId: 'oc_topic', messageId: 'om_topic' } } } as Ticket
    expect(await notifyPlan(host, { ...moved, plan })).toBe('om_9')
    const args = send.mock.calls[0]![0] as string[]
    expect(args.slice(0, 4)).toEqual(['im', '+messages-reply', '--message-id', 'om_topic'])
    expect(args).toContain('--reply-in-thread')
    expect(args).not.toContain('--chat-id')
  })
  it('does nothing for an approved plan, and says why when a ticket has no chat or the Source is off', async () => {
    const { host: approvedHost, send } = makeHost()
    expect(await notifyPlan(approvedHost, { ...ticket, plan: { ...plan, approved: { at: '2026-09-23T00:00:01Z' } } })).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    const off = makeHost({ enabled: false })
    expect(await notifyPlan(off.host, { ...ticket, plan })).toBeUndefined()
    expect(off.warn).toHaveBeenCalledWith(expect.stringContaining('Feishu Source'))
    const group = makeHost({ source: trigger({ meta: { direct: false } }) })
    expect(await notifyPlan(group.host, { ...ticket, plan })).toBeUndefined()
    expect(group.warn).toHaveBeenCalledWith(expect.stringContaining('no Feishu conversation'))
  })
  it('remembers the card message link, so the panel opens the question rather than the chat', async () => {
    const send = vi.fn(async (args: string[]) => args.includes('+messages-mget')
      ? JSON.stringify({ data: { messages: [{ message_app_link: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dm&position=7' }] } })
      : '{"data":{"message_id":"om_9"}}')
    const { host, cards } = makeHost({ send })
    expect(await notifyPlan(host, { ...ticket, plan })).toBe('om_9')
    expect(cards.om_9).toMatchObject({ ticketId: ticket.id, planAt: plan.at,
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dm&position=7' })
    expect((send.mock.calls[1]![0] as string[]).slice(0, 3)).toEqual(['im', '+messages-mget', '--message-ids'])
  })
  it('reports a failed send instead of losing it, and still answers the worker', async () => {
    const { host } = makeHost({ send: vi.fn(async (_args: string[]): Promise<string> => { throw new Error('offline') }) })
    expect(await notifyPlan(host, { ...ticket, plan })).toBeUndefined()
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })
})
