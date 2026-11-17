import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILD_INFO, dependenciesChanged, installedCommit, onlyVersionFields, parseCommits, Upgrade, UpgradeRefused, type Runner,
  type UpgradeHost } from '../src/app/upgrade.ts'
import { NO_UPGRADE } from '../src/deployment.ts'
import { failedStatus, openSwitchLog, parsePlan, runSwitch, type SwitchIo, type SwitchPlan } from '../scripts/upgrade-switch.mjs'

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40)
const log = (...shas: string[]) => shas.map((sha, index) => [sha, `feat: change ${index}`, 'dev', '2026-11-05T00:00:00+08:00'].join('\x1f')).join('\n')

/** A runner whose git answers from a small table; every command is recorded in order. */
function runner(files: Record<string, string>, git: Record<string, string | Error>, pnpm: Record<string, Error> = {}) {
  const commands: string[] = [], detached: string[][] = []
  const run: Runner = {
    command: async (file, args) => {
      const key = file === 'git' ? args.slice(2).join(' ') : `${file} ${args.join(' ')}`
      commands.push(key)
      if (file !== 'git') { const failure = pnpm[args[0]!]; if (failure) throw failure; return '' }
      // A worktree the fake adds exists as a directory afterwards, which the prepare guard and the restart look for.
      if (args.includes('add') && args.includes('--detach')) files[args.at(-2)!.replaceAll('\\', '/')] = 'worktree'
      const found = Object.entries(git).find(([prefix]) => key.startsWith(prefix))?.[1]
      if (found instanceof Error) throw found
      return found ?? ''
    },
    detach: (file, args) => { detached.push([file, ...args]) },
    read: path => files[path.replaceAll('\\', '/')],
    write: (path, text) => { files[path.replaceAll('\\', '/')] = text },
    exists: path => path.replaceAll('\\', '/') in files,
  }
  return { run, commands, detached, files }
}
function host(run: Runner, overrides: Partial<UpgradeHost> = {}) {
  const pause = vi.fn(async (_paused: boolean) => {})
  const exit = vi.fn()
  let paused = false
  const value: UpgradeHost = { config: { ...NO_UPGRADE, checkout: '/src/fork', install: '/install' }, stateDir: '/state', activeCount: () => 0,
    paused: () => paused, pause: async next => { paused = next; await pause(next) }, url: () => 'http://127.0.0.1:3082', exit,
    warn: () => {}, run, ...overrides }
  return { value, pause, exit }
}
const GIT = { [`rev-parse refs/remotes/origin/main`]: `${C}\n`, [`cat-file -e ${A}`]: '', [`log --max-count=31 --format=%H%x1f%s%x1f%an%x1f%cI ${A}..${C}`]: log(C, B),
  [`diff --name-only ${A} ${C}`]: 'src/app/upgrade.ts\n' }
const installed = (sha: string) => ({ [`/install/${BUILD_INFO}`]: JSON.stringify({ sha }) })
afterEach(() => { vi.useRealTimers() })

