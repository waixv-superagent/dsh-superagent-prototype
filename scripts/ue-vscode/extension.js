/**
 * The VS Code side of `node scripts/ue-lldb.mjs capture --backend vscode`.
 *
 * A worker cannot drive `vsdbg` (the Visual Studio debug engine) from outside VS Code: the engine
 * refuses a session whose client is not Microsoft VS Code. Inside VS Code the C/C++ extension owns
 * that session, so this small development extension starts one `cppvsdbg` session from a job file,
 * waits for the breakpoint, captures threads/frames/variables and writes the result for the CLI.
 */
const fs = require('node:fs')
const vscode = require('vscode')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function activate() {
  const jobPath = process.env.UE_CAPTURE_JOB
  if (!jobPath) return
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8').replace(/^\uFEFF/, ''))
  const logPath = job.logPath ?? `${jobPath}.log`
  const log = message => {
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // Logging is diagnostic only.
    }
  }
  log('activated')
  let finished = false
  const finish = result => {
    if (finished) return
    finished = true
    log(`finish ${JSON.stringify(result).slice(0, 300)}`)
    try {
      fs.writeFileSync(job.output, `${JSON.stringify(result, null, 2)}\n`)
    } catch {
      // The waiting CLI reports the missing file itself.
    }
    setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 300)
  }

  const run = async () => {
    try {
      const breakpoints = (job.breakpoints ?? []).map(entry => new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(entry.file), new vscode.Position(entry.line - 1, 0))))
      vscode.debug.addBreakpoints(breakpoints)
      const configuration = job.program
        ? {
            type: 'cppvsdbg', request: 'launch', name: 'ue-capture',
            program: job.program, args: job.args ?? [], cwd: job.cwd,
            stopAtEntry: false, console: 'internalConsole',
            ...(job.visualizerFile ? { visualizerFile: job.visualizerFile } : {}),
          }
        : {
            type: 'cppvsdbg', request: 'attach', name: 'ue-capture', processId: job.pid,
            ...(job.visualizerFile ? { visualizerFile: job.visualizerFile } : {}),
          }
      const session = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the debug session did not start')), 60000)
        log(`starting ${configuration.request} session ${JSON.stringify(configuration).slice(0, 300)}`)
        const subscription = vscode.debug.onDidStartDebugSession(started => {
          clearTimeout(timer)
          subscription.dispose()
          log(`session started ${started.id} type=${started.type}`)
          resolve(started)
        })
        vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configuration).then(started => {
          log(`startDebugging resolved ${started}`)
          if (!started) {
            clearTimeout(timer)
            reject(new Error('VS Code refused to start the debug session'))
          }
        }, error => {
          clearTimeout(timer)
          log(`startDebugging rejected ${error}`)
          reject(error)
        })
      })
      const deadline = Date.now() + (job.timeoutMs ?? 120000)
      let loggedError = false
      while (Date.now() < deadline) {
        await sleep(500)
        let threads
        try {
          threads = await session.customRequest('threads')
        } catch (error) {
          if (!loggedError) { loggedError = true; log(`threads failed: ${error.message ?? error}`) }
          continue
        }
        for (const thread of threads.threads ?? []) {
          let stack
          try {
            stack = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: job.frames ?? 4 })
          } catch (error) {
            if (!loggedError) { loggedError = true; log(`stackTrace failed: ${error.message ?? error}`) }
            continue
          }
          if (!stack.stackFrames?.length) continue
          log(`stopped in thread ${thread.id}: ${stack.stackFrames[0].name} ${stack.stackFrames[0].source?.path ?? ''}:${stack.stackFrames[0].line ?? ''}`)
          // Variables are best-effort: a stop with unreadable scopes is still worth reporting.
          const variables = []
          try {
            const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id })
            for (const scope of scopes.scopes ?? []) {
              if (scope.expensive) continue
              const body = await session.customRequest('variables', { variablesReference: scope.variablesReference })
              for (const variable of (body.variables ?? []).slice(0, job.vars ?? 40)) {
                variables.push({ scope: scope.name, name: variable.name, type: variable.type, value: variable.value })
              }
            }
          } catch (error) {
            log(`variables failed: ${error.message ?? error}`)
          }
          finish({
            ok: true,
            stop: { threadId: thread.id, reason: 'breakpoint' },
            frames: stack.stackFrames.map((frame, index) => ({
              index, name: frame.name, file: frame.source?.path, line: frame.line,
            })),
            variables,
          })
          try {
            await session.customRequest('disconnect', { terminateDebuggee: Boolean(job.terminate) })
          } catch {
            // The window is quitting anyway; a failed disconnect leaves the target attached only if
            // VS Code itself does not detach, which this capture cannot observe from here.
          }
          return
        }
      }
      finish({ ok: false, error: 'no breakpoint stop before the timeout' })
    } catch (error) {
      log(`error ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  run()
}

exports.activate = activate
