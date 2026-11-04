/** Loop-integrity invariant I4: which Ticket states are provably inconsistent, and how the host reprojects them. */
import { latestAssignment, liveTicket, waitsForPerson } from './model.ts'
import type { Assignment, Ticket, TicketRepair } from './model.ts'

/** How long an Assignment may look active with nothing running for it before the host reprojects it. */
export const REPROJECT_AFTER_MS = 5 * 60_000
/** How many repairs of one invariant the host attempts before it leaves the Ticket to a person. */
export const REPAIR_LIMIT = 2
/**
 * What the host can see about a Ticket's live worker and its durable effect queue, without the Ticket saying so: an
 * Assignment may claim to run while no worker Session is loaded, or wait on a launch or delivery effect that is gone.
 */
export interface Liveness {
  /** The Ticket's worker Session is loaded and its turn, or the background work of its turn, still runs. */
  active(ticketId: string): boolean
  /** A launch effect for this Assignment waits in the durable queue. */
  launching(assignmentId: string): boolean
  /** A delivery effect for this Ticket waits in the durable queue. */
  delivering(ticketId: string): boolean
}
/** What the host should do about one provable inconsistency. */
export type Reprojection =
  | { invariant: 'assignment'; action: 'restart'; assignment: Assignment; detail: string }
  | { invariant: 'launch'; action: 'relaunch'; assignment: Assignment; detail: string }
  | { invariant: 'delivery'; action: 'deliver'; assignment: Assignment; detail: string }
  /** The host already repaired this invariant `REPAIR_LIMIT` times; a person must look at the Ticket now. */
  | { invariant: TicketRepair['invariant']; action: 'blocked'; reason: string }

/** The number of times the host already repaired `invariant` on `ticket`. */
const repairsOf = (ticket: Ticket, invariant: TicketRepair['invariant']): number =>
  ticket.repairs?.filter(item => item.invariant === invariant).length ?? 0

/**
 * The provable inconsistency to repair on `ticket`, if any: an Assignment that runs with no live worker and never reported,
 * a pending Assignment whose launch effect is gone, or undelivered Inputs whose delivery effect is gone. Each needs the
 * Assignment to be older than `REPROJECT_AFTER_MS`, so a launch or delivery that is merely in flight is left alone, and a
 * state a worker reported is never second-guessed. A Ticket already repaired `REPAIR_LIMIT` times for the invariant is
 * returned as `blocked` rather than repaired again, so a persistent defect goes to a person instead of looping.
 * @param now - current time in milliseconds, for tests and for the passes' clock.
 */
export function reprojectable(ticket: Ticket, live: Liveness, now = Date.now()): Reprojection | undefined {
  if (!liveTicket(ticket)) return undefined
  const assignment = latestAssignment(ticket)
  if (!assignment) return undefined
  const started = Date.parse(assignment.startedAt ?? assignment.createdAt)
  const stale = !Number.isFinite(started) || started + REPROJECT_AFTER_MS <= now
  if (!stale) return undefined
  const exhausted = (invariant: TicketRepair['invariant'], reason: string): Reprojection | undefined =>
    repairsOf(ticket, invariant) >= REPAIR_LIMIT ? { invariant, action: 'blocked', reason } : undefined
  // Running with no worker and not even a first report: nothing can make progress, and no report is being overturned.
  if (assignment.state === 'running' && !assignment.report && !live.active(ticket.id)) {
    return exhausted('assignment', 'The host found this Assignment running with no live worker Session more than twice. '
      + 'Inspect its worker Session (it may have been deleted or corrupted), then retry, redispatch, or stop the ticket.')
      ?? { invariant: 'assignment', action: 'restart', assignment,
        detail: 'The Assignment ran with no live worker Session and had not reported; the host restarted it with a recovery note' }
  }
  // Pending with no launch left to start it: the durable effect that would run it is gone.
  if (assignment.state === 'pending' && !waitsForPerson(ticket) && !live.launching(assignment.id)) {
    return exhausted('launch', 'The host queued this Assignment to launch more than twice and its launch effect went missing again. '
      + 'Inspect the effect queue and the worker Session, then retry or stop the ticket.')
      ?? { invariant: 'launch', action: 'relaunch', assignment, detail: 'The Assignment was pending with no launch effect; the host queued it again' }
  }
  // Running with Inputs nobody is handing over, and no delivery failure the ticket already reports: its effect is gone.
  if (assignment.state === 'running' && ticket.undelivered.length && !ticket.delivery && !live.delivering(ticket.id)) {
    return exhausted('delivery', 'The host queued delivery more than twice and the delivery effect went missing again. '
      + 'Inspect the effect queue and the worker Session, then retry or stop the ticket.')
      ?? { invariant: 'delivery', action: 'deliver', assignment,
        detail: 'Inputs waited on a running Assignment with no delivery effect; the host queued their delivery again' }
  }
  return undefined
}
