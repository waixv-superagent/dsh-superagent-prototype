/** TAPD source kind: reads the bugs of one person, read-only, and turns every relevant change into a Trigger on a per-bug Thread. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Localized, SourceKind } from './kind.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

/** Source ID, Thread prefix and health entry name of the TAPD kind. */
export const SOURCE = 'tapd'
/**
 * Statuses the person can work right now: 新建, 修复中 and 重新打开. A bug reopened after a failed verification is work again, which is why
 * `reopened` is here even though most flows never use it.
 */
export const DEFAULT_OPEN_STATUSES = 'new|in_progress|reopened'
/**
 * Statuses that end the person's work on a bug: 修复完成, 测试完成, 已关闭 and BUG取消. They are read only so the change is visible — the
 * Source marks them filtered, so the panel shows "修复完成：已经修好，不重复实现" instead of silently dropping the transition, and no work
 * is ever started for an already finished bug.
 */
export const ENDED_STATUSES = ['resolved', 'verified', 'closed', 'rejected'] as const
/**
 * 待 QA 确认 (`unconfirmed`) is in neither set, by design: the bug belongs to the tester until QA hands it back, so the Source does not even
 * read it. The bug reappears on its own once QA moves it to 新建 or 修复中.
 */
/** How long an ended bug stays readable; a restart or a quiet weekend must not swallow the transition that ended the work. */
export const ENDED_WINDOW_MS = 72 * 3600 * 1000
/** TAPD answers at most this many rows per page; `limit` counts bugs across pages, not the page size. */
export const PAGE_SIZE = 200
/** Longest description kept on a Trigger; a longer one is cut, since the Thread reads the bug again when it needs the rest. */
const DESCRIPTION_MAX_CHARS = 4000
/** Why an ended bug is not worked, by status; an unknown status keeps the generic reason. */
const ENDED_REASONS: Record<string, string> = { resolved: 'bugResolved', verified: 'bugVerified', closed: 'bugClosed', rejected: 'bugRejected' }

const TapdConfigSchema = z.object({
  workspaceId: z.string().trim().regex(/^(\d{1,20})?$/).default(''),
  owner: z.string().trim().max(100).default(''),
  apiBase: z.string().trim().regex(/^https?:\/\/[^\s]+$/).default('https://api.tapd.cn'),
  pollSeconds: z.number().int().min(60).max(3600).default(300),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  limit: z.number().int().min(1).max(500).default(300),
  openStatuses: z.string().trim().min(1).max(200).default(DEFAULT_OPEN_STATUSES),
}).strict()
export type TapdConfig = z.infer<typeof TapdConfigSchema>

/** TAPD's long id is the workspace shard followed by the zero-padded short id: 1234567890000123456 -> 123456. */
export const shortIdOf = (id: string): string => id.length > 10 ? id.slice(10).replace(/^0+/, '') : id

/** One TAPD bug as the Source needs it; a missing field stays empty instead of being guessed. */
export interface TapdBug {
  id: string
  /** The short id TAPD shows in its UI: a long id's last shard segment without leading zeros (see the shard_id mapping). */
  shortId?: string
  title: string
  status: string
  priority: string
  severity: string
  owner: string
  reporter: string
  created: string
  modified: string
  url: string
  description: string
}

/** The HTTP authorization a TAPD read uses: a Bearer access token when present, otherwise HTTP Basic with an API user and password. */
export interface Credentials { authorization: string }

/**
 * Resolves the credentials from the environment, never from settings.
 * `DSH_SUPERAGENT_TAPD_ACCESS_TOKEN` or `TAPD_ACCESS_TOKEN` wins over `DSH_SUPERAGENT_TAPD_API_USER`/`DSH_SUPERAGENT_TAPD_API_PASSWORD`
 * (or `TAPD_API_USER`/`TAPD_API_PASSWORD`); a missing pair is named in the error instead of being guessed.
 */
