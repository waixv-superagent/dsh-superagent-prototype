/**
 * 复现用例的轻量 A/B 跑测（docs/025）：同一个探针在 baseline 臂（A）与改动臂（B）各跑一次，
 * 用两臂观测的差异做断言，而不是把期望值写死；每次运行的输出、产物与观测留在用例目录里，
 * 最后生成一份人可以直接打开的报告。它不启动编辑器，也不重编译，只负责「跑、留证、判读」。
 *
 * 用法（在用例目录里，或在参数里给目录）：
 *   node scripts/repro-ab.mjs init <caseDir> --probe "py -3 probe.py"
 *   node scripts/repro-ab.mjs run <caseDir> --arm A --label "baseline CL 589000"
 *   node scripts/repro-ab.mjs replay <caseDir>          # 跑 B 臂并与最近一次 A 比，写报告
 *   node scripts/repro-ab.mjs compare <caseDir>         # 只比最近两臂，不跑
 *   node scripts/repro-ab.mjs status <caseDir>
 *   node scripts/repro-ab.mjs --self-test
 *
 * 退出码：0 通过（或单臂运行成功）；1 用法/配置错误；2 断言不通过；3 信息不足（缺臂、观测、重复不一致）。
 *
 * 依赖：只用 Node 内置模块，因此 init 会把本文件复制到用例的 .repro/harness.mjs，用例目录里也能直接跑。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HARNESS_VERSION = '0.1.0'
/** The local, disposable directory a case keeps its harness snapshot, runs and report in. */
export const AB_DIR = '.repro'
const RUNS = 'runs'
const DEFAULT_OBSERVATION = 'observation.json'
const DEFAULT_TIMEOUT_SECONDS = 900
const MAX_REPEAT = 5
const MAX_ARTIFACTS = 120
const MAX_TAIL = 32 * 1024
const MAX_HASH_BYTES = 32 * 1024 * 1024
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const OPS = new Set(['equals', 'changed', 'unchanged', 'increase', 'decrease', 'within'])
const VERDICT_TEXT = { pass: '通过', fail: '不通过', incomplete: '信息不足' }
const STATUS_TEXT = { pass: '通过', fail: '不通过', incomplete: '信息不足' }
const EXIT = { pass: 0, usage: 1, fail: 2, incomplete: 3 }

