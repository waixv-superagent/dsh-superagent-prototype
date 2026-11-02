import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { bugUrl, credentials, isoOf, listBugs, parseBugs, people, plainText, pollRound, readStatuses, received, statusesOf, tapdKind,
  triggerOf, type TapdConfig } from '../src/sources/tapd.ts'

const config = (overrides: Partial<TapdConfig> = {}): TapdConfig => ({ workspaceId: '12345678', owner: 'alice',
  apiBase: 'https://api.tapd.cn', pollSeconds: 300, failuresBeforeError: 3, limit: 300,
  openStatuses: 'new|in_progress|reopened', ...overrides })

const row = (bug: Record<string, unknown>) => ({ Bug: { workspace_id: '12345678', ...bug } })
const page = (bugs: unknown[]) => JSON.stringify({ status: 1, info: 'success', data: bugs })

/** A Source context that only records the Triggers the Source ingests; the polling loop is exercised directly. */
function context(received: Trigger[], answers: ('stored' | 'duplicate')[] = []) {
  let index = 0
  return { receive: async (trigger: Trigger) => { received.push(trigger); return answers[index++] ?? 'stored' } } as unknown as SourceContext
}

beforeAll(() => { process.env.DSH_SUPERAGENT_TAPD_ACCESS_TOKEN = 'test-token' })
afterAll(() => { delete process.env.DSH_SUPERAGENT_TAPD_ACCESS_TOKEN })

describe('TAPD credentials', () => {
  it('prefer the access token, which TAPD only accepts in the Authorization header', () => {
    expect(credentials({ TAPD_ACCESS_TOKEN: 'tok' }).authorization).toBe('Bearer tok')
    expect(credentials({ DSH_SUPERAGENT_TAPD_ACCESS_TOKEN: 'tok' }).authorization).toBe('Bearer tok')
  })
  it('fall back to HTTP Basic with an API account', () => {
    const authorization = credentials({ DSH_SUPERAGENT_TAPD_API_USER: 'u', DSH_SUPERAGENT_TAPD_API_PASSWORD: 'p' }).authorization
    expect(authorization.startsWith('Basic ')).toBe(true)
    expect(Buffer.from(authorization.slice(6), 'base64').toString()).toBe('u:p')
  })
  it('name the missing variables instead of guessing', () => {
    expect(() => credentials({})).toThrow(/DSH_SUPERAGENT_TAPD_API_USER/)
  })
})

describe('TAPD statuses and people', () => {
  it('split a status setting case-insensitively and ignore empty entries', () => {
    expect(statusesOf(' new | IN_PROGRESS ||reopened ')).toEqual(['new', 'in_progress', 'reopened'])
    expect(statusesOf('')).toEqual([])
  })
  it('ask for the workable and the ended statuses, and never for 待 QA 确认', () => {
    expect(readStatuses(config())).toBe('new|in_progress|reopened|resolved|verified|closed|rejected')
    // A workspace with its own pending status keeps it, and the ended ones are appended once.
    expect(readStatuses(config({ openStatuses: 'new|postponed|resolved' }))).toBe('new|postponed|resolved|verified|closed|rejected')
    expect(readStatuses(config())).not.toContain('unconfirmed')
  })
  it('match a person by containment, because a bug may list several owners', () => {
    expect(people('carol;alice')).toEqual(['carol', 'alice'])
    expect(people('alice；dave,bob、erin')).toEqual(['alice', 'dave', 'bob', 'erin'])
    expect(people('alice;')).toEqual(['alice'])
    expect(people('')).toEqual([])
    expect(people('carol;alice')).toContain('alice')
  })
})

