/** Types for scripts/daily-retro.mjs, which tests import. */
import type { Hour, Metrics } from './daily-metrics.mjs'

export const LEDGER_VERSION: number
export const TEMPLATE_VERSION: number
export const STATUSES: string[]
export const NARRATIVE_SECTIONS: [key: string, label: string][]
export interface Commitment { id: string; text: string; ticket: string | null; due: string; from: string | null; status: string; note: string | null
  history: { on: string; from: string; to: string }[] }
export interface Ledger { version: number; items: Commitment[] }
export interface Reconciled { id: string; from: string; to: string; reason: string }

export function emptyLedger (): Ledger
export function readLedger (path: string): Ledger
export function writeLedger (path: string, ledger: Ledger): void
export function addCommitment (ledger: Ledger, input: { text?: string; due?: string; ticket?: string; from?: string }): Commitment
export function setCommitment (ledger: Ledger, id: string | undefined, input: { status?: string; note?: string; ticket?: string }, on: string): Commitment
export function reconcile (ledger: Ledger, date: string, lookup: (prefix: string) => { ended?: { outcome: string } } | undefined): Reconciled[]
export function escapeHtml (value: unknown): string
export function markdown (source: string): string
export function parseNarrative (source: string | undefined): Record<string, string>
export function hourlyChart (hourly: Hour[]): string
export function renderReport (input: { metrics: Metrics; previous?: Metrics; ledger?: Ledger; narrative?: Record<string, string> }): { html: string; missing: string[] }
export function main (argv?: string[]): Promise<number>
