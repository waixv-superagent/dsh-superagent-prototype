import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpgrade, AppUpgradeRefused, newestInstaller, type AppUpgradeHost } from '../src/app/app-upgrade.ts'
import { NO_UPGRADE } from '../src/deployment.ts'
import type { Runner } from '../src/app/upgrade.ts'

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), O = 'e'.repeat(40)
const log = (...shas: string[]) => shas.map((sha, index) => [sha, `feat: change ${index}`, 'dev', '2026-11-17T00:00:00+08:00'].join('\x1f')).join('\n')

/** A runner whose git answers from a table; pnpm commands are recorded and may fail. */
function runner(git: Record<string, string | Error>, pnpm: Record<string, Error> = {}) {
  const commands: string[] = []
  const run: Runner = {
    command: async (file, args) => {
      if (file !== 'git') {
        const key = `${file} ${args.join(' ')}`
        commands.push(key)
        const failure = pnpm[args[0] ?? '']
        if (failure) throw failure
        return ''
      }
      const key = args.slice(2).join(' ')
      commands.push(key)
      const found = Object.entries(git).find(([prefix]) => key.startsWith(prefix))?.[1]
      if (found instanceof Error) throw found
      return found ?? ''
    },
    detach: () => {},
    read: () => undefined,
    write: () => {},
    exists: () => false,
  }
  return { run, commands }
}

const CHECK = {
  'fetch --quiet fork master': '',
  'rev-parse refs/remotes/fork/master': `${C}\n`,
  'cat-file -e': '',
  'log --max-count=31': log(C, B),
  'rev-parse HEAD': `${C}\n`,
  'status --porcelain --untracked-files=normal': '',
  'fetch --quiet origin master': '',
  'rev-parse refs/remotes/origin/master': `${O}\n`,
  'rev-list --count': '2\n',
  'log --max-count=10': log(O),
}

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function make(git: Record<string, string | Error> = CHECK, overrides: Partial<AppUpgradeHost> = {},
  pnpm: Record<string, Error> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-app-upgrade-'))
  directories.push(stateDir)
  const { run, commands } = runner(git, pnpm)
  const host: AppUpgradeHost = {
    config: { ...NO_UPGRADE, appCheckout: 'C:/dsh', appRemote: 'fork', appBranch: 'master', appOfficialRemote: 'origin',
      appOfficialBranch: 'master', appBuildScript: 'package:desktop:win:x64:unsigned' },
    stateDir,
    warn: () => {},
    run,
    now: () => Date.parse('2026-11-17T00:00:00.000Z'),
    installed: () => ({ commit: A, version: '0.2.2-alpha.3' }),
    findArtifact: () => 'C:/out/deepseek-harness.exe',
    ...overrides,
  }
  return { upgrade: new AppUpgrade(host), stateDir, commands, host }
}

describe('desktop app update check', () => {
  it('offers nothing and refuses a build without a configured checkout', async () => {
    const { upgrade, commands } = make(CHECK, { config: { ...NO_UPGRADE } })
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ enabled: false, available: false, blocked: 'disabled' })
    expect(commands).toEqual([])
    expect(() => upgrade.build()).toThrow(AppUpgradeRefused)
  })

  it('lists the fork commits the installed app lacks and how far the official branch is ahead', async () => {
    const { upgrade } = make()
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ enabled: true, installed: { commit: A }, available: true, blocked: null,
      fork: { ref: 'fork/master', sha: C, error: null }, official: { ref: 'origin/master', sha: O, error: null },
      officialAhead: { count: 2 } })
    expect(upgrade.view().behind.map(commit => commit.sha)).toEqual([C, B])
    expect(upgrade.view().officialAhead.commits.map(commit => commit.sha)).toEqual([O])
  })

  it('offers nothing when the installed app is the fork head', async () => {
    const { upgrade } = make(CHECK, { installed: () => ({ commit: C, version: '0.2.2-alpha.3' }) })
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ available: false, blocked: 'current', behind: [] })
    expect(() => upgrade.build()).toThrow('current')
  })

  it('blocks a checkout with uncommitted changes or at another commit', async () => {
    const dirty = make({ ...CHECK, 'status --porcelain --untracked-files=normal': ' M src/app/upgrade.ts\n' })
    await dirty.upgrade.check()
    expect(dirty.upgrade.view()).toMatchObject({ available: true, blocked: 'dirty' })
    expect(() => dirty.upgrade.build()).toThrow('dirty')
    const behind = make({ ...CHECK, 'rev-parse HEAD': `${D}\n` })
    await behind.upgrade.check()
    expect(behind.upgrade.view()).toMatchObject({ blocked: 'out-of-sync' })
    expect(() => behind.upgrade.build()).toThrow('out-of-sync')
  })

  it('shows a fetch error without losing the previous answer', async () => {
    const { upgrade } = make({ 'fetch --quiet fork master': new Error('Could not resolve host: github.com') })
    await upgrade.check()
    expect(upgrade.view().fork).toMatchObject({ sha: null, error: expect.stringContaining('Could not resolve host') as unknown as string })
    expect(upgrade.view().available).toBe(false)
  })
})

