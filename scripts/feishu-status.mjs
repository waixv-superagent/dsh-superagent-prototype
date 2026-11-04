#!/usr/bin/env node
/**
 * superagent 状态卡：在 Feishu 里维护一条随状态变化的卡片（执行中 / 待验证 / 待拍板、空闲拟人、掉线红、模型上游断连恢复中）。
 *
 * 这条卡片要能在 DSH 进程挂掉时也变红，所以它是 dsh-superagent 之外的伴生脚本（和 scripts/dsh-superagent 一样）：
 * 由系统的计划任务每分钟跑一次，读本机管理 API，再发送 / 原地更新 / Pin 飞书卡片。脚本本身不写插件配置，也不改工单。
 *
 * 用法：
 *   node scripts/feishu-status.mjs --chat oc_xxx --panel-url http://127.0.0.1:3082 \
 *     --lark-cli /path/to/lark-bot
 *   node scripts/feishu-status.mjs --print-card --chat oc_xxx        # 只打印卡片 JSON，不发送
 *
 * 卡片原地更新（PATCH /open-apis/im/v1/messages/:id）要求发送时带上 config.update_multi=true，
 * 且只对 14 天内发送的消息有效；脚本在 13 天时换一张新卡，避免撞上窗口。
 *
 * 状态：<state-dir>/feishu-status.json（message_id、发送时间、Pin 状态、最后心跳），日志：同目录 feishu-status.log。
 * 退出码：0 正常（含“服务掉线、卡片已变红”）；1 配置或发送失败。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 默认面板地址；只在 loopback 上可用。 */
const DEFAULT_PANEL = 'http://127.0.0.1:3082'
/** 默认状态文件：DSH 默认 stateDir 下的一个旁文件。 */
const DEFAULT_STATE = join(homedir(), '.dsh', 'state', 'superagent', 'feishu-status.json')
/** 卡片创建后最多原地更新多少天再换新卡（官方窗口 14 天，留一天余量）。 */
const REFRESH_DAYS = 13
/** 连续多少次 PATCH 失败后强制换一张卡（用来兜住“消息太旧”这类没有专门错误码的拒绝）。 */
const MAX_PATCH_FAILURES = 3
/** 两次运行重叠时锁文件的最长寿命；超过视为上次异常退出留下的。 */
const LOCK_STALE_MS = 10 * 60_000
/** 日志文件大小上限，超过后保留一份 .1 备份再重开。 */
const LOG_LIMIT = 256 * 1024
/** Feishu 的卡片 header 允许的颜色。 */
const TEMPLATES = { idle: 'green', working: 'blue', waiting: 'orange', offline: 'red', paused: 'orange', problem: 'orange', expired: 'grey' }
/** 空闲时的拟人短句，按小时轮换，午休和深夜用更贴切的。 */
const IDLE_MOODS = ['甩尾巴中', '吐泡泡', '晒太阳', '摸鱼中', '发呆中']

/** 解析 `--flag value`、`--flag=value` 和没有值的开关（如 `--print-card`）。 */
export function parseArgs (argv) {
  const options = {}
  const flags = new Set()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!arg.startsWith('--')) {
      flags.add(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals !== -1) {
      options[arg.slice(2, equals)] = arg.slice(equals + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next
      index++
    } else {
      flags.add(key)
    }
  }
  return { options, flags }
}

/** 明细里一条工单需要的字段；只留标题、短状态和活跃时间，不把说明/链接带进卡片。 */
function ticketOf (item) {
  if (!item || typeof item !== 'object') return undefined
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const at = typeof item.pipeline?.at === 'string' ? item.pipeline.at : typeof item.updatedAt === 'string' ? item.updatedAt : ''
  return { title, action: typeof item.action === 'string' ? item.action : '', manual: item.pipeline?.manual === true, at }
}

function ticketsOf (value) {
  return Array.isArray(value) ? value.map(ticketOf).filter(Boolean) : []
}

