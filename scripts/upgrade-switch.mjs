#!/usr/bin/env node
/**
 * Swap a running dsh-superagent for a new build, and put the old one back if the new one does not come up.
 *
 * The panel's update action starts this script from the checked and built worktree, then stops its own host process. The
 * script runs outside that process, so it survives the host it replaces:
 *
 *   1. hold an external watchdog off (hold file) and wait until the old host process has exited;
 *   2. back up the installed package entries and the orchestrator database;
 *   3. replace: copy the new build's entries over the installed package and record the installed commit;
 *   4. start the service again and wait until `/orchestrator/api/state` reports a running runtime;
 *   5. on failure, stop what it started, restore the backup and start the old version again;
 *   6. resume processing unless it was paused before the update, release the watchdog and record the outcome.
 *
 * Usage: node scripts/upgrade-switch.mjs <plan.json>. The plan is written by src/app/upgrade.ts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Package entries a build replaces in the installed package; `node_modules` stays, which is why dependency changes are refused earlier. */
export const ENTRIES = ['lib', 'locale', 'prompts', 'skills', 'cordis.patch.yml', 'package.json', 'README.md']
/** Database files copied together, so the backup is the database as the old host left it. */
export const DATABASE = ['orchestrator.sqlite', 'orchestrator.sqlite-wal', 'orchestrator.sqlite-shm']
export const BUILD_INFO = 'build-info.json'

/** Read and check a plan; a field it lacks is a bug in the host that wrote it, so the switch stops before touching anything. */
export function parsePlan (text) {
  const plan = JSON.parse(text)
  for (const key of ['sha', 'source', 'install', 'stateDir', 'backup', 'statusFile', 'url', 'pid']) {
    if (plan[key] === undefined || plan[key] === '') throw new Error(`The update plan has no ${key}`)
  }
  if (!plan.start || (!plan.start.command && !plan.start.argv?.length)) throw new Error('The update plan has no start command')
  return { exitTimeoutMs: 120_000, healthTimeoutMs: 180_000, wasPaused: false, holdFile: '', ...plan }
}

/**
 * Run one switch. Every effect goes through `io`, so tests drive the order of steps and the rollback decision without
 * processes or files. Returns the final status, which is also the last one written.
 */
export async function runSwitch (plan, io) {
  // The host's steps (fetch through idle) carry over, so the panel of the next host shows the whole update.
  const status = { state: 'switching', sha: plan.sha, from: plan.from ?? null, startedAt: plan.startedAt ?? io.now(),
    steps: Array.isArray(plan.steps) ? plan.steps.filter(item => item.name !== 'stop') : [], error: null, rolledBack: false }
  const step = (name, state, detail = '') => {
    const found = status.steps.find(item => item.name === name)
    if (found) Object.assign(found, { state, detail, at: io.now() })
    else status.steps.push({ name, state, detail, at: io.now() })
    io.writeStatus(status)
  }
  const finish = async (state, error = null) => {
    if (!plan.wasPaused) {
      try { await io.resume(); step('resume', 'done') } catch (failure) { step('resume', 'failed', String(failure?.message ?? failure)) }
    }
    if (hold) io.remove(hold)
    Object.assign(status, { state, error, endedAt: io.now() })
    io.writeStatus(status)
    return status
  }

  // A hold file a person created stays theirs: the switch removes only one it wrote.
  const hold = plan.holdFile && !io.exists(plan.holdFile) ? plan.holdFile : ''
  if (hold) io.write(hold, `dsh-superagent update to ${plan.sha} in progress\n`)
  step('stop', 'running')
  if (!await io.waitExit(plan.pid, plan.exitTimeoutMs)) {
    io.kill(plan.pid)
    if (!await io.waitExit(plan.pid, 10_000)) {
      step('stop', 'failed', `Process ${plan.pid} did not exit`)
      return finish('failed', 'The old process did not stop; nothing was changed')
    }
    // A forced stop leaves the state directory lock behind; the next start would refuse to open the database.
    io.remove(`${plan.stateDir}.lock`)
    step('stop', 'done', 'forced')
  } else step('stop', 'done')

  step('backup', 'running')
  try {
    io.remove(plan.backup)
    for (const entry of ENTRIES) if (io.exists(join(plan.install, entry))) io.copy(join(plan.install, entry), join(plan.backup, 'package', entry))
    for (const file of DATABASE) if (io.exists(join(plan.stateDir, file))) io.copy(join(plan.stateDir, file), join(plan.backup, 'state', file))
    step('backup', 'done', plan.backup)
  } catch (failure) {
    step('backup', 'failed', String(failure?.message ?? failure))
    // Nothing was replaced: start the version that was running.
    const started = await startAndCheck(plan, io, step, 'restart')
    return finish(started ? 'failed' : 'down', 'The backup failed; the previous version was started again')
  }

  step('replace', 'running')
  try {
    for (const entry of ENTRIES) {
      const from = join(plan.source, entry)
      if (!io.exists(from)) continue
      io.remove(join(plan.install, entry))
      io.copy(from, join(plan.install, entry))
    }
    io.write(join(plan.install, BUILD_INFO), JSON.stringify({ sha: plan.sha, at: io.now() }, null, 2) + '\n')
    step('replace', 'done')
  } catch (failure) {
    step('replace', 'failed', String(failure?.message ?? failure))
    return rollback(plan, io, step, finish, status, `The new build could not be installed: ${String(failure?.message ?? failure)}`)
  }

  if (await startAndCheck(plan, io, step, 'start')) return finish('done')
  return rollback(plan, io, step, finish, status, 'The new version did not report a running runtime in time')
}

