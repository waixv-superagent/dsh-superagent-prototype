/** The worker capability face: a profile that resolves too few tools blocks the Assignment at launch instead of doing nothing. */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let hosts: Host[] = []
const started = async (...args: Parameters<typeof startRuntime>): Promise<Host> => {
  const h = await startRuntime(...args)
  hosts.push(h)
  return h
}
afterEach(async () => { for (const h of hosts.splice(0)) await h.stop() })

it('passes a normal worker profile and reports the tool face on the worker-tools health entry', async () => {
  const h = await started()
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runtime.idle()
  expect(h.runtime.health['worker-tools']).toMatchObject({ state: 'ready', detail: expect.stringContaining('worker resolves read') })
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report?.state).not.toBe('blocked')
})

it('blocks the Assignment at the first message, naming every missing tool, when the profile resolves none', async () => {
  const h = await started(undefined, { missingTools: ['read', 'write', 'pwsh', 'bash'] })
  const { ticket } = await h.acceptedTicket(feishu('2', '@bot 修一下回归'))
  await h.runtime.idle()
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const report = stored.assignments.at(-1)!.report!
  expect(report.state).toBe('blocked')
  expect(report.summary).toContain('read')
  expect(report.summary).toContain('write')
  expect(report.summary).toContain('bash|pwsh')
  // The ticket asks a person to fix the profile, and the health entry is red with the same evidence.
  expect(h.runtime.health['worker-tools']).toMatchObject({ state: 'error', detail: expect.stringContaining('missing required tools: read, write, bash|pwsh') })
  expect(h.runtime.health.runtime).toMatchObject({ state: 'ready' })
})

