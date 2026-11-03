import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TextCache } from '../src/app/cache.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { snapshot, threadSummary, ticketSummary, triggerView } from '../src/app/views/records.ts'
import { basisFacts, ticketDetail, ticketRow, ticketSearch } from '../src/app/views/tickets.ts'
import { search, threadDetail } from '../src/app/views/threads.ts'
import { droppedReplies, sourcesStatus } from '../src/app/views/sources.ts'
import { editorPage, editorUse, shortTitle } from '../src/app/views/editor.ts'
import { overview } from '../src/app/views/overview.ts'
import { markdown, plain } from '../src/app/views/text.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { KV } from '../src/kv.ts'
import { feishuLink } from '../src/sources/feishu-channel.ts'
import { feishuChannel, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { githubLink } from '../src/sources/github-channel.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { followupOwners, type ChannelRef } from '../src/core/index.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-views-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const links = (channel: ChannelRef) => (channel.source === 'feishu' ? feishuLink : githubLink)(channel.address, {})
const drop = (id: string, channel: ChannelRef, ticketId?: string) => {
  const message = { id, channel, text: id, kind: 'reply' as const, ...ticketId ? { ticketId } : {} }
  store.receipts.add(message)
  store.receipts.settle(message, 'channelGone')
}

it('names the Thread of each dropped message: the one of the Trigger its Channel answers, or the Channel\'s own', () => {
  // A Feishu Channel names its chat; the message it answers belongs to the Thread of the topic's root message.
  store.triggers.save({ id: feishuTriggerId('om_reply'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
    actor: { source: 'feishu', id: 'ou_a' }, human: true, at: new Date().toISOString(), text: 'please', meta: {} })
  store.threads.save({ key: 'github:42', ref: { source: 'github', id: '42' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
    meta: {} })
  drop('a', feishuChannel('oc_1', 'om_reply'))
  drop('b', githubChannel(42))
  // A message whose Trigger and Thread the store no longer has links nowhere.
  drop('c', feishuChannel('oc_2', 'om_gone'))
  expect(Object.fromEntries(droppedReplies({ store, links }).map(item => [item.id, item.thread])))
    .toEqual({ a: 'feishu:oc_1:om_root', b: 'github:42', c: undefined })
})

function views() {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] },
    github: { allowed: [{ id: 'alice' }] } },
    rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind); sources.register(githubKind)
  return { store, sources, links }
}
const at = new Date().toISOString()
/** A live ticket with no Assignment, as a follow-up's owner needs one. */
const live = (id: string) => store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at,
  updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })
const message = (id: string, actor: { source: string; id: string }, human = true) => ({ id, source: actor.source,
  threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor, human, at, text: `message ${id}`, meta: {} })

it('reports the Source a Ticket was accepted from beside its search result', () => {
  const host = views()
  live('a240d309cb49fb2b7180d55d5863be51')
  const ticket = store.tickets.get('a240d309cb49fb2b7180d55d5863be51')!
  store.tickets.save({ ...ticket, title: 'search wording check',
    mandate: { ...ticket.mandate, actor: { source: 'tapd', id: 'bug-9' } } })
  expect(search(host, 'search wording', new TextCache(1000)).tickets.map(hit => [hit.title, hit.source]))
    .toEqual([['search wording check', 'tapd']])
})

it('finds a Ticket by its worker Session id, including the tail a truncated session label shows', () => {
  const host = views()
  const id = 'f4bf326d45f8eb325f342afd3c1a968c'
  live(id)
  store.tickets.save({ ...store.tickets.get(id)!, title: '检查状态标签',
    assignments: [{ id: 'a1', state: 'running' as const, createdAt: at, startedAt: at }] })
  const found = (query: string) => search(host, query, new TextCache(1000)).tickets.map(hit => hit.id)
  expect(found(`worker-${id}`)).toEqual([id])
  expect(found(id)).toEqual([id])
  expect(found(id.slice(7))).toEqual([id])
  // Only hex text of six or more characters is a Session id, and a Ticket whose work never started has none: a word
  // that merely looks like the prefix, or a would-be id, matches nothing.
  expect(found('worker')).toEqual([])
  live('abcdef1234567890')
  store.tickets.save({ ...store.tickets.get('abcdef1234567890')!, title: '还没开工' })
  expect(found('abcdef1234567890')).toEqual([])
  expect(found(id.slice(7, 11))).toEqual([])
})

