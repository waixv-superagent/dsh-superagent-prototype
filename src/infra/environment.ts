/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { servesGithub } from '../deployment.ts'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli', 'p4']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
/**
 * The real program a Windows shim calls, found on PATH with the shim directory removed. The shim names it by absolute path because a
 * batch file that called `p4` would resolve `p4.cmd` again and re-enter itself.
 */
export function realProgram(name: string, shimDir: string): string {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry || sameDirectory(entry, shimDir)) continue
    for (const extension of ['.exe', '.cmd', '.bat', '']) {
      const candidate = join(entry, `${name}${extension}`)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* 下一个候选 */ }
    }
  }
  return `${name}.exe`
}
/**
 * The `lark-cli` commands that change which identities the bot configuration allows, its profile, or its credentials. A worker
 * must never run them: the deployment serves every Feishu message, read and file through this one bot configuration, and a
 * worker that switched it to the user identity disabled all of them until a person switched it back.
 */
const LARK_IDENTITY_POLICY: readonly (readonly [string, readonly string[]])[] = [
  ['config', ['strict-mode', 'bind', 'init', 'remove', 'default-as', 'keychain-downgrade', 'risk-control']],
  ['profile', ['add', 'use', 'remove', 'rename']],
  ['auth', ['login', 'logout']],
]
/** What a shim answers instead of running one of those commands; the operator runs them outside the worker's PATH. */
export const LARK_IDENTITY_POLICY_MESSAGE = 'The bot lark-cli is fixed to the bot identity; only the operator changes its identity policy, see docs/006-deployment.md. User-identity operations use the CLI the identities skill names; ask the requester to set one up when it names none.'
/**
 * A `.cmd` shim for Windows, where the extensionless `sh` scripts POSIX uses cannot run: PowerShell refuses a document in a pipeline
 * and cmd resolves neither. `blocked` names the subcommands that fail instead of reaching the real program, and `guard` adds
 * lines that refuse a command shape, such as a subcommand of a named command. Like the POSIX shims, it drops its own
 * directory from PATH first, so a wrapper the program runs by name reaches the real program, not the shim.
 */
