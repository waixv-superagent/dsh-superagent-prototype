/** Resolving a ticket's delivery target from the installation's configured repository and Perforce workspaces. */
import { expect, it } from 'vitest'
import { deliveryKey, deliveryTargets, matchDeliveryTarget, resolveDelivery } from '../src/app/delivery-targets.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { startRuntime } from './fixtures/host.ts'

const REPOSITORY = 'waixv-superagent/dsh-superagent-prototype'
/** The p4 depot and one shared workspace, as this installation configures them, with any executor field overridden. */
const settingsWith = (executor: Record<string, unknown> = {}) => SettingsSchema.parse({ executor: { backend: 'p4',
  p4: { depot: '//sun/mainline' }, workspaces: [{ id: 'sun', directory: 'E:\\sun_mainline', p4Client: 'wanghuaiyang_sun_mainline' }], ...executor } })
const match = (value: string, executor: Record<string, unknown> = {}) =>
  matchDeliveryTarget(value, deliveryTargets(settingsWith(executor), REPOSITORY))
const resolve = (input: { target?: string; source?: string } = {}, executor: Record<string, unknown> = {}) =>
  resolveDelivery({ settings: settingsWith(executor), repository: REPOSITORY, ...input })

it('lists the watched repository as git and the depot with its workspace spellings as p4', () => {
  const [repository, depot] = deliveryTargets(settingsWith(), REPOSITORY)
  expect(repository).toMatchObject({ target: REPOSITORY, backend: 'git' })
  expect(repository!.aliases).toEqual(expect.arrayContaining([REPOSITORY, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`]))
  expect(depot).toEqual({ target: '//sun/mainline', backend: 'p4',
    aliases: ['//sun/mainline', 'sun', 'E:\\sun_mainline', 'wanghuaiyang_sun_mainline'] })
  // An installation that configures neither has no target; a repository alone is still the one git target.
  expect(deliveryTargets(SettingsSchema.parse({}), '')).toEqual([])
  expect(deliveryTargets(SettingsSchema.parse({}), REPOSITORY)).toMatchObject([{ target: REPOSITORY, backend: 'git' }])
})

it('matches a repository by slug, URL or path inside it, and a depot by path, workspace id, directory or client', () => {
  expect(match(REPOSITORY)).toMatchObject({ target: REPOSITORY, backend: 'git' })
  expect(match('https://github.com/waixv-superagent/dsh-superagent-prototype.git')).toMatchObject({ backend: 'git' })
  expect(match('git@github.com:waixv-superagent/dsh-superagent-prototype.git')).toMatchObject({ backend: 'git' })
  expect(match(`${REPOSITORY}/src/app/delivery-targets.ts`)).toMatchObject({ target: REPOSITORY })
  expect(match('//sun/mainline')).toMatchObject({ target: '//sun/mainline', backend: 'p4' })
  expect(match('//sun/mainline/')).toMatchObject({ backend: 'p4' })
  expect(match('\\\\sun\\mainline\\Development\\Programs')).toMatchObject({ target: '//sun/mainline' })
  expect(match('sun')).toMatchObject({ backend: 'p4' })
  expect(match('E:\\sun_mainline')).toMatchObject({ target: '//sun/mainline' })
  expect(match('e:/sun_mainline/Source/Game')).toMatchObject({ target: '//sun/mainline' })
  expect(match('wanghuaiyang_sun_mainline')).toMatchObject({ backend: 'p4' })
  // A value the installation does not configure resolves to nothing, never to a guess.
  expect(match('waixv-superagent/dsh-superagent-other')).toBeUndefined()
  expect(match('//other/mainline')).toBeUndefined()
  expect(match('')).toBeUndefined()
})

it('resolves a source with no target to its own environment, and an explicit target over the source', () => {
  // A GitHub trigger belongs to the watched repository and a TAPD one to the depot, whichever backend the installation defaults to.
  expect(resolve({ source: 'github' })).toEqual({ backend: 'git', target: REPOSITORY })
  expect(resolve({ source: 'tapd' })).toEqual({ backend: 'p4', target: '//sun/mainline' })
  expect(resolve({ source: 'github' }, { backend: 'git' })).toEqual({ backend: 'git', target: REPOSITORY })
  // Anything else keeps the configured backend and records no target.
  expect(resolve({ source: 'feishu' })).toEqual({ backend: 'p4' })
  expect(resolve()).toEqual({ backend: 'p4' })
  // An explicit target wins over what the Source would say, and records the configured spelling, not the one it was given.
  expect(resolve({ target: 'E:\\sun_mainline', source: 'github' })).toEqual({ backend: 'p4', target: '//sun/mainline' })
  expect(resolve({ target: REPOSITORY, source: 'tapd' })).toEqual({ backend: 'git', target: REPOSITORY })
  // Without a configured repository or depot, a Source cannot fix a target and the configured backend applies.
  expect(resolveDelivery({ settings: settingsWith(), repository: '', source: 'github' })).toEqual({ backend: 'p4' })
  expect(resolve({ source: 'tapd' }, { p4: { depot: '' } })).toEqual({ backend: 'p4' })
  // The accept path validates the target first; a value no longer configured falls back instead of guessing.
  expect(resolve({ target: 'unknown' })).toEqual({ backend: 'p4' })
})

it('puts a ticket in its recorded target, or in the target its backend falls back to, so one environment has one limit', () => {
  const settings = settingsWith()
  const execution = { name: '', directory: '', assignment: '' }
  // A ticket accepted since targets existed carries the canonical spelling.
  expect(deliveryKey(settings, REPOSITORY, { execution: { ...execution, backend: 'git', target: REPOSITORY } } as Ticket)).toBe(REPOSITORY)
  expect(deliveryKey(settings, REPOSITORY, { execution: { ...execution, backend: 'p4', target: '//sun/mainline' } } as Ticket)).toBe('//sun/mainline')
  // A ticket accepted before targets existed still counts against the environment its backend runs in.
  expect(deliveryKey(settings, REPOSITORY, { execution: { ...execution, backend: 'p4' } } as Ticket)).toBe('//sun/mainline')
  expect(deliveryKey(settings, REPOSITORY, { execution: { ...execution, backend: 'git' } } as Ticket)).toBe(REPOSITORY)
  // A legacy ticket with no backend takes the configured one, and no execution at all still classifies instead of crashing.
  expect(deliveryKey(settings, REPOSITORY, { execution } as Ticket)).toBe('//sun/mainline')
  expect(deliveryKey(settings, REPOSITORY, undefined)).toBe('//sun/mainline')
  // An installation with no repository keeps a stable key for the configured backend.
  expect(deliveryKey(SettingsSchema.parse({}), '', { execution: { ...execution, backend: 'git' } } as Ticket)).toBe('git')
})

/** A stored Source trigger and the ticket an accept would create for it. */
const accepted = (runtime: { store: { triggers: { save(trigger: Trigger): void } } }, source: string): Ticket => {
  const trigger: Trigger = { id: `tr-${source}-1`, source, threads: [{ source, id: '1' }], actor: { source, id: 'alice' }, human: true,
    at: '2026-09-01T00:00:00Z', text: 'Fix the thing', meta: {} }
  runtime.store.triggers.save(trigger)
  return { id: 'ticket-00000000000000000000000000000001', title: 'Fix', category: 'bug',
    origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { rules: [] }, actor: { source: 'feishu', id: 'ou_a' }, scope: '' } } as unknown as Ticket
}

it('prepares a GitHub accept for the git repository and a TAPD accept for the p4 depot under a p4 default', async () => {
  const runtime = await startRuntime(store => {
    const current = store.settings()
    store.saveSettings({ ...current, executor: { ...current.executor, backend: 'p4', p4: { ...current.executor.p4, depot: '//sun/mainline' } } })
  })
  try {
    const accept = { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-thing' } as const
    const github = runtime.runtime.executor.prepare(accepted(runtime.runtime, 'github'), accept)
    // The deployment defaults to p4, but this ticket's work belongs to the GitHub repository the installation watches.
    expect(github.execution).toMatchObject({ backend: 'git', target: 'acme/widgets' })
    expect(github.phase).toBeUndefined()
    const tapd = runtime.runtime.executor.prepare(accepted(runtime.runtime, 'tapd'), accept)
    expect(tapd.execution).toMatchObject({ backend: 'p4', target: '//sun/mainline' })
    expect(tapd.phase).toBe('plan')
  } finally { await runtime.stop() }
})
