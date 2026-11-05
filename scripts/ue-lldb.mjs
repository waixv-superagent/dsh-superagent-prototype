#!/usr/bin/env node
/**
 * UE C++ breakpoint capture through lldb-dap, without an IDE.
 *
 * The Unreal toolchain builds with clang-cl into CodeView PDBs, and the same LLVM that builds it
 * ships `lldb-dap.exe`. This script speaks DAP over stdio to that adapter: attach to a running
 * editor (or launch a program), set source and function breakpoints, wait for the process to stop,
 * and return the threads, stack frames and frame variables as JSON. It never resumes or kills a
 * process it attached to; a timeout detaches.
 *
 * Usage (see `--help`):
 *   node scripts/ue-lldb.mjs capture --pid <editor-pid> --break Source/Game.cpp:42 --json
 *   node scripts/ue-lldb.mjs capture --launch <program.exe> --break fixture.cpp:7 --json
 *
 * Exit codes: 0 stopped and captured, 1 usage, 2 environment missing, 3 debugger error,
 * 4 the target exited before a breakpoint, 5 timed out.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findEngineTool, findExecutable, runProcess, uePaths, withPath } from './ue-toolchain.mjs'
import { parseMessages } from './ue-wire.mjs'

const DEFAULT_TIMEOUT_SECONDS = 120
const REQUEST_TIMEOUT_MS = 30_000

/** Parses `<file>:<line>` for a source breakpoint. The rightmost colon separates the line. */
export function parseBreakpoint(text) {
  const match = /^(.*):(\d+)$/.exec(text)
  if (!match) throw new Error(`Expected <file>:<line> for --break, got "${text}"`)
  const line = Number(match[2])
  if (line < 1) throw new Error(`A breakpoint line starts at 1, got ${line}`)
  return { file: match[1], line }
}

/** Groups source breakpoints by file, the way DAP's `setBreakpoints` wants them. */
export function groupBreakpoints(breakpoints) {
  const files = new Map()
  for (const breakpoint of breakpoints) {
    const file = resolve(breakpoint.file)
    if (!files.has(file)) files.set(file, [])
    files.get(file).push(breakpoint.line)
  }
  return [...files.entries()].map(([file, lines]) => ({ file, lines: [...new Set(lines)].sort((a, b) => a - b) }))
}

/** Flattens DAP stack frames into rows, with Windows paths as the CLI uses them. */
export function normalizeFrames(frames) {
  return (frames ?? []).map((frame, index) => ({
    index,
    name: frame.name,
    file: frame.source?.path,
    line: frame.line,
    column: frame.column,
    module: frame.moduleId ?? undefined,
  }))
}

/** Flattens DAP variables into rows that name their frame and scope. */
export function normalizeVariables(frameIndex, scope, variables, limit) {
  return (variables ?? []).slice(0, limit).map(variable => ({
    frame: frameIndex,
    scope,
    name: variable.name,
    type: variable.type ?? undefined,
    value: variable.value,
    expandable: Boolean(variable.variablesReference),
  }))
}

/**
 * The commands a capture starts the debugger with. Inline breakpoints are always on: UE's own
 * formatter setup needs it for inlined game code.
 *
 * The engine's `UEDataFormatters.py` is deliberately not imported by default: on this installation
 * importing it aborts lldb-dap (0xC0000409, no stderr), so a caller opts in with `--formatters <file>`
 * after checking the formatter works with its LLDB build.
 */
export function initCommands(options = {}) {
  const commands = ['settings set target.inline-breakpoint-strategy always']
  if (options.formatters) commands.push(`command script import "${options.formatters.replaceAll('\\', '/')}"`)
  return commands
}

