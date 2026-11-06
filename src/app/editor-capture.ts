/**
 * Editor-side screenshots for verification evidence (docs/027).
 *
 * The pixels come from the editor's own Slate rendering through the engine's ModelContextProtocol server, never from
 * the desktop. A desktop capture comes back black while the Windows session is locked; the editor keeps rendering, so
 * an evidence capture taken this way stays readable exactly when a worker cannot otherwise take a screenshot.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The engine MCP endpoint the project's ModelContextProtocol plugin serves; the project starts it on launch. */
export const EDITOR_CAPTURE_URL = process.env.DSH_SUPERAGENT_EDITOR_CAPTURE_URL ?? 'http://127.0.0.1:8000/mcp'
/** The engine toolset that lists, selects and screenshots top-level Slate windows. The engine dispatches it via `call_tool`. */
const SLATE_TOOLSET = 'SlateInspectorToolset.SlateInspectorToolset'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IHDR = Buffer.from('IHDR', 'ascii')
const DEFAULT_TIMEOUT_MS = 30_000

/** A capture step the worker can act on: the message names the endpoint, the window or the tool that failed. */
export class EditorCaptureError extends Error {
  constructor(message: string) { super(message); this.name = 'EditorCaptureError' }
}

/** One top-level editor window, as the Slate inspector lists it. */
export interface EditorWindow { index: number; title: string }

/** What a capture left on disk, and the facts the verification package can cite. */
export interface EditorCapture {
  /** Absolute path of the PNG, inside the ticket's evidence directory. */
  path: string
  /** Absolute path of the JSON sidecar recording the same facts. */
  metadata_path: string
  ticket_id: string
  captured_at: string
  target: 'active' | 'window'
  window?: EditorWindow
  width: number
  height: number
  bytes: number
  sha256: string
  editor: { url: string; toolset: string }
}

export interface CaptureEditorOptions {
  /** The ticket whose evidence the capture belongs to; it is recorded in the sidecar. */
  ticketId: string
  /** Directory the PNG and its sidecar are written to, such as `<stateDir>/evidence/<ticketId>`. */
  outDir: string
  /** Title substring of the window to bring to the front and capture; omitted captures the active window. */
  window?: string
  /** Engine MCP endpoint; defaults to `DSH_SUPERAGENT_EDITOR_CAPTURE_URL` or the project's port 8000. */
  url?: string
  timeoutMs?: number
  now?: () => Date
  signal?: AbortSignal
}

interface Session { url: string; id?: string; nextId: number }

/** Captures one editor window and writes the PNG and its metadata sidecar; the caller holds the editor lease. */
export async function captureEditor(options: CaptureEditorOptions): Promise<EditorCapture> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const session = await openSession(options.url ?? EDITOR_CAPTURE_URL, timeoutMs, options.signal)
  let window: EditorWindow | undefined
  if (options.window !== undefined) {
    const windows = await listWindows(session, timeoutMs, options.signal)
    window = pickWindow(windows, options.window)
    const selected = textOf(await callSlate(session, 'Windows', { action: 'select', index: window.index }, timeoutMs, options.signal), 'Windows select')
    if (selected.trim() !== 'OK') {
      throw new EditorCaptureError(`the editor refused to select window ${window.index} (${JSON.stringify(window.title)}): ${selected.trim() || 'no detail'}`)
    }
  }
  const png = imageOf(await callSlate(session, 'Screenshot', { ref: '' }, timeoutMs, options.signal), 'Screenshot')
  const size = pngSize(png)
  return save(options, png, size, window)
}

async function openSession(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Session> {
  const session: Session = { url, nextId: 0 }
  await request(session, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-superagent', version: '0.1.0' },
  }, timeoutMs, signal)
  // The initialized notification has no response and no id; the first tool call reports a real session problem.
  await notify(session, 'notifications/initialized', timeoutMs, signal).catch(() => undefined)
  const names = toolNames(await request(session, 'tools/list', {}, timeoutMs, signal))
  if (!names.includes('call_tool')) {
    throw new EditorCaptureError(`the editor MCP at ${url} does not dispatch toolsets through call_tool (tools: ${names.join(', ') || 'none'}); the editor answered, but not in the tool-search mode a capture needs`)
  }
  return session
}