/** A problem with the case's configuration or the command line; the CLI turns it into exit code 1. */
export class AbError extends Error {
  constructor(message, code = 'usage') {
    super(message)
    this.name = 'AbError'
    this.code = code
  }
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const reason = error => error instanceof Error ? error.message : String(error)
const exists = path => { try { return existsSync(path) } catch { return false } }
const stamp = iso => iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max)}…`
const jsonText = (value, max = 12_000) => clip(JSON.stringify(value, null, 2), max)
/** Windows editors and PowerShell commonly write a UTF-8 BOM; JSON.parse does not accept it, a case file may carry it. */
const parseJson = text => JSON.parse(String(text).replace(/^\uFEFF/, ''))

/** A flag's value from `argv`, or undefined; a flag without its value is a usage error. */
function flag(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new AbError(`${name} 需要一个值`)
  return value
}

const has = (argv, name) => argv.includes(name)

function unknownFlags(argv, allowed) {
  const known = new Set(allowed)
  for (const item of argv) if (item.startsWith('--') && !known.has(item)) throw new AbError(`不认识的参数：${item}`)
}

/** A relative path that stays inside `directory` (no absolute path, no `..`), else undefined. */
function inside(directory, value) {
  const trimmed = String(value).trim()
  if (!trimmed || isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return undefined
  const full = resolve(directory, trimmed)
  const path = relative(directory, full)
  return path && !path.startsWith('..') && !isAbsolute(path) ? full : undefined
}

/**
 * Reads and normalizes `.repro/ab.json` (or `ab.json` beside case.json). Unknown top-level keys are refused so a typo
 * such as `expects` cannot silently turn into "no assertions"; `arms` may override the probe per arm.
 */
export function parseAbManifest(raw) {
  if (!isObject(raw)) throw new AbError('ab.json 必须是一个 JSON 对象')
  const allowed = new Set(['version', 'probe', 'arms', 'observation', 'timeoutSeconds', 'repeat', 'tolerance', 'relativeTolerance', 'expect', 'notes'])
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new AbError(`ab.json 里有未知字段 "${key}"`)
  if (raw.version !== undefined && raw.version !== 1) throw new AbError('ab.json 的 version 目前只支持 1')
  if (typeof raw.probe !== 'string' || !raw.probe.trim()) throw new AbError('ab.json 缺少 probe：写明在用例目录里运行探针的命令')
  if (raw.probe.length > 2_000) throw new AbError('probe 太长')
  let arms
  if (raw.arms !== undefined) {
    if (!isObject(raw.arms)) throw new AbError('arms 必须是一个对象，例如 { "A": "...", "B": "..." }')
    for (const [key, value] of Object.entries(raw.arms)) {
      if (key !== 'A' && key !== 'B') throw new AbError(`arms 里只能有 A 与 B，不能有 "${key}"`)
      if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw new AbError(`arms.${key} 必须是非空命令`)
    }
    arms = { ...raw.arms }
  }
  const observation = raw.observation ?? DEFAULT_OBSERVATION
  if (typeof observation !== 'string' || !observation.trim()) throw new AbError('observation 必须是非空相对路径')
  if (observation.length > 400 || isAbsolute(observation) || /^[a-zA-Z]:/.test(observation) || observation.split(/[\\/]/).includes('..')) {
    throw new AbError('observation 必须是用例目录内的相对路径')
  }
  const timeoutSeconds = raw.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 7_200) throw new AbError('timeoutSeconds 必须是 10–7200 的整数')
  const repeat = raw.repeat ?? 1
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) throw new AbError(`repeat 必须是 1–${MAX_REPEAT} 的整数`)
  const tolerance = raw.tolerance ?? 0
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) throw new AbError('tolerance 必须是非负数字（绝对容差）')
  const relativeTolerance = raw.relativeTolerance ?? 0
  if (typeof relativeTolerance !== 'number' || !Number.isFinite(relativeTolerance) || relativeTolerance < 0 || relativeTolerance > 1) {
    throw new AbError('relativeTolerance 必须是 0–1 的数字（相对容差）')
  }
  if (raw.notes !== undefined && (typeof raw.notes !== 'string' || raw.notes.length > 2_000)) throw new AbError('notes 必须是不超过 2000 字的字符串')
  const expectations = raw.expect ?? []
  if (!Array.isArray(expectations) || expectations.length > 50) throw new AbError('expect 必须是数组，最多 50 条')
  const expect = expectations.map((item, index) => {
    const where = `expect[${index}]`
    if (!isObject(item)) throw new AbError(`${where} 必须是对象`)
    for (const key of Object.keys(item)) {
      if (!['path', 'op', 'value', 'min', 'tolerance', 'relativeTolerance', 'note'].includes(key)) throw new AbError(`${where} 里有未知字段 "${key}"`)
    }
    if (typeof item.path !== 'string' || !item.path.trim()) throw new AbError(`${where} 缺少 path（观测里的字段，点号分层）`)
    if (!OPS.has(item.op)) throw new AbError(`${where}.op 必须是 ${[...OPS].join(' / ')} 之一`)
    if ((item.op === 'equals' || item.op === 'within') && item.value === undefined) throw new AbError(`${where}（${item.op}）需要 value`)
    if (item.op === 'within' && (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0)) {
      throw new AbError(`${where}.value 必须是非负数字（within 的绝对边界）`)
    }
    if (item.min !== undefined && (typeof item.min !== 'number' || !Number.isFinite(item.min) || item.min < 0)) throw new AbError(`${where}.min 必须是非负数字`)
    if (item.tolerance !== undefined && (typeof item.tolerance !== 'number' || !Number.isFinite(item.tolerance) || item.tolerance < 0)) throw new AbError(`${where}.tolerance 必须是非负数字`)
    if (item.relativeTolerance !== undefined && (typeof item.relativeTolerance !== 'number' || !Number.isFinite(item.relativeTolerance) || item.relativeTolerance < 0 || item.relativeTolerance > 1)) {
      throw new AbError(`${where}.relativeTolerance 必须是 0–1 的数字`)
    }
    if (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 500)) throw new AbError(`${where}.note 必须是不超过 500 字的字符串`)
    return { path: item.path.trim(), op: item.op, ...(item.value !== undefined ? { value: item.value } : {}),
      ...(item.min !== undefined ? { min: item.min } : {}), ...(item.tolerance !== undefined ? { tolerance: item.tolerance } : {}),
      ...(item.relativeTolerance !== undefined ? { relativeTolerance: item.relativeTolerance } : {}), ...(item.note ? { note: item.note } : {}) }
  })
  return { version: 1, probe: raw.probe, ...(arms ? { arms } : {}), observation, timeoutSeconds, repeat, tolerance, relativeTolerance, expect,
    ...(raw.notes ? { notes: raw.notes } : {}) }
}

/** Reads the case's manifest, preferring `.repro/ab.json` and falling back to `ab.json` beside the case (used by examples). */
function loadManifest(caseDir) {
  const candidates = [join(caseDir, AB_DIR, 'ab.json'), join(caseDir, 'ab.json')]
  const found = candidates.find(path => exists(path))
  if (!found) throw new AbError(`找不到 ${AB_DIR}/ab.json（或 case 目录下的 ab.json）：先用 init 生成或用 --probe 新建`)
  let raw
  try { raw = parseJson(readFileSync(found, 'utf8')) } catch (error) { throw new AbError(`读不了 ${found}：${reason(error)}`) }
  return { manifest: parseAbManifest(raw), path: found }
}

/** The name and description the report shows; case.json stays owned by docs/024, so a broken one only loses the label. */
function caseMeta(caseDir) {
  try {
    const json = parseJson(readFileSync(join(caseDir, 'case.json'), 'utf8'))
    return { name: typeof json.name === 'string' && json.name.trim() ? json.name.trim() : basename(caseDir),
      description: typeof json.description === 'string' ? json.description : '' }
  } catch { return { name: basename(caseDir), description: '' } }
}

function spawnCommand(command, cwd, env) {
  const options = { cwd, env, windowsHide: true }
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...options, windowsVerbatimArguments: true })
    : spawn('/bin/sh', ['-c', command], { ...options, detached: true })
}

/** Stops a probe and everything it started; a case that drives the editor must not leave it running after a timeout. */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
}

/** A short stable digest for the report's evidence table; large artifacts keep their size only. */
function digest(path, size) {
  if (size > MAX_HASH_BYTES) return `size:${size}`
  try { return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) } catch { return 'unreadable' }
}

function listArtifacts(directory, logNames, observationName) {
  const artifacts = []
  const walk = (current, prefix, depth) => {
    if (depth > 5 || artifacts.length >= MAX_ARTIFACTS) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (artifacts.length >= MAX_ARTIFACTS) return
      const full = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(full, rel, depth + 1); continue }
      if (!entry.isFile() || logNames.has(rel) || rel === observationName) continue
      let size = 0
      try { size = statSync(full).size } catch { continue }
      artifacts.push({ path: rel, size, sha256: digest(full, size), image: IMAGE_EXT.has(extname(entry.name).toLowerCase()) })
    }
  }
  walk(directory, '', 0)
  return artifacts
}

/** Reads the probe's observation from the run directory; a missing or malformed file is an incomplete observation. */
function readObservation(attemptDir, observation) {
  const full = inside(attemptDir, observation)
  if (!full) return { error: `observation 路径不合法：${observation}` }
  let raw
  try { raw = readFileSync(full, 'utf8') } catch (error) {
    const missing = error?.code === 'ENOENT'
    return { error: missing ? `探针没有写 ${observation}（应写到 REPRO_RUN_DIR 下）` : `读不了观测：${reason(error)}` }
  }
  try {
    const value = parseJson(raw)
    if (!isObject(value)) return { error: '观测必须是 JSON 对象' }
    return { observation: value }
  } catch (error) { return { error: `观测不是合法 JSON：${reason(error)}` } }
}

async function runAttempt({ caseDir, runDir, arm, index, command, timeoutMs, observation }) {
  const attemptDir = join(runDir, `attempt-${index}`)
  mkdirSync(attemptDir, { recursive: true })
  const stdout = createWriteStream(join(attemptDir, 'stdout.log'))
  const stderr = createWriteStream(join(attemptDir, 'stderr.log'))
  let stdoutTail = ''
  let stderrTail = ''
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let timedOut = false
  let child
  const env = { ...process.env, REPRO_ARM: arm, REPRO_RUN_DIR: attemptDir, REPRO_CASE_DIR: caseDir, REPRO_ATTEMPT: String(index) }
  const done = new Promise(resolveClose => {
    try { child = spawnCommand(command, caseDir, env) } catch (error) {
      stderrTail = reason(error)
      resolveClose({ exitCode: null, signal: null })
      return
    }
    child.stdout?.on('data', chunk => { stdout.write(chunk); stdoutTail = (stdoutTail + chunk.toString()).slice(-MAX_TAIL) })
    child.stderr?.on('data', chunk => { stderr.write(chunk); stderrTail = (stderrTail + chunk.toString()).slice(-MAX_TAIL) })
    child.on('error', error => { stderrTail = `${stderrTail}\n${reason(error)}`.slice(-MAX_TAIL) })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child?.pid)
    }, timeoutMs)
    timer.unref?.()
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolveClose({ exitCode, signal }) })
  })
  const { exitCode, signal } = await done
  stdout.end()
  stderr.end()
  const endedAt = new Date().toISOString()
  const observed = readObservation(attemptDir, observation)
  const logs = new Set(['stdout.log', 'stderr.log'])
  return { index, exitCode: exitCode ?? null, signal: signal ?? null, timedOut, startedAt, endedAt, durationMs: Date.now() - started,
    ...(observed.observation ? { observation: observed.observation } : {}), ...(observed.error ? { observationError: observed.error } : {}),
    stdoutTail, stderrTail, artifacts: listArtifacts(attemptDir, logs, observation) }
}

/** Runs one arm (default `repeat` attempts) in its own run directory and returns the record written to run.json. */
export async function runArm({ caseDir, manifest, arm, repeat, label, now = () => Date.now() }) {
  if (arm !== 'A' && arm !== 'B') throw new AbError('--arm 只能是 A 或 B')
  const directory = resolve(caseDir)
  if (!exists(directory) || !statSync(directory).isDirectory()) throw new AbError(`用例目录不存在：${directory}`)
  const times = repeat ?? manifest.repeat
  if (!Number.isInteger(times) || times < 1 || times > MAX_REPEAT) throw new AbError(`--repeat 必须是 1–${MAX_REPEAT} 的整数`)
  const runRoot = join(directory, AB_DIR, RUNS)
  mkdirSync(runRoot, { recursive: true })
  const startedAt = new Date(now()).toISOString()
  const id = `${stamp(startedAt)}-${arm}-${randomUUID().slice(0, 6)}`
  const runDir = join(runRoot, id)
  mkdirSync(runDir, { recursive: true })
  const command = manifest.arms?.[arm] ?? manifest.probe
  const attempts = []
  for (let index = 1; index <= times; index += 1) {
    attempts.push(await runAttempt({ caseDir: directory, runDir, arm, index, command,
      timeoutMs: manifest.timeoutSeconds * 1_000, observation: manifest.observation }))
  }
  const record = { version: HARNESS_VERSION, id, arm, label: label ?? (arm === 'A' ? 'baseline' : 'candidate'), command,
    startedAt, endedAt: attempts.at(-1)?.endedAt ?? startedAt, durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0), attempts }
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  return { record, directory: runDir }
}

/** Every recorded run of the case, newest first; a broken run.json is skipped rather than breaking the list. */
function readRuns(caseDir) {
  const root = join(resolve(caseDir), AB_DIR, RUNS)
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const value = parseJson(readFileSync(join(root, entry.name, 'run.json'), 'utf8'))
      if (isObject(value) && typeof value.id === 'string' && Array.isArray(value.attempts)) runs.push(value)
    } catch {}
  }
  return runs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
}

/** The newest run of an arm that produced an observation, or undefined. */
export function selectLatestRun(caseDir, arm) {
  return readRuns(caseDir).find(run => run.arm === arm && run.attempts.some(attempt => isObject(attempt.observation)))
}

function findRun(caseDir, id) {
  if (!id || id === 'last') return undefined
  return readRuns(caseDir).find(run => run.id === id)
}

function numeric(a, b) { return typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) }

/** Numeric equality with absolute and relative tolerance; strings, booleans, null and structured values compare exactly. */
function sameValue(a, b, { tolerance = 0, relativeTolerance = 0 } = {}) {
  if (numeric(a, b)) {
    const limit = Math.max(tolerance, relativeTolerance * Math.max(Math.abs(a), Math.abs(b)))
    return Math.abs(a - b) <= limit
  }
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b)
  if (isObject(a) || isObject(b) || Array.isArray(a) || Array.isArray(b)) {
    return isObject(a) && isObject(b) || Array.isArray(a) && Array.isArray(b)
      ? JSON.stringify(a) === JSON.stringify(b) : false
  }
  return Object.is(a, b)
}

/** The value at a dotted path, or `{ found: false }`; dot keys are not supported because the path syntax uses them. */
function resolvePath(value, path) {
  let current = value
  for (const part of String(path).split('.')) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { found: false }
    current = current[part]
  }
  return { found: true, value: current }
}

/** Flattens observations into dotted paths (arrays stay one value) so two runs can be compared field by field. */
function flatten(value, prefix, output) {
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, output)
    return output
  }
  output[prefix || '<root>'] = value
  return output
}

/** One row per observation path: the baseline value, the candidate value and whether they are the same. */
export function diffFields(baseline, candidate, options = {}) {
  const left = flatten(baseline ?? {}, '', {})
  const right = flatten(candidate ?? {}, '', {})
  const paths = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  return paths.map(path => {
    const inA = Object.prototype.hasOwnProperty.call(left, path)
    const inB = Object.prototype.hasOwnProperty.call(right, path)
    if (!inA || !inB) return { path, a: inA ? left[path] : undefined, b: inB ? right[path] : undefined, status: 'missing',
      detail: !inA ? '只有 B 臂有' : '只有 A 臂有' }
    return { path, a: left[path], b: right[path], status: sameValue(left[path], right[path], options) ? 'same' : 'different',
      detail: sameValue(left[path], right[path], options) ? '相同' : '不同' }
  })
}

/** Evaluates the declared expectations against a baseline and a candidate observation. */
export function evaluateExpectations(expectations, baseline, candidate, options = {}) {
  return expectations.map(expectation => {
    const tolerance = { tolerance: expectation.tolerance ?? options.tolerance ?? 0,
      relativeTolerance: expectation.relativeTolerance ?? options.relativeTolerance ?? 0 }
    const a = resolvePath(baseline ?? {}, expectation.path)
    const b = resolvePath(candidate ?? {}, expectation.path)
    const base = { path: expectation.path, op: expectation.op, ...(expectation.note ? { note: expectation.note } : {}),
      a: a.found ? a.value : undefined, b: b.found ? b.value : undefined }
    if (!a.found || !b.found) {
      return { ...base, status: 'incomplete', detail: !a.found && !b.found ? '两臂都没有这个字段' : !a.found ? 'A 臂没有这个字段' : 'B 臂没有这个字段' }
    }
    switch (expectation.op) {
      case 'equals': {
        const pass = sameValue(b.value, expectation.value, tolerance)
        return { ...base, status: pass ? 'pass' : 'fail', detail: pass ? '符合期望值' : `期望 ${JSON.stringify(expectation.value)}，实际 ${JSON.stringify(b.value)}` }
      }
      case 'changed': {
        const pass = !sameValue(a.value, b.value, tolerance)
        return { ...base, status: pass ? 'pass' : 'fail', detail: pass ? 'A 与 B 不同' : 'A 与 B 相同（变化未发生）' }
      }
      case 'unchanged': {
        const pass = sameValue(a.value, b.value, tolerance)
        return { ...base, status: pass ? 'pass' : 'fail', detail: pass ? 'A 与 B 一致' : 'A 与 B 不一致（出现了非期望变化）' }
      }
      case 'increase':
      case 'decrease': {
        if (!numeric(a.value, b.value)) return { ...base, status: 'incomplete', detail: 'A/B 不是可比较的数字' }
        const min = expectation.min ?? 0
        const delta = expectation.op === 'increase' ? b.value - a.value : a.value - b.value
        const pass = delta > min
        return { ...base, status: pass ? 'pass' : 'fail', delta,
          detail: `${expectation.op === 'increase' ? '增加' : '减少'} ${delta.toFixed(4)}（阈值 ${min}）` }
      }
      case 'within': {
        if (!numeric(a.value, b.value)) return { ...base, status: 'incomplete', detail: 'A/B 不是可比较的数字' }
        const delta = Math.abs(b.value - a.value)
        const pass = delta <= expectation.value
        return { ...base, status: pass ? 'pass' : 'fail', delta, detail: `偏差 ${delta.toFixed(4)}（边界 ${expectation.value}）` }
      }
      default:
        return { ...base, status: 'incomplete', detail: `不支持的 op：${expectation.op}` }
    }
  })
}

function observedAttempts(run) {
  return run ? run.attempts.filter(attempt => isObject(attempt.observation)) : []
}

/** Checks that repeated runs of the same arm agree; disagreement means the case is not a stable experiment yet. */
function repeatability(runs) {
  return runs.filter(Boolean).map(run => {
    const attempts = observedAttempts(run)
    if (attempts.length < 2) return { arm: run.arm, run: run.id, attempts: attempts.length, differing: [] }
    const differing = []
    for (const attempt of attempts.slice(1)) {
      for (const row of diffFields(attempts[0].observation, attempt.observation)) {
        if (row.status !== 'same' && !differing.includes(row.path)) differing.push(row.path)
      }
    }
    return { arm: run.arm, run: run.id, attempts: attempts.length, differing }
  })
}

const slimRun = run => run ? { id: run.id, arm: run.arm, label: run.label, command: run.command, startedAt: run.startedAt, endedAt: run.endedAt,
  durationMs: run.durationMs, attempts: run.attempts } : null

/** Compares two recorded runs and produces the verdict and every table the report needs. */
export function compareRuns({ caseDir, manifest, baseline, candidate, now = () => Date.now() }) {
  const reasons = []
  const a = baseline ?? null
  const b = candidate ?? null
  const baselineAttempt = observedAttempts(a)[0] ?? null
  const candidateAttempts = observedAttempts(b)
  const aErrors = (a?.attempts ?? []).filter(attempt => !isObject(attempt.observation))
  const bErrors = (b?.attempts ?? []).filter(attempt => !isObject(attempt.observation))
  const timedOut = [...(a?.attempts ?? []), ...(b?.attempts ?? [])].filter(attempt => attempt.timedOut)
  const perAttempt = (b?.attempts ?? []).map(attempt => ({
    index: attempt.index,
    results: baselineAttempt && isObject(attempt.observation)
      ? evaluateExpectations(manifest.expect, baselineAttempt.observation, attempt.observation,
        { tolerance: manifest.tolerance, relativeTolerance: manifest.relativeTolerance })
      : [],
    error: attempt.observationError,
  }))
  const results = perAttempt.find(item => item.results.length)?.results ?? []
  const statuses = perAttempt.flatMap(item => item.results.map(result => result.status))
  const repeat = repeatability([a, b])
  const flaky = repeat.filter(item => item.attempts > 1 && item.differing.length > 0)
  if (!candidateAttempts.length) reasons.push('B 臂没有成功产出观测')
  if (!baselineAttempt) reasons.push('还没有 baseline（A 臂）的观测：先在改动前跑 run --arm A')
  if (manifest.expect.length === 0) reasons.push('ab.json 没有声明 expect：本次只留证据，不做判定')
  if (aErrors.length) reasons.push(`A 臂有 ${aErrors.length} 次没有观测，baseline 不是一次干净的对照`)
  if (bErrors.length) reasons.push(`B 臂有 ${bErrors.length} 次没有观测`)
  if (statuses.includes('fail')) reasons.push('有断言不通过')
  if (statuses.includes('incomplete')) reasons.push('有断言缺少可比的数据')
  if (timedOut.length) reasons.push('有运行超时，结果不可信')
  for (const item of flaky) reasons.push(`${item.arm} 臂的重复运行不一致：${item.differing.slice(0, 8).join('、')}${item.differing.length > 8 ? ' 等' : ''}`)
  let verdict = 'pass'
  if (statuses.includes('fail')) verdict = 'fail'
  else if (!baselineAttempt || !candidateAttempts.length || !results.length || statuses.includes('incomplete') || flaky.length > 0 ||
    aErrors.length > 0 || bErrors.length > 0 || timedOut.length > 0) verdict = 'incomplete'
  else if (manifest.expect.length === 0) verdict = 'incomplete'
  const fields = baselineAttempt && candidateAttempts[0]
    ? diffFields(baselineAttempt.observation, candidateAttempts[0].observation,
      { tolerance: manifest.tolerance, relativeTolerance: manifest.relativeTolerance })
    : []
  return { version: HARNESS_VERSION, generatedAt: new Date(now()).toISOString(), verdict, reasons,
    baseline: slimRun(a), candidate: slimRun(b), attempts: { baseline: a?.attempts.length ?? 0, candidate: b?.attempts.length ?? 0, perAttempt },
    fields, expectations: results, repeat, flaky, expect: manifest.expect }
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function linkPath(...parts) { return parts.join('/').split('/').filter(Boolean).map(encodeURIComponent).join('/') }

function valueText(value, max = 180) {
  if (value === undefined) return '—'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return clip(text, max)
}

function artifactHtml(run, attempt) {
  if (!attempt.artifacts.length) return '<p class="muted">没有额外的产物文件。</p>'
  const images = attempt.artifacts.filter(artifact => artifact.image)
  const others = attempt.artifacts.filter(artifact => !artifact.image)
  const imageHtml = images.map(artifact => `<figure><a href="${linkPath('runs', run.id, `attempt-${attempt.index}`, artifact.path)}" target="_blank" rel="noreferrer">` +
    `<img src="${linkPath('runs', run.id, `attempt-${attempt.index}`, artifact.path)}" alt="${escapeHtml(artifact.path)}" loading="lazy"></a>` +
    `<figcaption>${escapeHtml(artifact.path)} · ${artifact.size} B</figcaption></figure>`).join('')
  const listHtml = others.map(artifact => `<li><a href="${linkPath('runs', run.id, `attempt-${attempt.index}`, artifact.path)}" target="_blank" rel="noreferrer">` +
    `${escapeHtml(artifact.path)}</a> · ${artifact.size} B · <code>${escapeHtml(artifact.sha256)}</code></li>`).join('')
  return `${imageHtml ? `<div class="shots">${imageHtml}</div>` : ''}${listHtml ? `<ul class="files">${listHtml}</ul>` : ''}`
}

function runHtml(run, role) {
  if (!run) return `<article class="arm missing"><h3>${role}</h3><p class="muted">这一臂还没有运行。</p></article>`
  const attempts = run.attempts.map(attempt => `<details ${attempt.index === 1 ? 'open' : ''}><summary>第 ${attempt.index} 次 · ` +
    `退出码 ${attempt.exitCode ?? '—'}${attempt.timedOut ? ' · 超时' : ''} · ${(attempt.durationMs / 1000).toFixed(1)}s</summary>` +
    `${attempt.observation ? `<pre>${escapeHtml(jsonText(attempt.observation))}</pre>` : `<p class="bad">${escapeHtml(attempt.observationError ?? '没有观测')}</p>`}` +
    `${artifactHtml(run, attempt)}` +
    `${attempt.stdoutTail.trim() ? `<details class="log"><summary>stdout（末尾）</summary><pre>${escapeHtml(clip(attempt.stdoutTail, 6_000))}</pre></details>` : ''}` +
    `${attempt.stderrTail.trim() ? `<details class="log"><summary>stderr（末尾）</summary><pre>${escapeHtml(clip(attempt.stderrTail, 6_000))}</pre></details>` : ''}` +
    `</details>`).join('')
  return `<article class="arm"><h3>${role}</h3><p class="muted"><code>${escapeHtml(run.id)}</code> · ${escapeHtml(run.label)} · ` +
    `${escapeHtml(run.startedAt)} · ${(run.durationMs / 1000).toFixed(1)}s</p><p class="cmd"><code>${escapeHtml(run.command)}</code></p>${attempts}</article>`
}

/** The self-contained HTML report: both arms' observations and artifacts, the diff, and the declared expectations. */
export function renderReport(model) {
  const { case: caseInfo, manifest, comparison } = model
  const verdict = VERDICT_TEXT[comparison.verdict] ?? comparison.verdict
  const expectationRows = comparison.expectations.map(item => `<tr class="${item.status}"><td>${escapeHtml(STATUS_TEXT[item.status] ?? item.status)}</td>` +
    `<td><code>${escapeHtml(item.op)}</code> <code>${escapeHtml(item.path)}</code>${item.note ? `<div class="note">${escapeHtml(item.note)}</div>` : ''}</td>` +
    `<td>${escapeHtml(valueText(item.a))}</td><td>${escapeHtml(valueText(item.b))}</td><td>${escapeHtml(item.detail ?? '')}</td></tr>`).join('')
  const diffRows = comparison.fields.map(row => `<tr class="${row.status}"><td><code>${escapeHtml(row.path)}</code></td>` +
    `<td>${escapeHtml(valueText(row.a))}</td><td>${escapeHtml(valueText(row.b))}</td><td>${escapeHtml(row.detail)}</td></tr>`).join('')
  const repeatRows = comparison.repeat.map(item => `<tr class="${item.differing.length ? 'incomplete' : 'same'}"><td>${item.arm === 'A' ? 'A · baseline' : 'B · candidate'}</td>` +
    `<td>${item.attempts}</td><td>${item.differing.length ? escapeHtml(item.differing.join('、')) : '一致'}</td></tr>`).join('')
  const attemptsRows = comparison.attempts.perAttempt.map(item => {
    const status = item.results.some(result => result.status === 'fail') ? 'fail'
      : item.error || !item.results.length || item.results.some(result => result.status === 'incomplete') ? 'incomplete' : 'pass'
    return `<tr class="${status}"><td>${item.index}</td><td>${item.results.length}</td>` +
      `<td>${item.results.filter(result => result.status === 'pass').length}</td>` +
      `<td>${item.results.filter(result => result.status === 'fail').length}</td><td>${escapeHtml(item.error ?? '—')}</td></tr>`
  }).join('')
  const reasons = comparison.reasons.length ? `<ul class="reasons">${comparison.reasons.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''
  const notes = manifest.notes ? `<p class="muted">${escapeHtml(manifest.notes)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(caseInfo.name)} · A/B 复现报告</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#1d2129;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px 64px}header{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #dfe1e6;padding-bottom:16px;margin-bottom:20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 12px}h3{font-size:15px;margin:0 0 6px}.meta,.muted{color:#6b7280;font-size:13px}.muted{margin:4px 0}
.verdict{display:inline-block;border-radius:999px;padding:6px 14px;font-weight:700;white-space:nowrap}.pass{background:#e8f7ee;color:#126b37}.fail{background:#fdecec;color:#a12727}.incomplete{background:#fff6dc;color:#7a5300}
section{background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:16px 18px;margin:16px 0}header{border-bottom:none;background:none;padding:0;margin:0}
.reasons{margin:8px 0 0;padding-left:20px}.arms{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:860px){.arms{grid-template-columns:1fr}}
.arm{background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:14px}.arm.missing{border-style:dashed}.cmd code{word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #eceef1;padding:7px 8px;text-align:left;vertical-align:top}th{background:#f8f9fb;font-weight:600}
tr.fail td:first-child{color:#a12727;font-weight:600}tr.incomplete td:first-child{color:#7a5300;font-weight:600}tr.same td:first-child{color:#126b37}tr.different td:first-child{color:#a12727;font-weight:600}
pre{background:#0f172a;color:#e5e7eb;border-radius:8px;padding:12px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;max-height:420px;white-space:pre-wrap;word-break:break-word}
code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.note{color:#6b7280;font-size:12px}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:10px 0}
figure{margin:0}figure img{width:100%;border:1px solid #e3e6eb;border-radius:8px;background:#fafafa}figcaption{color:#6b7280;font-size:12px;margin-top:4px;word-break:break-all}
.files{padding-left:18px;margin:8px 0}.log{margin-top:8px}summary{cursor:pointer;color:#374151}footer{color:#6b7280;font-size:12px;margin-top:28px;border-top:1px solid #dfe1e6;padding-top:12px}
.bad{color:#a12727}
</style></head><body><main>
<header><div><h1>${escapeHtml(caseInfo.name)} · A/B 复现报告</h1><p class="meta">${escapeHtml(caseInfo.description || '（没有写描述）')}</p>
<p class="meta">生成于 ${escapeHtml(comparison.generatedAt)} · harness ${escapeHtml(model.version)} · 用例目录 ${escapeHtml(caseInfo.dir)} · 判定文件 <code>${escapeHtml(AB_DIR)}/result.json</code></p></div>
<span class="verdict ${comparison.verdict}">${verdict}</span></header>
${reasons}<section><h2>结论</h2><p>机器只判 <code>ab.json</code> 里声明的指标；没有声明、缺少观测或重复不一致都不会算通过。观感、手感、镜头与动画质量仍需人判断。</p>${notes}</section>
<section><h2>两臂</h2><div class="arms">${runHtml(comparison.baseline, 'A · baseline（改动前）')}${runHtml(comparison.candidate, 'B · candidate（改动后）')}</div></section>
<section><h2>声明的断言</h2>${comparison.expect.length ? `<table><thead><tr><th>结果</th><th>断言</th><th>A</th><th>B</th><th>说明</th></tr></thead><tbody>${expectationRows}</tbody></table>` : '<p class="muted">ab.json 没有声明 expect，因此只保留差异，不做判定。</p>'}</section>
<section><h2>逐次尝试</h2>${attemptsRows ? `<table><thead><tr><th>第几次</th><th>断言数</th><th>通过</th><th>不通过</th><th>观测错误</th></tr></thead><tbody>${attemptsRows}</tbody></table>` : '<p class="muted">B 臂还没有成功的尝试。</p>'}</section>
<section><h2>观测差异</h2>${diffRows ? `<table><thead><tr><th>字段</th><th>A</th><th>B</th><th>状态</th></tr></thead><tbody>${diffRows}</tbody></table>` : '<p class="muted">缺少一臂的观测，无法列出差异。</p>'}</section>
<section><h2>重复运行</h2><table><thead><tr><th>臂</th><th>有观测的次数</th><th>结果</th></tr></thead><tbody>${repeatRows}</tbody></table>
<p class="muted">同一输入重复出现同一现象才算可复现；重复不一致时本报告判“信息不足”，而不是挑一次好看的结果。</p></section>
<footer>复跑：执行 case.json 的 command（面板“复现用例”里该用例的“运行”按钮就是它），或按 docs/025 的说明手动跑两臂。<br>
用例约定见仓库 docs/025-repro-ab.md；产物与运行记录留在 ${escapeHtml(AB_DIR)}/runs/，报告可随时重生成。</footer>
</main></body></html>`
}

