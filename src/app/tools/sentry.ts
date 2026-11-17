/** The deployment's read-only Sentry view for Executor Sessions: search crash issues by text, stack or event GUID, and read one issue or event with its stack, crash GUID and tags. */
import { z } from 'zod'
import type { Tool } from './tool.ts'

const DEFAULT_PERIOD = '90d'
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const TIMEOUT_MS = 30_000
const STACK_FRAMES = 12
const MESSAGE_CHARS = 1_200
/** The windows Sentry's issue search accepts here; its project-scoped list endpoint takes fewer, so searches use the organization endpoint. */
export const PERIODS = ['24h', '7d', '14d', '30d', '90d'] as const
/** The 32 hexadecimal characters of a Sentry event id, with the `worker-` prefix dsh-superagent puts on its Session ids removed. */
const GUID = /^(?:worker-)?([0-9a-f]{32})$/i

export interface SentryConfig { url: string; org: string; token: string }

/** The deployment's Sentry settings from its process environment; undefined until all three are set. The token stays in the host: DSH strips credentials from worker shells. */
export function sentryConfig(env: NodeJS.ProcessEnv = process.env): SentryConfig | undefined {
  const token = env.SENTRY_AUTH_TOKEN?.trim()
  const url = env.SENTRY_URL?.trim().replace(/\/+$/, '')
  const org = env.SENTRY_ORG?.trim()
  if (!token || !url || !org) return undefined
  return { url, org, token }
}

/** The event id a GUID names, with a `worker-` prefix removed; undefined when the text is not an event id. */
export function eventIdOf(text: string): string | undefined {
  return GUID.exec(text.trim())?.[1]?.toLowerCase()
}