class DapClient {
  constructor(child) {
    this.child = child
    this.buffer = Buffer.alloc(0)
    this.seq = 1
    this.pending = new Map()
    this.events = []
    this.waiters = []
    this.stderr = ''
    this.output = ''
    this.closed = false
    child.stdout.on('data', chunk => this.receive(chunk))
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8000) })
    child.on('exit', (code, signal) => this.failAll(new Error(`lldb-dap exited (code=${code}, signal=${signal}): ${this.stderr.slice(-600)}`)))
  }

  receive(chunk) {
    try {
      const { messages, rest } = parseMessages(Buffer.concat([this.buffer, chunk]))
      this.buffer = rest
      for (const message of messages) this.dispatch(message)
    } catch (error) {
      this.failAll(error)
    }
  }

  dispatch(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq)
      if (!pending) return
      this.pending.delete(message.request_seq)
      if (!message.success) {
        const detail = this.output.trim()
        pending.reject(new Error(`${pending.command}: ${message.message ?? 'failed'}${detail ? ` (${detail.slice(-400)})` : ''}`))
      } else pending.resolve(message.body ?? {})
      return
    }
    if (message.type !== 'event') return
    // lldb-dap reports launch and breakpoint detail through output events, not the response message.
    if (message.event === 'output') this.output = (this.output + (message.body?.output ?? '')).slice(-4000)
    const waiter = this.waiters.find(item => item.events.includes(message.event))
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve(message)
      return
    }
    this.events.push(message)
  }

  send(message) {
    if (this.closed) throw new Error('the debug adapter is closed')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  request(command, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const seq = this.seq++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        rejectPromise(new Error(`lldb-dap did not answer ${command} within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(seq, {
        command,
        resolve: value => { clearTimeout(timer); resolvePromise(value) },
        reject: error => { clearTimeout(timer); rejectPromise(error) },
      })
      this.send({ seq, type: 'request', command, arguments: args })
    })
  }

  /** Waits for the next event among `events`, including one that arrived before the call. */
  waitAny(events, timeoutMs) {
    const index = this.events.findIndex(item => events.includes(item.event))
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0])
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { events, resolve: resolvePromise, reject: rejectPromise }
      this.waiters.push(waiter)
      setTimeout(() => {
        if (!this.waiters.includes(waiter)) return
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        rejectPromise(new Error(`lldb-dap sent no ${events.map(event => `"${event}"`).join(' or ')} event within `
          + `${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
    })
  }

  /** The next event called `event`. */
  waitEvent(event, timeoutMs) {
    return this.waitAny([event], timeoutMs)
  }

  /** The next `stopped` event, or the `exited` event when the target ends first. */
  waitForStop(timeoutMs) {
    return this.waitAny(['stopped', 'exited'], timeoutMs)
  }

  failAll(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const waiter of this.waiters.splice(0)) waiter.reject?.(error)
  }

  close() {
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {
      // The adapter may already have exited.
    }
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
    }, 1000).unref()
  }
}

/** The lldb-dap that belongs to the engine, so it matches the compiler that produced the PDBs. */
function resolveAdapter(paths) {
  return findEngineTool(paths.engine, 'lldb-dap.exe')
    ?? findExecutable('lldb-dap', { extra: [join('C:\\', 'Program Files', 'LLVM', 'bin')] })
}

/** The Python runtime liblldb is linked against; without it lldb-dap cannot start. */
function resolvePython(engine) {
  const candidates = [
    engine ? join(engine, 'Binaries', 'ThirdParty', 'Python3', 'Win64') : undefined,
    engine ? join(engine, 'Binaries', 'ThirdParty', 'Python3', 'WinArm64') : undefined,
  ].filter(candidate => candidate !== undefined)
  return candidates.find(candidate => existsSync(join(candidate, 'python311.dll')))
}

function requireAdapter(paths) {
  const adapter = resolveAdapter(paths)
  if (!adapter) throw Object.assign(new Error('no lldb-dap found; point --root at a UE workspace with its LLVM toolchain'), { exitCode: 2 })
  const python = resolvePython(paths.engine)
  if (!python) throw Object.assign(new Error(`no python311.dll under ${paths.engine}/Binaries/ThirdParty/Python3; lldb-dap cannot start`), { exitCode: 2 })
  return { adapter, env: withPath(process.env, [python, dirname(adapter)]) }
}

