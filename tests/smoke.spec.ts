/** S1 smoke: a ticket goes from accept to a worker with its tools, its transcript is readable, and a ready report ends it. */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let hosts: Host[] = []
afterEach(async () => { for (const h of hosts.splice(0)) await h.stop() })

it('accepts a ticket, starts a worker with its work tools, reads its transcript, and ends on a ready report', async () => {
  const h = await startRuntime()
  hosts.push(h)
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const sessionId = `worker-${ticket.id}`
  // The worker got the preset's work tools, not an empty face (the 2026-11-03 incident): the check names them, and the
  // Session carries its own orchestrator tools on top.
  const health = h.runtime.health['worker-tools']!
  expect(health.state).toBe('ready')
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', process.platform === 'win32' ? 'pwsh' : 'bash']) expect(health.detail).toContain(name)
  expect(h.tools.get(sessionId)!.has('orchestrator_read')).toBe(true)
  // The transcript read works through the session query service that replaced sessionController.inspect.
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/transcript` })).toBeDefined()
  // One turn ends with its result, which completes this analysis-style ticket.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'fixed, typecheck and tests pass' })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'completed' })
})