it('names each sender as the Policy lists it, by its id where the id is readable, and as its kind names one it does not list', () => {
  const view = snapshot(views())
  expect([view.actor({ source: 'feishu', id: 'OU_ALICE' }), view.actor({ source: 'github', id: 'alice' }), view.actor({ source: 'github',
    id: 'bob' }),
    view.actor({ source: 'feishu', id: 'ou_bob' }), view.actor({ source: 'feishu', id: 'ou_bot' }, false), view.actor({ source: 'feishu',
      id: '' })])
    .toEqual([{ source: 'feishu', id: 'OU_ALICE', name: { zh: 'Alice', en: 'Alice' } }, { source: 'github', id: 'alice',
      name: { zh: 'alice', en: 'alice' } },
      { source: 'github', id: 'bob', name: { zh: 'bob', en: 'bob' } }, { source: 'feishu', id: 'ou_bob',
        name: feishuKind.policy!.unnamed!.person },
      { source: 'feishu', id: 'ou_bot', name: feishuKind.policy!.unnamed!.bot }, { source: 'feishu', id: '' }])
  expect(view.rule('copy')).toEqual({ id: 'copy', name: 'Copy fixes' })
  expect(view.rule('gone')).toEqual({ id: 'gone', name: 'gone' })
})

it('classifies a Thread by what it is doing, and offers a filtered Trigger of a person to Eval again', () => {
  const host = views()
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
    correlated: [],
    pending: ['e2'], meta: {} })
  store.triggers.save(message('e1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.save(message('e2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.save(message('e3', { source: 'feishu', id: 'ou_bot' }, false))
  for (const id of ['e1', 'e3']) store.triggers.saveDisposition(id, { filtered: { code: 'not_a_member' }, fanout: [], at })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!).stage).toBe('queued')
  const rows = ['e1', 'e2', 'e3'].map(id => triggerView(view, store.triggers.get(id)!))
  // A queued Trigger waits for Eval already, and an automated one is not offered.
  expect(rows.map(row => row.actions.requeue)).toEqual([true, false, false])
  expect(rows[0]!.actor.name).toEqual({ zh: 'Alice', en: 'Alice' })
})

it('states each Source by the first state that holds', () => {
  const host = views()
  const states = (setup: Parameters<typeof sourcesStatus>[2], health: Parameters<typeof sourcesStatus>[1] = {}) =>
    Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
  expect(states({})).toEqual({ feishu: 'starting', github: 'starting' })
  expect(states({}, { feishu: { state: 'ready', detail: '' }, history: { state: 'paused', detail: '' }, cards: { state: 'ready',
    detail: '' }, github: { state: 'error', detail: 'x' } }))
    .toEqual({ feishu: 'paused', github: 'error' })
  const problem = { place: 'deployment', code: 'stateDirUnset', values: {}, detail: '' } as never
  expect(states({ problem }, { feishu: { state: 'ready', detail: '' }, history: { state: 'ready', detail: '' }, github: { state: 'ready',
    detail: '' } }))
    .toEqual({ feishu: 'setup', github: 'setup' })
})