describe('desktop app build', () => {
  it('builds the checked commit and reports the installer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-app-installer-'))
    directories.push(directory)
    const artifact = join(directory, 'deepseek-harness.exe')
    writeFileSync(artifact, 'installer')
    const { upgrade, commands } = make(CHECK, { findArtifact: () => artifact })
    await upgrade.check()
    const run = upgrade.build()
    expect(run).toMatchObject({ state: 'preparing', sha: C, artifact: null })
    await vi.waitFor(() => { expect(upgrade.view().run?.state).toBe('done') })
    expect(commands).toContain('pnpm run package:desktop:win:x64:unsigned')
    expect(upgrade.view().run).toMatchObject({ state: 'done', artifact,
      steps: [{ name: 'fetch', state: 'done' }, { name: 'verify', state: 'done' }, { name: 'build', state: 'done' }, { name: 'locate', state: 'done' }] })
    expect(upgrade.view().ready).toMatchObject({ sha: C, artifact })
  })

  it('fails the run with the step and keeps the error for the panel', async () => {    const { upgrade } = make(CHECK, { findArtifact: () => undefined })
    await upgrade.check()
    upgrade.build()
    await vi.waitFor(() => { expect(upgrade.view().run?.state).toBe('failed') })
    expect(upgrade.view().run?.error).toContain('no installer was found')
    expect(upgrade.view().ready).toBeNull()
  })

  it('applies the finished build over the install directory and restarts it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-app-apply-'))
    directories.push(directory)
    const artifact = join(directory, 'deepseek-harness-unsigned.exe')
    writeFileSync(artifact, 'installer')
    const app = join(directory, 'win-unpacked')
    mkdirSync(join(app, 'resources', 'app.asar'), { recursive: true })
    writeFileSync(join(app, 'resources', 'app.asar', 'package.json'), '{}')
    let launched: string | undefined
    const { upgrade } = make(CHECK, { findArtifact: () => artifact, appRoot: () => 'C:/installed', launch: script => { launched = script } })
    await upgrade.check()
    upgrade.build()
    await vi.waitFor(() => { expect(upgrade.view().run?.state).toBe('done') })
    expect(upgrade.view().ready).toMatchObject({ app, target: 'C:/installed' })
    expect(upgrade.apply()).toEqual({ started: true })
    expect(launched).toBeDefined()
    const script = readFileSync(launched!, 'utf8')
    expect(script).toContain(app)
    expect(script).toContain('C:/installed')
    expect(script).toContain('robocopy')
  })

  it('refuses to apply before a build finished', () => {
    const { upgrade } = make()
    expect(() => upgrade.apply()).toThrow(AppUpgradeRefused)
  })

  it('marks a build a previous host left running as interrupted on the next start', () => {
    const { upgrade, stateDir } = make()
    mkdirSync(join(stateDir, 'app-upgrade'), { recursive: true })
    writeFileSync(join(stateDir, 'app-upgrade', 'status.json'), JSON.stringify({ state: 'preparing', sha: C, startedAt: new Date().toISOString(),
      steps: [], error: null, artifact: null }))
    const next = new AppUpgrade({ config: { ...NO_UPGRADE, appCheckout: 'C:/dsh' }, stateDir, warn: () => {} })
    expect(next.view().run?.state).toBe('interrupted')
    expect(upgrade).toBeDefined()
  })
})

describe('installer discovery', () => {
  it('returns the newest installer written since the build started', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-app-artifacts-'))
    directories.push(directory)
    const old = join(directory, 'old.exe'), fresh = join(directory, 'new.exe')
    writeFileSync(old, 'old'); writeFileSync(fresh, 'new')
    const now = Date.now()
    utimesSync(old, new Date(now - 60_000), new Date(now - 60_000))
    utimesSync(fresh, new Date(now), new Date(now))
    expect(newestInstaller('C:/dsh', directory, now - 1_000)).toBe(fresh)
    expect(newestInstaller('C:/dsh', directory, now + 1_000)).toBeUndefined()
  })
})
