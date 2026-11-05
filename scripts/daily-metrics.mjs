#!/usr/bin/env node
/**
 * daily-metrics：一条命令导出每日复盘的数据，输出固定 schema 的 metrics.json。复盘报告和逐日 diff 都读这一份文件。
 *
 * 取数走 PTC 式：聚合全部在本地代码里跑完，模型只读聚合后的结果，不逐条读原始数据。
 * 脚本只读：orchestrator.sqlite 以 readOnly 打开；会话归档只解压读取；gh 只调 list 类命令。不写工单，也不发消息。
 *
 * 用法：
 *   node scripts/daily-metrics.mjs --date 2026-11-04 --out metrics.json      # 本地日历日，时区默认 +08:00
 *   node scripts/daily-metrics.mjs --since 2026-11-03T16:00:00Z --until 2026-11-04T16:00:00Z --out m.json
 *   node scripts/daily-metrics.mjs --diff prev.json cur.json                 # 打印两天的数字差
 * 选项：--state-dir（默认 ~/.dsh/state/superagent）、--db、--sessions（默认 ~/.dsh/sessions）、--repo owner/name、
 *   --tz +08:00、--p4-user 与 --p4-path（默认 $DSH_SUPERAGENT_P4_DEPOT/...；给了 --p4-user 才取 p4）、--no-github、--no-sessions。
 * 退出码：0 成功（数据源缺失写进 limits，不算失败）；1 参数错误或数据库打不开。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

export const SCHEMA_VERSION = 1
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 报告根因归类：按顺序匹配，一条报告只归第一类。改这张表会改变口径，所以要同时升 SCHEMA_VERSION。 */
export const CAUSES = [
  ['quota', '额度 / 402', /\b402\b|ACCOUNT_QUOTA|Insufficient Balance|余额|额度/i],
  ['session-format', '会话格式', /SessionFormatError/],
  ['tool-input', '工具输入非法 JSON', /invalid JSON|非法 JSON|JSON\.parse|Unexpected token|tool input/i],
  ['permission', '权限 / 403', /\b403\b|forbidden|permission denied|无权限|没有写入通道/i],
  ['upstream', '模型网关 / 网络', /gateway|ECONN|ETIMEDOUT|timed? ?out|socket hang up|\b5\d\d\b|断连/i],
  ['delivery-target', '交付目标 / 远端', /no remote|无远端|没有远端|remote/i],
  ['scope', '超出范围 / 待决定', /scope|超范围|超出本工单|需要人工确认|待你决定/i],
  ['environment', '环境 / 编辑器 / 编译', /编辑器|editor|compile|编译|UBT|DLL/i],
]

/** 解析 `--flag value`、`--flag=value` 和不带值的开关。 */
export function parseArgs (argv) {
  const options = {}, flags = new Set(), positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq !== -1) { options[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--') && !['diff', 'no-github', 'no-sessions'].includes(arg.slice(2))) { options[arg.slice(2)] = next; i++ } else flags.add(arg.slice(2))
  }
  return { options, flags, positional }
}

/** `+08:00` → 480 分钟。 */
export function offsetMinutes (tz) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz)
  if (!m) throw new Error(`--tz 需要形如 +08:00 的偏移，收到 ${tz}`)
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/** 本地日历日 → UTC 半开区间 [since, until)。 */
export function dayWindow (date, tz = '+08:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date 需要 YYYY-MM-DD，收到 ${date}`)
  const start = Date.parse(`${date}T00:00:00Z`) - offsetMinutes(tz) * 60_000
  return { since: new Date(start).toISOString(), until: new Date(start + 86_400_000).toISOString(), tz, date }
}

/** 时间戳（ISO 字符串或毫秒）在窗口内的本地小时；窗口外返回 undefined。 */
export function localHour (at, window) {
  const ms = typeof at === 'number' ? at : Date.parse(at ?? '')
  if (!Number.isFinite(ms) || ms < Date.parse(window.since) || ms >= Date.parse(window.until)) return undefined
  return new Date(ms + offsetMinutes(window.tz) * 60_000).getUTCHours()
}
const inWindow = (at, window) => localHour(at, window) !== undefined
const localClock = (at, window) => new Date(Date.parse(at) + offsetMinutes(window.tz) * 60_000).toISOString().slice(11, 16)
const bump = (counter, key, by = 1) => { counter[key] = (counter[key] ?? 0) + by; return counter }
const sorted = counter => Object.fromEntries(Object.entries(counter).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))))

