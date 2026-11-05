/** Ticket stage classification and retry eligibility (docs/003). */
import { awaitsVerification, currentReport, latestAssignment, waitsForPerson, type Follow, type Ticket } from './model.ts'

/** High-level execution stage of a ticket: waiting on a person, in pipeline follow-up, actively working or queued, idle between turns, or ended. */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'verify' | 'blocked' | 'failed' }
  | { stage: 'pipeline'; action: 'running' | 'blocked' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  // The P4.5 local check is a mandatory human gate and the first gate the ticket page shows, so it comes before a question
  // and the pipeline follow-up: the host watches the pipeline in parallel from delivery, but a delivered change waiting for
  // the person's check must read as verify, not as an answer or a pipeline item, until it is passed or returned (docs/003).
  if (awaitsVerification(ticket)) return { stage: 'person', action: 'verify' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  // A merged pipeline is history: it completed the Ticket once, and a person's later message may resume the Ticket for a
  // follow-up round, which is not pipeline work again (docs/003).
  if (ticket.pipeline && ticket.pipeline.state !== 'merged') return { stage: 'pipeline', action: ticket.pipeline.state === 'blocked' ? 'blocked' : 'running' }
  const assignment = latestAssignment(ticket)
  // A report speaks for the Ticket only while its worker has nothing newer to do, and a blocked or failed one only while the
  // worker still waits for a person (`currentReport`): otherwise the Ticket is working again on what was delivered after it.
  const report = currentReport(ticket)?.state
  // Work delivered into a pull request the Ticket opened is approved and merged there, not in a local check: it waits at the
  // pipeline gate, where the person opens the request and marks the Ticket merged (docs/003).
  if (report === 'ready' && ticket.pipeline?.state !== 'merged' && ownPull(ticket)) return { stage: 'pipeline', action: 'blocked' }
  if (report === 'ready') return { stage: 'person', action: 'review' }
  if (report === 'blocked' || report === 'failed') return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}

/**
 * The pull request a Ticket opened and still waits on, as the Thread it follows: its delivered change is approved and merged
 * in the Source, so the Ticket waits at the pipeline gate rather than for a person's review of the work. A Ticket's `own`
 * follows are the Threads it opened, such as its own pull request; `followsDone` ends it once they all closed.
 */
export function ownPull(ticket: Pick<Ticket, 'follows'>): Follow | undefined {
  return ticket.follows?.find(item => item.own && !item.closed)
}
