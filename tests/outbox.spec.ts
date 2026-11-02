/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('holds a reply whose arguments the CLI refused instead of retrying it, lets the later ones pass, and sends it again on a retry', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  const channel = feishu('1', 'x').channel!
  lark.mockImplementation(async args => {
    if (JSON.stringify(args).includes('REFUSE')) throw new CliError('--content is not valid JSON', undefined, 2, 'validation')
    return {}
  })
  h.runtime.outbox.send({ id: 'refused', channel, text: 'REFUSE 保留在「收集更新」', kind: 'reply', ticketId: 't' })
  h.runtime.outbox.send({ id: 'next', channel, text: '下一条', kind: 'reply', ticketId: 't' })
  await h.runtime.sendReplies()
  const tries = () => lark.mock.calls.filter(([args]) => JSON.stringify(args).includes('REFUSE')).length
  // One refusal is the whole evidence: the later message of the same Ticket goes out, and no timer tries the refused one again.
  expect([h.runtime.outbox.status('refused'), h.runtime.outbox.status('next'), tries(), h.runtime.health.reply?.state])
    .toEqual(['pending', 'sent', 1, 'error'])
  expect(h.runtime.store.read.failingReplies()).toEqual([expect.objectContaining({ id: 'refused', attempts: 1, refused: true,
    error: expect.stringContaining('--content is not valid JSON') })])
  await at(3_600_000)
  expect(tries()).toBe(1)
  lark.mockResolvedValue({})
  expect(h.runtime.outbox.retry('refused')).toBe(true)
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('refused'), h.runtime.health.reply?.state, h.runtime.outbox.retry('refused')]).toEqual(['sent', 'ready', false])
})
