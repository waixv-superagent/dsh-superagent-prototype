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
import { takeTopicLink, topicLinkLine } from './feishu-topic-link.ts'
import type { ChannelHost, ChannelLink, ChannelLinks } from './kind.ts'

export { feishuPostContent } from './feishu-text.ts'
/** How long a question message's id and link are remembered for its button callback and the panel's answer button. */
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
/** The ids a Feishu thread AppLink names; Feishu's own links carry both the snake_case and the joined spellings. */
function threadIdsOf(url: string): { chatId?: string; threadId?: string } {
  // A stored link can carry a raw `%`; an id it cannot decode stays as written rather than failing the view.
  const decoded = (value: string): string => { try { return decodeURIComponent(value) } catch { return value } }
  const value = (name: string): string | undefined => {
    const found = new RegExp(`[?&]${name}=([^&#]+)`, 'i').exec(url)
    return found?.[1] ? decoded(found[1]) : undefined
  }
  return { chatId: value('open_chat_id') ?? value('openchatid'), threadId: value('open_thread_id') ?? value('openthreadid') }
}
/** A thread AppLink on the scheme and host the link already used; the client scheme carries no host. */
const threadAppLink = (scheme: 'https' | 'feishu' | 'lark', brand: 'feishu.cn' | 'larksuite.com', chatId: string, threadId: string): string => {
  const base = scheme === 'https' ? `https://applink.${brand}` : `${scheme}://applink`
  return `${base}/client/thread/open?open_chat_id=${encodeURIComponent(chatId)}&open_thread_id=${encodeURIComponent(threadId)}`
    + `&openchatid=${encodeURIComponent(chatId)}&openthreadid=${encodeURIComponent(threadId)}&thread_position=-1`
}
/**
 * The AppLink that opens a Feishu topic at its own root message. Feishu's client resolves a topic link through the root
 * message's `thread_position`, which is -1; a link that names none is read as position 0, and a topic that has no reply
 * yet has nothing there, so the click silently does nothing. Feishu's own message links therefore carry
 * `thread_position=-1` and both query spellings, and this rebuilds exactly that. A chat link cannot address the topic at
 * all, so the topic is named directly whenever the chat and thread ids are known; only a chat link without a topic id
 * falls back to the conversation at its newest message. A card's own link keeps its position (see `questionUrl`).
 */
export function feishuTopicLink(input: { chatId?: string; threadId?: string; url?: string }): string | undefined {
  const { chatId, threadId, url } = input
  if (url === undefined) return chatId && threadId ? threadAppLink('https', 'feishu.cn', chatId, threadId) : undefined
  const scheme = /^feishu:\/\//i.test(url) ? 'feishu' : /^lark:\/\//i.test(url) ? 'lark' : 'https'
  const brand = /(?:larksuite\.com|^lark:\/\/)/i.test(url) ? 'larksuite.com' : 'feishu.cn'
  // A thread link names its topic; a chat link names only the conversation it belongs to.
  const ids = threadIdsOf(url)
  const chat = chatId ?? ids.chatId
  const thread = threadId ?? ids.threadId
  if (chat && thread) return threadAppLink(scheme, brand, chat, thread)
  // An unreadable topic link keeps its own position rather than losing the only way into the topic.
  if (/\/client\/thread\/open/i.test(url)) return url
  return withoutPosition(url)
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
  // A ticket's acceptance receipt is its first message; the topic opened for the same ticket folds into it, so one message
  // says what was accepted and where the conversation continues. The link line goes on after the limit check, like the
  // footer, and a receipt that waited too long goes out without it while the opener posts its notice instead.
  const topic = message.kind === 'acknowledgement' && message.ticketId ? await takeTopicLink(host.state, message.ticketId) : undefined
  // The ticket link goes on after the limit check, so the footer never takes words from the message itself.
  const text = withTicketFooter(topic ? `${checked}\n${topicLinkLine(topic.title, topic.url)}` : checked, panelUrl, message.ticketId)
  const chatId = message.channel.address.chatId ?? ''
  /** Keeps the way back from the bot's message to its ticket, for the panel's search. */
  const remember = (output: unknown): void => {
    const id = messageIdOf(output)
    const ticketId = message.ticketId ?? message.attention?.ticketId
    if (!id || !ticketId || !chatId) return
    const threadId = threadIdOf(output)
    rememberSent(host.state, KV.feishu.sent(id), { ticketId, chatId, at: new Date().toISOString(), ...threadId ? { threadId } : {} })
  }
  // A question with choices is a card: the click answers it without a chat round-trip. A question without choices is the
  // plain text reply below, and a card Feishu rejects falls back to it, so the question still reaches the person.
  if (message.attention?.options.length) {
    try {
      const sent = await host.commands.lark<unknown>(['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'interactive',
        '--content', jsonForCmd(attentionCard(message.text, message.attention.attentionId, message.attention.options, message.attention.ticketId, message.attention.sections,
          panelUrl ? ticketPanelLink(panelUrl, message.attention.ticketId) : undefined).card),
        '--reply-in-thread', '--idempotency-key', message.id])
      remember(sent)
      await rememberQuestion(host, message.attention, sent)
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
        '--content', jsonForCmd(pipelineStageCard(message.pipeline, checked, panelUrl ? ticketPanelLink(panelUrl, message.pipeline.ticketId) : undefined).card), '--reply-in-thread', '--idempotency-key', message.id])
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
  try {
    const sent = await host.commands.lark(reply)
    remember(sent)
    if (message.attention) await rememberQuestion(host, message.attention, sent)
  }
  catch (error) {
    if (!gone(error)) throw error
    outcome = 'gone'
  }
  await releaseReceipt(host, messageId)
  return outcome
}
/**
 * Records where a question was asked, as a card or as text alike: the message id lets a choice's button find the question,
 * and its own link is what the panel's answer button opens, so it lands on the question rather than the chat. Entries older
 * than a button token's lifetime go, so the map stays small; `fillLinks` retries a link that could not be fetched here.
 */
async function rememberQuestion(host: ChannelHost, attention: NonNullable<OutboundMessage['attention']>, output: unknown): Promise<void> {
  const id = messageIdOf(output)
  if (!id) return
  const url = await messageLink(host, id).catch(() => undefined)
  const keep = Date.now() - CARD_KEEP_MS
  const cards = Object.fromEntries(Object.entries(host.state.get(KV.feishu.attentionCards) ?? {})
    .filter(([key, ref]) => key === id || Date.parse(ref.at) >= keep))
  host.state.set(KV.feishu.attentionCards, { ...cards, [id]: { ticketId: attention.ticketId,
    attentionId: attention.attentionId, at: new Date().toISOString(), ...url ? { url } : {} } })
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