/** A wildcard stack filter, quoted so a function name with `::`, `<>` or a path with spaces stays one value. */
export function stackQuery(text: string, kind: 'function' | 'filename'): string {
  const value = text.trim().replace(/["\\*]/g, ' ').replace(/\s+/g, ' ').trim()
  return `stack.${kind}:"*${value}*"`
}

interface Issue { id: string; shortId: string; title: string; level: string; status: string; count: string | number; userCount: number
  firstSeen: string; lastSeen: string; permalink: string; project?: { slug?: string; name?: string } }
interface Tag { key: string; value: string }
interface Frame { function?: string | null; symbol?: string | null; module?: string | null; package?: string | null
  filename?: string | null; lineNo?: number | null; inApp?: boolean | null }
interface SentryEvent { eventID?: string; groupID?: string; projectID?: string; dateCreated?: string; message?: string
  entries?: { type: string; data?: { formatted?: string; values?: { stacktrace?: { frames?: Frame[] } }[] } }[]
  tags?: Tag[]; user?: { id?: string; username?: string; email?: string }
  contexts?: { unreal?: { crash_guid?: string; crash_type?: string; build_version?: string; crash_reporter_message?: string } } }

const clip = (text: string, chars = MESSAGE_CHARS): string => text.length > chars ? `${text.slice(0, chars)}…` : text

/** One request against the Sentry API, with the deployment token; failures name the status and Sentry's own message. */
async function request(config: SentryConfig, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${config.url}${path}`, { headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) })
  const text = await response.text()
  if (!response.ok) {
    let detail = text
    try {
      const value = JSON.parse(text) as { detail?: unknown; error?: unknown }
      const message = value.detail ?? value.error
      detail = typeof message === 'string' ? message : message === undefined ? text : JSON.stringify(message)
    } catch { /* Not JSON. */ }
    throw new Error(`Sentry answered ${response.status} for ${path}: ${detail.slice(0, 300)}`)
  }
  try { return JSON.parse(text) as unknown } catch { throw new Error(`Sentry did not answer JSON for ${path}; check SENTRY_URL and the token`) }
}

/** The project id a slug names, from the one organization listing; a numeric value passes through. */
async function projectId(config: SentryConfig, project: string, signal: AbortSignal): Promise<string> {
  if (/^\d+$/.test(project)) return project
  const projects = await request(config, `/api/0/organizations/${encodeURIComponent(config.org)}/projects/`, signal) as { id: string; slug: string }[]
  const found = projects.find(item => item.slug === project)
  if (!found) throw new Error(`Sentry has no project "${project}"; its projects are ${projects.map(item => item.slug).join(', ')}`)
  return String(found.id)
}

/** The compact shape a search returns, so a list stays readable in a Session's context. */
function issueOf(issue: Issue) {
  return { id: String(issue.id), short_id: issue.shortId, title: issue.title, project: issue.project?.slug ?? '', level: issue.level,
    status: issue.status, count: Number(issue.count), users: Number(issue.userCount), first_seen: issue.firstSeen, last_seen: issue.lastSeen,
    permalink: issue.permalink }
}

/** The crash facts a Ticket's investigation needs from one event: what failed, where, for which build and machine. */
function eventOf(event: SentryEvent, permalink: string) {
  const message = clip(event.entries?.find(entry => entry.type === 'message')?.data?.formatted ?? event.message ?? '')
  const values = event.entries?.find(entry => entry.type === 'exception')?.data?.values
  const frames = values?.[0]?.stacktrace?.frames ?? []
  const stack = [...frames].reverse().slice(0, STACK_FRAMES).map(frame => {
    const name = frame.function || frame.symbol || frame.module || frame.package || '(unknown)'
    // A symbolicated game frame carries its source file; a system frame carries only the module it lives in.
    const location = frame.filename ? `${frame.filename}${frame.lineNo ? `:${frame.lineNo}` : ''}` : frame.module || frame.package || ''
    return location ? `${name} (${location})` : name
  })
  const unreal = event.contexts?.unreal
  return { event_id: event.eventID ?? '', at: event.dateCreated ?? '', message,
    crash_guid: unreal?.crash_guid ?? '', crash_type: unreal?.crash_type ?? '', build_version: unreal?.build_version ?? '',
    reporter_message: unreal?.crash_reporter_message ?? '',
    user: { ...(event.user?.username ? { username: event.user.username } : {}), ...(event.user?.email ? { email: event.user.email } : {}) },
    tags: Object.fromEntries((event.tags ?? []).map(tag => [tag.key, tag.value])), stack,
    permalink: event.eventID ? `${permalink.replace(/\/+$/, '')}/events/${event.eventID}/` : permalink }
}

/** One issue as its own page reports it, with its latest event's crash facts. */
async function issueDetail(config: SentryConfig, id: string, signal: AbortSignal) {
  const issue = await request(config, `/api/0/issues/${encodeURIComponent(id)}/`, signal) as Issue
  const summary = issueOf(issue)
  const event = await request(config, `/api/0/issues/${encodeURIComponent(id)}/events/latest/`, signal) as SentryEvent
  return { ...summary, latest_event: eventOf(event, summary.permalink) }
}

/** The issue that contains an event id, resolved through Sentry's event-id index and then read whole. */
async function issueOfEvent(config: SentryConfig, eventId: string, signal: AbortSignal) {
  const found = await request(config, `/api/0/organizations/${encodeURIComponent(config.org)}/eventids/${eventId}/`, signal) as
    { groupId: string; eventId: string; projectSlug: string }
  return { resolved: { event_id: found.eventId, issue_id: found.groupId, project: found.projectSlug },
    issue: await issueDetail(config, found.groupId, signal) }
}

/** Search issues, resolving a GUID through the event-id index first and reading one issue or event for the other two operations. */
export async function searchSentry(config: SentryConfig, input: { query?: string; guid?: string; stack?: string; stackKind?: 'function' | 'filename'
  project?: string; period?: string; limit?: number }, signal: AbortSignal) {
  const guid = input.guid?.trim() ? input.guid.trim() : undefined
  const eventId = guid === undefined ? undefined : eventIdOf(guid)
  // An event id is the one GUID Sentry indexes; its index answers even when the issue-search text would not.
  if (eventId) {
    const resolved = await issueOfEvent(config, eventId, signal).catch(() => undefined)
    if (resolved) return { query: input.guid!, matched: 'event_id', count: 1, issues: [resolved.issue], resolved: resolved.resolved }
  }
  // A non-hex GUID (such as a Unreal crash GUID) is not indexed; search it as text so the answer is an empty list, not an error.
  const parts = [input.query?.trim(), input.stack?.trim() ? stackQuery(input.stack, input.stackKind ?? 'function') : '', guid ?? ''].filter(Boolean)
  if (!parts.length) throw new Error('search needs query, guid or stack')
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
  // A project is a query parameter, not search text: issue search would read `project:` as one of its own fields.
  const project = input.project?.trim() ? `&project=${await projectId(config, input.project.trim(), signal)}` : ''
  const query = parts.join(' ')
  const path = `/api/0/organizations/${encodeURIComponent(config.org)}/issues/?query=${encodeURIComponent(query)}`
    + `&limit=${limit}&statsPeriod=${encodeURIComponent(input.period ?? DEFAULT_PERIOD)}${project}`
  const issues = await request(config, path, signal) as Issue[]
  return { query, matched: 'issue_search', count: issues.length, issues: issues.map(issueOf) }
}

/** Read one issue by numeric id, short id or issue link. */
export async function readSentryIssue(config: SentryConfig, ref: string, signal: AbortSignal) {
  const text = ref.trim()
  const fromUrl = /\/issues\/(\d+)\/?/.exec(text)?.[1]
  const id = /^\d+$/.test(text) ? text : fromUrl
  if (id) return issueDetail(config, id, signal)
  const short = await request(config, `/api/0/organizations/${encodeURIComponent(config.org)}/shortids/${encodeURIComponent(text)}/`, signal) as
    { groupId: string; projectSlug: string }
  return { ...await issueDetail(config, String(short.groupId), signal), project_slug: short.projectSlug }
}

/** Read one event by its id, its issue and crash facts included. */
export async function readSentryEvent(config: SentryConfig, eventId: string, signal: AbortSignal) {
  const id = eventIdOf(eventId)
  if (!id) throw new Error(`"${eventId}" is not a Sentry event id: 32 hexadecimal characters, optionally prefixed worker-`)
  const found = await request(config, `/api/0/organizations/${encodeURIComponent(config.org)}/eventids/${id}/`, signal) as
    { groupId: string; eventId: string; projectSlug: string; event: SentryEvent }
  const issue = issueOf(await request(config, `/api/0/issues/${encodeURIComponent(found.groupId)}/`, signal) as Issue)
  return { issue, project: found.projectSlug, ...eventOf(found.event, issue.permalink) }
}

/** The Executor Session's Sentry tool: read-only, and refused with a clear message while the deployment holds no token. */
export function sentryTool(): Tool {
  const schema = z.object({
    op: z.enum(['search', 'issue', 'event']).describe('search issues, or read one issue or one event.'),
    query: z.string().trim().max(500).optional()
      .describe('search: a Sentry issue query, such as is:unresolved, level:error, "free text", user.username:<name> or BuildVersion:<value>.'),
    guid: z.string().trim().max(100).optional()
      .describe('search: a Sentry event id (32 hex characters), optionally prefixed worker-; it resolves to the issue that contains that event.'),
    stack: z.string().trim().max(300).optional().describe('search: a function or file name to find in a crash stack.'),
    stack_kind: z.enum(['function', 'filename']).optional().describe('search: whether stack names a function (the default) or a file.'),
    project: z.string().trim().max(64).optional().describe('search: a project slug such as the slugs the instance lists.'),
    stats_period: z.enum(PERIODS).optional().describe('search: the window searched, 90d by default.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('search: how many issues to return, 10 by default.'),
    issue: z.string().trim().max(300).optional().describe('issue: a short id such as MY_PROJECT-ABC, a numeric id or an issue link.'),
    event: z.string().trim().max(100).optional().describe('event: a Sentry event id, 32 hex characters, optionally prefixed worker-.'),
  }).strict()
  return {
    name: 'sentry',
    description: 'Search or read the team\'s Sentry (Unreal crash-report projects), read-only. '
      + 'op=search searches issues: pass a Sentry search query (is:unresolved, level:error, "free text", user.username:<name>, '
      + 'BuildVersion:<value>, BranchName:<branch>), a stack (stack_kind chooses function or filename and a wildcard match is built), '
      + 'or a guid (a Sentry event id, 32 hex characters, optionally worker-<id>: it resolves the issue that contains that event). '
      + 'project, stats_period and limit narrow the search. '
      + 'op=issue reads one issue by short id (MY_PROJECT-ABC), numeric id or link, with its latest event: message, crash_guid, '
      + 'crash type and build from the Unreal context, user, tags and the top stack frames. '
      + 'op=event reads one event by event id and names its issue. '
      + 'An Unreal crash GUID (UECC-Windows-…) is shown on an event but not indexed for search: find that crash by stack or title instead. '
      + 'An unset SENTRY_AUTH_TOKEN, SENTRY_URL or SENTRY_ORG in the deployment environment refuses every call.',
    schema,
    execute: async (raw, signal) => {
      const args = schema.parse(raw)
      const config = sentryConfig()
      if (!config) throw new Error('Sentry is not configured: set SENTRY_AUTH_TOKEN, SENTRY_URL and SENTRY_ORG in the deployment environment (docs/032).')
      if (args.op === 'issue') {
        if (!args.issue) throw new Error('issue needs issue: a short id, numeric id or link')
        return readSentryIssue(config, args.issue, signal)
      }
      if (args.op === 'event') {
        if (!args.event) throw new Error('event needs event: a Sentry event id')
        return readSentryEvent(config, args.event, signal)
      }
      return searchSentry(config, { query: args.query, guid: args.guid, stack: args.stack,
        ...args.stack_kind === undefined ? {} : { stackKind: args.stack_kind },
        ...args.project === undefined ? {} : { project: args.project },
        ...args.stats_period === undefined ? {} : { period: args.stats_period },
        ...args.limit === undefined ? {} : { limit: args.limit } }, signal)
    },
  }
}



