/**
 * The lease's teeth (docs/021): a worker's shell command that opens, builds or stops the shared editor without the
 * matching lease is reported on the schedule, and an editor it started is stopped before it can fight the one in use.
 * The decision is taken from the command text when the tool is called, so a lease granted afterwards never excuses a
 * launch that happened before it. Only a worker's own shell calls are read; a person's Rider or Explorer launch, an
 * MCP tool and a subagent session are not this guard's business.
 */
import type { EditorProcess } from './editor.ts'
import type { EditorPurpose } from './editor-schedule.ts'

/** What a Ticket holds when the command starts: a lease with a purpose, a place in the queue, or nothing. */
export type EditorStanding = { state: 'holding'; purpose: EditorPurpose } | { state: 'queued' } | { state: 'none' }

/** One kind of process a command would start: the interactive editor, a headless commandlet, or a build. */
export interface EditorLaunch {
  readonly kind: 'use' | 'headless' | 'build'
  /** Process names the probe reports: lowercased and without `.exe`. */
  readonly names: readonly string[]
  /** Absolute executable paths the command named; empty when it only named a bare program. */
  readonly paths: readonly string[]
}

/** The processes a command asks to stop: ids, or every process of one of the editor's image names. */
export interface EditorStop {
  readonly pids: readonly number[]
  /** The command kills by image name (`taskkill /IM UnrealEditor.exe`), which can include a person's editor. */
  readonly all: boolean
}

/** What a shell command would do to the shared editor, as far as its text tells. */
export interface EditorCommand {
  readonly launches: readonly EditorLaunch[]
  readonly stop: EditorStop | null
}

