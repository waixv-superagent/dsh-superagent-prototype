import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// Exercise the extension against a DAP-shaped VS Code mock. No editor or adapter is launched.
async function capture(event = 'stopped', reason = 'breakpoint', jobOverrides: Record<string, unknown> = {}) {
  const job = {
    pid: 1234, terminate: true, functions: ['UWorld::Tick'], breakpoints: [],
    frames: 2, scopes: 1, vars: 2, timeoutMs: 1000, output: 'capture.json', ...jobOverrides,
  }
  const requests: { command: string; args: any }[] = []
  const registered: any[] = []
  let trackerFactory: any
  let configured: any
  let result: any
  let stopped = false
  const session = {
    name: 'ue-capture',
    async customRequest(command: string, args: any) {
      requests.push({ command, args })
      if (command !== 'disconnect' && !stopped) throw new Error('Capture queried a running target')
      if (command === 'threads') return { threads: [{ id: 7, name: 'GameThread' }] }
      if (command === 'stackTrace') return { stackFrames: [{ id: 1, name: 'UWorld::Tick', source: { path: 'LevelTick.cpp' }, line: 1657 }] }
      if (command === 'scopes') return { scopes: [{ name: 'Locals', variablesReference: 1, expensive: false }] }
      if (command === 'variables') return { variables: [{ name: 'DeltaSeconds', value: '0.016', type: 'float', variablesReference: 0 }] }
      return {}
    },
  }
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: 'workspace' } }] },
    FunctionBreakpoint: class { constructor(public name: string) {} },
    debug: {
      addBreakpoints(breakpoints: any[]) { registered.push(...breakpoints) },
      registerDebugAdapterTrackerFactory(_type: string, factory: any) { trackerFactory = factory; return { dispose() {} } },
      async startDebugging(_folder: any, configuration: any) {
        configured = configuration
        const tracker = trackerFactory.createDebugAdapterTracker(session)
        tracker.onWillReceiveMessage({ type: 'request', seq: 1, command: 'setFunctionBreakpoints', arguments: { breakpoints: [{ name: 'UWorld::Tick' }] } })
        tracker.onDidSendMessage({ type: 'response', request_seq: 1, success: true, command: 'setFunctionBreakpoints', body: { breakpoints: [{ id: 9, verified: false, message: 'pending' }] } })
        tracker.onDidSendMessage({ type: 'event', event: 'breakpoint', body: { reason: 'changed', breakpoint: { id: 9, verified: true, line: 1657 } } })
        expect(requests).toEqual([])
        stopped = event === 'stopped'
        tracker.onDidSendMessage({ type: 'event', event, body: { reason, threadId: 7, hitBreakpointIds: [9] } })
        return true
      },
    },
    commands: { executeCommand() {} },
  }
  const extension = { exports: {} as { activate: (context: any) => Promise<void> } }
  runInNewContext(readFileSync(new URL('../scripts/ue-vscode/extension.js', import.meta.url), 'utf8'), {
    exports: extension.exports,
    process: { env: { UE_CAPTURE_JOB: 'job.json' } },
    setTimeout(callback: () => void, ms: number) {
      // The final quit is outside capture; do not open an idle timer for it.
      return ms === 300 ? undefined : setTimeout(callback, ms)
    },
    clearTimeout,
    require(name: string) {
      if (name === 'vscode') return vscode
      if (name === 'node:fs') return {
        readFileSync: () => JSON.stringify(job), appendFileSync() {},
        writeFileSync: (_path: string, contents: string) => { result = JSON.parse(contents) },
      }
      throw new Error(`Unexpected require: ${name}`)
    },
  })
  await extension.exports.activate({ subscriptions: [] })
  return { result, requests, configured, registered }
}

describe('VS Code capture protocol', () => {
  it('forwards function breakpoints and captures a queued DAP stop with actual binding and thread data', async () => {
    const { result, requests, configured, registered } = await capture()
    expect(registered[0].name).toBe('UWorld::Tick')
    expect(configured.processId).toBe('1234')
    expect(result.ok).toBe(true)
    expect(result.stop).toMatchObject({ reason: 'breakpoint', threadId: 7, hitBreakpointIds: [9] })
    expect(result.functionBreakpoints[0]).toMatchObject({ name: 'UWorld::Tick', verified: true, line: 1657 })
    expect(result.variables[0]).toMatchObject({ frame: 0, name: 'DeltaSeconds', value: '0.016' })
    expect(requests.at(-1)).toEqual({ command: 'disconnect', args: { terminateDebuggee: false } })
  })

  it('does not misreport an exception stack as a successful breakpoint', async () => {
    const { result } = await capture('stopped', 'exception')
    expect(result.ok).toBe(false)
    expect(result.stop.reason).toBe('exception')
    expect(result.frames[0].name).toBe('UWorld::Tick')
  })

  it('reports a target exit before the breakpoint and still disconnects', async () => {
    const { result, requests } = await capture('exited')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('target exited before a breakpoint')
    expect(requests.map(request => request.command)).toEqual(['disconnect'])
  })

  it('terminates only an explicitly owned launch', async () => {
    const { configured, requests } = await capture('stopped', 'breakpoint', { pid: undefined, program: 'UnrealEditor.exe' })
    expect(configured.request).toBe('launch')
    expect(configured.stopAtEntry).toBe(false)
    expect(requests.at(-1)?.args.terminateDebuggee).toBe(true)
  })
})
