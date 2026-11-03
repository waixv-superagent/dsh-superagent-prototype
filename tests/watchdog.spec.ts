import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECOVERY_DELAYS_MS, RECOVERY_TRIES, Watchdog, type WatchdogHost } from '../src/app/watchdog.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'
import type { HealthEntry } from '../src/infra/health.ts'
import type { Sessions } from '../src/app/sessions.ts'

const NOW = Date.parse('2026-11-03T16:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const PASSING = 'LlmError: 503: {"message":"额度服务暂不可用","trace_id":"1"}'
const FAILING = 'AggregateError: session-persistence-jsonl flush failed'
const MASTER = 'master'

function ticket (assignments: Assignment[], overrides: Partial<Ticket> = {}): Ticket {
  return { id: 't1', title: 'Fix', decisionId: 'd',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' },
    channels: [], assignments, inputs: [], undelivered: [], createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000),
    origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides }
}
function failed (summary: string, at: number): Assignment {
  return { id: `a-${at}-${summary.length}`, state: 'running', createdAt: iso(at), report: { state: 'failed', summary, at: iso(at) } }
}
function ended (reason: string, at: number): Assignment {
  return { id: `e-${reason}-${at}`, state: 'ended', createdAt: iso(at), endedAt: iso(at), endedReason: reason }
}

interface Harness {
  watch: Watchdog
  recover: ReturnType<typeof vi.fn<(id: string) => Ticket>>
  ensure: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  agents: Map<string, { id: string; status: string }>
  open: { tickets: Ticket[]; open: () => Ticket[] }
  health: { value: { state: string; detail: string } }
  paused: { value: boolean }
  clock: { value: number }
  emit: (event: string, ...args: unknown[]) => void
}

function harness (tickets: Ticket[] = []): Harness {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const agents = new Map<string, { id: string; status: string }>()
  const context = {
    agents: { get: (id: string) => agents.get(id) },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    }
  }
  const health = { value: { state: 'ready', detail: '' } }
  const entry: HealthEntry = { get: () => health.value as never, set: value => { health.value = value as never }, release: () => {} }
  const paused = { value: false }
  const clock = { value: NOW }
  const open = { tickets, open: () => open.tickets }
  const recover = vi.fn<(id: string) => Ticket>()
  const ensure = vi.fn(async (id: string) => { agents.set(id, { id, status: 'idle' }); return agents.get(id) })
  const prompt = vi.fn(async () => {})
  const host: WatchdogHost = { context: context as unknown as Context, tickets: open, engine: { recoverTicket: recover },
    master: { id: MASTER, title: 'orchestrator', directory: () => '/state' },
    sessions: { ensure, prompt } as unknown as Pick<Sessions, 'ensure' | 'prompt'>, health: entry,
    paused: () => paused.value, now: () => clock.value }
  const emit = (event: string, ...args: unknown[]): void => { for (const handler of listeners.get(event) ?? []) handler(...args) }
  return { watch: new Watchdog(host), recover, ensure, prompt, agents, open, health, paused, clock, emit }
}

afterEach(() => { vi.useRealTimers() })

