/** Rolling per-minute model spend for the board's billing strip: observed Session usage, priced from the route's published model list. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-settings'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** The window the strip sums, in minutes. */
export const BILLING_WINDOW_MINUTES = 60
/** Usage older than this is dropped: it can never enter the strip or the persisted snapshot. */
const KEEP_MINUTES = 120
const BUCKET_MS = 60_000
const CATALOG_TTL_MS = 60_000
const PRICE_TTL_MS = 10 * 60_000
const PRICE_FAILURE_TTL_MS = 60_000
const FLUSH_MS = 30_000
/** The gateway account is read at most this often. */
const GATEWAY_TTL_MS = 60_000
/** A view waits this long for a gateway read before it shows what it already has. */
const GATEWAY_WAIT_MS = 6_000
/** A gateway figure older than this is dropped rather than shown as current. */
const GATEWAY_STALE_MS = 5 * 60_000
/** A minute this far in the past is assumed settled by the gateway and is not read again. */
const GATEWAY_SETTLE_MS = 2 * 60_000
const TOKEN_LIMIT = Number.MAX_SAFE_INTEGER
const PROVIDER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/

/** One model's published request price, in CNY per million tokens. */
export interface ModelPrice {
  readonly prompt: number
  readonly completion: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** The frame of a Session event the ledger reads; the host event carries these fields. */
export interface BillingEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }

/** One provider's usage in the strip, with the latest model it charged. */
export interface BillingProvider {
  readonly provider: string
  readonly name: string
  readonly model: string
  /** Null when the route publishes no price for at least one of the models it used. */
  readonly cost: number | null
  readonly tokens: number
  readonly requests: number
  /** Epoch milliseconds of the latest priced or counted request. */
  readonly lastAt: number
  /** Tokens whose model had no published price, so the money figure excludes them. */
  readonly unpricedTokens: number
}

/** One provider+model route's usage in the strip, so a model that dominates the spend is not hidden behind its provider. */
export interface BillingRoute {
  readonly provider: string
  readonly name: string
  /** Display name of the model. */
  readonly model: string
  /** Raw model id used for the price lookup and the configured-role comparison. */
  readonly modelId: string
  /** Null when this route publishes no price for the model it used. */
  readonly cost: number | null
  readonly tokens: number
  readonly requests: number
  /** Epoch milliseconds of the latest request on this route. */
  readonly lastAt: number
  /** Tokens whose model had no published price, so the money figure excludes them. */
  readonly unpricedTokens: number
}

/** One minute of the rolling window, oldest first on the strip. */
export interface BillingBucket { readonly at: number; readonly cost: number; readonly tokens: number }

/** A configured role's effective model selection. */
export interface BillingRole {
  readonly role: 'default' | 'orchestrator' | 'worker'
  readonly provider: string
  readonly name: string
  /** Raw model id, as the role chose it. */
  readonly model: string
  /** Display name of that model. */
  readonly modelName: string
}

/** The billing account's own quota for its current period, as the route's gateway settles it. */
export interface BillingQuota {
  /** Who keeps this account: the gateway, so every client sharing its key counts against it. */
  readonly source: 'gateway'
  readonly limit: number
  readonly used: number
  readonly remaining: number
  /** Remaining share of the period's limit, 0–100. */
  readonly remainingPercent: number
  /** Epoch milliseconds the current period ends at, when the gateway says. */
  readonly periodEnd: number | null
  /** Epoch milliseconds of the gateway's usage snapshot. */
  readonly at: number
}

/** The rolling hour as the route's gateway billed it, minute by minute; the account's whole key, not only this host. */
export interface BillingSettled {
  readonly source: 'gateway'
  readonly provider: string
  readonly cost: number
  readonly requests: number
  readonly tokens: number
  /** One entry per minute of the window, aligned with `BillingView.buckets`. */
  readonly buckets: readonly { readonly at: number; readonly cost: number; readonly requests: number }[]
  /** Whether every minute of the window was read; a partial window is a lower bound. */
  readonly complete: boolean
}