describe('TAPD reads', () => {
  it('filter by current_owner, because TAPD silently ignores owner and would return the whole workspace', () => {
    const url = bugUrl(config(), 2)
    expect(url).toContain('current_owner=')
    expect(url).not.toMatch(/[?&]owner=/)
    expect(url).toContain('page=2')
    expect(new URL(url).searchParams.get('current_owner')).toBe('alice')
  })
  it('ask for the workable statuses and the ended ones in one query', () => {
    const url = new URL(bugUrl(config(), 1))
    expect(url.searchParams.get('status')).toBe('new|in_progress|reopened|resolved|verified|closed|rejected')
    // `unconfirmed` is the tester's: reading it would show a bug that is not the person's yet.
    expect(url.searchParams.get('status')).not.toContain('unconfirmed')
    // A deployment whose workflow has another pending status gets it into the query without code changes.
    expect(new URL(bugUrl(config({ openStatuses: 'new|postponed' }), 1)).searchParams.get('status')).toBe('new|postponed|resolved|verified|closed|rejected')
  })
  it('cap the page size at what TAPD serves while `limit` counts bugs across pages', () => {
    expect(new URL(bugUrl(config({ limit: 500 }), 1)).searchParams.get('limit')).toBe('200')
    expect(new URL(bugUrl(config({ limit: 80 }), 1)).searchParams.get('limit')).toBe('80')
  })
  it('normalize a row, preferring the current owner and the readable priority', () => {
    const [bug] = parseBugs(page([row({ id: '11', title: ' Crash on load ', status: 'new', current_owner: 'alice;', reporter: 'bob',
      priority: '3', priority_label: '高', description: '<p>Steps<br/>to&nbsp;repro</p>' })]), config())
    expect(bug).toMatchObject({ id: '11', title: 'Crash on load', status: 'new', owner: 'alice', reporter: 'bob', priority: '高' })
    expect(bug?.description).toBe('Steps\nto repro')
    expect(bug?.url).toBe('https://www.tapd.cn/12345678/bugtrace/bugs/view/11')
  })
  it('report TAPD errors instead of reading them as an empty page', () => {
    expect(() => parseBugs(JSON.stringify({ status: 422, info: 'access_token is not allowed in the url' }), config()))
      .toThrow(/access_token is not allowed/)
    expect(() => parseBugs('<html>', config())).toThrow(/not JSON/)
  })
  it('keep paging through full pages and stop on a short one', async () => {
    // TAPD serves 200 rows a page, so only a limit above that ever needs a second request.
    const first = page(Array.from({ length: 200 }, (_, index) => row({ id: `a${index}`, status: 'closed' })))
    const second = page([row({ id: 'b1', status: 'new' })])
    let calls = 0
    const bugs = await listBugs(config({ limit: 500 }), async () => [first, second][calls++] ?? page([]))
    expect(bugs).toHaveLength(201)
    expect(bugs.at(-1)?.id).toBe('b1')
    expect(calls).toBe(2)
  })
  it('turn HTML into the text an assessment reads, capped', () => {
    expect(plainText('<div>Hello <b>world</b>&amp; friends</div>')).toBe('Hello world & friends')
    expect(plainText('x'.repeat(5000)).length).toBeLessThanOrEqual(4001)
  })
})

describe('TAPD receiving scope', () => {
  const bug = (status: string, modified = '2026-11-02 15:00:00') => parseBugs(page([row({ id: '1', status, modified })]), config())[0]!
  const now = Date.parse('2026-11-02T08:00:00.000Z') // 16:00 Shanghai

  it('receive workable bugs, including a reopened one', () => {
    expect(received(bug('new'), config(), now)).toBe(true)
    expect(received(bug('in_progress'), config(), now)).toBe(true)
    expect(received(bug('reopened'), config(), now)).toBe(true)
  })
  it('receive a just-ended bug so its transition is visible, and drop a stale one', () => {
    expect(received(bug('resolved', '2026-11-02 10:00:00'), config(), now)).toBe(true)
    expect(received(bug('closed', '2026-10-20 10:00:00'), config(), now)).toBe(false)
    expect(received(bug('rejected', '2026-10-20 10:00:00'), config(), now)).toBe(false)
  })
  it('never read a bug that is still waiting for QA', () => {
    expect(received(bug('unconfirmed', '2026-11-02 15:59:00'), config(), now)).toBe(false)
    expect(received(bug('postponed'), config(), now)).toBe(false)
  })
})

