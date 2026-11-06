/** Run a single cppvsdbg capture inside Microsoft VS Code, observing real DAP events. */
const fs = require('node:fs')
const vscode = require('vscode')

function deadline(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })]).finally(() => clearTimeout(timer))
}

function activate(context) {
  const jobPath = process.env.UE_CAPTURE_JOB
  if (!jobPath) return
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8').replace(/^\uFEFF/, ''))
  const log = message => fs.appendFileSync(job.logPath ?? `${jobPath}.log`, `${new Date().toISOString()} ${message}\n`)
  const trace = (direction, message) => {
    if (job.tracePath) fs.appendFileSync(job.tracePath, `${JSON.stringify({ time: new Date().toISOString(), direction, ...message })}\n`)
  }
  const configuration = {
    type: 'cppvsdbg', name: 'ue-capture',
    ...(job.pid ? { request: 'attach', processId: String(job.pid) } : {
      request: 'launch', program: job.program, args: job.args ?? [], cwd: job.cwd,
      stopAtEntry: false, console: 'internalConsole',
    }),
    ...(job.visualizerFile ? { visualizerFile: job.visualizerFile } : {}),
    ...job.configuration,
  }
  let session
  let acceptEvent
  const events = []
  const receive = event => {
    if (acceptEvent) { const accept = acceptEvent; acceptEvent = undefined; accept(event) }
    else events.push(event)
  }
  const nextEvent = () => events.length ? Promise.resolve(events.shift()) : new Promise(resolve => { acceptEvent = resolve })
  const breakpointResponses = []
  const breakpointChanges = []
  const breakpointRequests = new Map()
  const boundBreakpoints = new Map()
  let processInfo
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('cppvsdbg', {
    createDebugAdapterTracker(started) {
      if (started.name !== configuration.name) return
      session = started
      return {
        onWillReceiveMessage(message) {
          trace('client', message)
          if (['setBreakpoints', 'setFunctionBreakpoints'].includes(message.command)) breakpointRequests.set(message.seq, message)
        },
        onDidSendMessage(message) {
          trace('adapter', message)
          if (message.type === 'response' && ['setBreakpoints', 'setFunctionBreakpoints'].includes(message.command)) {
            breakpointResponses.push(message)
            const original = breakpointRequests.get(message.request_seq)
            for (const [index, breakpoint] of (message.body?.breakpoints ?? []).entries()) {
              boundBreakpoints.set(breakpoint.id, {
                ...(original?.command === 'setFunctionBreakpoints'
                  ? { name: original.arguments.breakpoints[index].name }
                  : { file: original?.arguments.source.path, requestedLine: original?.arguments.breakpoints[index].line }),
                ...breakpoint,
              })
            }
          }
          if (message.type !== 'event') return
          if (message.event === 'breakpoint') {
            breakpointChanges.push(message.body)
            const breakpoint = message.body.breakpoint
            boundBreakpoints.set(breakpoint.id, { ...boundBreakpoints.get(breakpoint.id), message: undefined, ...breakpoint })
          }
          if (message.event === 'process') processInfo = message.body
          if (['stopped', 'exited', 'terminated'].includes(message.event)) {
            log(`${message.event} ${JSON.stringify(message.body)}`)
            receive(message)
          }
        },
        onError(error) { log(`adapter error ${error.message}`); receive({ event: 'error', body: { error: error.message } }) },
        onExit(code, signal) { log(`adapter exit ${code} ${signal}`) },
      }
    },
  }))
  const request = (command, args) => deadline(session.customRequest(command, args), job.requestTimeoutMs ?? 30000, command)
  const run = async () => {
    let result
    try {
      log(`activated trusted=${vscode.workspace.isTrusted} folders=${JSON.stringify(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath))}`)
      const breakpoints = (job.breakpoints ?? []).map(entry => new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(entry.file), new vscode.Position(entry.line - 1, 0))))
      breakpoints.push(...(job.functions ?? []).map(name => new vscode.FunctionBreakpoint(name)))
      vscode.debug.addBreakpoints(breakpoints)
      log(`starting ${JSON.stringify(configuration)}`)
      if (!await deadline(vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configuration), job.timeoutMs ?? 120000, 'startDebugging')) {
        throw new Error('VS Code refused to start the debug session')
      }
      log('startDebugging resolved true')
      const event = await deadline(nextEvent(), job.timeoutMs ?? 120000, 'waiting for stopped')
      if (event.event !== 'stopped') throw new Error(`target ${event.event} before a breakpoint: ${JSON.stringify(event.body)}`)
      const stopped = event.body ?? {}
      const threads = (await request('threads')).threads ?? []
      const threadId = stopped.threadId ?? threads[0]?.id
      const stack = await request('stackTrace', { threadId, startFrame: 0, levels: job.frames ?? 3 })
      const variables = []
      const variableErrors = []
      for (const [frameIndex, frame] of (stack.stackFrames ?? []).entries()) {
        try {
          const scopes = (await request('scopes', { frameId: frame.id })).scopes ?? []
          for (const scope of scopes.filter(scope => !scope.expensive && scope.name !== 'Registers').slice(0, job.scopes ?? 3)) {
            const body = await request('variables', { variablesReference: scope.variablesReference })
            variables.push(...(body.variables ?? []).slice(0, job.vars ?? 40).map(variable => ({
              frame: frameIndex, scope: scope.name, name: variable.name, type: variable.type,
              value: variable.value, expandable: Boolean(variable.variablesReference),
            })))
          }
        } catch (error) { variableErrors.push({ frame: frameIndex, error: error.message }); log(`variables failed ${error.message}`) }
      }
      result = {
        ok: stopped.reason === 'breakpoint',
        ...(stopped.reason !== 'breakpoint' ? { error: `target stopped for ${stopped.reason}, not a requested breakpoint` } : {}),
        stop: stopped, process: processInfo, threads,
        frames: (stack.stackFrames ?? []).map((frame, index) => ({ index, name: frame.name, file: frame.source?.path, line: frame.line })),
        variables, variableErrors,
      }
    } catch (error) {
      log(`error ${error.stack ?? error}`)
      result = { ok: false, error: error.message }
    } finally {
      if (session) {
        try {
          await deadline(session.customRequest('disconnect', { terminateDebuggee: Boolean(job.terminate && !job.pid) }), 10000, 'disconnect')
          log('disconnect completed')
        } catch (error) { result.cleanupError = error.message; log(`disconnect failed ${error.message}`) }
      }
      result.configuration = configuration
      result.breakpointResponses = breakpointResponses
      result.breakpointChanges = breakpointChanges
      result.breakpoints = [...boundBreakpoints.values()].filter(breakpoint => !breakpoint.name)
      result.functionBreakpoints = [...boundBreakpoints.values()].filter(breakpoint => breakpoint.name)
      fs.writeFileSync(job.output, `${JSON.stringify(result, null, 2)}\n`)
      log(`finished ok=${result.ok}`)
      setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 300)
    }
  }
  return run()
}

exports.activate = activate