describe('update check', () => {
  it('shows no update and runs nothing when no checkout is configured', async () => {
    const { run, commands } = runner({}, {})
    const upgrade = new Upgrade(host(run, { config: NO_UPGRADE }).value)
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ enabled: false, available: false })
    expect(commands).toEqual([])
    expect(() => upgrade.prepare()).toThrow(UpgradeRefused)
  })
  it('lists the commits on the fork branch the installed build lacks, newest first', async () => {
    const { run } = runner(installed(A), GIT)
    const upgrade = new Upgrade(host(run).value)
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ enabled: true, installed: A, available: true, more: false, blocked: null,
      remote: { ref: 'origin/main', sha: C, error: null } })
    expect(upgrade.view().behind.map(commit => commit.sha)).toEqual([C, B])
  })
  it('offers nothing when the installed build is the branch head', async () => {
    const { run } = runner(installed(C), GIT)
    const upgrade = new Upgrade(host(run).value)
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ available: false, behind: [] })
  })
  it('refuses a one-click update that changes dependencies, which the switch cannot install', async () => {
    const pkg = (deps: Record<string, string>) => JSON.stringify({ version: '0.1.0', dependencies: deps })
    const { run } = runner(installed(A), { ...GIT, [`diff --name-only ${A} ${C} -- pnpm-lock.yaml`]: '', [`diff --name-only ${A} ${C}`]: 'package.json\n',
      [`show ${A}:package.json`]: pkg({ zod: '4.4.3' }), [`show ${C}:package.json`]: pkg({ zod: '4.5.0' }) })
    const upgrade = new Upgrade(host(run).value)
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ available: true, blocked: 'dependencies' })
    expect(() => upgrade.prepare()).toThrow('dependencies')
  })
  it('keeps the last good answer and shows the fetch error when the remote cannot be read', async () => {
    const { run } = runner(installed(A), { fetch: new Error('Could not resolve host: github.com') })
    const upgrade = new Upgrade(host(run).value)
    await upgrade.check()
    expect(upgrade.view().remote.error).toContain('Could not resolve host')
    expect(upgrade.view().available).toBe(false)
  })
  it('lists the branch without a range for a build installed by hand, which records no commit', async () => {
    const { run } = runner({}, { ...GIT, [`log --max-count=31 --format=%H%x1f%s%x1f%an%x1f%cI ${C}`]: log(C) })
    const upgrade = new Upgrade(host(run).value)
    await upgrade.check()
    expect(upgrade.view()).toMatchObject({ installed: null, available: true, more: true })
  })
})

