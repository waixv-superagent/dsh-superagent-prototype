/** Feishu outbound channel: posts threaded bot replies, releases the receipt reactions they answer, and builds chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { releaseReceipt } from './feishu-receipt.ts'
import { feishuTriggerId } from './feishu-trigger.ts'
import type { ChannelHost, ChannelLink, ChannelLinks } from './kind.ts'

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
/** Full-width forms of the characters cmd re-reads; they read the same in a message and reach Feishu intact. */
const CMD_UNSAFE: Record<string, string> = { '<': '＜', '>': '＞', '&': '＆', '|': '｜', '^': '＾', '!': '！', '%': '％' }
/**
 * Feishu's CLI is a `.cmd` wrapper that re-runs the real CLI with `%*` under `EnableDelayedExpansion`, and Windows reaches it
 * through `cmd.exe /c`, so a message argument passes two cmd parsers. The JSON a reply needs is made of quotes, so cmd does
 * not keep it as one quoted word. Measured through that chain: `&` cuts the content at the character (a reply carrying
 * `「收集&更新飘带动画List」` arrived as invalid JSON and its tail ran as a command), `|` loses the argument, `<` and `>` are
 * redirections, `^` and `!` disappear without an error, and `%NAME%` expands. Full-width forms are the one rewrite that
 * survives both parsers, so every string that goes into a message passes through here.
 */
export const cmdSafe = (text: string): string => text.replace(/[<>&|^!%]/g, char => CMD_UNSAFE[char] ?? char)
/**
 * The `post` content JSON for Markdown text. `JSON.stringify` escapes every newline, so the whole message reaches the CLI
 * as one argument even through the Windows `.cmd` wrapper that `Commands` runs with `cmd.exe /c`; a literal newline there
 * would be cut at the first line by cmd before the CLI ever saw it.
 */
export const feishuPostContent = (text: string): string => JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } })
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