/** Writes the report and the machine-readable verdict beside the case's runs directory. */
export function writeReport(caseDir, model) {
  const directory = join(resolve(caseDir), AB_DIR)
  mkdirSync(directory, { recursive: true })
  const report = join(directory, 'report.html')
  writeFileSync(report, renderReport(model))
  writeFileSync(join(directory, 'result.json'), `${JSON.stringify({ ...model.comparison, case: model.case, expect: model.manifest.expect }, null, 2)}\n`)
  return { report, result: join(directory, 'result.json') }
}

function buildModel({ caseDir, manifest, baseline, candidate, now }) {
  const comparison = compareRuns({ caseDir, manifest, baseline, candidate, now })
  return { version: HARNESS_VERSION, generatedAt: comparison.generatedAt, case: { ...caseMeta(caseDir), dir: resolve(caseDir) }, manifest, comparison }
}

function runSummary(record) {
  const observed = record.attempts.filter(attempt => isObject(attempt.observation)).length
  const failed = record.attempts.filter(attempt => !isObject(attempt.observation)).map(attempt => attempt.observationError ?? '没有观测')
  return `${record.arm} 臂已记录：${record.id}（${observed}/${record.attempts.length} 次有观测）` +
    `${failed.length ? `\n  问题：${failed.join('；')}` : ''}`
}

