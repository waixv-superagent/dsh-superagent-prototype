/**
 * A workspace belongs to the worker that occupies it: a Ticket whose worker hands off a blocked or ready report releases
 * the tree with its slot, so a queued peer that needs the whole workspace starts instead of waiting for that person.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => {
  const space = mkdtempSync(join(tmpdir(), 'orchestrator-space-'))
  h = await startRuntime((store) => {
    const settings = store.settings()
    // A p4 Ticket is pinned to the task centre's default workspace, so two of them need the one tree this deployment has.
    store.saveSettings(SettingsSchema.parse({ ...settings,
      executor: { ...settings.executor, backend: 'p4',
        workspaces: [{ id: 'sun', directory: space, p4Client: 'agent_sun', slots: 1 }] } }))
  })
})
afterEach(async () => { await h.stop() })

/** The turn of a Session's agent ends, and DSH says so. */
const idle = (sessionId: string) => {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}

it('starts a pinned ticket once the peer that held the workspace handed off to a person', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  expect(h.runtime.store.tickets.get(one.ticket.id)!.execution!.workspace).toBe('sun')
  // The worker asks a person and its turn ends: its slot, and with it the workspace, is free again.
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' })
  await h.runtime.idle()
  idle(one.sessionId)
  await h.runtime.idle()
  expect(h.runtime.executor.activeCount()).toBe(0)
  const two = await h.acceptedTicket(feishu('2', '@bot 修二'))
  const second = h.runtime.store.tickets.get(two.ticket.id)!
  expect(second.execution!.workspace).toBe('sun')
  // The handed-off ticket still holds its Assignment while it waits for that person, which is what used to keep the tree.
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.state).toBe('running')
  expect(latestAssignment(second)?.state).toBe('running')
  expect(h.runtime.executor.waitOf(two.ticket.id)).toBeUndefined()
})