it('follows the Ticket\'s stage: a blocked Ticket a person answered since is working, with no retry, note or turn end', () => {
  const host = views()
  const blocked = { state: 'blocked' as const, summary: 'Needs the design file', at: '2026-09-22T00:01:00Z' }
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit' as const, policyVersion: 'v', basis: { via: 'listed' as const }, actor: { source: 'feishu',
      id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [{ id: 'a1', state: 'running' as const, createdAt: at, startedAt: at,
      report: blocked }],
    inputs: [] as { id: string; kind: 'trigger'; triggerId: string; at: string; human?: true }[] }
  store.tickets.save(ticket)
  const row = ticketSummary(store.tickets.get('t1')!)
  expect(row).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true }, note: { text: 'Needs the design file',
    error: false } })
  expect(ticketDetail(host, 't1')!.assignments[0]).toMatchObject({ turnEndedAt: blocked.at })
  store.tickets.save({ ...ticket, inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:02:00Z', human: true }] })
  const answered = ticketSummary(store.tickets.get('t1')!)
  expect(answered).toMatchObject({ stage: 'working', actions: { retry: false } })
  expect(answered).not.toHaveProperty('note')
  expect(ticketDetail(host, 't1')!.assignments[0]).not.toHaveProperty('turnEndedAt')
})

it('names who verified delivered work, and never reads "completed" as verified by itself', () => {
  const host = views()
  const delivered = { name: 'w', directory: '/w', assignment: '', changelist: 42, verification: 'Automation 19/19 passed' }
  live('t1')
  store.tickets.save({ ...store.tickets.get('t1')!, execution: delivered, verification: { at, state: 'pending' } })
  expect(ticketSummary(store.tickets.get('t1')!)).toMatchObject({ stage: 'person', action: 'verify',
    actions: { verify: true, rework: true, confirm: false }, verification: { state: 'pending' } })
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'human', outcome: 'completed' }, verification: { at, state: 'passed',
    by: 'person' } })
  expect(ticketSummary(store.tickets.get('t1')!)).toMatchObject({ state: 'ended', actions: { verify: false, rework: false },
    provenance: 'person', verification: { state: 'passed' } })
  // A completed ticket with no verification record reads as the worker's own check, not the person's.
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', outcome: 'completed' }, verification: undefined })
  expect(ticketSummary(store.tickets.get('t1')!)).toMatchObject({ provenance: 'agent', actions: { verify: true, rework: false } })
  // A completed analysis ticket with nothing to run locally is an automatic close, not a missed verification.
  store.tickets.save({ ...store.tickets.get('t1')!, execution: { name: 'w', directory: '/w', assignment: '' } })
  expect(ticketSummary(store.tickets.get('t1')!)).toMatchObject({ provenance: 'auto', actions: { verify: false } })
})
it('does not offer a merged pipeline gate again after a person\'s message resumed the ticket', () => {
  const host = views()
  live('t1')
  store.tickets.save({ ...store.tickets.get('t1')!, execution: { name: 'w', directory: '/w', assignment: '', changelist: 42 },
    verification: { at, state: 'passed', by: 'person' }, pipeline: { state: 'merged', at } })
  const resumed = ticketSummary(store.tickets.get('t1')!)
  expect(resumed).toMatchObject({ state: 'open' })
  expect(resumed).not.toHaveProperty('pipeline')
  // An ended ticket keeps the observation for its record; the panel hides the gate on an ended ticket anyway.
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', outcome: 'completed' } })
  expect(ticketSummary(store.tickets.get('t1')!)).toMatchObject({ stage: 'ended', pipeline: { state: 'merged' }, provenance: 'person' })
})
it('does not show a follow-up that reached a ticket as waiting for an Eval, though an older version queued it', () => {
  const host = views()
  live('t1')
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, at })
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: ['f1'], meta: {} })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'subscribed', pending: 0 })
  expect(triggerView(view, store.triggers.get('f1')!).disposition.queued).toBe(false)
  // One a person sent to Eval again waits for it.
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1', 'f2'] })
  expect(threadSummary(snapshot(host), store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'queued', pending: 1 })
})

