/** When a Ticket last had a real event, for recency ordering that does not read the host's housekeeping timestamps. */
import type { Ticket } from './model.ts'

/**
 * The time of the newest event worth ordering a Ticket by: an Input it received, a worker turn or Report, the plan,
 * verification and delivery facts, a confirmation, a priority a person set, a back-move or a repair.
 *
 * `updatedAt` and the pipeline observation time are deliberately left out. The host rewrites `updatedAt` on passes that
 * change no state a person can see — the pipeline watcher refreshes `seenAt` and saves the Ticket on every poll — so
 * ranking by it would put a Ticket at the top for as long as the host keeps looking at it, not for what happened on it.
 * A Ticket with no event at all (one accepted but never started) has no activity time.
 */
export function lastActivityAt(ticket: Ticket): string | undefined {
  const times: (string | undefined)[] = [
    ...ticket.inputs.map(input => input.at),
    ...ticket.assignments.flatMap(assignment => [assignment.createdAt, assignment.startedAt, assignment.idleAt,
      assignment.report?.at, assignment.endedAt]),
    ticket.verification?.at,
    ticket.plan?.at,
    ticket.plan?.approved?.at,
    ...(ticket.plan?.feedback ?? []).map(feedback => feedback.at),
    ticket.confirmed?.at,
    ...(ticket.phaseResets ?? []).map(reset => reset.at),
    ...(ticket.repairs ?? []).map(repair => repair.at),
    ticket.delivery?.at,
    ticket.priority?.source === 'human' ? ticket.priority.at : undefined,
  ]
  let latest: string | undefined
  for (const at of times) if (at && (!latest || at > latest)) latest = at
  return latest
}
