/**
 * TAPD 工单入口：把「处理人 = 指定人」的未关闭缺陷拉成 Ticket 候选。
 *
 * 只读，不做任何写操作（创建/流转/评论都不做），对应「TAPD 只读」硬约束。
 * 凭据只从环境变量读，不落盘、不写日志，两种任一即可：
 *   TAPD_ACCESS_TOKEN（或 DSH_SUPERAGENT_TAPD_ACCESS_TOKEN）→ Authorization: Bearer
 *   DSH_SUPERAGENT_TAPD_API_USER / DSH_SUPERAGENT_TAPD_API_PASSWORD（兼容 TAPD_API_USER / TAPD_API_PASSWORD）→ HTTP Basic
 *
 * 两个必须踩准的 TAPD 行为（实测）：
 *   - owner 参数被静默忽略（不报错，直接返回整个项目），筛处理人只能用 current_owner；
 *   - access_token 不允许出现在 URL 里，必须放 Authorization 头（Bearer）。
 *
 * 用法：
 *   node scripts/tapd-bugs.mjs --workspace <id> --owner <tapd-nickname> [--limit 200] [--json]
 *   node scripts/tapd-bugs.mjs --self-test
 *
 * 退出码：0 成功；1 用法/参数错误；2 凭据缺失；3 TAPD 返回错误。
 */

/** TAPD 视为「已了结」的状态：入口默认排除，避免无人值守反复捞回旧单。 */
export const TERMINAL_STATUSES = ['closed', 'rejected', 'verified']

/** TAPD OpenAPI 基址；只读查询走这里。 */
export const TAPD_BASE = 'https://api.tapd.cn'

/** 从环境变量解析凭据：有 access token 就用 Bearer，否则用 API 账号走 Basic；缺哪个就点名哪个，不猜默认值。 */
export function credentials(env = process.env) {
  const token = env.DSH_SUPERAGENT_TAPD_ACCESS_TOKEN || env.TAPD_ACCESS_TOKEN || ''
  if (token) return { user: '', password: '', authorization: `Bearer ${token}` }
  const user = env.DSH_SUPERAGENT_TAPD_API_USER || env.TAPD_API_USER || ''
  const password = env.DSH_SUPERAGENT_TAPD_API_PASSWORD || env.TAPD_API_PASSWORD || ''
  const missing = []
  if (!user) missing.push('DSH_SUPERAGENT_TAPD_API_USER')
  if (!password) missing.push('DSH_SUPERAGENT_TAPD_API_PASSWORD')
  if (missing.length) throw new Error(`缺少 TAPD 凭据环境变量：${missing.join('、')}（或设置 TAPD_ACCESS_TOKEN 走 Bearer）`)
  return { user, password, authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
}

/** 拼一页查询的 URL。处理人必须走 current_owner：owner 会被 TAPD 静默忽略，一次拉回整个项目。中文必须编码。 */
export function pageUrl({ workspace, owner, limit, page }) {
  const query = new URLSearchParams({
    workspace_id: String(workspace),
    current_owner: owner,
    limit: String(limit),
    page: String(page),
  })
  return `${TAPD_BASE}/bugs?${query.toString()}`
}

/** TAPD 的一行 → 入口需要的字段；字段缺失时保留空串，不做猜测性填充。 */
export function normalize(row) {
  const bug = row?.Bug ?? {}
  return {
    id: String(bug.id ?? ''),
    title: String(bug.title ?? ''),
    status: String(bug.status ?? ''),
    priority: String(bug.priority_label ?? bug.priority ?? ''),
    owner: String(bug.current_owner ?? bug.owner ?? '').replace(/;$/, ''),
    iterationId: String(bug.iteration_id ?? ''),
    created: String(bug.created ?? ''),
    modified: String(bug.modified ?? ''),
    url: bug.id ? `https://www.tapd.cn/${bug.workspace_id ?? ''}/bugtrace/bugs/view/${bug.id}` : '',
  }
}

/** 入口筛单：了结态与无 id 的行都丢掉；其余保持 TAPD 给的顺序。 */
export function actionable(bugs, terminal = TERMINAL_STATUSES) {
  const dead = new Set(terminal.map(name => name.toLowerCase()))
  return bugs.filter(bug => bug.id && !dead.has(bug.status.toLowerCase()))
}

/** 解析一页响应；TAPD 用 status=1 表示成功，其余按错误处理并把 info 抛出来。 */
export function parsePage(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`TAPD 响应不是 JSON：${String(text).slice(0, 200)}`)
  }
  if (Number(payload?.status) !== 1) throw new Error(`TAPD 返回错误：${payload?.info ?? 'unknown'}`)
  const rows = Array.isArray(payload.data) ? payload.data : []
  return rows.map(normalize)
}

/**
 * 翻页取到 limit 条为止。
 * deps.fetchText 注入是为了自检时离线跑，不在测试里打真接口。
 */
export async function listBugs({ workspace, owner, limit = 200, pageSize = 30, fetchText, terminal = TERMINAL_STATUSES }) {
  const collected = []
  for (let page = 1; collected.length < limit; page += 1) {
    const url = pageUrl({ workspace, owner, limit: pageSize, page })
    const rows = parsePage(await fetchText(url))
    if (!rows.length) break
    collected.push(...actionable(rows, terminal))
    if (rows.length < pageSize) break
  }
  return collected.slice(0, limit)
}

/** 默认取数实现：只带 Authorization，不额外泄漏凭据到 URL。 */
export function httpFetch(authorization) {
  return async (url) => {
    const response = await fetch(url, { headers: { Authorization: authorization, Accept: 'application/json' } })
    if (!response.ok) throw new Error(`TAPD HTTP ${response.status}：${url}`)
    return response.text()
  }
}