describe('update run', () => {
  const settle = async (upgrade: Upgrade, state: string) => { await vi.waitFor(() => { expect(upgrade.view().run?.state).toBe(state) }, { timeout: 5000 }) }
  it('prepares in a detached worktree without touching the running service, then restarts only when asked', async () => {
    const { run, commands, detached, files } = runner(installed(A), GIT)
    let active = 1
    const { value, pause, exit } = host(run, { activeCount: () => active })
    const upgrade = new Upgrade(value)
    await upgrade.check()
    upgrade.prepare()
    await settle(upgrade, 'prepared')
    expect(commands.find(command => command.startsWith('worktree add --detach --force'))?.replaceAll('\\', '/')).toBe(`worktree add --detach --force /state/upgrade/build ${C}`)
    expect(commands.filter(command => command.startsWith('pnpm')).map(command => command.split(' ')[1])).toEqual(['install', 'typecheck', 'test', 'build'])
    // The prepare phase changes nothing a person would notice: no pause, no switch, no exit, and the build stays ready.
    expect(pause).not.toHaveBeenCalled()
    expect(detached).toEqual([])
    expect(exit).not.toHaveBeenCalled()
    expect(upgrade.view()).toMatchObject({ prepared: { sha: C }, available: true, running: 1 })
    expect(JSON.parse(files['/state/upgrade/status.json']!)).toMatchObject({ state: 'prepared', sha: C })
    // Only the explicit restart pauses dispatch and waits for the running ticket.
    upgrade.apply()
    await vi.waitFor(() => { expect(pause).toHaveBeenCalledWith(true) }, { timeout: 5000 })
    expect(detached).toEqual([])
    active = 0
    await settle(upgrade, 'switching')
    expect(detached).toHaveLength(1)
    const plan = JSON.parse(Object.entries(files).find(([path]) => path.endsWith('upgrade/plan.json'))![1]) as SwitchPlan
    expect(plan).toMatchObject({ sha: C, from: A, install: '/install', wasPaused: false, pid: process.pid, url: 'http://127.0.0.1:3082' })
    expect(plan.steps!.map(step => step.name)).toEqual(expect.arrayContaining(['fetch', 'build', 'pause', 'idle']))
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1) }, { timeout: 5000 })
  })
  it('refuses to restart before a build is prepared', async () => {
    const { run } = runner(installed(A), GIT)
    const upgrade = new Upgrade(host(run).value)
    await upgrade.check()
    expect(() => upgrade.apply()).toThrow('not-prepared')
    expect(() => upgrade.apply(true)).toThrow('not-prepared')
    expect(upgrade.view().run).toBeNull()
  })
  it('keeps a prepared build across a host restart, and offers preparing again when its worktree is gone', async () => {
    const { run, files } = runner(installed(A), GIT)
    const startedAt = new Date().toISOString()
    files['/state/upgrade/status.json'] = JSON.stringify({ state: 'prepared', sha: C, from: A, startedAt,
      steps: [{ name: 'build', state: 'done', detail: '', at: startedAt }], error: null })
    files['/state/upgrade/build'] = 'worktree'
    const upgrade = new Upgrade(host(run).value)
    expect(upgrade.view()).toMatchObject({ prepared: { sha: C }, run: { state: 'prepared' } })
    delete files['/state/upgrade/build']
    expect(upgrade.view().prepared).toBeNull()
    await upgrade.check()
    upgrade.prepare()
    await settle(upgrade, 'prepared')
    expect(upgrade.view().prepared).toEqual({ sha: C })
  })
  it('stops at a failed check before touching the running service, and lifts nothing it did not set', async () => {
    const { run, detached, files } = runner(installed(A), GIT, { test: new Error('1 failed') })
    const { value, pause, exit } = host(run)
    const upgrade = new Upgrade(value)
    await upgrade.check()
    upgrade.prepare()
    await settle(upgrade, 'failed')
    expect(upgrade.view().run).toMatchObject({ error: '1 failed' })
    expect(upgrade.view().run!.steps.find(step => step.name === 'test')).toMatchObject({ state: 'failed' })
    expect(pause).not.toHaveBeenCalled()
    expect(detached).toEqual([])
    expect(exit).not.toHaveBeenCalled()
    expect(JSON.parse(files['/state/upgrade/status.json']!)).toMatchObject({ state: 'failed', error: '1 failed' })
  })
  it('keeps the prepared build when the restart gives up waiting, and resumes the dispatch it paused', async () => {
    const { run, detached } = runner(installed(A), GIT)
    let clock = 0, active = 2
    const { value, pause } = host(run, { activeCount: () => active, now: () => clock, config: { ...NO_UPGRADE, checkout: '/src/fork', install: '/install', idleTimeoutMin: 1 } })
    const upgrade = new Upgrade(value)
    await upgrade.check()
    upgrade.prepare()
    await settle(upgrade, 'prepared')
    upgrade.apply()
    await settle(upgrade, 'waiting')
    clock = 2 * 60_000
    await vi.waitFor(() => { expect(upgrade.view().run?.error).toContain('still running') }, { timeout: 5000 })
    // The restart never reached the switch: the build is still prepared and dispatch is resumed, so a person may try again.
    expect(upgrade.view().run).toMatchObject({ state: 'prepared', error: expect.stringContaining('still running') })
    expect(upgrade.view().prepared).toEqual({ sha: C })
    expect(pause.mock.calls).toEqual([[true], [false]])
    expect(detached).toEqual([])
    // A later restart uses the same build rather than preparing it again.
    active = 0
    upgrade.apply(true)
    await settle(upgrade, 'switching')
    expect(detached).toHaveLength(1)
  })
  it('keeps an existing pause in place and tells the switch so', async () => {
    const { run, files } = runner(installed(A), GIT)
    const { value, pause } = host(run, { paused: () => true })
    const upgrade = new Upgrade(value)
    await upgrade.check()
    upgrade.prepare()
    await settle(upgrade, 'prepared')
    upgrade.apply(true)
    await settle(upgrade, 'switching')
    expect(pause).not.toHaveBeenCalled()
    const plan = JSON.parse(Object.entries(files).find(([path]) => path.endsWith('upgrade/plan.json'))![1]) as SwitchPlan
    expect(plan.wasPaused).toBe(true)
  })
  it('refuses a second prepare while one runs, and cancel drops a prepared build', async () => {
    const { run, files } = runner(installed(A), GIT)
    const upgrade = new Upgrade(host(run, { activeCount: () => 1 }).value)
    await upgrade.check()
    upgrade.prepare()
    expect(() => upgrade.prepare()).toThrow('running')
    expect(() => upgrade.apply()).toThrow('not-prepared')
    await settle(upgrade, 'prepared')
    expect(() => upgrade.prepare()).toThrow('prepared')
    expect(await upgrade.cancel()).toBe(true)
    expect(upgrade.view().run?.state).toBe('cancelled')
    expect(JSON.parse(files['/state/upgrade/status.json']!)).toMatchObject({ state: 'cancelled' })
  })
  it('reads a switch that died as down after a restart', async () => {
    const { run, files } = runner(installed(A), GIT)
    const stale = new Date(Date.now() - 21 * 60_000).toISOString()
    files['/state/upgrade/status.json'] = JSON.stringify({ state: 'switching', sha: C, from: A, startedAt: stale, steps: [], error: null })
    expect(new Upgrade(host(run).value).view().run).toMatchObject({ state: 'down' })
  })
  it('shows the outcome a switch writes after the new host started while it was still finalizing', () => {
    const { run, files } = runner(installed(A), GIT)
    const startedAt = new Date().toISOString()
    const switching = { state: 'switching', sha: C, from: A, startedAt, steps: [], error: null }
    files['/state/upgrade/status.json'] = JSON.stringify(switching)
    const upgrade = new Upgrade(host(run).value)
    expect(upgrade.view().run).toMatchObject({ state: 'switching' })
    files['/state/upgrade/status.json'] = JSON.stringify({ ...switching, state: 'done', endedAt: new Date().toISOString(),
      steps: [{ name: 'replace', state: 'done', detail: '', at: startedAt }] })
    expect(upgrade.view().run).toMatchObject({ state: 'done', steps: [{ name: 'replace' }] })
  })
})

