/** Placement of Tickets into workspaces: slots, lease overlap, and the conflicts a queued Ticket reports. */
import { describe, expect, it } from 'vitest'
import { claimsWorkspace, conflicts, LeaseSchema, normalizePath, overlap, place, placeTicket, running, workspaceClient, WorkspaceSchema, type Active, type Workspace } from '../src/executor/workspace.ts'
import { ticketExecution } from '../src/executor/dsh.ts'
import { SettingsSchema } from '../src/policy.ts'

const workspace = (id: string, slots = 1): Workspace => ({ id, directory: `C:/work/${id}`, p4Client: '', slots })

describe('lease overlap', () => {
  it('treats an empty lease as the whole workspace, so it excludes every peer', () => {
    expect(overlap([], ['Source/A/'])).toBe(true)
    expect(overlap(['Source/A/'], [])).toBe(true)
  })
  it('overlaps equal paths and either direction of containment', () => {
    expect(overlap(['Source/A/'], ['Source/A/'])).toBe(true)
    expect(overlap(['Source/A/'], ['Source/A/B.cpp'])).toBe(true)
    expect(overlap(['Source/A/B.cpp'], ['Source/A/'])).toBe(true)
  })
  it('does not overlap sibling directories, a shared text prefix, or separate files', () => {
    expect(overlap(['Source/A/'], ['Source/B/'])).toBe(false)
    expect(overlap(['Source/A/'], ['Source/AB/'])).toBe(false)
    expect(overlap(['Source/A/x.cpp'], ['Source/A/y.cpp'])).toBe(false)
  })
  it('compares paths the same however they were written', () => {
    expect(normalizePath('\\Source\\A\\')).toBe('Source/A')
    expect(overlap(['Source\\A'], ['Source/A/B.cpp'])).toBe(true)
    expect(overlap(['/Source/A/'], ['Source/A'])).toBe(true)
  })
})

describe('placement', () => {
  it('names the p4 client a workspace owns, from its own name or the template', () => {
    expect(workspaceClient({ id: 'main', p4Client: '' }, 'dsh-<name>')).toBe('dsh-main')
    expect(workspaceClient({ id: 'main', p4Client: 'agent_workspace' }, 'dsh-<name>')).toBe('agent_workspace')
  })
  it('places into the first workspace with a free slot and no overlap', () => {
    const spaces = [workspace('one'), workspace('two')]
    expect(place(spaces, [], ['Source/A/'])?.id).toBe('one')
    const active: Active[] = [{ workspace: 'one', lease: ['Source/A/'] }]
    // One slot: the disjoint ticket fits the other workspace, not the busy one.
    expect(place(spaces, active, ['Source/B/'])?.id).toBe('two')
    expect(place(spaces, active, ['Source/A/'])?.id).toBe('two')
  })
  it('waits when every free slot overlaps, rather than sharing a file', () => {
    const spaces = [workspace('one')]
    const active: Active[] = [{ workspace: 'one', lease: ['Source/A/'] }]
    expect(place(spaces, active, ['Source/A/x.cpp'])).toBe(undefined)
  })
  it('counts slots, so a second ticket may share a workspace of two slots when both leases are disjoint', () => {
    const spaces = [workspace('one', 2)]
    const active: Active[] = [{ workspace: 'one', lease: ['Source/A/'] }]
    expect(running(active, 'one')).toBe(1)
    expect(place(spaces, active, ['Source/B/'])?.id).toBe('one')
  })
  it('treats an empty lease as conflicting if it ever reaches placement', () => {
    // The Executor keeps a Ticket that named no paths out of the pool (see `claimsWorkspace`), so this is only the pure
    // overlap rule: an empty lease means the whole workspace and excludes every peer.
    const spaces = [workspace('one', 4)]
    const active: Active[] = [{ workspace: 'one', lease: ['Source/A/'] }]
    expect(place(spaces, active, [])).toBe(undefined)
  })
  it('names the running tickets a queued ticket conflicts with', () => {
    const active: Active[] = [{ workspace: 'one', lease: ['Source/A/'] }, { workspace: 'one', lease: ['Source/B/'] }]
    expect(conflicts(active, ['Source/A/x.cpp'])).toEqual([{ workspace: 'one', lease: ['Source/A/'] }])
  })
  it('places a pinned ticket in its own workspace, waiting for it rather than moving elsewhere', () => {
    const spaces = [workspace('one'), workspace('two')]
    // A pinned ticket ignores a free second workspace: it belongs in the default one.
    const active: Active[] = [{ workspace: 'one', lease: ['Source/A/'] }]
    expect(placeTicket(spaces, active, ['Source/B/'], 'one')).toBe(undefined)
    expect(placeTicket(spaces, [], ['Source/B/'], 'one')?.id).toBe('one')
    // An empty lease is the whole workspace, so any peer in it makes the pinned ticket wait.
    expect(placeTicket(spaces, active, [], 'one')).toBe(undefined)
    // A pin this installation no longer configures falls back to the pool, so a stale record cannot wedge a ticket.
    expect(placeTicket(spaces, [], ['Source/B/'], 'gone')?.id).toBe('one')
    // Without a pin, the first free workspace with no overlap is chosen, as before.
    expect(placeTicket(spaces, active, ['Source/B/'])?.id).toBe('two')
  })
})