describe('a ticket whose worker stopped on a passing failure', () => {
  it('is retried once its backoff is due, and not before', async () => {
    const h = harness([ticket([failed(PASSING, NOW - 10_000)])])
    await h.watch.poll()
    expect(h.recover).not.toHaveBeenCalled()
    h.clock.value = NOW + 49_999
    await h.watch.poll()
    expect(h.recover).not.toHaveBeenCalled()
    h.clock.value = NOW + 50_000
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledWith('t1')
  })

  it('keeps the retry count across the host\'s own retries and starts again after a person retried', async () => {
    const h = harness([ticket([failed(PASSING, NOW - 120_000)])])
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(1)
    // The host's retry runs: the new assignment is pending, and its failure keeps the chain's count.
    h.open.tickets = [ticket([ended('recovered', NOW - 120_000), { id: 'a2', state: 'pending', createdAt: iso(NOW) }])]
    h.clock.value = NOW + 10_000
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(1)
    const later = NOW + 11_000
    h.open.tickets = [ticket([ended('recovered', NOW - 120_000), failed(PASSING, later)])]
    h.clock.value = later + RECOVERY_DELAYS_MS[0]
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(1)
    h.clock.value = later + RECOVERY_DELAYS_MS[1] + 1
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(2)
    // A person's retry starts the count again, so the first delay applies.
    const after = h.clock.value + 1_000
    h.open.tickets = [ticket([ended('retried', later), failed(PASSING, after)])]
    h.clock.value = after + RECOVERY_DELAYS_MS[0] - 1
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(2)
    h.clock.value = after + RECOVERY_DELAYS_MS[0]
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(3)
  })

  it('is left alone for a failure a later try would meet again, a blocked report, a person\'s follow-up, a question, a failed delivery or a paused host', async () => {
    const h = harness([
      ticket([failed(FAILING, NOW - 600_000)], { id: 'failing' }),
      ticket([{ id: 'b', state: 'running', createdAt: iso(NOW - 600_000), report: { state: 'blocked', summary: PASSING, at: iso(NOW - 600_000) } }], { id: 'blocked' }),
      ticket([failed(PASSING, NOW - 600_000)], { id: 'followed',
        inputs: [{ id: 'i', kind: 'trigger', triggerId: 't', at: iso(NOW - 60_000), human: true }] }),
      ticket([failed(PASSING, NOW - 600_000)], { id: 'question', attention: { id: 'q', question: 'Which?' } }),
      ticket([failed(PASSING, NOW - 600_000)], { id: 'undelivered', delivery: { error: 'Session offline', at: iso(NOW - 60_000) } })
    ])
    await h.watch.poll()
    expect(h.recover).not.toHaveBeenCalled()
    expect(h.health.value.state).toBe('ready')
    h.paused.value = true
    h.open.tickets = [ticket([failed(PASSING, NOW - 600_000)])]
    await h.watch.poll()
    expect(h.recover).not.toHaveBeenCalled()
  })

  it('stops retrying after the last attempt and waits for a person', async () => {
    const h = harness([])
    let previous: string | undefined
    for (let attempt = 0; attempt < RECOVERY_TRIES; attempt++) {
      const at = h.clock.value - 60 * 60_000
      const chain = previous ? [ended(previous, at - 1_000)] : []
      h.open.tickets = [ticket([...chain, failed(PASSING, at)])]
      await h.watch.poll()
      expect(h.recover).toHaveBeenCalledTimes(attempt + 1)
      previous = 'recovered'
      h.clock.value += 31 * 60_000
    }
    h.open.tickets = [ticket([ended('recovered', h.clock.value - 3_600_000), failed(PASSING, h.clock.value - 60 * 60_000)])]
    await h.watch.poll()
    expect(h.recover).toHaveBeenCalledTimes(RECOVERY_TRIES)
  })

  it('shows the pending recovery in the watchdog health entry and clears it when the ticket works again', async () => {
    const h = harness([ticket([failed(PASSING, NOW - 10_000)])])
    await h.watch.poll()
    expect(h.health.value.state).toBe('error')
    expect(h.health.value.detail).toContain('1 ticket(s)')
    h.open.tickets = [ticket([failed(PASSING, NOW - 10_000), { id: 'a2', state: 'running', createdAt: iso(NOW),
      report: { state: 'waiting', summary: 'idle', at: iso(NOW) } }])]
    await h.watch.poll()
    expect(h.health.value.state).toBe('ready')
  })
})

describe('the main Session', () => {
  it('is created again when it disappeared, and left alone while it exists', async () => {
    const h = harness()
    await h.watch.ensureMaster()
    expect(h.ensure).toHaveBeenCalledWith(MASTER, '/state', 'orchestrator', 'orchestrator')
    await h.watch.ensureMaster()
    expect(h.ensure).toHaveBeenCalledTimes(1)
  })

  it('reports what it is recovering through status, which the state API carries to the Feishu status card', async () => {
    vi.useFakeTimers()
    const h = harness([ticket([failed(PASSING, NOW - 10_000)])])
    expect(h.watch.status()).toEqual({ recovering: false, tickets: 0, master: false, gaveUp: false, missing: false })
    h.clock.value = NOW + 50_000
    await h.watch.poll()
    expect(h.watch.status()).toMatchObject({ recovering: true, tickets: 1, master: false })
    h.agents.set(MASTER, { id: MASTER, status: 'idle' })
    h.watch.masterTurnFailed(Object.assign(new Error('503'), { status: 503 }))
    expect(h.watch.status()).toMatchObject({ recovering: true, master: true })
    // A main Session that cannot be created again is a recovery state of its own.
    h.agents.delete(MASTER)
    h.ensure.mockRejectedValueOnce(new Error('Session store offline'))
    await h.watch.ensureMaster()
    expect(h.watch.status()).toMatchObject({ missing: true })
    await h.watch.stop()
  })

  it('is told to go on after a passing failure, on the retry backoff', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.agents.set(MASTER, { id: MASTER, status: 'idle' })
    h.watch.masterTurnFailed(Object.assign(new Error('503: gateway unavailable'), { status: 503, code: 'SERVER' }))
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0] - 1)
    expect(h.prompt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.prompt).toHaveBeenCalledWith(MASTER, 'recover:master:1', expect.stringContaining('Your last turn failed for a passing reason'), 'queue')
  })

  it('is never retried for a failure a later try would meet again', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.watch.masterTurnFailed(Object.assign(new Error('account quota exhausted'), { code: 'QUOTA', status: 429 }))
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.prompt).not.toHaveBeenCalled()
  })

  it('starts over when a turn ends as turns do, so a person\'s later turn ends the chain', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.agents.set(MASTER, { id: MASTER, status: 'idle' })
    h.watch.start()
    h.watch.masterTurnFailed(Object.assign(new Error('503'), { status: 503 }))
    h.emit('session/event', { id: MASTER }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.health.value.state).toBe('ready')
    await h.watch.stop()
  })

  it('waits while the Session runs or processing is paused', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.agents.set(MASTER, { id: MASTER, status: 'running' })
    h.watch.masterTurnFailed(Object.assign(new Error('503'), { status: 503 }))
    await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0] + 1_000)
    expect(h.prompt).not.toHaveBeenCalled()
    h.agents.set(MASTER, { id: MASTER, status: 'idle' })
    h.paused.value = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.prompt).not.toHaveBeenCalled()
    h.paused.value = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.prompt).toHaveBeenCalledTimes(1)
  })
})
