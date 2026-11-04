/** Types for scripts/daily-metrics.mjs, which tests and scripts/daily-retro.mjs import. */
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION: number
export const CAUSES: [key: string, label: string, pattern: RegExp][]
export interface Window { since: string; until: string; tz: string; date: string | null }
export interface Hour { hour: number; human: number; progress: number; deliveries: number; failed: number; toolCalls: number }
export interface TicketRow { id: string; title: string; kind: string; createdAt: string; assignments: number; outcome: string; phase: string | null; reports: string[]; toolCalls?: number }
export interface Failure { ticket: string; state: string; cause: string; at: string; summary: string }
export interface Pull { number: number; title: string; at: string }
export interface Changelist { changelist: number; ticket: string | null; at: string; desc?: string; review?: string }
export interface Metrics {
  schemaVersion: number
  generatedAt: string
  window: Window
  sources: Record<string, unknown>
  tickets: { created: number; ended: number; open: number; outcomes: Record<string, number>; kinds: Record<string, number>; list: TicketRow[] }
  assignments: { started: number; ended: number; endedReasons: Record<string, number> }
  reports: { total: number; states: Record<string, number>; causes: Record<string, number>; failures: Failure[] }
  restarts: { interrupted: number; events: { at: string; interrupted: number }[] }
  intake: { total: number; human: number; bySource: Record<string, number>; decisions: Record<string, number>; fanoutOnly: number; handbacks: number; acks: number; filtered: number }
  delivery: { ready: number; prsMerged: number; clsSubmitted: number; total: number; prs: { merged: Pull[]; closed: Pull[]; open: Pull[] } | null
    cls: { source: 'p4' | 'pipeline'; submitted: Changelist[]; tracked?: Changelist[] } }
  tools: { calls: number; sessions: number; files: number; badFrames: number; byName: Record<string, number>; byTicket: Record<string, number> } | null
  hourly: Hour[]
  limits: string[]
}
export interface DiffRow { key: string; previous: number; current: number; delta: number }

export function parseArgs (argv: string[]): { options: Record<string, string>; flags: Set<string>; positional: string[] }
export function offsetMinutes (tz: string): number
export function dayWindow (date: string, tz?: string): Window
export function localHour (at: string | number | undefined, window: Window): number | undefined
export function causeOf (summary: string | undefined): string
export function kindOf (ticket: Record<string, any>, source?: string, repository?: string): string
export function decodeSession (buffer: Buffer): { text: string; frames: number; bad: number }
export function collectChanges (changes: Record<string, unknown>[] | undefined, tracked: Changelist[], window: Window, hourly: Hour[]): Metrics['delivery']['cls']
export function buildMetrics (input: { db: DatabaseSync; window: Window; repository?: string; sessionsDir?: string; pulls?: Record<string, unknown>[];
  changes?: Record<string, unknown>[]; sources: Record<string, unknown> }): Metrics
export function diffMetrics (previous: Metrics, current: Metrics): DiffRow[]
export function main (argv?: string[]): Promise<number>
