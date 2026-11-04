import { afterEach, expect, it, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Billing, gatewayAccount, publishedPrices, type BillingEvent, type BillingQuota, type BillingSnapshot, type ModelPrice } from '../src/app/billing.ts'
import { SettingsSchema } from '../src/policy.ts'

const CATALOG: ModelCatalog = {
  default: { provider: 'ai-gateway', model: 'deepseek-v4.1-flash' },
  routableProviders: ['ai-gateway', 'deepseek-account'],
  groups: [
    { id: 'ai-gateway', name: 'kurogames', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }] },
    { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] },
  ],
  failures: [],
}
const PRICES = new Map<string, ModelPrice>([['deepseek-v4.1-flash', { prompt: 2, completion: 8, cacheRead: 0.04, cacheWrite: 2 }]])
const CLOCK = Date.UTC(2026, 10, 4, 8, 30, 0)

function fakeStore(saved?: BillingSnapshot, settings: unknown = SettingsSchema.parse({})) {
  const kv = new Map<string, unknown>()
  if (saved) kv.set('billing-snapshot', saved)
  return {
    get: (name: string) => kv.get(name),
    set: (name: string, value: unknown) => { kv.set(name, value) },
    settings: () => SettingsSchema.parse(settings),
    snapshot: () => kv.get('billing-snapshot') as BillingSnapshot | undefined,
  }
}

function billingOf({ store = fakeStore(), now = () => CLOCK, priced = true }: {
  store?: ReturnType<typeof fakeStore>
  now?: () => number
  priced?: boolean
} = {}) {
  return new Billing({ store: store as never, now, catalog: async () => CATALOG,
    prices: async provider => provider === 'ai-gateway' && priced ? PRICES : null })
}

const message = (seq: number, at: number, provider = 'ai-gateway', model = 'deepseek-v4.1-flash',
  usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0 }): BillingEvent =>
  ({ type: 'assistant/message', seq, time: at, data: { message: { source: { provider, model } }, usage } })

/** The single priced call in the fixtures: (1000·2 + 500·8 + 200·0.04) / 1e6. */
const ONE_CALL = (1000 * 2 + 500 * 8 + 200 * 0.04) / 1_000_000

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GW_KEY
})

it('prices the rolling hour, names the latest route, and warns when a role uses another provider', async () => {
  const settings = SettingsSchema.parse({ executor: { model: { provider: 'deepseek-account', model: 'deepseek-flash' } } })
  const billing = billingOf({ store: fakeStore(undefined, settings) })
  billing.observe('worker-a', message(1, CLOCK - 150_000))
  billing.observe('worker-a', message(2, CLOCK - 90_000))
  billing.observe('worker-b', message(1, CLOCK - 30_000))
  const view = await billing.view()
  expect(view.windowMinutes).toBe(60)
  expect(view.priced).toBe(true)
  expect(view.total.requests).toBe(3)
  expect(view.total.tokens).toBe(3 * 1700)
  expect(view.total.cost).toBeCloseTo(3 * ONE_CALL, 10)
  expect(view.total.unpricedTokens).toBe(0)
  expect(view.providers).toHaveLength(1)
  expect(view.providers[0]).toMatchObject({ provider: 'ai-gateway', name: 'kurogames', model: 'DeepSeek V4.1 Flash',
    requests: 3, tokens: 3 * 1700, cost: 3 * ONE_CALL })
  expect(view.current).toMatchObject({ provider: 'ai-gateway', name: 'kurogames', model: 'DeepSeek V4.1 Flash', at: CLOCK - 30_000 })
  expect(view.configured.find(role => role.role === 'worker')).toMatchObject({ provider: 'deepseek-account',
    name: 'DeepSeek Account', model: 'deepseek-flash' })
  expect(view.buckets).toHaveLength(60)
  const used = view.buckets.filter(bucket => bucket.tokens > 0)
  expect(used).toHaveLength(3)
  expect(used.reduce((sum, bucket) => sum + bucket.cost, 0)).toBeCloseTo(3 * ONE_CALL, 10)
})

