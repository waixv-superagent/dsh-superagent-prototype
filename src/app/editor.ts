/** Editor occupancy read from the operating system's process table: who holds the Unreal Editor and what it is doing. */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** A probe slower than this would hold up the panel; the row is cached, so a miss only delays the next refresh. */
const PROBE_TIMEOUT_MS = 5_000
/** The panel reads this row on every poll; probing the process table that often would spend more than it tells. */
const DEFAULT_INTERVAL_MS = 15_000
/** Process names without `.exe`, which the derivation compares after normalizing the probe's names. */
const INTERACTIVE_EDITOR = 'unrealeditor'
const HEADLESS_EDITOR = 'unrealeditor-cmd'
const BUILD_TOOLS = new Set(['unrealbuildtool', 'shadercompileworker'])

/** One process the derivation reads: the operating system reports names and start times, never a user's intent. */
export interface EditorProcess {
  readonly pid: number
  /** Lowercase process name without `.exe`, as `processName` reports it. */
  readonly name: string
  /** ISO start time, or null when the operating system would not report it for this process. */
  readonly started: string | null
  /** The executable's full path when it reports one; the lease guard matches a command's path against it. */
  readonly path?: string
}

/**
 * Who holds the editor: a person's interactive editor, an agent's headless commandlet, a local build tool that locks
 * the editor slot while it compiles, nobody, or a state the probe could not read.
 */
export type EditorHolder = 'person' | 'agent' | 'build' | 'none' | 'unknown'
/** What is running against the editor: editing, a build tool, or nothing the probe knows. */
export type EditorActivity = 'editing' | 'building' | 'unknown'

/** The build tool the row observed; its start time bounds which delivered changes the build contains. */
export interface EditorBuild {
  /** A build process: the earliest-started UnrealBuildTool, or the earliest worker when no UBT is running. */
  readonly pid: number
  /**
   * ISO start time of the earliest UnrealBuildTool, or null when a UBT row would not report one (a shader worker's
   * later start is not used instead).
   */
  readonly since: string | null
}

/** The overview's editor row: the holder, what it is doing, and when the current holder started. */
export interface EditorView {
  readonly holder: EditorHolder
  readonly activity: EditorActivity
  /** ISO start time of the editor, or of the build when only a build holds the slot; null when nothing holds it or the time is unknown. */
  readonly since: string | null
  readonly pid: number | null
  /** The build tool running alongside or instead of an editor; null when no build tool is running. */
  readonly build: EditorBuild | null
  /** When this row was derived, so a stale row is recognisable after a probe failure. */
  readonly at: string
  /** A person-facing reason the state is unknown; never used to decide anything. */
  readonly detail?: string
  /** Every editor process the probe saw, so the scheduler can tell an editor an agent started from a person's. */
  readonly editors?: readonly EditorProcess[]
}

/**
 * Derives the editor row from a process snapshot. `UnrealEditor-Cmd` and commandlets are an agent's headless use;
 * an interactive `UnrealEditor` is treated as a person's even when an agent opened it, because the safe answer is
 * to stop the agent before it starts fighting for the editor, not after. Unknown inputs stay unknown and read as
 * "in use by a person" in the panel, never as free.
 * @param processes - The probe's rows; names are compared case-insensitively and without `.exe`.
 * @param at - ISO time the row is derived at, stored on the view.
 */
export function deriveEditor(processes: readonly EditorProcess[], at: string): EditorView {
  const editors = processes.filter(process => process.name === INTERACTIVE_EDITOR || process.name === HEADLESS_EDITOR)
  const builds = processes.filter(process => BUILD_TOOLS.has(process.name))
  const building = builds.length > 0
  // ShaderCompileWorker children start after UnrealBuildTool: they must never stand in for a UBT whose start is
  // unknown, because their later time would call the build younger than it is and over-count the changes it contains.
  const ubt = builds.filter(process => process.name === 'unrealbuildtool')
  const buildRows = ubt.length ? ubt : builds
  // Process start times may carry different offsets, so compare instants, not their ISO text.
  const startedAt = (value: string | null) => value === null ? Number.POSITIVE_INFINITY : Date.parse(value)
  const buildStarted = buildRows.some(process => process.started === null) ? null
    : buildRows.slice().sort((left, right) => startedAt(left.started) - startedAt(right.started) || left.pid - right.pid)[0]?.started ?? null
  const build: EditorBuild | null = building ? {
    // A row without a start time cannot be the earliest known start, so it loses to any row that has one.
    pid: buildRows.slice().sort((left, right) => (left.started === null ? 1 : 0) - (right.started === null ? 1 : 0)
      || startedAt(left.started) - startedAt(right.started) || left.pid - right.pid)[0]!.pid,
    since: buildStarted,
  } : null
  const activity: EditorActivity = building ? 'building' : editors.length ? 'editing' : 'unknown'
  // A build occupies the editor slot even with no editor open: it rewrites the binaries a person would otherwise use.
  if (!editors.length) return building
    ? { holder: 'build', activity, since: buildStarted, pid: build!.pid, build, at }
    : { holder: 'none', activity, since: null, pid: null, build: null, at }
  // An interactive editor wins over a headless one: both present is still a person's editor to leave alone.
  const interactive = editors.find(process => process.name === INTERACTIVE_EDITOR)
  const started = editors.map(process => process.started).filter((value): value is string => !!value).sort()[0] ?? null
  const representative = interactive ?? editors[0]!
  return { holder: interactive ? 'person' : 'agent', activity, since: started, pid: representative.pid, build, at, editors }
}

