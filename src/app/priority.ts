/**
 * Sends a TAPD ticket's priority question to the person who decides it, in the ticket's Feishu conversation: the topic its
 * replies moved to, else the chat it started in, else the Source's intervention chat (a TAPD ticket has no Feishu
 * conversation of its own). The card itself is built by `sources/feishu-card.ts`; this module resolves where it goes,
 * records the mapping its buttons need, and answers with the message it went out as.
 */
import { key, tapdSuggestion } from '../core/index.ts'
import type { Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { messageLink, priorityCard, sendCard, type PriorityFacts } from '../sources/feishu-card.ts'
import { notifyChat } from './plan.ts'
import type { Store } from './store.ts'

/** How long a priority card's message id is remembered for its button callback; the card's delayed-update token lasts 30 minutes. */
const CARD_KEEP_MS = 48 * 3600_000
export interface PriorityHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'triggers' | 'get' | 'set'>
  readonly sources: Pick<SourceRegistry, 'instance'>
  readonly commands: Pick<Commands, 'lark'>
  /** Reports a card that could not be sent, so the failure appears in the log rather than nowhere. */
  warn(message: string): void
}
/**
 * The facts a TAPD priority card shows from the bug's own Trigger. TAPD's priority is a suggestion only: the card says so,
 * because the ticket's level is the person's to decide.
 */
export function priorityFacts(origin: { meta: Record<string, unknown> } | undefined): PriorityFacts {
  const suggestion = tapdSuggestion(origin)
  const fact = (value: unknown): string | undefined => String(value ?? '').trim() || undefined
  return { shortId: fact(origin?.meta.shortId), status: fact(origin?.meta.status), tapdPriority: fact(origin?.meta.priority), suggestion,
    ...suggestion ? { reason: 'TAPD 自带优先级只作建议' } : {} }
}
/**
 * Sends a ticket's waiting priority question as a card, and its text when Feishu refuses the card.
 * @returns the sent message's id (card or fallback text), undefined when no chat is configured or nothing went out.
 */
export async function notifyPriority(host: PriorityHost, ticket: Ticket): Promise<string | undefined> {
  const ask = ticket.priorityAsk
  if (ask?.state !== 'pending') return undefined
  if (!host.sources.instance('feishu')?.enabled) { host.warn(`Ticket ${ticket.id}: its priority card needs the Feishu Source, which is off`); return undefined }
  // The ticket's own conversation first: the topic its replies moved to, else the Feishu chat it started in. A TAPD ticket
  // has neither, so the Source's intervention chat is the only place its question can reach a person.
  const channel = ticket.replyChannel ?? ticket.channels.find(item => item.source === 'feishu')
  const chat = channel?.address.chatId ?? notifyChat(host.store, ticket)
  const replyTo = channel?.address.messageId
  if (!chat) { host.warn(`Ticket ${ticket.id}: no Feishu conversation for its priority card; set a private chat in the Feishu Source`); return undefined }
  try {
    // The bug's Trigger is the ticket's origin, so its meta (short id, status and TAPD priority) gives the card its facts.
    const origin = host.store.triggers.get(ticket.origin.triggerId)
    const message = await sendCard(host, chat, priorityCard(ticket, ask, priorityFacts(origin)),
      `priority-${key('priority', ticket.id, ask.at)}`, replyTo)
    if (message) {
      const url = await messageLink(host, message).catch(() => undefined)
      const keep = Date.now() - CARD_KEEP_MS
      const cards = Object.fromEntries(Object.entries(host.store.get(KV.feishu.priorityCards) ?? {})
        .filter(([id, ref]) => id === message || Date.parse(ref.askAt) >= keep))
      host.store.set(KV.feishu.priorityCards, { ...cards, [message]: { ticketId: ticket.id, askAt: ask.at, ...url ? { url } : {} } })
    }
    return message
  } catch (error) {
    host.warn(`Ticket ${ticket.id}: its priority card could not be sent: ${String(error)}`)
    return undefined
  }
}