/** 一条报告的根因 key；不命中任何一类时为 `other`。 */
export function causeOf (summary) {
  for (const [key, , pattern] of CAUSES) if (pattern.test(summary ?? '')) return key
  return 'other'
}

/**
 * 工单分类：优先读工单上记录的 `kind`（接单分类功能写入），没有就读 escalation 的 `category`，再按来源和标题推算。
 * 返回 feature | bug | self | inquiry，保证非空。
 */
export function kindOf (ticket, source, repository) {
  if (typeof ticket.kind === 'string' && ticket.kind) return ticket.kind
  if (ticket.category === 'bug') return 'bug'
  if (source === 'tapd') return 'bug'
  const target = ticket.execution?.target
  if (source === 'github' || (repository && target === repository)) return 'self'
  const title = ticket.title ?? ''
  if (/修|bug|报错|崩|异常|失败|不生效|错/i.test(title)) return 'bug'
  if (/分析|调研|复盘|为什么|查|评估|报告/.test(title)) return 'inquiry'
  return 'feature'
}

/** 从 orchestrator.sqlite 聚合工单、assignment、报告、触发与决策。`db` 是 node:sqlite 的 DatabaseSync。 */
export function collectStore (db, window, { repository } = {}) {
  const limits = []
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, human: 0, progress: 0, deliveries: 0, failed: 0, toolCalls: 0 }))
  const sourceOfTrigger = new Map()
  const triggers = { total: 0, human: 0, bySource: {} }
  for (const { id, value } of db.prepare('select id, value from trigger where at >= ? and at < ?').iterate(window.since, window.until)) {
    const trigger = JSON.parse(value)
    sourceOfTrigger.set(id, trigger.source)
    triggers.total++
    if (!trigger.human) continue
    triggers.human++
    bump(triggers.bySource, trigger.source ?? '-')
    const hour = localHour(trigger.at, window)
    if (hour !== undefined) hourly[hour].human++
  }
  const sourceLookup = db.prepare('select value from trigger where id = ?')
  const sourceOf = id => {
    if (!id) return undefined
    if (sourceOfTrigger.has(id)) return sourceOfTrigger.get(id)
    const row = sourceLookup.get(id)
    const source = row ? JSON.parse(row.value).source : undefined
    sourceOfTrigger.set(id, source)
    return source
  }

  const tickets = { created: 0, ended: 0, open: 0, outcomes: {}, kinds: {}, list: [] }
  const assignments = { started: 0, ended: 0, endedReasons: {} }
  const reports = { total: 0, states: {}, causes: {}, failures: [] }
  const restartMinutes = {}
  const cls = []
  const byTicket = new Map()
  for (const { value } of db.prepare('select value from ticket').iterate()) {
    const ticket = JSON.parse(value)
    byTicket.set(ticket.id, ticket)
    const states = []
    for (const assignment of ticket.assignments ?? []) {
      if (inWindow(assignment.startedAt, window)) assignments.started++
      if (inWindow(assignment.endedAt, window)) {
        assignments.ended++
        bump(assignments.endedReasons, assignment.endedReason ?? 'normal')
        if (assignment.endedReason === 'hostRestarted') bump(restartMinutes, localClock(assignment.endedAt, window))
      }
      const report = assignment.report
      if (!report) continue
      states.push(report.state)
      const hour = localHour(report.at, window)
      if (hour === undefined) continue
      reports.total++
      bump(reports.states, report.state)
      if (report.state === 'ready') hourly[hour].deliveries++
      else if (report.state === 'failed') hourly[hour].failed++
      else hourly[hour].progress++
      if (report.state === 'failed' || report.state === 'blocked') {
        const cause = causeOf(report.summary)
        bump(reports.causes, cause)
        reports.failures.push({ ticket: ticket.id.slice(0, 8), state: report.state, cause, at: localClock(report.at, window),
          summary: (report.summary ?? '').replace(/\s+/g, ' ').slice(0, 160) })
      }
    }
    const pipeline = ticket.pipeline
    if (pipeline?.state === 'merged' && ticket.execution?.changelist && inWindow(pipeline.at, window)) {
      cls.push({ changelist: ticket.execution.changelist, ticket: ticket.id.slice(0, 8), at: localClock(pipeline.at, window), review: pipeline.url })
    }
    if (!inWindow(ticket.createdAt, window)) continue
    const kind = kindOf(ticket, sourceOf(ticket.origin?.triggerId), repository)
    tickets.created++
    ticket.ended ? tickets.ended++ : tickets.open++
    bump(tickets.outcomes, ticket.ended?.outcome ?? 'open')
    bump(tickets.kinds, kind)
    tickets.list.push({ id: ticket.id.slice(0, 8), title: ticket.title, kind, createdAt: localClock(ticket.createdAt, window),
      assignments: (ticket.assignments ?? []).length, outcome: ticket.ended?.outcome ?? 'open', phase: ticket.phase ?? null,
      reports: states.slice(-8) })
  }
  tickets.list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  tickets.outcomes = sorted(tickets.outcomes); tickets.kinds = sorted(tickets.kinds)
  assignments.endedReasons = sorted(assignments.endedReasons)
  reports.states = sorted(reports.states); reports.causes = sorted(reports.causes)

  const decisions = {}
  for (const { value } of db.prepare('select value from decision').iterate()) {
    const decision = JSON.parse(value)
    if (inWindow(decision.at, window)) bump(decisions, decision.kind)
  }
  const intake = { ...triggers, bySource: sorted(triggers.bySource), decisions: sorted(decisions), fanoutOnly: 0, handbacks: 0, acks: 0, filtered: 0 }
  const disposition = db.prepare('select value from disposition where id = ?')
  for (const { id } of db.prepare('select id from trigger where at >= ? and at < ?').iterate(window.since, window.until)) {
    const row = disposition.get(id)
    if (!row) continue
    const value = JSON.parse(row.value)
    if (!value.evalId && (value.fanout ?? []).length) intake.fanoutOnly++
    if (value.filtered) intake.filtered++
    intake.handbacks += (value.handbacks ?? []).length
    intake.acks += (value.acked ?? []).length
  }
  const restarts = { interrupted: Object.values(restartMinutes).reduce((a, b) => a + b, 0),
    events: Object.entries(restartMinutes).sort().map(([at, interrupted]) => ({ at, interrupted })) }
  limits.push('outbox 记录没有时间戳，回执与回复条数取自 disposition.acked，不含 outbox。')
  return { tickets, assignments, reports, restarts, intake, cls, hourly, byTicket, limits }
}