function compareSummary(comparison, reportPath) {
  const lines = [`判定：${VERDICT_TEXT[comparison.verdict] ?? comparison.verdict}`]
  for (const item of comparison.expectations) lines.push(`  ${STATUS_TEXT[item.status] ?? item.status} ${item.op} ${item.path} — ${item.detail}`)
  for (const item of comparison.reasons) lines.push(`  说明：${item}`)
  lines.push(`报告：${reportPath}`)
  return lines.join('\n')
}

/** Creates `.repro/` in a case folder: a harness snapshot, a manifest template, and case.json when it is missing. */
function initCase(caseDir, argv) {
  unknownFlags(argv, ['--probe', '--name', '--force'])
  const probe = flag(argv, '--probe')
  if (!probe || !probe.trim()) throw new AbError('init 需要 --probe "<在用例目录里运行探针的命令>"')
  const directory = resolve(caseDir)
  mkdirSync(join(directory, AB_DIR), { recursive: true })
  const target = join(directory, AB_DIR, 'harness.mjs')
  const force = has(argv, '--force')
  // A copy must never overwrite itself: the case may invoke init from `.repro/harness.mjs`.
  if ((!exists(target) || force) && resolve(fileURLToPath(import.meta.url)) !== resolve(target)) copyFileSync(fileURLToPath(import.meta.url), target)
  const manifestPath = join(directory, AB_DIR, 'ab.json')
  if (!exists(manifestPath) || force) {
    writeFileSync(manifestPath, `${JSON.stringify({ version: 1, probe: probe.trim(), observation: DEFAULT_OBSERVATION,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, repeat: 1, tolerance: 0, relativeTolerance: 0, expect: [],
      notes: '把 expect 写成这个 case 真正要判的点：changed / unchanged / increase / decrease / equals / within。' }, null, 2)}\n`)
  }
  const casePath = join(directory, 'case.json')
  const name = flag(argv, '--name') ?? basename(directory)
  const command = `node ${AB_DIR}/harness.mjs replay`
  const createdCase = !exists(casePath)
  if (createdCase) {
    writeFileSync(casePath, `${JSON.stringify({ name, description: '', command, report: `${AB_DIR}/report.html`, timeoutSeconds: 3_600 }, null, 2)}\n`)
  }
  const lines = [`已准备 ${directory}`, `  ${AB_DIR}/harness.mjs（本脚本快照）`, `  ${AB_DIR}/ab.json（探针与断言）`]
  if (createdCase) lines.push(`  case.json（面板入口）`)
  else lines.push(`  case.json 已存在：请确认 command 是 "node ${AB_DIR}/harness.mjs replay"，report 是 "${AB_DIR}/report.html"`)
  lines.push('下一步：', `  1. 在 ${AB_DIR}/ab.json 里写 expect（至少一条），让探针把观测写到 REPRO_RUN_DIR/${DEFAULT_OBSERVATION}`,
    `  2. 改动前记录基线：node ${AB_DIR}/harness.mjs run . --arm A --label "baseline <CL/commit>"`,
    `  3. 改动后跑对照：node ${AB_DIR}/harness.mjs replay .（或在面板里点这个用例的运行）`)
  return lines.join('\n')
}

