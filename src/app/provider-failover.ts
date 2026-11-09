/**
 * Provider-level failover for an exhausted model-account quota (docs/003): a managed Session whose request a provider refused
 * for its account quota (ACCOUNT_QUOTA, QUOTA or HTTP 402) runs on another provider that offers the same model instead of
 * failing the work, and a new Session is seeded away from a provider that failed that way recently. Only the provider changes,
 * never the model, so the work continues on the behaviour the Ticket was accepted with. A quota failure with no provider left
 * is a hard stop: the host never swaps in a different model on its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelRoute } from '../core/index.ts'
import type { RoleModel } from '../policy.ts'

/** DeepSeek Harness codes for a model request refused because the account's quota or balance is used up. */
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
/** HTTP status a provider returns for a request it refused because the account's quota is used up. */
const QUOTA_STATUS = 402
/** How long a provider that ran out of quota stays out of a new Session's way without a successful request proving it recovered. */
const GATE_MS = 30 * 60_000
/** One provider switch a Session made: the route that ran out of quota and the route that took over. */
export interface FailoverSwitch { readonly from: ModelRoute; readonly to: ModelRoute }
/** A route as the host names it in a message or a notice. */
export const routeText = (route: ModelRoute): string => `${route.provider}/${route.model}`

/**
 * True when a provider refused a model request for an exhausted account quota, a failure a later try meets again until the
 * account is topped up. The code wins over the message, as DeepSeek Harness's own retry policy routes on it; an HTTP 402 is
 * the same refusal from a provider that names no code.
 */
export function quotaExhausted(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown; failure?: { code?: unknown; status?: unknown } } | undefined
  const code = typeof value?.code === 'string' ? value.code : typeof value?.failure?.code === 'string' ? value.failure.code : undefined
  if (code !== undefined && QUOTA_CODES.has(code)) return true
  const status = typeof value?.status === 'number' ? value.status : value?.failure?.status
  return status === QUOTA_STATUS
}
/** Host dependencies of `ProviderFailover`: the Cordis context for the model catalog and Session events, and a clock. */
export interface ProviderFailoverHost { readonly context: Context; now?(): number }

/**
 * Keeps which providers recently ran out of quota and which providers one Session already tried after such a failure, and swaps
 * a Session's provider when it stopped on one. `Sessions` owns one: the Executor and the Watchdog ask it to fail over a worker
 * or the main Session, and `Sessions.ensure` asks `preferred` for the route a new Session is seeded with. A request that
 * succeeds on a gated provider clears the gate, and a turn that ends as turns do starts a fresh failure chain.
 */