describe('pure helpers', () => {
  it('reads the installed commit and the commit log', () => {
    expect(installedCommit(() => JSON.stringify({ sha: A }), '/x')).toBe(A)
    expect(installedCommit(() => 'not json', '/x')).toBeNull()
    expect(installedCommit(() => undefined, '/x')).toBeNull()
    expect(parseCommits(log(A, B)).map(commit => commit.subject)).toEqual(['feat: change 0', 'feat: change 1'])
  })
  it('tells a dependency change from a version bump', () => {
    expect(dependenciesChanged('src/a.ts\npackage.json\n')).toBe(true)
    expect(dependenciesChanged('src/a.ts\n')).toBe(false)
    expect(onlyVersionFields(JSON.stringify({ version: '1', dependencies: { a: '1' } }), JSON.stringify({ version: '2', dependencies: { a: '1' } }))).toBe(true)
    expect(onlyVersionFields(JSON.stringify({ dependencies: { a: '1' } }), JSON.stringify({ dependencies: { a: '2' } }))).toBe(false)
  })
})

/** A switch world: files as a map, and processes as flags the test sets. */
function world({ healthy = [true], exits = true }: { healthy?: boolean[]; exits?: boolean } = {}) {
  const files = new Map<string, string>([['/install/lib', 'old lib'], ['/install/package.json', 'old pkg'], ['/new/lib', 'new lib'],
    ['/new/package.json', 'new pkg'], ['/state/orchestrator.sqlite', 'old db']])
  const events: string[] = []
  const answers = [...healthy]
  // The switch joins paths with node:path, which writes backslashes on Windows.
  const n = (path: string) => path.replaceAll('\\', '/')
  const io: SwitchIo = {
    now: () => '2026-11-05T00:00:00.000Z',
    exists: raw => { const path = n(raw); return [...files.keys()].some(key => key === path || key.startsWith(`${path}/`)) },
    copy: (rawFrom, rawTo) => { const from = n(rawFrom), to = n(rawTo); for (const [key, value] of [...files]) if (key === from || key.startsWith(`${from}/`)) files.set(to + key.slice(from.length), value) },
    remove: raw => { const path = n(raw); for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key) },
    write: (path, text) => { files.set(n(path), text) },
    writeStatus: () => {},
    waitExit: async () => exits,
    kill: pid => { events.push(`kill ${pid}`) },
    start: () => { events.push(`start ${files.get('/install/lib')}`) },
    stopStarted: () => { events.push('stop started') },
    healthy: async () => answers.shift() ?? false,
    resume: async () => { events.push('resume') },
  }
  const plan = parsePlan(JSON.stringify({ sha: C, from: A, source: '/new', install: '/install', stateDir: '/state', backup: '/backup',
    statusFile: '/state/upgrade/status.json', url: 'http://127.0.0.1:3082', pid: 42, start: { argv: ['node', 'dsh'] } }))
  return { files, events, io, plan }
}
const pathed = (plan: SwitchPlan) => ({ ...plan })