/** Lists the case's runs so an agent can pick an id without reading the directory. */
function statusCase(caseDir, argv) {
  unknownFlags(argv, ['--json'])
  const runs = readRuns(caseDir)
  if (has(argv, '--json')) return JSON.stringify(runs.map(run => ({ id: run.id, arm: run.arm, label: run.label, startedAt: run.startedAt,
    attempts: run.attempts.length, observed: run.attempts.filter(attempt => isObject(attempt.observation)).length })), null, 2)
  if (!runs.length) return '还没有运行记录。先用 run --arm A 记录基线。'
  return runs.map(run => `${run.id}  ${run.arm}  ${run.attempts.filter(attempt => isObject(attempt.observation)).length}/${run.attempts.length}  ${run.label}  ${run.startedAt}`).join('\n')
}

function usage() {
  return `用法：
  node scripts/repro-ab.mjs init <caseDir> --probe "<命令>" [--name "<名字>"] [--force]
  node scripts/repro-ab.mjs run <caseDir> --arm A|B [--label "<说明>"] [--repeat N] [--json]
  node scripts/repro-ab.mjs replay <caseDir> [--label "<说明>"] [--repeat N] [--baseline <runId>] [--json]
  node scripts/repro-ab.mjs compare <caseDir> [--baseline <runId>] [--candidate <runId>] [--json]
  node scripts/repro-ab.mjs status <caseDir> [--json]
  node scripts/repro-ab.mjs --self-test`
}