/**
 * Parses the probe's JSON, which PowerShell emits as one object for a single process and an array otherwise.
 * Rows the operating system reported incompletely are dropped rather than guessed at.
 */
export function parseEditorProcesses(stdout: string): EditorProcess[] {
  const text = stdout.trim()
  if (!text) return []
  const parsed: unknown = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    const pid = typeof row.id === 'number' && Number.isInteger(row.id) && row.id > 0 ? row.id : undefined
    const name = typeof row.name === 'string' ? row.name.trim().toLowerCase().replace(/\.exe$/, '') : ''
    if (pid === undefined || !name) return []
    const started = typeof row.started === 'string' && !Number.isNaN(Date.parse(row.started)) ? row.started : null
    // A path is optional: the process table hides it for some processes, and a row without one still answers "who is running".
    const path = typeof row.path === 'string' && row.path.trim() ? row.path.trim() : undefined
    return [{ pid, name, started, ...path ? { path } : {} }]
  })
}

// `Get-Process -Name` fails (exit code 1) for every editor that is not running, which `execFile` reports as a failed
// probe even when the output is valid; filtering the whole table has no such failure mode.
const PROBE_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Get-Process | Where-Object { $_.ProcessName -in 'UnrealEditor','UnrealEditor-Cmd','UnrealBuildTool','ShaderCompileWorker' } | ForEach-Object {
  $started = $null
  $path = $null
  try { $started = $_.StartTime.ToUniversalTime().ToString('o') } catch { }
  try { $path = $_.Path } catch { }
  [pscustomobject]@{ id = $_.Id; name = $_.ProcessName; started = $started; path = $path }
} | ConvertTo-Json -Compress`

/**
 * Reads the editor and build processes from the operating system. PowerShell is the only process-table reader
 * available without a native module, and starting it costs about two seconds, which is why the result is cached.
 * @throws when this is not Windows or the probe cannot run; the caller turns that into an unknown row.
 */
export async function probeEditorProcesses(): Promise<EditorProcess[]> {
  if (process.platform !== 'win32') throw new Error('editor occupancy needs the Windows process table')
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64')
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  return parseEditorProcesses(stdout)
}

export interface EditorOptions {
  /** Replaces the process probe in tests. */
  readonly probe?: () => Promise<readonly EditorProcess[]>
  readonly now?: () => number
  readonly intervalMs?: number
  /** Receives a probe failure's reason; the panel only sees an unknown row. */
  readonly warn?: (message: string) => void
}

/**
 * Caches the editor row and refreshes it in the background: the HTTP overview route is synchronous and must not wait
 * for a process probe. A row is null only before the first probe finishes; a failed probe keeps the four states
 * honest by reporting `unknown`, which the panel renders as "in use by a person".
 */
export class Editor {
  private view: EditorView | null = null
  private rows: readonly EditorProcess[] | null = null
  private startedAt = 0
  private running = false
  private disposed = false
  constructor(private readonly options: EditorOptions = {}) {}

  /** The last probe's rows, including build tools the derived row does not keep; the lease guard matches new processes. */
  last(): readonly EditorProcess[] | null {
    return this.rows
  }

  /** The last derived row, starting a refresh when the cached one is older than the interval. */
  read(): EditorView | null {
    const now = this.options.now ?? Date.now
    if (!this.disposed && !this.running && now() - this.startedAt >= (this.options.intervalMs ?? DEFAULT_INTERVAL_MS)) {
      this.startedAt = now()
      void this.refresh()
    }
    return this.view
  }

  /** Runs one probe and replaces the row; concurrent callers share the running probe. */
  async refresh(): Promise<EditorView | null> {
    if (this.disposed) return this.view
    if (this.running) return this.view
    this.running = true
    this.startedAt = (this.options.now ?? Date.now)()
    const at = new Date(this.startedAt).toISOString()
    try {
      const processes = await (this.options.probe ?? probeEditorProcesses)()
      if (!this.disposed) { this.view = deriveEditor(processes, at); this.rows = processes }
    } catch (error) {
      this.options.warn?.(`editor probe failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!this.disposed) this.view = { holder: 'unknown', activity: 'unknown', since: null, pid: null, build: null, at,
        detail: '读取进程表失败，按人在用' }
    } finally {
      this.running = false
    }
    return this.view
  }

  /** Stops the loop the panel's polling drives; an in-flight probe finishes but no longer replaces the row. */
  dispose(): void {
    this.disposed = true
  }
}
