#!/usr/bin/env node
/**
 * UE C++ code intelligence through clangd, without an IDE.
 *
 * The compile database comes from UnrealBuildTool's own `GenerateClangDatabase` mode, so the flags
 * clangd sees are the flags the build uses: clang-cl, UHT generated includes, third-party `imsvc`
 * paths and `Definitions.h`. clangd then answers symbol, definition, reference, hover and diagnostic
 * questions over its LSP, against a disk index that survives between commands.
 *
 * Usage (all commands take `--root` and `--project`; see `--help`):
 *   node scripts/ue-clangd.mjs status [--json]
 *   node scripts/ue-clangd.mjs index [--target SunEditor] [--configuration Development] [--print]
 *   node scripts/ue-clangd.mjs symbol <query> [--limit 20]
 *   node scripts/ue-clangd.mjs definition <file>:<line>:<column>
 *   node scripts/ue-clangd.mjs references <file>:<line>:<column>
 *   node scripts/ue-clangd.mjs hover <file>:<line>:<column>
 *   node scripts/ue-clangd.mjs diagnostics <file>
 *
 * Exit codes: 0 ok, 1 usage, 2 environment missing, 3 clangd query failed or timed out,
 * 4 compile database missing (run `index`), 5 index command failed.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  engineVersion, findEngineTool, findExecutable, quoteArg, runProcess, uePaths,
} from './ue-toolchain.mjs'
import { parseMessages } from './ue-wire.mjs'

const MANIFEST = 'ue-clangd.json'
const DATABASE = 'compile_commands.json'
const DEFAULT_LIMIT = 20

/** LSP SymbolKind numbers, in the order the protocol defines them. */
export const SYMBOL_KINDS = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
  'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
  'object', 'key', 'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter',
]

/** LSP DiagnosticSeverity numbers. */
export const SEVERITIES = ['error', 'warning', 'information', 'hint']

/** `file:///E:/...` for a local path; clangd only speaks URIs. */
export function pathToUri(file) {
  const absolute = resolve(file).replaceAll('\\', '/')
  const prefix = absolute.startsWith('/') ? 'file://' : 'file:///'
  return `${prefix}${absolute.split('/').map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment))).join('/')}`
}

/** The local path a `file://` URI names, with Windows' leading slash removed. */
export function uriToPath(uri) {
  const url = new URL(uri)
  let path = decodeURIComponent(url.pathname)
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path.replaceAll('/', '\\')
}

/** `C:/work/Game/Source/Game.cpp:12:3` from the CLI. The rightmost two colons are the position. */
export function parsePosition(text) {
  const match = /^(.*):(\d+):(\d+)$/.exec(text)
  if (!match) throw new Error(`Expected <file>:<line>:<column>, got "${text}"`)
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) }
}

/** The clangd symbol kind name, or `unknown`. */
export function kindName(kind) {
  return SYMBOL_KINDS[(kind ?? 0) - 1] ?? 'unknown'
}

/** The diagnostics severity name, or `unknown`. */
export function severityName(severity) {
  return SEVERITIES[(severity ?? 0) - 1] ?? 'unknown'
}

/** The location a symbol came from, flattened for a CLI. */
function locationOf(location) {
  if (!location) return undefined
  const target = location.targetUri ?? location.uri
  const range = location.targetRange ?? location.range
  if (!target || !range) return undefined
  return { file: uriToPath(target), line: range.start.line + 1, column: range.start.character + 1 }
}

/** Normalizes the two symbol shapes LSP may return into one row per symbol. */
export function normalizeSymbols(result, limit = DEFAULT_LIMIT) {
  if (!Array.isArray(result)) return []
  return result.slice(0, limit).map(symbol => ({
    name: symbol.name,
    kind: kindName(symbol.kind),
    container: symbol.containerName ?? undefined,
    ...locationOf(symbol.location),
  }))
}

