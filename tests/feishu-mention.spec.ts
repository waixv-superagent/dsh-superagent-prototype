import { describe, expect, it } from 'vitest'
import { claimMention, mentionIds, mentionLine, MENTION_BUDGET, MENTION_GAP_MS } from '../src/sources/feishu-mention.ts'

/** The Source KV a mention budget lives in; the same shape the Store and a Source context expose. */
function memory() {
  const values = new Map<string, unknown>()
  return {
    get: <V,>(key: string) => values.get(key) as V | undefined,
    set: <V,>(key: string, value: V | undefined) => { if (value === undefined) values.delete(key); else values.set(key, value) },
  }
}

describe('Feishu mentions', () => {
  it('keeps only unique open ids, so a login or a bot app id never becomes card markup', () => {
    expect(mentionIds(['ou_a', 'ou_b', 'ou_a', 'zhangsan', 'cli_1', undefined])).toEqual(['ou_a', 'ou_b'])
    expect(mentionLine(['ou_a'], '请确认这张方案')).toBe('<at id=ou_a></at> 请确认这张方案')
    expect(mentionLine(['zhangsan'], '请确认')).toBe('')
    expect(mentionLine(['ou_a', 'zhangsan'], 'a<b')).toBe('<at id=ou_a></at> a＜b')
  })

  it('claims one mention per ticket, then holds the rest inside the budget and the gap', () => {
    const state = memory()
    const at = Date.parse('2026-11-19T00:00:00Z')
    expect(claimMention(state, 't1', at)).toBe(true)
    expect(claimMention(state, 't1', at + 60_000)).toBe(false)
    expect(claimMention(state, 't1', at + MENTION_GAP_MS)).toBe(true)
    expect(claimMention(state, 't2', at + MENTION_GAP_MS)).toBe(true)
  })

  it('stops at the per-ticket budget even after the gap', () => {
    const state = memory()
    const start = Date.parse('2026-11-19T00:00:00Z')
    for (let index = 0; index < MENTION_BUDGET; index++) expect(claimMention(state, 't1', start + index * MENTION_GAP_MS)).toBe(true)
    expect(claimMention(state, 't1', start + MENTION_BUDGET * MENTION_GAP_MS)).toBe(false)
  })

  it('sends the mention when the budget record cannot be read, rather than losing the notification', () => {
    const broken = { get: () => { throw new Error('db closed') }, set: () => {} }
    expect(claimMention(broken, 't1')).toBe(true)
  })
})