export function credentials(env: Record<string, string | undefined> = process.env): Credentials {
  const token = env.DSH_SUPERAGENT_TAPD_ACCESS_TOKEN || env.TAPD_ACCESS_TOKEN
  if (token) return { authorization: `Bearer ${token}` }
  const user = env.DSH_SUPERAGENT_TAPD_API_USER || env.TAPD_API_USER
  const password = env.DSH_SUPERAGENT_TAPD_API_PASSWORD || env.TAPD_API_PASSWORD
  const missing = [!user ? 'DSH_SUPERAGENT_TAPD_API_USER' : '', !password ? 'DSH_SUPERAGENT_TAPD_API_PASSWORD' : ''].filter(Boolean)
  if (missing.length) {
    throw new Error(`TAPD credentials are missing: set DSH_SUPERAGENT_TAPD_ACCESS_TOKEN (or TAPD_ACCESS_TOKEN), or ${missing.join(' and ')}`)
  }
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
}

/** Splits a status setting such as `new|in_progress` into lower-case status codes. */
export function statusesOf(value: string): string[] {
  return String(value ?? '').split('|').map(status => status.trim().toLowerCase()).filter(Boolean)
}

/**
 * Splits a people field, which lists several TAPD nicknames separated by `;` (and sometimes `,` or `、`). Matching is by containment on this
 * list, not by equality on the raw string: a bug owned by `carol;alice` is one of alice's, and saying so must not depend on the order TAPD
 * returns the owners in.
 */
export function people(value: string): string[] {
  return String(value ?? '').split(/[;；,，、]/).map(name => name.trim()).filter(Boolean)
}

/** The statuses one poll asks TAPD for: the workable ones plus the ended ones whose transition stays visible. */
export function readStatuses(config: Pick<TapdConfig, 'openStatuses'>): string {
  return [...new Set([...statusesOf(config.openStatuses), ...ENDED_STATUSES])].join('|')
}

/**
 * One page of the bugs currently owned by the configured person.
 * TAPD ignores an `owner` filter silently, which would read the whole workspace, so the exact `current_owner` field is used and the
 * owner is always URL-encoded: TAPD nicknames are usually Chinese. Multi-owner rows (`carol;alice`) come back from this filter, which is
 * what the containment check in `people` is for. No status other than the two sets is read, so 待 QA 确认 never shows up.
 */
export function bugUrl(config: Pick<TapdConfig, 'apiBase' | 'workspaceId' | 'owner' | 'limit' | 'openStatuses'>, page: number): string {
  const query = new URLSearchParams({ workspace_id: config.workspaceId, current_owner: config.owner, limit: String(Math.min(config.limit, PAGE_SIZE)),
    page: String(page), status: readStatuses(config) })
  return `${config.apiBase.replace(/\/+$/, '')}/bugs?${query.toString()}`
}

/** Turns TAPD's HTML description into plain text, capped at DESCRIPTION_MAX_CHARS; images and markup carry no meaning for the assessment. */
export function plainText(html: string): string {
  const text = String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
  return text.length > DESCRIPTION_MAX_CHARS ? `${text.slice(0, DESCRIPTION_MAX_CHARS)}…` : text
}

/** Normalizes one row of a TAPD response; `priority_label` is preferred over the raw priority code, and the URL follows the workspace. */
export function normalizeBug(row: { Bug?: Record<string, unknown> }, config: Pick<TapdConfig, 'workspaceId'>): TapdBug {
  const bug = row?.Bug ?? {}
  const id = String(bug.id ?? '')
  const shortId = shortIdOf(id)
  return {
    id,
    shortId,
    title: String(bug.title ?? '').trim(),
    status: String(bug.status ?? ''),
    priority: String(bug.priority_label ?? bug.priority ?? ''),
    severity: String(bug.severity ?? ''),
    owner: String(bug.current_owner ?? bug.owner ?? '').replace(/;$/, ''),
    reporter: String(bug.reporter ?? '').trim(),
    created: String(bug.created ?? ''),
    modified: String(bug.modified ?? ''),
    description: plainText(String(bug.description ?? '')),
    url: id ? `https://www.tapd.cn/${config.workspaceId}/bugtrace/bugs/view/${id}` : '',
  }
}

/** Parses one page; TAPD answers `status: 1` on success and names the problem in `info` otherwise. */
export function parseBugs(text: string, config: Pick<TapdConfig, 'workspaceId'>): TapdBug[] {
  let payload: { status?: unknown; info?: unknown; data?: unknown }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error(`TAPD answered with something that is not JSON: ${text.slice(0, 200)}`)
  }
  if (Number(payload.status) !== 1) throw new Error(`TAPD returned an error: ${String(payload.info ?? 'unknown')}`)
  const rows = Array.isArray(payload.data) ? payload.data as { Bug?: Record<string, unknown> }[] : []
  return rows.map(row => normalizeBug(row, config))
}

