import { describe, expect, it, vi } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { OPEN_TICKET_MS, SURFACE_ACTIVE_MS, SurfaceState } from '../src/app/surface.ts'

const TICKET = '96c4cb5233453965b1e35a008b0eb3b7'

/** Mounts the real prefix handler on a fake web server; management calls carry the panel header, plain links do not. */
function harness() {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } }
  const focusApp = vi.fn(() => true)
  const surfaces = new SurfaceState()
  registerHttp(ctx as never, {
    ready: Promise.resolve(), surfaces, focusApp,
    store: { tickets: { get: (id: string) => id === TICKET ? { id } : undefined } },
  } as unknown as HttpHost)
  const call = async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string | undefined>;
    management?: boolean } = {}) => {
    let status = 0
    let headers: Record<string, unknown> = {}
    let text = ''
    const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082',
      ...options.management === false ? {} : { 'x-orchestrator-request': '1' }, ...options.headers })
      .filter(([, value]) => value !== undefined))
    const req = { method, url: path, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number, next: Record<string, unknown> = {}) => { status = code; headers = next },
      end: (data?: string) => { text = data ?? '' } })
    return { status, headers, text }
  }
  return { call, focusApp, surfaces }
}

describe('the surface a person is using', () => {
  it('follows the newest focused report, and a visible background page does not take it over', () => {
    const surfaces = new SurfaceState()
    const now = Date.now()
    expect(surfaces.active(now)).toBe('web')
    surfaces.touch({ surface: 'app', focused: true, visible: true }, now)
    expect(surfaces.active(now)).toBe('app')
    surfaces.touch({ surface: 'web', focused: true, visible: true }, now + 1_000)
    expect(surfaces.active(now + 1_000)).toBe('web')
    // Switching to Feishu blurs the page that was in use; a second visible window, or the page itself, must not take over.
    surfaces.touch({ surface: 'web', focused: false, visible: true }, now + 2_000)
    surfaces.touch({ surface: 'app', focused: false, visible: true }, now + 2_000)
    expect(surfaces.active(now + 2_000)).toBe('web')
    expect(surfaces.active(now + SURFACE_ACTIVE_MS + 1_001)).toBe('web')
  })
  it('remembers where each client was used, so a message links the browser address instead of a guessed one', () => {
    const surfaces = new SurfaceState()
    expect(surfaces.panelBase('')).toBe('')
    // The app's own loopback origin never becomes a link: a system browser has no session there.
    surfaces.touch({ surface: 'app', focused: true, visible: true, origin: 'http://127.0.0.1:3082/?token=x' })
    expect(surfaces.panelBase('')).toBe('')
    surfaces.touch({ surface: 'web', focused: true, visible: true, origin: 'https://10.104.0.40:9443' })
    expect(surfaces.panelBase('')).toBe('https://10.104.0.40:9443')
    // A configured address still wins, and a report that is not an http(s) origin never becomes a link.
    expect(surfaces.panelBase('https://panel.example/')).toBe('https://panel.example')
    surfaces.touch({ surface: 'web', focused: true, visible: true, origin: 'javascript:alert(1)' })
    expect(surfaces.panelBase('')).toBe('https://10.104.0.40:9443')
  })
  it('hands the app one ticket at a time and never replays an old handoff', () => {    const surfaces = new SurfaceState()
    const now = Date.now()
    expect(surfaces.take(now)).toBeUndefined()
    expect(surfaces.open(TICKET, now)).toBe(true)
    // A reload of the handoff page asks again for the same Ticket; it must not focus the app a second time.
    expect(surfaces.open(TICKET, now + 1_000)).toBe(false)
    expect(surfaces.take(now + 1_000)).toBe(TICKET)
    expect(surfaces.take(now + 1_001)).toBeUndefined()
    expect(surfaces.open(TICKET, now + OPEN_TICKET_MS + 2)).toBe(true)
    expect(surfaces.take(now + OPEN_TICKET_MS * 3)).toBeUndefined()
  })
  it('takes a report from the panel and answers its own state', async () => {
    const h = harness()
    expect((await h.call('POST', '/orchestrator/api/surface', { body: { surface: 'app', focused: true, visible: true } })).text).toBe('{"ok":true}')
    expect((await h.call('GET', '/orchestrator/api/app-open?surface=web')).text).toBe('{}')
    expect(h.surfaces.active()).toBe('app')
  })
  it('learns the browser address a report carries, for a card nobody configured by hand', async () => {
    const h = harness()
    await h.call('POST', '/orchestrator/api/surface', { body: { surface: 'web', focused: true, visible: true, origin: 'https://10.104.0.40:9443' } })
    expect(h.surfaces.panelBase('')).toBe('https://10.104.0.40:9443')
  })
  it('refuses a malformed report', async () => {
    const h = harness()
    const answer = await h.call('POST', '/orchestrator/api/surface', { body: { surface: 'desktop' } })
    expect(answer.status).toBe(400)
    expect(h.surfaces.active()).toBe('web')
  })
})

