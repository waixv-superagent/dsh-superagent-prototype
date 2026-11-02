/**
 * Feishu receipt reactions as scoped resources: taking a message adds the bot's reaction and records which reaction it is,
 * and that record is released exactly once — when the reply for the message settles, or when the Source stops owing one.
 */
import { z } from 'zod'
import { liveTicket } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

/** The record of one receipt reaction: the Trigger the message was taken for, Feishu's ID of the reaction, and when it was added. */
export interface ReceiptReaction { triggerId: string; reactionId?: string; at: string }
/** What a receipt needs: the bot's CLI and the Source's own records. */
export type ReceiptHost = Pick<SourceContext, 'commands' | 'state'>
/** What a sweep asks: the receipt's own host, plus what the domain did with the Trigger the message was taken for. */
export type ReceiptSweepHost = Pick<SourceContext, 'commands' | 'state' | 'triggers' | 'tickets'>
/**
 * How long a receipt may stand when nothing settles it, such as a reply that never came or a run that ended before it could.
 * Replies and the sweep normally release a receipt long before; this only bounds a leftover nobody else removes.
 */
export const RECEIPT_LIFETIME_MS = 6 * 3600_000
/** `im reactions create` answers with the reaction it made; a response naming none leaves it findable only by listing the message's. */
const Created = z.looseObject({ reaction_id: z.string().optional() })
/** One message's reactions as `GET .../messages/{id}/reactions` lists them, with the operator each one belongs to. */
const ReactionPage = z.looseObject({ items: z.array(z.looseObject({ reaction_id: z.string(),
  operator: z.looseObject({ operator_id: z.string().optional(), operator_type: z.string().optional() }).optional() })).default([]) })

/** Every receipt the Source holds, by message ID: one record owns one reaction, and a message without an entry has none. */
const held = (host: ReceiptHost): Record<string, ReceiptReaction> => host.state.get(KV.feishu.receipts) ?? {}
/** Writes or (`undefined`) forgets the receipt of one message, dropping the family once it holds nothing. */
function hold(host: ReceiptHost, messageId: string, record: ReceiptReaction | undefined): void {
  const rest = { ...held(host) }
  if (record) rest[messageId] = record
  else delete rest[messageId]
  host.state.set(KV.feishu.receipts, Object.keys(rest).length ? rest : undefined)
}
/** True when Feishu says the reaction or its message is already gone, so the receipt is released either way. */
const absent = (error: unknown): boolean => error instanceof CliError
  && (error.code === 230011 || /not (?:exist|found)|no such|deleted|withdrawn/i.test(error.message))
/** The API path of one reaction on one message. */
const reactionPath = (messageId: string, reactionId: string): string =>
  `/open-apis/im/v1/messages/${messageId}/reactions/${encodeURIComponent(reactionId)}`
/** Deletes one reaction by the ID Feishu gave the bot when it added it. */
const deleteOne = async (host: ReceiptHost, messageId: string, reactionId: string): Promise<void> => {
  await host.commands.lark(['api', 'DELETE', reactionPath(messageId, reactionId)])
}
/** Deletes the bot's reactions on one message, for a receipt that never learned the ID of the reaction it added. */
async function deleteMine(host: ReceiptHost, messageId: string): Promise<void> {
  const appId = host.commands.deployment.feishu?.appId
  const page = ReactionPage.parse(await host.commands.lark(['api', 'GET', `/open-apis/im/v1/messages/${messageId}/reactions`,
    '--params', JSON.stringify({ page_size: 50 })]))
  for (const item of page.items) {
    const operator = item.operator ?? {}
    if (operator.operator_type !== 'app' || (appId !== undefined && operator.operator_id !== appId)) continue
    await deleteOne(host, messageId, item.reaction_id)
  }
}

/**
 * Takes a message with the bot's reaction, entering the scope that `releaseReceipt` leaves. The receipt is recorded before the
 * reaction is asked for, so a run that ends in between leaves the sweep a record it can release, and it is recorded again with
 * the reaction's ID once Feishu names it. A message that already holds a receipt keeps its reaction, since one record owns one
 * reaction and Feishu refuses a second identical one. A failed add never fails receiving: the record stays, and its release
 * finds nothing to delete.
 */
export async function takeReceipt(host: ReceiptHost, message: { triggerId: string; messageId: string }, emoji: string): Promise<void> {
  if (held(host)[message.messageId]) return
  const at = new Date().toISOString()
  hold(host, message.messageId, { triggerId: message.triggerId, at })
  let reactionId: string | undefined
  try {
    reactionId = Created.parse(await host.commands.lark(['im', 'reactions', 'create', '--message-id', message.messageId,
      '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } })])).reaction_id
  } catch { /* The receipt stays recorded without an ID, so a release lists the message's reactions instead. */ }
  if (reactionId) hold(host, message.messageId, { triggerId: message.triggerId, reactionId, at })
}

/**
 * Releases the receipt held for a message: deletes the reaction it names and forgets it, or drops it alone when Feishu no
 * longer has that reaction. A message the bot never took releases nothing, which is the usual case for a reply. Any other
 * Feishu failure keeps the record for the next sweep, because a reply that went out must stay delivered.
 */
export async function releaseReceipt(host: ReceiptHost, messageId: string): Promise<void> {
  const record = held(host)[messageId]
  if (!record) return
  let released = false
  try {
    if (record.reactionId) await deleteOne(host, messageId, record.reactionId)
    else await deleteMine(host, messageId)
    released = true
  } catch (error) { released = absent(error) }
  if (released) hold(host, messageId, undefined)
}

/**
 * Whether nothing will answer the message any more: a Decision was recorded that reached no live Ticket, or the Ticket the
 * message reached has ended. A Trigger whose receipt outlived its record is judged by its lifetime alone.
 */
function settled(ctx: ReceiptSweepHost, record: ReceiptReaction): boolean {
  const disposition = ctx.triggers.disposition(record.triggerId)
  // Queued for a fresh Eval, or received and not assessed yet: the Eval may still take the message, so the receipt stands.
  if (!disposition || disposition.requeued) return false
  const live = disposition.fanout.some(id => { const ticket = ctx.tickets.get(id); return !!ticket && liveTicket(ticket) })
  return !live && (disposition.decisionId !== undefined || disposition.fanout.length > 0)
}

/**
 * Releases every receipt nothing will settle: the work on its message ended (or never started), or the receipt outlived its
 * lifetime. Runs on the Source's own loop, so a reaction cannot outlive the reply it stands for.
 */
export async function sweepReceipts(ctx: ReceiptSweepHost, now = Date.now()): Promise<void> {
  for (const [messageId, record] of Object.entries(held(ctx))) {
    const expired = now - Date.parse(record.at) >= RECEIPT_LIFETIME_MS
    if (!expired && !settled(ctx, record)) continue
    await releaseReceipt(ctx, messageId)
    // A reaction this sweep could not remove keeps its record for the next one until its lifetime ends.
    if (expired) hold(ctx, messageId, undefined)
  }
}