/** 把管理 API 的 state/overview 归一成卡片需要的数字；缺字段按 0 处理，形状可选是为了测试样本可以很小。 */
export function snapshotOf (overview, state) {
  const count = (value) => Array.isArray(value) ? value.length : 0
  const executor = overview?.executor && typeof overview.executor === 'object' ? overview.executor : {}
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
  // 断连恢复状态由 state 里的 watchdog 字段给出；服务端没带这个字段时保持 null，卡片按原来的样子显示。
  const recovery = state?.watchdog && typeof state.watchdog === 'object' ? state.watchdog : undefined
  // 卡住告警由 state 里的 stall 字段给出；老服务端没有这个字段时按 0 处理。
  const stall = state?.stall && typeof state.stall === 'object' ? state.stall : undefined
  return {
    online: true,
    paused: state?.paused === true,
    runtime: typeof state?.health?.runtime?.state === 'string' ? state.health.runtime.state : 'ready',
    setupProblem: Boolean(state?.setup?.problem || state?.setup?.feishuProblem),
    problems: count(overview?.problems),
    stalled: number(stall?.tickets),
    watchdog: recovery ? {
      recovering: recovery.recovering === true,
      tickets: number(recovery.tickets),
      master: recovery.master === true,
      gaveUp: recovery.gaveUp === true,
      missing: recovery.missing === true
    } : null,
    counts: {
      working: count(overview?.working),
      verification: count(overview?.verification),
      person: count(overview?.person),
      pipeline: count(overview?.pipeline),
      idle: count(overview?.idle)
    },
    tickets: {
      working: ticketsOf(overview?.working),
      verification: ticketsOf(overview?.verification),
      person: ticketsOf(overview?.person),
      pipeline: ticketsOf(overview?.pipeline)
    },
    executor: {
      running: number(executor.running),
      queued: number(executor.queued),
      maxWorkers: number(executor.maxWorkers)
    }
  }
}

/** 连不上管理 API 时的快照：不猜数字，只保留“掉线”这个事实。 */
export function offlineSnapshot (error) {
  return { online: false, error: String(error?.message ?? error), paused: false, runtime: 'unknown', setupProblem: false, problems: 0, stalled: 0, watchdog: null,
    counts: null, tickets: null, executor: null }
}

/** 本地时间的 HH:MM；无效时间返回 `—`。 */
export function clock (value, seconds = false) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', ...seconds ? { second: '2-digit' } : {} })
}

/** 空闲时按本地时间挑一句拟人短句；同一小时内不变，避免每分钟闪烁。 */
export function idleMood (now) {
  const hour = now.getHours()
  const minute = now.getMinutes()
  if (hour >= 23 || hour < 7) return '打盹中'
  if (hour === 11 && minute >= 30) return '吃饭饭'
  if (hour === 12) return '吃饭饭'
  return IDLE_MOODS[hour % IDLE_MOODS.length]
}

/** 卡片要呈现的状态优先级：掉线 > 暂停 > 模型上游断连的恢复 > 工单卡住 > 其他问题 > 等人 > 在跑 > 空闲。 */
function stateOf (snapshot, now) {
  if (!snapshot.online) return { kind: 'offline', title: '🔴 掉线了', template: TEMPLATES.offline }
  if (snapshot.paused) return { kind: 'paused', title: '⏸️ 暂停中', template: TEMPLATES.paused }
  // 上游断连时面板本身还在，watchdog 正在自动重试：先把这件事说清楚，而不是只报“有问题”。
  if (snapshot.watchdog?.gaveUp) return { kind: 'watchdog', title: '🔴 模型上游断连 · 自动恢复已停止', template: TEMPLATES.offline }
  if (snapshot.watchdog?.missing) return { kind: 'watchdog', title: '🟠 主对话掉线 · 正在重建', template: TEMPLATES.problem }
  if (snapshot.watchdog?.recovering) return { kind: 'watchdog', title: '🟠 模型上游断连 · 自动恢复中', template: TEMPLATES.waiting }
  // 卡住的工单不会自己好，人需要去看：排在一般问题前面。
  if (snapshot.stalled > 0) return { kind: 'stall', title: `🟠 ${snapshot.stalled} 张工单疑似卡住`, template: TEMPLATES.problem }
  if (snapshot.problems > 0 || snapshot.setupProblem) return { kind: 'problem', title: `🟠 有 ${Math.max(snapshot.problems, 1)} 个问题`, template: TEMPLATES.problem }
  if (snapshot.counts.person > 0) return { kind: 'person', title: `🟠 有 ${snapshot.counts.person} 件等你拍板`, template: TEMPLATES.waiting }
  if (snapshot.counts.verification > 0) return { kind: 'verify', title: `🟠 有 ${snapshot.counts.verification} 件等你验证`, template: TEMPLATES.waiting }
  if (snapshot.counts.working > 0 || snapshot.counts.pipeline > 0 || snapshot.executor.running > 0) return { kind: 'working', title: '🔵 正在干活', template: TEMPLATES.working }
  return { kind: 'idle', title: `🐟 ${idleMood(now)}`, template: TEMPLATES.idle }
}

