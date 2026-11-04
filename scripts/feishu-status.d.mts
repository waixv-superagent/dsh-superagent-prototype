/** Types for scripts/feishu-status.mjs, which tests import for its pure parts. */
export interface SnapshotCounts {
  working: number
  verification: number
  person: number
  pipeline: number
  idle: number
}
export interface SnapshotExecutor {
  running: number
  queued: number
  maxWorkers: number
}
/** One row of the expandable detail: only what a quick phone glance needs. */
export interface SnapshotTicket {
  title: string
  action: string
  manual: boolean
  at: string
}
export interface SnapshotTickets {
  working: SnapshotTicket[]
  verification: SnapshotTicket[]
  person: SnapshotTicket[]
  pipeline: SnapshotTicket[]
}
/** What the outage recovery is doing, as `/orchestrator/api/state` reports it; null when the state omits it. */
export interface SnapshotWatchdog {
  recovering: boolean
  tickets: number
  master: boolean
  gaveUp: boolean
  missing: boolean
}
/** The last hour's spend as the board's billing strip counts it; null when the host serves no billing. */
export interface SnapshotBilling {
  /** gateway: the gateway's settled bill; estimate: priced from published lists; tokens: no price, only a token count. */
  source: 'gateway' | 'estimate' | 'tokens'
  cost: number | null
  /** The gateway has not settled every minute yet, so the amount is a lower bound. */
  partial: boolean
  tokens: number
  requests: number
  windowMinutes: number
  /** The gateway account's remaining share of this period, 0–100; null when it could not be read. */
  quotaPercent: number | null
}
export interface Snapshot {
  online: boolean
  error?: string
  paused: boolean
  runtime: string
  setupProblem: boolean
  problems: number
  /** Open Tickets the host's stall alert counts as stalled; absent or 0 when none, or from a host without it. */
  stalled?: number
  watchdog: SnapshotWatchdog | null
  counts: SnapshotCounts | null
  tickets: SnapshotTickets | null
  /** Absent in a hand-built snapshot from before the usage line; treated as null. */
  billing?: SnapshotBilling | null
  executor: SnapshotExecutor | null
}
export interface CardView {
  card: Record<string, unknown>
  title: string
  template: string
  kind: string
  summary: string
}
export interface RunResult {
  action: string
  messageId?: string
  online?: boolean
  kind?: string
  card?: Record<string, unknown>
  view?: CardView
}
export type Fetcher = (url: string, init?: unknown) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>
export interface RunOptions {
  chat?: string
  panelUrl?: string
  stateFile?: string
  lark?: (args: string[]) => Promise<unknown>
  link?: string
  fetchImpl?: Fetcher
  now?: Date
  print?: boolean
  lock?: boolean
  log?: (line: string) => void
}

export function parseArgs (argv: string[]): { options: Record<string, string>; flags: Set<string> }
export function snapshotOf (overview: unknown, state: unknown): Snapshot
export function billingOf (billing: unknown): SnapshotBilling | null
export function billingLine (billing: SnapshotBilling | null | undefined): string
export function moneyText (value: number): string
export function tokensText (value: number): string
export function offlineSnapshot (error: unknown): Snapshot
export function clock (value: string | Date, seconds?: boolean): string
export function idleMood (now: Date): string
export function ago (value: string | Date, now?: Date): string
export function shortTitle (value: unknown, max?: number): string
/** Adds Feishu's open-in-system-browser parameters to a URL, keeping its query and hash; an unparsable URL is returned as is. */
export function browserLink (url: string): string
export function composeCard (snapshot: Snapshot, options?: { now?: Date; lastOkAt?: string | null; link?: string }): CardView
export function cardExpired (sentAt: string | null | undefined, now?: Date): boolean
export function messageIdOf (output: unknown): string | undefined
export function isGoneError (error: unknown): boolean
export function readState (file: string): Record<string, unknown>
export function collect (panelUrl: string, fetchImpl?: Fetcher, now?: Date): Promise<Snapshot>
export function runOnce (options?: RunOptions): Promise<RunResult>
