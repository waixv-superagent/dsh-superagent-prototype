#!/usr/bin/env node
/**
 * Run the test suite, and run again only the files whose vitest workers could not start.
 *
 * The forks pool starts one process per test file. On a busy host a fork can miss vitest's fixed 60 s start timeout before
 * any test runs (`[vitest-pool]: Failed to start forks worker for test files …`), which fails the run although no test
 * failed. The one-click update runs this suite inside the live host, so those files are run once more instead of failing
 * the update. A run whose tests actually failed is never retried.
 *
 * The one-click update's build worktree (`<stateDir>/upgrade/build`, see src/app/upgrade.ts) runs this same script from
 * inside the host, where the deployment's own editor endpoint is ambient; the specs that speak to an editor MCP endpoint
 * are left out there and covered by the worker's own run instead (docs/006).
 */
import { spawn } from 'node:child_process'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** How many rounds a run whose workers did not start may take: the full suite, then the files it lost, then those again. */
export const ROUNDS = 4
/**
 * Specs that speak to an editor MCP endpoint. The update build runs inside the host, whose own editor endpoint and bridge
 * files are ambient, so its build must not depend on them; the worker's own suite still runs these (docs/006).
 */
export const EDITOR_MCP_SPECS = ['tests/editor-capture.spec.ts']
/** Whether `cwd` is the host's update build worktree: `<stateDir>/upgrade/build`. */
export function updateBuild(cwd) {
  return /[/\\]upgrade[/\\]build[/\\]?$/i.test(cwd)
}
/** Enough output to tell a test failure from a start failure, without keeping a massive failure log in memory. */
const OUTPUT_LIMIT = 4 << 20
const ANSI = /\x1b\[[0-9;]*m/g

/**
 * Why a run failed: `test` when a test failed, `pool` when vitest could not start a worker, `other` otherwise. Only `pool`
 * is worth another attempt: it says nothing about the code under test.
 */
export function testRunOutcome(output) {
  // The reporter colors FAIL/cross lines when its output is a terminal or CI; the decision ignores the escape codes.
  const text = output.replace(ANSI, '')
  if (/(^|\n)\s*(FAIL|×)\s/.test(text)) return 'test'
  if (/\[vitest-pool\]: Failed to start|Timeout waiting for worker to respond/.test(text)) return 'pool'
  return 'other'
}

/** The test files vitest named as workers it could not start, in the order its `Failed to start … worker` lines list them. */
export function filesWithoutWorkers(output) {
  const text = output.replace(ANSI, '')
  const files = []
  const line = /\[vitest-pool\]: Failed to start \w+ worker for test files (.+?)\.(?:\r?\n|$)/g
  for (const match of text.matchAll(line)) {
    for (const file of match[1].split(', ')) {
      const path = file.replace(/^['"]|['"]$/g, '').trim()
      if (/\.spec\.[cm]?[jt]sx?$/.test(path) && !files.includes(path)) files.push(path)
    }
  }
  return files
}

/** The vitest invocation for one round: its entry, `run`, the excluded globs, then the files to run. */
export function vitestArgs(cwd, files, exclude = []) {
  // The pool names absolute files; vitest's positional filters match the files it knows, so pass them repo-relative.
  return [join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...exclude.map(glob => `--exclude=${glob}`),
    ...(files ?? []).map(file => relative(cwd, file))]
}
/** Run vitest over the whole suite, or over `files`, streaming its output through, and resolve its exit code and output. */
function runOnce(cwd, env, files, exclude) {
  const args = vitestArgs(cwd, files, exclude)
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let collected = ''
  const collect = target => chunk => {
    target.write(chunk)
    if (collected.length < OUTPUT_LIMIT) collected += chunk.toString()
  }
  child.stdout.on('data', collect(process.stdout))
  child.stderr.on('data', collect(process.stderr))
  return new Promise(resolve => {
    child.on('error', error => resolve({ code: 1, output: `${collected}\n${String(error?.stack ?? error)}` }))
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output: collected }))
  })
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase() : false
if (invoked) {
  const cwd = process.cwd()
  const exclude = updateBuild(cwd) ? EDITOR_MCP_SPECS : []
  let files
  for (let round = 1; round <= ROUNDS; round++) {
    const { code, output } = await runOnce(cwd, process.env, files, exclude)
    if (code === 0) { process.exitCode = 0; break }
    // A test failure is the code's answer: no retry, whatever else the run reported.
    files = testRunOutcome(output) === 'pool' ? filesWithoutWorkers(output) : []
    if (round === ROUNDS || !files.length) { process.exitCode = code; break }
    process.stderr.write(`\nThe test suite could not start vitest's workers for ${files.length} file(s); ` +
      `running ${files.length === 1 ? 'it' : 'them'} again (round ${round + 1} of ${ROUNDS}).\n`)
  }
}