it('ignores a replayed sequence and usage outside the rolling window', async () => {
  const billing = billingOf()
  const event = message(4, CLOCK - 60_000)
  billing.observe('worker-a', event)
  billing.observe('worker-a', event)
  billing.observe('worker-a', message(3, CLOCK - 61 * 60_000))
  const view = await billing.view()
  expect(view.total.requests).toBe(1)
  expect(view.total.cost).toBeCloseTo(ONE_CALL, 10)
})

it('counts an unpriced route by its tokens and never invents money', async () => {
  const billing = billingOf()
  billing.observe('worker-a', message(1, CLOCK - 60_000, 'deepseek-account', 'deepseek-flash'))
  const view = await billing.view()
  expect(view.priced).toBe(false)
  expect(view.total.cost).toBeNull()
  expect(view.total.tokens).toBe(1700)
  expect(view.total.unpricedTokens).toBe(1700)
  expect(view.providers[0]).toMatchObject({ provider: 'deepseek-account', name: 'DeepSeek Account', cost: null,
    tokens: 1700, unpricedTokens: 1700 })
  expect(view.current).toMatchObject({ provider: 'deepseek-account', name: 'DeepSeek Account', model: 'DeepSeek-V4.1-Flash' })
  expect(view.buckets.reduce((sum, bucket) => sum + bucket.cost, 0)).toBe(0)
})

it('restores the persisted window after a restart', async () => {
  const store = fakeStore()
  const first = billingOf({ store })
  first.observe('worker-a', message(1, CLOCK - 60_000))
  first.stop()
  expect(store.snapshot()?.version).toBe(1)
  const second = billingOf({ store, now: () => CLOCK + 5_000 })
  const view = await second.view()
  expect(view.total.requests).toBe(1)
  expect(view.total.cost).toBeCloseTo(ONE_CALL, 10)
})

it('replays a Session only after the persisted sequence watermark', async () => {
  const store = fakeStore()
  const first = billingOf({ store })
  first.observe('worker-a', message(5, CLOCK - 60_000))
  first.stop()
  const second = billingOf({ store, now: () => CLOCK + 5_000 })
  second.restore('worker-a', [message(5, CLOCK - 60_000), message(6, CLOCK - 30_000)])
  const view = await second.view()
  expect(view.total.requests).toBe(2)
  expect(view.total.cost).toBeCloseTo(2 * ONE_CALL, 10)
})

it('reads the configured route\'s published /v1/models prices with the route credential', async () => {
  process.env.GW_KEY = 'route-secret'
  const ctx = { get: (name: string) => name === 'settings' ? { describe: () => [{
    value: { providers: { 'ai-gateway': { baseURL: 'https://gw.example/', apiKeyEnv: 'GW_KEY' } } },
  }] } : undefined } as never
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [
    { id: 'deepseek-v4.1-flash', prompt_cost_per_1m_cny: 2, completion_cost_per_1m_cny: 8,
      cache_read_cost_per_1m_cny: 0.04, cache_write_cost_per_1m_cny: 1 },
    { id: 'no-price', model_type: 'chat' },
  ] }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const prices = await publishedPrices(ctx, 'ai-gateway')
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(String(url)).toBe('https://gw.example/v1/models')
  expect(options.headers).toMatchObject({ accept: 'application/json', authorization: 'Bearer route-secret' })
  expect([...prices!.keys()]).toEqual(['deepseek-v4.1-flash'])
  expect(prices!.get('deepseek-v4.1-flash')).toEqual({ prompt: 2, completion: 8, cacheRead: 0.04, cacheWrite: 1 })
})