/** 人读摘要：按状态分组计数 + 逐条一行，方便肉眼核对入口是否捞对。 */
export function report(bugs) {
  const byStatus = new Map()
  for (const bug of bugs) byStatus.set(bug.status, (byStatus.get(bug.status) ?? 0) + 1)
  const counts = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => `${status} ${count}`).join('，')
  const lines = [`共 ${bugs.length} 条未了结工单（${counts || '无'}）`]
  for (const bug of bugs) lines.push(`  ${bug.id}  [${bug.status}] ${bug.title}`)
  return lines.join('\n')
}

/** 自检：覆盖凭据缺失、URL 编码、了结态过滤、翻页终止、错误响应。 */
export function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`自检失败：${message}`)
  }

  // 凭据缺失必须点名变量，不能静默拿空密码去请求
  let named = ''
  try {
    credentials({})
  } catch (error) {
    named = error.message
  }
  assert(named.includes('DSH_SUPERAGENT_TAPD_API_USER'), '缺凭据应点名 API_USER')
  assert(credentials({ DSH_SUPERAGENT_TAPD_API_USER: 'u', DSH_SUPERAGENT_TAPD_API_PASSWORD: 'p' }).authorization.startsWith('Basic '), 'Basic 头应可生成')
  // access token 优先走 Bearer；TAPD 不接受 URL 里的 access_token
  const bearer = credentials({ TAPD_ACCESS_TOKEN: 'tok' })
  assert(bearer.authorization === 'Bearer tok', 'access token 应转成 Bearer 头')
  assert(credentials({ TAPD_ACCESS_TOKEN: 'tok', DSH_SUPERAGENT_TAPD_API_USER: 'u', DSH_SUPERAGENT_TAPD_API_PASSWORD: 'p' }).authorization === 'Bearer tok', '有 token 时优先 Bearer')

  // owner 必须编码（空格/中文都要），否则 TAPD 侧匹配不到；处理人只能用 current_owner，owner 会被静默忽略
  const url = pageUrl({ workspace: 12345678, owner: 'alice smith', limit: 30, page: 2 })
  assert(url.includes('workspace_id=12345678'), 'URL 应带 workspace_id')
  assert(url.includes('page=2'), 'URL 应带页码')
  assert(new URL(url).searchParams.get('current_owner') === 'alice smith', 'owner 应正确编码')
  assert(url.includes('current_owner='), '处理人必须用 current_owner 过滤')
  assert(!/[?&]owner=/.test(url), '不允许出现 TAPD 会静默忽略的 owner 参数')

  const rows = [
    { Bug: { id: '1', title: 'a', status: 'new', workspace_id: '12345678' } },
    { Bug: { id: '2', title: 'b', status: 'closed', workspace_id: '12345678' } },
    { Bug: { id: '3', title: 'c', status: 'verified', workspace_id: '12345678' } },
    { Bug: { id: '4', title: 'd', status: 'Resolved', workspace_id: '12345678' } },
    { Bug: { title: '无 id', status: 'new' } },
  ]
  const kept = actionable(rows.map(normalize).filter(bug => bug.title !== '无 id'))
  assert(kept.length === 2 && kept[0].id === '1' && kept[1].id === '4', '只应保留未了结的 new / resolved')
  assert(normalize(rows[0]).url.endsWith('/bugtrace/bugs/view/1'), 'URL 应可拼出')

  // resolved 不是了结态（待验证、仍需推进），TAPD 大小写也要兼容
  assert(actionable([normalize(rows[3])]).length === 1, 'resolved 仍未了结，应保留')

  // 翻页：第一页满、第二页空 → 必须停
  const pages = [
    JSON.stringify({ status: 1, data: Array.from({ length: 30 }, (_, index) => ({ Bug: { id: `p1-${index}`, status: 'new' } })) }),
    JSON.stringify({ status: 1, data: [] }),
  ]
  let calls = 0
  const fetchText = async () => pages[calls++] ?? pages[1]
  return (async () => {
    const bugs = await listBugs({ workspace: 1, owner: 'x', limit: 500, fetchText })
    assert(bugs.length === 30 && calls === 2, '翻页应在空页处停止')

    // 错误响应必须抛出，不能当作空列表
    let failed = ''
    try {
      parsePage(JSON.stringify({ status: 0, info: 'invalid token' }))
    } catch (error) {
      failed = error.message
    }
    assert(failed.includes('invalid token'), '错误响应应带 info')
    return true
  })()
}

async function main(argv) {
  const arg = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  if (argv.includes('--self-test')) {
    await selfTest()
    console.log('self-test passed')
    return 0
  }
  const workspace = Number(arg('--workspace', ''))
  const owner = arg('--owner', '')
  const limit = Number(arg('--limit', '200'))
  if (!Number.isFinite(workspace) || !owner || !Number.isFinite(limit) || limit <= 0) {
    console.error('usage: node scripts/tapd-bugs.mjs --workspace <id> --owner <tapd-nickname> [--limit 200] [--json] [--self-test]')
    return 1
  }
  let creds
  try {
    creds = credentials()
  } catch (error) {
    console.error(error.message)
    return 2
  }
  try {
    const bugs = await listBugs({ workspace, owner, limit, fetchText: httpFetch(creds.authorization) })
    console.log(argv.includes('--json') ? JSON.stringify(bugs, null, 2) : report(bugs))
    return 0
  } catch (error) {
    console.error(error.message)
    return 3
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/tapd-bugs.mjs')) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