/** 模型上游断连时的一句话：正在恢复什么，恢复不了时要人做什么。 */
function watchdogNote (watchdog) {
  if (watchdog.gaveUp) return '自动重试已用完 · 需要人工处理'
  if (watchdog.missing) return '主会话不在了 · watchdog 正在重建'
  const parts = ['模型上游断连 · watchdog 自动重试中']
  if (watchdog.tickets > 0) parts.push(`${watchdog.tickets} 张工单待恢复`)
  if (watchdog.master) parts.push('主会话自动续跑')
  return parts.join(' · ')
}

/** 列表预览里的一行；Feishu 用它显示会话最后一条消息。 */
function summaryOf (snapshot, status, now) {
  if (status.kind === 'offline') return '状态｜掉线了'
  if (status.kind === 'paused') return '状态｜暂停中'
  if (status.kind === 'watchdog') {
    if (snapshot.watchdog?.gaveUp) return '状态｜模型上游断连，自动恢复已停止'
    if (snapshot.watchdog?.missing) return '状态｜主对话掉线，正在重建'
    return '状态｜模型上游断连，自动恢复中'
  }
  if (status.kind === 'stall') return `状态｜${snapshot.stalled} 张工单疑似卡住`
  const counts = snapshot.counts
  const line = `在跑 ${counts.working} · 待验证 ${counts.verification} · 待拍板 ${counts.person}`
  if (status.kind === 'idle') return `状态｜${line}｜${idleMood(now)}`
  return `状态｜${line}`
}

/** 相对时间：手机上比绝对时间更好读；超过一周只显示周数。 */
export function ago (value, now = new Date()) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.floor((now.getTime() - time) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return `${Math.floor(days / 7)} 周前`
}

/** 明细行的标题：压成一行并截断，避免一条长标题把手机上的卡片撑破。 */
export function shortTitle (value, max = 26) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 工单标题里的 Markdown 特殊字符转成实体，避免标题被卡片当成格式。 */
function escapeMd (text) {
  return text.replace(/[<>&*_~`\[\]()#\\]/g, ch => `&#${ch.charCodeAt(0)};`)
}

/** 明细里按状态分块；短状态只给需要区分“卡住/待提交”的两类状态。 */
const DETAIL_GROUPS = [
  { key: 'working', label: '执行中' },
  { key: 'verification', label: '待验证' },
  { key: 'person', label: '待拍板', tag: item => item.action === 'blocked' ? '阻塞' : '' },
  { key: 'pipeline', label: '流水线', tag: item => item.manual ? '待提交' : '' }
]

/**
 * 可展开的工单明细：一类状态一块，每行是「工单名 · 短状态 · 多久没动」。
 * 主要场景是手机/电脑上扫一眼，所以标题截断、只用固定短词，不放长说明和链接。
 */
function detailPanel (snapshot, now) {
  const tickets = snapshot.tickets
  if (!snapshot.online || !tickets) return undefined
  const groups = DETAIL_GROUPS
    .map(group => ({ ...group, items: tickets[group.key] ?? [] }))
    .filter(group => group.items.length > 0)
  if (groups.length === 0) return undefined
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'plain_text', content: `工单明细 · ${total} 件` }, width: 'fill' },
    elements: groups.map(group => ({
      tag: 'markdown',
      content: `**${group.label} ${group.items.length}**\n${group.items.map(item => {
        const tag = group.tag?.(item) ?? ''
        const when = ago(item.at, now)
        const parts = [escapeMd(shortTitle(item.title || '未命名工单'))]
        if (tag) parts.push(tag)
        if (when) parts.push(when)
        return `- ${parts.join(' · ')}`
      }).join('\n')}`,
      text_size: 'normal'
    }))
  }
}

