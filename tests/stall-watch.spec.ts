import { describe, expect, it } from 'vitest'
import { StallWatch, stallText, TOOL_GRACE_MS, type StallWatchHost } from '../src/app/stall-watch.ts'
import type { ActivityView } from '../src/app/activity.ts'
import type { Assignment, ChannelRef, OutboundMessage, Ticket } from '../src/core/index.ts'
import type { HealthEntry } from '../src/infra/health.ts'
import { SettingsSchema, StallConfigSchema } from '../src/policy.ts'
import { wordCount } from '../src/infra/text.ts'

const NOW = Date.parse('2026-11-04T04:08:00Z')
const MIN = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()
const CHANNEL: ChannelRef = { source: 'feishu', address: { chatId: 'oc_x' } } as unknown as ChannelRef

function ticket (assignments: Assignment[], overrides: Partial<Ticket> = {}): Ticket {
  return { id: 'c559cd6eaec4d0cf5b1920492ee8d446', title: '跳跃曲线改延迟 + 起跳速度', decisionId: 'd',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' },
    channels: [CHANNEL], assignments, inputs: [], undelivered: [], createdAt: iso(NOW - 120 * MIN), updatedAt: iso(NOW - 120 * MIN),
    origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides }
}
const running = (startedAt: number, extra: Partial<Assignment> = {}): Assignment =>
  ({ id: 'a1', state: 'running', createdAt: iso(startedAt), startedAt: iso(startedAt), ...extra })
const idleActivity: ActivityView = { live: false, updatedAt: 0, tool: null, recent: [] }

function harness (tickets: Ticket[], options: { activity?: ActivityView; background?: boolean; stall?: object; request?: string } = {}) {
  const sent: OutboundMessage[] = []
  const health = { value: { state: 'ready', detail: '' } as { state: string; detail: string } }
  const entry: HealthEntry = { get: () => health.value as never, set: value => { health.value = value }, release: () => {} }
  const state = { paused: false, now: NOW, tickets, activity: options.activity ?? idleActivity, background: options.background ?? false }
  const settings = SettingsSchema.parse({ executor: { stall: options.stall ?? {} } })
  const host: StallWatchHost = { tickets: { open: () => state.tickets }, settings: () => settings,
    activity: { read: () => state.activity }, background: () => state.background, channel: item => item.channels[0],
    request: () => options.request ?? '帮我看看跳跃', outbox: { send: message => { sent.push(message) } }, health: entry,
    paused: () => state.paused, now: () => state.now }
  return { watch: new StallWatch(host), sent, health, state }
}