describe('pool membership', () => {
  it('counts a leased path as a claim: only a Ticket with no pinned workspace needs one to enter the pool', () => {
    expect(claimsWorkspace([])).toBe(false)
    expect(claimsWorkspace(['Source/A/'])).toBe(true)
  })
})

describe('settings schema', () => {
  it('defaults a workspace to one slot, no p4 client, and rejects an unusable id', () => {
    expect(WorkspaceSchema.parse({ id: 'one', directory: 'C:/work/one' })).toEqual({ id: 'one', directory: 'C:/work/one', p4Client: '', slots: 1 })
    expect(() => WorkspaceSchema.parse({ id: 'One Two', directory: 'C:/work' })).toThrow()
    expect(() => WorkspaceSchema.parse({ id: 'one', directory: 'C:/work', extra: true })).toThrow()
  })
  it('defaults a lease to none and refuses blank entries', () => {
    expect(LeaseSchema.parse(undefined)).toEqual([])
    expect(() => LeaseSchema.parse(['  '])).toThrow()
  })
  it('starts with no pool, so a ticket keeps its own directory', () => {
    expect(SettingsSchema.parse({}).executor.workspaces).toEqual([])
    const pool = SettingsSchema.parse({ executor: { workspaces: [{ id: 'main', directory: '/work/main', slots: 2 }] } })
    expect(pool.executor.workspaces).toEqual([{ id: 'main', directory: '/work/main', p4Client: '', slots: 2 }])
  })
})

describe('ticket execution', () => {
  const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
    mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: [] }, actor: { source: 'github', id: 'alice' }, scope: '' } } as never
  const accept = (paths?: string[]) => ({ kind: 'accept' as const, title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo', ...(paths ? { paths } : {}) })
  it('leases the paths an accepted assessment declares, normalized for comparison', () => {
    const execution = ticketExecution(ticket, accept(['\\Source\\Game\\Tests\\', '/Source/Project/']), SettingsSchema.parse({}), '/state')
    expect(execution.lease).toEqual(['Source/Game/Tests', 'Source/Project'])
  })
  it('keeps no lease when the assessment names no paths, which serializes the ticket', () => {
    expect(ticketExecution(ticket, accept(), SettingsSchema.parse({}), '/state').lease).toEqual([])
  })
  it('pins a p4 ticket to the default workspace and leases its paths there', () => {
    const settings = SettingsSchema.parse({ executor: { backend: 'p4', workspaces: [
      { id: 'sun', directory: 'E:/workspace', p4Client: 'agent_workspace' },
      { id: 'other', directory: 'E:/other' }] } })
    const execution = ticketExecution(ticket, accept(['Source/A']), settings, '/state')
    expect(execution.workspace).toBe('sun')
    expect(execution.directory).toBe('E:/workspace')
    expect(execution.lease).toEqual(['Source/A'])
    expect(execution.assignment).toContain('DSH_SUPERAGENT_LEASE')
  })
  it('pins a p4 ticket that named no paths too, so it works in the shared tree alone', () => {
    const settings = SettingsSchema.parse({ executor: { backend: 'p4', workspaces: [{ id: 'sun', directory: 'E:/workspace' }] } })
    const execution = ticketExecution(ticket, accept(), settings, '/state')
    expect(execution.workspace).toBe('sun')
    expect(execution.directory).toBe('E:/workspace')
    expect(execution.lease).toEqual([])
    expect(execution.assignment).toContain('DSH_SUPERAGENT_LEASE')
  })
  it('keeps a git ticket in its own directory, without a pinned workspace', () => {
    const settings = SettingsSchema.parse({ executor: { workspaces: [{ id: 'main', directory: '/work/main' }] } })
    const execution = ticketExecution(ticket, accept(['Source/A']), settings, '/state')
    expect(execution.workspace).toBeUndefined()
    expect(execution.directory).toContain('fix-typo')
  })
  it('does not tell a ticket that works nowhere shared about a shared workspace', () => {
    const settings = SettingsSchema.parse({ executor: { workspaces: [{ id: 'main', directory: '/work/main' }] } })
    expect(ticketExecution(ticket, accept(), settings, '/state').assignment).not.toContain('DSH_SUPERAGENT_LEASE')
    expect(ticketExecution(ticket, accept(), SettingsSchema.parse({}), '/state').assignment).not.toContain('DSH_SUPERAGENT_LEASE')
  })
})