/** What the route's gateway reports about its account; any part may be missing when the gateway cannot be read. */
export interface GatewayAccount {
  readonly quota?: BillingQuota
  /** Settled requests in [from, to): one per request, the gateway's own cost in CNY. */
  readonly requests?: readonly { readonly at: number; readonly cost: number; readonly tokens: number }[]
  /** Minutes the gateway answered completely; a minute outside them was not read. */
  readonly covered?: { readonly from: number; readonly to: number }
}

/** The billing strip's data: what is charging now, what the window consumed, what it cost at published prices, and what the route's gateway settled. */
export interface BillingView {
  /** The gateway account's quota for its period; absent when the route has none or it could not be read. */
  readonly quota?: BillingQuota
  /** The rolling hour as the gateway billed it; absent when it could not be read, leaving the estimate in `total`. */
  readonly settled?: BillingSettled
  readonly windowMinutes: number
  readonly currency: 'CNY'
  /** The provider and model of the latest request in the window, or the deployment default when nothing ran. */
  readonly current: { readonly provider: string; readonly name: string; readonly model: string; readonly at: number | null }
  readonly configured: readonly BillingRole[]
  /** Provider totals, kept for clients that only need the route-level figure. */
  readonly providers: readonly BillingProvider[]
  /** Per provider+model totals: the unit that explains where the money went. */
  readonly routes: readonly BillingRoute[]
  /** The route with the highest priced cost, or the highest token use when no route is priced. */
  readonly top: BillingRoute | null
  readonly total: { readonly cost: number | null; readonly tokens: number; readonly requests: number; readonly unpricedTokens: number }
  readonly buckets: readonly BillingBucket[]
  /** Whether any usage in the window could be priced. */
  readonly priced: boolean
  readonly updatedAt: number
}

/** Usage as persisted between host restarts: one row per minute, provider and model. */
export interface SavedSpend {
  readonly at: number
  readonly provider: string
  readonly model: string
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly requests: number
  readonly lastAt: number
}

/** The persisted snapshot; an unreadable one is ignored rather than failing the host. */
export interface BillingSnapshot {
  readonly version: 1
  readonly spends: readonly SavedSpend[]
  /** Last observed sequence per Session, so a restart replays only what the snapshot does not already hold. */
  readonly watermarks?: Readonly<Record<string, number>>
}

interface Spend { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number; lastAt: number }
interface CountedUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
interface SettledMinute { cost: number; requests: number; tokens: number; final: boolean }
interface SettledState {
  provider: string
  minutes: Map<number, SettledMinute>
  quota?: { value: BillingQuota; readAt: number }
  readAt: number
  okAt: number
  pending?: Promise<void>
}

