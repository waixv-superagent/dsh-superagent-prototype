/** The local reproduction cases' page view: what the host finds on disk, how the recent runs ended, and what to open. */
import type { TicketReproView } from './ticket-repro.ts'
import type { ReproCase, ReproRootProblem } from '../repro.ts'
import type { ReproRun } from '../repro-runner.ts'

export interface ReproCaseView {
  id: string
  name: string
  description: string
  /** The command the host runs, shown on hover so a person can recognise a case before clicking it. */
  command?: string
  /** The report the case declares, relative to its folder. */
  report?: string
  /** Why this case cannot run; such a case is listed with the reason instead of a run button. */
  problem?: ReproCase['problem']
}

export interface ReproRunView {
  id: string
  caseId: string
  caseName: string
  state: ReproRun['state']
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  summary: string
  /** The report this run wrote, relative to the case folder; the panel opens it inside that folder. */
  report?: string
}

export interface ReproPageView {
  /** The directory the cases are read from; the page shows it so a person knows where a case goes. */
  root: string
  problem: ReproRootProblem | null
  cases: ReproCaseView[]
  /** The newest runs first, bounded by the runner; a case's latest run is the first one carrying its id. */
  runs: ReproRunView[]
  /** The run in progress and its last output, so the page shows progress without another request. */
  active: { runId: string; caseId: string; tail: string } | null
  /** Why no case may run now: an agent or a host job holds the editor. */
  blocked: 'agent' | 'job' | null
}

/** One case as the panel shows it: the same shape the editor page's card uses. */
export function reproCaseView(item: ReproCase): ReproCaseView {
  return { id: item.id, name: item.name, description: item.description,
    ...item.command ? { command: item.command } : {}, ...item.report ? { report: item.report } : {},
    ...item.problem ? { problem: item.problem } : {} }
}

/** One run as the panel shows it: the same shape the editor page's card uses. */
export function reproRunView(run: ReproRun): ReproRunView {
  return { id: run.id, caseId: run.caseId, caseName: run.caseName, state: run.state, startedAt: run.startedAt,
    ...run.endedAt ? { endedAt: run.endedAt } : {}, ...run.exitCode !== undefined ? { exitCode: run.exitCode } : {},
    summary: run.summary, ...run.report ? { report: run.report } : {} }
}

export function reproPage(input: { root: string; problem?: ReproRootProblem; cases: readonly ReproCase[]; runs: readonly ReproRun[]
  active?: { runId: string; caseId: string; tail: string }; blocked: 'agent' | 'job' | null }): ReproPageView {
  return {
    root: input.root,
    problem: input.problem ?? null,
    cases: input.cases.map(reproCaseView),
    runs: input.runs.map(reproRunView),
    active: input.active ?? null,
    blocked: input.blocked,
  }
}
