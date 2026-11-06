/** Types for scripts/repro-ab.mjs, which the test suite imports to check the manifest, the differential rules and the report. */
export const HARNESS_VERSION: string
export const AB_DIR: string

export type AbOp = 'equals' | 'changed' | 'unchanged' | 'increase' | 'decrease' | 'within'
export interface AbExpectation {
  path: string
  op: AbOp
  value?: unknown
  min?: number
  tolerance?: number
  relativeTolerance?: number
  note?: string
}
export interface AbManifest {
  version: 1
  probe: string
  arms?: { A?: string; B?: string }
  observation: string
  timeoutSeconds: number
  repeat: number
  tolerance: number
  relativeTolerance: number
  expect: AbExpectation[]
  notes?: string
}
export interface DiffRow {
  path: string
  a?: unknown
  b?: unknown
  status: 'same' | 'different' | 'missing'
  detail: string
}
export interface ExpectationResult {
  path: string
  op: AbOp
  status: 'pass' | 'fail' | 'incomplete'
  a: unknown
  b: unknown
  detail: string
  note?: string
  delta?: number
}
export interface ToleranceOptions { tolerance?: number; relativeTolerance?: number }
export function parseAbManifest(raw: unknown): AbManifest
export function diffFields(baseline: unknown, candidate: unknown, options?: ToleranceOptions): DiffRow[]
export function evaluateExpectations(expectations: readonly AbExpectation[], baseline: unknown, candidate: unknown, options?: ToleranceOptions): ExpectationResult[]
export function renderReport(model: unknown): string
export function runSelfTest(): Promise<true>
export function main(argv: string[]): Promise<number>