it('archives completed Tickets from the board after seven days but keeps them in search', () => {
  const host = views()
  live('t1')
  store.tickets.save({ ...store.tickets.get('t1')!, title: '旧交付', execution: { name: 'w', directory: '/w', assignment: '', changelist: 7001 },
    verification: { at: '2026-10-01T00:00:00.000Z', state: 'passed', by: 'person' },
    ended: { at: '2026-10-01T00:00:00.000Z', by: 'executor', outcome: 'completed' } })
  live('t2')
  store.tickets.save({ ...store.tickets.get('t2')!, title: '新交付', execution: { name: 'w', directory: '/w', assignment: '', changelist: 7002 },
    verification: { at: new Date().toISOString(), state: 'passed', by: 'person' },
    ended: { at: new Date().toISOString(), by: 'executor', outcome: 'completed' } })
  const page = overview(host, {}, 'v1', load)
  expect(page.ended.map(ticket => ticket.title)).toEqual(['新交付'])
  expect(page.endedStats).toMatchObject({ completed: 1, archived: 1 })
  expect(ticketSearch(host, '7001').tickets[0]).toMatchObject({ archived: true, ticket: { title: '旧交付' } })
})

const load = { running: 0, queued: 0 }
// The overview carries the editor row when the host has probed it; the panel hides the row while it is null.
it('carries the editor occupancy row into the overview', () => {
  const host = views()
  expect(overview(host, {}, 'v1', load).editor).toBeNull()
  expect(overview(host, {}, 'v1', load, undefined, { holder: 'person', activity: 'editing', since: at, pid: 7, build: null,
    at }).editor)
    .toMatchObject({ holder: 'person', pid: 7, since: at })
})

it('lists the working Tickets with their live tool on the editor page, live first, and keeps verification out of decisions', () => {
  const host = views()
  const recent = new Date(Date.now() - 10 * 60_000).toISOString()
  const running = { id: 'a1', state: 'running' as const, createdAt: recent, startedAt: recent }
  live('queued')
  live('quiet'); store.tickets.save({ ...store.tickets.get('quiet')!, assignments: [running] })
  live('build'); store.tickets.save({ ...store.tickets.get('build')!, assignments: [running] })
  live('asks'); store.tickets.save({ ...store.tickets.get('asks')!, attention: { id: 'q1', question: 'Which colour?' } })
  live('check'); store.tickets.save({ ...store.tickets.get('check')!, assignments: [running],
    execution: { name: 'w', directory: '/w', assignment: '', changelist: 42 }, verification: { at, state: 'pending' } })
  const tools: Record<string, { name: string; digest: string }> = { build: { name: 'Bash', digest: 'E:/game/CompileSunGame.bat -target' },
    quiet: { name: 'Read', digest: 'src/app/editor.ts' } }
  const activity = { read: (id: string) => {
    if (id === 'queued') throw new Error('no buffer')
    const tool = tools[id]
    return tool ? { live: id === 'build', updatedAt: 1, tool: { ...tool, elapsed: 1000 }, recent: [] }
      : { live: false, updatedAt: 0, tool: null, recent: [] }
  } }
  const editor = { holder: 'person' as const, activity: 'editing' as const, since: recent, pid: 7, build: null, at }
  const page = editorPage(host, activity, editor, { running: 1, queued: 1, maxWorkers: 3 })
  expect(page.editor).toBe(editor)
  expect(page.executor).toEqual({ running: 1, queued: 1, maxWorkers: 3 })
  expect(page.counts).toEqual({ working: 3, queued: 1, person: 1, verification: 1 })
  expect(page.working.map(row => [row.ticket.id, row.queued, row.usesEditor])).toEqual([['build', false, true], ['quiet', false, false],
    ['queued', true, false]])
  expect(page.working.map(row => row.use)).toEqual(['uses', 'not', 'unknown'])
  // The last-hour timeline is built from the editor's process start and the workers' recorded runs.
  expect(page.timeline.editor.map(band => band.tone)).toEqual(['person'])
  expect(page.timeline.workers.map(row => row.id)).toEqual(['build', 'quiet'])
  expect(page.timeline.workers.map(row => row.short)).toEqual(['build', 'quiet'])
  expect(page.timeline.workers.find(row => row.id === 'build')?.bands.map(band => band.tone)).toContain('build')
  expect(page.timeline.workers.find(row => row.id === 'quiet')?.bands.map(band => band.tone)).toEqual(['run'])
  // A worker whose activity cannot be read is shown as not live rather than failing the page.
  expect(page.working[2]!.activity).toEqual({ live: false, updatedAt: 0, tool: null, recent: [] })
  expect(page.person.map(ticket => ticket.id)).toEqual(['asks'])
  expect(page.verification.map(ticket => ticket.id)).toEqual(['check'])
  expect(editorPage(host, { read: () => { throw new Error('gone') } }, null).editor).toBeNull()
})

