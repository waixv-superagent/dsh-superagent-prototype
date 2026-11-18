// @vitest-environment jsdom
/** The frame-wide surface report and the desktop app's handoff poll: what each client sends, and what the app takes. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSurfaceLink } from '../src/client/surface.ts'
import type { T } from '../src/client/text.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const desktopAgent = browserAgent.replace('Chrome/152.0.0.0', 'Chrome/152.0.7977.130 Electron/44.7.0')
const originalAgent = navigator.userAgent
const useAgent = (value: string): void => { Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => value }) }
const t = ((key: string) => key) as unknown as T

let root: Root | undefined
let container: HTMLElement | undefined
afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
  useAgent(originalAgent)
  vi.unstubAllGlobals()
})

function Harness({ onOpen }: { onOpen: (ticketId: string) => void }) {
  useSurfaceLink(t, onOpen)
  return null
}

/** Stub the management API and record every call; the handoff answer is the one a pending app request would get. */
function api(handoff: { ticketId?: string } = {}) {
  const calls: { url: string; method: string; body?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    const answer = url.includes('/app-open') ? handoff : { ok: true }
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) } as unknown as Response
  }))
  return calls
}

async function mount(onOpen: (ticketId: string) => void): Promise<{ calls: ReturnType<typeof api>; opened: string[] }> {
  const calls = api({ ticketId: 't6' })
  const opened: string[] = []
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<Harness onOpen={id => { opened.push(id) }} />) })
  return { calls, opened }
}

describe('the panel reporting which client it is', () => {
  it('reports a browser page as web and never asks for the app\'s handoff', async () => {
    useAgent(browserAgent)
    const { calls } = await mount(() => {})
    await vi.waitFor(() => expect(calls.some(call => call.url.includes('/surface'))).toBe(true))
    const report = calls.find(call => call.url.includes('/surface'))!
    expect(JSON.parse(report.body!)).toMatchObject({ surface: 'web', visible: true })
    expect(calls.some(call => call.url.includes('/app-open'))).toBe(false)
  })
  it('reports the desktop shell as app and asks for a handoff', async () => {
    useAgent(desktopAgent)
    const { calls } = await mount(() => {})
    await vi.waitFor(() => expect(calls.some(call => call.url.includes('/app-open'))).toBe(true))
    expect(JSON.parse(calls.find(call => call.url.includes('/surface'))!.body!)).toMatchObject({ surface: 'app', visible: true })
  })
  it('moves the panel to the handed-over ticket', async () => {
    useAgent(desktopAgent)
    const calls = api({ ticketId: 't6' })
    const opened: string[] = []
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(<Harness onOpen={id => { opened.push(id) }} />) })
    await vi.waitFor(() => expect(opened).toEqual(['t6']))
    expect(calls.find(call => call.url.includes('/app-open'))?.method).toBe('GET')
  })
})