async function listWindows(session: Session, timeoutMs: number, signal?: AbortSignal): Promise<EditorWindow[]> {
  const text = textOf(await callSlate(session, 'Windows', { action: 'list' }, timeoutMs, signal), 'Windows list')
  const parsed = parseJson(text)
  if (!Array.isArray(parsed)) throw new EditorCaptureError(`the editor's window list is not a JSON array: ${text.slice(0, 200)}`)
  const windows: EditorWindow[] = []
  for (const item of parsed) {
    if (isRecord(item) && typeof item.index === 'number' && typeof item.title === 'string') {
      windows.push({ index: item.index, title: item.title })
    }
  }
  return windows
}

/** The one window a title substring names; a missing or ambiguous title lists the open windows instead of guessing. */
function pickWindow(windows: readonly EditorWindow[], wanted: string): EditorWindow {
  const needle = wanted.toLocaleLowerCase()
  const matches = windows.filter(window => window.title.toLocaleLowerCase().includes(needle))
  if (matches.length === 1) return matches[0]!
  const titles = windows.map(window => JSON.stringify(window.title)).join(', ')
  if (matches.length === 0) {
    throw new EditorCaptureError(`no editor window matches ${JSON.stringify(wanted)}; open windows: ${titles || 'none (is the editor minimized or still loading?)'}`)
  }
  throw new EditorCaptureError(`window ${JSON.stringify(wanted)} is ambiguous: ${matches.map(window => JSON.stringify(window.title)).join(', ')}`)
}

/** Reads the PNG the Slate screenshot returned as MCP image content or as JSON text carrying base64 data. */
function imageOf(result: unknown, tool: string): Buffer {
  for (const item of contentOf(result, tool)) {
    if (item.type === 'image' && typeof item.data === 'string') {
      if (item.mimeType !== undefined && item.mimeType !== 'image/png') throw new EditorCaptureError(`the editor returned ${String(item.mimeType)} for ${tool}; only PNG captures are evidence this tool can store`)
      return Buffer.from(item.data, 'base64')
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      const parsed = parseJson(item.text)
      const nested = isRecord(parsed) && isRecord(parsed.image) ? parsed.image : parsed
      if (isRecord(nested) && typeof nested.data === 'string'
        && (nested.mimeType === undefined || nested.mimeType === 'image/png')) {
        return Buffer.from(nested.data, 'base64')
      }
    }
  }
  throw new EditorCaptureError(`the editor returned no PNG for ${tool}; the window may be closed or minimized`)
}

/** The PNG's own header is the only size source trusted: an empty or non-PNG payload never becomes evidence. */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_MAGIC) || !png.subarray(12, 16).equals(PNG_IHDR)) {
    throw new EditorCaptureError('the editor returned data that is not a PNG; the capture was not stored')
  }
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width === 0 || height === 0) throw new EditorCaptureError('the editor returned an empty PNG; the capture was not stored')
  return { width, height }
}

async function save(options: CaptureEditorOptions, png: Buffer, size: { width: number; height: number },
  window: EditorWindow | undefined): Promise<EditorCapture> {
  const capturedAt = (options.now ?? (() => new Date()))().toISOString()
  const stamp = capturedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const slug = slugOf(window?.title ?? 'active')
  const sha256 = createHash('sha256').update(png).digest('hex')
  await mkdir(options.outDir, { recursive: true })
  // One capture never overwrites another: a busy timestamp gets a numeric suffix instead.
  for (let attempt = 1; ; attempt++) {
    const base = attempt === 1 ? `${stamp}-${slug}` : `${stamp}-${slug}-${attempt}`
    const path = join(options.outDir, `${base}.png`)
    try {
      await writeFile(path, png, { flag: 'wx' })
      const record = {
        ticket_id: options.ticketId,
        captured_at: capturedAt,
        target: window === undefined ? 'active' as const : 'window' as const,
        ...(window === undefined ? {} : { window }),
        width: size.width,
        height: size.height,
        bytes: png.length,
        sha256,
        editor: { url: options.url ?? EDITOR_CAPTURE_URL, toolset: SLATE_TOOLSET },
        png: `${base}.png`,
      }
      const metadataPath = join(options.outDir, `${base}.json`)
      await writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      return { path, metadata_path: metadataPath, ...record }
    } catch (error) {
      if (!isRecord(error) || (error as { code?: unknown }).code !== 'EEXIST' || attempt >= 50) throw error
    }
  }
}

