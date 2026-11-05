/**
 * Where the UE workspace's pieces live, and which engine toolchain to run.
 *
 * A worker reaches a Unreal project through a shared workspace root (`Development/Project/<Game>`)
 * with the engine beside it. Every path here is derived from `--root`/`--project` or the two
 * `DSH_SUPERAGENT_UE_*` variables, so no script carries a machine path; the defaults match the
 * repository's other UE script (`ue-verify.mjs`) and exist only for a first try.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

/** Runs of `engine`-relative directories that hold an LLVM toolchain, newest first. */
export function engineLlvmBins(engine) {
  if (!engine) return []
  const root = join(engine, 'Binaries', 'ThirdParty', 'LLVM')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => Number(right) - Number(left))
    .map(name => join(root, name, 'Win64', 'bin'))
    .filter(bin => existsSync(bin))
}

/**
 * The engine root beside a project, or under the workspace. The first candidate whose
 * `Build/BatchFiles/RunUBT.bat` exists wins; without one the first candidate is returned so a
 * caller can report the concrete missing path instead of a vague failure.
 */
export function engineRootOf(project, workspace) {
  const candidates = [
    project ? join(dirname(project), 'Engine') : undefined,
    join(workspace, 'Engine'),
    join(workspace, 'Development', 'Project', 'Engine'),
  ].filter(candidate => candidate !== undefined)
  return candidates.find(candidate => existsSync(join(candidate, 'Build', 'BatchFiles', 'RunUBT.bat'))) ?? candidates[0]
}

/** The `.uproject` inside `directory`, if exactly one exists. */
function uprojectIn(directory) {
  if (!directory || !existsSync(directory)) return undefined
  const found = readdirSync(directory).find(name => name.toLowerCase().endsWith('.uproject'))
  return found ? join(directory, found) : undefined
}

/**
 * Resolves the workspace, project, `.uproject` and engine that a command works on.
 * `project` may be a directory, a `.uproject` file, or a bare name under `Development/Project`.
 */
export function uePaths(input = {}) {
  const workspace = resolve(input.root ?? process.env.DSH_SUPERAGENT_UE_ROOT ?? 'E:\\workspace')
  const projects = join(workspace, 'Development', 'Project')
  const requested = input.project ?? process.env.DSH_SUPERAGENT_UE_PROJECT ?? 'Game'
  const candidate = isAbsolute(requested) || /[\\/]/.test(requested) || requested.toLowerCase().endsWith('.uproject')
    ? resolve(requested)
    : join(projects, requested)
  let project
  let uproject
  if (candidate.toLowerCase().endsWith('.uproject')) {
    uproject = candidate
    project = dirname(candidate)
  } else {
    project = candidate
    uproject = uprojectIn(project)
  }
  return { workspace, project, uproject, engine: engineRootOf(project, workspace) }
}

/** The engine's `Build.version` object, or undefined when the checkout has no readable one. */
export function engineVersion(engine) {
  if (!engine) return undefined
  try {
    return JSON.parse(readFileSync(join(engine, 'Build', 'Build.version'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The newest engine LLVM tool called `name`, or undefined. */
export function findEngineTool(engine, name) {
  for (const bin of engineLlvmBins(engine)) {
    const tool = join(bin, name)
    if (existsSync(tool)) return tool
  }
  return undefined
}

/**
 * `name` from the extra directories first, then `PATH`. The `.exe` suffix is tried on Windows and
 * the bare name elsewhere, because the same checkout may be inspected from either system.
 */
export function findExecutable(name, options = {}) {
  const env = options.env ?? process.env
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : ['', '.exe']
  for (const directory of options.extra ?? []) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory) continue
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** A copy of `env` whose `PATH` starts with `directories`; the CLI tools need their sibling DLLs. */
export function withPath(env, directories) {
  const order = directories.filter(Boolean)
  const path = [...order, env.PATH ?? env.Path ?? ''].filter(Boolean).join(delimiter)
  return { ...env, PATH: path }
}

/** Quotes one argument so `cmd.exe` passes it through as a single token. */
export function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value
  return `"${String(value).replaceAll('"', '\\"')}"`
}

/**
 * Runs a command and resolves with its exit code, collected stdout+stderr and whether the timeout
 * killed it. Never rejects for a non-zero exit: a compiler or debugger failure is data the caller
 * reports, not an exception that hides it.
 */
export function runProcess(command, args, options = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const append = chunk => {
      const text = chunk.toString('utf8')
      output += text
      options.onOutput?.(text)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : undefined
    const finish = value => {
      if (timer) clearTimeout(timer)
      resolvePromise({ timedOut, output, ...value })
    }
    child.on('error', error => finish({ code: -1, signal: null, error: String(error) }))
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}
