/**
 * The way back from Feishu to a ticket: the tickets a pasted Feishu message id, topic id, chat id or message link leads to.
 * A bot message the host recorded (`KV.feishu.sent`) names its ticket directly; any other message leads through the thread
 * its Trigger sits in. A topic link names its chat too, so a topic that leads nowhere falls back to the whole chat, which in
 * a direct chat lists every ticket started there.
 */
import type { Ticket } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import { feishuIds } from '../../sources/feishu-sent.ts'
import type { Store } from '../store.ts'

/** How a ticket was reached, most specific first: the message itself, its topic, or only its chat. */
export type TraceVia = 'message' | 'topic' | 'chat'
export interface TraceHit { ticket: Ticket; via: TraceVia; id: string }

/** The tickets `query` leads to through the Feishu ids it names, each once at its most specific match, newest first per kind. */
export function feishuTrace(store: Pick<Store, 'get' | 'read' | 'tickets'>, query: string): TraceHit[] {
  const { messages, topics, chats } = feishuIds(query)
  const hits = new Map<string, TraceHit>()
  const add = (ids: Iterable<string>, via: TraceVia, id: string) => {
    for (const ticketId of ids) {
      if (hits.has(ticketId)) continue
      const ticket = store.tickets.get(ticketId)
      if (ticket) hits.set(ticketId, { ticket, via, id })
    }
  }
  const subscribers = (threads: { subscriptions: string[] }[]) => threads.flatMap(thread => thread.subscriptions)
  const ordered = (ids: string[]) => [...new Set(ids)].flatMap(id => store.tickets.get(id) ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(ticket => ticket.id)
  for (const id of messages) {
    const sent = store.get(KV.feishu.sent(id))
    add(sent ? [sent.ticketId] : [], 'message', id)
    add(ordered(subscribers(store.read.feishuThreads('message', id))), 'message', id)
  }
  // A pasted message link (a direct chat's `position` link, or a topic's `thread_position` one) matches the link a Trigger
  // was received with; the client scheme the panel shows is the same link.
  const link = /^(?:https:\/\/applink\.|feishu:\/\/applink\/|lark:\/\/applink\/)/i.test(query.trim())
    ? query.trim().replace(/^feishu:\/\/applink\//i, 'https://applink.feishu.cn/').replace(/^lark:\/\/applink\//i, 'https://applink.larksuite.com/')
    : undefined
  if (link && /[?&](?:thread_)?position=/.test(link)) {
    const triggers = store.read.search(link, 5).filter(trigger => trigger.source === 'feishu' && trigger.url === link)
    for (const trigger of triggers) {
      const messageId = typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : trigger.id
      add(ordered(subscribers(store.read.feishuThreads('message', messageId))), 'message', messageId)
    }
  }
  for (const id of topics) {
    add(ordered([...store.read.feishuSent('topic', id).map(item => item.ticketId), ...subscribers(store.read.feishuThreads('topic', id))]), 'topic', id)
  }
  // A link names its chat beside its message or topic; the chat widens the search only when nothing more specific was found,
  // which is also the case when the chat is all the query names.
  if (!hits.size) {
    for (const id of chats) {
      add(ordered([...store.read.feishuSent('chat', id).map(item => item.ticketId), ...subscribers(store.read.feishuThreads('chat', id))]), 'chat', id)
    }
  }
  return [...hits.values()]
}
