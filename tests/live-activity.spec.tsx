// @vitest-environment jsdom
// The worker's live activity: its bounded buffer, and the Ticket page's collapsed line and reasoning stream.
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Activity } from '../src/app/activity.ts'
import { zh } from '../src/client/locales.ts'
import { at, click, mount, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

type Listener = (...args: unknown[]) => void
function fakeHost() {
  const listeners = new Map<string, Listener>()
  const ctx = { on: (event: string, listener: Listener) => { listeners.set(event, listener); return () => { listeners.delete(event) } }
  } as unknown as Context
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.(...args)
  return { ctx, emit }
}
const worker = { agent: { id: 'worker-t1' } }
const frame = (emit: (event: string, ...args: unknown[]) => void, chunk: object, time = 1_000) => emit('agent/assistant-stream',
  { ...worker, frame: { type: 'chunk', attemptId: 'a', revision: 1, index: 0, time, chunk } })
const status = (emit: (event: string, ...args: unknown[]) => void, value: string) => emit('agent/status', { ...worker, status: value })
const event = (emit: (event: string, ...args: unknown[]) => void, value: object, id = 'worker-t1') => emit('session/event', { id }, value)

it('keeps a worker reasoning tail, the running tool, tokens and the settled step rate', () => {
  const { ctx, emit } = fakeHost()
  const activity = new Activity(ctx)
  status(emit, 'running')
  emit('agent/assistant-stream', { ...worker, frame: { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 } })
  frame(emit, { type: 'reasoning-delta', index: 0, text: '先看 ' }, 1_000)
  frame(emit, { type: 'reasoning-delta', index: 0, text: 'http 路由' }, 1_100)
  event(emit, { type: 'tool/call', seq: 1, time: 1_500,
    data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{"path":"src/app/http.ts"}' } })
  const running = activity.read('t1', 0, true)
  expect(running).toMatchObject({ live: true, calls: 1, tokens: 0, rate: null,
    tool: { name: 'read_file', digest: 'src/app/http.ts' } })
  expect(running.tool!.elapsed).toBeGreaterThanOrEqual(0)
  expect(running.thinking).toMatchObject({ text: '先看 http 路由', total: 10, reset: false })
  expect(activity.read('t1', 1, true).thinking?.text).toBe('看 http 路由')
  expect(activity.read('t1', 0, false).thinking).toBeUndefined()
  event(emit, { type: 'tool/result', seq: 2, time: 1_600, data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false } } })
  expect(activity.read('t1', 0, false).tool).toBeNull()
  event(emit, { type: 'assistant/message', seq: 3, time: 2_000,
    data: { turn: 1, step: 1, message: { role: 'assistant' }, stream: [], usage: { inputTokens: 1, outputTokens: 60 } } })
  const settled = activity.read('t1', 10, true)
  expect(settled).toMatchObject({ tokens: 60, rate: 60 })
  expect(settled.thinking?.text).toBe('')
  status(emit, 'idle')
  expect(activity.read('t1', 0, false).live).toBe(false)
  activity.dispose()
  expect(activity.read('t1', 0, false)).toMatchObject({ live: false, calls: 0, tokens: 0 })
})

it('resets a cursor behind the retained tail and ignores sessions that are not workers', () => {
  const { ctx, emit } = fakeHost()
  const activity = new Activity(ctx)
  status(emit, 'running')
  frame(emit, { type: 'reasoning-delta', index: 0, text: 'x'.repeat(90_000) })
  const tail = activity.read('t1', 0, true).thinking!
  expect(tail.reset).toBe(true)
  expect(tail.text).toHaveLength(64 * 1024)
  expect(tail.total).toBe(90_000)
  expect(activity.read('t1', 90_000, true).thinking?.text).toBe('')
  expect(activity.read('t1', 90_001, true).thinking?.reset).toBe(true)
  event(emit, { type: 'tool/call', seq: 1, time: 1_000,
    data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' } }, 'master')
  expect(activity.read('t1', 0, false).calls).toBe(0)
  activity.dispose()
})

const reasoning = '先读运行时，再看 http 路由。'
function live(ticketId: string, query: { after?: string; thinking?: string }) {
  if (ticketId !== 't1') return undefined
  const after = Number(query.after ?? 0)
  return { live: true, startedAt: 0, updatedAt: 0, tool: { name: 'read_file', digest: 'src/app/http.ts', elapsed: 3_200 },
    calls: 3, tokens: 12_400, rate: 38,
    ...query.thinking === '1' ? { thinking: { text: reasoning.slice(after), total: reasoning.length, reset: after > reasoning.length } } : {} }
}

it('shows the running tool and token speed collapsed, and the reasoning stream only once expanded', async () => {
  server.activity = live
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(text()).toContain(zh.liveRunning)
  expect(text()).toContain('调用 read_file')
  expect(text()).toContain('3.2s')
  expect(text()).toContain('≈38 tok/s')
  expect(text()).toContain('12.4k tok')
  expect(document.querySelector('.dt-live-text')).toBeNull()
  expect(server.requests.filter(request => request.path.startsWith('tickets/t1/activity'))).not.toHaveLength(0)
  await click(document.querySelector<HTMLElement>('.dt-live .dt-disclosure-row')!)
  expect(document.querySelector('.dt-live-stream')?.textContent).toContain('先读运行时，再看 http 路由。')
  expect(server.requests.some(request => request.path === 'tickets/t1/activity?after=0&thinking=1')).toBe(true)
})

it('renders no live block for an idle worker', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-live')).toBeNull()
})
