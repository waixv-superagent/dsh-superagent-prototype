import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
import { commandLine, CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
const windows = process.platform === 'win32'
let dir: string
/**
 * A fake CLI written as a Node program: POSIX gets an executable script, Windows a `.cmd` wrapper, which is the file a
 * PATH lookup and a worker shell find there. The body receives the arguments in `process.argv.slice(2)`.
 */
const program = (file: string, body: string): string => {
  if (windows) {
    writeFileSync(`${file}.mjs`, body)
    writeFileSync(`${file}.cmd`, `@echo off\r\n"${process.execPath}" "%~dp0${basename(file)}.mjs" %*\r\n`)
    return `${file}.cmd`
  }
  writeFileSync(file, `#!/usr/bin/env node\n${body}`); chmodSync(file, 0o755); return file
}
/** A shim's path in the worker bin directory, with the extension Windows gives it. */
const shim = (name: string): string => join(workerBin(dir), windows ? `${name}.cmd` : name)
/** A shim's file names in the worker bin directory. */
const shims = (): string[] => readdirSync(workerBin(dir)).sort()
/** Runs a shim the way a worker shell does: `cmd.exe /c` on Windows, directly elsewhere; a killed start is retried once. */
const runShim = async (name: string, args: string[], options: { env?: Record<string, string> } = {}) => {
  const [file, argv] = commandLine(shim(name), args)
  const run = () => exec(file, argv, { ...options, timeout: 60_000 })
  try {
    return await run()
  } catch (error) {
    // A fully parallel suite can starve or scan a fresh `cmd.exe` until it is killed (no exit code); that is not the shim's answer.
    if ((error as { code?: number | null }).code !== null) throw error
    return await run()
  }
}
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    program(join(dir, 'real', 'gh'), "console.log(JSON.stringify({ login: 'agent-bot', config: process.env.GH_CONFIG_DIR, path: process.env.PATH }))")
    const config = join(dir, 'agent-config')
    const wrapper = windows
      // A Windows wrapper is a batch file; `call` resolves the real `gh` through the PATH the shim already stripped.
      ? (writeFileSync(join(dir, 'gh-agent.cmd'), `@echo off\r\nset "GH_CONFIG_DIR=${config}"\r\ncall gh %*\r\n`), join(dir, 'gh-agent.cmd'))
      : program(join(dir, 'gh-agent'), `process.env.GH_CONFIG_DIR = ${JSON.stringify(config)}\nrequire('node:child_process').execFileSync('gh', process.argv.slice(2), { stdio: 'inherit' })`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const entries = [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin']
    const { stdout } = await runShim('gh', ['api', 'user'], { env: { PATH: [bin, ...entries].join(delimiter) } })
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config, path: entries.join(delimiter) })
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const fail = async (name: string, args: string[] = []) => (await runShim(name, args).catch((error: unknown) => error)) as { code: number; stderr: string }
    expect(await fail('lark-cli', ['im', '+chat-list'])).toMatchObject({ code: 1 })
    expect(await fail('personal-gh')).toMatchObject({ code: 1 })
    expect((await fail('lark-cli')).stderr).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
    expect((await fail('personal-gh')).stderr).toContain('personal-gh is blocked in this installation; use gh, which acts as agent-bot.')
  })
  it('write a `p4` wrapper that passes every subcommand through except `submit`', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [])
    const text = readFileSync(shim('p4'), 'utf8')
    // The wrapper runs the real `p4` with the shim directory removed from PATH, so only `submit` differs.
    expect(text).toContain(windows ? 'if /I "%%~A"=="submit"' : 'case "$argument" in submit)')
    expect(text).toContain('p4 submit is blocked: the mainline is read-only for workers; shelve the changelist for review instead.')
    if (windows) expect(text).toContain('"')
    else expect(text).toContain('exec \'p4\' "$@"')
    // The blocked subcommand answers before the real `p4` is reached.
    const blocked = await runShim('p4', ['submit']).catch((error: unknown) => error) as { code: number; stderr: string }
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain('p4 submit is blocked')
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const base = testDeployment()
    const gh = program(join(dir, 'gh-agent'), "console.log('gh ' + process.argv.slice(2).join(' '))")
    const lark = program(join(dir, 'lark-bot'), "console.log('lark ' + process.argv.slice(2).join(' '))")
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    expect([(await runShim('gh', ['api', 'user'])).stdout.trim(), (await runShim('lark-cli', ['im'])).stdout.trim()]).toEqual(['gh api user', 'lark im'])
    expect(shims()).not.toContain(windows ? 'git.cmd' : 'git')
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(shims()).toEqual(windows ? ['gh.cmd', 'lark-cli.cmd', 'p4.cmd'] : ['gh', 'lark-cli', 'p4'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    const marker = readFileSync(shim('gh'), 'utf8').split('\n').map(line => line.replace(/\r$/, '')).find(line => line.includes('Written by dsh-superagent'))!
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${marker}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(shim('gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('keeps its own Windows batch shim instead of calling it foreign on the next start', async () => {
    // A `.cmd` shim carries the marker as a `rem` comment and ends its lines with CRLF, unlike the POSIX sh shims.
    const bin = workerBin(dir)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'p4.cmd'), '@echo off\r\nrem Written by dsh-superagent on every start; edits are lost.\r\n"p4.exe" %*\r\n')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(bin)).toContain(process.platform === 'win32' ? 'p4.cmd' : 'p4')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(shim('old-cli'), 'dsh-tag'); legacy(shim('older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(shims()).toEqual(windows ? ['gh.cmd', 'lark-cli.cmd', 'p4.cmd'] : ['gh', 'lark-cli', 'p4'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    // Git quotes an origin path that contains backslashes, and doubles them inside the quotes.
    const origin = (text: string): string => text.replace(/^file:"(.*)"\t/, 'file:$1\t').replaceAll('\\\\', '\\')
    expect(origin(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')))
      .toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'asked\\n'); console.log('operator-secret')`)
  const agent = program(join(dir, 'real', 'gh'), 'process.exit(0)')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(delimiter), bin)).toBe(['/usr/bin', 'node_modules/.bin'].join(delimiter))
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const [file, args] = commandLine(argv[0]!, argv.slice(1))
    const child = spawn(file, args, { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    // Node stands in for a CLI: it exists on every platform, and its exit needs no shell.
    const failing = [process.execPath, '-e', "console.error('nope'); process.exit(3)"]
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })
})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
