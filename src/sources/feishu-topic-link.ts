/**
 * The topic link a ticket's acceptance receipt carries instead of a second "已开话题" message: the Feishu Source opens the
 * topic right after the ticket is created, while the receipt is already queued, so the receipt waits here for the topic's
 * own link and folds it into that one message. The opener registers before its first Feishu call, in the same synchronous
 * step that queues the receipt, so the receipt always finds the wait; a link that was settled is kept in the Source's KV
 * state, so a receipt delivered after a restart still carries it.
 */
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

/** The topic a receipt points at: the link to open, the ticket brief its title starts with, and the conversation it opens. */
export interface TopicLink { url: string; title: string; chatId?: string; messageId?: string }

/** How long a receipt waits for its ticket's topic before it goes without the link; the opener then posts its own notice. */
export const TOPIC_WAIT_MS = 10_000
/** How long a settled link stays available to a receipt retried after a failed send, or delivered after a restart. */
const LINK_KEEP_MS = 60 * 60_000

type LinkState = Pick<SourceContext['state'], 'get' | 'set'>

interface Waiting {
  promise: Promise<TopicLink | undefined>
  resolve: (link: TopicLink | undefined) => void
  /** The receipt gave up waiting, so the opener still has to say where the topic is. */
  abandoned: boolean
}
const waiting = new Map<string, Waiting>()

/** The one line a receipt or a ticket's own notice uses for its topic: a described link, never the long raw AppLink. */
export const topicLinkLine = (title: string, url: string): string => {
  const brief = Array.from((title.trim() || '工单').replace(/[[\]]/g, '').replace(/\s+/g, ' ')).slice(0, 24).join('')
  return `已开话题：[「${brief}」](${url})`
}

/** Starts the wait for the topic of `ticketId`; the receipt queued for the same ticket takes the link it settles with. */
export function expectTopicLink(ticketId: string): void {
  if (waiting.has(ticketId)) return
  let resolve!: (link: TopicLink | undefined) => void
  const promise = new Promise<TopicLink | undefined>(done => { resolve = done })
  waiting.set(ticketId, { promise, resolve, abandoned: false })
}

/**
 * The receipt's side: the topic's link when it settles within `timeoutMs`, else the link kept from an earlier settle, or
 * nothing. A receipt that had to wait and timed out marks the wait abandoned, so the opener posts the notice the receipt
 * could not carry.
 */
export async function takeTopicLink(state: LinkState, ticketId: string, timeoutMs = TOPIC_WAIT_MS): Promise<TopicLink | undefined> {
  const entry = waiting.get(ticketId)
  if (!entry) {
    const saved = state.get(KV.feishu.topicLinks) ?? {}
    const link = saved[ticketId]
    // A link settled by an older build names no conversation; it still opens the topic, so a receipt keeps it.
    return link && Date.now() - Date.parse(link.at) < LINK_KEEP_MS
      ? { url: link.url, title: link.title, ...link.chatId ? { chatId: link.chatId } : {}, ...link.messageId ? { messageId: link.messageId } : {} }
      : undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), timeoutMs) })
  const link = await Promise.race([entry.promise, timeout])
  clearTimeout(timer)
  if (link) return link
  entry.abandoned = true
  return undefined
}

/**
 * The opener's side: settles the wait with the topic's link, or with nothing when the topic could not be resolved.
 * Returns whether the receipt already gave up, so the opener has to post the notice itself; a link is kept for a receipt
 * that is retried or delivered after a restart, and one nobody took is forgotten.
 */
export function settleTopicLink(state: LinkState, ticketId: string, link: TopicLink | undefined): boolean {
  const entry = waiting.get(ticketId)
  if (!entry) return false
  waiting.delete(ticketId)
  if (entry.abandoned) return true
  entry.resolve(link)
  if (link) {
    const keep = Date.now() - LINK_KEEP_MS
    const links = Object.fromEntries(Object.entries(state.get(KV.feishu.topicLinks) ?? {})
      .filter(([id, saved]) => id === ticketId || Date.parse(saved.at) >= keep))
    state.set(KV.feishu.topicLinks, { ...links, [ticketId]: { ...link, at: new Date().toISOString() } })
  }
  return false
}
