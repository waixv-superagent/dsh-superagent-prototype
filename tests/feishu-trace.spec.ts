import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextCache } from '../src/app/cache.ts'
import { Store } from '../src/app/store.ts'
import { ticketSearch } from '../src/app/views/tickets.ts'
import { search } from '../src/app/views/threads.ts'
import { feishuTrace } from '../src/app/views/trace.ts'
import { KV } from '../src/kv.ts'
import type { ChannelRef, OutboundMessage, Trigger } from '../src/core/index.ts'
import { planCard } from '../src/sources/feishu-card.ts'
import { feishuLink, sendFeishu } from '../src/sources/feishu-channel.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuIds, ticketFooter, ticketPanelLink, withTicketFooter } from '../src/sources/feishu-sent.ts'
import { feishuChannel, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { IM_WORDS, wordCount } from '../src/infra/text.ts'

const PANEL = 'https://panel.example.com:9443'
const TICKET = '96c4cb5233453965b1e35a008b0eb3b7'

describe('the ticket link a bot message carries', () => {
  it('opens the ticket page of the configured panel, and is absent without one', () => {
    expect(ticketPanelLink(`${PANEL}/`, TICKET)).toBe(`${PANEL}/?ticket=${TICKET}`)
    expect(ticketFooter(PANEL, TICKET)).toBe(`[工单 96c4cb52 ↗](${PANEL}/?ticket=${TICKET})`)
    expect(withTicketFooter('好了', '', TICKET)).toBe('好了')
    expect(withTicketFooter('好了', PANEL, undefined)).toBe('好了')
  })
  it('accepts only an http(s) panel address in the Feishu settings, and defaults to none', () => {
    expect(feishuKind.schema.parse({}).panelUrl).toBe('')
    expect(feishuKind.schema.parse({ panelUrl: PANEL }).panelUrl).toBe(PANEL)
    expect(() => feishuKind.schema.parse({ panelUrl: 'javascript:alert(1)' })).toThrow()
    expect(() => feishuKind.schema.parse({ panelUrl: `${PANEL}/?token=x` })).toThrow()
  })
})

describe('sending a ticket\'s message', () => {
  const reply = (text: string, ticketId?: string): OutboundMessage => ({ id: 'reply-1', text, kind: 'reply',
    channel: feishuChannel('oc_dm', 'om_ask', true), ...ticketId ? { ticketId } : {} })
  const host = (output: unknown = { data: { message_id: 'om_bot', thread_id: 'omt_9' } }) => {
    const saved: Record<string, unknown> = {}
    const lark = vi.fn(async (_args: string[]) => output)
    return { saved, lark, host: { commands: { lark }, state: { get: () => undefined,
      set: (key: string, value: unknown) => { saved[key] = value } } } as never }
  }
  const sentText = (lark: ReturnType<typeof host>['lark']) => {
    const args = lark.mock.calls[0]![0]
    return JSON.parse(args[args.indexOf('--content') + 1]!).zh_cn.content[0][0].text as string
  }
  it('ends with the ticket link, outside the IM word limit the text itself is checked against', async () => {
    const h = host()
    // A text exactly at the limit still goes out, because the footer is added after the check.
    const full = Array.from({ length: IM_WORDS }, () => 'word').join(' ')
    expect(wordCount(full)).toBe(IM_WORDS)
    expect(await sendFeishu(h.host, reply(full, TICKET), { panelUrl: PANEL })).toBe('sent')
    expect(sentText(h.lark)).toBe(`${full}\n[工单 96c4cb52 ↗](${PANEL}/?ticket=${TICKET})`)
    await expect(sendFeishu(h.host, reply(`${full} more`, TICKET), { panelUrl: PANEL })).rejects.toThrow(/maximum is 100/)
  })
  it('sends the text unchanged when no panel is configured or the message has no ticket', async () => {
    const h = host()
    await sendFeishu(h.host, reply('收到', TICKET))
    expect(sentText(h.lark)).toBe('收到')
    const other = host()
    await sendFeishu(other.host, reply('收到'), { panelUrl: PANEL })
    expect(sentText(other.lark)).toBe('收到')
    expect(other.saved).toEqual({})
  })
  it('records the bot\'s own message, its chat and topic, so the message leads back to the ticket', async () => {
    const h = host()
    await sendFeishu(h.host, reply('收到', TICKET), { panelUrl: PANEL })
    expect(h.saved[KV.feishu.sent('om_bot')]).toMatchObject({ ticketId: TICKET, chatId: 'oc_dm', threadId: 'omt_9' })
  })
  it('still reports a sent reply when Feishu returns no message id to record', async () => {
    const h = host({})
    expect(await sendFeishu(h.host, reply('收到', TICKET))).toBe('sent')
    expect(h.saved).toEqual({})
  })
  it('puts the ticket link on a question card and records the card', async () => {
    const h = host({ data: { message_id: 'om_card' } })
    const asked = { ...reply('先上 A 还是 B？', TICKET), attention: { ticketId: TICKET, attentionId: 'att', options: ['A', 'B'] } }
    expect(await sendFeishu(h.host, asked, { panelUrl: PANEL })).toBe('sent')
    const args = h.lark.mock.calls[0]![0]
    expect(args[args.indexOf('--content') + 1]).toContain(`?ticket=${TICKET}`)
    expect(h.saved[KV.feishu.sent('om_card')]).toMatchObject({ ticketId: TICKET, chatId: 'oc_dm' })
  })
  it('reads the panel address from the Feishu settings when the registry sends', async () => {
    const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { panelUrl: PANEL } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(feishuKind)
    const h = host()
    expect(await sources.send(reply('收到', TICKET), h.host)).toBe('sent')
    expect(sentText(h.lark)).toContain(`${PANEL}/?ticket=${TICKET}`)
  })
  it('links the plan card to its ticket only when a link is given', () => {
    const plan = { text: '现象：x', template: 'fix' as const }
    expect(JSON.stringify(planCard({ id: TICKET, title: 't' }, plan).card)).not.toContain('?ticket=')
    const linked = planCard({ id: TICKET, title: 't' }, plan, ticketPanelLink(PANEL, TICKET))
    expect(JSON.stringify(linked.card)).toContain(`${PANEL}/?ticket=${TICKET}`)
    expect(linked.text.endsWith(`(${PANEL}/?ticket=${TICKET})`)).toBe(true)
  })
})

describe('finding a ticket from Feishu', () => {
  let directory: string
  let store: Store
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-trace-'))
    store = new Store(join(directory, 'orchestrator.sqlite'))
  })
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString()
  const ticket = (id: string, title: string, minute: number) => store.tickets.save({ id, title, decisionId: 'd', channels: [],
    undelivered: [], createdAt: at(minute), updatedAt: at(minute),
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_a' }, scope: '' },
    origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })
  const thread = (key: string, subscriptions: string[], meta: Record<string, unknown> = {}) => store.threads.save({ key,
    ref: { source: 'feishu', id: key.slice('feishu:'.length) }, createdAt: at(0), subscriptions, correlated: [], pending: [], meta })
  const trigger = (messageId: string, threadId: string, extra: Partial<Trigger> & { meta?: Record<string, unknown> } = {}) =>
    store.triggers.save({ id: feishuTriggerId(messageId), source: 'feishu', threads: [{ source: 'feishu', id: threadId }],
      actor: { source: 'feishu', id: 'ou_a' }, human: true, at: at(1), text: `ask ${messageId}`, ...extra,
      meta: { chatId: threadId.split(':')[0], messageId, direct: true, ...extra.meta } })
  const views = () => {
    const sources = new SourceRegistry(() => store.settings())
    sources.register(feishuKind)
    return { store, sources, links: (channel: ChannelRef) => feishuLink(channel.address, {}) }
  }
  // Two DM sub-threads of one direct chat, each the thread of one ticket, and a third ticket elsewhere.
  const directChat = () => {
    ticket('aaaaaaaa000000000000000000000001', '飞书反查工单', 5)
    ticket('bbbbbbbb000000000000000000000002', '今日复盘', 9)
    ticket('cccccccc000000000000000000000003', '别的群的单', 7)
    thread('feishu:oc_dm:om_ask1', ['aaaaaaaa000000000000000000000001'])
    thread('feishu:oc_dm:om_ask2', ['bbbbbbbb000000000000000000000002'])
    thread('feishu:oc_team:om_x', ['cccccccc000000000000000000000003'])
    trigger('om_ask1', 'oc_dm:om_ask1', { url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dm&position=31' })
    trigger('om_ask2', 'oc_dm:om_ask2', { meta: { threadId: 'omt_dm2' } })
  }

  it('reads the Feishu ids a pasted text names', () => {
    expect(feishuIds('https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_2&thread_position=3 om_4'))
      .toEqual({ messages: ['om_4'], topics: ['omt_2'], chats: ['oc_1'] })
  })
  it('leads from a bot message id straight to its ticket, in the header search and the ticket finder', () => {
    directChat()
    store.set(KV.feishu.sent('om_botreply'), { ticketId: 'aaaaaaaa000000000000000000000001', chatId: 'oc_dm', at: at(6) })
    expect(feishuTrace(store, 'om_botreply').map(hit => [hit.ticket.id, hit.via])).toEqual([['aaaaaaaa000000000000000000000001', 'message']])
    expect(search(views(), 'om_botreply', new TextCache(10)).tickets.map(item => item.id)).toEqual(['aaaaaaaa000000000000000000000001'])
    expect(ticketSearch(views(), 'om_botreply').tickets[0]).toMatchObject({ ticket: { id: 'aaaaaaaa000000000000000000000001' },
      match: { field: 'feishu', text: 'om_botreply' } })
  })
  it('leads from a person\'s message id to the ticket of the thread it sits in', () => {
    directChat()
    expect(feishuTrace(store, 'om_ask2').map(hit => hit.ticket.id)).toEqual(['bbbbbbbb000000000000000000000002'])
  })
  it('leads from a pasted direct-chat message link, which carries only the chat and a position', () => {
    directChat()
    const link = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dm&position=31'
    expect(feishuTrace(store, link).map(hit => hit.ticket.id)).toEqual(['aaaaaaaa000000000000000000000001'])
    // The client-scheme copy the panel shows is the same link.
    expect(feishuTrace(store, 'feishu://applink/client/chat/open?openChatId=oc_dm&position=31').map(hit => hit.ticket.id))
      .toEqual(['aaaaaaaa000000000000000000000001'])
  })
  it('leads from a topic link to the topic\'s ticket, not to the whole chat', () => {
    directChat()
    const link = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_dm&open_thread_id=omt_dm2&thread_position=4'
    expect(feishuTrace(store, link).map(hit => [hit.ticket.id, hit.via])).toEqual([['bbbbbbbb000000000000000000000002', 'topic']])
  })
  it('lists every ticket of a chat, newest first, for its chat id or a position the host never saw', () => {
    directChat()
    expect(feishuTrace(store, 'oc_dm').map(hit => hit.ticket.id))
      .toEqual(['bbbbbbbb000000000000000000000002', 'aaaaaaaa000000000000000000000001'])
    const unseen = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dm&position=99'
    expect(feishuTrace(store, unseen).map(hit => hit.via)).toEqual(['chat', 'chat'])
    expect(search(views(), 'oc_dm', new TextCache(10)).tickets.map(item => item.id))
      .toEqual(['bbbbbbbb000000000000000000000002', 'aaaaaaaa000000000000000000000001'])
  })
  it('finds nothing for ids that lead nowhere', () => {
    directChat()
    expect(feishuTrace(store, 'om_unknown oc_nowhere')).toEqual([])
  })
})
