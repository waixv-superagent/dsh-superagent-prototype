/** Feishu outbound channel: posts threaded bot replies, releases the receipt reactions they answer, and builds chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { attentionCard, messageIdOf, messageLink, pipelineStageCard } from './feishu-card.ts'
import { rememberSent, threadIdOf, ticketPanelLink, withTicketFooter } from './feishu-sent.ts'
import { releaseReceipt } from './feishu-receipt.ts'
import { jsonForCmd, feishuPostContent } from './feishu-text.ts'
import { feishuTriggerId } from './feishu-trigger.ts'
import type { ChannelHost, ChannelLink, ChannelLinks } from './kind.ts'

export { feishuPostContent } from './feishu-text.ts'
/** How long an attention card's message id is remembered for its button callback. */
const CARD_KEEP_MS = 48 * 3600_000

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * Feishu documents the degraded scheme `feishu://applink/<path>` for AppLinks used outside Feishu: it opens the installed
 * client directly, while the `https://applink…` URL first renders Feishu's own landing page in the browser, which is the
 * tab a person has to close after answering. Non-AppLink URLs, such as another Source's, pass through unchanged.
 */
export const feishuClientLink = (url: string): string => url
  .replace(/^https:\/\/applink\.feishu\.cn\//i, 'feishu://applink/')
  .replace(/^https:\/\/applink\.larksuite\.com\//i, 'lark://applink/')
/**
 * True when an AppLink opens a particular message or topic rather than only its chat. A chat link lands on the
 * conversation and leaves a person to find the question themselves, so it is not a message link.
 */
export const isMessageLink = (url: string | undefined): url is string =>
  !!url && /\/client\/(?:thread|message)\/|[?&]position=/.test(url)
/** Drops the parameters that point a Feishu AppLink at one message, keeping every other part of the link. */
const withoutPosition = (url: string): string => {
  if (!/^(?:https:\/\/applink\.(?:feishu\.cn|larksuite\.com)|feishu:\/\/applink|lark:\/\/applink)\//i.test(url)) return url
  const [base = '', query = ''] = url.split('?')
  const kept = query.split('&').filter(part => part && !/^(?:thread_position|position)=/.test(part))
  return kept.length ? `${base}?${kept.join('&')}` : base
}
/**
 * The AppLink that opens a Feishu thread at its newest message. Feishu's per-message links carry `thread_position` (a chat
 * link its `position`), which lands in the middle of the conversation; the same link without it opens the topic at the
 * latest message, where the person can read on. A chat link cannot address the topic at all, so the topic is named
 * directly whenever the chat and thread ids are known. Only a card's own link keeps its position (see `questionUrl`).
 */
export function feishuTopicLink(input: { chatId?: string; threadId?: string; url?: string }): string | undefined {
  const { chatId, threadId, url } = input
  // A thread link already names its topic; only the position it points at has to go.
  const unpositioned = url === undefined ? undefined : withoutPosition(url)
  if (unpositioned && /\/client\/thread\/open/i.test(unpositioned)) return unpositioned
  if (chatId && threadId) {
    const brand = /(?:larksuite\.com|^lark:\/\/)/i.test(url ?? '') ? 'larksuite.com' : 'feishu.cn'
    return `https://applink.${brand}/client/thread/open?open_chat_id=${encodeURIComponent(chatId)}&open_thread_id=${encodeURIComponent(threadId)}`
  }
  return unpositioned
}
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, not found, or never
 * existed. Only a Feishu response carrying one of these errors means the target is gone; timeouts or crashes do not. The
 * invalid-id failure is matched by text because Feishu reports it in the message, and settling it keeps a reply that can
 * never succeed from retrying forever.
 */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 230011
  || (error.code !== undefined && Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message))
  || /withdrawn/i.test(error.message)
  || /\b99992354\b/.test(error.message) || /not a valid \{open_message_id\}/i.test(error.message))
/**
 * Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's
 * `message.id`). A reply that settled, sent or gone with the message it answered, ends the scope of the receipt reaction the
 * bot held on that message: the reply itself is the acknowledgement. A retryable failure keeps the receipt, since the Outbox
 * delivers that reply again.
 */
export async function sendFeishu(host: ChannelHost, message: OutboundMessage, config: { panelUrl?: string } = {}): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const checked = checkedImText(message.text)
  const panelUrl = config.panelUrl?.trim() ?? ''
  // The ticket link goes on after the limit check, so the footer never takes words from the message itself.
  const text = withTicketFooter(checked, panelUrl, message.ticketId)
  const chatId = message.channel.address.chatId ?? ''
  /** Keeps the way back from the bot's message to its ticket, for the panel's search. */
  const remember = (output: unknown): void => {
    const id = messageIdOf(output)
    const ticketId = message.ticketId ?? message.attention?.ticketId
    if (!id || !ticketId || !chatId) return
    const threadId = threadIdOf(output)
    rememberSent(host.state, KV.feishu.sent(id), { ticketId, chatId, at: new Date().toISOString(), ...threadId ? { threadId } : {} })
  }
  // A question with choices is a card: the click answers it without a chat round-trip. A card Feishu rejects falls back to
  // the plain text reply, so the question still reaches the person.
  if (message.attention) {
    try {
      const sent = await host.commands.lark<unknown>(['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'interactive',
        '--content', jsonForCmd(attentionCard(message.text, message.attention.attentionId, message.attention.options, message.attention.ticketId, message.attention.sections,
          panelUrl ? ticketPanelLink(panelUrl, message.attention.ticketId) : undefined).card),
        '--reply-in-thread', '--idempotency-key', message.id])
      const id = messageIdOf(sent)
      remember(sent)
      if (id) {
        // The card's own link is what the panel's answer button opens, so it lands on the question rather than the chat.
        const url = await messageLink(host, id).catch(() => undefined)
        const keep = Date.now() - CARD_KEEP_MS
        const cards = Object.fromEntries(Object.entries(host.state.get(KV.feishu.attentionCards) ?? {})
          .filter(([key, ref]) => key === id || Date.parse(ref.at) >= keep))
        host.state.set(KV.feishu.attentionCards, { ...cards, [id]: { ticketId: message.attention.ticketId,
          attentionId: message.attention.attentionId, at: new Date().toISOString(), ...url ? { url } : {} } })
      }
      await releaseReceipt(host, messageId)
      return 'sent'
    } catch (error) {
      if (gone(error)) { await releaseReceipt(host, messageId); return 'gone' }
      // Fall through to the text reply; the question itself is already validated for the channel.
    }
  }
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'post', '--content', feishuPostContent(text), '--reply-in-thread', '--idempotency-key', message.id]
  // A pipeline stage is a card with its links and actions; a card Feishu refuses falls back to the one-line text below.
  if (message.pipeline) {
    try {
      const sent = await host.commands.lark<unknown>(['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'interactive',
        '--content', jsonForCmd(pipelineStageCard(message.pipeline, checked).card), '--reply-in-thread', '--idempotency-key', message.id])
      const id = messageIdOf(sent)
      remember(sent)
      if (id && (message.pipeline.reviewers || message.pipeline.targets || message.pipeline.close || message.pipeline.rerun)) {
        const keep = Date.now() - CARD_KEEP_MS * 4
        const cards = Object.fromEntries(Object.entries(host.state.get(KV.feishu.pipelineCards) ?? {})
          .filter(([key, ref]) => key === id || Date.parse(ref.at) >= keep))
        host.state.set(KV.feishu.pipelineCards, { ...cards, [id]: { ticketId: message.pipeline.ticketId, at: new Date().toISOString() } })
      }
      await releaseReceipt(host, messageId)
      return 'sent'
    } catch (error) {
      if (gone(error)) { await releaseReceipt(host, messageId); return 'gone' }
    }
  }
  let outcome: 'sent' | 'gone' = 'sent'
  try { remember(await host.commands.lark(reply)) }
  catch (error) {
    if (!gone(error)) throw error
    outcome = 'gone'
  }
  await releaseReceipt(host, messageId)
  return outcome
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
