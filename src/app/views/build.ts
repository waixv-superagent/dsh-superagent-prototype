/** The editor page's compile-and-launch target list and its recent runs (docs/021). */
import type { BuildRunState, BuildTarget } from '../build-runner.ts'

export interface BuildTargetView {
  name: string
  /** The command as configured, shown on hover so a person recognises a target before running it. */
  command: string
}

export interface BuildRunView {
  id: string
  target: string
  state: BuildRunState
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  summary: string
}

export interface BuildPageView {
  /** The configured targets; an empty list means the person must add one in the settings first. */
  targets: BuildTargetView[]
  /** The newest runs first, bounded by the runner. */
  runs: BuildRunView[]
  /** The run in progress and its last output, so the page shows progress without another request. */
  active: { runId: string; target: string; tail: string } | null
  /** Why the person may not start a run now: an agent or a host job holds the editor. */
  blocked: 'agent' | 'job' | null
}

/** One page's worth of the person's targets and runs, with the run in flight and what holds the editor. */
export function buildPage(input: { targets: readonly BuildTarget[]; runs: readonly BuildRunView[]; active?: BuildPageView['active']
  blocked: 'agent' | 'job' | null }): BuildPageView {
  return {
    targets: input.targets.map(target => ({ name: target.name, command: target.command })),
    runs: input.runs.map(run => ({ ...run })),
    active: input.active ?? null,
    blocked: input.blocked,
  }
}