/** 解压一个多帧 zstd 会话归档（session.v4.jsonl.zstd），返回文本；单帧损坏只跳过该帧。 */
export function decodeSession (buffer) {
  const starts = []
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1] && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  let text = '', bad = 0
  for (let k = 0; k < starts.length; k++) {
    try { text += zstdDecompressSync(buffer.subarray(starts[k], starts[k + 1] ?? buffer.length)).toString('utf8') } catch { bad++ }
  }
  return { text, frames: starts.length, bad }
}

function * sessionFiles (directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield * sessionFiles(path)
    else if (entry.name.endsWith('.jsonl.zstd')) yield path
  }
}

/** 统计窗口内各会话的 tool/call 事件：按小时、按工具名、按工单（worker 会话 id 为 worker-<ticketId>）。 */
export function collectTools (directory, window, hourly) {
  const tools = { calls: 0, sessions: 0, files: 0, badFrames: 0, byName: {}, byTicket: {} }
  const since = Date.parse(window.since)
  for (const file of sessionFiles(directory)) {
    if (statSync(file).mtimeMs < since) continue
    tools.files++
    const { text, bad } = decodeSession(readFileSync(file))
    tools.badFrames += bad
    let session, counted = false
    for (const line of text.split('\n')) {
      if (!line.includes('"tool/call"') && !line.includes('"type":"session"')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'session') { session = event.id; continue }
      if (event.type !== 'tool/call') continue
      const hour = localHour(event.time, window)
      if (hour === undefined) continue
      tools.calls++
      hourly[hour].toolCalls++
      bump(tools.byName, event.data?.name ?? '?')
      if (session?.startsWith('worker-')) bump(tools.byTicket, session.slice(7, 15))
      if (!counted) { tools.sessions++; counted = true }
    }
  }
  const top = (counter, n) => Object.fromEntries(Object.entries(sorted(counter)).slice(0, n))
  return { ...tools, byName: top(tools.byName, 15), byTicket: sorted(tools.byTicket) }
}

