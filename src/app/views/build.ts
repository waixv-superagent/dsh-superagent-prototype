/** The editor page's composed compile-and-launch runs (docs/021): configuration × target × platform. */
import type { EditorConfiguration, EditorPlatform } from '../../core/editor-composition.ts'
import type { EditorPathProblem } from '../../core/editor-paths.ts'
import type { BuildRunState } from '../build-runner.ts'

export interface BuildRunView {
  id: string
  /** Rider's name for the combination, such as `Development Editor SunGame`. */
  name: string
  target: string
  configuration: EditorConfiguration
  platform: EditorPlatform
  state: BuildRunState
  startedAt: string
  endedAt?: string
  exitCode?: number | null
  summary: string
}

/** The configured locations the card shows before a run, so a missing path reads as configuration, not a failed build. */
export interface BuildPathsView {
  project: string
  engine: string
  editorExe: string
  /** What a derived command still needs: the project or the engine; null when templates or paths are enough. */
  problem: EditorPathProblem
}

export interface BuildPageView {
  /** The configured Unreal target names; empty means the person must add them in the settings first. */
  targets: string[]
  /** The configurations Rider offers for an Unreal project. */
  configurations: EditorConfiguration[]
  /** The platforms this host can build for. */
  platforms: EditorPlatform[]
  /** The configured build and launch templates, empty when the commands are derived from the paths. */
  build: string
  launch: string
  /** Where the project, engine and editor live, and which of them is still missing. */
  paths: BuildPathsView
  /** The newest runs first, bounded by the runner. */
  runs: BuildRunView[]
  /** The run in progress and its last output, so the page shows progress without another request. */
  active: { runId: string; name: string; tail: string } | null
  /** Why the person may not start a run now: an agent or a host job holds the editor. */
  blocked: 'agent' | 'job' | null
}

/** One page's worth of the person's target choices and runs, with the run in flight and what holds the editor. */
export function buildPage(input: { targets: readonly string[]; configurations: readonly EditorConfiguration[]
  platforms: readonly EditorPlatform[]; build: string; launch: string; paths: BuildPathsView
  runs: readonly BuildRunView[]; active?: BuildPageView['active']; blocked: 'agent' | 'job' | null }): BuildPageView {
  return {
    targets: [...input.targets],
    configurations: [...input.configurations],
    platforms: [...input.platforms],
    build: input.build,
    launch: input.launch,
    paths: { ...input.paths },
    runs: input.runs.map(run => ({ ...run })),
    active: input.active ?? null,
    blocked: input.blocked,
  }
}
