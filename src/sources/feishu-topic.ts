/** Opens a Feishu topic for an accepted ticket and moves the ticket's replies there. */
import type { Ticket, ThreadRef } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { feishuPostContent } from './feishu-channel.ts'
import { SOURCE, feishuChannel } from './feishu-trigger.ts'
import type { FeishuConfig } from './feishu.ts'

/** The fields of `im +messages-mget` this module needs: the topic root's own thread and deep link. */
type FeishuMessageLookup = { message_id?: string; message_app_link?: string; thread_id?: string }

/** The short ticket id shown to people; the full id stays in the DSH panel and source records. */
export const shortTicketId = (ticket: Pick<Ticket, 'id'>): string => ticket.id.slice(0, 8)
/** A topic's root message is its title, so the title starts with the ticket brief; the link is the original request. */
export const topicText = (ticket: Pick<Ticket, 'id' | 'title'>, link?: string): string => {
  const title = ticket.title.trim() || '工单'
  const text = `「${title}」· 工单 ${shortTicketId(ticket)}`
  return link ? `${text}\n${link}` : text
}

/**
 * Creates the topic root message in the configured topic chat and moves the ticket's replies there. Feishu has no
 * rename API for a topic: its title is the root message's text, so the root carries the ticket brief and its short id.
 * A ticket whose replies were already moved is left alone, which also makes a repeated `ticket.created` harmless.
 */
export async function openFeishuTopic(ctx: SourceContext, ticket: Ticket): Promise<void> {
  const config = ctx.config<FeishuConfig>(SOURCE)
  const topicChat = config?.topicChat
  if (!topicChat || ticket.replyChannel) return
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  if (!trigger || trigger.source !== SOURCE || !trigger.channel) return
  const key = `topic-${ticket.id}`.slice(0, 50)
  const sent = await ctx.commands.lark<{ message_id?: string; thread_id?: string; data?: { message_id?: string; thread_id?: string } }>(
    ['im', '+messages-send', '--chat-id', topicChat, '--msg-type', 'post', '--content',
      feishuPostContent(topicText(ticket, trigger.url)), '--idempotency-key', key])
  const messageId = sent?.message_id ?? sent?.data?.message_id
  if (!messageId) throw new Error(`Feishu did not return the topic message id for ticket ${ticket.id}`)
  const thread: ThreadRef = { source: SOURCE, id: `${topicChat}:${messageId}` }
  const threadKey = `${thread.source}:${thread.id}`
  ctx.tickets.retarget(ticket.id, feishuChannel(topicChat, messageId), thread)
  ctx.threads.describe(threadKey, { label: topicText({ id: ticket.id, title: ticket.title }), ...(trigger.url ? { url: trigger.url } : {}) })
  // The send response often omits the thread id, and the topic's link is the root message's own deep link; one lookup
  // gives both. It must not fail the topic or the retarget, which already succeeded.
  let threadId = sent?.thread_id ?? sent?.data?.thread_id
  let link: string | undefined
  try {
    const found = await ctx.commands.lark<{ data?: { messages?: FeishuMessageLookup[] }; messages?: FeishuMessageLookup[] }>(
      ['im', '+messages-mget', '--message-ids', messageId])
    const message = [...found?.data?.messages ?? [], ...found?.messages ?? []].find(item => item.message_id === messageId)
    threadId ??= message?.thread_id
    link = message?.message_app_link
  } catch {
    // The topic exists and replies already moved; a lookup failure only drops the back-link below.
  }
  // The polling loop reads this Feishu thread id; a topic root has one, and without it the topic would not be polled.
  if (threadId) ctx.threads.patch(threadKey, { threadId })
  // Point the place the request started from at the topic, since the person now answers there.
  if (link) ctx.notify({ id: `topic-link-${ticket.id}`, channel: trigger.channel, text: `已开话题：${link}`, kind: 'reply', ticketId: ticket.id })
}