describe('a ticket link opened from Feishu', () => {
  it('sends a browser to the panel page it already knows', async () => {
    const h = harness()
    const answer = await h.call('GET', `/orchestrator/ticket/${TICKET}`, { management: false })
    expect(answer.status).toBe(302)
    expect(answer.headers.location).toBe(`/?ticket=${TICKET}`)
    expect(answer.text).toBe('')
    expect(h.focusApp).not.toHaveBeenCalled()
  })
  it('hands the ticket to the app in use and brings the app forward, twice at most for one page load', async () => {
    const h = harness()
    await h.call('POST', '/orchestrator/api/surface', { body: { surface: 'app', focused: true, visible: true } })
    const answer = await h.call('GET', `/orchestrator/ticket/${TICKET}`, { management: false })
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('dsh://open')
    expect(answer.text).toContain(`/?ticket=${TICKET}`)
    expect(h.focusApp).toHaveBeenCalledTimes(1)
    // A reload shows the same page but does not yank the app forward again.
    expect((await h.call('GET', `/orchestrator/ticket/${TICKET}`, { management: false })).status).toBe(200)
    expect(h.focusApp).toHaveBeenCalledTimes(1)
  })
  it('gives the handed-over ticket to the app only, once', async () => {
    const h = harness()
    await h.call('POST', '/orchestrator/api/surface', { body: { surface: 'app', focused: true, visible: true } })
    await h.call('GET', `/orchestrator/ticket/${TICKET}`, { management: false })
    // A browser page asking is answered, but it does not consume the app's handoff.
    expect((await h.call('GET', '/orchestrator/api/app-open?surface=web')).text).toBe('{}')
    expect((await h.call('GET', '/orchestrator/api/app-open?surface=app')).text).toBe(JSON.stringify({ ticketId: TICKET }))
    expect((await h.call('GET', '/orchestrator/api/app-open?surface=app')).text).toBe('{}')
  })
  it('answers a page load of a malformed or unknown ticket with 404, and a non-GET with 405', async () => {
    const h = harness()
    expect((await h.call('GET', '/orchestrator/ticket/not-a-ticket', { management: false })).status).toBe(404)
    expect((await h.call('GET', '/orchestrator/ticket/ffffffffffffffffffffffffffffffff', { management: false })).status).toBe(404)
    expect((await h.call('POST', `/orchestrator/ticket/${TICKET}`, { management: false })).status).toBe(405)
  })
  it('answers HEAD without a page body', async () => {
    const h = harness()
    await h.call('POST', '/orchestrator/api/surface', { body: { surface: 'app', focused: true, visible: true } })
    const answer = await h.call('HEAD', `/orchestrator/ticket/${TICKET}`, { management: false })
    expect(answer.status).toBe(200)
    expect(answer.text).toBe('')
  })
})