/**
 * Whether one bug of a poll becomes a Trigger: a workable bug always, an ended bug only while its change is recent (so the panel shows
 * the transition without replaying years of closed bugs), and nothing else — a bug waiting for QA is not even read.
 */
export function received(bug: TapdBug, config: Pick<TapdConfig, 'openStatuses'>, now = Date.now()): boolean {
  const status = bug.status.toLowerCase()
  if (statusesOf(config.openStatuses).includes(status)) return true
  if (!(ENDED_STATUSES as readonly string[]).includes(status)) return false
  const at = Date.parse(isoOf(bug.modified || bug.created))
  return Number.isFinite(at) && now - at <= ENDED_WINDOW_MS
}

/** Reads and parses one page through the caller's `fetchText`, so tests read fixtures instead of the network. */
export async function fetchPage(url: string, authorization: string, fetchText: (url: string) => Promise<string> = httpFetch(authorization)): Promise<string> {
  return fetchText(url)
}

/** Reads every page until `limit` bugs are collected or TAPD returns a short page. */
export async function listBugs(config: TapdConfig, fetchText: (url: string, authorization?: string) => Promise<string>,
  authorization = ''): Promise<TapdBug[]> {
  if (!config.workspaceId || !config.owner) throw new Error('Set the TAPD workspace ID and owner before reading bugs')
  const collected: TapdBug[] = []
  const pageSize = Math.min(config.limit, PAGE_SIZE)
  for (let page = 1; collected.length < config.limit; page += 1) {
    const rows = parseBugs(await fetchText(bugUrl(config, page), authorization), config)
    collected.push(...rows)
    if (rows.length < pageSize) break
  }
  return collected.slice(0, config.limit)
}

/** A concrete fetch backed by the global `fetch`; the authorization never reaches the URL or the log. */
export function httpFetch(authorization: string): (url: string) => Promise<string> {
  return async (url) => {
    const response = await fetch(url, { headers: { Authorization: authorization, Accept: 'application/json' } })
    if (!response.ok) throw new Error(`TAPD answered HTTP ${response.status} for ${url.split('?')[0]}`)
    return response.text()
  }
}

/**
 * The Trigger one bug produces. The ID carries the bug's `modified` time, so an edited, reopened or commented bug is a new Trigger on
 * the same Thread while an unchanged one is a duplicate the Engine drops; the bug is a direct request from the person it is assigned to.
 */
