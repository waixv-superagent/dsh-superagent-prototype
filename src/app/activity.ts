/** Live execution activity of worker Sessions for the ticket page: reasoning text, tool calls and token throughput, bounded in memory. */
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ticketOfSession } from '../executor/dsh.ts'

/** The reasoning text the panel keeps per worker; every request reads at most this many trailing characters. */
const THINKING_CAP = 64 * 1024
/** Appended reasoning is trimmed back to `THINKING_CAP` only after crossing this bound, so a token delta never slices a large string. */
const THINKING_TRIM = 80 * 1024
/** How many worker Sessions keep a buffer; tickets in flight are far fewer, and an ended ticket is evicted by a newer one. */
const MAX_BUFFERS = 24
/** The longest single argument the collapsed line shows; a path or a command fits, a serialized payload does not. */
const MAX_DIGEST = 80

/** What the ticket page reads about one worker: live state, the running tool, counters and, on request, the reasoning text. */
export interface ActivityView {
  readonly live: boolean
  readonly startedAt: number
  readonly updatedAt: number
  readonly tool: { readonly name: string; readonly digest: string; readonly elapsed: number } | null
  readonly calls: number
  readonly tokens: number
  /** Output tokens per second of the last settled step, when its streamed generation time was long enough to measure. */
  readonly rate: number | null
  /** Present only for an expanded view; `text` continues after the caller's `after` cursor, or is the retained tail when `reset`. */
  readonly thinking?: { readonly text: string; readonly total: number; readonly reset: boolean }
}

interface ToolCall {
  readonly callId: string
  readonly name: string
  readonly digest: string
  readonly at: number
}

interface Buffer {
  readonly sessionId: string
  startedAt: number
  updatedAt: number
  live: boolean
  text: string
  /** Characters appended since the buffer was created; the read cursor counts these, not the retained `text.length`. */
  total: number
  tool: ToolCall | null
  calls: number
  tokens: number
  rate: number | null
  /** Timestamp of the first delta of the current attempt, used with the settled `assistant/message` time for tok/s. */
  firstDeltaAt: number | null
}

/** Describe a tool call in one line: its most telling string argument, clipped; the tool output itself never reaches the panel. */
function digest(argumentsText: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(argumentsText) } catch { parsed = argumentsText }
  const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_DIGEST)
  if (typeof parsed === 'string') return clip(parsed)
  if (parsed && typeof parsed === 'object') {
    const fields = parsed as Record<string, unknown>
    for (const key of ['path', 'file_path', 'file', 'command', 'cmd', 'pattern', 'query', 'url', 'name']) {
      const value = fields[key]
      if (typeof value === 'string' && value.trim()) return clip(value)
    }
    for (const value of Object.values(fields)) if (typeof value === 'string' && value.trim()) return clip(value)
  }
  return ''
}

/**
 * Holds the live activity of worker Sessions so the ticket page can show a running tool and token speed without opening the Session.
 * It listens to the transient assistant stream and the durable session events, keeps only bounded reasoning text and counters,
 * and never persists anything: a host restart starts empty, and the Session remains the complete record.
 */
export class Activity {
  private readonly buffers = new Map<string, Buffer>()
  private readonly disposers: (() => void)[]

  constructor(ctx: Context) {
    this.disposers = [
      ctx.on('agent/assistant-stream', payload => this.stream(payload.agent.id, payload.frame)),
      ctx.on('agent/status', payload => this.status(payload.agent.id, payload.status)),
      ctx.on('session/event', (session, event) => this.event(session, event)),
    ]
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.buffers.clear()
  }

  /** Read a worker's activity; `thinking` is sent only for an expanded view, and `after` counts characters of that text. */
  read(ticketId: string, after: number, thinking: boolean): ActivityView {
    const buffer = this.buffers.get(`worker-${ticketId}`)
    if (!buffer) return { live: false, startedAt: 0, updatedAt: 0, tool: null, calls: 0, tokens: 0, rate: null }
    const view = { live: buffer.live, startedAt: buffer.startedAt, updatedAt: buffer.updatedAt,
      tool: buffer.live && buffer.tool ? { name: buffer.tool.name, digest: buffer.tool.digest,
        elapsed: Math.max(0, Date.now() - buffer.tool.at) } : null,
      calls: buffer.calls, tokens: buffer.tokens, rate: buffer.rate }
    if (!thinking) return view
    const base = buffer.total - buffer.text.length
    const reset = after > buffer.total || after < base
    return { ...view, thinking: { text: reset ? buffer.text : buffer.text.slice(after - base), total: buffer.total, reset } }
  }

  private ensure(sessionId: string): Buffer | undefined {
    if (!ticketOfSession(sessionId)) return undefined
    const existing = this.buffers.get(sessionId)
    if (existing) return existing
    if (this.buffers.size >= MAX_BUFFERS) {
      const oldest = [...this.buffers.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0]
      if (oldest) this.buffers.delete(oldest.sessionId)
    }
    const buffer: Buffer = { sessionId, startedAt: Date.now(), updatedAt: Date.now(), live: false, text: '', total: 0,
      tool: null, calls: 0, tokens: 0, rate: null, firstDeltaAt: null }
    this.buffers.set(sessionId, buffer)
    return buffer
  }

  private status(sessionId: string, status: string): void {
    const buffer = this.ensure(sessionId)
    if (!buffer) return
    buffer.live = status === 'running'
    buffer.updatedAt = Date.now()
    if (!buffer.live) { buffer.tool = null; buffer.firstDeltaAt = null }
  }

  private stream(sessionId: string, frame: AssistantStreamFrame): void {
    const buffer = this.ensure(sessionId)
    if (!buffer) return
    buffer.updatedAt = Date.now()
    if (frame.type === 'start') { buffer.live = true; buffer.firstDeltaAt = null; return }
    if (frame.type === 'end') { if (frame.outcome.kind === 'abandoned') buffer.firstDeltaAt = null; return }
    buffer.live = true
    if (frame.chunk.type === 'reasoning-delta') this.append(buffer, frame.chunk.text)
    if ((frame.chunk.type === 'reasoning-delta' || frame.chunk.type === 'text-delta') && buffer.firstDeltaAt === null) {
      buffer.firstDeltaAt = frame.time
    }
  }

  private event(session: Session, event: SessionEvent): void {
    const buffer = this.ensure(session.id)
    if (!buffer) return
    buffer.updatedAt = Date.now()
    switch (event.type) {
      case 'tool/call': {
        buffer.tool = { callId: String(event.data.callId), name: event.data.name, digest: digest(event.data.arguments), at: event.time }
        buffer.calls += 1
        return
      }
      case 'tool/result': {
        if (buffer.tool?.callId === String(event.data.message.toolCallId)) buffer.tool = null
        return
      }
      case 'turn/end': {
        buffer.tool = null
        buffer.firstDeltaAt = null
        return
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (!usage) return
        buffer.tokens += usage.outputTokens
        const started = buffer.firstDeltaAt
        // Only a settled, sufficiently long generation gives a meaningful rate; a retried attempt leaves no rate behind.
        if (!event.data.interrupted && started !== null && usage.outputTokens > 0) {
          const seconds = (event.time - started) / 1000
          if (seconds >= 0.25) buffer.rate = Math.round(usage.outputTokens / seconds)
        }
        buffer.firstDeltaAt = null
        return
      }
      default: return
    }
  }

  private append(buffer: Buffer, text: string): void {
    if (!text) return
    buffer.text += text
    buffer.total += text.length
    if (buffer.text.length > THINKING_TRIM) buffer.text = buffer.text.slice(-THINKING_CAP)
  }
}