describe('StallWatch', () => {
  it('announces a working ticket once it made no progress for the threshold, and only once', () => {
    const h = harness([ticket([running(NOW - 14 * MIN)])])
    expect(h.watch.poll()).toEqual([])
    expect(h.sent).toEqual([])
    h.state.now = NOW + MIN
    expect(h.watch.poll().map(item => [item.kind, item.minutes])).toEqual([['working', 15]])
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ channel: CHANNEL, kind: 'notice', ticketId: 'c559cd6eaec4d0cf5b1920492ee8d446' })
    expect(h.sent[0]!.text).toContain('15 分钟没有进展')
    expect(h.sent[0]!.text).toContain('c559cd6e')
    expect(h.health.value).toMatchObject({ state: 'error' })
    expect(h.watch.status()).toMatchObject({ tickets: 1 })
    // Later looks of the same stall keep the same message id, which the Outbox's receipts send only once.
    h.state.now = NOW + 30 * MIN
    h.watch.poll()
    expect(new Set(h.sent.map(message => message.id)).size).toBe(1)
  })

  it('counts from the latest progress: a report, a turn end, a delivered Input or the live Session activity', () => {
    const since = NOW - 40 * MIN
    const reported = ticket([running(since, { report: { state: 'progress', summary: 'x', at: iso(NOW - 5 * MIN) } })])
    expect(harness([reported]).watch.poll()).toEqual([])
    expect(harness([ticket([running(since, { idleAt: iso(NOW - 5 * MIN) })])]).watch.poll()).toEqual([])
    expect(harness([ticket([running(since, { deliveredAt: iso(NOW - 5 * MIN) })])]).watch.poll()).toEqual([])
    const active = harness([ticket([running(since)])], { activity: { ...idleActivity, live: true, updatedAt: NOW - 2 * MIN } })
    expect(active.watch.poll()).toEqual([])
    // New progress after an alert starts a new count, and the next stall is a new message.
    const h = harness([ticket([running(since)])])
    h.watch.poll()
    h.state.tickets = [ticket([running(since, { report: { state: 'progress', summary: 'x', at: iso(NOW + MIN) } })])]
    h.state.now = NOW + 2 * MIN
    expect(h.watch.poll()).toEqual([])
    expect(h.health.value.state).toBe('ready')
    h.state.now = NOW + 20 * MIN
    h.watch.poll()
    expect(new Set(h.sent.map(message => message.id)).size).toBe(2)
  })

  it('leaves a running tool and background work alone, but not a tool that never returns', () => {
    const tool = { name: 'pwsh', digest: 'pnpm test', elapsed: 20 * MIN }
    const busy = harness([ticket([running(NOW - 40 * MIN)])], { activity: { live: true, updatedAt: NOW - 20 * MIN, tool, recent: [] } })
    expect(busy.watch.poll()).toEqual([])
    expect(harness([ticket([running(NOW - 40 * MIN)])], { background: true }).watch.poll()).toEqual([])
    const hung = { ...tool, elapsed: TOOL_GRACE_MS + MIN }
    const h = harness([ticket([running(NOW - 120 * MIN)])], { activity: { live: true, updatedAt: NOW - 61 * MIN, tool: hung, recent: [] } })
    expect(h.watch.poll()).toMatchObject([{ kind: 'working', minutes: 61, lastTool: 'pwsh', toolRunning: true }])
    expect(h.sent[0]!.text).toContain('`pwsh` 一直在运行')
  })

  it('names the last tool the worker called', () => {
    const recent = [{ name: 'mcp__ue__run_pie', digest: '', at: NOW - 30 * MIN, endedAt: NOW - 29 * MIN }]
    const h = harness([ticket([running(NOW - 60 * MIN)])], { activity: { live: false, updatedAt: NOW - 29 * MIN, tool: null, recent } })
    h.watch.poll()
    expect(h.sent[0]!.text).toContain('最后一步：`mcp__ue__run_pie`')
  })

  it('announces a ticket queued past its own threshold', () => {
    const queued = ticket([{ id: 'a1', state: 'pending', createdAt: iso(NOW - 31 * MIN) }])
    const h = harness([queued])
    expect(h.watch.poll()).toMatchObject([{ kind: 'queued', minutes: 31 }])
    expect(h.sent[0]!.text).toContain('已排队 31 分钟')
    expect(harness([ticket([{ id: 'a1', state: 'pending', createdAt: iso(NOW - 20 * MIN) }])]).watch.poll()).toEqual([])
  })

  it('stays silent while paused, for a ticket that waits for a person, is idle or ended, or has no conversation', () => {
    const stale = ticket([running(NOW - 60 * MIN)])
    const paused = harness([stale])
    paused.state.paused = true
    expect(paused.watch.poll()).toEqual([])
    expect(paused.sent).toEqual([])
    const blocked = ticket([running(NOW - 60 * MIN, { report: { state: 'blocked', summary: 'x', at: iso(NOW - 60 * MIN) } })])
    const asking = ticket([running(NOW - 60 * MIN)], { attention: { id: 'q', question: '?' } })
    const idle = ticket([{ ...running(NOW - 60 * MIN), state: 'ended', endedAt: iso(NOW - 60 * MIN) }])
    const ended = ticket([running(NOW - 60 * MIN)], { ended: { at: iso(NOW - 60 * MIN), by: 'human', outcome: 'stopped' } })
    const h = harness([blocked, asking, idle, ended])
    expect(h.watch.poll()).toEqual([])
    const silent = harness([ticket([running(NOW - 60 * MIN)], { channels: [] })])
    expect(silent.watch.poll()).toHaveLength(1)
    expect(silent.sent).toEqual([])
  })

  it('keeps the alert on the board and the status card only when notify is off, and follows the configured minutes', () => {
    const h = harness([ticket([running(NOW - 20 * MIN)])], { stall: { notify: false } })
    expect(h.watch.poll()).toHaveLength(1)
    expect(h.sent).toEqual([])
    expect(h.health.value.state).toBe('error')
    expect(harness([ticket([running(NOW - 20 * MIN)])], { stall: { minutes: 30 } }).watch.poll()).toEqual([])
  })

  it('stops looking after stop', () => {
    const h = harness([ticket([running(NOW - 60 * MIN)])])
    h.watch.stop()
    h.watch.poll()
    expect(h.sent).toEqual([])
  })
})

describe('stallText', () => {
  const owner = { id: 'c559cd6eaec4d0cf5b1920492ee8d446' }
  it('fits in three short lines under the IM limit, in the request\'s language', () => {
    const zh = stallText({ ticketId: owner.id, title: '一'.repeat(80), kind: 'working', minutes: 15, lastTool: 'pwsh' }, owner, true)
    expect(zh.split('\n')).toHaveLength(3)
    expect(wordCount(zh)).toBeLessThanOrEqual(100)
    expect(zh).toContain('…')
    const en = stallText({ ticketId: owner.id, title: 'Fix [the] *button*', kind: 'queued', minutes: 31 }, owner, false)
    expect(en).toBe('⚠️ Ticket "Fix the button" has been queued for 31 min without starting.\nIt waits for a free worker slot.\n'
      + 'Retry or stop it on the panel (ticket c559cd6e).')
  })
})

describe('executor.stall settings', () => {
  it('defaults to 15 and 30 minutes with notices on, so a stored executor block needs no migration', () => {
    expect(StallConfigSchema.parse({})).toEqual({ minutes: 15, queuedMinutes: 30, notify: true })
    expect(SettingsSchema.parse({ executor: { maxWorkers: 3 } }).executor.stall).toEqual({ minutes: 15, queuedMinutes: 30, notify: true })
    expect(() => StallConfigSchema.parse({ minutes: 1 })).toThrow()
  })
})
