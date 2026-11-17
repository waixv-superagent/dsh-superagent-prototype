/** The read-only Sentry tool: configuration, search query building, GUID resolution, issue/event reads, and refusals. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventIdOf, readSentryEvent, readSentryIssue, searchSentry, sentryConfig, sentryTool, stackQuery } from '../src/app/tools/sentry.ts'

const TOKEN = 'test-token'
const ORG = 'my-org'
const URL = 'http://sentry.example'
const CONFIG = { url: URL, org: ORG, token: TOKEN }
const EVENT_ID = '7c3eb8a7d1fc454c8e09edfacd7c0c7f'
const ISSUE = { id: '10591', shortId: 'MY_PROJECT-ABC', title: 'SomeNamespace::SomeFunction', level: 'error',
  status: 'unresolved', count: '12', userCount: 5, firstSeen: '2026-11-01T00:00:00Z', lastSeen: '2026-11-17T02:51:33Z',
  permalink: `${URL}/organizations/sentry/issues/10591/`, project: { slug: 'my-project', name: 'my-project' } }
const EVENT = { eventID: EVENT_ID, groupID: '10591', dateCreated: '2026-11-17T02:51:33Z',
  entries: [{ type: 'message', data: { formatted: 'Assert Failed: SelectorFragment' } },
    { type: 'exception', data: { values: [{ stacktrace: { frames: [
      { function: 'RaiseException', package: 'C:\\Windows\\System32\\KERNELBASE.dll' },
      { function: 'SomeNamespace::SomeFunction', filename: 'SomeFile.cpp', lineNo: 1104, inApp: true },
    ] } }] } }],
  tags: [{ key: 'BranchName', value: '//my/mainline' }, { key: 'user', value: 'id:abc' }],
  user: { id: 'abc', username: 'someone' },
  contexts: { unreal: { crash_guid: 'UECC-Windows-0123456789ABCDEF0123456789ABCDEF_0000', crash_type: 'Assert',
    build_version: 'MyEditor-123', crash_reporter_message: 'Attended' } } }

const signal = (): AbortSignal => new AbortController().signal
/** A fetch stand-in that answers by URL pattern, and records every URL it was asked for. */
function serve(routes: [pattern: RegExp, body: unknown, status?: number][]) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const route = routes.find(([pattern]) => pattern.test(url))
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return new Response(JSON.stringify(route[1]), { status: route[2] ?? 200 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const urls = (fetch: ReturnType<typeof serve>): string[] => fetch.mock.calls.map(([input]) => String(input))

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('configuration', () => {
  it('reads the token, URL and organization from the deployment environment and needs all three', () => {
    expect(sentryConfig({})).toBeUndefined()
    expect(sentryConfig({ SENTRY_AUTH_TOKEN: '  ' })).toBeUndefined()
    expect(sentryConfig({ SENTRY_AUTH_TOKEN: 't' })).toBeUndefined()
    expect(sentryConfig({ SENTRY_AUTH_TOKEN: 't', SENTRY_URL: 'https://s.example' })).toBeUndefined()
    expect(sentryConfig({ SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'team' })).toBeUndefined()
    expect(sentryConfig({ SENTRY_AUTH_TOKEN: ' t ', SENTRY_URL: ' https://s.example/// ', SENTRY_ORG: ' team ' }))
      .toEqual({ url: 'https://s.example', org: 'team', token: 't' })
  })
  it('refuses an unknown operation, an unknown field and a limit outside its bounds', async () => {
    const tool = sentryTool()
    const run = (args: unknown) => tool.execute(args as never, signal())
    await expect(run({ op: 'delete' })).rejects.toThrow()
    await expect(run({ op: 'search', query: 'x', unknown: 1 })).rejects.toThrow()
    await expect(run({ op: 'search', query: 'x', limit: 21 })).rejects.toThrow()
    await expect(run({ op: 'search', query: 'x', limit: 0 })).rejects.toThrow()
  })
  it('refuses every call while the deployment configuration is incomplete', async () => {
    // The host that builds an update may itself carry the deployment's Sentry variables, which the test runner inherits:
    // this test is about an incomplete environment, so it clears them instead of reading the host's real configuration.
    vi.stubEnv('SENTRY_AUTH_TOKEN', '')
    vi.stubEnv('SENTRY_URL', '')
    vi.stubEnv('SENTRY_ORG', '')
    await expect(sentryTool().execute({ op: 'search', query: 'is:unresolved' }, signal()))
      .rejects.toThrow('set SENTRY_AUTH_TOKEN, SENTRY_URL and SENTRY_ORG in the deployment environment')
  })
  it('reads an event id with or without the worker- prefix, and builds a quoted wildcard stack filter', () => {
    expect(eventIdOf(EVENT_ID)).toBe(EVENT_ID)
    expect(eventIdOf(`worker-${EVENT_ID.toUpperCase()}`)).toBe(EVENT_ID)
    expect(eventIdOf('UECC-Windows-0123456789ABCDEF0123456789ABCDEF_0000')).toBeUndefined()
    expect(stackQuery(' SomeNamespace::SomeFunction ', 'function')).toBe('stack.function:"*SomeNamespace::SomeFunction*"')
    expect(stackQuery('Some File.cpp', 'filename')).toBe('stack.filename:"*Some File.cpp*"')
    expect(stackQuery('bad"quote', 'function')).toBe('stack.function:"*bad quote*"')
  })
})

describe('search', () => {
  it('searches issues with the query, window, limit and project parameter, and returns compact issues', async () => {
    const fetch = serve([[/\/organizations\/[^/]+\/projects\//, [{ id: '7', slug: 'my-project' }]], [/\/issues\/\?/, [ISSUE]]])
    const result = await searchSentry(CONFIG, { query: 'is:unresolved', project: 'my-project', period: '14d', limit: 3 }, signal())
    const asked = urls(fetch)
    expect(asked[1]).toContain(`/api/0/organizations/${ORG}/issues/?query=${encodeURIComponent('is:unresolved')}`)
    expect(asked[1]).toContain('&limit=3&statsPeriod=14d&project=7')
    expect(result).toMatchObject({ matched: 'issue_search', count: 1, issues: [expect.objectContaining({ short_id: 'MY_PROJECT-ABC',
      project: 'my-project', count: 12, users: 5, permalink: `${URL}/organizations/sentry/issues/10591/` })] })
    // The token never leaves the Authorization header of the request.
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
  it('builds a stack filter from a function or file name', async () => {
    const fetch = serve([[/\/issues\/\?/, [ISSUE]]])
    await searchSentry(CONFIG, { stack: 'SomeFunction' }, signal())
    expect(urls(fetch)[0]).toContain(encodeURIComponent('stack.function:"*SomeFunction*"'))
    await searchSentry(CONFIG, { stack: 'SomeFile.cpp', stackKind: 'filename' }, signal())
    expect(urls(fetch)[1]).toContain(encodeURIComponent('stack.filename:"*SomeFile.cpp*"'))
  })
  it('resolves an event id to the issue that contains it, with that issue\'s latest crash facts', async () => {
    const fetch = serve([[/\/eventids\//, { groupId: '10591', eventId: EVENT_ID, projectSlug: 'my-project' }],
      [/\/issues\/10591\/events\/latest\//, EVENT], [/\/issues\/10591\/$/, ISSUE]])
    const result = await searchSentry(CONFIG, { guid: `worker-${EVENT_ID}` }, signal()) as { matched: string; issues: { latest_event: Record<string, unknown> }[] }
    expect(result.matched).toBe('event_id')
    expect(urls(fetch)[0]).toBe(`${URL}/api/0/organizations/${ORG}/eventids/${EVENT_ID}/`)
    expect(result.issues[0]!.latest_event).toMatchObject({ event_id: EVENT_ID, crash_guid: 'UECC-Windows-0123456789ABCDEF0123456789ABCDEF_0000',
      crash_type: 'Assert', build_version: 'MyEditor-123', user: { username: 'someone' },
      // The top of the stack comes first for a reader.
      stack: ['SomeNamespace::SomeFunction (SomeFile.cpp:1104)', 'RaiseException (C:\\Windows\\System32\\KERNELBASE.dll)'],
      permalink: `${URL}/organizations/sentry/issues/10591/events/${EVENT_ID}/` })
  })
  it('searches a GUID Sentry does not index as text, answering an empty list instead of an error', async () => {
    const fetch = serve([[/\/issues\/\?/, []]])
    const result = await searchSentry(CONFIG, { guid: 'UECC-Windows-0123456789ABCDEF0123456789ABCDEF_0000' }, signal())
    expect(urls(fetch)[0]).toContain(encodeURIComponent('UECC-Windows-0123456789ABCDEF0123456789ABCDEF_0000'))
    expect(result).toMatchObject({ matched: 'issue_search', count: 0, issues: [] })
  })
  it('refuses a search without a selector', async () => {
    await expect(searchSentry(CONFIG, {}, signal())).rejects.toThrow('search needs query, guid or stack')
  })
  it('names a project Sentry does not have', async () => {
    serve([[/\/projects\//, [{ id: '7', slug: 'my-project' }]]])
    await expect(searchSentry(CONFIG, { query: 'is:unresolved', project: 'nope' }, signal()))
      .rejects.toThrow('Sentry has no project "nope"; its projects are my-project')
  })
})

describe('reading one issue or event', () => {
  it('reads an issue by short id through the short-id endpoint', async () => {
    const fetch = serve([[/\/shortids\/MY_PROJECT-ABC\//, { groupId: '8566', projectSlug: 'my-project' }],
      [/\/issues\/8566\/events\/latest\//, EVENT], [/\/issues\/8566\/$/, { ...ISSUE, id: '8566', shortId: 'MY_PROJECT-ABC' }]])
    const result = await readSentryIssue(CONFIG, 'MY_PROJECT-ABC', signal()) as Record<string, unknown>
    expect(urls(fetch)[0]).toBe(`${URL}/api/0/organizations/${ORG}/shortids/MY_PROJECT-ABC/`)
    expect(result).toMatchObject({ short_id: 'MY_PROJECT-ABC', project_slug: 'my-project', latest_event: { event_id: EVENT_ID } })
  })
  it('reads an issue by numeric id and by link without the short-id endpoint', async () => {
    for (const ref of ['8566', `${URL}/organizations/sentry/issues/8566/`]) {
      const fetch = serve([[/\/issues\/8566\/events\/latest\//, EVENT], [/\/issues\/8566\/$/, { ...ISSUE, id: '8566', shortId: 'MY_PROJECT-ABC' }]])
      const result = await readSentryIssue(CONFIG, ref, signal()) as Record<string, unknown>
      expect(result).toMatchObject({ id: '8566', short_id: 'MY_PROJECT-ABC' })
      expect(urls(fetch).some(url => url.includes('/shortids/'))).toBe(false)
      vi.unstubAllGlobals()
    }
  })
  it('reads one event by id and names its issue', async () => {
    serve([[/\/eventids\//, { groupId: '10591', eventId: EVENT_ID, projectSlug: 'my-project', event: EVENT }], [/\/issues\/10591\/$/, ISSUE]])
    const result = await readSentryEvent(CONFIG, `worker-${EVENT_ID}`, signal()) as Record<string, unknown>
    expect(result).toMatchObject({ event_id: EVENT_ID, project: 'my-project', crash_guid: 'UECC-Windows-0123456789ABCDEF0123456789ABCDEF_0000',
      issue: { short_id: 'MY_PROJECT-ABC' } })
  })
  it('refuses text that is not an event id', async () => {
    await expect(readSentryEvent(CONFIG, 'not-an-event', signal())).rejects.toThrow('is not a Sentry event id: 32 hexadecimal characters')
  })
})

describe('failures', () => {
  it('surfaces Sentry\'s own message without the token', async () => {
    serve([[/\/issues\/\?/, { detail: 'Invalid token' }, 401]])
    const failure = await searchSentry(CONFIG, { query: 'is:unresolved' }, signal()).catch((error: Error) => error)
    expect(String(failure)).toContain('Sentry answered 401')
    expect(String(failure)).toContain('Invalid token')
    expect(String(failure)).not.toContain(TOKEN)
  })
  it('refuses an answer that is not JSON, such as a login page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>login</html>', { status: 200 })))
    await expect(searchSentry(CONFIG, { query: 'is:unresolved' }, signal())).rejects.toThrow('Sentry did not answer JSON')
  })
})


