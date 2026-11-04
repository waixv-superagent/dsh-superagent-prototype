/** Loop-integrity invariant I4: which ticket states are provably inconsistent, and how the host reprojects them. */
import { afterEach, expect, it } from 'vitest'
import { REPAIR_LIMIT, REPROJECT_AFTER_MS, reprojectable } from '../src/core/index.ts'
import type { Assignment, Liveness, Ticket } from '../src/core/index.ts'
import { ticketSummary } from '../src/app/views/records.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const NOW = Date.parse('2026-11-04T04:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({ id: 'assignment-1', state: 'running',
  createdAt: iso(NOW - REPROJECT_AFTER_MS - 1000), startedAt: iso(NOW - REPROJECT_AFTER_MS - 1000), ...overrides })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 'ticket-1', title: 'Fix', decisionId: 'decision-1',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { rules: [] }, actor: { source: 'feishu', id: 'ou_a' }, scope: '' },
  channels: [], assignments: [assignment()], inputs: [], undelivered: [], createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 3_600_000),
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...overrides }) as Ticket
/** The host's live view: everything alive and every effect queued unless a test says otherwise. */
const live = (overrides: Partial<Liveness> = {}): Liveness => ({ active: () => true, launching: () => true, delivering: () => true, ...overrides })

it('relaunches a pending Assignment whose launch effect is gone, and leaves one with a launch, a person, or a fresh start', () => {
  const pending = () => ticket({ assignments: [assignment({ state: 'pending', startedAt: undefined })] })
  expect(reprojectable(pending(), live({ launching: () => false }), NOW)).toMatchObject({ invariant: 'launch', action: 'relaunch',
    assignment: { id: 'assignment-1' } })
  expect(reprojectable(pending(), live(), NOW)).toBeUndefined()
  // A ticket waiting for a person is theirs, not the host's to relaunch.
  const blocked = ticket({ assignments: [assignment({ state: 'pending', startedAt: undefined, report: { state: 'blocked', summary: 'needs a person', at: iso(NOW - 1000) } })] })
  expect(reprojectable(blocked, live({ launching: () => false }), NOW)).toBeUndefined()
  // A fresh Assignment may still be in flight.
  const fresh = ticket({ assignments: [assignment({ state: 'pending', startedAt: undefined, createdAt: iso(NOW - 1000) })] })
  expect(reprojectable(fresh, live({ launching: () => false }), NOW)).toBeUndefined()
})

it('restarts a running Assignment with no live worker and no report, and never second-guesses a report', () => {
  expect(reprojectable(ticket(), live({ active: () => false }), NOW)).toMatchObject({ invariant: 'assignment', action: 'restart' })
  expect(reprojectable(ticket(), live(), NOW)).toBeUndefined()
  expect(reprojectable(ticket({ assignments: [assignment({ report: { state: 'progress', summary: 'working', at: iso(NOW - 2000) } })] }),
    live({ active: () => false }), NOW)).toBeUndefined()
  // A running Assignment older than the window is the only one considered; a younger one may still be starting.
  const young = ticket({ assignments: [assignment({ startedAt: iso(NOW - 1000) })] })
  expect(reprojectable(young, live({ active: () => false }), NOW)).toBeUndefined()
})

it('re-queues delivery for Inputs nobody is handing over, unless an effect or a reported failure exists', () => {
  const waiting = ticket({ undelivered: ['input-1'] })
  expect(reprojectable(waiting, live({ delivering: () => false }), NOW)).toMatchObject({ invariant: 'delivery', action: 'deliver' })
  expect(reprojectable(waiting, live(), NOW)).toBeUndefined()
  expect(reprojectable(ticket({ undelivered: ['input-1'], delivery: { error: 'worker busy', at: iso(NOW - 1000) } }),
    live({ delivering: () => false }), NOW)).toBeUndefined()
})

it('stops repairing after the limit and leaves the ticket to a person instead of looping', () => {
  const repairs = Array.from({ length: REPAIR_LIMIT }, (_, index) => ({ at: iso(NOW - index * 1000), invariant: 'assignment' as const,
    action: 'restart' as const, detail: 'restarted' }))
  const repaired = ticket({ repairs })
  expect(reprojectable(repaired, live({ active: () => false }), NOW)).toMatchObject({ invariant: 'assignment', action: 'blocked' })
  // An ended ticket has no live state to reproject.
  expect(reprojectable(ticket({ ended: { at: iso(NOW), by: 'executor', outcome: 'completed' } }), live({ active: () => false }), NOW)).toBeUndefined()
})

let hosts: Host[] = []
afterEach(async () => { for (const h of hosts.splice(0)) await h.stop() })

it('restarts a running Assignment whose worker Session vanished, records the repair, and shows it on the board', async () => {
  const h = await startRuntime()
  hosts.push(h)
  const { ticket: started } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const sessionId = `worker-${started.id}`
  expect(h.agents.has(sessionId)).toBe(true)
  // The Session vanished externally and the Assignment is old with no report: the state nothing can progress.
  h.agents.delete(sessionId)
  h.runtime.store.atomic(() => {
    const current = h.runtime.store.tickets.get(started.id)!
    current.assignments.at(-1)!.startedAt = new Date(Date.now() - REPROJECT_AFTER_MS - 60_000).toISOString()
    h.runtime.store.tickets.save(current)
  })
  // Past the sweep's own throttle, as a later pass would be.
  h.runtime.executor.reproject(Date.now() + 60_000)
  await h.runtime.idle()
  const repaired = h.runtime.store.tickets.get(started.id)!
  expect(repaired.repairs).toEqual([expect.objectContaining({ invariant: 'assignment', action: 'restart' })])
  expect(repaired.assignments).toHaveLength(2)
  expect(repaired.assignments.at(-1)!.state).toBe('running')
  // The board's ticket row carries the trace for the "system handled it" strip.
  expect(ticketSummary(repaired).repairs).toEqual(repaired.repairs)
})



