/** The engine-side editor capture (docs/027): the MCP session, window selection, the PNG and its sidecar, and the failures. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureEditor, EditorCaptureError } from '../src/app/editor-capture.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { Ticket } from '../src/core/index.ts'

/** A real 1x1 PNG; the capture only trusts a payload whose own IHDR says it is one. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

interface Call { message: Record<string, any>; headers: IncomingMessage['headers'] }
interface FakeEditor { url: string; calls: Call[]; close(): Promise<void> }
type Behavior = (call: Call) => unknown | undefined

const tools = (call: Call) => call.message.params.arguments as { tool_name: string; arguments: Record<string, unknown> }
/** The engine wraps a plain tool result in `{"returnValue": …}`; a text result keeps its JSON inside that string. */
const text = (value: string) => ({ content: [{ type: 'text', text: JSON.stringify({ returnValue: value }) }] })
const image = (data: Buffer = PNG, mimeType = 'image/png') => ({ content: [{ type: 'image', mimeType, data: data.toString('base64') }] })
const textImage = (data: Buffer = PNG) => ({ content: [{ type: 'text', text: JSON.stringify({ returnValue: { mimeType: 'image/png', data: data.toString('base64') } }) }] })
const windows = (...titles: string[]) => text(JSON.stringify(titles.map((title, index) => ({ index, title }))))

async function fakeEditor(behavior: Behavior): Promise<FakeEditor> {
  const calls: Call[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const message = JSON.parse(body) as Record<string, any>
      const call = { message, headers: req.headers }
      calls.push(call)
      if (message.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'session-1')
        return json(res, message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } })
      }
      if (message.method === 'notifications/initialized') { res.statusCode = 202; return res.end() }
      if (message.method === 'tools/list') return json(res, message.id, { tools: [{ name: 'call_tool' }] })
      if (message.method === 'tools/call') {
        const result = behavior(call)
        if (result !== undefined) return json(res, message.id, result)
      }
      return json(res, message.id, { isError: true, content: [{ type: 'text', text: 'unexpected call' }] })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function json(res: ServerResponse, id: unknown, result: unknown) {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

let editors: FakeEditor[] = []
afterEach(async () => { for (const editor of editors.splice(0)) await editor.close() })

function outDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'editor-capture-')), 'evidence', 'ticket-1')
}