function slugOf(title: string): string {
  const slug = title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48)
  return slug || 'window'
}

/** The tools/call content items; an error result becomes the message a worker can act on. */
function contentOf(result: unknown, tool: string): Record<string, unknown>[] {
  if (!isRecord(result)) throw new EditorCaptureError(`the editor returned no result for ${tool}`)
  const content = result.content
  const items = Array.isArray(content) ? content.filter(isRecord) : []
  if (result.isError === true) {
    const detail = items.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n').trim()
    throw new EditorCaptureError(`the editor reported ${tool} failed: ${detail || 'no detail'}`)
  }
  if (!Array.isArray(content)) throw new EditorCaptureError(`the editor returned no content for ${tool}`)
  return items
}

/** The text items of a tool result, joined for the JSON-shaped window list and the select acknowledgement. */
function textOf(result: unknown, tool: string): string {
  return contentOf(result, tool)
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n')
    .trim()
}

function toolNames(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) return []
  return result.tools.flatMap(tool => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [])
}

// -- engine MCP transport -------------------------------------------------

/** One JSON-RPC request over the engine's Streamable HTTP endpoint, answering with `result` or a named failure. */
async function request(session: Session, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const id = ++session.nextId
  const response = await post(session, { jsonrpc: '2.0', id, method, params }, timeoutMs, signal)
  const messages = messageList(response.body, response.contentType, session.url)
  for (const message of messages) {
    if (!isRecord(message) || message.id !== id) continue
    if (isRecord(message.error)) throw new EditorCaptureError(`the editor MCP ${method} failed: ${String(message.error.message ?? 'unknown error')}`)
    return message.result
  }
  throw new EditorCaptureError(`the editor MCP ${method} produced no matching response at ${session.url}`)
}

async function notify(session: Session, method: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await post(session, { jsonrpc: '2.0', method }, timeoutMs, signal)
}

async function callSlate(session: Session, tool: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  return request(session, 'tools/call', { name: 'call_tool', arguments: { toolset_name: SLATE_TOOLSET, tool_name: tool, arguments: args } }, timeoutMs, signal)
}

async function post(session: Session, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ body: string; contentType: string }> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const aborted = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'dsh-superagent/0.1.0',
  }
  if (session.id !== undefined) headers['Mcp-Session-Id'] = session.id
  let response: Response
  try {
    response = await fetch(session.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: aborted })
  } catch (error) {
    if (signal?.aborted) throw new EditorCaptureError('the capture was cancelled')
    throw new EditorCaptureError(`cannot reach the editor MCP at ${session.url}: ${reasonOf(error)}. Start Unreal Editor for the project; the project serves this endpoint on launch.`)
  }
  const body = await response.text()
  if (!response.ok) throw new EditorCaptureError(`the editor MCP answered HTTP ${response.status} at ${session.url}: ${body.slice(0, 300) || response.statusText}`)
  const id = response.headers.get('mcp-session-id')
  if (id !== null && id !== '') session.id = id
  return { body, contentType: response.headers.get('content-type') ?? '' }
}

/** The JSON messages of a Streamable HTTP response, plain or server-sent events. */
function messageList(body: string, contentType: string, url: string): unknown[] {
  if (!body.trim()) return []
  try {
    const value: unknown = JSON.parse(body)
    return Array.isArray(value) ? value : [value]
  } catch {
    // Not plain JSON; the engine may answer with SSE frames.
  }
  const messages: unknown[] = []
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n').trim()
    if (!data) continue
    try {
      const value: unknown = JSON.parse(data)
      messages.push(...Array.isArray(value) ? value : [value])
    } catch {
      continue
    }
  }
  if (messages.length === 0) throw new EditorCaptureError(`the editor MCP at ${url} returned neither JSON nor SSE (${contentType || 'no content type'}): ${body.slice(0, 200)}`)
  return messages
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