describe('switch', () => {
  it('replaces the package, records the commit, starts and resumes', async () => {
    const { files, events, io, plan } = world()
    const status = await runSwitch(pathed(plan), io)
    expect(status).toMatchObject({ state: 'done', rolledBack: false, error: null })
    expect(files.get('/install/lib')).toBe('new lib')
    expect(JSON.parse(files.get(`/install/${BUILD_INFO}`)!)).toMatchObject({ sha: C })
    expect(files.get('/backup/package/lib')).toBe('old lib')
    expect(files.get('/backup/state/orchestrator.sqlite')).toBe('old db')
    expect(events).toEqual(['start new lib', 'resume'])
  })
  it('rolls back the package and the database when the new version does not come up', async () => {
    const { files, events, io, plan } = world({ healthy: [false, true] })
    // The new version migrated the database before it failed.
    const start = io.start
    io.start = spec => { start(spec); if (files.get('/install/lib') === 'new lib') files.set('/state/orchestrator.sqlite', 'migrated db') }
    const status = await runSwitch(pathed(plan), io)
    expect(status).toMatchObject({ state: 'rolledBack', rolledBack: true })
    expect(files.get('/install/lib')).toBe('old lib')
    expect(files.get('/state/orchestrator.sqlite')).toBe('old db')
    expect(JSON.parse(files.get(`/install/${BUILD_INFO}`)!)).toMatchObject({ sha: A })
    expect(events).toEqual(['start new lib', 'stop started', 'start old lib', 'resume'])
  })
  it('reports down when neither version comes up, keeping the backup', async () => {
    const { files, io, plan } = world({ healthy: [false, false] })
    const status = await runSwitch(pathed(plan), io)
    expect(status.state).toBe('down')
    expect(files.get('/backup/package/lib')).toBe('old lib')
  })
  it('changes nothing when the old process does not stop', async () => {
    const { files, events, io, plan } = world({ exits: false })
    const status = await runSwitch(pathed(plan), io)
    expect(status.state).toBe('failed')
    expect(files.get('/install/lib')).toBe('old lib')
    expect(events).toEqual(['kill 42', 'resume'])
  })
  it('leaves a pause it found in place, and a hold file a person created', async () => {
    const { files, events, io, plan } = world()
    files.set('/hold', 'person')
    const status = await runSwitch({ ...plan, wasPaused: true, holdFile: '/hold' }, io)
    expect(status.state).toBe('done')
    expect(events).not.toContain('resume')
    expect(files.get('/hold')).toBe('person')
  })
  it('refuses a plan without a start command', () => {
    expect(() => parsePlan(JSON.stringify({ sha: C, source: '/n', install: '/i', stateDir: '/s', backup: '/b', statusFile: '/f', url: 'u', pid: 1 })))
      .toThrow('start command')
  })
})

describe('switch setup', () => {
  it('falls back to the handles the switch already has when the launcher holds its log', () => {
    expect(openSwitchLog(undefined)).toBe('ignore')
    expect(openSwitchLog('/state/upgrade/switch.log', () => 7)).toBe(7)
    expect(openSwitchLog('/state/upgrade/switch.log', () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    })).toBe('inherit')
  })
  it('records a failed switch when setup dies before the switch starts', () => {
    const plan = parsePlan(JSON.stringify({ sha: C, from: A, source: '/new', install: '/install', stateDir: '/state', backup: '/backup',
      statusFile: '/state/upgrade/status.json', url: 'http://127.0.0.1:3082', pid: 42, start: { argv: ['node', 'dsh'] },
      startedAt: '2026-11-05T00:00:00.000Z', steps: [{ name: 'fetch', state: 'done', detail: '', at: '2026-11-05T00:00:00.000Z' }] }))
    const status = failedStatus(plan, 'EBUSY: resource busy or locked')
    expect(status).toMatchObject({ state: 'failed', sha: C, from: A, error: 'EBUSY: resource busy or locked', rolledBack: false })
    expect(status.steps.map(step => step.name)).toEqual(['fetch'])
  })
})