/** What the ledger needs from its owner; the host supplies the live catalog and the route's published prices. */
export interface BillingHost {
  readonly store: Pick<Store, 'get' | 'set' | 'settings'>
  /** The live model catalog, read for display names and the deployment default. */
  catalog(): Promise<ModelCatalog>
  /** Published prices by model id for `provider`, or null when that route publishes none. */
  prices(provider: string): Promise<ReadonlyMap<string, ModelPrice> | null>
  /** The account `provider`'s gateway bills, settled over [from, to); absent when the host reads no gateway account. */
  account?(provider: string, from: number, to: number): Promise<GatewayAccount | null>
  now?(): number
  warn?(message: string): void
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const count = (value: unknown): number | undefined => {
  const parsed = number(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed <= TOKEN_LIMIT ? parsed : undefined
}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
const minuteOf = (at: number): number => Math.floor(at / BUCKET_MS) * BUCKET_MS

/** Total tokens of one counted usage, the unit the strip shows when a route has no price. */
const tokensOf = (usage: CountedUsage): number => usage.input + usage.output + usage.cacheRead + usage.cacheWrite

/** Price one counted usage, treating a missing cache-write price as ordinary prompt input. */
function priceOf(usage: CountedUsage, price: ModelPrice): number {
  return (usage.input * price.prompt + usage.output * price.completion
    + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000
}

/** Read the provider, model and disjoint token counts from one `assistant/message` event. */
function usageOf(event: BillingEvent): { provider: string; model: string; usage: CountedUsage } | undefined {
  const data = record(event.data)
  const source = record(record(data?.message)?.source)
  const provider = text(source?.provider), model = text(source?.model)
  const usage = record(data?.usage)
  if (!provider || !PROVIDER_PATTERN.test(provider) || !model || !usage) return undefined
  const input = count(usage.inputTokens), output = count(usage.outputTokens)
  const cacheRead = usage.cacheReadTokens === undefined ? 0 : count(usage.cacheReadTokens)
  const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : count(usage.cacheWriteTokens)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined
  const counted = { input, output, cacheRead, cacheWrite }
  return tokensOf(counted) > 0 ? { provider, model, usage: counted } : undefined
}

/**
 * Replays recorded model calls into one rolling window and prices them from the routes' published catalogs.
 * The host feeds every `assistant/message` it observes; the class keeps one minute-granular window in memory, persists
 * an aggregate snapshot so a restart does not erase the hour, and never makes a model call of its own.
 */
export class Billing {
  private readonly buckets = new Map<number, Map<string, Spend>>()
  private readonly lastSeq = new Map<string, number>()
  private readonly priceCache = new Map<string, { at: number; models: ReadonlyMap<string, ModelPrice> | null }>()
  private catalogCache?: { at: number; value: ModelCatalog }
  private settled: SettledState = { provider: '', minutes: new Map(), readAt: 0, okAt: 0 }
  private timer?: ReturnType<typeof setInterval>
  private dirty = false
  private readonly now: () => number

  constructor(private readonly host: BillingHost) {
    this.now = host.now ?? (() => Date.now())
    this.load(host.store.get(KV.billing.snapshot))
  }

  /** Start the periodic snapshot; repeated calls are harmless. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.flush() }, FLUSH_MS)
    this.timer.unref?.()
  }

  /** Stop the snapshot timer and write the last pending change. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    this.flush()
  }

  /** Record one Session event; only a successful, billed model message contributes. */
  observe(sessionId: string, event: BillingEvent): void {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isFinite(event.time) || event.time < 0) return
    const previous = this.lastSeq.get(sessionId)
    if (previous !== undefined && event.seq <= previous) return
    this.lastSeq.set(sessionId, event.seq)
    this.observeBilled(event)
  }

  /** Replay one Session's durable events; events already in the persisted snapshot are skipped by sequence. */
  restore(sessionId: string, events: readonly BillingEvent[]): void {
    for (const event of events) this.observe(sessionId, event)
  }

  private observeBilled(event: BillingEvent): void {
    if (event.type !== 'assistant/message') return
    const counted = usageOf(event)
    if (!counted) return
    const at = event.time
    if (at < this.now() - KEEP_MINUTES * BUCKET_MS) return
    const minute = minuteOf(at)
    let bucket = this.buckets.get(minute)
    if (!bucket) { bucket = new Map(); this.buckets.set(minute, bucket) }
    const key = `${counted.provider}\u0000${counted.model}`
    const spend = bucket.get(key)
    if (spend) {
      spend.input += counted.usage.input
      spend.output += counted.usage.output
      spend.cacheRead += counted.usage.cacheRead
      spend.cacheWrite += counted.usage.cacheWrite
      spend.requests += 1
      spend.lastAt = Math.max(spend.lastAt, at)
    } else {
      bucket.set(key, { ...counted.usage, requests: 1, lastAt: at })
    }
    this.dirty = true
  }

  /** Build the strip's current view; a price lookup that is still pending leaves cost absent, never guessed. */
  async view(): Promise<BillingView> {
    const now = this.now()
    this.prune(now)
    const catalog = await this.catalog()
    const names = catalogNames(catalog)
    const windowStart = minuteOf(now) - (BILLING_WINDOW_MINUTES - 1) * BUCKET_MS
    const totals = new Map<string, { provider: string; modelId: string; cost: number | null; tokens: number; requests: number;
      lastAt: number; unpricedTokens: number; priced: boolean }>()
    const buckets: BillingBucket[] = []
    const prices = new Map<string, ReadonlyMap<string, ModelPrice> | null>()
    for (let index = 0; index < BILLING_WINDOW_MINUTES; index++) {
      const at = windowStart + index * BUCKET_MS
      const bucket = this.buckets.get(at)
      let bucketCost = 0, bucketTokens = 0
      for (const [key, spend] of bucket ?? new Map<string, Spend>()) {
        const [provider, model] = key.split('\u0000') as [string, string]
        const tokens = tokensOf(spend)
        bucketTokens += tokens
        const price = await this.priceOf(provider, model, prices)
        let row = totals.get(key)
        if (!row) {
          row = { provider, modelId: model, cost: null, tokens: 0, requests: 0, lastAt: 0, unpricedTokens: 0, priced: false }
          totals.set(key, row)
        }
        row.tokens += tokens
        row.requests += spend.requests
        if (spend.lastAt > row.lastAt) row.lastAt = spend.lastAt
        if (price) {
          const cost = priceOf(spend, price)
          bucketCost += cost
          row.cost = (row.cost ?? 0) + cost
          row.priced = true
        } else {
          row.unpricedTokens += tokens
        }
      }
      buckets.push({ at, cost: bucketCost, tokens: bucketTokens })
    }
    const routes: BillingRoute[] = [...totals.values()].map(row => ({
      provider: row.provider, name: names.provider(row.provider), modelId: row.modelId,
      model: names.model(row.provider, row.modelId), cost: row.priced ? row.cost : null,
      tokens: row.tokens, requests: row.requests, lastAt: row.lastAt, unpricedTokens: row.unpricedTokens,
    })).sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1) || right.tokens - left.tokens)
    // Provider totals keep the earlier shape for a client that reads only them; the money and the headline use routes.
    const byProvider = new Map<string, { provider: string; model: string; cost: number | null; tokens: number; requests: number;
      lastAt: number; unpricedTokens: number; priced: boolean; unpriced: boolean }>()
    for (const route of routes) {
      let row = byProvider.get(route.provider)
      if (!row) {
        row = { provider: route.provider, model: route.model, cost: null, tokens: 0, requests: 0, lastAt: 0, unpricedTokens: 0,
          priced: false, unpriced: false }
        byProvider.set(route.provider, row)
      }
      row.tokens += route.tokens
      row.requests += route.requests
      row.unpricedTokens += route.unpricedTokens
      if (route.lastAt > row.lastAt) { row.lastAt = route.lastAt; row.model = route.model }
      if (route.cost === null) row.unpriced = true
      else { row.cost = (row.cost ?? 0) + route.cost; row.priced = true }
    }
    const providers = [...byProvider.values()].map(row => ({ provider: row.provider, name: names.provider(row.provider),
      model: row.model, cost: row.priced && !row.unpriced ? row.cost : null, tokens: row.tokens, requests: row.requests,
      lastAt: row.lastAt, unpricedTokens: row.unpricedTokens }))
      .sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1) || right.tokens - left.tokens)
    const pricedRoutes = routes.filter(route => route.cost !== null)
    const totalCost = pricedRoutes.length ? pricedRoutes.reduce((sum, route) => sum + (route.cost ?? 0), 0) : null
    const totalTokens = routes.reduce((sum, route) => sum + route.tokens, 0)
    const unpricedTokens = routes.reduce((sum, route) => sum + route.unpricedTokens, 0)
    const latest = routes.filter(route => route.lastAt > 0).sort((left, right) => right.lastAt - left.lastAt)[0]
    const top = routes.length ? [...routes].sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1)
      || right.tokens - left.tokens)[0]! : null
    const fallback = catalog.default
    const current = latest
      ? { provider: latest.provider, name: latest.name, model: latest.model, at: latest.lastAt }
      : { provider: fallback.provider, name: names.provider(fallback.provider), model: names.model(fallback.provider, fallback.model), at: null }
    return {
      windowMinutes: BILLING_WINDOW_MINUTES,
      currency: 'CNY',
      current,
      configured: configuredRoles(this.host.store.settings(), catalog, names),
      providers,
      routes,
      top,
      total: { cost: totalCost, tokens: totalTokens, requests: routes.reduce((sum, route) => sum + route.requests, 0), unpricedTokens },
      buckets,
      priced: totalCost !== null,
      updatedAt: now,
      ...await this.gateway(catalog.default.provider, windowStart, now),
    }
  }

  /**
   * The gateway's own account for `provider`: its quota and what it settled minute by minute. A read refreshes at most
   * once a minute and only re-reads minutes that may still change; a failed or slow read leaves the last good minutes.
   */
  private async gateway(provider: string, windowStart: number, now: number): Promise<Pick<BillingView, 'quota' | 'settled'>> {
    if (!this.host.account || !provider) return {}
    if (this.settled.provider !== provider) this.settled = { provider, minutes: new Map(), readAt: 0, okAt: 0 }
    const state = this.settled
    if (now - state.readAt >= GATEWAY_TTL_MS) {
      state.readAt = now
      state.pending ??= this.refreshGateway(state, windowStart, now).finally(() => { state.pending = undefined })
    }
    if (state.pending) await Promise.race([state.pending, new Promise(resolve => setTimeout(resolve, GATEWAY_WAIT_MS).unref?.())])
    const quota = state.quota && now - state.quota.readAt < GATEWAY_STALE_MS ? state.quota.value : undefined
    if (now - state.okAt >= GATEWAY_STALE_MS) return quota ? { quota } : {}
    const buckets: BillingSettled['buckets'][number][] = []
    let cost = 0, requests = 0, tokens = 0, complete = true
    for (let index = 0; index < BILLING_WINDOW_MINUTES; index++) {
      const at = windowStart + index * BUCKET_MS
      const minute = state.minutes.get(at)
      if (!minute) complete = false
      buckets.push({ at, cost: minute?.cost ?? 0, requests: minute?.requests ?? 0 })
      cost += minute?.cost ?? 0
      requests += minute?.requests ?? 0
      tokens += minute?.tokens ?? 0
    }
    return { ...quota ? { quota } : {}, settled: { source: 'gateway', provider, cost, requests, tokens, buckets, complete } }
  }

  private async refreshGateway(state: SettledState, windowStart: number, now: number): Promise<void> {
    for (const at of [...state.minutes.keys()]) if (at < windowStart) state.minutes.delete(at)
    // A minute is final once the gateway has had time to settle it; only later minutes are read again.
    let from = windowStart
    while (from < now && state.minutes.get(from)?.final) from += BUCKET_MS
    const to = minuteOf(now) + BUCKET_MS
    let account: GatewayAccount | null = null
    try { account = await this.host.account!(state.provider, from, to) } catch (error) {
      this.host.warn?.(`could not read the gateway account of ${state.provider}: ${String(error)}`)
    }
    if (!account || this.settled !== state) return
    const readAt = this.now()
    if (account.quota) state.quota = { value: account.quota, readAt }
    const covered = account.covered
    if (!covered || !account.requests) return
    const fresh = new Map<number, SettledMinute>()
    for (let at = minuteOf(covered.from); at < covered.to; at += BUCKET_MS) {
      fresh.set(at, { cost: 0, requests: 0, tokens: 0, final: at + BUCKET_MS <= readAt - GATEWAY_SETTLE_MS })
    }
    for (const request of account.requests) {
      const minute = fresh.get(minuteOf(request.at))
      if (!minute) continue
      minute.cost += request.cost
      minute.requests += 1
      minute.tokens += request.tokens
    }
    for (const [at, minute] of fresh) state.minutes.set(at, minute)
    state.okAt = readAt
  }

  private async catalog(): Promise<ModelCatalog> {
    const now = this.now()
    if (this.catalogCache && now - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.value
    try {
      const value = await this.host.catalog()
      this.catalogCache = { at: now, value }
      return value
    } catch {
      const value = this.catalogCache?.value ?? { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] }
      this.catalogCache = { at: now, value }
      return value
    }
  }

  private async priceOf(provider: string, model: string, pending: Map<string, ReadonlyMap<string, ModelPrice> | null>): Promise<ModelPrice | undefined> {
    if (!pending.has(provider)) {
      const cached = this.priceCache.get(provider)
      const now = this.now()
      if (cached && now - cached.at < (cached.models ? PRICE_TTL_MS : PRICE_FAILURE_TTL_MS)) pending.set(provider, cached.models)
      else {
        let models: ReadonlyMap<string, ModelPrice> | null = null
        try { models = await this.host.prices(provider) } catch { models = null }
        this.priceCache.set(provider, { at: now, models })
        pending.set(provider, models)
      }
    }
    return pending.get(provider)?.get(model)
  }

  private prune(now: number): void {
    const cutoff = minuteOf(now - KEEP_MINUTES * BUCKET_MS)
    for (const at of [...this.buckets.keys()]) if (at < cutoff) { this.buckets.delete(at); this.dirty = true }
    // Keep the recent watermarks: they are what lets a restart replay the gap without counting the snapshot twice.
    if (this.lastSeq.size > 5_000) for (const session of this.lastSeq.keys()) {
      this.lastSeq.delete(session)
      if (this.lastSeq.size <= 4_000) break
    }
  }

  private load(saved: BillingSnapshot | undefined): void {
    if (!saved || saved.version !== 1 || !Array.isArray(saved.spends)) return
    const cutoff = minuteOf(this.now() - KEEP_MINUTES * BUCKET_MS)
    for (const row of saved.spends.slice(0, 5_000)) {
      if (!row || !Number.isSafeInteger(row.at) || row.at < cutoff) continue
      if (typeof row.provider !== 'string' || !PROVIDER_PATTERN.test(row.provider) || typeof row.model !== 'string' || !row.model) continue
      const input = count(row.input), output = count(row.output), cacheRead = count(row.cacheRead), cacheWrite = count(row.cacheWrite)
      const requests = count(row.requests), lastAt = number(row.lastAt)
      if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
        || requests === undefined || !lastAt) continue
      let bucket = this.buckets.get(row.at)
      if (!bucket) { bucket = new Map(); this.buckets.set(row.at, bucket) }
      bucket.set(`${row.provider}\u0000${row.model}`, { input, output, cacheRead, cacheWrite, requests, lastAt })
    }
    for (const [session, seq] of Object.entries(saved.watermarks ?? {})) {
      if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) this.lastSeq.set(session, seq)
    }
  }

  /** Persist the rolling window; a closed store is reported once per flush rather than failing the host. */
  private flush(): void {
    if (!this.dirty) return
    this.prune(this.now())
    const spends: SavedSpend[] = []
    for (const [at, bucket] of this.buckets) for (const [key, spend] of bucket) {
      const [provider, model] = key.split('\u0000') as [string, string]
      spends.push({ at, provider, model, input: spend.input, output: spend.output, cacheRead: spend.cacheRead,
        cacheWrite: spend.cacheWrite, requests: spend.requests, lastAt: spend.lastAt })
    }
    try {
      this.host.store.set(KV.billing.snapshot, { version: 1, spends, watermarks: Object.fromEntries(this.lastSeq) } satisfies BillingSnapshot)
      this.dirty = false
    } catch (error) {
      this.host.warn?.(`could not persist the billing window: ${String(error)}`)
    }
  }
}