it('infers from timestamps which pending-verification Tickets a running build contains, and draws the build band', () => {
  const host = views()
  const now = Date.now()
  const buildSince = new Date(now - 20 * 60_000).toISOString()
  const early = new Date(now - 40 * 60_000).toISOString()
  const late = new Date(now - 5 * 60_000).toISOString()
  const pending = (id: string, verificationAt: string) => {
    live(id)
    store.tickets.save({ ...store.tickets.get(id)!, verification: { at: verificationAt, state: 'pending' } })
  }
  pending('early', early)
  pending('late', late)
  pending('exact', buildSince)
  const editor = { holder: 'build' as const, activity: 'building' as const, since: buildSince, pid: 5,
    build: { pid: 5, since: buildSince }, at }
  const page = editorPage(host, { read: () => ({ live: false, updatedAt: 0, tool: null, recent: [] }) }, editor)
  // Only the Tickets delivered before the build started can be part of it; the one delivered during it cannot, and a
  // delivery at the very start still counts.
  expect(page.build).toMatchObject({ pid: 5, since: buildSince })
  expect([...page.build!.included].sort()).toEqual(['early', 'exact'])
  expect(page.timeline.editor).toEqual([{ id: 'build', tone: 'build', from: buildSince, to: page.timeline.to, title: buildSince }])
  // Without a readable build start there is no inference: the page shows the build but claims no Ticket.
  const unknown = { ...editor, since: null, build: { pid: 5, since: null } }
  expect(editorPage(host, { read: () => ({ live: false, updatedAt: 0, tool: null, recent: [] }) }, unknown).build)
    .toEqual({ pid: 5, since: null, included: [] })
})

it('shortens a lane name to its first clause and reads an MCP editor server as using the editor', () => {
  expect(shortTitle('补 i18n 文案：设置页的保存按钮')).toBe('补 i18n 文案')
  expect(shortTitle('梳理 dsh 与 dsh super agent 的提交并分类')).toBe('梳理 dsh 与 dsh…')
  expect(shortTitle('')).toBe('')
  const tool = (name: string, digest = '') => ({ live: true, updatedAt: 1, tool: { name, digest, elapsed: 1 }, recent: [] })
  expect(editorUse(tool('Bash', 'E:/game/CompileSunGame.bat -target'))).toBe('uses')
  expect(editorUse(tool('mcp__unreal__spawn_actor'))).toBe('uses')
  expect(editorUse(tool('mcp__github__search_issues'))).toBe('unknown')
  expect(editorUse(tool('Read', 'src/app/editor.ts'))).toBe('not')
  expect(editorUse({ live: false, updatedAt: 0, tool: null, recent: [] })).toBe('unknown')
})
const problems = (host: ReturnType<typeof views>, health: Parameters<typeof overview>[1] = {}) =>
  overview(host, health, 'v1', load).problems

