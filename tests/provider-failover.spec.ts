/** Provider-level failover for an exhausted account quota (docs/003): another provider runs the same model, never a different one. */
import { describe, expect, it, vi } from 'vitest'
import { ProviderFailover, routeText, quotaExhausted } from '../src/app/provider-failover.ts'
import type { RoleModel } from '../src/policy.ts'
import { CATALOG, SESSION_MODEL } from './fixtures/host.ts'

type Route = { provider: string; model: string; reasoningEffort?: string }
/** A deployment whose two providers offer the same model, the second one also another model; a clock and a Session's model. */
function harness(options: { catalog?: unknown; model?: Route } = {}) {
  const now = { value: Date.parse('2026-11-06T00:00:00Z') }
  const listeners: ((session: { id: string }, event: { type: string; data: unknown }) => void)[] = []
  const context = {
    on: vi.fn((_event: string, handler: (session: { id: string }, event: { type: string; data: unknown }) => void) => {
      listeners.push(handler)
      return () => {}
    }),
    logger: { warn: vi.fn() },
    llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) },
    sessionController: { modelCatalog: vi.fn(async () => options.catalog ?? CATALOG) },
  }
  const model: Route = { ...(options.model ?? SESSION_MODEL) }
  const agent = { id: 'worker-t1', model: { current: () => model, select: vi.fn((next: Route) => { Object.assign(model, next) }) } }
  const failover = new ProviderFailover({ context: context as never, now: () => now.value })
  failover.install()
  const emit = (sessionId: string, type: string, data: unknown) => { for (const listener of listeners) listener({ id: sessionId }, { type, data }) }
  return { failover, agent, model, context, now, emit }
}
const role = (provider: string): RoleModel => ({ provider, model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })

describe('quotaExhausted', () => {
  it('recognizes an exhausted account quota by code or HTTP 402, and nothing else', () => {
    expect(quotaExhausted(Object.assign(new Error('x'), { code: 'ACCOUNT_QUOTA' }))).toBe(true)
    expect(quotaExhausted(Object.assign(new Error('x'), { code: 'QUOTA' }))).toBe(true)
    expect(quotaExhausted(Object.assign(new Error('x'), { status: 402 }))).toBe(true)
    expect(quotaExhausted({ failure: { code: 'ACCOUNT_QUOTA', status: 402 } })).toBe(true)
    expect(quotaExhausted(Object.assign(new Error('x'), { code: 'AUTH', status: 401 }))).toBe(false)
    expect(quotaExhausted(Object.assign(new Error('x'), { code: 'RATE_LIMIT', status: 429 }))).toBe(false)
    expect(quotaExhausted(Object.assign(new Error('x'), { status: 500 }))).toBe(false)
    expect(quotaExhausted(new Error('quota'))).toBe(false)
  })
})

