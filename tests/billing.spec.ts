import { afterEach, expect, it, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { Billing, publishedPrices, type BillingEvent, type BillingSnapshot, type ModelPrice } from '../src/app/billing.ts'
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
