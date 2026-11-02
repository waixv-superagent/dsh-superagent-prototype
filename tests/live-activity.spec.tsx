// @vitest-environment jsdom
// The worker's current-tool buffer, and the Ticket page's compact "now" card. No reasoning, tokens or speed reaches the panel.
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Activity } from '../src/app/activity.ts'
import { zh } from '../src/client/locales.ts'
import { at, mount, text, usePanel } from './fixtures/panel.tsx'
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
const status = (emit: (event: string, ...args: unknown[]) => void, value: string) => emit('agent/status', { ...worker, status: value })
const event = (emit: (event: string, ...args: unknown[]) => void, value: object, id = 'worker-t1') => emit('session/event', { id }, value)

it('keeps only the running tool and its age, and clears it when the turn ends', () => {
  const { ctx, emit } = fakeHost()
  const activity = new Activity(ctx)
  status(emit, 'running')
  event(emit, { type: 'tool/call', seq: 1, time: Date.now(),
    data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{"path":"src/app/http.ts"}' } })
  const running = activity.read('t1')
  expect(running).toMatchObject({ live: true, tool: { name: 'read_file', digest: 'src/app/http.ts' } })
  expect(running.tool!.elapsed).toBeGreaterThanOrEqual(0)
  event(emit, { type: 'tool/result', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false } } })
  expect(activity.read('t1').tool).toBeNull()
  event(emit, { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1 } })
  status(emit, 'idle')
  expect(activity.read('t1')).toMatchObject({ live: false, tool: null })
  activity.dispose()
  expect(activity.read('t1')).toMatchObject({ live: false, tool: null })
})

it('marks a generating turn live and ignores sessions that are not workers', () => {
  const { ctx, emit } = fakeHost()
  const activity = new Activity(ctx)
  emit('agent/assistant-stream', { ...worker, frame: { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 } })
  expect(activity.read('t1').live).toBe(true)
  event(emit, { type: 'tool/call', seq: 1, time: Date.now(),
    data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' } }, 'master')
  expect(activity.read('t1').tool).toBeNull()
  activity.dispose()
})

it('shows what the worker is doing, its latest progress and who acts next without a stream', async () => {
  server.activity = ticketId => ticketId !== 't1' ? undefined : { live: true, updatedAt: Date.now(),
    tool: { name: 'read_file', digest: 'src/app/http.ts', elapsed: 3_200 } }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(text()).toContain(zh.nowWorking)
  expect(text()).toContain(zh.nowDoing)
  expect(text()).toContain('read_file')
  expect(text()).toContain('src/app/http.ts')
  expect(text()).toContain('3.2s')
  expect(text()).toContain(zh.nowLatest)
  expect(text()).toContain('working')
  expect(text()).toContain(zh.nowNextWorking)
  expect(text()).not.toContain('tok/s')
  expect(document.querySelector('.dt-now')).not.toBeNull()
  expect(document.querySelector('.dt-now .dt-disclosure-row')).toBeNull()
  expect(server.requests.some(request => request.path === 'tickets/t1/activity')).toBe(true)
})

it('falls back to the assignment state when no tool is readable', async () => {
  server.activity = () => ({ live: true, updatedAt: Date.now(), tool: null })
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(text()).toContain(zh.nowPreparing)
  expect(text()).toContain(zh.nowNextWorking)
})

it('renders no now card when the ticket is past working', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'person', action: 'verify' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-now')).toBeNull()
})
