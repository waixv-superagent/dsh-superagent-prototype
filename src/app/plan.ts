/**
 * Sends a ticket's P1 plan to the person who decides it, in the ticket's Feishu conversation: the topic its replies moved to,
 * else the chat the ticket started in, so a person who works in that thread can see and click it. Without a Feishu
 * conversation it uses the private chat the Feishu Source names for intervention cards. The card itself is built by
 * `sources/feishu-card.ts`.
 */
import { key, pendingPlan, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { planCard, messageLink, sendCard } from '../sources/feishu-card.ts'
import type { Store } from './store.ts'

/** How long a plan card's message id is remembered for its button callback; the card's delayed-update token lasts 30 minutes. */
const CARD_KEEP_MS = 48 * 3600_000
export interface PlanHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'triggers' | 'get' | 'set'>
  readonly sources: Pick<SourceRegistry, 'instance'>
  readonly commands: Pick<Commands, 'lark'>
  /** Reports a card that could not be sent, so the failure appears in the log rather than nowhere. */
  warn(message: string): void
}

/** Where intervention cards go: the configured private chat, else the direct chat a trigger came from, else none. */
export function notifyChat(store: Pick<Store, 'settings' | 'triggers'>, ticket: Pick<Ticket, 'origin'>): string | undefined {
  const config = store.settings().sources.feishu?.config ?? {}
  const configured = typeof config.notifyChat === 'string' ? config.notifyChat.trim() : ''
  if (configured) return configured
  const trigger = store.triggers.get(ticket.origin.triggerId)
  if (trigger?.source !== 'feishu' || trigger.meta.direct !== true) return undefined
  return trigger.channel?.address.chatId ?? (typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : undefined)
}
/**
 * Sends a ticket's waiting plan as a card, and its text when Feishu refuses the card.
 * @returns the sent message's id (card or fallback text), undefined when no chat is configured or nothing went out.
 */
export async function notifyPlan(host: PlanHost, ticket: Ticket): Promise<string | undefined> {
  const plan = pendingPlan(ticket)
  if (!plan) return undefined
  if (!host.sources.instance('feishu')?.enabled) { host.warn(`Ticket ${ticket.id}: its plan card needs the Feishu Source, which is off`); return undefined }
  // The ticket's own conversation first: the topic its replies moved to, else the Feishu chat it started in. The private
  // chat is only for a ticket with no Feishu conversation at all.
  const channel = ticket.replyChannel ?? ticket.channels?.find(item => item.source === 'feishu')
  const chat = channel?.address.chatId ?? notifyChat(host.store, ticket)
  const replyTo = channel?.address.messageId
  if (!chat) { host.warn(`Ticket ${ticket.id}: no Feishu conversation for its plan card; set a private chat in the Feishu Source`); return undefined }
  try {
    const message = await sendCard(host, chat, planCard(ticket, plan), `plan-${key('plan', ticket.id, plan.at)}`, replyTo)
    // Remember which plan the card asks about, so its buttons can decide without matching a chat thread, and drop old entries.
    if (message) {
      // The card's own link, so the panel's answer button opens the question instead of the chat's newest message.
      const url = await messageLink(host, message).catch(() => undefined)
      const keep = Date.now() - CARD_KEEP_MS
      const cards = Object.fromEntries(Object.entries(host.store.get(KV.feishu.cards) ?? {})
        .filter(([id, ref]) => id === message || Date.parse(ref.planAt) >= keep))
      host.store.set(KV.feishu.cards, { ...cards, [message]: { ticketId: ticket.id, planAt: plan.at, ...url ? { url } : {} } })
    }
    return message
  } catch (error) {
    host.warn(`Ticket ${ticket.id}: its plan card could not be sent: ${String(error)}`)
    return undefined
  }
}