it('lists an Eval past its deadline, and as dsh-superagent\'s own errors only parts no Source or Policy sync reports', () => {
  const host = views()
  const evaluating = { id: 'e1', threadKey: 'github:1', triggerIds: ['t1'], strength: 'explicit' as const, actor: { source: 'github',
    id: 'alice' },
    basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '2026-01-01T00:00:00Z',
    deadline: '2026-01-01T00:02:00Z' }
  store.threads.save({ key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: at, subscriptions: [], correlated: [], pending: [],
    evaluating, meta: {} })
  const error = (detail: string) => ({ state: 'error' as const, detail })
  const health = { relay: error('relay failing'), reply: error('reply failing'), feishu: error('socket closed'),
    history: error('read failed'),
    'sync:feishu': error('sync failed'), evals: error('unavailable'), launch: { state: 'ready' as const, detail: '' } }
  const found = problems(host, health)
  expect(found).toContainEqual({ kind: 'eval-overdue', thread: expect.objectContaining({ key: 'github:1', stage: 'evaluating' }) })
  // Effects are dsh-superagent's own; a Source shows its parts and its Policy sync, and the Evals are listed one by one.
  expect(found.filter(item => item.kind === 'runtime-error')).toEqual([{ kind: 'runtime-error', name: 'relay', detail: 'relay failing' },
    { kind: 'runtime-error', name: 'reply', detail: 'reply failing' }])
  expect(found.filter(item => item.kind === 'source-error').map(item => item.source.health.name)).toEqual(['feishu', 'history'])
})

it('says no Source runs when every Source is off, and states a Source missing or off', () => {
  const host = views()
  expect(problems(host).map(item => item.kind)).not.toContain('no-source')
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { feishu: { enabled: false, config: {} }, github: { enabled: false, config: {} },
    jira: { enabled: true, config: { site: 'acme' } } } })
  expect(problems(host).map(item => item.kind)).toContain('no-source')
  expect(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])))
    .toEqual({ feishu: ['off', true], github: ['off', true], jira: ['missing', false] })
})

it('sends text without HTML, entity-encoded tags included, and with images named', () => {
  const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
  expect(plain(text)).toBe('Hello there alert(1) [image] [image]')
  expect(markdown(`**Fix** ${text}\n\n- one`)).toBe('**Fix** Hello there alert(1)  [image] [image]\n\n- one')
  expect(plain('[the docs](https://example.com) and `code` &amp; more')).toBe('the docs and code & more')
})

it('words each settings save by what it changed from the one before, and nothing after a gap in the history', () => {
  const host = views()
  const first = store.settings()
  const allowed = (entries: { id: string; name?: string }[]) => ({ ...first.policy, sources: { ...first.policy.sources,
    feishu: { ...first.policy.sources.feishu!, allowed: entries } } })
  const alice = { id: 'ou_alice', name: 'Alice Liu' }, bob = { id: 'ou_bob', name: 'Bob' }
  store.saveSettings({ ...first, policy: allowed([alice, bob, { id: 'ou_carol' }]), paused: true,
    sources: { ...first.sources, feishu: { enabled: false, config: {} } },
    executor: { ...first.executor, directory: '/srv/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'] } })
  const second = store.settings()
  store.saveSettings({ ...second, policy: allowed([alice, { id: 'ou_carol' }]), paused: false, sources: { ...second.sources,
    feishu: { enabled: true, config: {} } } })
  const changes = (revision: number) => policyHistory(store, host.sources, 'v').items.find(item => item.revision === revision)!.changes
  const revision = store.get(KV.settings.revision)!
  expect(changes(revision - 1)).toEqual([
    { code: 'sourceRowsAdded', source: 'feishu', part: true, field: 'allowed', items: ['Bob', 'ou_carol'] },
    { code: 'sourceRowsChanged', source: 'feishu', part: true, field: 'allowed', items: ['Alice Liu'] },
    { code: 'paused' }, { code: 'executionDirectory', from: '', to: '/srv/work' }, { code: 'prepareCommand' },
    { code: 'blockedCommands', from: '', to: 'rm curl' }, { code: 'sourceDisabled', source: 'feishu' }])
  expect(changes(revision)).toEqual([{ code: 'sourceRowsRemoved', source: 'feishu', part: true, field: 'allowed', items: ['Bob'] },
    { code: 'resumed' }, { code: 'sourceEnabled', source: 'feishu' }])
  // A save whose predecessor is missing from the history has nothing to compare with.
  store.delete(KV.settings.version(revision))
  store.saveSettings({ ...store.settings(), paused: true })
  expect(changes(revision + 1)).toBeNull()
})