/** Provider and model display names from the live catalog, falling back to the raw ids. */
function catalogNames(catalog: ModelCatalog): { provider(id: string): string; model(provider: string, id: string): string } {
  const providers = new Map(catalog.groups.map(group => [group.id, group]))
  return {
    provider: id => providers.get(id)?.name ?? id ?? '',
    model: (provider, id) => providers.get(provider)?.models.find(model => model.id === id)?.name ?? id ?? '',
  }
}

/** Every configured role's effective selection, with the deployment default named `default`. */
function configuredRoles(settings: ReturnType<Store['settings']>, catalog: ModelCatalog,
  names: { provider(id: string): string; model(provider: string, id: string): string }): BillingRole[] {
  const role = (name: 'default' | 'orchestrator' | 'worker', selection: { provider: string; model: string }): BillingRole =>
    ({ role: name, provider: selection.provider, name: names.provider(selection.provider), model: selection.model,
      modelName: names.model(selection.provider, selection.model) })
  return [role('default', catalog.default), role('orchestrator', settings.eval.model ?? catalog.default),
    role('worker', settings.executor.model ?? catalog.default)]
}

/** Locate one configured pi-ai route's endpoint and credential reference without exposing the credential. */
function routeProfile(ctx: Context, provider: string): { baseURL: string; apiKeyEnv?: string } | undefined {
  let descriptors: readonly unknown[]
  try {
    const settings = ctx.get('settings') as { describe?: () => readonly unknown[] } | undefined
    descriptors = settings?.describe?.() ?? []
  } catch { return undefined }
  for (const descriptor of descriptors) {
    const value = record(descriptor)
    for (const layer of [value?.value, value?.base, value?.user]) {
      const profile = record(record(record(layer)?.providers)?.[provider])
      const baseURL = profile ? text(profile.baseURL) : undefined
      if (!profile || !baseURL) continue
      try { new URL(baseURL) } catch { continue }
      return { baseURL, ...typeof profile.apiKeyEnv === 'string' ? { apiKeyEnv: profile.apiKeyEnv } : {} }
    }
  }
  return undefined
}