describe('TAPD triggers', () => {
  const bug = { id: '42', title: 'Strafe drift', status: 'new', priority: '高', severity: 'normal', owner: 'alice', reporter: 'bob',
    created: '2026-11-01 09:00:00', modified: '2026-11-01 09:30:00', url: 'https://www.tapd.cn/12345678/bugtrace/bugs/view/42', description: 'Repro steps' }

  it('derives the short id from a long id, which is what a P4 description uses', () => {
    const long = { ...bug, id: '1234567890000123456' }
    expect(triggerOf(long, config()).meta).toMatchObject({ bugId: '1234567890000123456', shortId: '123456' })
    // A row that already carries the short id keeps it unchanged.
    expect(triggerOf(bug, config()).meta).toMatchObject({ shortId: '42' })
  })
  it('carry the bug revision so an edited bug is a new trigger and an unchanged one a duplicate', () => {
    const first = triggerOf(bug, config())
    expect(first.id).toMatch(/^tapd:42:\d+$/)
    expect(triggerOf({ ...bug, modified: '2026-11-01 10:00:00' }, config()).id).not.toBe(first.id)
    expect(first).toMatchObject({ source: 'tapd', human: true, addressed: 'direct', url: bug.url,
      threads: [{ source: 'tapd', id: '42' }], actor: { source: 'tapd', id: 'alice' } })
    expect(first.text).toBe('Strafe drift\n\nRepro steps')
    expect(first.meta).toMatchObject({ bugId: '42', workspaceId: '12345678', status: 'new', reporter: 'bob', people: ['alice'] })
  })
  it('speak for the configured person even when the bug lists several owners', () => {
    // "carol;alice" as an actor never matched the Policy allowlist, so such bugs were silently ignored.
    expect(triggerOf({ ...bug, owner: 'carol;alice' }, config()).actor).toEqual({ source: 'tapd', id: 'alice' })
    // Someone else's multi-owner bug still gets one actor, the first listed.
    expect(triggerOf({ ...bug, owner: 'dave;carol' }, config()).actor).toEqual({ source: 'tapd', id: 'dave' })
  })
  it('use Shanghai wall-clock times as the trigger time', () => {
    expect(isoOf('2026-11-01 09:30:00')).toBe('2026-11-01T01:30:00.000Z')
    expect(isoOf('')).toBe('')
    expect(triggerOf(bug, config()).at).toBe('2026-11-01T01:30:00.000Z')
  })
  it('ingest the bugs that are the person\'s to see and count only the new ones', async () => {
    const received: Trigger[] = []
    const now = Date.parse('2026-11-02T08:00:00.000Z')
    const stored = await pollRound(context(received, ['stored', 'duplicate']), config(), async () => page([
      row({ id: '1', status: 'new' }),
      row({ id: '2', status: 'resolved', modified: '2026-11-02 15:00:00' }),
      row({ id: '3', status: 'unconfirmed', modified: '2026-11-02 15:00:00' }),
      row({ id: '4', status: 'closed', modified: '2026-01-01 00:00:00' }),
    ]), now)
    expect(received.map(trigger => trigger.id.replace(/:\d+$/, ''))).toEqual(['tapd:1', 'tapd:2'])
    expect(stored).toBe(1)
  })
})

describe('TAPD kind', () => {
  it('listens to workable bugs and filters the ended ones with a reason the panel can show', () => {
    expect(tapdKind.scope!({ meta: { status: 'new' } }, config())).toEqual({ listened: true, observed: false })
    expect(tapdKind.scope!({ meta: { status: 'in_progress' } }, config())).toEqual({ listened: true, observed: false })
    expect(tapdKind.scope!({ meta: { status: 'resolved' } }, config())).toEqual({ listened: false, reason: 'bugResolved' })
    expect(tapdKind.scope!({ meta: { status: 'closed' } }, config())).toEqual({ listened: false, reason: 'bugClosed' })
    expect(tapdKind.scope!({ meta: { status: 'postponed' } }, config())).toEqual({ listened: false, reason: 'bugStatus' })
  })
  it('finds a thread by bug id', () => {
    expect(tapdKind.find!('1112345678001286074')).toEqual({ threads: ['tapd:1112345678001286074'], terms: ['1112345678001286074'] })
    expect(tapdKind.find!('crash')).toEqual({ threads: [], terms: [] })
  })
  it('exposes the bug to the executor, and nothing when the ticket came from another source', () => {
    const values = (trigger?: Trigger) => tapdKind.environment!.values({ deployment: {} as never, config: config(), trigger })
    const trigger = triggerOf({ id: '42', title: 't', status: 'new', priority: '', severity: '', owner: 'alice', reporter: '',
      created: '', modified: '', url: 'u', description: '' }, config())
    expect(values(trigger)).toMatchObject({ DSH_SUPERAGENT_TAPD_BUG_ID: '42', DSH_SUPERAGENT_TAPD_BUG_URL: 'u', DSH_SUPERAGENT_TAPD_WORKSPACE: '12345678' })
    expect(values(undefined)).toMatchObject({ DSH_SUPERAGENT_TAPD_BUG_ID: '', DSH_SUPERAGENT_TAPD_BUG_URL: '' })
    expect(values({ ...trigger, threads: [{ source: 'feishu', id: 'x' }] })).toMatchObject({ DSH_SUPERAGENT_TAPD_BUG_ID: '' })
  })
  it('validates its configuration and fills the deployment defaults', () => {
    expect(tapdKind.schema.parse({})).toMatchObject({ workspaceId: '', owner: '', apiBase: 'https://api.tapd.cn' })
    expect(() => tapdKind.schema.parse({ pollSeconds: 30 })).toThrow()
    expect(() => tapdKind.schema.parse({ unexpected: true })).toThrow()
  })
  it('refuses a separated list in one allowlist row, which would match no TAPD nickname', () => {
    const policy = tapdKind.policy!.schema
    expect(() => policy.parse({ allowed: [{ id: 'bob;dave;alice' }] })).toThrow('One person per row')
    expect(policy.parse({ allowed: [{ id: 'alice' }] })).toEqual({ allowed: [{ id: 'alice' }] })
  })
})