it('names a listed bot as the Policy lists it, and gives a bot\'s Mandate a basis fact of its own', () => {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [], bots: [{ id: 'cli_review', name: '评审机器人' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  const view = snapshot({ store, sources, links })
  expect(view.actor({ source: 'feishu', id: 'cli_review' }, false).name).toEqual({ zh: '评审机器人', en: '评审机器人' })
  expect(basisFacts({ via: 'bot', sender: '评审机器人', addressed: 'mention', observation: { mode: 'auto' } }, view.rule).facts)
    .toEqual([{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'addressed', value: 'mention' }, { name: 'mode', value: 'auto' }])
})

it('shows a follow-up that reached a ticket as delivered, the tickets that handed a Trigger back with why, and the Threads a ticket follows for context', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, handbacks: [{ ticketId: 't1', reason: 'Asks for a new feature', at }], at })
  const view = snapshot(host)
  expect(triggerView(view, store.triggers.get('f1')!).disposition).toMatchObject({ delivered: true, queued: false, handbacks: [] })
  // A Trigger handed back goes to Eval as any message on its Thread; the Ticket that handed it back is named by its title once it has one.
  expect(triggerView(view, store.triggers.get('f2')!).disposition).toMatchObject({ delivered: false,
    handbacks: [{ ticketId: 't1', title: 't1', reason: 'Asks for a new feature' }] })
  store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: at, subscriptions: ['t1'], context: ['t1'],
    correlated: [], pending: [], meta: {} })
  expect(threadDetail(host, 'github:7', undefined, 50)?.context).toEqual(['t1'])
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'f1', at }, { id: 'i2', kind: 'trigger', triggerId: 'f2', at }] })
  const page = ticketDetail(host, 't1')!
  expect(Object.fromEntries(page.threads.map(thread => [thread.key, !!thread.context]))).toEqual({ 'feishu:oc_1:om_root': false,
    'github:7': true })
  expect(page.inputs.map(input => input.kind === 'trigger' && input.trigger?.handback)).toEqual([{ reason: 'Asks for a new feature', at },
    undefined])
  expect(triggerView(snapshot(host), store.triggers.get('f2')!).disposition.handbacks[0]?.title).toBe('Fix')
})

it('opens the current question card\'s own message through the client scheme, not a browser landing page', () => {
  const host = views()
  const planUrl = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1&position=7'
  const askedUrl = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=9'
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [feishuChannel('oc_1', 'om_q')], undelivered: [],
    createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [],
    plan: { text: '现象：x', at, waiting: true }, attention: { id: 'a1', question: '先上 A 还是先上 B？' } })
  store.set(KV.feishu.cards, { om_card: { ticketId: 't1', planAt: at, url: planUrl } })
  store.set(KV.feishu.attentionCards, { om_asked: { ticketId: 't1', attentionId: 'a1', at, url: askedUrl } })
  const view = snapshot(host)
  const clientUrl = 'feishu://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=9'
  expect(ticketRow(view, store.tickets.get('t1')!).reply?.url).toBe(clientUrl)
  expect(ticketDetail(host, 't1')!.reply?.url).toBe(clientUrl)
})

it('falls back to the chat\'s client scheme link when the question card link is unknown', () => {
  const host = views()
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [feishuChannel('oc_1', 'om_q')], undelivered: [],
    createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [],
    attention: { id: 'a2', question: '需要你确认这个取舍' } })
  expect(ticketDetail(host, 't1')!.reply?.url).toBe('feishu://applink/client/chat/open?openChatId=oc_1')
})

it('names a bot\'s Mandate as a bot once the Policy no longer lists it', () => {
  const host = views()
  const mandate = { strength: 'inferred' as const, policyVersion: 'v', basis: { via: 'bot' as const,
    observation: { mode: 'auto' as const } },
    actor: { source: 'feishu', id: 'cli_removed' }, scope: '' }
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] })
  expect(ticketDetail(host, 't1')!.mandate.actor).toEqual({ source: 'feishu', id: 'cli_removed', name: feishuKind.policy!.unnamed!.bot })
})