/**
 * Read one route's published model list and prices. The endpoint is the configured route's own `/v1/models`, which the
 * kurogames gateway serves publicly; a route that publishes no prices, or a failed read, simply yields null.
 */
export async function publishedPrices(ctx: Context, provider: string): Promise<ReadonlyMap<string, ModelPrice> | null> {
  const profile = routeProfile(ctx, provider)
  if (!profile) return null
  const base = profile.baseURL.endsWith('/') ? profile.baseURL : `${profile.baseURL}/`
  let url: URL
  try { url = new URL('v1/models', base) } catch { return null }
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined
  if (key && url.protocol === 'https:') headers.authorization = `Bearer ${key}`
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    const body = record(await response.json())
    const rows = Array.isArray(body?.data) ? body.data : []
    const models = new Map<string, ModelPrice>()
    for (const row of rows) {
      const model = record(row)
      const id = text(model?.id), prompt = number(model?.prompt_cost_per_1m_cny), completion = number(model?.completion_cost_per_1m_cny)
      if (!id || prompt === undefined || completion === undefined) continue
      const cacheRead = number(model?.cache_read_cost_per_1m_cny) ?? prompt
      const cacheWrite = number(model?.cache_write_cost_per_1m_cny) ?? number(model?.cache_write_1h_cost_per_1m_cny) ?? prompt
      models.set(id, { prompt, completion, cacheRead, cacheWrite })
    }
    return models.size ? models : null
  } catch { return null }
}