export function triggerOf(bug: TapdBug, config: Pick<TapdConfig, 'workspaceId' | 'owner'>, at = isoOf(bug.modified || bug.created)): Trigger {
  const revision = Date.parse(bug.modified) || Date.now()
  const owners = people(bug.owner)
  // A bug may list several owners. The configured person is the one this Source speaks for, so the actor is that nickname — not the raw
  // "carol;alice", which no Policy allowlist could match.
  const actor = owners.includes(config.owner) ? config.owner : owners[0] ?? config.owner
  return {
    id: `${SOURCE}:${bug.id}:${revision}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: bug.id }],
    actor: { source: SOURCE, id: actor },
    human: true,
    addressed: 'direct',
    at,
    text: bug.description ? `${bug.title}\n\n${bug.description}` : bug.title,
    url: bug.url,
    meta: { bugId: bug.id, shortId: bug.shortId ?? shortIdOf(bug.id), workspaceId: config.workspaceId, kind: 'bug', status: bug.status, priority: bug.priority,
      severity: bug.severity, owner: bug.owner || config.owner, people: owners, reporter: bug.reporter, created: bug.created,
      modified: bug.modified },
  }
}

/** TAPD times are Asia/Shanghai wall-clock strings; anything unparseable is returned unchanged so the Engine can only normalize what it can. */
export function isoOf(value: string): string {
  const wall = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(wall)) return wall
  return new Date(`${wall.replace(' ', 'T')}+08:00`).toISOString()
}

/** Reads every page once, ingesting one Trigger per bug that is the person's to see, and returns how many Triggers were new. */
export async function pollRound(ctx: SourceContext, config: TapdConfig, fetchText?: (url: string, authorization?: string) => Promise<string>,
  now = Date.now()): Promise<number> {
  const authorization = credentials().authorization
  const bugs = await listBugs(config, fetchText ?? ((url) => httpFetch(authorization)(url)), authorization)
  let stored = 0
  for (const bug of bugs) {
    if (!received(bug, config, now)) continue
    if (await ctx.receive(triggerOf(bug, config)) === 'stored') stored += 1
  }
  return stored
}

/** The status field carries the whole receiving rule, so it is stated once and in full. */
const OPEN_HINT: Localized = { zh: '用竖线分隔，默认 new|in_progress|reopened（新建/修复中/重新打开），这些状态的单会直接变成触发。修复完成、测试完成、已关闭、取消的单不会被接单，但会出现在「被过滤」里，让人看清单子是怎么结束的；待 QA 确认（unconfirmed）的单不读——QA 确认完轮到你时，它自然会以新建/修复中重新出现。TAPD 只认竖线分隔的多状态过滤。',
  en: 'Separated by |, default new|in_progress|reopened: these bugs become Triggers directly. Resolved, verified, closed and rejected bugs are never worked, yet still show under "filtered" so the end of the work stays visible. A bug waiting for QA (unconfirmed) is not read at all: when QA hands it back it reappears as new or in progress. TAPD only honours the | form of a multi-status filter.' }

/** The kind: a read-only poller with no Channel, because TAPD is read-only; replies and notices go out through the deployment's other Sources. */
export const tapdKind: SourceKind<TapdConfig> = {
  kind: SOURCE,
  title: { zh: 'TAPD', en: 'TAPD' },
  description: { zh: '只读读取指定处理人的全部缺陷，一个缺陷一条线程：新建/修复中/重新打开的会接单，修复完成/测试完成/已关闭/取消的只作为被过滤的通知出现。',
    en: 'Reads every bug of one person, one Thread per bug: new, in-progress and reopened bugs are worked, while resolved, verified, closed and rejected ones only appear as filtered notices. Reads only: it never writes to TAPD.' },
  schema: TapdConfigSchema,
  fields: [
    { key: 'workspaceId', type: 'text', pattern: '\\d{1,20}', label: { zh: 'TAPD 项目 ID', en: 'TAPD workspace ID' },
      hint: { zh: '你的 TAPD 项目 ID（纯数字）。只读，不会写回 TAPD。', en: 'Your TAPD workspace ID (digits only). Read-only: nothing is written back.' } },
    { key: 'owner', type: 'text', label: { zh: '处理人', en: 'Bug owner' },
      hint: { zh: '取这个人的全部缺陷，按「当前处理人」匹配；该字段列出多人（如 alice;bob）时，命中任意一个即算这个人的单。写 TAPD 里的昵称，不是登录名。',
        en: 'Every bug of this person, matched on the current owner. When the field lists several people (such as alice;bob), containing the nickname is enough. Use the TAPD nickname, not the login.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '默认 5 分钟。TAPD 的 rate limit 是每个令牌每小时 1 万次，够用。', en: 'Five minutes by default. TAPD allows 10,000 calls an hour per token, which is ample.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'limit', type: 'number', advanced: true, min: 1, max: 500, label: { zh: '每次最多读取的缺陷数', en: 'Bugs read per poll' },
      hint: { zh: '一次最多收集这么多条缺陷，超出的下一轮继续；TAPD 每页最多 200 条，这里超出部分会自动翻页。', en: 'At most this many bugs per poll; the rest wait for the next round. TAPD pages hold 200 rows, and larger limits are paged through.' } },
    { key: 'openStatuses', type: 'text', advanced: true, pattern: '[^|]+\\|[^|]+', label: { zh: '直接接单的状态', en: 'Statuses worked directly' }, hint: OPEN_HINT },
    { key: 'apiBase', type: 'text', advanced: true, pattern: 'https?://[^\\s]+', label: { zh: 'TAPD API 基址', en: 'TAPD API base' },
      hint: { zh: '默认 https://api.tapd.cn，通常不需要改。', en: 'Defaults to https://api.tapd.cn and rarely needs changing.' } },
  ],
  health: ['tapd'],
  // A bug assigned to the person is addressed to the agent directly; the workable ones are listened to, and the ended ones are filtered
  // with a reason, which is exactly what the panel shows under "被过滤".
  scope: ({ meta }, config) => {
    const status = String(meta.status ?? '').toLowerCase()
    if (statusesOf(config.openStatuses).includes(status)) return { listened: true, observed: false }
    // The Engine records this code as the filtered Trigger's reason; the panel localizes `reason.bugResolved` and friends.
    return { listened: false, reason: ENDED_REASONS[status] ?? 'bugStatus' }
  },
  // The kind knows the workspace and the owner, so a bug id finds its Thread and its display text without a network read.
  find: query => {
    const id = query.trim().match(/^\d{10,}$/)?.[0]
    return id ? { threads: [`${SOURCE}:${id}`], terms: [id] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(100), name: z.string().trim().max(100).optional() }).strict())
        .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate owners')
        // A trigger's actor is one TAPD nickname, matched exactly, so a list pasted into one row matches nobody and drops
        // every bug from those people without a word. Refuse it where it is saved instead of at the next poll.
        .refine(people => people.every(person => !/[;；,，、]/.test(person.id)),
          'One person per row: a TAPD nickname is matched exactly, so a separated list in one row matches nobody')
        .default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的处理人', en: 'Owners who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'TAPD 昵称', en: 'TAPD nickname' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的处理人被指派的缺陷是明确的请求，不需要再 @；其他处理人的缺陷不接收。', en: 'A bug assigned to someone on this list is an explicit request, with no mention needed; bugs of anyone else are not received.' },
    // The Source reads the bugs assigned to one person, so the admission table's rows are the owner's bugs and everything else is unlisted.
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TAPD_BUG_ID', description: { zh: '接下工单的 TAPD 缺陷 ID；工单不是从 TAPD 来的时为空', en: 'ID of the TAPD bug that started the ticket; empty when the ticket did not start on TAPD' } },
      { key: 'DSH_SUPERAGENT_TAPD_SHORT_ID', description: { zh: '这条缺陷的 TAPD 短单号（P4 描述首行用）', en: 'TAPD short id of that bug, for the first line of a P4 description' } },
      { key: 'DSH_SUPERAGENT_TAPD_BUG_URL', description: { zh: '这条缺陷在 TAPD 里的链接', en: 'Link to that bug in TAPD' } },
      { key: 'DSH_SUPERAGENT_TAPD_WORKSPACE', description: { zh: '缺陷所在的 TAPD 项目 ID', en: 'TAPD workspace the bug lives in' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_TAPD_BUG_ID: trigger?.threads[0]?.source === SOURCE ? String(trigger.meta.bugId ?? '') : '',
      DSH_SUPERAGENT_TAPD_SHORT_ID: trigger?.threads[0]?.source === SOURCE ? String(trigger.meta.shortId ?? '') : '',
      DSH_SUPERAGENT_TAPD_BUG_URL: trigger?.threads[0]?.source === SOURCE ? String(trigger.url ?? '') : '',
      DSH_SUPERAGENT_TAPD_WORKSPACE: trigger?.threads[0]?.source === SOURCE ? String(trigger.meta.workspaceId ?? '') : '',
    }),
  },
}

/** Returns an error health once `failures` consecutive polls fail, so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

/** Polls forever: reads the person's bugs, reports its own health, and never lets an error escape, which would end the DSH process. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('tapd', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<TapdConfig>(SOURCE)
    try {
      if (!config) ctx.report('tapd', health('paused', 'sourceOff'))
      else {
        const stored = await pollRound(ctx, config)
        const open = `read every ${config.pollSeconds}s`
        ctx.report('tapd', { state: 'ready', detail: `${stored} new trigger${stored === 1 ? '' : 's'}; ${open}` })
        failures = 0
      }
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('tapd', failed)
    }
    await pause(Math.max(60, ctx.config<TapdConfig>(SOURCE)?.pollSeconds ?? 300) * 1000, signal)
  }
}

export const name = 'dsh-superagent-tapd'
export const inject = ['orchestrator']
/** Registers the kind and starts its polling loop; the deployment's own profile entry switches it on. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(tapdKind), 'tapd: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, tapdKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('tapd', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