/** Normalizes definition results (`Location`, `Location[]` or `LocationLink[]`). */
export function normalizeLocations(result) {
  if (!result) return []
  const entries = Array.isArray(result) ? result : [result]
  return entries.map(locationOf).filter(Boolean)
}

/** The text of an LSP hover, flattened. */
export function hoverText(result) {
  if (!result) return ''
  const contents = result.contents
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(part => (typeof part === 'string' ? part : part.value ?? '')).join('\n')
  return contents.value ?? ''
}

/** The diagnostic rows a CLI prints, with the absolute path of the file they belong to. */
export function normalizeDiagnostics(uri, diagnostics) {
  const file = uriToPath(uri)
  return (diagnostics ?? []).map(diagnostic => ({
    file,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity: severityName(diagnostic.severity),
    message: diagnostic.message,
    code: diagnostic.code ?? undefined,
  }))
}

/**
 * The reasons a compile database should be regenerated, each one concrete. Staleness is judged by
 * the engine build the database recorded, not by file times: a p4 sync rewrites every file's time.
 */
export function staleness({ databaseExists, manifest, engineNow, compilerExists, ageDays }) {
  const reasons = []
  if (!databaseExists) return ['compile database is missing; run `index`']
  if (!manifest) reasons.push('compile database has no `ue-clangd.json` manifest; run `index` to record its engine and target')
  else {
    const recorded = manifest.engine
    if (engineNow && recorded && (recorded.buildId !== engineNow.buildId || recorded.major !== engineNow.major
      || recorded.minor !== engineNow.minor || recorded.patch !== engineNow.patch)) {
      reasons.push(`engine changed from ${recorded.major}.${recorded.minor}.${recorded.patch} (${recorded.buildId}) to `
        + `${engineNow.major}.${engineNow.minor}.${engineNow.patch} (${engineNow.buildId})`)
    }
    if (compilerExists === false) reasons.push(`the compiler the database names is gone: ${manifest.compiler}`)
    if (typeof ageDays === 'number' && ageDays > 14) reasons.push(`compile database is ${Math.round(ageDays)} days old`)
  }
  return reasons
}

/** The UBT arguments that produce a clang database for one target. Exported for the tests. */
export function generateArguments({ uproject, target, configuration, outputDir, includes = [], noCodegen = false }) {
  const args = [
    '-Mode=GenerateClangDatabase',
    target,
    'Win64',
    configuration,
    `-Project=${uproject}`,
    `-OutputDir=${outputDir}`,
    `-OutputFilename=${DATABASE}`,
  ]
  if (noCodegen) args.push('-NoExecCodeGenActions')
  for (const include of includes) args.push(`-Include=${include}`)
  return args
}

/** The database path of a workspace, under the project's Saved directory so it never enters source control. */
export function databaseDirectory(paths) {
  return join(paths.project, 'Saved', 'AgentClangd')
}

/** The index cache directory of a workspace, shared by clangd sessions this tool starts. */
export function indexCacheDirectory(paths) {
  return join(paths.project, '.cache', 'clangd', 'index')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function readManifest(directory) {
  return readJson(join(directory, MANIFEST))
}

function entryCount(database) {
  try {
    const parsed = JSON.parse(readFileSync(database, 'utf8'))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/**
 * The first translation unit of the project in the compile database. clangd's background index
 * starts from an open file; opening one project source is what queues the rest of the database.
 */
export function firstProjectSource(database, project) {
  try {
    const entries = JSON.parse(readFileSync(database, 'utf8'))
    if (!Array.isArray(entries)) return undefined
    const root = resolve(project).toLowerCase()
    const found = entries.find(entry => typeof entry?.file === 'string'
      && resolve(entry.file).toLowerCase().startsWith(root)
      && /\.(?:cpp|cc|cxx)$/i.test(entry.file))
    return found?.file
  } catch {
    return undefined
  }
}

/** Recursively counts and, when asked, sums the files under `directory`. */
function directoryStats(directory, deep = false) {
  if (!existsSync(directory)) return { exists: false, files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name))
      else {
        files += 1
        if (deep) bytes += statSync(join(current, entry.name)).size
      }
    }
  }
  walk(directory)
  return { exists: true, files, bytes }
}