/** 汇总窗口内 PR：合并、关闭、新开仍 open；合并计入小时交付。`prs` 是 `gh pr list --json` 的数组。 */
export function collectPulls (prs, window, hourly) {
  const merged = [], closed = [], opened = []
  for (const pr of prs) {
    if (pr.mergedAt && inWindow(pr.mergedAt, window)) { merged.push(pr); hourly[localHour(pr.mergedAt, window)].deliveries++ }
    else if (pr.state === 'CLOSED' && inWindow(pr.closedAt, window)) closed.push(pr)
    else if (pr.state === 'OPEN' && inWindow(pr.createdAt, window)) opened.push(pr)
  }
  const brief = pr => ({ number: pr.number, title: pr.title, at: localClock(pr.mergedAt ?? pr.closedAt ?? pr.createdAt, window) })
  return { merged: merged.map(brief), closed: closed.map(brief), open: opened.map(brief) }
}

/**
 * 窗口内入库的 CL。`changes` 是 `p4 -ztag -Mj changes -s submitted` 的逐行 JSON；`tracked` 是工单流水线已标记合并的 CL
 * （工单记录的是提交前的编号，p4 里对应 `oldChange`），用来把入库 CL 关联回工单。没有 p4 数据时退回 `tracked`。
 */
export function collectChanges (changes, tracked, window, hourly) {
  if (!changes) {
    for (const cl of tracked) { const hour = Number(cl.at.slice(0, 2)); hourly[hour].deliveries++ }
    return { source: 'pipeline', submitted: tracked }
  }
  const byNumber = new Map(tracked.map(cl => [String(cl.changelist), cl]))
  const submitted = []
  for (const change of changes) {
    const at = Number(change.time) * 1000
    const hour = localHour(at, window)
    if (hour === undefined) continue
    hourly[hour].deliveries++
    const link = byNumber.get(String(change.oldChange)) ?? byNumber.get(String(change.change))
    submitted.push({ changelist: Number(change.change), ticket: link?.ticket ?? null, at: localClock(new Date(at).toISOString(), window),
      desc: String(change.desc ?? '').trim().slice(0, 60) })
  }
  submitted.sort((a, b) => a.at.localeCompare(b.at))
  return { source: 'p4', submitted, tracked }
}

/** 拼出完整的 metrics 对象。`pulls` / `changes` 为 undefined 表示没取 GitHub / p4。 */
export function buildMetrics ({ db, window, repository, sessionsDir, pulls, changes, sources }) {
  const store = collectStore(db, window, { repository })
  const limits = [...store.limits]
  let tools
  if (sessionsDir) {
    tools = collectTools(sessionsDir, window, store.hourly)
    if (tools.badFrames) limits.push(`会话归档有 ${tools.badFrames} 个 zstd 帧解压失败，其中的工具调用未计入。`)
  } else limits.push('未扫描会话归档：工具调用为 0，不代表没有调用。')
  let github
  if (pulls) github = collectPulls(pulls, window, store.hourly)
  else limits.push('未取 GitHub：PR 合并不计入交付。')
  const cls = collectChanges(changes, store.cls, window, store.hourly)
  if (!changes) limits.push('未取 p4：入库 CL 只计工单流水线标记为已提交的，不含人直接提交的。')
  else if (cls.tracked.length && !cls.submitted.some(cl => cl.ticket)) limits.push('入库 CL 没能按 oldChange 关联回工单（人工提交时可能换了 CL）；工单侧的已提交 CL 见 delivery.cls.tracked。')
  for (const ticket of store.tickets.list) ticket.toolCalls = tools?.byTicket[ticket.id] ?? 0
  const delivery = { ready: store.reports.states.ready ?? 0, prsMerged: github?.merged.length ?? 0, clsSubmitted: cls.submitted.length }
  delivery.total = delivery.ready + delivery.prsMerged + delivery.clsSubmitted
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    window,
    sources,
    tickets: store.tickets,
    assignments: store.assignments,
    reports: store.reports,
    restarts: store.restarts,
    intake: store.intake,
    delivery: { ...delivery, prs: github ?? null, cls },
    tools: tools ?? null,
    hourly: store.hourly,
    limits,
  }
}