/**
 * 三个数字并排的指标卡：数字放大成焦点，标签灰色小字。
 * `counts` 为 null 表示没读到（掉线），显示 — 而不是猜 0。
 * 数字不带 `<font>` 之类的卡内 HTML：lark-cli 的 .cmd 包装经 cmd.exe 运行，卡片内容里不能有 < >。
 */
function metricsElement (counts) {
  const column = (value, label) => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    background_style: 'grey-50',
    padding: '12px',
    vertical_spacing: '2px',
    elements: [
      { tag: 'markdown', content: counts ? `## ${value}` : '## —', text_align: 'center' },
      { tag: 'markdown', content: label, text_align: 'center', text_size: 'notation' }
    ]
  })
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [column(counts?.working, '执行中'), column(counts?.verification, '待验证'), column(counts?.person, '待拍板')]
  }
}

/** 飞书客户端识别的“跳到系统浏览器打开”参数：桌面端 V7.7+、移动端 V7.11+，优先级高于用户的链接打开方式设置。 */
const BROWSER_PARAMS = ['lk_jump_to_browser', 'lk_mobile_jump_to_browser']

/**
 * 给看板地址补上飞书的跳浏览器参数：飞书内嵌 webview 不弹 Basic 认证框，看板在里面打不开。
 * 已有的 query 与 hash 保持不变，参数已在则不重复；解析不了的地址原样返回。
 */
export function browserLink (url) {
  let parsed
  try { parsed = new URL(url) } catch { return url }
  for (const name of BROWSER_PARAMS) if (!parsed.searchParams.has(name)) parsed.searchParams.append(name, 'true')
  return parsed.href
}

/**
 * 拼一张 Card 2.0 卡片。数字和固定短句之外，展开明细里会带工单名和活跃时间，所以这张卡只能发到私密会话。
 * `lastOkAt` 用于掉线时告诉人最后一次成功读到状态是什么时候；`link` 是整卡点击跳转的看板地址，
 * 卡片上会带飞书的跳浏览器参数，让它在系统浏览器而不是飞书内嵌 webview 里打开。
 */
export function composeCard (snapshot, { now = new Date(), lastOkAt = null, link = '' } = {}) {
  const status = stateOf(snapshot, now)
  const counts = snapshot.counts
  let subtitle
  if (!snapshot.online) subtitle = `最后心跳 ${lastOkAt ? clock(lastOkAt) : '—'}`
  else if (snapshot.paused) subtitle = `已暂停接活 · 更新 ${clock(now, true)}`
  else subtitle = `更新 ${clock(now, true)}`
  let note
  if (!snapshot.online) note = '主机服务没响应 · 等待重连'
  else if (snapshot.paused) note = '暂停期间不接新活 · 恢复请点面板'
  else if (snapshot.watchdog && (snapshot.watchdog.recovering || snapshot.watchdog.gaveUp || snapshot.watchdog.missing)) note = watchdogNote(snapshot.watchdog)
  else if (snapshot.stalled > 0) note = '长时间没有进展 · 已在工单原会话提醒 · 可在面板重试或停止'
  else if (snapshot.problems > 0 || snapshot.setupProblem) note = `面板上有 ${Math.max(snapshot.problems, 1)} 个问题`
  else {
    const executor = snapshot.executor
    const parts = [`执行器 ${executor.running}/${executor.maxWorkers}`, `排队 ${executor.queued}`]
    if (counts.pipeline > 0) parts.push(`流水线 ${counts.pipeline}`)
    note = parts.join(' · ')
  }
  const summary = summaryOf(snapshot, status, now)
  const elements = [metricsElement(counts)]
  const panel = detailPanel(snapshot, now)
  if (panel) elements.push(panel)
  elements.push({ tag: 'markdown', content: note, text_align: 'center', text_size: 'notation' })
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'compact', summary: { content: summary } },
    header: {
      title: { tag: 'plain_text', content: status.title },
      subtitle: { tag: 'plain_text', content: subtitle },
      template: status.template
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '8px',
      elements
    }
  }
  const href = typeof link === 'string' ? link.trim() : ''
  if (href) card.card_link = { url: browserLink(href) }
  return { card, title: status.title, template: status.template, kind: status.kind, summary }
}

