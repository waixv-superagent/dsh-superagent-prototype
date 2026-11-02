/** Placement of Tickets into workspaces: slots, lease overlap, and the conflicts a queued Ticket reports. */
import { describe, expect, it } from 'vitest'
import { claimsWorkspace, conflicts, LeaseSchema, normalizePath, overlap, place, running, workspaceClient, WorkspaceSchema, type Active, type Workspace } from '../src/executor/workspace.ts'
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
})

describe('pool membership', () => {
  it('keeps a ticket that named no paths out of the pool, so it runs on its own', () => {
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
  it('tells a worker in a shared workspace to stay inside its lease', () => {
    const settings = SettingsSchema.parse({ executor: { workspaces: [{ id: 'main', directory: '/work/main' }] } })
    expect(ticketExecution(ticket, accept(['Source/A']), settings, '/state').assignment).toContain('DSH_SUPERAGENT_LEASE')
    expect(ticketExecution(ticket, accept(['Source/A']), SettingsSchema.parse({}), '/state').assignment).not.toContain('DSH_SUPERAGENT_LEASE')
  })
})

