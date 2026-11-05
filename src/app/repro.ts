/**
 * Local reproduction cases (docs/024): the scripts an agent wrote for a reported case stay outside the repository, one
 * folder each under a local directory, with a `case.json` naming the command and the report it produces. This module
 * reads that directory; `repro-runner.ts` runs one and keeps its output. A case therefore re-runs against the editor
 * that is already open instead of starting another one, which is the point of a reproduction.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'

/** How long a case may run unless its `case.json` names a timeout: long enough for a PIE sweep, short enough to stop. */
export const DEFAULT_TIMEOUT_MS = 20 * 60_000
/** A directory holding more folders than this is read as the wrong directory, not as a list a person can scan. */
export const MAX_CASES = 100

/**
 * Where the local cases live: `Saved/ReproTests` beside the configured editor project, so a case sits with the editor it
 * reproduces on; without a configured project, the host's own `repro-tests` directory, so the panel always has a place
 * to list and an operator can point the editor setting at the project to move it.
 */
export function reproRoot(project: string, stateDir: string): string {
  const trimmed = project.trim()
  return trimmed ? join(dirname(resolve(trimmed)), 'Saved', 'ReproTests') : join(stateDir, 'repro-tests')
}

/**
 * The `case.json` a case folder holds. `command` runs in the case folder through the platform's own shell, so a case
 * keeps its scripts and fixtures beside it; `report` is the one file the panel opens when a run wrote it.
 */
export const ReproCaseSchema = z.object({
  /** The name the panel lists; the folder name when absent. */
  name: z.string().trim().min(1).max(120).optional(),
  /** One sentence on what the case reproduces, shown under its name. */
  description: z.string().trim().max(500).optional(),
  /** The command the host runs in the case folder. */
  command: z.string().trim().min(1).max(1_000),
  /** The report file, relative to the case folder, the panel opens after a run. */
  report: z.string().trim().min(1).max(400).optional(),
  /** How long the command may run before the host stops it. */
  timeoutSeconds: z.number().int().min(10).max(7_200).optional(),
}).strict()
export type ReproCaseManifest = z.infer<typeof ReproCaseSchema>

/** Why a case folder cannot run; the panel localizes the code and shows `detail` as the host wrote it. */
export interface ReproCaseProblem {
  code: 'missingManifest' | 'unreadableManifest' | 'invalidManifest' | 'invalidReport'
  detail?: string
}
/** Why the case directory itself could not be read. */
export interface ReproRootProblem {
  code: 'missing' | 'unreadable'
  detail?: string
}

export interface ReproCase {
  /** The folder name, which is the case's stable id and its route parameter. */
  id: string
  /** The display name: the manifest's, else the folder's. */
  name: string
  description: string
  /** The folder the host runs the command in, and the boundary every report path must stay inside. */
  directory: string
  command?: string
  /** The report file relative to `directory`, as the manifest declared it. */
  report?: string
  timeoutMs: number
  /** Set when the folder has no usable `case.json`; such a case is listed but cannot run. */
  problem?: ReproCaseProblem
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The absolute path `value` names inside `directory`, or undefined when it is empty, absolute, or climbs out of the
 * folder. A report path is written by a case, not by a request, but the boundary is still checked when it is served.
 */
export function inside(directory: string, value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return undefined
  const full = resolve(directory, trimmed)
  const path = relative(directory, full)
  return path && !path.startsWith('..') && !isAbsolute(path) ? full : undefined
}

/** Reads one case folder; a folder without a usable `case.json` stays listed so a person sees why it cannot run. */
function readCase(root: string, id: string): ReproCase {
  const directory = join(root, id)
  let raw: string
  try { raw = readFileSync(join(directory, 'case.json'), 'utf8') } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { id, name: id, description: '', directory, timeoutMs: DEFAULT_TIMEOUT_MS,
      problem: { code: missing ? 'missingManifest' : 'unreadableManifest', ...missing ? {} : { detail: reason(error) } } }
  }
  let json: unknown
  try { json = JSON.parse(raw) } catch (error) {
    return { id, name: id, description: '', directory, timeoutMs: DEFAULT_TIMEOUT_MS,
      problem: { code: 'invalidManifest', detail: `case.json: ${reason(error)}` } }
  }
  const parsed = ReproCaseSchema.safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || 'case.json'}: ${issue.message}`).join('; ')
    return { id, name: id, description: '', directory, timeoutMs: DEFAULT_TIMEOUT_MS, problem: { code: 'invalidManifest', detail } }
  }
  const { name, description, command, report, timeoutSeconds } = parsed.data
  const value: ReproCase = { id, name: name ?? id, description: description ?? '', directory, command,
    timeoutMs: (timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1_000) * 1_000 }
  if (report === undefined) return value
  if (!inside(directory, report)) return { ...value, problem: { code: 'invalidReport', detail: report } }
  return { ...value, report }
}

/**
 * Reads every case folder in `root`, sorted by folder name so the list is stable between polls. Folder names starting
 * with a dot are skipped, since they are editor or version-control metadata rather than a case.
 */
export function readReproCases(root: string): { cases: ReproCase[]; problem?: ReproRootProblem } {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { cases: [], problem: { code: missing ? 'missing' : 'unreadable', ...missing ? {} : { detail: reason(error) } } }
  }
  const ids = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name).sort((left, right) => left.localeCompare(right, 'zh-CN')).slice(0, MAX_CASES)
  return { cases: ids.map(id => readCase(root, id)) }
}

/** Starts a case's command in its folder through the platform's own shell, as the host runs its editor jobs. */
export function spawnCase(command: string, cwd: string): ChildProcess {
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${command}"`],
      { cwd, windowsHide: true, windowsVerbatimArguments: true })
    // Its own process group, so stopping a case reaches every process the command started.
    : spawn('/bin/sh', ['-c', command], { cwd, detached: true })
}

/** One line a person reads on a run's row: the last output line the command wrote. */
export function runSummary(output: string): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return lines.at(-1)?.slice(0, 240) ?? ''
}
