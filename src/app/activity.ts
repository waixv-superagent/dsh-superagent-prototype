/** Live execution activity of worker Sessions for the ticket page: the running tool and when it last changed. */
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ticketOfSession } from '../executor/dsh.ts'

/** How many worker Sessions keep a buffer; tickets in flight are far fewer, and an ended ticket is evicted by a newer one. */
const MAX_BUFFERS = 24
/** The longest single argument the card shows; a path or a command fits, a serialized payload does not. */
const MAX_DIGEST = 80

/** What the ticket page reads about one worker: whether it is running, when it last changed, and the tool it is in. */
export interface ActivityView {
  readonly live: boolean
  readonly updatedAt: number
  readonly tool: { readonly name: string; readonly digest: string; readonly elapsed: number } | null
}

interface ToolCall {
  readonly callId: string
  readonly name: string
  readonly digest: string
  readonly at: number
}

interface Buffer {
  readonly sessionId: string
  updatedAt: number
  live: boolean
  tool: ToolCall | null
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
 * Holds the live state of worker Sessions so the ticket page can say what a running worker is doing without opening the
 * Session. It keeps only the current tool call and counters that a person can act on; reasoning, token totals and speed
 * are deliberately not retained or streamed. Nothing is persisted: a host restart starts empty, and the Session remains
 * the complete record.
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

  /** Read a worker's current tool; an unstarted or evicted worker reads as not live. */
  read(ticketId: string): ActivityView {
    const buffer = this.buffers.get(`worker-${ticketId}`)
    if (!buffer) return { live: false, updatedAt: 0, tool: null }
    return { live: buffer.live, updatedAt: buffer.updatedAt,
      tool: buffer.live && buffer.tool ? { name: buffer.tool.name, digest: buffer.tool.digest,
        elapsed: Math.max(0, Date.now() - buffer.tool.at) } : null }
  }

  private ensure(sessionId: string): Buffer | undefined {
    if (!ticketOfSession(sessionId)) return undefined
    const existing = this.buffers.get(sessionId)
    if (existing) return existing
    if (this.buffers.size >= MAX_BUFFERS) {
      const oldest = [...this.buffers.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0]
      if (oldest) this.buffers.delete(oldest.sessionId)
    }
    const buffer: Buffer = { sessionId, updatedAt: Date.now(), live: false, tool: null }
    this.buffers.set(sessionId, buffer)
    return buffer
  }

  private status(sessionId: string, status: string): void {
    const buffer = this.ensure(sessionId)
    if (!buffer) return
    buffer.live = status === 'running'
    buffer.updatedAt = Date.now()
    if (!buffer.live) buffer.tool = null
  }

  private stream(sessionId: string, frame: AssistantStreamFrame): void {
    const buffer = this.ensure(sessionId)
    if (!buffer) return
    // A turn that has started generating is running even while the status event lags behind. No text is kept.
    if (frame.type === 'start' || frame.type === 'chunk') {
      buffer.live = true
      buffer.updatedAt = Date.now()
    }
  }

  private event(session: Session, event: SessionEvent): void {
    const buffer = this.ensure(session.id)
    if (!buffer) return
    buffer.updatedAt = Date.now()
    switch (event.type) {
      case 'tool/call': {
        buffer.live = true
        buffer.tool = { callId: String(event.data.callId), name: event.data.name, digest: digest(event.data.arguments), at: event.time }
        return
      }
      case 'tool/result': {
        if (buffer.tool?.callId === String(event.data.message.toolCallId)) buffer.tool = null
        return
      }
      case 'turn/end': {
        buffer.tool = null
        return
      }
      default: return
    }
  }
}