it('finds Tickets by id, CL, review, title or requester, and marks archived completed work', () => {
  const host = views()
  live('t1')
  store.tickets.save({ ...store.tickets.get('t1')!, title: '修复移动普攻后接 Q 技能无法起飞', origin: { triggerId: 'e1', triggerIds: ['e1'] },
    execution: { name: 'w', directory: '/w', assignment: '',
    changelist: 123456, review: '654321' } })
  store.triggers.save(message('e1', { source: 'feishu', id: 'ou_alice' }))
  const byCl = ticketSearch(host, 'CL 123456')
  expect(byCl.tickets[0]).toMatchObject({ ticket: { id: 't1' }, match: { field: 'changelist', text: 'CL 123456' } })
  expect(ticketSearch(host, '654321').tickets[0]).toMatchObject({ match: { field: 'review', text: '654321' } })
  expect(ticketSearch(host, 'Q 技能').tickets[0]).toMatchObject({ match: { field: 'title' } })
  expect(ticketSearch(host, 'Alice').tickets[0]).toMatchObject({ match: { field: 'actor', text: 'Alice' } })
  expect(ticketSearch(host, 'nothing-matches-this').tickets).toEqual([])
  // A completed Ticket leaves the board after seven days but stays searchable, flagged so the panel can say it is archived.
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at: '2026-10-01T00:00:00.000Z', by: 'executor', outcome: 'completed' },
    updatedAt: '2026-10-01T00:00:00.000Z' })
  expect(ticketSearch(host, '123456').tickets[0]).toMatchObject({ archived: true })
})
it('offers a person to send a follow-up to Eval while a ticket decides it, or once nothing did', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  const row = () => triggerView(snapshot(host), store.triggers.get('f1')!)
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: true } })
  // A ticket that ended after its worker had it leaves it to nobody: a person may still send it to Eval.
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: false } })
  // Not once its worker acknowledged it, which took it up; a stop on it decided only the ticket's work.
  store.triggers.saveDisposition('f1', { fanout: ['t1'], acked: ['t1'], at })
  expect(row().actions.requeue).toBe(false)
  store.decisions.save({ id: 'stop', evalId: 'e', threadKey: 'feishu:oc_1:om_root', triggerIds: ['f1'], policyVersion: 'v', at, kind: 'stop',
    reason: [{ code: 'humanStop' }], strength: 'explicit', ticketId: 't1' })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // So once the stop ended the ticket, which let go of the message, as the Engine records it.
  store.triggers.saveDisposition('f1', { fanout: [], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // Once sent, it waits for the Eval.
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1'] })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], requeued: true, at })
  expect(row()).toMatchObject({ actions: { requeue: false }, disposition: { queued: true } })
})

it('reads each ticket a page\'s follow-ups reached once, and nothing for a message no ticket can decide', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [], pending: [], meta: {} })
  for (const id of ['f1', 'f2', 'f3']) {
    store.triggers.save(message(id, { source: 'feishu', id: 'ou_alice' }))
    store.triggers.saveDisposition(id, { fanout: ['t1'], at })
  }
  const view = snapshot(host)
  const tickets = vi.spyOn(store.tickets, 'get')
  expect(['f1', 'f2', 'f3'].map(id => triggerView(view, store.triggers.get(id)!).disposition.delivered)).toEqual([true, true, true])
  expect(tickets).toHaveBeenCalledOnce()
  tickets.mockRestore()
  // A message the ticket handed back is decided by no ticket, which needs no read.
  store.triggers.saveDisposition('f3', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Another change', at }], at })
  const records = { tickets: { get: vi.fn() }, threads: { get: vi.fn() }, triggers: store.triggers }
  expect(followupOwners(store.triggers.get('f3')!, records)).toEqual([])
  expect([records.tickets.get, records.threads.get].map(read => read.mock.calls.length)).toEqual([0, 0])
})

