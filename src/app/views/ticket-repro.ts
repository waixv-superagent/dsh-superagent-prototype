/** What one Ticket's page shows of the local reproduction cases (docs/024): the case its verification package names. */
import type { Ticket } from '../../core/model.ts'
import { matchedReproCaseIds, type ReproCase } from '../repro.ts'
import type { ReproRun } from '../repro-runner.ts'
import { reproCaseView, reproRunView, type ReproCaseView, type ReproRunView } from './repro.ts'

export interface TicketReproView {
  /** The directory the cases are read from, so an empty match can say where a case belongs. */
  root: string
  /** The cases this Ticket's verification package names, and their newest runs. */
  cases: ReproCaseView[]
  runs: ReproRunView[]
  /** The run in flight for one of those cases, with its last output. */
  active: { runId: string; caseId: string; tail: string } | null
  /** Why no case may run now: an agent or a host job holds the editor. */
  blocked: 'agent' | 'job' | null
}

/** Matches a Ticket's verification package to the local cases; an unmatched package keeps an empty list. */
export function ticketRepro(input: { root: string; cases: readonly ReproCase[]; runs: readonly ReproRun[]
  active?: { runId: string; caseId: string; tail: string } | null; blocked: 'agent' | 'job' | null },
  ticket: Pick<Ticket, 'id' | 'execution'>): TicketReproView {
  const cases = input.cases.map(reproCaseView)
  const matched = matchedReproCaseIds(ticket.execution?.verification, cases, ticket.id)
  return {
    root: input.root,
    cases: cases.filter(item => matched.includes(item.id)),
    runs: input.runs.filter(run => matched.includes(run.caseId)).map(reproRunView),
    active: input.active && matched.includes(input.active.caseId) ? input.active : null,
    blocked: input.blocked,
  }
}
