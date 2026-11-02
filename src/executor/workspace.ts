/** Task center: which physical workspace a Ticket runs in, and which paths it may write while it does. */
import { z } from 'zod'

/** Path prefixes a Ticket may write, relative to its workspace. An empty lease means the whole workspace. */
export type Lease = readonly string[]

export const LeaseSchema = z.array(z.string().trim().min(1).max(400)).max(20).default([])

/** A physical directory a worker may run in, plus the p4 client that maps it. Slots cap how many run there at once. */
export const WorkspaceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/).max(40),
  directory: z.string().trim().min(1).max(400),
  p4Client: z.string().trim().max(100).default(''),
  slots: z.number().int().min(1).max(8).default(1),
}).strict()
export type Workspace = z.infer<typeof WorkspaceSchema>

/** A Ticket currently running in a workspace, as the placement needs to see it. */
export interface Active { workspace: string; lease: Lease }

/** A peer a worker is told about: another ticket running in the same workspace and the paths it writes. */
export interface Peer { ticket_id: string; title: string; lease: Lease }

/** Drops leading and trailing separators and uses forward slashes, so a lease compares the same however it was written. */
export const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

/**
 * True when two leases may write the same file: either one is the other, or one contains the other.
 * An empty lease is the whole workspace and therefore overlaps everything, which is the safe default for a Ticket that names no paths.
 */
export function overlap(a: Lease, b: Lease): boolean {
  if (!a.length || !b.length) return true
  return a.some(left => {
    const x = normalizePath(left)
    return b.some(right => {
      const y = normalizePath(right)
      return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
    })
  })
}

/**
 * Whether a Ticket joins the shared pool at all. A Ticket whose assessment named no paths has nothing to protect in the
 * shared tree: it runs in its own directory, so it neither waits for a workspace slot nor blocks a peer that needs one.
 */
export const claimsWorkspace = (lease: Lease): boolean => lease.length > 0

/** How many Tickets a workspace is already running. */
export const running = (active: readonly Active[], id: string): number => active.filter(item => item.workspace === id).length

/**
 * The workspace a Ticket may run in: the first one with a free slot whose running leases do not overlap `lease`.
 * `undefined` means wait — a queued Ticket is launched when a peer delivers or stops, like one waiting for a slot.
 */
export function place(workspaces: readonly Workspace[], active: readonly Active[], lease: Lease): Workspace | undefined {
  return workspaces.find(workspace =>
    running(active, workspace.id) < workspace.slots
    && active.every(item => item.workspace !== workspace.id || !overlap(item.lease, lease)))
}

/** The smallest set of leases that `lease` conflicts with, for the message a queued Ticket shows. */
export function conflicts(active: readonly Active[], lease: Lease): Active[] {
  return active.filter(item => overlap(item.lease, lease))
}

/**
 * The p4 client a workspace owns: its configured name, or one made from the template and its id. One client per workspace,
 * created once, is what lets tickets share the tree and still keep their own changelists.
 */
export function workspaceClient(workspace: Pick<Workspace, 'id' | 'p4Client'>, template: string): string {
  return workspace.p4Client || template.replaceAll('<name>', workspace.id)
}
