/** Session store recovery: bounded reopen attempts, a blocked report when the store stays unreadable, and a tolerant shutdown. */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let hosts: Host[] = []
const started = async (): Promise<Host> => { const h = await startRuntime(); hosts.push(h); return h }
afterEach(async () => { for (const h of hosts.splice(0)) await h.stop() })

/** A DSH session-controller failure, as a resume that could not open the stored log returns it. */
const unreadable = (why: string) => ({ error: { code: 'gateway/internal', message: `resume failed for session: ${why}` } })

it('reopens a worker Session that fails to load twice, then starts it once the store is readable again', async () => {
  const h = await started()
  const fallback = h.resolveDefault
  let failures = 2
  h.controller.resolveAgent.mockImplementation(async (id: string) => {
    if (String(id).startsWith('worker-') && failures-- > 0) return unreadable('SessionPersistenceCorruptionError: torn tail') as never
    return fallback(id)
  })
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(failures).toBeLessThanOrEqual(0)
  // The first attempt failed and the bounded reopen recovered: the Assignment runs instead of blocking the ticket.
  expect(stored.assignments[0]!.state).toBe('running')
  expect(stored.assignments[0]!.report).toBeUndefined()
  expect(stored.repairs).toBeUndefined()
})

it('reports the Assignment blocked with the store error when the Session stays unreadable, keeping the history', async () => {
  const h = await started()
  const fallback = h.resolveDefault
  h.controller.resolveAgent.mockImplementation(async (id: string) => String(id).startsWith('worker-')
    ? unreadable('SessionPersistenceCorruptionError: a record fails validation') as never
    : fallback(id))
  const { ticket } = await h.acceptedTicket(feishu('2', '@bot 修一下回归'))
  await h.runtime.idle()
  const report = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report!
  expect(report.state).toBe('blocked')
  expect(report.summary).toContain('could not be opened after retrying')
  expect(report.summary).toContain('SessionPersistenceCorruptionError')
  expect(report.summary).toContain('stored history was kept')
})

it('stops the host even when the session store cannot flush, leaving the log for the next open', async () => {
  const h = await started()
  h.persistence.flush.mockRejectedValue(new Error('session-persistence-jsonl flush failed'))
  await expect(h.runtime.stop()).resolves.toBeUndefined()
})