describe('ProviderFailover', () => {
  it('moves a Session to the same model on another provider and gates the exhausted one', async () => {
    const h = harness()
    expect(await h.failover.failover(h.agent as never)).toEqual({ from: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' },
      to: { provider: 'ai-gateway', model: 'deepseek-v4.1-flash' } })
    expect(h.agent.model.select).toHaveBeenCalledWith({ provider: 'ai-gateway', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
    expect(h.model).toEqual({ provider: 'ai-gateway', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
    // The caller reads the route it moved to from the Session, not from the return value.
    expect(routeText(h.agent.model.current()!)).toBe('ai-gateway/deepseek-v4.1-flash')
  })

  it('gates a provider a new Session is seeded away from, until a request succeeds on it or the gate time passes', async () => {
    const h = harness()
    await h.failover.failover(h.agent as never)
    // The exhausted provider no longer gets a new Session's first request; the same model starts on the other one.
    expect(await h.failover.preferred(role('deepseek-account'))).toEqual(role('ai-gateway'))
    // The other provider is not gated, so its configured route is kept.
    expect(await h.failover.preferred(role('ai-gateway'))).toEqual(role('ai-gateway'))
    // A model message from the gated provider proves it recovered and clears its gate.
    h.emit('worker-t9', 'assistant/message', { message: { source: { kind: 'model', provider: 'deepseek-account' } } })
    expect(await h.failover.preferred(role('deepseek-account'))).toEqual(role('deepseek-account'))
    // Without a successful request the gate expires on its own.
    await h.failover.failover(h.agent as never)
    h.now.value += 31 * 60_000
    expect(await h.failover.preferred(role('deepseek-account'))).toEqual(role('deepseek-account'))
  })

  it('makes no catalog read for a new Session while no provider is gated, and gates no provider otherwise', async () => {
    const h = harness()
    expect(await h.failover.preferred(role('deepseek-account'))).toEqual(role('deepseek-account'))
    expect(await h.failover.preferred(null)).toBeNull()
    expect(h.context.sessionController.modelCatalog).not.toHaveBeenCalled()
  })

  it('seeds a new Session away from the default model\'s gated provider', async () => {
    // The catalog default is ai-gateway, so the Session that runs out of quota must be the one on it.
    const h = harness({ model: { provider: 'ai-gateway', model: 'deepseek-v4.1-flash' } })
    await h.failover.failover(h.agent as never)
    expect(await h.failover.preferred(null)).toEqual({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
  })

  it('does not start a new failure chain after one switch, and starts one after a turn that ended as turns do', async () => {
    const h = harness()
    await h.failover.failover(h.agent as never)
    // The Session now runs on ai-gateway; its quota failure has no second provider to try (deepseek-account is gated).
    expect(await h.failover.failover(h.agent as never)).toBeUndefined()
    // A turn that ends as turns do clears the chain, but a gated provider is still no failover target.
    h.emit('worker-t1', 'turn/end', { reason: { kind: 'completed' } })
    expect(await h.failover.failover(h.agent as never)).toBeUndefined()
    // Past the gate's time the provider is no longer gated: the next failure moves back to it.
    h.now.value += 31 * 60_000
    expect(await h.failover.failover(h.agent as never)).toEqual({ from: { provider: 'ai-gateway', model: 'deepseek-v4.1-flash' },
      to: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' } })
  })

  it('keeps an errored turn in the chain, so a repeated failure cannot try a provider twice', async () => {
    const h = harness()
    await h.failover.failover(h.agent as never)
    h.emit('worker-t1', 'turn/end', { reason: { kind: 'error' } })
    expect(await h.failover.failover(h.agent as never)).toBeUndefined()
  })

  it('drops a reasoning effort the other provider does not offer', async () => {
    const h = harness({ model: { provider: 'deepseek-account', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } })
    await h.failover.failover(h.agent as never)
    expect(h.agent.model.select).toHaveBeenCalledWith({ provider: 'ai-gateway', model: 'deepseek-v4.1-flash' })
  })

  it('never swaps in a different model: no alternative model id means no failover', async () => {
    const h = harness({ catalog: { ...CATALOG, groups: [CATALOG.groups[0]!] } })
    expect(await h.failover.failover(h.agent as never)).toBeUndefined()
    expect(h.agent.model.select).not.toHaveBeenCalled()
  })

  it('takes no failover whose route does not resolve', async () => {
    const h = harness()
    h.context.llm.resolveCallConfig.mockRejectedValueOnce(new Error('no adapter for the route'))
    expect(await h.failover.failover(h.agent as never)).toBeUndefined()
    expect(h.agent.model.select).not.toHaveBeenCalled()
  })

  it('takes no failover when the catalog cannot be read', async () => {
    const h = harness()
    h.context.sessionController.modelCatalog.mockRejectedValueOnce(new Error('listing offline'))
    expect(await h.failover.failover(h.agent as never)).toBeUndefined()
    expect(h.agent.model.select).not.toHaveBeenCalled()
  })
})
