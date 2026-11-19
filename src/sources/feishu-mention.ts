/**
 * Outbound Feishu mentions: the open ids a milestone message may carry, the card markup, and the small per-ticket budget
 * that keeps a burst of plan or pipeline cards from paging a person repeatedly (docs/012).
 */
import { KV, type Key } from '../kv.ts'
import { FEISHU_OPEN_ID, textSafe } from './feishu-text.ts'

/** At most this many mentions per ticket, and none within the gap after the last one, however many cards follow. */
export const MENTION_BUDGET = 6
export const MENTION_GAP_MS = 10 * 60_000

/** The KV state a mention budget lives in; both the Store and a Source's context satisfy it. */
export interface MentionState {
  get<V>(key: Key<V>): V | undefined
  set<V>(key: Key<V>, value: V | undefined): void
}

/** The unique Feishu open_ids of `ids`; anything else is dropped rather than put in card markup. */
export const mentionIds = (ids: readonly (string | undefined)[] | undefined): string[] =>
  [...new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && FEISHU_OPEN_ID.test(id)))]

/**
 * The card markdown that mentions `ids`, followed by `note`: at tags are card structure, so they bypass `textSafe` while
 * the note still goes through it. Empty when no id survives the filter, which is what makes a card text-only.
 */
export function mentionLine(ids: readonly string[], note = ''): string {
  const valid = mentionIds(ids)
  if (!valid.length) return ''
  const tags = valid.map(id => `<at id=${id}></at>`).join(' ')
  return `${tags}${note ? ` ${textSafe(note)}` : ''}`
}

/**
 * Claims one mention for `ticketId` under the budget and the gap, recording it before the message goes out. False means
 * this message is sent without an @. A failed read or write sends the mention rather than swallowing the notification.
 */
export function claimMention(state: MentionState, ticketId: string, now = Date.now()): boolean {
  try {
    const all = state.get(KV.feishu.mentions) ?? {}
    const last = all[ticketId]
    if (last && (last.count >= MENTION_BUDGET || now - Date.parse(last.at) < MENTION_GAP_MS)) return false
    state.set(KV.feishu.mentions, { ...all, [ticketId]: { count: (last?.count ?? 0) + 1, at: new Date(now).toISOString() } })
    return true
  } catch { return true }
}
