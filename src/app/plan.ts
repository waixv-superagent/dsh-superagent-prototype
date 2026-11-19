/**
 * Sends a ticket's P1 plan to the person who decides it, in the ticket's Feishu conversation: the topic its replies moved to,
 * else the chat the ticket started in, so a person who works in that thread can see and click it. Without a Feishu
 * conversation it uses the private chat the Feishu Source names for intervention cards, or the fixed topic chat, which takes
 * a ticket from another Source as a new topic. The card itself is built by `sources/feishu-card.ts`.
 */
import { grillWaiting, key, pendingPlan, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { grillCard, planCard, messageLink, sendCard } from '../sources/feishu-card.ts'
import { ticketOpenLink } from '../sources/feishu-sent.ts'
import type { SurfaceState } from './surface.ts'
import type { Store } from './store.ts'

/** How long a plan card's message id is remembered for its button callback; the card's delayed-update token lasts 30 minutes. */
const CARD_KEEP_MS = 48 * 3600_000
export interface PlanHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'triggers' | 'get' | 'set'>
  readonly sources: Pick<SourceRegistry, 'instance'>
  readonly commands: Pick<Commands, 'lark'>
  /** Reports the panel address a browser was last seen at, so a card links an address nobody configured by hand. */
  readonly surfaces: Pick<SurfaceState, 'panelBase'>
  /** Reports a card that could not be sent, so the failure appears in the log rather than nowhere. */
  warn(message: string): void
}

/** The panel page of the ticket: the configured address, else the origin the browser last used, else none. */
export function panelLinkOf(host: { sources: Pick<SourceRegistry, 'instance'>; surfaces: Pick<SurfaceState, 'panelBase'> },
  ticketId: string): string | undefined {
  const configured = host.sources.instance<{ panelUrl?: string }>('feishu')?.config?.panelUrl ?? ''
  const base = host.surfaces.panelBase(configured)
  return base ? ticketOpenLink(base, ticketId) : undefined
}
/**
 * Where intervention cards go when the ticket has no Feishu conversation of its own: the configured private chat, else the
 * direct chat a Feishu trigger came from, else the fixed topic chat, which takes a ticket from another Source as a new
 * topic. The topic chat is what makes a plan card reach a person for a ticket the panel, GitHub or TAPD started.
 */
export function notifyChat(store: Pick<Store, 'settings' | 'triggers'>, ticket: Pick<Ticket, 'origin'>): string | undefined {
  const config = store.settings().sources.feishu?.config ?? {}
  const configured = typeof config.notifyChat === 'string' ? config.notifyChat.trim() : ''
  if (configured) return configured
  const trigger = store.triggers.get(ticket.origin.triggerId)
  if (trigger?.source === 'feishu' && trigger.meta.direct === true) return trigger.channel?.address.chatId ?? (typeof trigger.meta.chatId === 'string' ? trigger.meta.chatId : undefined)
  const topicChat = typeof config.topicChat === 'string' ? config.topicChat.trim() : ''
  return topicChat || undefined
}
/**
 * Sends a ticket's waiting plan as a card, and its text when Feishu refuses the card.
 * @returns the sent message's id (card or fallback text), undefined when no chat is configured or nothing went out.
 */
export async function notifyPlan(host: PlanHost, ticket: Ticket): Promise<string | undefined> {
  const plan = pendingPlan(ticket)
  if (!plan) return undefined
  if (!host.sources.instance('feishu')?.enabled) { host.warn(`Ticket ${ticket.id}: its plan card needs the Feishu Source, which is off`); return undefined }
  // The ticket's own conversation first: the topic its replies moved to, which the Feishu Source opens for every ticket,
  // else the Feishu chat it started in. The private or fixed topic chat is only for a ticket with no conversation at all.
  const channel = ticket.replyChannel ?? ticket.channels?.find(item => item.source === 'feishu')
  const chat = channel?.address.chatId ?? notifyChat(host.store, ticket)
  const replyTo = channel?.address.messageId
  if (!chat) { host.warn(`Ticket ${ticket.id}: no Feishu conversation for its plan card; set the Topic chat or a private chat in the Feishu Source`); return undefined }
  try {
    const message = await sendCard(host, chat, planCard(ticket, plan, panelLinkOf(host, ticket.id)), `plan-${key('plan', ticket.id, plan.at)}`, replyTo)
    // Remember which plan the card asks about, so its buttons can decide without matching a chat thread, and drop old entries.
    if (message) {
      host.store.set(KV.feishu.sent(message), { ticketId: ticket.id, chatId: chat, at: new Date().toISOString() })
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
/**
 * Sends a ticket's waiting structured grill as one form card in the same Feishu conversation its plan card uses, and its
 * text when Feishu refuses the card. The message mapping lets a submit answer that grill without a Trigger, and the card's
 * own link lets the panel open the question.
 * @returns the sent message's id (card or fallback text), undefined when no chat is configured, nothing went out, or the
 * grill was already answered.
 */
export async function notifyGrill(host: PlanHost, ticket: Ticket): Promise<string | undefined> {
  const grill = grillWaiting(ticket)
  if (!grill) return undefined
  if (!host.sources.instance('feishu')?.enabled) { host.warn(`Ticket ${ticket.id}: its grill card needs the Feishu Source, which is off`); return undefined }
  const channel = ticket.replyChannel ?? ticket.channels?.find(item => item.source === 'feishu')
  const chat = channel?.address.chatId ?? notifyChat(host.store, ticket)
  const replyTo = channel?.address.messageId
  if (!chat) { host.warn(`Ticket ${ticket.id}: no Feishu conversation for its grill card; set the Topic chat or a private chat in the Feishu Source`); return undefined }
  try {
    const message = await sendCard(host, chat, grillCard(ticket, grill, panelLinkOf(host, ticket.id)), `grill-${key('grill', ticket.id, grill.at)}`, replyTo)
    if (message) {
      host.store.set(KV.feishu.sent(message), { ticketId: ticket.id, chatId: chat, at: new Date().toISOString() })
      const url = await messageLink(host, message).catch(() => undefined)
      const keep = Date.now() - CARD_KEEP_MS
      const cards = Object.fromEntries(Object.entries(host.store.get(KV.feishu.grillCards) ?? {})
        .filter(([id, ref]) => id === message || Date.parse(ref.at) >= keep))
      host.store.set(KV.feishu.grillCards, { ...cards, [message]: { ticketId: ticket.id, grillId: grill.id, at: grill.at, ...url ? { url } : {} } })
    }
    return message
  } catch (error) {
    host.warn(`Ticket ${ticket.id}: its grill card could not be sent: ${String(error)}`)
    return undefined
  }
}
