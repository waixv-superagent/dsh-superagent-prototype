/** Types for scripts/test-suite.mjs, which the package's test script runs. */
export const ROUNDS: number
/** Specs that speak to an editor MCP endpoint; the host's update build leaves them out (docs/006). */
export const EDITOR_MCP_SPECS: string[]
/** Whether `cwd` is the host's update build worktree, `<stateDir>/upgrade/build`. */
export function updateBuild(cwd: string): boolean
export type TestRunOutcome = 'test' | 'pool' | 'other'
export function testRunOutcome(output: string): TestRunOutcome
export function filesWithoutWorkers(output: string): string[]
/** The vitest invocation for one round: its entry, `run`, the excluded globs, then the files to run. */
export function vitestArgs(cwd: string, files?: string[] | undefined, exclude?: string[]): string[]