export async function main(argv) {
  try {
    if (argv.includes('--help') || argv.length === 0) { console.log(usage()); return EXIT.pass }
    if (argv.includes('--self-test')) { await runSelfTest(); console.log('self-test passed'); return EXIT.pass }
    const [command, ...rest] = argv
    const caseDir = rest.find((item, index) => !item.startsWith('--') && rest[index - 1] !== '--label' &&
      rest[index - 1] !== '--arm' && rest[index - 1] !== '--repeat' && rest[index - 1] !== '--baseline' &&
      rest[index - 1] !== '--candidate' && rest[index - 1] !== '--probe' && rest[index - 1] !== '--name') ?? '.'
    if (command === 'init') {
      unknownFlags(rest, ['--probe', '--name', '--force'])
      console.log(initCase(caseDir, rest))
      return EXIT.pass
    }
    if (command === 'status') { unknownFlags(rest, ['--json']); console.log(statusCase(caseDir, rest)); return EXIT.pass }
    if (command === 'run') {
      unknownFlags(rest, ['--arm', '--label', '--repeat', '--json'])
      const arm = flag(rest, '--arm')
      if (arm !== 'A' && arm !== 'B') throw new AbError('run 必须带 --arm A 或 --arm B')
      const { manifest } = loadManifest(caseDir)
      const repeat = flag(rest, '--repeat') === undefined ? undefined : Number(flag(rest, '--repeat'))
      const { record, directory } = await runArm({ caseDir, manifest, arm, repeat, label: flag(rest, '--label') })
      if (has(rest, '--json')) console.log(JSON.stringify({ run: record, directory: relative(process.cwd(), directory) }, null, 2))
      else {
        console.log(runSummary(record))
        console.log(arm === 'A' ? '这是 baseline；改动后用 replay 与它对照。' : '改动臂已记录；用 compare 或 replay 看差异。')
      }
      return record.attempts.some(attempt => isObject(attempt.observation)) ? EXIT.pass : EXIT.incomplete
    }
    if (command === 'replay') {
      unknownFlags(rest, ['--label', '--repeat', '--baseline', '--json'])
      const { manifest } = loadManifest(caseDir)
      const repeat = flag(rest, '--repeat') === undefined ? undefined : Number(flag(rest, '--repeat'))
      const { record } = await runArm({ caseDir, manifest, arm: 'B', repeat, label: flag(rest, '--label') })
      const model = buildModel({ caseDir, manifest, baseline: findRun(caseDir, flag(rest, '--baseline')) ?? selectLatestRun(caseDir, 'A'), candidate: record })
      const written = writeReport(caseDir, model)
      if (has(rest, '--json')) console.log(JSON.stringify({ run: record.id, verdict: model.comparison.verdict, report: written.report, result: model.comparison }, null, 2))
      else console.log(compareSummary(model.comparison, written.report))
      return EXIT[model.comparison.verdict] ?? EXIT.incomplete
    }
    if (command === 'compare') {
      unknownFlags(rest, ['--baseline', '--candidate', '--json'])
      const { manifest } = loadManifest(caseDir)
      const model = buildModel({ caseDir, manifest, baseline: findRun(caseDir, flag(rest, '--baseline')) ?? selectLatestRun(caseDir, 'A'),
        candidate: findRun(caseDir, flag(rest, '--candidate')) ?? selectLatestRun(caseDir, 'B') })
      const written = writeReport(caseDir, model)
      if (has(rest, '--json')) console.log(JSON.stringify({ verdict: model.comparison.verdict, report: written.report, result: model.comparison }, null, 2))
      else console.log(compareSummary(model.comparison, written.report))
      return EXIT[model.comparison.verdict] ?? EXIT.incomplete
    }
    throw new AbError(`不认识的命令：${command}\n${usage()}`)
  } catch (error) {
    if (error instanceof AbError) { console.error(`repro-ab: ${error.message}`); return EXIT.usage }
    console.error(`repro-ab: ${reason(error)}`)
    return EXIT.usage
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Self-test: no editor and no repository needed; a tiny probe writes an observation into REPRO_RUN_DIR.            */
/* ---------------------------------------------------------------------------------------------------------------- */

const PROBE_SOURCE = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.REPRO_RUN_DIR
const arm = process.env.REPRO_ARM
const attempt = Number(process.env.REPRO_ATTEMPT)
const slide = arm === 'A' ? 8 : (process.env.REPRO_FLAKY === '1' && attempt > 1 ? 3 : 0.5)
const observation = { state: 'idle', metrics: { slide: { max: slide }, fps: 60 }, input: 'turn-90' }
writeFileSync(join(dir, 'observation.json'), JSON.stringify(observation))
writeFileSync(join(dir, 'trace.json'), JSON.stringify({ arm, attempt }))
`

const DEMO_MANIFEST = { version: 1, probe: '__NODE__ probe.mjs', observation: 'observation.json', timeoutSeconds: 30, repeat: 1,
  tolerance: 0.1, relativeTolerance: 0, expect: [
    { path: 'metrics.slide.max', op: 'decrease', min: 3, note: '急转滑动应明显减小' },
    { path: 'metrics.fps', op: 'unchanged', tolerance: 0.5, note: '帧率不应退化' },
    { path: 'state', op: 'equals', value: 'idle' },
  ] }

const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath

function tempCase(root, name, probe = PROBE_SOURCE, manifest = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ name, description: 'self-test', command: `node ${AB_DIR}/harness.mjs replay`,
    report: `${AB_DIR}/report.html`, timeoutSeconds: 60 }))
  writeFileSync(join(dir, 'probe.mjs'), probe)
  writeFileSync(join(dir, 'ab.json'), JSON.stringify({ ...DEMO_MANIFEST, probe: DEMO_MANIFEST.probe.replace('__NODE__', NODE), ...manifest }, null, 2))
  return dir
}

/** Runs the harness end to end against temporary cases; used by --self-test and by the test suite. */
export async function runSelfTest() {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '/tmp', `repro-ab-selftest-${randomUUID().slice(0, 8)}`)
  mkdirSync(root, { recursive: true })
  const assert = (condition, message) => { if (!condition) throw new AbError(`自检失败：${message}`) }
  try {
    const dir = tempCase(root, 'pass')
    const { manifest } = (() => { const raw = parseJson(readFileSync(join(dir, 'ab.json'), 'utf8')); return { manifest: parseAbManifest(raw) } })()
    const baseline = await runArm({ caseDir: dir, manifest, arm: 'A', label: 'baseline' })
    assert(baseline.record.attempts.length === 1 && isObject(baseline.record.attempts[0].observation), 'A 臂应产出观测')
    assert(baseline.record.attempts[0].artifacts.some(artifact => artifact.path === 'trace.json'), '产物应被记录')
    const candidate = await runArm({ caseDir: dir, manifest, arm: 'B', label: 'fix' })
    const model = buildModel({ caseDir: dir, manifest, baseline: baseline.record, candidate: candidate.record })
    assert(model.comparison.verdict === 'pass', `A/B 应通过，实际 ${model.comparison.verdict}`)
    assert(model.comparison.expectations.every(item => item.status === 'pass'), '每条断言应通过')
    const written = writeReport(dir, model)
    const report = readFileSync(written.report, 'utf8')
    assert(report.includes('A · baseline') && report.includes('B · candidate') && report.includes('trace.json'), '报告应包含两臂与产物')

    const failDir = tempCase(root, 'fail', PROBE_SOURCE, { expect: [{ path: 'metrics.slide.max', op: 'unchanged' }] })
    const failManifest = parseAbManifest(JSON.parse(readFileSync(join(failDir, 'ab.json'), 'utf8')))
    const failA = await runArm({ caseDir: failDir, manifest: failManifest, arm: 'A' })
    const failB = await runArm({ caseDir: failDir, manifest: failManifest, arm: 'B' })
    const failed = buildModel({ caseDir: failDir, manifest: failManifest, baseline: failA.record, candidate: failB.record })
    assert(failed.comparison.verdict === 'fail', '不满足的断言应判不通过')

    const missingDir = tempCase(root, 'missing', 'process.exit(0)')
    const missingManifest = parseAbManifest(JSON.parse(readFileSync(join(missingDir, 'ab.json'), 'utf8')))
    const missingA = await runArm({ caseDir: missingDir, manifest: missingManifest, arm: 'A' })
    const missingB = await runArm({ caseDir: missingDir, manifest: missingManifest, arm: 'B' })
    const missing = buildModel({ caseDir: missingDir, manifest: missingManifest, baseline: missingA.record, candidate: missingB.record })
    assert(missing.comparison.verdict === 'incomplete', '没有观测应判信息不足，不能当通过')

    const flakyDir = tempCase(root, 'flaky', PROBE_SOURCE, { repeat: 2, expect: [{ path: 'metrics.slide.max', op: 'decrease', min: 3 }] })
    process.env.REPRO_FLAKY = '1'
    const flakyManifest = parseAbManifest(JSON.parse(readFileSync(join(flakyDir, 'ab.json'), 'utf8')))
    const flakyA = await runArm({ caseDir: flakyDir, manifest: flakyManifest, arm: 'A', repeat: 1 })
    const flakyB = await runArm({ caseDir: flakyDir, manifest: flakyManifest, arm: 'B', repeat: 2 })
    delete process.env.REPRO_FLAKY
    const flaky = buildModel({ caseDir: flakyDir, manifest: flakyManifest, baseline: flakyA.record, candidate: flakyB.record })
    assert(flaky.comparison.verdict === 'incomplete' && flaky.comparison.flaky.length === 1, '重复不一致应判信息不足')

    const noBaseline = buildModel({ caseDir: dir, manifest, baseline: undefined, candidate: candidate.record })
    assert(noBaseline.comparison.verdict === 'incomplete', '缺 baseline 应判信息不足')

    const badReport = renderReport({ version: HARNESS_VERSION, generatedAt: new Date().toISOString(),
      case: { name: '<script>alert(1)</script>', description: '', dir: root },
      manifest: { ...manifest, notes: '<img src=x onerror=alert(1)>' }, comparison: model.comparison })
    assert(!badReport.includes('<script>alert(1)</script>') && badReport.includes('&lt;script&gt;'), '报告必须转义 HTML')

    assert(parseAbManifest({ probe: 'x', expect: [{ path: 'a', op: 'changed' }] }).expect[0].op === 'changed', '合法断言应解析')
    let rejected = false
    try { parseAbManifest({ probes: 'x' }) } catch { rejected = true }
    assert(rejected, '未知字段应被拒绝')
    rejected = false
    try { parseAbManifest({ probe: 'x', expect: [{ path: 'a', op: 'changed', typo: 1 }] }) } catch { rejected = true }
    assert(rejected, '断言的未知字段应被拒绝')

    const initDir = join(root, 'init')
    mkdirSync(initDir, { recursive: true })
    initCase(initDir, ['--probe', `${NODE} probe.mjs`, '--name', '演示'])
    assert(exists(join(initDir, AB_DIR, 'harness.mjs')) && exists(join(initDir, AB_DIR, 'ab.json')) && exists(join(initDir, 'case.json')), 'init 应生成快照、清单与 entry')
    const initCaseJson = JSON.parse(readFileSync(join(initDir, 'case.json'), 'utf8'))
    assert(initCaseJson.command === `node ${AB_DIR}/harness.mjs replay` && initCaseJson.report === `${AB_DIR}/report.html`, 'init 的 case.json 应指向 harness 与报告')
    return true
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    console.error(`repro-ab: ${reason(error)}`)
    process.exit(EXIT.usage)
  })
}
