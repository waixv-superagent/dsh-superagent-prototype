/** Types for scripts/upgrade-switch.mjs, which tests import to drive the switch without processes or files. */
export const ENTRIES: string[]
export const DATABASE: string[]
export const BUILD_INFO: string
export interface SwitchPlan {
  sha: string
  from?: string | null
  source: string
  install: string
  stateDir: string
  backup: string
  statusFile: string
  log?: string
  url: string
  pid: number
  wasPaused?: boolean
  holdFile?: string
  start: { command?: string; argv?: string[]; cwd?: string }
  startedAt?: string
  steps?: { name: string; state: string; detail: string; at: string }[]
  exitTimeoutMs?: number
  healthTimeoutMs?: number
}
export interface SwitchStatus {
  state: 'switching' | 'done' | 'failed' | 'rolledBack' | 'down'
  sha: string
  from: string | null
  startedAt: string
  endedAt?: string
  steps: { name: string; state: string; detail: string; at: string }[]
  error: string | null
  rolledBack: boolean
}
export interface SwitchIo {
  now(): string
  exists(path: string): boolean
  copy(from: string, to: string): void
  remove(path: string): void
  write(path: string, text: string): void
  writeStatus(status: SwitchStatus): void
  waitExit(pid: number, ms: number): Promise<boolean>
  kill(pid: number): void
  start(start: SwitchPlan['start']): void
  stopStarted(): void
  healthy(url: string, ms: number): Promise<boolean>
  resume(): Promise<void>
}
export function parsePlan(text: string): Required<Pick<SwitchPlan, 'exitTimeoutMs' | 'healthTimeoutMs' | 'wasPaused' | 'holdFile'>> & SwitchPlan
export function runSwitch(plan: SwitchPlan, io: SwitchIo): Promise<SwitchStatus>
export function systemIo(plan: SwitchPlan): SwitchIo
