/** Types for scripts/test-suite.mjs, which the package's test script runs. */
export const ROUNDS: number
export type TestRunOutcome = 'test' | 'pool' | 'other'
export function testRunOutcome(output: string): TestRunOutcome
export function filesWithoutWorkers(output: string): string[]