/** The clangd in the engine's LLVM, then on `PATH`, then the stock LLVM install. */
function resolveClangd(paths) {
  return findEngineTool(paths.engine, 'clangd.exe')
    ?? findExecutable('clangd', { extra: [join('C:\\', 'Program Files', 'LLVM', 'bin')] })
}

/** The clang-cl the engine builds with; passed to clangd so it can query the system headers. */
function resolveDriver(paths) {
  return findEngineTool(paths.engine, 'clang-cl.exe')
}

class ClangdSession {
  constructor(child, root) {
    this.child = child
    this.root = root
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.diagnostics = []
    this.diagnosticWaiters = []
    this.closed = false
    this.stderr = ''
    child.stdout.on('data', chunk => this.receive(chunk))
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000) })
    child.on('exit', (code, signal) => this.failAll(new Error(`clangd exited (code=${code}, signal=${signal}): ${this.stderr.slice(-400)}`)))
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
    // clangd asks the client to register capabilities or create progress tokens; answering with a
    // null result keeps it from waiting, and nothing here depends on the answer.
    if (message.id !== undefined && message.method !== undefined) {
      this.send({ jsonrpc: '2.0', id: message.id, result: null })
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      this.diagnostics.push(message.params)
      for (const waiter of [...this.diagnosticWaiters]) {
        if (waiter.uri === message.params.uri) {
          this.diagnosticWaiters.splice(this.diagnosticWaiters.indexOf(waiter), 1)
          waiter.resolve(message.params)
        }
      }
    }
  }

  send(message) {
    if (this.closed) throw new Error('clangd session is closed')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`clangd did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolvePromise(value) },
        reject: error => { clearTimeout(timer); rejectPromise(error) },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async initialize(timeoutMs) {
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'ue-clangd', version: '1' },
      rootUri: pathToUri(this.root),
      capabilities: {
        workspace: { symbol: {} },
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
      },
      workspaceFolders: [{ uri: pathToUri(this.root), name: basename(this.root) }],
    }, timeoutMs)
    this.notify('initialized', {})
  }

  /** Opens a file and returns its text; clangd only answers about open or indexed files. */
  open(file) {
    const text = readFileSync(file, 'utf8')
    const uri = pathToUri(file)
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text } })
    return { uri, text }
  }

  /** Waits for the first diagnostics publication for `uri`, including one that already arrived. */
  awaitDiagnostics(uri, timeoutMs) {
    const index = this.diagnostics.findIndex(publication => publication.uri === uri)
    if (index >= 0) return Promise.resolve(this.diagnostics.splice(index, 1)[0])
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { uri, resolve: resolvePromise }
      this.diagnosticWaiters.push(waiter)
      setTimeout(() => {
        if (!this.diagnosticWaiters.includes(waiter)) return
        this.diagnosticWaiters.splice(this.diagnosticWaiters.indexOf(waiter), 1)
        rejectPromise(new Error(`clangd sent no diagnostics for ${uriToPath(uri)} within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
    })
  }

  failAll(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  async close() {
    if (this.closed) return
    try {
      this.notify('shutdown', undefined)
    } catch {
      // A clangd that already exited has nothing left to shut down.
    }
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {
      // Same: the pipe may already be gone.
    }
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
    }, 1000).unref()
  }
}

