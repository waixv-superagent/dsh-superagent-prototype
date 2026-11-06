/** Types for scripts/ue-toolchain.mjs, which the UE scripts and their tests import. */

export interface UePaths {
  workspace: string
  project: string
  uproject?: string
  engine: string
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
  timedOut: boolean
  error?: string
}

export function engineLlvmBins (engine: string | undefined): string[]
export function engineRootOf (project: string | undefined, workspace: string): string
export function uePaths (input?: { root?: string; project?: string }): UePaths
export function engineVersion (engine: string | undefined): Record<string, any> | undefined
export function findEngineTool (engine: string | undefined, name: string): string | undefined
export function findExecutable (name: string, options?: { env?: Record<string, string | undefined>; extra?: string[] }): string | undefined
export function withPath (env: Record<string, string | undefined>, directories: (string | undefined)[]): Record<string, string | undefined>
export function quoteArg (value: string): string
export function runProcess (command: string, args: string[], options?: {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  verbatim?: boolean
  onOutput?: (text: string) => void
}): Promise<RunResult>