async function rollback (plan, io, step, finish, status, reason) {
  status.rolledBack = true
  step('rollback', 'running', reason)
  io.stopStarted()
  try {
    for (const entry of ENTRIES) {
      io.remove(join(plan.install, entry))
      const saved = join(plan.backup, 'package', entry)
      if (io.exists(saved)) io.copy(saved, join(plan.install, entry))
    }
    io.remove(join(plan.install, BUILD_INFO))
    if (plan.from) io.write(join(plan.install, BUILD_INFO), JSON.stringify({ sha: plan.from, at: io.now() }, null, 2) + '\n')
    // The new version may have migrated the database, which the old one then refuses to open.
    for (const file of DATABASE) {
      io.remove(join(plan.stateDir, file))
      const saved = join(plan.backup, 'state', file)
      if (io.exists(saved)) io.copy(saved, join(plan.stateDir, file))
    }
    io.remove(`${plan.stateDir}.lock`)
    step('rollback', 'done', reason)
  } catch (failure) {
    step('rollback', 'failed', String(failure?.message ?? failure))
    return finish('down', `${reason}; restoring the backup failed, which is kept at ${plan.backup}`)
  }
  const up = await startAndCheck(plan, io, step, 'restart')
  return finish(up ? 'rolledBack' : 'down', up ? reason : `${reason}; the previous version did not come up either`)
}

async function startAndCheck (plan, io, step, name) {
  step(name, 'running')
  try { io.start(plan.start) } catch (failure) { step(name, 'failed', String(failure?.message ?? failure)); return false }
  const healthy = await io.healthy(plan.url, plan.healthTimeoutMs)
  step(name, healthy ? 'done' : 'failed', healthy ? '' : `${plan.url} did not answer with a running runtime`)
  return healthy
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const HEADERS = { 'x-orchestrator-request': '1' }

function alive (pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
function killTree (pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ } }
}

/**
 * The log for the start command's output. The launcher that started this switch already redirects its own stdout and
 * stderr to the same file, and on Windows a second open of that file fails with EBUSY; the child then inherits the
 * handles the switch already has, which are that log.
 */
export function openSwitchLog (path, open = openSync) {
  if (!path) return 'ignore'
  try { return open(path, 'a') } catch { return 'inherit' }
}

/** The real effects: files, processes and the management API on loopback. */
export function systemIo (plan) {
  const started = []
  const log = openSwitchLog(plan.log)
  return {
    now: () => new Date().toISOString(),
    exists: path => existsSync(path),
    copy: (from, to) => { mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true, force: true }) },
    remove: path => rmSync(path, { recursive: true, force: true }),
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) },
    writeStatus: status => { mkdirSync(dirname(plan.statusFile), { recursive: true }); writeFileSync(plan.statusFile, JSON.stringify(status, null, 2) + '\n') },
    waitExit: async (pid, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) { if (!alive(pid)) return true; await sleep(500) }
      return !alive(pid)
    },
    // Only the host itself: a tree kill would take this switch, which the host started, down with it.
    kill: pid => { try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ } },
    start: start => {
      const child = start.command
        ? spawn(start.command, { shell: true, cwd: start.cwd || undefined, detached: true, windowsHide: true, stdio: ['ignore', log, log] })
        : spawn(start.argv[0], start.argv.slice(1), { cwd: start.cwd || undefined, detached: true, windowsHide: true, stdio: ['ignore', log, log] })
      child.unref()
      if (child.pid) started.push(child.pid)
    },
    stopStarted: () => {
      // A host writes its own pid on start; a start script's own pid would leave the host it launched running.
      const hostPid = Number(readText(join(dirname(plan.statusFile), 'host.pid')).trim())
      for (const pid of new Set([...started, ...(hostPid && hostPid !== plan.pid ? [hostPid] : [])])) killTree(pid)
      started.length = 0
    },
    healthy: async (url, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        try {
          const response = await fetch(`${url}/orchestrator/api/state`, { headers: HEADERS, signal: AbortSignal.timeout(5000) })
          if (response.ok) {
            const state = await response.json()
            if (['ready', 'paused'].includes(state?.health?.runtime?.state)) return true
          }
        } catch { /* Not up yet. */ }
        await sleep(2000)
      }
      return false
    },
    resume: async () => {
      const response = await fetch(`${plan.url}/orchestrator/api/executor/pause`, { method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ paused: false }), signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`Resuming processing answered ${response.status}`)
    },
  }
}
function readText (path) { try { return readFileSync(path, 'utf8') } catch { return '' } }

/**
 * The status a switch leaves when it dies before writing one, so the panel and the next host do not wait in `switching`
 * forever: the steps the host already recorded carry over, minus the stop step it did not finish.
 */
export function failedStatus (plan, error, now = () => new Date().toISOString()) {
  return { state: 'failed', sha: plan.sha, from: plan.from ?? null, startedAt: plan.startedAt ?? now(), endedAt: now(),
    steps: Array.isArray(plan.steps) ? plan.steps.filter(item => item.name !== 'stop') : [], error: String(error), rolledBack: false }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase() : false
if (invoked) {
  let plan
  const record = error => {
    console.error(String(error?.stack ?? error))
    // A setup failure happens before runSwitch, so only this path can still tell the panel the switch did not run.
    try {
      if (plan) writeFileSync(plan.statusFile, JSON.stringify(failedStatus(plan, String(error?.message ?? error)), null, 2) + '\n')
    } catch { /* Nothing to record. */ }
    process.exitCode = 1
  }
  try {
    plan = parsePlan(readFileSync(process.argv[2], 'utf8'))
    runSwitch(plan, systemIo(plan)).then(status => { process.exitCode = status.state === 'done' ? 0 : 1 }, error => record(error))
  } catch (error) { record(error) }
}