/** Captures the top frames of one stopped thread: names, locations and the variables of each frame. */
async function captureStop(dap, stopped, options) {
  const threadId = stopped.threadId
  const threads = (await dap.request('threads')).threads ?? []
  const stack = await dap.request('stackTrace', { threadId, startFrame: 0, levels: options.frames })
  const frames = normalizeFrames(stack.stackFrames)
  const variables = []
  for (const [frameIndex, frame] of (stack.stackFrames ?? []).entries()) {
    const scopes = (await dap.request('scopes', { frameId: frame.id })).scopes ?? []
    // Registers are a pseudo-scope of two empty rows; they matter for a crash, not for a source capture.
    for (const scope of scopes.filter(item => !item.expensive && item.name !== 'Registers').slice(0, options.scopes)) {
      const body = await dap.request('variables', { variablesReference: scope.variablesReference })
      variables.push(...normalizeVariables(frameIndex, scope.name, body.variables, options.vars))
    }
  }
  return { stopped, threadId, threads, frames, variables }
}

async function dapCapture(paths, options) {
  if (options.program && !existsSync(options.program)) {
    throw Object.assign(new Error(`no such program: ${options.program}`), { exitCode: 2 })
  }
  const { adapter, env } = requireAdapter(paths)
  if (options.print) {
    process.stdout.write(`${adapter}\n`)
    return 0
  }
  const commands = initCommands({ formatters: options.formatters })
  const child = spawn(adapter, [], { env, cwd: options.cwd ?? process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const dap = new DapClient(child)
  const result = { mode: options.pid ? 'attach' : 'launch', lldb: adapter, breakpoints: [], functionBreakpoints: [], stop: undefined, threads: [], frames: [], variables: [] }
  try {
    await dap.request('initialize', {
      adapterID: 'lldb',
      clientID: 'ue-lldb',
      clientName: 'ue-lldb',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
    })
    if (options.pid) {
      await dap.request('attach', { pid: options.pid, initCommands: commands }, options.launchTimeoutMs)
    } else {
      await dap.request('launch', {
        program: options.program,
        args: options.args,
        cwd: options.cwd,
        stopOnEntry: false,
        console: 'internalConsole',
        initCommands: commands,
      }, options.launchTimeoutMs)
    }
    // The adapter announces itself once the target exists and is stopped at its entry point.
    await dap.waitEvent('initialized', options.launchTimeoutMs)
    for (const group of groupBreakpoints(options.breakpoints)) {
      const body = await dap.request('setBreakpoints', {
        source: { path: group.file, name: group.file.split(/[\\/]/).pop() },
        breakpoints: group.lines.map(line => ({ line })),
        lines: group.lines,
        sourceModified: false,
      })
      const verified = body.breakpoints ?? []
      group.lines.forEach((line, index) => result.breakpoints.push({
        file: group.file, line, verified: Boolean(verified[index]?.verified), actualLine: verified[index]?.line ?? undefined,
        message: verified[index]?.message ?? undefined,
      }))
    }
    if (options.functions.length) {
      const body = await dap.request('setFunctionBreakpoints', { breakpoints: options.functions.map(name => ({ name })) })
      const verified = body.breakpoints ?? []
      options.functions.forEach((name, index) => result.functionBreakpoints.push({
        name, verified: Boolean(verified[index]?.verified), message: verified[index]?.message ?? undefined,
      }))
    }
    await dap.request('configurationDone', {})
    const event = await dap.waitForStop(options.timeoutMs)
    if (event.event === 'exited') {
      result.exited = { exitCode: event.body?.exitCode }
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else process.stderr.write(`[ue-lldb] the target exited (code=${event.body?.exitCode}) before reaching a breakpoint\n`)
      return 4
    }
    const captured = await captureStop(dap, event.body ?? {}, options)
    result.stop = { reason: captured.stopped.reason, threadId: captured.threadId, hitBreakpointIds: captured.stopped.hitBreakpointIds }
    result.threads = captured.threads
    result.frames = captured.frames
    result.variables = captured.variables
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else process.stdout.write(formatCapture(result))
    return 0
  } finally {
    try {
      await dap.request('disconnect', { terminateDebuggee: Boolean(options.terminate && !options.pid) }, 5000)
    } catch {
      // A target that already ended has nothing to detach.
    }
    dap.close()
  }
}

/** The short text form of a capture: where it stopped, the frames, and the top frame's variables. */
export function formatCapture(result) {  const stop = result.stop ?? {}
  const top = result.frames[0]
  const where = top ? `${top.file ?? '?'}:${top.line ?? '?'} in ${top.name}` : '(no frame)'
  const lines = [`stopped: ${stop.reason ?? 'unknown'} at ${where} (thread ${stop.threadId ?? '?'})`]
  for (const frame of result.frames) lines.push(`  #${frame.index} ${frame.name} at ${frame.file ?? '?'}:${frame.line ?? '?'}`)
  for (const variable of result.variables.filter(item => item.frame === 0)) {
    lines.push(`  ${variable.scope}: ${variable.name} = ${variable.value}${variable.type ? ` (${variable.type})` : ''}`)
  }
  if (result.breakpoints.some(breakpoint => !breakpoint.verified)) {
    lines.push('  note: some breakpoints are pending; they bind when the module loads')
  }
  return `${lines.join('\n')}\n`
}

/** Parses the text lldb prints for one attach / break / continue / bt / frame-variable run. */
export function parseCliCapture(text) {
  const breakpoints = []
  const frames = []
  const variables = []
  let stop
  let section = ''
  for (const line of String(text).split(/\r?\n/)) {
    const command = /^\(lldb\)\s+(.*)$/.exec(line)
    if (command) {
      section = command[1]
      continue
    }
    if (section.startsWith('breakpoint set')) {
      const created = /^Breakpoint \d+:\s*(.*)$/.exec(line.trim())
      if (!created) continue
      const detail = created[1]
      const location = /at (.+):(\d+)/.exec(detail)
      breakpoints.push({
        verified: !/no locations|pending/i.test(detail),
        detail: detail.slice(0, 200),
        file: location?.[1],
        line: location ? Number(location[2]) : undefined,
      })
      continue
    }
    if (section === 'process attach' || section === 'continue') {
      if (/^Process \d+ stopped$/.test(line.trim()) && !stop) stop = { reason: 'stopped' }
      const thread = /^\* thread #(\d+), stop reason = (.*)$/.exec(line.trim())
      if (thread) stop = { threadId: Number(thread[1]), reason: thread[2] }
      if (stop) {
        const located = /^\s+frame #0:.*? at (.+):(\d+)$/.exec(line)
        if (located) {
          stop.file = located[1]
          stop.line = Number(located[2])
        }
      }
      continue
    }
    if (section.startsWith('bt')) {
      const frame = /^\s*\*?\s*frame #(\d+):\s*0x[0-9a-f]+\s+(.*)$/i.exec(line)
      if (!frame) continue
      const detail = frame[2]
      const located = / at (.+):(\d+)$/.exec(detail)
      // lldb prints `Module.dll\`Symbol` before the location; a single backtick separates the two.
      const head = detail.split(' at ')[0]
      const symbol = head.includes('`') ? head.slice(head.indexOf('`') + 1) : head
      frames.push({ index: Number(frame[1]), name: symbol, file: located?.[1], line: located ? Number(located[2]) : undefined })
      continue
    }
    if (section === 'frame variable') {
      const variable = /^\s*\(([^)]+)\)\s+([A-Za-z_][\w:<>,\s*&]*?)\s+=\s*(.*)$/.exec(line)
      if (variable) {
        variables.push({ frame: 0, scope: 'Locals', name: variable[2].trim(), type: variable[1].trim(), value: variable[3].trim(), expandable: false })
      }
    }
  }
  return { breakpoints, functionBreakpoints: [], stop, threads: [], frames, variables }
}

/** The lldb CLI that belongs to the engine. */
function resolveLldb(paths) {
  return findEngineTool(paths.engine, 'lldb.exe') ?? findExecutable('lldb', { extra: [join('C:\\', 'Program Files', 'LLVM', 'bin')] })
}

/**
 * Captures through the `lldb` command line instead of lldb-dap. On this installation lldb-dap aborts
 * while attaching to the editor's PDB set while the CLI attaches; both share the same LLDB library,
 * so the difference is the adapter's symbol preloading.
 */
async function cliCapture(paths, options) {
  if (!options.pid) {
    throw Object.assign(new Error('the lldb CLI backend attaches to a running process; use --backend dap to launch a program'), { exitCode: 2 })
  }
  const lldb = resolveLldb(paths)
  if (!lldb) throw Object.assign(new Error('no lldb found; point --root at a UE workspace with its LLVM toolchain'), { exitCode: 2 })
  const python = resolvePython(paths.engine)
  if (!python) throw Object.assign(new Error(`no python311.dll under ${paths.engine}/Binaries/ThirdParty/Python3; lldb cannot start`), { exitCode: 2 })
  if (options.print) {
    process.stdout.write(`${lldb}\n`)
    return 0
  }
  const commands = [
    'settings set target.inline-breakpoint-strategy always',
    `process attach --pid ${options.pid}`,
    ...options.breakpoints.map(breakpoint => `breakpoint set --file "${breakpoint.file}" --line ${breakpoint.line}`),
    ...options.functions.map(name => `breakpoint set --name "${name}"`),
    'continue',
    `bt ${options.frames}`,
    'frame variable',
    'detach',
    'quit',
  ]
  // `-o` commands stop being consumed after a stop on this LLDB build; a sourced script runs them all.
  const directory = mkdtempSync(join(tmpdir(), 'ue-lldb-'))
  const script = join(directory, 'capture.lldb')
  writeFileSync(script, `${commands.join('\n')}\n`)
  try {
    const result = await runProcess(lldb, ['-b', '-s', script], {
      env: withPath(process.env, [python, dirname(lldb)]),
      timeoutMs: options.timeoutMs,
    })
    if (result.timedOut) {
      throw Object.assign(new Error(`lldb did not reach a breakpoint within ${Math.round(options.timeoutMs / 1000)}s`), { exitCode: 5 })
    }
    const parsed = parseCliCapture(result.output)
    if (!parsed.stop) {
      process.stderr.write(`${result.output.slice(-1500)}\n`)
      throw Object.assign(new Error(`lldb attached but reported no stop (exit ${result.code})`), { exitCode: 4 })
    }
    const capture = { backend: 'cli', mode: 'attach', lldb, ...parsed }
    if (options.json) process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`)
    else process.stdout.write(formatCapture(capture))
    return 0
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Runs the capture through lldb-dap, falling back to the lldb CLI when the adapter cannot attach. */
async function capture(paths, options) {
  if (options.backend === 'cli') return cliCapture(paths, options)
  if (options.backend === 'dap') return dapCapture(paths, options)
  try {
    return await dapCapture(paths, options)
  } catch (error) {
    if (!options.pid) throw error
    process.stderr.write(`[ue-lldb] lldb-dap failed (${error instanceof Error ? error.message : String(error)}); retrying with the lldb CLI\n`)
    return cliCapture(paths, options)
  }
}

/** Parses the CLI; refuses a terminate request against an existing process. */
export function parseArgs(argv) {
  const args = argv[0] === 'capture' ? argv.slice(1) : argv
  const options = {
    args: [], breakpoints: [], functions: [], frames: 3, vars: 40, scopes: 3, backend: 'auto',
    timeout: DEFAULT_TIMEOUT_SECONDS, json: false, print: false, terminate: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument "${argument}"`)
    const name = argument.slice(2)
    const value = () => {
      const next = args[index + 1]
      if (next === undefined) throw new Error(`--${name} needs a value`)
      index += 1
      return next
    }
    switch (name) {
      case 'help': options.help = true; break
      case 'json': options.json = true; break
      case 'print': options.print = true; break
      case 'terminate': options.terminate = true; break
      case 'pid': options.pid = Number(value()); break
      case 'launch': options.program = resolve(value()); break
      case 'arg': options.args.push(value()); break
      case 'cwd': options.cwd = resolve(value()); break
      case 'break': options.breakpoints.push(parseBreakpoint(value())); break
      case 'break-func': options.functions.push(value()); break
      case 'backend': options.backend = value(); break
      case 'formatters': options.formatters = resolve(value()); break
      case 'root': options.root = value(); break
      case 'project': options.project = value(); break
      case 'frames': options.frames = Number(value()); break
      case 'vars': options.vars = Number(value()); break
      case 'scopes': options.scopes = Number(value()); break
      case 'timeout': options.timeout = Number(value()); break
      default: throw new Error(`unknown option --${name}`)
    }
  }
  if (options.pid !== undefined && !Number.isInteger(options.pid)) throw new Error('--pid must be an integer')
  if (options.pid !== undefined && (options.pid <= 0 || options.pid === process.pid || options.pid === process.ppid)) {
    throw new Error(`refusing to attach to pid ${options.pid}`)
  }
  if (options.terminate && !options.program) throw new Error('--terminate only applies to --launch; an attached editor is never killed')
  if (!['auto', 'dap', 'cli'].includes(options.backend)) throw new Error('--backend must be auto, dap or cli')
  if (!options.pid && !options.program) throw new Error('one of --pid or --launch is required')
  if (options.pid && options.program) throw new Error('--pid and --launch are exclusive')
  if (!options.breakpoints.length && !options.functions.length) throw new Error('at least one --break or --break-func is required')
  options.timeoutMs = options.timeout * 1000
  options.requestTimeoutMs = Math.min(REQUEST_TIMEOUT_MS, options.timeoutMs)
  // Launching or attaching loads the debug info first: the DebugGame editor took over a minute for
  // the engine target alone, so quick commands keep their short timeout and the setup gets its own.
  options.launchTimeoutMs = Math.min(300_000, options.timeoutMs)
  return options
}

