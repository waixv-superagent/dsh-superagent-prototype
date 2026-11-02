/** Feishu outbound channel: posts threaded bot replies, releases the receipt reactions they answer, and builds chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { attentionCard, messageIdOf } from './feishu-card.ts'
import { releaseReceipt } from './feishu-receipt.ts'
import { cmdSafe, feishuPostContent } from './feishu-text.ts'
import { feishuTriggerId } from './feishu-trigger.ts'
import type { ChannelHost, ChannelLink, ChannelLinks } from './kind.ts'

export { cmdSafe, feishuPostContent } from './feishu-text.ts'
/** How long an attention card's message id is remembered for its button callback. */
const CARD_KEEP_MS = 48 * 3600_000

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
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
export async function sendFeishu(host: ChannelHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = cmdSafe(checkedImText(message.text))
  // A question with choices is a card: the click answers it without a chat round-trip. A card Feishu rejects falls back to
  // the plain text reply, so the question still reaches the person.
  if (message.attention) {
    try {
      const sent = await host.commands.lark<unknown>(['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'interactive',
        '--content', JSON.stringify(attentionCard(message.text, message.attention.attentionId, message.attention.options, message.attention.ticketId, message.attention.sections).card),
        '--reply-in-thread', '--idempotency-key', message.id])
      const id = messageIdOf(sent)
      if (id) {
        const keep = Date.now() - CARD_KEEP_MS
        const cards = Object.fromEntries(Object.entries(host.state.get(KV.feishu.attentionCards) ?? {})
          .filter(([key, ref]) => key === id || Date.parse(ref.at) >= keep))
        host.state.set(KV.feishu.attentionCards, { ...cards, [id]: { ticketId: message.attention.ticketId, attentionId: message.attention.attentionId, at: new Date().toISOString() } })
      }
      await releaseReceipt(host, messageId)
      return 'sent'
    } catch (error) {
      if (gone(error)) { await releaseReceipt(host, messageId); return 'gone' }
      // Fall through to the text reply; the question itself is already validated for the channel.
    }
  }
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'post', '--content', feishuPostContent(text), '--reply-in-thread', '--idempotency-key', message.id]
  let outcome: 'sent' | 'gone' = 'sent'
  try { await host.commands.lark(reply) }
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