it('publishes no prices for a route without a configured endpoint', async () => {
  const ctx = { get: () => undefined } as never
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await publishedPrices(ctx, 'ai-gateway')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

const QUOTA: BillingQuota = { source: 'gateway', limit: 3000, used: 1735.6218, remaining: 1264.018, remainingPercent: 1264.018 / 3000 * 100,
  periodEnd: Date.UTC(2026, 10, 8, 16), at: CLOCK - 60_000 }

it('shows the gateway\'s settled hour and quota beside the estimate, and re-reads only the minutes still settling', async () => {
  const account = vi.fn(async (_provider: string, from: number, to: number) => ({
    quota: QUOTA,
    requests: [{ at: CLOCK - 150_000, cost: 0.4, tokens: 100 }, { at: CLOCK - 30_000, cost: 0.1, tokens: 50 },
      { at: from - 1, cost: 99, tokens: 1 }],
    covered: { from, to },
  }))
  let now = CLOCK
  const billing = new Billing({ store: fakeStore() as never, now: () => now, catalog: async () => CATALOG,
    prices: async () => PRICES, account })
  billing.observe('worker-a', message(1, CLOCK - 30_000))
  const view = await billing.view()
  expect(view.total.cost).toBeCloseTo(ONE_CALL, 10)
  expect(view.quota).toEqual(QUOTA)
  expect(view.settled).toMatchObject({ source: 'gateway', provider: 'ai-gateway', requests: 2, tokens: 150, complete: true })
  expect(view.settled!.cost).toBeCloseTo(0.5, 10)
  expect(view.settled!.buckets).toHaveLength(60)
  expect(view.settled!.buckets.map(bucket => bucket.at)).toEqual(view.buckets.map(bucket => bucket.at))
  // CLOCK sits on a minute boundary, so the request 30 s earlier lands in the minute before the last bucket.
  expect(view.settled!.buckets.at(-2)!.cost).toBeCloseTo(0.1, 10)
  const [provider, from, to] = account.mock.calls[0]!
  expect(provider).toBe('ai-gateway')
  expect(from).toBe(view.buckets[0]!.at)
  expect(to).toBe(view.buckets.at(-1)!.at + 60_000)

  // Within a minute the account is not read again.
  await billing.view()
  expect(account).toHaveBeenCalledTimes(1)
  // A minute later only the minutes that may still settle are asked for.
  now = CLOCK + 61_000
  await billing.view()
  expect(account).toHaveBeenCalledTimes(2)
  expect(account.mock.calls[1]![1]).toBeGreaterThanOrEqual(CLOCK - 3 * 60_000)
})

it('falls back to the estimate when the gateway account cannot be read', async () => {
  const warn = vi.fn()
  const billing = new Billing({ store: fakeStore() as never, now: () => CLOCK, catalog: async () => CATALOG,
    prices: async () => PRICES, account: async () => { throw new Error('HTTP 401') }, warn })
  billing.observe('worker-a', message(1, CLOCK - 30_000))
  const view = await billing.view()
  expect(view.settled).toBeUndefined()
  expect(view.quota).toBeUndefined()
  expect(view.total.cost).toBeCloseTo(ONE_CALL, 10)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'))
})

it('marks a settled hour partial when the gateway covered only part of it', async () => {
  const billing = new Billing({ store: fakeStore() as never, now: () => CLOCK, catalog: async () => CATALOG,
    prices: async () => PRICES, account: async (_provider, from) => ({
      requests: [{ at: from + 30_000, cost: 1, tokens: 10 }], covered: { from, to: from + 10 * 60_000 } }) })
  const view = await billing.view()
  expect(view.settled).toMatchObject({ cost: 1, requests: 1, complete: false })
  expect(view.quota).toBeUndefined()
})

const gatewayCtx = (resolve?: (ref: string) => Promise<{ value: string } | undefined>) => ({ get: (name: string) => name === 'settings'
  ? { describe: () => [{ value: { providers: { 'ai-gateway': { baseURL: 'https://gw.example', apiKeyEnv: 'GW_KEY' } } } }] }
  : name === 'credentials' && resolve ? { resolve } : undefined }) as never
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })

it('reads the gateway quota and timeline with the stored route credential, splitting a truncated range', async () => {
  vi.useFakeTimers({ now: CLOCK, toFake: ['Date'] })
  try {
    const resolve = vi.fn(async () => ({ value: 'stored-secret' }))
    const from = Date.UTC(2026, 10, 4, 7, 31), to = Date.UTC(2026, 10, 4, 8, 31)
    const urls: string[] = []
    const fetch = vi.fn(async (url: URL, options: RequestInit) => {
      urls.push(String(url))
      expect(options.headers).toMatchObject({ authorization: 'Bearer stored-secret' })
      if (url.pathname === '/my-usage/api/detail') return json({ period_limit_cny: 30_000_000, period_used_cny: 17_356_218,
        period_remaining_cny: 12_643_782, quota_v2: { week_end: 1794153600 }, usage_snapshot_at: '2026-11-04T08:29:00Z' })
      const start = url.searchParams.get('start')!
      // The whole hour is too many requests for one answer; each half fits.
      if (start === '2026-11-04T15:31' && url.searchParams.get('end') === '2026-11-04T16:30') return json({ truncated: true, requests: [] })
      return json({ truncated: false, requests: start === '2026-11-04T15:31'
        ? [{ timestamp: '2026-11-04T07:35:10Z', cost_cny: 4603, total_tokens: 122_380 }]
        : [{ timestamp: '2026-11-04T08:20:00Z', cost_cny: 172, total_tokens: 418_684 }, { timestamp: 'bad', cost_cny: 1 }] })
    })
    vi.stubGlobal('fetch', fetch)
    const account = await gatewayAccount(gatewayCtx(resolve), 'ai-gateway', from, to)
    expect(resolve).toHaveBeenCalledWith('GW_KEY')
    expect(account?.quota).toMatchObject({ source: 'gateway', limit: 3000, remaining: 1264.3782, periodEnd: 1794153600_000 })
    expect(account?.quota?.remainingPercent).toBeCloseTo(42.14594, 4)
    expect(account?.covered).toEqual({ from, to })
    expect(account?.requests).toEqual([{ at: Date.parse('2026-11-04T07:35:10Z'), cost: 0.4603, tokens: 122_380 },
      { at: Date.parse('2026-11-04T08:20:00Z'), cost: 0.0172, tokens: 418_684 }])
    expect(urls[0]).toBe('https://gw.example/my-usage/api/detail?date=20261104')
    expect(urls.slice(1).map(url => new URL(url).search)).toEqual([
      '?date=20261104&window=custom&start=2026-11-04T15%3A31&end=2026-11-04T16%3A30',
      '?date=20261104&window=custom&start=2026-11-04T15%3A31&end=2026-11-04T16%3A00',
      '?date=20261104&window=custom&start=2026-11-04T16%3A01&end=2026-11-04T16%3A30'])
  } finally { vi.useRealTimers() }
})

it('reads no gateway account without a credential, and keeps only the readable part when the timeline fails', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(await gatewayAccount(gatewayCtx(), 'ai-gateway', CLOCK - 3_600_000, CLOCK)).toBeNull()
  expect(fetch).not.toHaveBeenCalled()

  process.env.GW_KEY = 'env-secret'
  fetch.mockImplementation(async (url: URL) => url.pathname === '/my-usage/api/detail'
    ? json({ period_limit_cny: 1_000_000, period_used_cny: 900_000, period_remaining_cny: 100_000 })
    : new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  const account = await gatewayAccount(gatewayCtx(), 'ai-gateway', CLOCK - 3_600_000, CLOCK)
  expect(account).toEqual({ quota: expect.objectContaining({ limit: 100, remaining: 10, remainingPercent: 10 }) })
})
