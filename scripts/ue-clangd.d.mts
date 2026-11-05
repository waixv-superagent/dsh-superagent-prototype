/** Types for scripts/ue-clangd.mjs, which tests import. */
import type { UePaths } from './ue-toolchain.mjs'

export const SYMBOL_KINDS: string[]
export const SEVERITIES: string[]

export interface SymbolRow { name: string; kind: string; container?: string; file?: string; line?: number; column?: number }
export interface LocationRow { file: string; line: number; column: number }
export interface DiagnosticRow { file: string; line: number; column: number; severity: string; message: string; code?: unknown }
export interface StalenessInput {
  databaseExists: boolean
  manifest?: Record<string, any>
  engineNow?: Record<string, any>
  compilerExists?: boolean
  ageDays?: number
}

export function pathToUri (file: string): string
export function uriToPath (uri: string): string
export function parsePosition (text: string): { file: string; line: number; column: number }
export function kindName (kind: number | undefined): string
export function severityName (severity: number | undefined): string
export function normalizeSymbols (result: unknown, limit?: number): SymbolRow[]
export function normalizeLocations (result: unknown): LocationRow[]
export function hoverText (result: unknown): string
export function normalizeDiagnostics (uri: string, diagnostics: unknown): DiagnosticRow[]
export function staleness (input: StalenessInput): string[]
export function generateArguments (input: {
  uproject: string
  target: string
  configuration: string
  outputDir: string
  includes?: string[]
  noCodegen?: boolean
}): string[]
export function databaseDirectory (paths: Pick<UePaths, 'project'>): string
export function indexCacheDirectory (paths: Pick<UePaths, 'project'>): string
export function firstProjectSource (database: string, project: string): string | undefined
export function parseArgs (argv: string[]): { options: Record<string, any>; positional: string[] }
export function main (argv?: string[]): Promise<number>
