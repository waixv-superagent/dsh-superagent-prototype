/** The honest wait behind a ticket's stage (docs/003): who it waits for, what it is doing, and when a real deadline passes. */
import type { Ticket } from './model.ts'
import { ticketStage } from './stage.ts'

/** Who the ticket waits for: a person, the delivery pipeline, its own worker, or nobody because it ended. */
export type WaitWho = 'person' | 'pipeline' | 'worker' | 'none'
/**
 * One ticket's wait, derived from the same stage rules the board and cards use: `action` is the stage's own action
 * (`deliver`, `answer`, `review`, `verify`, `blocked`, `failed`, `running`, `queued`, ...), and `until` is only a fact the
 * domain really has, such as the P1 gate's deadline, never a guess.
 */
export interface Waiting { who: WaitWho; action: string; since: string; until?: string }

/** Classifies the wait behind an open or ended ticket; the stage itself stays unchanged, so the board and docs/003 agree. */
export function waitingOf(ticket: Ticket): Waiting {
  if (ticket.ended) return { who: 'none', action: ticket.ended.outcome, since: ticket.ended.at }
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') {
    const since = stage.action === 'verify' ? ticket.verification?.at : stage.action === 'review' ? ticket.updatedAt : ticket.updatedAt
    return { who: 'person', action: stage.action, since: since ?? ticket.updatedAt,
      ...(stage.action === 'answer' && ticket.plan?.deadline ? { until: ticket.plan.deadline } : {}) }
  }
  if (stage.stage === 'pipeline') return { who: 'pipeline', action: stage.action, since: ticket.pipeline?.at ?? ticket.updatedAt }
  if (stage.stage === 'idle') return { who: 'none', action: 'idle', since: ticket.updatedAt }
  if (stage.stage === 'working') return { who: 'worker', action: stage.action ?? 'running', since: ticket.updatedAt }
  return { who: 'none', action: stage.stage, since: ticket.updatedAt }
}
