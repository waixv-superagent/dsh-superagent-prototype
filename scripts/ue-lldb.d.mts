/** Types for scripts/ue-lldb.mjs, which tests import. */

export interface FrameRow { index: number; name?: string; file?: string; line?: number; column?: number; module?: unknown }
export interface VariableRow { frame: number; scope: string; name: string; type?: string; value: string; expandable: boolean }

export function parseBreakpoint (text: string): { file: string; line: number }
export function parseCliCapture (text: string): Record<string, any>
export function groupBreakpoints (breakpoints: { file: string; line: number }[]): { file: string; lines: number[] }[]
export function normalizeFrames (frames: any[]): FrameRow[]
export function normalizeVariables (frameIndex: number, scope: string, variables: any[], limit: number): VariableRow[]
export function initCommands (options?: { formatters?: string }): string[]
export function formatCapture (result: Record<string, any>): string
export function parseArgs (argv: string[]): Record<string, any>
export function resolveCpptools (root?: string): string | undefined
export function main (argv?: string[]): Promise<number>