/** The gateway quotes money in units of 1/10 000 CNY. */
const GATEWAY_MONEY_UNIT = 10_000
/** The gateway's portal reads its own clock: Beijing time, without daylight saving. */
const GATEWAY_OFFSET_MS = 8 * 3_600_000
/** Upper bound on timeline reads for one refresh; a busier hour is shown as a partial window rather than read forever. */
const GATEWAY_TIMELINE_READS = 24

/** One route's gateway endpoint and its key, resolved through the credentials service before the environment. */
async function gatewayRoute(ctx: Context, provider: string): Promise<{ base: string; key: string } | undefined> {
  const profile = routeProfile(ctx, provider)
  if (!profile?.apiKeyEnv) return undefined
  const base = profile.baseURL.endsWith('/') ? profile.baseURL : `${profile.baseURL}/`
  if (new URL(base).protocol !== 'https:') return undefined
  let key: string | undefined
  try {
    const credentials = ctx.get('credentials') as { resolve?(ref: string): Promise<{ value?: string } | undefined> } | undefined
    key = (await credentials?.resolve?.(profile.apiKeyEnv))?.value
  } catch { key = undefined }
  key ||= process.env[profile.apiKeyEnv]
  return key ? { base, key } : undefined
}

/** Beijing-time `YYYYMMDD` and `YYYY-MM-DDTHH:mm` for one instant, the portal's own query format. */
function gatewayClock(at: number): { date: string; minute: string } {
  const iso = new Date(at + GATEWAY_OFFSET_MS).toISOString()
  return { date: iso.slice(0, 10).replaceAll('-', ''), minute: iso.slice(0, 16) }
}