/** 卡片是否已经到了该换新卡的时间；没有发送时间也算需要重建。 */
export function cardExpired (sentAt, now = new Date()) {
  if (!sentAt) return true
  const sent = Date.parse(sentAt)
  if (Number.isNaN(sent)) return true
  return now.getTime() - sent >= REFRESH_DAYS * 24 * 60 * 60_000
}

/** 从 +messages-send 的结果里取 message_id，兼容 `{ok,data}` 和直接平铺两种输出。 */
export function messageIdOf (output) {
  const parsed = typeof output === 'string' ? safeJson(output) : output
  const data = parsed?.data ?? parsed
  const id = data?.message_id
  return typeof id === 'string' && id ? id : undefined
}

function safeJson (text) {
  try { return JSON.parse(text) } catch { return undefined }
}

/** 把飞书对“消息不在了”的拒绝认出来；其他错误继续按普通失败处理。 */
export function isGoneError (error) {
  const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`
  return /230011|message (?:not found|not exist)|not found|不存在|已撤回|withdrawn|recalled/i.test(text)
}

/** 掉线时告诉人“这张卡已经过期”，避免旧卡上的数字被当真；失败就忽略，旧卡本身已经不可更新时正好这样。 */
function expiredCard () {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: '状态｜这张状态卡已过期' } },
    header: { title: { tag: 'plain_text', content: '⌛ 这张状态卡已过期' }, template: TEMPLATES.expired },
    body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements: [{ tag: 'markdown', content: '下面那张才是现在用的状态卡。' }] }
  }
}

/** 读状态文件；不存在、损坏或形状不符都当作第一次运行，不阻塞发卡。 */
export function readState (file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function writeState (file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** 同一分钟里多个计划任务重叠时只跑一个；锁超过 10 分钟视为上次异常退出的残留。 */
function acquireLock (file) {
  const lock = `${file}.lock`
  mkdirSync(dirname(file), { recursive: true })
  const write = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
  try {
    write()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    try {
      if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return null
      unlinkSync(lock)
      write()
    } catch {
      return null
    }
  }
  return () => { try { unlinkSync(lock) } catch {} }
}

/** 日志只记录状态变化、重建、Pin 失败和错误；每分钟一次的原地更新不写，避免日志膨胀。 */
function makeLog (stateFile) {
  const file = join(dirname(stateFile), 'feishu-status.log')
  return (line) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`)
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // 日志写不进去不影响卡片；失败信息已经通过退出码体现。
    }
  }
}

/** 卡片 JSON 里不允许出现 cmd 的重定向字符（Windows 上 lark-cli.cmd 经 cmd.exe /c 运行）。 */
function cmdSafe (value) {
  return JSON.stringify(value).replace(/[<>]/g, '')
}

function makeKey (chat, now) {
  return `fs-${chat.slice(-6)}-${now.getTime().toString(36)}`.slice(0, 50)
}

