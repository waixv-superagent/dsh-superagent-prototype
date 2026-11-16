/**
 * Whether a person is at the machine (docs/021): the operating system's last keyboard or mouse input.
 * The editor scheduler reads it so an editor a person left open does not hold the queue for agents forever; a reading
 * costs one short PowerShell call, so it is cached like the process probe and refreshed in the background.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** How long a person may go without keyboard or mouse input before the editors they left count as unattended. */
export const AWAY_AFTER_MS = 10 * 60_000
/** The panel reads the schedule on every poll; probing the input session that often would spend more than it tells. */
const PRESENCE_INTERVAL_MS = 30_000
/** A probe slower than this would hold up a scheduler decision; the cached reading stays until the next refresh. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * What the last input says: a person is using the machine, has not touched it for the away threshold, or the reading is
 * unavailable. Only `away` may yield anything; `unknown` is the conservative answer on a host that cannot tell.
 */
export interface Presence {
  readonly state: 'present' | 'away' | 'unknown'
  /** Milliseconds since the last keyboard or mouse input; null when the operating system would not say. */
  readonly idleMs: number | null
  /** When this reading was taken, ISO. */
  readonly at: string
  /** Why the state is unknown, in words a person checking the log can act on; never used to decide anything. */
  readonly detail?: string
}

/** Whether the last input is old enough to count as away; a missing reading stays unknown, never present or away. */
export function derivePresence(idleMs: number | null, now: number, awayMs: number = AWAY_AFTER_MS): Presence {
  const at = new Date(now).toISOString()
  if (idleMs === null) return { state: 'unknown', idleMs: null, at, detail: 'the operating system would not report the last input' }
  return { state: idleMs >= awayMs ? 'away' : 'present', idleMs, at }
}

/** Parses the probe's single number; anything else is a reading this host cannot use. */
export function parseIdleMilliseconds(stdout: string): number | null {
  const text = stdout.trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

// `GetLastInputInfo` is the only answer that reflects the whole session: the editor's own idle deed, the panel's polls
// and this host's calls all leave it untouched. PowerShell compiles the one P/Invoke it needs per call.
const PROBE_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class DshIdle {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long IdleMilliseconds() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return -1;
    return unchecked((uint)(Environment.TickCount - (int)info.dwTime));
  }
}'
[DshIdle]::IdleMilliseconds()`

/**
 * Reads the session's last keyboard or mouse input. PowerShell is the only input-session reader available without a native
 * module, and the call costs about a second, which is why the class below caches it.
 * @throws when this is not Windows or PowerShell cannot answer; the caller turns that into an unknown reading.
 */
export async function probeIdleMilliseconds(): Promise<number | null> {
  if (process.platform !== 'win32') throw new Error('idle detection needs the Windows input session')
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64')
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' })
  return parseIdleMilliseconds(stdout)
}

export interface PresenceOptions {
  /** Replaces the Windows probe in tests. */
  readonly probe?: () => Promise<number | null>
  readonly now?: () => number
  readonly intervalMs?: number
  readonly awayMs?: number
  /** Receives a probe failure's reason; the scheduler only sees an unknown reading. */
  readonly warn?: (message: string) => void
}

/**
 * Caches the last-input reading and refreshes it in the background: the scheduler asks on every change and a tick, and
 * only a reading taken by an earlier refresh is ever answered. A failed probe reports `unknown`, which yields nothing.
 */
export class EditorPresence {
  private presence: Presence | null = null
  private startedAt = 0
  private running = false
  private disposed = false
  constructor(private readonly options: PresenceOptions = {}) {}

  /** The last reading, starting a refresh when the cached one is older than the interval. */
  read(): Presence | null {
    const now = this.options.now ?? Date.now
    if (!this.disposed && !this.running && now() - this.startedAt >= (this.options.intervalMs ?? PRESENCE_INTERVAL_MS)) {
      this.startedAt = now()
      void this.refresh()
    }
    return this.presence
  }

  /** Runs one probe and replaces the reading; concurrent callers share the running probe. */
  async refresh(): Promise<Presence | null> {
    if (this.disposed) return this.presence
    if (this.running) return this.presence
    this.running = true
    this.startedAt = (this.options.now ?? Date.now)()
    try {
      const idleMs = await (this.options.probe ?? probeIdleMilliseconds)()
      if (!this.disposed) this.presence = derivePresence(idleMs, this.startedAt, this.options.awayMs)
    } catch (error) {
      this.options.warn?.(`editor presence probe failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!this.disposed) this.presence = derivePresence(null, this.startedAt)
    } finally {
      this.running = false
    }
    return this.presence
  }

  /** Stops replacing the reading; an in-flight probe finishes but no longer changes it. */
  dispose(): void {
    this.disposed = true
  }
}