/** The editor executables the guard recognizes, as they appear in a command. */
const EDITOR_EXE = String.raw`(?:UnrealEditor-Cmd|UnrealEditor|UnrealBuildTool)\.exe`
/** Where a program can start: the beginning of the text, a new statement, a pipeline, `&`, Start-Process or `cmd /c`. */
const LAUNCH_PREFIX = String.raw`(?:^|[;&|(\r\n]\s*|Start-Process\s+(?:-FilePath\s+)?|cmd(?:\.exe)?\s+/c\s+)`
/** An absolute executable path in a launch position. */
const ABSOLUTE_LAUNCH = new RegExp(String.raw`${LAUNCH_PREFIX}["']?([A-Za-z]:[\\/][^"'|;&\r\n]*?\.exe)["']?`, 'gi')
/** A bare or relative editor program in a launch position, such as `& UnrealEditor.exe` or `Start-Process .\UnrealEditor.exe`. */
const BARE_LAUNCH = new RegExp(String.raw`${LAUNCH_PREFIX}["']?(?:\.{0,2}[\\/])?(${EDITOR_EXE})["']?`, 'gi')
/** A process name `taskkill /IM` or `Stop-Process -Name` would match. */
const KILL_NAME = /^(["']?)(?:UnrealEditor-Cmd|UnrealEditor|UnrealBuildTool)(?:\.exe)?\1$/i
/** The names the probe reports for what a command asks to stop. */
const STOPPED_NAMES = new Set(['unrealeditor', 'unrealeditor-cmd', 'unrealbuildtool'])
/** When to look for the process a command started: it takes a moment to appear, and a launch is visible for a while. */
export const ATTEMPTS_MS = [2_000, 5_000, 12_000] as const
/** The lease a stopped launch needed, as the notice tells the worker to take it. */
const PURPOSE_HINT: Record<EditorLaunch['kind'], string> = { use: 'use or restart', headless: 'use, test or restart', build: 'build' }

/** The approved purpose for a launch: opening the editor needs its own lease, and a compile needs the build lease. */
export function launchAllowed(kind: EditorLaunch['kind'], purpose: EditorPurpose | null): boolean {
  if (kind === 'build') return purpose === 'build'
  // A headless commandlet is an agent's use of the editor slot, so a test lease covers it as well.
  if (kind === 'headless') return purpose === 'use' || purpose === 'test' || purpose === 'restart'
  return purpose === 'use' || purpose === 'restart'
}

/** The kind of editor use a program is: the interactive editor, a headless commandlet, or a build. */
function launchKind(name: string): EditorLaunch['kind'] {
  return name === 'unrealbuildtool' ? 'build' : name === 'unrealeditor-cmd' ? 'headless' : 'use'
}

function editorName(path: string): string | null {
  const base = path.split(/[\\/]/).pop()?.trim().toLowerCase().replace(/\.exe$/, '')
  return base && STOPPED_NAMES.has(base) ? base : null
}

/**
 * Reads what a shell command would launch or stop. A path mentioned outside a launch position, such as
 * `Get-Item "…\UnrealEditor.exe"`, is not a launch; a new process is additionally required to prove one happened.
 */
export function editorCommand(text: string): EditorCommand {
  const groups = new Map<EditorLaunch['kind'], { names: Set<string>; paths: Set<string> }>()
  const add = (name: string, path?: string): void => {
    const kind = launchKind(name)
    const group = groups.get(kind) ?? { names: new Set<string>(), paths: new Set<string>() }
    group.names.add(name)
    if (path) group.paths.add(path)
    groups.set(kind, group)
  }
  for (const match of text.matchAll(ABSOLUTE_LAUNCH)) {
    const path = match[1]!
    const name = editorName(path)
    if (name) add(name, path)
  }
  for (const match of text.matchAll(BARE_LAUNCH)) {
    const name = editorName(match[1]!)
    if (name) add(name)
  }
  const launches: EditorLaunch[] = [...groups].map(([kind, group]) => ({ kind, names: [...group.names], paths: [...group.paths] }))
  return { launches, stop: editorStop(text) }
}

/** Reads `taskkill` and `Stop-Process` targets; anything neither names nor kills an editor is ignored. */
function editorStop(text: string): EditorStop | null {
  const pids = new Set<number>()
  let all = false
  for (const match of text.matchAll(/\btaskkill(?:\.exe)?\b([^\r\n]*)/gi)) {
    const args = match[1]!
    for (const value of args.matchAll(/\/PID\s+"?(\d+)/gi)) pids.add(Number(value[1]))
    for (const value of args.matchAll(/\/IM\s+("[^"]*"|'[^']*'|[^\s"']+)/gi)) if (KILL_NAME.test(value[1]!.trim())) all = true
  }
  for (const match of text.matchAll(/\bStop-Process\b([^\r\n]*)/gi)) {
    const args = match[1]!
    for (const value of args.matchAll(/-Id\s+("[^"]*"|[\d,\s]+)/gi)) {
      for (const id of value[1]!.replaceAll('"', '').split(',')) {
        const pid = Number(id.trim())
        if (Number.isInteger(pid) && pid > 0) pids.add(pid)
      }
    }
    for (const value of args.matchAll(/-Name\s+("[^"]*"|'[^']*'|[^\s"']+)/gi)) if (KILL_NAME.test(value[1]!.trim())) all = true
  }
  return pids.size || all ? { pids: [...pids], all } : null
}

function normalizePath(path: string): string {
  return path.replaceAll('/', '\\').toLowerCase()
}

/**
 * The process a watched command started: an editor or build process whose path the command named and whose start is
 * not older than the call. A process of the right name on a different path is left alone, and so is one that was
 * already running, so a person's editor is never what gets stopped. Host and process share one clock, so a process
 * older than the call cannot be the one it started.
 */
export function matchLaunch(rows: readonly EditorProcess[], launch: EditorLaunch, at: number): EditorProcess | undefined {
  const paths = new Set(launch.paths.map(normalizePath))
  return rows.find(row => launch.names.includes(row.name) && row.started !== null
    && Date.parse(row.started) >= at
    && (paths.size === 0 || (row.path !== undefined && paths.has(normalizePath(row.path)))))
}

/** What the guard needs from the host; every effect is injected so a test can watch the decisions. */
export interface EditorGuardHost {
  /** The Ticket a worker Session belongs to, or undefined for another Session. */
  ticketOf(sessionId: string): string | undefined
  /** Whether the Ticket is still open. */
  live(ticketId: string): boolean
  /** What the Ticket holds right now. */
  standing(ticketId: string): EditorStanding
  /** Interactive editors the scheduler knows agents started under a lease. */
  agentPids(): readonly number[]
  /** The last probe's rows, without running a new probe; a stop is judged against the editor processes it saw. */
  known(): readonly EditorProcess[]
  /** The current process table rows. */
  processes(): Promise<readonly EditorProcess[]>
  /** Stops one process and what it started. */
  kill(pid: number): void
  /** Hands the process an allowed launch started to the gatekeeper, which owns it for the lease's lifetime (docs/021). */
  adopt(ticketId: string, pid: number, kind: 'editor' | 'commandlet' | 'build', started: string | null): void
  /** Delivers one notice to the Ticket's worker, at most once per id. */
  notify(ticketId: string, id: string, text: string): Promise<void>
  /** Records the attempt on the schedule's event list. */
  record(ticketId: string, detail: string): void
  warn(message: string): void
  now?(): number
  /** Replaces the waits in tests. */
  delay?(ms: number): Promise<void>
}

/**
 * Watches a worker's shell calls and acts on the ones that bypass the lease. It reads the call, decides from the
 * lease the Ticket held at that moment, and looks for the process the call started; only when one appears is it
 * stopped and reported, so a command that merely names an editor path is not a violation.
 */
export class EditorGuard {
  private disposed = false
  private readonly watching = new Set<string>()
  constructor(private readonly host: EditorGuardHost) {}

  /** Inspects one Session event; anything but a worker's shell tool call is ignored. */
  observe(sessionId: string, callId: string, name: string, argumentsText: string): void {
    if (this.disposed || (name !== 'pwsh' && name !== 'bash')) return
    const ticketId = this.host.ticketOf(sessionId)
    if (!ticketId || !this.host.live(ticketId)) return
    let command: string
    try {
      const body: unknown = JSON.parse(argumentsText)
      const value = body && typeof body === 'object' ? (body as { command?: unknown }).command : undefined
      command = typeof value === 'string' ? value : ''
    } catch {
      return
    }
    if (!command.trim()) return
    const parsed = editorCommand(command)
    const standing = this.host.standing(ticketId)
    const purpose = standing.state === 'holding' ? standing.purpose : null
    for (const launch of parsed.launches) {
      if (launchAllowed(launch.kind, purpose)) void this.adopt(ticketId, callId, launch)
      else void this.watch(ticketId, callId, launch)
    }
    if (parsed.stop) this.reportStop(ticketId, callId, parsed.stop)
  }

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  private delay(ms: number): Promise<void> {
    return this.host.delay ? this.host.delay(ms) : new Promise(resolve => setTimeout(resolve, ms))
  }

  /** Waits for the process an allowed launch creates and hands it to the gatekeeper, which closes it when the lease lapses. */
  private async adopt(ticketId: string, callId: string, launch: EditorLaunch): Promise<void> {
    const key = `${ticketId}:${callId}:adopt:${launch.kind}`
    if (this.watching.has(key)) return
    this.watching.add(key)
    const at = this.now()
    try {
      let waited = 0
      for (const attempt of ATTEMPTS_MS) {
        await this.delay(attempt - waited)
        waited = attempt
        if (this.disposed) return
        const found = matchLaunch(await this.host.processes(), launch, at)
        if (!found) continue
        this.host.adopt(ticketId, found.pid, launch.kind === 'use' ? 'editor' : launch.kind === 'headless' ? 'commandlet' : 'build',
          found.started)
        return
      }
    } catch (error) {
      this.host.warn(`editor lease adoption failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.watching.delete(key)
    }
  }

  /** Waits for the process a disallowed launch creates, stops it, and tells the Ticket what the lease is for. */
  private async watch(ticketId: string, callId: string, launch: EditorLaunch): Promise<void> {
    const key = `${ticketId}:${callId}:${launch.kind}`
    if (this.watching.has(key)) return
    this.watching.add(key)
    const at = this.now()
    try {
      let waited = 0
      for (const attempt of ATTEMPTS_MS) {
        await this.delay(attempt - waited)
        waited = attempt
        if (this.disposed) return
        const found = matchLaunch(await this.host.processes(), launch, at)
        if (!found) continue
        this.host.kill(found.pid)
        const what = launch.kind === 'build' ? 'a build' : 'the shared editor'
        this.host.record(ticketId, `started ${what} without the lease: stopped ${found.name} (pid ${found.pid})`)
        await this.host.notify(ticketId, `editor-bypass:${callId}:${launch.kind}`,
          `You started ${what} without the shared editor lease, so the host stopped it (pid ${found.pid}). `
          + `Call orchestrator_editor op=acquire with purpose ${PURPOSE_HINT[launch.kind]} before you open, build, restart or test it, `
          + 'and never stop an editor you did not start.')
        return
      }
    } catch (error) {
      this.host.warn(`editor lease guard failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.watching.delete(key)
    }
  }

  /** Reports a stop aimed at an editor the Ticket did not start; the process may already be gone, so nothing is killed. */
  private reportStop(ticketId: string, callId: string, stop: EditorStop): void {
    if (!stop.all && stop.pids.length === 0) return
    // A worker stopping its own test or job process is not an editor stop; only the editor processes the last probe
    // saw count. An image-name kill names the editor itself, so it is reported whether or not a row is current.
    const editors = new Set(this.host.known().filter(row => STOPPED_NAMES.has(row.name)).map(row => row.pid))
    const targets = stop.pids.filter(pid => editors.has(pid))
    if (!stop.all && targets.length === 0) return
    // An editor the scheduler saw an agent open is not a person's, even after the Ticket released it to close it again.
    const own = !stop.all && targets.every(pid => this.host.agentPids().includes(pid))
    if (own) return
    const what = stop.all ? 'every running editor' : `pid ${targets.join(', ')}`
    this.host.record(ticketId, `tried to stop ${what} without holding it`)
    void this.host.notify(ticketId, `editor-stop:${callId}`,
      `You tried to stop ${what} of the shared editor without holding it. Call orchestrator_editor op=status to see who holds it, `
      + 'and ask a person to yield instead of stopping an editor you did not start.')
      .catch(error => { this.host.warn(`editor stop notice failed: ${String(error)}`) })
  }

  /** Ends any watch still waiting; a host that stops must not stop a process it no longer owns. */
  dispose(): void {
    this.disposed = true
    this.watching.clear()
  }
}