/** 真实依赖：调用 lark-cli（Windows 上 .cmd/.bat 经 cmd.exe 转一层，和插件里的 Commands 一致）。 */
function makeLark (cli) {
  return async (args) => {
    const wrapped = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cli)
    const program = wrapped ? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe' : cli
    const argv = wrapped ? ['/c', cli, ...args] : args
    try {
      const { stdout } = await execFileAsync(program, argv, {
        timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }
      })
      return JSON.parse(stdout)
    } catch (error) {
      const detail = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n').slice(0, 2000)
      throw new Error(`lark-cli ${args[0]} ${args[1] ?? ''} 失败：${detail}`)
    }
  }
}

/** 读一次状态；overview 是必需数据，state 读不到时按“服务在、状态未知”处理，不把整个服务判成掉线。 */
export async function collect (panelUrl, fetchImpl = fetch, now = new Date()) {
  const base = panelUrl.replace(/\/+$/, '')
  const get = async (path) => {
    const response = await fetchImpl(`${base}${path}`, {
      headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`)
    return response.json()
  }
  let overview
  try {
    overview = await get('/orchestrator/api/overview')
  } catch (error) {
    return offlineSnapshot(error)
  }
  let state
  try {
    state = await get('/orchestrator/api/state')
  } catch {
    state = undefined
  }
  return snapshotOf(overview, state, now)
}

/**
 * 跑一次：读状态 → 拼卡 → 首次发送或原地更新 → 没 Pin 就补 Pin。
 * 依赖全部从参数注入，测试可以用假的 fetch/lark 和临时 state 文件。
 */
export async function runOnce (options = {}) {
  const {
    chat, panelUrl = DEFAULT_PANEL, stateFile = DEFAULT_STATE, lark, link = '',
    fetchImpl = fetch, now = new Date(), print = false, lock = true, log = () => {}
  } = options
  const release = lock ? acquireLock(stateFile) : () => {}
  if (!release) return { action: 'locked' }
  try {
    const state = readState(stateFile)
    const snapshot = await collect(panelUrl, fetchImpl, now)
    const lastOkAt = snapshot.online ? now.toISOString() : (typeof state.lastOkAt === 'string' ? state.lastOkAt : null)
    const view = composeCard(snapshot, { now, lastOkAt, link })
    if (print) return { action: 'print', card: view.card, view, online: snapshot.online }

    if (state.lastOkAt !== lastOkAt) state.lastOkAt = lastOkAt
    const changed = () => `${state.lastKind ?? 'none'} -> ${view.kind}`
    const recordKind = () => {
      if (state.lastKind !== view.kind) log(`状态 ${changed()}`)
      state.lastKind = view.kind
    }

    const send = async () => {
      state.pendingKey = typeof state.pendingKey === 'string' && state.pendingKey ? state.pendingKey : makeKey(chat, now)
      writeState(stateFile, state)
      const id = messageIdOf(await lark(['im', '+messages-send', '--chat-id', chat, '--msg-type', 'interactive',
        '--content', cmdSafe(view.card), '--idempotency-key', state.pendingKey]))
      if (!id) throw new Error('发送成功但没有返回 message_id')
      state.messageId = id
      state.chatId = chat
      state.sentAt = now.toISOString()
      state.pinned = false
      state.patchFailures = 0
      delete state.pendingKey
      writeState(stateFile, state)
      log(`新卡 ${id}`)
      return id
    }
    const patch = async (id, card) => lark(['api', 'PATCH', `/open-apis/im/v1/messages/${id}`,
      '--data', JSON.stringify({ content: cmdSafe(card) })])
    const pin = async (id) => {
      await lark(['api', 'POST', '/open-apis/im/v1/pins', '--data', JSON.stringify({ message_id: id })])
      state.pinned = true
      state.pinError = null
      writeState(stateFile, state)
    }

    let action = 'patched'
    if (state.chatId !== chat || !state.messageId || cardExpired(state.sentAt, now)) {
      if (state.messageId && state.chatId === chat) {
        try { await patch(state.messageId, expiredCard()) } catch { /* 旧卡太旧/被撤回时正好不用再管 */ }
      }
      action = 'sent'
      await send()
    } else {
      try {
        await patch(state.messageId, view.card)
        state.patchFailures = 0
      } catch (error) {
        if (isGoneError(error)) {
          state.messageId = null
          state.pinned = false
          writeState(stateFile, state)
          log(`旧卡不在了，重发：${String(error?.message ?? error).slice(0, 200)}`)
          action = 'sent'
          await send()
        } else {
          state.patchFailures = (Number.isInteger(state.patchFailures) ? state.patchFailures : 0) + 1
          if (state.patchFailures >= MAX_PATCH_FAILURES) {
            state.messageId = null
            state.pinned = false
            writeState(stateFile, state)
            log(`连续 ${MAX_PATCH_FAILURES} 次更新失败，换新卡：${String(error?.message ?? error).slice(0, 200)}`)
            action = 'sent'
            await send()
          } else {
            writeState(stateFile, state)
            throw error
          }
        }
      }
    }

    if (!state.pinned && state.messageId) {
      try {
        await pin(state.messageId)
      } catch (error) {
        if (!state.pinError) log(`Pin 失败：${String(error?.message ?? error).slice(0, 200)}`)
        state.pinError = String(error?.message ?? error).slice(0, 500)
        writeState(stateFile, state)
      }
    }
    recordKind()
    writeState(stateFile, state)
    return { action, messageId: state.messageId, online: snapshot.online, kind: view.kind }
  } finally {
    release()
  }
}

function usage () {
  return [
    '用法：node scripts/feishu-status.mjs --chat <oc_…> [选项]',
    '',
    '  --chat <oc_…>        状态卡发送到的会话 id（必填；--print-card 时可选）',
    '  --panel-url <url>    本机面板地址，默认 http://127.0.0.1:3082',
    '  --lark-cli <path>    lark-cli 或 bot 包装脚本，默认 lark-cli',
    '  --state-file <path>  状态文件，默认 ~/.dsh/state/superagent/feishu-status.json',
    '  --link-url <url>     卡片点击跳转的看板地址，会在系统浏览器打开；不传则卡片不可点（建议 <面板>/?view=board）',
    '  --print-card         只打印卡片 JSON，不发送',
    '  --help               显示这段帮助',
    '',
    '环境变量：DSH_FEISHU_STATUS_CHAT / _PANEL / _LARK / _STATE / _LINK。'
  ].join('\n')
}

async function main () {
  const { options, flags } = parseArgs(process.argv.slice(2))
  if (flags.has('help') || flags.has('h')) {
    console.log(usage())
    return
  }
  const chat = options.chat ?? process.env.DSH_FEISHU_STATUS_CHAT ?? ''
  const panelUrl = options['panel-url'] ?? process.env.DSH_FEISHU_STATUS_PANEL ?? DEFAULT_PANEL
  const larkCli = options['lark-cli'] ?? process.env.DSH_FEISHU_STATUS_LARK ?? 'lark-cli'
  const stateFile = options['state-file'] ?? process.env.DSH_FEISHU_STATUS_STATE ?? DEFAULT_STATE
  const link = options['link-url'] ?? process.env.DSH_FEISHU_STATUS_LINK ?? ''
  const print = flags.has('print-card')
  if (!print && !chat) {
    console.error(usage())
    process.exitCode = 1
    return
  }
  const now = options.now ? new Date(options.now) : new Date()
  if (Number.isNaN(now.getTime())) {
    console.error(`无法解析 --now：${options.now}`)
    process.exitCode = 1
    return
  }
  const log = makeLog(stateFile)
  try {
    const result = await runOnce({ chat, panelUrl, stateFile, link, lark: makeLark(larkCli), now, print, log })
    if (print) console.log(JSON.stringify(result.card, null, 2))
  } catch (error) {
    log(`错误：${String(error?.message ?? error).slice(0, 1000)}`)
    throw error
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href.toLowerCase() === import.meta.url.toLowerCase() : false
if (invoked) {
  main().catch((error) => {
    console.error(String(error?.stack ?? error))
    process.exitCode = 1
  })
}