async function gatewayJson(route: { base: string; key: string }, path: string): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(new URL(path, route.base), { headers: { accept: 'application/json', authorization: `Bearer ${route.key}` },
    redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return undefined
  const body = record(await response.json())
  return body && body.error === undefined ? body : undefined
}

/** The account's current period from the portal's day summary; absent when it reports no period limit. */
function quotaOf(body: Record<string, unknown> | undefined, now: number): BillingQuota | undefined {
  const limit = number(body?.period_limit_cny), used = number(body?.period_used_cny), remaining = number(body?.period_remaining_cny)
  if (!limit || used === undefined || remaining === undefined) return undefined
  const end = number(record(body?.quota_v2)?.week_end)
  const snapshot = typeof body?.usage_snapshot_at === 'string' ? Date.parse(body.usage_snapshot_at) : Number.NaN
  return {
    source: 'gateway',
    limit: limit / GATEWAY_MONEY_UNIT,
    used: used / GATEWAY_MONEY_UNIT,
    remaining: remaining / GATEWAY_MONEY_UNIT,
    remainingPercent: Math.max(0, Math.min(100, remaining / limit * 100)),
    periodEnd: end ? end * 1000 : null,
    at: Number.isFinite(snapshot) ? snapshot : now,
  }
}

/**
 * Read the account a gateway route bills: its period quota and the requests it settled in [from, to). The source is the
 * kurogames gateway's own usage portal (`/my-usage/api/detail` and `/my-usage/api/timeline`), the same figures its
 * "我的用量" page shows; it is undocumented, so any failure yields what could be read and never an estimate. A timeline
 * answer is capped at 1000 requests, so a truncated range is split until each part is complete.
 */
export async function gatewayAccount(ctx: Context, provider: string, from: number, to: number): Promise<GatewayAccount | null> {
  let route: { base: string; key: string } | undefined
  try { route = await gatewayRoute(ctx, provider) } catch { return null }
  if (!route) return null
  const now = Date.now()
  let quota: BillingQuota | undefined
  try { quota = quotaOf(await gatewayJson(route, `my-usage/api/detail?date=${gatewayClock(now).date}`), now) } catch { quota = undefined }
  const requests: { at: number; cost: number; tokens: number }[] = []
  // Read the range oldest first, splitting a truncated part; coverage stays contiguous from `from`.
  const queue: [number, number][] = [[minuteOf(from), Math.max(minuteOf(from) + BUCKET_MS, to)]]
  let coveredTo = queue[0]![0], reads = 0
  while (queue.length && reads < GATEWAY_TIMELINE_READS) {
    const [start, end] = queue.shift()!
    reads += 1
    const first = gatewayClock(start), last = gatewayClock(end - BUCKET_MS)
    let body: Record<string, unknown> | undefined
    try {
      body = await gatewayJson(route, `my-usage/api/timeline?date=${first.date}&window=custom`
        + `&start=${encodeURIComponent(first.minute)}&end=${encodeURIComponent(last.minute)}`)
    } catch { body = undefined }
    const rows = Array.isArray(body?.requests) ? body.requests : undefined
    if (!rows) break
    if (body?.truncated === true && end - start > BUCKET_MS) {
      const middle = start + Math.ceil((end - start) / BUCKET_MS / 2) * BUCKET_MS
      queue.unshift([start, middle], [middle, end])
      continue
    }
    for (const row of rows) {
      const value = record(row)
      const at = typeof value?.timestamp === 'string' ? Date.parse(value.timestamp) : Number.NaN
      const cost = number(value?.cost_cny)
      if (!Number.isFinite(at) || at < start || at >= end || cost === undefined) continue
      requests.push({ at, cost: cost / GATEWAY_MONEY_UNIT, tokens: count(value?.total_tokens) ?? 0 })
    }
    coveredTo = end
  }
  if (!quota && coveredTo <= minuteOf(from)) return null
  return { ...quota ? { quota } : {}, ...coveredTo > minuteOf(from) ? { requests, covered: { from: minuteOf(from), to: coveredTo } } : {} }
}