export function batchShim(program: string, blocked: string[], message: string, shimDir: string, guard: string[] = []): string {
  const blockedGuard = blocked.length
    ? [
        'for %%A in (%*) do (',
        ...blocked.map(word => `  if /I "%%~A"=="${word}" (`),
        `    echo ${message} 1>&2`,
        '    exit /b 1',
        '  )',
        ')',
      ]
    : []
  // The marker stays within the first two lines so the next start recognizes the file as its own: `written` reads those.
  return ['@echo off', `rem ${MARKER.slice(2)}`, 'setlocal EnableExtensions EnableDelayedExpansion',
    'set "dsh_rest=!PATH!"', 'set "dsh_path="', ':dsh_next',
    'for /f "tokens=1* delims=;" %%A in ("!dsh_rest!") do (',
    `  if /I not "%%~A"=="${shimDir}" set "dsh_path=!dsh_path!%%~A;"`,
    '  set "dsh_rest=%%B"',
    ')',
    'if defined dsh_rest goto dsh_next',
    'if defined dsh_path set "dsh_path=!dsh_path:~0,-1!"',
    'set "PATH=!dsh_path!"',
    ...blockedGuard, ...guard, `"${program}" %*`, 'exit /b %errorlevel%', ''].join('\r\n')
}
/** Batch lines that refuse the identity-policy subcommands before the bot CLI sees them. */
function batchLarkGuard(): string[] {
  return LARK_IDENTITY_POLICY.flatMap(([command, subcommands]) => subcommands.map(subcommand =>
    `if /I "%~1"=="${command}" if /I "%~2"=="${subcommand}" (echo ${LARK_IDENTITY_POLICY_MESSAGE} 1>&2 & exit /b 1)`))
}
/** The same refusal as POSIX sh lines, including `strict-mode` wherever it appears in the arguments. */
function shellLarkGuard(): string {
  const subcommandCases = LARK_IDENTITY_POLICY.map(([command, subcommands]) => [
    `if [ "$1" = ${shellQuote(command)} ]; then`,
    `  case "$2" in ${subcommands.join('|')}) echo ${shellQuote(LARK_IDENTITY_POLICY_MESSAGE)} >&2; exit 1 ;; esac`,
    'fi',
  ].join('\n'))
  return [...subcommandCases,
    `for argument in "$@"; do case "$argument" in strict-mode) echo ${shellQuote(LARK_IDENTITY_POLICY_MESSAGE)} >&2; exit 1 ;; esac; done`,
  ].join('\n')
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/**
 * True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other
 * non-regular file never counts as written by dsh-superagent. A POSIX shim keeps the marker verbatim after `#!/bin/sh`, while a
 * Windows `.cmd` shim carries it as a `rem` comment after `@echo off` and ends its lines with CRLF: both forms count, or a
 * batch shim this plugin wrote would look foreign on the next start and stop the deployment check.
 */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.replace(/\r$/, ''))
  const markers = [MARKER, ...LEGACY_MARKERS]
  return markers.some(marker => head.includes(marker) || head.includes(`rem ${marker.slice(2)}`))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`,
    // Git Bash and friends compare against MSYS paths (`/c/...`), not the Windows path the shim is written with; without this
    // the loop below never matches, the shim stays in PATH, and `exec` re-enters it forever.
    'if command -v cygpath >/dev/null 2>&1; then self="$(cygpath -u "$self")"; fi',
    'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const runGuarded = (program: string, guard: string): string => `${withoutShims}\n${guard}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  // Submitting a changelist is a person's decision, so every other p4 subcommand passes through and `submit` does not.
  const submitFree = (program: string, message: string): string => `${withoutShims}
for argument in "$@"; do
  case "$argument" in submit) ${fail(message)};; esac
done
exec ${shellQuote(program)} "$@"`
  // An installation that serves no GitHub Source writes no `gh` shim: nothing may hand a worker a command that would
  // act as an account this deployment never verified.
  // Windows runs `.cmd` shims instead of the extensionless sh scripts: PowerShell treats a document in a pipeline as
  // unexecutable, and cmd resolves neither, so a worker could not run p4 or lark-cli at all.
  const refuse = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  const batchRefuse = (message: string): string => ['@echo off', `rem ${MARKER.slice(2)}`, `echo ${message} 1>&2`, 'exit /b 1', ''].join('\r\n')
  const windows = process.platform === 'win32'
  const batch = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, body)
    await rename(temporary, join(dir, `${name}.cmd`))
    kept.add(`${name}.cmd`)
  }
  const p4Blocked = 'p4 submit is blocked: the mainline is read-only for workers; shelve the changelist for review instead.'
  const larkBlocked = 'lark-cli is unavailable: this installation has no Feishu bot.'
  const blockedNames = new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))
  const blockedText = (name: string): string => github.cli
    ? `${name} is blocked in this installation; use gh, which acts as ${github.login}.`
    : `${name} is blocked in this installation.`
  if (windows) {
    // A resolved CLI is an absolute path; only a name has to be found on PATH with the shim directory removed.
    const real = (cli: string, name: string): string => isAbsolute(cli) ? cli : realProgram(name, dir)
    if (github.cli) await batch('gh', batchShim(real(github.cli, 'gh'), [], '', dir))
    await batch('p4', batchShim(realProgram('p4', dir), ['submit'], p4Blocked, dir))
    await batch('lark-cli', feishu
      ? batchShim(real(feishu.cli, 'lark-cli'), ['strict-mode'], LARK_IDENTITY_POLICY_MESSAGE, dir, batchLarkGuard())
      : batchRefuse(larkBlocked))
    for (const name of blockedNames) await batch(name, batchRefuse(blockedText(name)))
  } else {
    if (github.cli) await shim('gh', run(github.cli))
    await shim('p4', submitFree('p4', p4Blocked))
    await shim('lark-cli', feishu ? runGuarded(feishu.cli, shellLarkGuard()) : refuse(larkBlocked))
    for (const name of blockedNames) await shim(name, refuse(blockedText(name)))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    ...github.cli ? ['[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`] : [],
    ...github.cli ? ['[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/'] : [],
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // An installation without a GitHub Source wrote no credential helper, so there is nothing for git to disagree with.
  if (!servesGithub(deployment)) return
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
