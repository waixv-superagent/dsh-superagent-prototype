/** Editor presence: the last-input reading, its away threshold, and the cached reading the scheduler asks for. */
import { describe, expect, it, vi } from 'vitest'
import { AWAY_AFTER_MS, derivePresence, EditorPresence, parseIdleMilliseconds } from '../src/app/editor-presence.ts'

const T0 = Date.parse('2026-11-16T16:00:00.000Z')
const at = new Date(T0).toISOString()

describe('derivePresence', () => {
  it('reads input older than the away threshold as away, and the threshold itself as away', () => {
    expect(derivePresence(AWAY_AFTER_MS - 1, T0)).toEqual({ state: 'present', idleMs: AWAY_AFTER_MS - 1, at })
    expect(derivePresence(AWAY_AFTER_MS, T0)).toEqual({ state: 'away', idleMs: AWAY_AFTER_MS, at })
  })
  it('keeps a missing reading unknown, never away or present', () => {
    expect(derivePresence(null, T0)).toMatchObject({ state: 'unknown', idleMs: null, at,
      detail: expect.stringContaining('would not report the last input') })
  })
  it('parses only a whole non-negative number of milliseconds', () => {
    expect(parseIdleMilliseconds(' 12345\r\n')).toBe(12345)
    expect(parseIdleMilliseconds('0')).toBe(0)
    expect(parseIdleMilliseconds('-1')).toBeNull()
    expect(parseIdleMilliseconds('1.5')).toBeNull()
    expect(parseIdleMilliseconds('')).toBeNull()
    expect(parseIdleMilliseconds('error')).toBeNull()
  })
})

describe('EditorPresence cache', () => {
  it('starts a probe on the first read, then serves the cached reading until the interval passes', async () => {
    let now = 1_000, calls = 0
    const presence = new EditorPresence({ now: () => now, intervalMs: 100, probe: async () => { calls++; return 12_000 } })
    expect(presence.read()).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    expect(presence.read()).toMatchObject({ state: 'present', idleMs: 12_000 })
    now += 99
    expect(presence.read()).toMatchObject({ state: 'present' })
    expect(calls).toBe(1)
    now += 1
    presence.read()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(2)
  })
  it('reports a probe failure as unknown, which yields nothing, and keeps the reason internal', async () => {
    const warn = vi.fn()
    const presence = new EditorPresence({ probe: async () => { throw new Error('powershell missing') }, warn })
    await presence.refresh()
    expect(presence.read()).toMatchObject({ state: 'unknown', idleMs: null, detail: expect.stringContaining('would not report') })
    expect(warn).toHaveBeenCalledWith('editor presence probe failed: powershell missing')
  })
  it('does not replace the reading after disposal', async () => {
    let release: (value: number) => void = () => {}
    const probe = () => new Promise<number>(resolve => { release = resolve })
    const presence = new EditorPresence({ probe })
    const running = presence.refresh()
    presence.dispose()
    release(60_000)
    await running
    expect(presence.read()).toBeNull()
  })
})