export class ProviderFailover {
  /** Provider ids whose quota ran out, with when it did; a successful request clears the entry and the gate's time expires it. */
  private readonly gated = new Map<string, number>()
  /** The providers each Session already tried in one failure chain, by Session id; a turn that ends as turns do clears it. */
  private readonly tried = new Map<string, Set<string>>()
  private readonly ctx: Context
  private readonly now: () => number
  private readonly disposers: (() => void)[] = []
  constructor(private readonly host: ProviderFailoverHost) {
    this.ctx = host.context
    this.now = () => host.now?.() ?? Date.now()
  }
  /** Follows Session events: a turn that ends as turns do starts a new failure chain, and a request that succeeds ungates its provider. */
  install(): void {
    if (this.disposers.length) return
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.observe(session.id, event)))
  }
  /** Stops following Session events. */
  dispose(): void { for (const dispose of this.disposers.splice(0)) dispose() }
  /**
   * Handles one Session event: a turn that ended as turns do clears the Session's failure chain, so a later quota failure may
   * switch again; a model message that came from a gated provider proves the provider recovered and clears its gate.
   */
  observe(sessionId: string, event: { readonly type: string; readonly data: unknown }): void {
    if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
      if (reason?.kind !== 'error') this.tried.delete(sessionId)
      return
    }
    if (event.type !== 'assistant/message') return
    const source = (event.data as { message?: { source?: { kind?: unknown; provider?: unknown } } } | undefined)?.message?.source
    if (source?.kind === 'model' && typeof source.provider === 'string') this.gated.delete(source.provider)
  }
  /**
   * The route a new Session is seeded with: `model` itself, or the same model on another provider while its provider is gated;
   * `null` keeps DeepSeek Harness's default unless that default's provider is gated. The gate reads the catalog only when some
   * provider is gated, so an ordinary Session creation makes no catalog read.
   */
  async preferred(model: RoleModel | null): Promise<RoleModel | null> {
    this.prune()
    if (!this.gated.size) return model
    const catalog = await this.catalog()
    if (!catalog) return model
    const route = model ?? { provider: catalog.default.provider, model: catalog.default.model,
      ...(catalog.default.reasoningEffort === undefined ? {} : { reasoningEffort: catalog.default.reasoningEffort }) }
    if (!this.blocked(route.provider)) return model
    const to = this.alternative(catalog, route, new Set([route.provider]))
    if (!to) return model
    const selection = this.selection(catalog, route, to)
    // A route the host cannot resolve is no seed: a new Session keeps the configured model instead of failing to start.
    try { await this.ctx.llm.resolveCallConfig(selection) } catch { return model }
    this.ctx.logger.warn('dsh-superagent seeds a new Session on %s because %s ran out of account quota', routeText(selection), route.provider)
    return { provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
  }
  /**
   * Switches `agent`'s Session to another provider that offers its current model; undefined when its failure chain has no
   * provider left (all are tried or gated) or the chosen route does not resolve. The Session's own model is the only change:
   * the deployment default stays as a person configured it.
   */
  async failover(agent: Agent): Promise<FailoverSwitch | undefined> {
    const current = agent.model.current()
    if (!current) return undefined
    // Capture the route before selecting another: `select` changes the object `current` names on some hosts.
    const from: ModelRoute = { provider: current.provider, model: current.model }
    const tried = this.triedOf(agent.id)
    tried.add(from.provider)
    const catalog = await this.catalog()
    if (!catalog) return undefined
    const to = this.alternative(catalog, current, tried)
    if (!to) return undefined
    const selection = this.selection(catalog, current, to)
    try { await this.ctx.llm.resolveCallConfig(selection) } catch (error) {
      this.ctx.logger.warn('dsh-superagent will not fail over to %s: %s', routeText(to), String(error))
      return undefined
    }
    agent.model.select(selection)
    this.gated.set(from.provider, this.now())
    return { from, to }
  }
  /** The catalog's first provider, other than the failing one and the gate's, that offers `route`'s model id. */
  private alternative(catalog: ModelCatalog, route: ModelRoute, exclude: Set<string>): ModelRoute | undefined {
    for (const group of catalog.groups) {
      if (exclude.has(group.id) || this.blocked(group.id)) continue
      const model = group.models.find(entry => entry.id === route.model)
      if (model) return { provider: group.id, model: model.id }
    }
    return undefined
  }
  /** The selection for `to`, keeping `from`'s reasoning effort only when the new route advertises that effort. */
  private selection(catalog: ModelCatalog, from: ModelRoute & { readonly reasoningEffort?: string }, to: ModelRoute) {
    const model = catalog.groups.find(group => group.id === to.provider)?.models.find(entry => entry.id === to.model)
    const efforts = model?.reasoning?.efforts.map(effort => effort.id) ?? []
    const effort = from.reasoningEffort !== undefined && efforts.includes(from.reasoningEffort) ? ReasoningEffortId(from.reasoningEffort) : undefined
    return { provider: to.provider, model: to.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  }
  /** Whether `provider` is gated: its quota failed within the gate's time. A stale gate is dropped as it is read. */
  private blocked(provider: string): boolean {
    const since = this.gated.get(provider)
    if (since === undefined) return false
    if (this.now() - since < GATE_MS) return true
    this.gated.delete(provider)
    return false
  }
  /** Drops every gate that has expired, so an idle host does not keep an old quota failure forever. */
  private prune(): void { for (const provider of [...this.gated.keys()]) this.blocked(provider) }
  /** The provider set of one Session's current failure chain, created on its first quota failure. */
  private triedOf(sessionId: string): Set<string> {
    let tried = this.tried.get(sessionId)
    if (!tried) { tried = new Set(); this.tried.set(sessionId, tried) }
    return tried
  }
  /** The deployment's routable model catalog; undefined when it cannot be read, which makes no failover rather than a wrong one. */
  private async catalog(): Promise<ModelCatalog | undefined> {
    try { return await this.ctx.sessionController.modelCatalog() } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not read the model catalog for provider failover: %s', String(error))
      return undefined
    }
  }
}