const USAGE = `Usage: node scripts/ue-lldb.mjs capture (--pid <pid> | --launch <program>) [options]

Options
  --break <file>:<line>   Source breakpoint; may be repeated
  --break-func <name>     Function breakpoint; may be repeated
  --arg <value>           Argument for --launch; may be repeated
  --cwd <dir>             Working directory for a launched program
  --timeout <seconds>     How long to wait for a breakpoint (default: ${DEFAULT_TIMEOUT_SECONDS})
  --frames <count>        Stack frames to capture (default: 3)
  --scopes <count>        Non-expensive scopes per frame (default: 3)
  --vars <count>          Variables per scope (default: 40)
  --formatters <file>     Import an LLDB Python formatter script (off by default; the engine's
                          UEDataFormatters.py aborts this lldb-dap build)
  --backend <mode>        auto (default), dap or cli; auto retries an attach with the lldb CLI when
                          lldb-dap cannot attach (the mode this installation's editor needs)
  --terminate             Let a launched program exit with the capture; an attached editor is never killed
  --json                  Print JSON instead of text
  --print                 Print the resolved lldb-dap and exit
  --root <dir>            UE workspace root (default: $DSH_SUPERAGENT_UE_ROOT or E:\\\\workspace)
  --project <name>        Project name, directory or .uproject (default: $DSH_SUPERAGENT_UE_PROJECT or Game)
`

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    return 1
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  const paths = uePaths({ root: options.root, project: options.project })
  try {
    return await capture(paths, options)
  } catch (error) {
    process.stderr.write(`[ue-lldb] ${error instanceof Error ? error.message : String(error)}\n`)
    return error?.exitCode ?? 3
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('scripts/ue-lldb.mjs')
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`[ue-lldb] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(3)
  })
}