/** 两份 metrics 的数字差：只比较标量计数，路径用点号连接；schemaVersion 不同时拒绝比较。 */
export function diffMetrics (previous, current) {
  if (previous.schemaVersion !== current.schemaVersion) throw new Error(`schemaVersion 不同（${previous.schemaVersion} → ${current.schemaVersion}），口径不可直接 diff`)
  const flat = (value, prefix, out) => {
    if (typeof value === 'number') out[prefix] = value
    else if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) flat(v, prefix ? `${prefix}.${k}` : k, out)
    return out
  }
  const skip = /^(schemaVersion|window|sources|hourly|tools\.byTicket)/
  const a = flat(previous, '', {}), b = flat(current, '', {})
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !skip.test(k)).sort()
  return keys.map(key => ({ key, previous: a[key] ?? 0, current: b[key] ?? 0, delta: (b[key] ?? 0) - (a[key] ?? 0) })).filter(row => row.previous || row.current)
}

function pullRequests (repository) {
  const out = execFileSync('gh', ['pr', 'list', '--repo', repository, '--state', 'all', '--limit', '200',
    '--json', 'number,title,state,createdAt,mergedAt,closedAt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out)
}

function submittedChanges (user, path) {
  const out = execFileSync('p4', ['-ztag', '-Mj', 'changes', '-s', 'submitted', '-u', user, '-m', '300', path],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
  return out.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(change => change.change)
}

export async function main (argv = process.argv.slice(2)) {
  const { options, flags, positional } = parseArgs(argv)
  if (flags.has('diff')) {
    const [prev, cur] = positional
    if (!prev || !cur) throw new Error('--diff 需要两个文件：prev.json cur.json')
    const rows = diffMetrics(JSON.parse(readFileSync(prev, 'utf8')), JSON.parse(readFileSync(cur, 'utf8')))
    for (const row of rows) console.log(`${row.key}\t${row.previous}\t${row.current}\t${row.delta > 0 ? '+' : ''}${row.delta}`)
    return 0
  }
  const tz = options.tz ?? '+08:00'
  offsetMinutes(tz)
  const window = options.date ? dayWindow(options.date, tz)
    : options.since && options.until ? { since: new Date(options.since).toISOString(), until: new Date(options.until).toISOString(), tz, date: null }
      : dayWindow(new Date(Date.now() + offsetMinutes(tz) * 60_000).toISOString().slice(0, 10), tz)
  const stateDir = options['state-dir'] ?? join(homedir(), '.dsh', 'state', 'superagent')
  const dbPath = options.db ?? join(stateDir, 'orchestrator.sqlite')
  if (!existsSync(dbPath)) throw new Error(`找不到数据库 ${dbPath}`)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const repository = options.repo ?? process.env.DSH_SUPERAGENT_GITHUB_REPOSITORY
  const sessionsDir = flags.has('no-sessions') ? undefined : options.sessions ?? join(homedir(), '.dsh', 'sessions')
  let pulls, githubError
  if (!flags.has('no-github') && repository) {
    try { pulls = pullRequests(repository) } catch (error) { githubError = String(error?.stderr || error?.message || error).trim().slice(0, 200) }
  }
  let changes, p4Error
  const p4User = options['p4-user'], p4Path = options['p4-path'] ?? (process.env.DSH_SUPERAGENT_P4_DEPOT ? `${process.env.DSH_SUPERAGENT_P4_DEPOT}/...` : undefined)
  if (p4User && p4Path) {
    try { changes = submittedChanges(p4User, p4Path) } catch (error) { p4Error = String(error?.stderr || error?.message || error).trim().slice(0, 200) }
  }
  const metrics = buildMetrics({ db, window, repository, sessionsDir, pulls, changes,
    sources: { db: dbPath, sessions: sessionsDir ?? null, github: pulls ? repository : null, p4: changes ? { user: p4User, path: p4Path } : null } })
  if (githubError) metrics.limits.push(`gh pr list 失败：${githubError}`)
  if (p4Error) metrics.limits.push(`p4 changes 失败：${p4Error}`)
  else if (!repository && !flags.has('no-github')) metrics.limits.push('没有 --repo（或 DSH_SUPERAGENT_GITHUB_REPOSITORY），未取 GitHub。')
  db.close()
  const text = JSON.stringify(metrics, null, 2) + '\n'
  if (options.out) writeFileSync(options.out, text)
  else process.stdout.write(text)
  if (options.out) console.error(`metrics → ${options.out}：工单 ${metrics.tickets.created}、报告 ${metrics.reports.total}、工具调用 ${metrics.tools?.calls ?? '-'}、交付 ${metrics.delivery.total}`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => { process.exitCode = code }, error => { console.error(error?.message ?? error); process.exitCode = 1 })
}
