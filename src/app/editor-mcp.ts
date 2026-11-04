/**
 * What the editor itself says through ue-mcp, read from the files its bridge plugin publishes under
 * `<project>/Saved/UE_MCP_Bridge`: `status.json` is flushed by a writer thread that keeps running while the game thread is
 * blocked, and `instances/<pid>.json` records each bridge that listens. Reading files costs nothing and never asks the
 * game thread, so a wedged or modal editor is still described instead of timing out.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A snapshot older than this is the last word of an editor that stopped writing, not its current state. */
const STALE_MS = 30_000

export interface EditorEngineState {
  /** Where the snapshot came from; `none` when the project has no bridge or no editor wrote one. */
  source: 'status.json' | 'none'
  /** The plugin's phase, such as `config init`, `loading map` or `ready`. */
  phase: string | null
  pid: number | null
  ticking: boolean | null
  /** Seconds the game thread has not ticked; null during startup, when there is no loop to stall. */
  stalledSeconds: number | null
  /** The engine's slow task, such as a map load or a shader compile, with its fraction. */
  slowTask: { name: string; fraction: number } | null
  /** A dialog waiting for a person's answer; `blocking` when the engine is parked behind it. */
  modal: { title: string; message: string; buttons: string[]; blocking: boolean } | null
  compiling: { shaders: number; assets: number } | null
  /** The bridge request the editor is executing, such as `run_automation_tests`. */
  handler: { method: string; elapsedSeconds: number } | null
  writtenAt: string | null
  /** True when the snapshot is older than the editor would let it get while running. */
  stale: boolean
  /** Bridges that registered for this project and whose process still runs. */
  bridges: { pid: number; port: number; state: string; startedAt: string | null }[]
  /** Why nothing could be read, in words a person can check. */
  detail?: string
}

const NONE = (detail: string): EditorEngineState => ({ source: 'none', phase: null, pid: null, ticking: null, stalledSeconds: null,
  slowTask: null, modal: null, compiling: null, handler: null, writtenAt: null, stale: false, bridges: [], detail })

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/** Parses one `status.json` snapshot; unknown or malformed fields read as null rather than as a guess. */
export function parseEngineSnapshot(value: unknown, now: number): Omit<EditorEngineState, 'bridges'> {
  const snap = record(value)
  if (!snap) return NONE('status.json is unreadable')
  const slow = record(snap.slowTask)
  const modal = record(snap.modal)
  const compiling = record(snap.compiling)
  const handler = record(snap.handler)
  const writtenAt = str(snap.writtenAt)
  const written = writtenAt ? Date.parse(writtenAt) : NaN
  return {
    source: 'status.json', phase: str(snap.phase), pid: num(snap.pid),
    ticking: typeof snap.gameThreadTicking === 'boolean' ? snap.gameThreadTicking : null,
    stalledSeconds: num(snap.gameThreadStalledSeconds),
    slowTask: slow && str(slow.name) ? { name: String(slow.name), fraction: num(slow.fraction) ?? 0 } : null,
    // An older plugin does not say whether a dialog blocks; treating it as blocking is the answer every caller had before.
    modal: modal ? { title: str(modal.title) ?? '', message: str(modal.message) ?? '', blocking: modal.blocksGameThread !== false,
      buttons: Array.isArray(modal.buttons) ? modal.buttons.filter((button): button is string => typeof button === 'string') : [] } : null,
    compiling: compiling ? { shaders: num(compiling.shaders) ?? 0, assets: num(compiling.assets) ?? 0 } : null,
    handler: handler && str(handler.method) ? { method: String(handler.method), elapsedSeconds: num(handler.elapsedSeconds) ?? 0 } : null,
    writtenAt, stale: !Number.isFinite(written) || now - written > STALE_MS,
  }
}

/** Whether a process still runs; signal 0 checks without touching it. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Reads the bridge's files for the project at `uproject`. A missing project path, plugin or snapshot is a `none` row
 * that says which, so the overview can tell "no ue-mcp here" from "the editor stopped writing".
 */
export function readEngineState(uproject: string, now = Date.now(), isAlive: (pid: number) => boolean = alive): EditorEngineState {
  if (!uproject.trim()) return NONE('no project is configured for the editor')
  const dir = join(dirname(uproject), 'Saved', 'UE_MCP_Bridge')
  let names: string[]
  try { names = readdirSync(dir) } catch { return NONE(`${dir} does not exist; ue-mcp's bridge is not deployed or never started`) }
  const bridges = (() => {
    try {
      return readdirSync(join(dir, 'instances')).filter(name => name.endsWith('.json')).flatMap(name => {
        const value = record(readJson(join(dir, 'instances', name)))
        const pid = num(value?.pid)
        if (!value || pid === null || !isAlive(pid)) return []
        return [{ pid, port: num(value.port) ?? 0, state: str(value.state) ?? 'unknown', startedAt: str(value.startedAt) }]
      })
    } catch { return [] }
  })()
  // Several editors of one project each write `status.<pid>.json`; the newest one of a running process is the current one.
  const candidates = names.filter(name => /^status(\.\d+)?\.json$/.test(name)).map(name => {
    let mtime = 0
    try { mtime = statSync(join(dir, name)).mtimeMs } catch { /* A file removed between the listing and the stat is skipped. */ }
    return { name, mtime }
  }).sort((left, right) => right.mtime - left.mtime)
  for (const { name } of candidates) {
    const parsed = parseEngineSnapshot(readJson(join(dir, name)), now)
    if (parsed.source === 'none') continue
    if (parsed.pid !== null && !isAlive(parsed.pid)) continue
    return { ...parsed, bridges }
  }
  return { ...NONE('no running editor wrote a status snapshot'), bridges }
}

/** One phrase the overview shows for the engine: a blocking dialog first, then a stall, a slow task, compiling, or the phase. */
export function engineSummary(state: EditorEngineState): { tone: 'ok' | 'busy' | 'blocked' | 'off'; text: string } {
  if (state.source === 'none' || state.stale) return { tone: 'off', text: state.detail ?? 'the editor stopped writing its status' }
  if (state.modal?.blocking) return { tone: 'blocked', text: `dialog: ${state.modal.title || state.modal.message}` }
  if (state.stalledSeconds !== null && state.stalledSeconds > 30) return { tone: 'blocked', text: `game thread stalled ${Math.round(state.stalledSeconds)}s` }
  if (state.handler) return { tone: 'busy', text: `${state.handler.method} ${Math.round(state.handler.elapsedSeconds)}s` }
  if (state.slowTask) return { tone: 'busy', text: `${state.slowTask.name} ${Math.round(state.slowTask.fraction * 100)}%` }
  if (state.compiling && (state.compiling.shaders > 0 || state.compiling.assets > 0)) {
    return { tone: 'busy', text: `compiling ${state.compiling.shaders} shaders, ${state.compiling.assets} assets` }
  }
  return { tone: state.phase === 'ready' ? 'ok' : 'busy', text: state.phase ?? 'unknown phase' }
}