describe('captureEditor', () => {
  it('captures the active window, keeps the MCP session and writes the PNG with its sidecar', async () => {
    const editor = await fakeEditor(call => tools(call).tool_name === 'Screenshot' ? image() : undefined)
    editors.push(editor)
    const directory = outDir()
    const capture = await captureEditor({ ticketId: 'ticket-1', outDir: directory, url: editor.url })

    expect(capture.target).toBe('active')
    expect(capture.window).toBeUndefined()
    expect(capture.width).toBe(1)
    expect(capture.height).toBe(1)
    expect(capture.bytes).toBe(PNG.length)
    expect(capture.sha256).toBe(createHash('sha256').update(PNG).digest('hex'))
    expect(readFileSync(capture.path).equals(PNG)).toBe(true)
    const record = JSON.parse(readFileSync(capture.metadata_path, 'utf8'))
    expect(record).toMatchObject({ ticket_id: 'ticket-1', target: 'active', width: 1, height: 1, sha256: capture.sha256,
      editor: { url: editor.url, toolset: 'SlateInspectorToolset.SlateInspectorToolset' } })
    // Every request after initialize carries the session the engine handed back; no window selection happened.
    expect(editor.calls.slice(1).every(call => call.headers['mcp-session-id'] === 'session-1')).toBe(true)
    expect(editor.calls.some(call => call.message.method === 'tools/call' && tools(call).arguments.action === 'select')).toBe(false)
  })

  it('selects the one window a title substring names', async () => {
    const editor = await fakeEditor(call => {
      const { tool_name, arguments: args } = tools(call)
      if (tool_name === 'Windows' && args.action === 'list') return windows('SunGame - Unreal Editor', 'Output Log')
      if (tool_name === 'Windows' && args.action === 'select') return text('OK')
      if (tool_name === 'Screenshot') return image()
      return undefined
    })
    editors.push(editor)
    const capture = await captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: editor.url, window: 'output log' })

    expect(capture.target).toBe('window')
    expect(capture.window).toEqual({ index: 1, title: 'Output Log' })
    const selected = editor.calls.find(call => call.message.method === 'tools/call' && tools(call).arguments.action === 'select')
    expect(tools(selected!).arguments.index).toBe(1)
  })

  it('names the open windows instead of guessing when no window matches', async () => {
    const editor = await fakeEditor(call => {
      const { tool_name, arguments: args } = tools(call)
      if (tool_name === 'Windows' && args.action === 'list') return windows('SunGame - Unreal Editor', 'Output Log')
      return undefined
    })
    editors.push(editor)
    await expect(captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: editor.url, window: 'missing' }))
      .rejects.toThrow(/no editor window matches "missing"; open windows: "SunGame - Unreal Editor", "Output Log"/)
    expect(editor.calls.some(call => call.message.method === 'tools/call' && tools(call).tool_name === 'Screenshot')).toBe(false)
  })

  it('refuses an ambiguous window title', async () => {
    const editor = await fakeEditor(call => {
      const { tool_name, arguments: args } = tools(call)
      if (tool_name === 'Windows' && args.action === 'list') return windows('SunGame - Unreal Editor', 'Output Log')
      return undefined
    })
    editors.push(editor)
    await expect(captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: editor.url, window: 'o' }))
      .rejects.toThrow(/ambiguous/)
  })

  it('reports an unreachable editor with the endpoint', async () => {
    const dead = await fakeEditor(() => undefined)
    const url = dead.url
    await dead.close()
    const error = await captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url })
      .then<undefined, Error>(() => undefined, reason => reason instanceof Error ? reason : new Error(String(reason)))
    if (!error) throw new Error('expected the capture to fail')
    expect(error).toBeInstanceOf(EditorCaptureError)
    expect(error.message).toContain('cannot reach the editor MCP')
    expect(error.message).toContain(url)
  })

  it('refuses an engine endpoint without tool-search call_tool', async () => {
    const calls: Call[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const message = JSON.parse(body) as Record<string, any>
        calls.push({ message, headers: req.headers })
        res.setHeader('Mcp-Session-Id', 'session-1')
        if (message.method === 'tools/list') return json(res, message.id, { tools: [{ name: 'list_toolsets' }, { name: 'describe_toolset' }] })
        return json(res, message.id, {})
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const editor: FakeEditor = { url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
    editors.push(editor)
    await expect(captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: editor.url })).rejects.toThrow(/call_tool/)
  })

  it('stores no evidence when the editor returns no image or a payload that is not a PNG', async () => {
    const noImage = await fakeEditor(() => text('the window is closed'))
    editors.push(noImage)
    await expect(captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: noImage.url })).rejects.toThrow(/no PNG for Screenshot/)

    const fakePng = await fakeEditor(call => tools(call).tool_name === 'Screenshot' ? image(Buffer.from('not a png')) : undefined)
    editors.push(fakePng)
    await expect(captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: fakePng.url })).rejects.toThrow(/not a PNG/)
  })

  it('surfaces a tool error result', async () => {
    const editor = await fakeEditor(call => tools(call).tool_name === 'Screenshot'
      ? { isError: true, content: [{ type: 'text', text: 'Screenshot failed: no active window' }] } : undefined)
    editors.push(editor)
    await expect(captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: editor.url }))
      .rejects.toThrow(/the editor reported Screenshot failed: Screenshot failed: no active window/)
  })

  it('decodes a screenshot the editor returned as wrapped JSON text', async () => {
    const editor = await fakeEditor(call => tools(call).tool_name === 'Screenshot' ? textImage() : undefined)
    editors.push(editor)
    const capture = await captureEditor({ ticketId: 'ticket-1', outDir: outDir(), url: editor.url })
    expect(capture.width).toBe(1)
    expect(readFileSync(capture.path).equals(PNG)).toBe(true)
    expect(capture.window).toBeUndefined()
  })

  it('never overwrites an earlier capture with the same timestamp', async () => {
    const editor = await fakeEditor(call => tools(call).tool_name === 'Screenshot' ? image() : undefined)
    editors.push(editor)
    const directory = outDir()
    const now = () => new Date('2026-11-06T06:00:00.000Z')
    const first = await captureEditor({ ticketId: 'ticket-1', outDir: directory, url: editor.url, now })
    const second = await captureEditor({ ticketId: 'ticket-1', outDir: directory, url: editor.url, now })
    expect(second.path).not.toBe(first.path)
    expect(existsSync(first.path) && existsSync(second.path)).toBe(true)
  })
})

describe('orchestrator_editor op=capture', () => {
  const ticket = { id: 'ticket-1' } as unknown as Ticket
  const signal = new AbortController().signal

  it('refuses without the editor lease and passes the window while holding it', async () => {
    let holding = false
    const capture = vi.fn(async () => ({ path: 'C:/state/evidence/ticket-1/x.png' }))
    const host = {
      editor: { standing: () => holding ? { state: 'holding', lease: {} } : { state: 'none' } },
      store: { tickets: { get: () => ticket }, settings: () => ({ executor: { backend: 'git' } }) },
      github: { deployment: { repository: 'owner/repo', github: { login: 'agent' } } },
      capture,
    } as unknown as ExecutorToolsHost
    const editor = executorTools(host, ticket).find(tool => tool.name === 'orchestrator_editor')!

    await expect(editor.execute({ op: 'capture' } as never, signal)).rejects.toThrow(/acquire/)
    expect(capture).not.toHaveBeenCalled()

    holding = true
    await expect(editor.execute({ op: 'capture', window: 'SunGame' } as never, signal))
      .resolves.toEqual({ path: 'C:/state/evidence/ticket-1/x.png' })
    expect(capture).toHaveBeenCalledWith({ ticketId: 'ticket-1', window: 'SunGame', signal })
  })
})
