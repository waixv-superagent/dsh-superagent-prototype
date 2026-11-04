/**
 * The way back from a Feishu message to its ticket: the panel link a bot message carries, and the record of each message the
 * bot sent for a ticket, which the panel's search reads to turn a pasted message id, topic link or chat link into the ticket.
 * Imported by the web panel's views, so it must stay free of Node-only modules.
 */
import type { Key } from '../kv.ts'

/** One message the bot sent for a ticket: the chat it went to, the topic (thread) it sits in when Feishu named one, and when. */
export interface FeishuSent { ticketId: string; chatId: string; at: string; threadId?: string }
/** The panel page of one ticket; `?ticket=` opens it before the page the browser remembered. */
export const ticketPanelLink = (panelUrl: string, ticketId: string): string =>
  `${panelUrl.trim().replace(/\/+$/, '')}/?ticket=${encodeURIComponent(ticketId)}`
/** The footer line a ticket's bot message ends with; empty when no panel address is configured. */
export const ticketFooter = (panelUrl: string, ticketId: string): string =>
  panelUrl.trim() ? `[工单 ${ticketId.slice(0, 8)} ↗](${ticketPanelLink(panelUrl, ticketId)})` : ''
/**
 * `text` with the ticket footer on its own last line. The footer is added after the message text was checked against the IM
 * limit, so it never takes words from what the worker or orchestrator wrote.
 */
export const withTicketFooter = (text: string, panelUrl: string, ticketId: string | undefined): string => {
  const footer = ticketId ? ticketFooter(panelUrl, ticketId) : ''
  return footer ? `${text}\n${footer}` : text
}
/** The ids a pasted text names: Feishu message ids (`om_`), topic ids (`omt_`) and chat ids (`oc_`), each once. */
export function feishuIds(text: string): { messages: string[]; topics: string[]; chats: string[] } {
  const all = (pattern: RegExp) => [...new Set(text.match(pattern) ?? [])]
  return { messages: all(/\bom_[A-Za-z0-9]+/g), topics: all(/\bomt_[A-Za-z0-9]+/g), chats: all(/\boc_[A-Za-z0-9]+/g) }
}
/** The `thread_id` a `+messages-reply`/`+messages-send` answer carries, when it carries one. */
export function threadIdOf(output: unknown): string | undefined {
  let parsed = output
  if (typeof output === 'string') { try { parsed = JSON.parse(output) } catch { return undefined } }
  const data = (parsed as { data?: unknown } | undefined)?.data ?? parsed
  const id = (data as { thread_id?: unknown } | undefined)?.thread_id
  return typeof id === 'string' && id ? id : undefined
}
/** Records a sent message for the reverse lookup; a failure here must never fail the message, which already went out. */
export function rememberSent(state: { set<V>(key: Key<V>, value: V | undefined): void }, key: Key<FeishuSent>, record: FeishuSent): void {
  try { state.set(key, record) } catch { /* the message is sent; only its way back from Feishu is missing */ }
}