/** Starts clangd for one query and initializes it against the workspace. */
async function startSession(paths, clangd, database, options) {
  const env = { ...process.env }
  // clangd keeps its index under the platform cache directory (`%LOCALAPPDATA%/clangd/index` on
  // Windows, `$XDG_CACHE_HOME/clangd/index` elsewhere). Overriding both puts shards beside the
  // project, so they survive between commands and `status` can count them.
  if (options.cacheDir) {
    env.XDG_CACHE_HOME = join(paths.project, '.cache')
    env.LOCALAPPDATA = join(paths.project, '.cache')
  }
  const driver = resolveDriver(paths)
  const args = [
    `--compile-commands-dir=${database}`,
    `--background-index=${options.backgroundIndex ? 'true' : 'false'}`,
    '--background-index-priority=background',
    '--pch-storage=memory',
    '--log=error',
  ]
  if (driver) args.push(`--query-driver=${driver}`)
  const child = spawn(clangd, args, { cwd: paths.project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const session = new ClangdSession(child, paths.project)
  await session.initialize(options.timeoutMs)
  return session
}

/** Fails with the exit code the CLI documents for a missing database, before starting a server. */
function requireDatabase(paths, allowMissing = false) {
  const directory = databaseDirectory(paths)
  const database = join(directory, DATABASE)
  if (!existsSync(database) && !allowMissing) {
    throw Object.assign(new Error(`no compile database at ${database}; run \`node scripts/ue-clangd.mjs index\` first`), { exitCode: 4 })
  }
  return { directory, database }
}

async function statusCommand(paths, options) {
  const { directory, database } = requireDatabase(paths, true)
  const manifest = readManifest(directory)
  const exists = existsSync(database)
  const ageDays = exists ? (Date.now() - statSync(database).mtimeMs) / 86_400_000 : undefined
  const compiler = manifest?.compiler
  const cache = directoryStats(indexCacheDirectory(paths), options.deep)
  const clangd = resolveClangd(paths)
  const engineNow = engineVersion(paths.engine)
  const current = engineNow ? {
    major: engineNow.MajorVersion, minor: engineNow.MinorVersion, patch: engineNow.PatchVersion, buildId: engineNow.BuildId,
  } : undefined
  const result = {
    workspace: paths.workspace,
    project: paths.project,
    uproject: paths.uproject,
    engine: {
      root: paths.engine,
      version: engineNow ? `${engineNow.MajorVersion}.${engineNow.MinorVersion}.${engineNow.PatchVersion}` : undefined,
      buildId: engineNow?.BuildId,
    },
    clangd,
    database: { path: database, exists, ageDays: ageDays === undefined ? undefined : Number(ageDays.toFixed(1)),
      entries: exists ? entryCount(database) : 0, target: manifest?.target, configuration: manifest?.configuration,
      generatedAt: manifest?.generatedAt },
    indexCache: { path: indexCacheDirectory(paths), ...cache },
    stale: staleness({ databaseExists: exists, manifest, engineNow: current, compilerExists: compiler ? existsSync(compiler) : undefined, ageDays }),
  }
  if (options.json) return result
  const lines = [
    `workspace  ${result.workspace}`,
    `project    ${result.project}`,
    `engine     ${result.engine.version ?? '(unknown)'} ${result.engine.buildId ?? ''} at ${result.engine.root}`,
    `clangd     ${result.clangd ?? '(not found)'}`,
    result.database.exists
      ? `database   ${result.database.entries} entries, ${result.database.ageDays} days old, ${result.database.target ?? '(no manifest)'} ${result.database.configuration ?? ''}`
      : 'database   missing',
    `index      ${result.indexCache.files} shard files${options.deep ? `, ${(result.indexCache.bytes / 1e6).toFixed(0)} MB` : ''} at ${result.indexCache.path}`,
    result.stale.length ? `stale      ${result.stale.join('; ')}` : 'stale      no',
  ]
  return lines.join('\n')
}

async function indexCommand(paths, options) {
  if (!existsSync(join(paths.engine, 'Build', 'BatchFiles', 'RunUBT.bat'))) {
    throw Object.assign(new Error(`no UnrealBuildTool at ${paths.engine}/Build/BatchFiles/RunUBT.bat; pass --root/--project`), { exitCode: 2 })
  }
  if (!paths.uproject || !existsSync(paths.uproject)) {
    throw Object.assign(new Error(`no .uproject in ${paths.project}; pass --project`), { exitCode: 2 })
  }
  const directory = databaseDirectory(paths)
  mkdirSync(directory, { recursive: true })
  const clangd = resolveClangd(paths)
  const compiler = resolveDriver(paths)
  const ubt = join(paths.engine, 'Build', 'BatchFiles', 'RunUBT.bat')
  const args = generateArguments({
    uproject: paths.uproject,
    target: options.target,
    configuration: options.configuration,
    outputDir: directory,
    includes: options.include,
    noCodegen: options.noCodegen,
  })
  const line = ['call', ubt, ...args].map(quoteArg).join(' ')
  if (options.print) {
    process.stdout.write(`${line}\n`)
    return 0
  }
  process.stderr.write(`[ue-clangd] ${line}\n`)
  const started = Date.now()
  const result = await runProcess('cmd.exe', ['/d', '/s', '/c', line], {
    cwd: paths.project,
    timeoutMs: options.timeoutMs,
    // cmd.exe must receive the quoted command line as written; letting Node re-quote the arguments
    // turns the first path into \"E:\...\" and cmd refuses it.
    verbatim: true,
    // UBT prints a lot; keep the operator's terminal alive without buffering the whole log twice.
    onOutput: text => process.stdout.write(text),
  })
  if (result.timedOut) {
    process.stderr.write(`\n[ue-clangd] UBT did not finish within ${Math.round(options.timeoutMs / 1000)}s\n`)
    return 5
  }
  if (result.code !== 0) {
    process.stderr.write(`\n[ue-clangd] UBT failed with exit code ${result.code}\n`)
    return 5
  }
  const database = join(directory, DATABASE)
  if (!existsSync(database)) {
    process.stderr.write(`[ue-clangd] UBT reported success but wrote no database at ${database}\n`)
    return 5
  }
  const entries = entryCount(database)
  const engine = engineVersion(paths.engine)
  const manifest = {
    tool: 'ue-clangd',
    version: 1,
    generatedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    engine: engine ? {
      major: engine.MajorVersion, minor: engine.MinorVersion, patch: engine.PatchVersion, buildId: engine.BuildId,
    } : undefined,
    compiler,
    clangd,
    uproject: paths.uproject,
    target: options.target,
    configuration: options.configuration,
    platform: 'Win64',
    entries,
  }
  writeFileSync(join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`[ue-clangd] ${entries} compile commands in ${database}\n`)
  return 0
}

/** Waits, so a bounded index warm-up does not spin. */
const sleep = timeoutMs => new Promise(resolvePromise => setTimeout(resolvePromise, timeoutMs))

/**
 * Runs clangd with its background index for a bounded time and lets it flush. A symbol search is the
 * only command that needs the index; definition, references and diagnostics answer from the open file.
 */
async function warmCommand(paths, options) {
  const clangd = resolveClangd(paths)
  if (!clangd) throw Object.assign(new Error('no clangd found; install LLVM or point --root at a UE workspace with its LLVM'), { exitCode: 2 })
  const { database } = requireDatabase(paths)
  const before = directoryStats(indexCacheDirectory(paths)).files
  const session = await startSession(paths, clangd, dirname(database), {
    cacheDir: true, backgroundIndex: true, timeoutMs: options.timeoutMs,
  })
  const started = Date.now()
  try {
    // clangd's background index starts with a translation unit; opening one project source is what
    // queues the database's remaining commands for indexing.
    const sample = firstProjectSource(database, paths.project)
    if (sample) session.open(sample)
    while (Date.now() - started < options.minutes * 60_000) await sleep(5000)
    await session.request('shutdown', undefined, 10_000)
    session.notify('exit', undefined)
  } catch {
    // An indexing clangd may ignore shutdown; the kill below still ends it.
  } finally {
    try {
      await Promise.race([
        new Promise(resolvePromise => session.child.once('exit', resolvePromise)),
        sleep(30_000),
      ])
    } finally {
      session.closed = true
      try {
        session.child.kill()
      } catch {
        // Already gone.
      }
    }
  }
  const after = directoryStats(indexCacheDirectory(paths)).files
  const result = {
    clangd, minutes: options.minutes, seconds: Math.round((Date.now() - started) / 1000),
    shardsBefore: before, shardsAfter: after, indexCache: indexCacheDirectory(paths),
  }
  return options.json ? result : `warmed ${result.seconds}s: index shards ${before} -> ${after} in ${result.indexCache}`
}

async function withSession(paths, options, run) {
  const clangd = resolveClangd(paths)
  if (!clangd) throw Object.assign(new Error('no clangd found; install LLVM or point --root at a UE workspace with its LLVM'), { exitCode: 2 })
  const { database } = requireDatabase(paths)
  const session = await startSession(paths, clangd, dirname(database), {
    cacheDir: true, backgroundIndex: options.backgroundIndex, timeoutMs: options.timeoutMs,
  })
  try {
    return await run(session)
  } finally {
    await session.close()
  }
}

async function symbolCommand(paths, query, options) {
  return withSession(paths, options, async session => {
    const result = await session.request('workspace/symbol', { query }, options.timeoutMs)
    const symbols = normalizeSymbols(result, options.limit)
    if (!options.json) return symbols
    const shards = directoryStats(indexCacheDirectory(paths)).files
    return {
      query, symbols, indexShards: shards,
      // workspace/symbol reads the disk index; without shards only the open file could answer.
      hint: symbols.length === 0 && shards === 0 ? 'no index shards yet; run `node scripts/ue-clangd.mjs warm` first' : undefined,
    }
  })
}

async function positionCommand(paths, method, position, options) {
  const file = resolve(position.file)
  if (!existsSync(file)) throw Object.assign(new Error(`no such file: ${file}`), { exitCode: 2 })
  return withSession(paths, options, async session => {
    const { uri } = session.open(file)
    const params = {
      textDocument: { uri },
      position: { line: position.line - 1, character: position.column - 1 },
      context: { includeDeclaration: true },
    }
    if (method === 'textDocument/hover') {
      const result = await session.request(method, { textDocument: { uri }, position: params.position }, options.timeoutMs)
      const text = hoverText(result)
      return options.json ? { file, line: position.line, column: position.column, text } : text
    }
    const result = await session.request(method, params, options.timeoutMs)
    const locations = normalizeLocations(result)
    if (options.json) return { file, line: position.line, column: position.column, locations }
    return locations.map(location => `${location.file}:${location.line}:${location.column}`).join('\n')
  })
}

async function diagnosticsCommand(paths, target, options) {
  const file = resolve(target)
  if (!existsSync(file)) throw Object.assign(new Error(`no such file: ${file}`), { exitCode: 2 })
  return withSession(paths, options, async session => {
    const { uri } = session.open(file)
    const publication = await session.awaitDiagnostics(uri, options.timeoutMs)
    const diagnostics = normalizeDiagnostics(uri, publication.diagnostics)
    if (options.json) return { file, diagnostics }
    if (!diagnostics.length) return `${file}: no diagnostics`
    return diagnostics.map(diagnostic => `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: `
      + `${diagnostic.severity}: ${diagnostic.message}${diagnostic.code === undefined ? '' : ` [${diagnostic.code}]`}`).join('\n')
  })
}

const USAGE = `Usage: node scripts/ue-clangd.mjs <command> [options]

Commands
  status                          Compile database, engine, clangd and index cache state
  index                           Generate compile_commands.json with UnrealBuildTool
  warm                            Build the clangd index in the background for a bounded time
  symbol <query>                  Search symbols in the clangd index
  definition <file>:<line>:<col>  Where a symbol is defined
  references <file>:<line>:<col>  Where a symbol is referenced
  hover <file>:<line>:<col>       Type and documentation of a symbol
  diagnostics <file>              Diagnostics for one file

Options
  --root <dir>          UE workspace root (default: $DSH_SUPERAGENT_UE_ROOT or E:\\workspace)
  --project <name>      Project name under Development/Project, a directory, or a .uproject
                        (default: $DSH_SUPERAGENT_UE_PROJECT or Game)
  --json                Print JSON instead of text
  --timeout <seconds>   Per-request timeout (default: 120)
  --limit <count>       Symbol results to print (default: ${DEFAULT_LIMIT})
  --target <name>       Target for \`index\` (default: SunEditor)
  --configuration <c>   Configuration for \`index\` (default: Development)
  --include <glob>      Source path filter for \`index\`; may be repeated
  --minutes <count>     Minutes for \`warm\` to build the background index (default: 10)
  --no-codegen          Skip UHT/codegen actions while building the database
  --print               Print the UBT command instead of running it
  --deep                Sum the index cache size in \`status\`
  --no-background-index  Answer from open files only (fast, but no workspace symbols)
`

/** Parses `--name value` and `--flag` arguments plus positionals, refusing unknown options. */
export function parseArgs(argv) {
  const options = { target: 'SunEditor', configuration: 'Development', timeout: 120, limit: DEFAULT_LIMIT, minutes: 10, include: [] }
  const flags = new Set(['json', 'deep', 'print', 'no-codegen', 'no-background-index', 'help'])
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (name === 'include') {
      options.include.push(argv[index + 1] ?? '')
      index += 1
    } else if (flags.has(name)) {
      options[name] = true
    } else if (['root', 'project', 'timeout', 'limit', 'target', 'configuration', 'minutes'].includes(name)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`--${name} needs a value`)
      options[name] = value
      index += 1
    } else {
      throw new Error(`unknown option --${name}`)
    }
  }
  options.timeoutMs = Number(options.timeout) * 1000
  options.limit = Number(options.limit)
  options.minutes = Number(options.minutes)
  options.backgroundIndex = !options['no-background-index']
  options.noCodegen = options['no-codegen']
  options.print = Boolean(options.print)
  return { options, positional }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    return 1
  }
  const { options, positional } = parsed
  if (options.help || positional.length === 0) {
    process.stdout.write(USAGE)
    return options.help ? 0 : 1
  }
  const command = positional[0]
  const rest = positional.slice(1)
  const paths = uePaths({ root: options.root, project: options.project })
  try {
    if (command === 'status') return print(await statusCommand(paths, options))
    if (command === 'index') return await indexCommand(paths, options)
    if (command === 'warm') return print(await warmCommand(paths, options))
    if (command === 'symbol') {
      if (!rest[0]) throw new Error('symbol needs a query')
      return print(await symbolCommand(paths, rest[0], options))
    }
    if (command === 'definition' || command === 'references' || command === 'hover') {
      if (!rest[0]) throw new Error(`${command} needs <file>:<line>:<column>`)
      const method = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover' }[command]
      return print(await positionCommand(paths, method, parsePosition(rest[0]), options))
    }
    if (command === 'diagnostics') {
      if (!rest[0]) throw new Error('diagnostics needs a file')
      return print(await diagnosticsCommand(paths, rest[0], options))
    }
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`)
    return 1
  } catch (error) {
    process.stderr.write(`[ue-clangd] ${error instanceof Error ? error.message : String(error)}\n`)
    return error?.exitCode ?? 3
  }
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
  return 0
}

const invokedDirectly = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('scripts/ue-clangd.mjs')
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`[ue-clangd] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(3)
  })
}
