#!/usr/bin/env node
/**
 * daily-retro：每日复盘的承诺台账与报告渲染。数字只来自 daily-metrics 的 metrics.json，模型只写叙述（narrative.md）。
 *
 * 用法：
 *   node scripts/daily-retro.mjs ledger list   [--ledger retro-ledger.json]
 *   node scripts/daily-retro.mjs ledger add    --text "一句话承诺" --due 2026-11-05 [--ticket 42bed3b9] [--from 2026-11-04]
 *   node scripts/daily-retro.mjs ledger set    <id> --status done|partial|missed|dropped|open [--note "…"] [--ticket …]
 *   node scripts/daily-retro.mjs ledger reconcile --date 2026-11-05 [--db orchestrator.sqlite] [--apply]
 *   node scripts/daily-retro.mjs render --metrics m.json [--previous prev.json] [--ledger …] [--narrative narrative.md] --out report.html
 *
 * 台账默认在 ~/.dsh/state/superagent/retro-ledger.json（与 feishu-status.json 同目录）。reconcile 只读数据库：工单已完成/已合并
 * 判为兑现，已停止判为放弃，到期仍未结判为未兑现，没有工单号的标“未开单”；不加 --apply 只打印建议，不改台账。
 * 退出码：0 成功；1 参数错误或文件读写失败；render 缺叙述段时仍输出 HTML 并在 stderr 列出缺段（退出码 0）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from './daily-metrics.mjs'

export const LEDGER_VERSION = 1
export const TEMPLATE_VERSION = 4
export const STATUSES = ['open', 'done', 'partial', 'missed', 'dropped']
const STATUS_LABEL = { open: '进行中', done: '已兑现', partial: '半兑现', missed: '未兑现', dropped: '已放弃' }
const KIND_LABEL = { feature: '需求', bug: 'bug', self: '自迭代', inquiry: '问询', chat: '闲聊' }
/** 叙述段：模型在 narrative.md 里用 `## <key>` 写这些段；缺段会在报告里显眼地标出来。 */
export const NARRATIVE_SECTIONS = [
  ['summary', '三行结论'],
  ['interview', '采访人的感受'],
  ['review', '四类复盘（需求 / bug / 闲聊 / 问询）'],
  ['bottlenecks', '瓶颈（现状 / 缺什么 / 谁该修）'],
  ['plan', '明日方案'],
  ['research', '外部对照与调研'],
  ['template', '模板本身要改的'],
]

const defaultLedger = () => join(homedir(), '.dsh', 'state', 'superagent', 'retro-ledger.json')

export function emptyLedger () { return { version: LEDGER_VERSION, items: [] } }

export function readLedger (path) {
  if (!existsSync(path)) return emptyLedger()
  const ledger = JSON.parse(readFileSync(path, 'utf8'))
  if (ledger.version !== LEDGER_VERSION || !Array.isArray(ledger.items)) throw new Error(`${path} 不是 v${LEDGER_VERSION} 承诺台账`)
  return ledger
}

export function writeLedger (path, ledger) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n')
  renameSync(tmp, path)
}

const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

/** 新增一条承诺；`id` 是递增的 `C<n>`，删除过的号不复用。 */
export function addCommitment (ledger, { text, due, ticket, from }) {
  if (!text?.trim()) throw new Error('--text 不能为空')
  if (!isDate(due)) throw new Error(`--due 需要 YYYY-MM-DD，收到 ${due}`)
  if (from !== undefined && !isDate(from)) throw new Error(`--from 需要 YYYY-MM-DD，收到 ${from}`)
  const next = ledger.items.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0) + 1
  const item = { id: `C${next}`, text: text.trim(), ticket: ticket?.trim() || null, due, from: from ?? null, status: 'open', note: null, history: [] }
  ledger.items.push(item)
  return item
}

export function setCommitment (ledger, id, { status, note, ticket }, on) {
  const item = ledger.items.find(entry => entry.id === id)
  if (!item) throw new Error(`台账里没有 ${id}`)
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new Error(`--status 只能是 ${STATUSES.join(' / ')}`)
    if (status !== item.status) item.history.push({ on, from: item.status, to: status })
    item.status = status
  }
  if (note !== undefined) item.note = note
  if (ticket !== undefined) item.ticket = ticket || null
  return item
}

/**
 * 按工单状态给每条未结承诺一个建议：`lookup(prefix)` 返回 `{ ended?: { outcome } }` 或 undefined。
 * 已兑现 / 已放弃的承诺不再动；返回 `{ id, from, to, reason }` 的列表，`to` 与 `from` 相同的不返回。
 */
export function reconcile (ledger, date, lookup) {
  const changes = []
  for (const item of ledger.items) {
    if (item.status === 'done' || item.status === 'dropped') continue
    const overdue = item.due < date
    let to = item.status, reason
    if (!item.ticket) { reason = '未开单'; if (overdue) to = 'missed' }
    else {
      const ticket = lookup(item.ticket)
      if (!ticket) reason = `找不到工单 ${item.ticket}`
      else if (ticket.ended?.outcome === 'completed' || ticket.ended?.outcome === 'merged') { to = 'done'; reason = `工单${ticket.ended.outcome === 'merged' ? '已合并' : '已完成'}` }
      else if (ticket.ended?.outcome === 'stopped') { to = 'dropped'; reason = '工单被停止' }
      else if (ticket.ended) reason = `工单已结束（${ticket.ended.outcome}），需人工判定`
      else reason = '工单未结'
      if (to === item.status && overdue && !ticket?.ended) { to = 'missed'; reason += '，已过截止日' }
    }
    if (to !== item.status || reason === '未开单') changes.push({ id: item.id, from: item.status, to, reason })
  }
  return changes
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ESC[ch])

/** 极简 Markdown：段落、`-`/`1.` 列表、`**粗**`、`` `码` ``、`[文字](https://…)`、`###` 小标题、`|` 表格。输入先转义，不放行原始 HTML。 */
export function markdown (source) {
  const inline = text => escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
  const out = []
  let list, para = [], table
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = [] }
    if (list) { out.push(`<${list.tag}>${list.items.map(item => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`); list = undefined }
    if (table) {
      const [head, ...body] = table.filter(row => !/^\s*\|?\s*:?-{2,}/.test(row))
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      out.push(`<div class="table-wrap"><table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map(row => `<tr>${cells(row).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      table = undefined
    }
  }
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line), numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line), heading = /^###\s+(.*)$/.exec(line)
    if (!line.trim()) { flush(); continue }
    if (line.trim().startsWith('|')) { if (!table) { flush(); table = [] } table.push(line); continue }
    if (heading) { flush(); out.push(`<h4>${inline(heading[1])}</h4>`); continue }
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol'
      if (para.length || (list && list.tag !== tag) || table) flush()
      list ??= { tag, items: [] }
      list.items.push((bullet ?? numbered)[1])
      continue
    }
    if (list || table) flush()
    para.push(line.trim())
  }
  flush()
  return out.join('\n')
}

/** 把 narrative.md 按 `## <key>` 切段；未知 key 也保留，渲染时附在“其他”。 */
export function parseNarrative (source) {
  const sections = {}
  let key
  for (const line of (source ?? '').split(/\r?\n/)) {
    const heading = /^##\s+([\w-]+)\s*$/.exec(line)
    if (heading) { key = heading[1]; sections[key] = []; continue }
    if (key) sections[key].push(line)
  }
  return Object.fromEntries(Object.entries(sections).map(([k, lines]) => [k, lines.join('\n').trim()]).filter(([, text]) => text))
}

const fmt = n => Number(n ?? 0).toLocaleString('en-US')
function delta (current, previous, { goodWhenDown = false } = {}) {
  if (previous === undefined || previous === null) return ''
  const d = current - previous
  if (!d) return '<span class="d flat">与昨天持平</span>'
  const good = goodWhenDown ? d < 0 : d > 0
  return `<span class="d ${good ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)} vs 昨天</span>`
}

/**
 * 小时图：每小时一行，两段首尾相接——先是人类消息段，紧接着是 agent 段；agent 段内按颜色分工具调用、流程推进（非 ready 报告）
 * 与交付（ready 报告 + 合并 PR + 入库 CL）。每个系列按全天自己的峰值缩放到固定份额，图例写明各自的峰值。
 */
export function hourlyChart (hourly) {
  const rows = hourly.filter(h => h.human || h.toolCalls || h.progress || h.deliveries || h.failed)
  if (!rows.length) return '<p class="muted">窗口内没有人类消息，也没有 agent 活动。</p>'
  const max = key => Math.max(1, ...rows.map(h => h[key]))
  const peak = { human: max('human'), toolCalls: max('toolCalls'), progress: max('progress'), deliveries: max('deliveries') }
  // 份额（百分比）：人类段最长 38%，agent 段的三色合计最长 62%。
  const share = { human: 38, toolCalls: 34, progress: 12, deliveries: 16 }
  const seg = (h, key, cls, label) => {
    const width = (h[key] / peak[key]) * share[key]
    return h[key] ? `<i class="seg ${cls}" style="width:${width.toFixed(2)}%" title="${label} ${h[key]}"></i>` : ''
  }
  const lines = rows.map(h => `<div class="hrow"><span class="hl">${String(h.hour).padStart(2, '0')} 时</span><div class="htrack">${
    seg(h, 'human', 'human', '人类消息')}<span class="join"></span>${seg(h, 'toolCalls', 'tools', '工具调用')}${seg(h, 'progress', 'progress', '流程推进')}${
    seg(h, 'deliveries', 'deliver', '交付')}</div><span class="hv"><b class="c-human">${h.human}</b> · <b class="c-tools">${fmt(h.toolCalls)}</b> · <b class="c-progress">${h.progress}</b> · <b class="c-deliver">${h.deliveries}</b>${
    h.failed ? ` · <b class="c-failed">失败 ${h.failed}</b>` : ''}</span></div>`)
  const legend = `<div class="legend"><span><i class="sw human"></i>人类消息（峰值 ${peak.human}）</span><span class="arrow">→ 接着</span><span><i class="sw tools"></i>Agent 工具调用（峰值 ${fmt(peak.toolCalls)}）</span><span><i class="sw progress"></i>流程推进：非 ready 报告（峰值 ${peak.progress}）</span><span><i class="sw deliver"></i>交付：ready + 合并 PR + 入库 CL（峰值 ${peak.deliveries}）</span></div>`
  return `${legend}<div class="hours">${lines.join('')}</div><p class="small muted">每行左段是人在说话，右段紧接着是 agent 在干活；每种颜色按全天自己的峰值缩放，所以比较的是同一系列在不同小时的起伏，不是不同颜色之间的绝对量。右侧数字依次是：人类消息 · 工具调用 · 推进 · 交付。</p>`
}

// 视觉基线：2026-11-06 复盘 v2（米白 / 黛蓝、分格 KPI）。报告每天由 render 生成，样式只在这里改，
// 不再对生成的 HTML 手工改 CSS。
const CSS = `:root{--paper:#f7f5f0;--card:#fff;--ink:#1d2329;--ink2:#3a424b;--muted:#5b636c;--line:#e3ded4;--line2:#cfc8bb;--wash:#f2efe9;--accent:#2c4a6e;--accent-soft:#6f8099;--human:#3d5f8a;--tools:#aab3bd;--progress:#c9a25a;--deliver:#5b8a72;--good:#2f6b4f;--warn:#8a5a00;--bad:#b42318;--bad-wash:#fbf1ee;--bad-line:#ecc9c1}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.75 "PingFang SC","Microsoft YaHei","Noto Sans SC","Hiragino Sans GB",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1120px;margin:0 auto;padding:48px 32px 72px}
b,strong{font-weight:600}
a{color:var(--accent);text-decoration:underline;text-decoration-color:rgba(44,74,110,.35);text-underline-offset:3px}
a:hover{text-decoration-color:var(--accent)}
p{margin:0 0 14px}
ul{margin:0 0 16px;padding-left:1.25em}
li{margin:0 0 6px;overflow-wrap:break-word;word-wrap:break-word}
li::marker{color:var(--accent-soft)}
section>p,section>ul{max-width:54em}

/* 刊头与章节 */
header{padding-bottom:22px;border-bottom:2px solid var(--ink)}
header:before{content:"";display:block;width:36px;height:3px;background:var(--accent);margin-bottom:18px}
header h1{margin:0 0 8px;font-size:32px;line-height:1.3;font-weight:600;letter-spacing:.02em}
header .sub{color:var(--muted);font-size:14px}
section{margin-top:64px}
h2{display:flex;align-items:baseline;margin:0 0 22px;padding-top:16px;border-top:1px solid var(--line2);font-size:22px;line-height:1.35;font-weight:600;letter-spacing:.02em}
h2 .no{flex:none;min-width:52px;margin-right:14px;color:var(--accent-soft);font-size:34px;line-height:1;font-weight:300;letter-spacing:0;font-variant-numeric:tabular-nums;font-family:"Segoe UI","Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
h3{margin:34px 0 12px;font-size:17px;line-height:1.45;font-weight:600}
h3:before{content:"";display:inline-block;width:3px;height:14px;margin-right:10px;background:var(--accent);vertical-align:-1px}
h4{margin:28px 0 8px;font-size:15.5px;line-height:1.5;font-weight:600;color:var(--ink2)}
.muted{color:var(--muted)}
.small{font-size:13px;line-height:1.65}
p.small{margin-top:12px}
code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:13px;color:#2b3540;background:var(--wash);padding:1px 5px;border-radius:3px;white-space:nowrap}
.tag{display:inline-block;padding:0 7px;border:1px solid var(--line);border-radius:3px;background:var(--wash);color:var(--ink2);font-size:13px;line-height:1.7;white-space:nowrap}

/* KPI：一块分格面板，细线分隔 */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin:28px 0 0;background:var(--line);border:1px solid var(--line);border-top:2px solid var(--ink)}
.kpi{background:var(--card);padding:16px 18px 14px}
.kpi .n{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;font-family:"Segoe UI","Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
.kpi .l{margin-top:6px;color:var(--muted);font-size:13px;line-height:1.6}
.d{display:block;margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:13px;font-variant-numeric:tabular-nums}
.d.up{color:var(--good)}.d.down{color:var(--bad)}.d.flat{color:var(--muted)}

/* 第一屏警示 */
.alert{margin:24px 0 0;padding:16px 22px 10px;background:var(--bad-wash);border:1px solid var(--bad-line);border-left:3px solid var(--bad)}
.alert>b{display:block;margin-bottom:8px;color:var(--bad);font-size:15px}
.alert ul{margin:0 0 6px;padding-left:1.1em}
.alert li{margin:0 0 7px;font-size:14px;line-height:1.7}
.alert li::marker{color:var(--bad)}
.alert li>b:first-child{display:inline-block;min-width:2.4em;font-variant-numeric:tabular-nums}
.alert code{background:#fff}
.ok{margin:16px 0;padding:14px 20px;background:#f1f6f2;border:1px solid #cfe0d4;border-left:3px solid var(--good)}
.todo{margin:16px 0;padding:12px 18px;background:#faf5ea;border:1px dashed var(--progress);color:var(--warn)}

/* 表格 */
.table-wrap{margin:12px 0 22px;overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:4px}
.table-wrap.compact{display:inline-block;min-width:360px;max-width:100%;vertical-align:top}
table{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.65}
th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{background:var(--wash);color:var(--ink2);font-size:13px;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line2)}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#fbfaf7}
td.small{color:var(--ink2);overflow-wrap:break-word;word-wrap:break-word;word-break:break-word}
.compact td:last-child,.compact th:last-child{text-align:right;font-variant-numeric:tabular-nums}
#s3 td:nth-child(1),#s4 td:nth-child(1),#s4 td:nth-child(4),#s4 td:nth-child(5),#s5 td:nth-child(1),#s7 td:nth-child(1),#s7 td:nth-child(5),#s9 td:nth-child(1){white-space:nowrap}
#s3 td:nth-child(1),#s5 td:nth-child(1),#s4 td:nth-child(4){color:var(--muted);font-variant-numeric:tabular-nums}
#s3 th:nth-child(5),#s3 th:nth-child(6),#s3 td:nth-child(5),#s3 td:nth-child(6){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
#s3 td:nth-child(7){white-space:nowrap;color:var(--ink2)}
#s3 td:nth-child(8){min-width:150px}
#s4 td:nth-child(1),#s7 td:nth-child(1),#s7 td:nth-child(5),#s9 td:nth-child(1){font-weight:600;font-variant-numeric:tabular-nums}
#s4 td:nth-child(2){min-width:280px}
#s7 td:nth-child(1){color:var(--accent)}
#s5 .compact td:first-child{color:var(--ink)}

/* 状态色：红只给风险与未兑现 */
.st-done{color:var(--good)}.st-missed{color:var(--bad);font-weight:600}.st-partial{color:var(--warn)}.st-open{color:var(--accent)}.st-dropped{color:var(--muted)}
td.st-done,td.st-missed,td.st-partial,td.st-open,td.st-dropped{font-weight:600;white-space:nowrap}
td.st-done:before,td.st-missed:before,td.st-partial:before,td.st-open:before,td.st-dropped:before{content:"";display:inline-block;width:7px;height:7px;margin-right:7px;border-radius:50%;background:currentColor;vertical-align:1px}

/* 小时图 */
.legend{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0 0 12px;font-size:13px;color:var(--ink2)}
.legend .arrow{color:var(--muted)}
.sw{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:2px;vertical-align:0}
.hours{display:flex;flex-direction:column;gap:7px;padding:18px 20px;background:var(--card);border:1px solid var(--line);border-radius:4px}
.hrow{display:grid;grid-template-columns:48px minmax(0,1fr) 260px;align-items:center;gap:14px}
.hl{color:var(--muted);font-size:13px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.htrack{display:flex;height:14px;background:var(--wash);border-radius:2px;overflow:hidden}
.seg{display:block;height:100%}
.join{display:block;flex:none;width:2px;height:100%;background:var(--card)}
.human{background:var(--human)}.tools{background:var(--tools)}.progress{background:var(--progress)}.deliver{background:var(--deliver)}
.hv{font-size:13px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.c-human{color:var(--human)}.c-tools{color:#4f5862}.c-progress{color:var(--warn)}.c-deliver{color:var(--good)}.c-failed{color:var(--bad)}

footer{margin-top:80px;padding-top:14px;border-top:2px solid var(--ink);color:var(--muted);font-size:13px}

@media (max-width:820px){main{padding:32px 18px 56px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.hrow{grid-template-columns:40px minmax(0,1fr)}.hv{grid-column:2}h2 .no{font-size:28px;min-width:42px}}
@media print{body{background:#fff}main{max-width:none;padding:0}.table-wrap{overflow:visible}.kpi,.alert,.hrow,tr{page-break-inside:avoid}h2,h3,h4{page-break-after:avoid}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}tbody tr:hover td{background:transparent}}`

function narrativeBlock (narrative, key, missing) {
  const text = narrative[key]
  if (text) return markdown(text)
  missing.push(key)
  const label = NARRATIVE_SECTIONS.find(([k]) => k === key)?.[1] ?? key
  return `<div class="todo">（待填写：narrative.md 的 <code>## ${escapeHtml(key)}</code>，${escapeHtml(label)}）</div>`
}

const counterTable = (counter, labels = {}, head = ['项', '数量']) => {
  const rows = Object.entries(counter ?? {})
  if (!rows.length) return '<p class="muted">无。</p>'
  return `<div class="table-wrap"><table><thead><tr><th>${head[0]}</th><th>${head[1]}</th></tr></thead><tbody>${
    rows.map(([k, v]) => `<tr><td>${escapeHtml(labels[k] ?? k)}</td><td>${fmt(v)}</td></tr>`).join('')}</tbody></table></div>`
}

/**
 * 渲染固定 9 节的自包含 HTML。第一屏：三行结论 + 与昨天对比的数字 + 昨天未兑现的承诺。
 * 第 02 节是「采访人的感受」：数字之外唯一写人的一节，只收原话与标为推断的解读。
 * 返回 `{ html, missing }`，`missing` 是缺的叙述段 key。
 */
export function renderReport ({ metrics, previous, ledger, narrative = {} }) {
  if (previous && previous.schemaVersion !== metrics.schemaVersion) previous = undefined
  const missing = []
  const m = metrics, p = previous
  const date = m.window.date ?? `${m.window.since} – ${m.window.until}`
  const kpi = (n, label, cur, prev, opts) => `<div class="kpi"><div class="n">${n}</div><div class="l">${label}</div>${delta(cur, prev, opts)}</div>`
  const kpis = [
    kpi(fmt(m.tickets.created), `新建工单<br>${m.tickets.ended} 结束 / ${m.tickets.open} 未结`, m.tickets.created, p?.tickets.created),
    kpi(fmt(m.delivery.total), `交付件<br>ready ${m.delivery.ready} · PR ${m.delivery.prsMerged} · CL ${m.delivery.clsSubmitted}`, m.delivery.total, p?.delivery.total),
    kpi(fmt(m.reports.states.failed ?? 0), 'failed 报告', m.reports.states.failed ?? 0, p?.reports.states.failed ?? 0, { goodWhenDown: true }),
    kpi(fmt(m.reports.states.blocked ?? 0), 'blocked 报告', m.reports.states.blocked ?? 0, p?.reports.states.blocked ?? 0, { goodWhenDown: true }),
    kpi(fmt(m.restarts.interrupted), `重启打断<br>${m.restarts.events.length} 个事件`, m.restarts.interrupted, p?.restarts.interrupted, { goodWhenDown: true }),
    kpi(fmt(m.intake.human), '人类消息', m.intake.human, p?.intake.human),
    kpi(m.tools ? fmt(m.tools.calls) : '—', `工具调用<br>${m.tools ? `${m.tools.sessions} 个会话` : '未扫描'}`, m.tools?.calls ?? 0, p?.tools?.calls, { goodWhenDown: true }),
    kpi(`${fmt(m.assignments.started)} / ${fmt(m.assignments.ended)}`, 'assignment 启动 / 结束', m.assignments.started, p?.assignments.started),
  ].join('')

  const items = ledger?.items ?? []
  const unmet = items.filter(item => item.status === 'missed' || item.status === 'partial' || (item.status === 'open' && m.window.date && item.due < m.window.date) || (item.status === 'open' && !item.ticket))
  const firstScreen = unmet.length
    ? `<div class="alert"><b>昨天的承诺里有 ${unmet.length} 条没兑现：</b><ul>${unmet.map(item => `<li><b>${escapeHtml(item.id)}</b> ${escapeHtml(item.text)} · ${
      item.ticket ? `工单 <code>${escapeHtml(item.ticket)}</code>` : '<b>未开单</b>'} · 截止 ${escapeHtml(item.due)} · <span class="st-${item.status}">${STATUS_LABEL[item.status]}</span></li>`).join('')}</ul></div>`
    : items.length ? '<div class="ok">台账里没有逾期或未开单的承诺。</div>' : '<div class="todo">承诺台账为空：在第 6 节的方案里，把要兑现的事用 <code>ledger add</code> 记下来。</div>'

  const ledgerRows = items.length
    ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>承诺</th><th>工单</th><th>截止</th><th>状态</th><th>备注</th></tr></thead><tbody>${
      items.map(item => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.text)}</td><td>${item.ticket ? `<code>${escapeHtml(item.ticket)}</code>` : '<b class="st-missed">未开单</b>'}</td><td>${escapeHtml(item.due)}</td><td class="st-${item.status}">${STATUS_LABEL[item.status]}</td><td>${escapeHtml(item.note ?? '')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">台账为空。</p>'

  const ticketRows = m.tickets.list.length
    ? `<div class="table-wrap"><table><thead><tr><th>建单</th><th>工单</th><th>类</th><th>标题</th><th>assignment</th><th>工具调用</th><th>结果</th><th>最近报告</th></tr></thead><tbody>${
      m.tickets.list.map(t => `<tr><td>${t.createdAt}</td><td><code>${escapeHtml(t.id)}</code></td><td><span class="tag">${escapeHtml(KIND_LABEL[t.kind] ?? t.kind)}</span></td><td>${escapeHtml(t.title)}</td><td>${t.assignments}</td><td>${fmt(t.toolCalls ?? 0)}</td><td>${escapeHtml(t.outcome)}</td><td class="small">${escapeHtml(t.reports.join(' → '))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">窗口内没有新建工单。</p>'

  const causeLabels = { quota: '额度 / 402', 'session-format': '会话格式', 'tool-input': '工具输入非法 JSON', permission: '权限 / 403', upstream: '模型网关 / 网络', 'delivery-target': '交付目标 / 远端', scope: '超出范围 / 待决定', environment: '环境 / 编辑器 / 编译', other: '其他' }
  const failures = m.reports.failures.length
    ? `<div class="table-wrap"><table><thead><tr><th>时间</th><th>工单</th><th>状态</th><th>根因</th><th>摘要</th></tr></thead><tbody>${
      m.reports.failures.map(f => `<tr><td>${f.at}</td><td><code>${escapeHtml(f.ticket)}</code></td><td>${f.state}</td><td>${escapeHtml(causeLabels[f.cause] ?? f.cause)}</td><td class="small">${escapeHtml(f.summary)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">没有 failed / blocked 报告。</p>'

  const prs = m.delivery.prs
  const deliveries = `<ul>${prs ? `<li>PR 合并 ${prs.merged.length}：${prs.merged.map(pr => `#${pr.number} ${escapeHtml(pr.title)}`).join('；') || '无'}</li><li>PR 关闭未合 ${prs.closed.length}，今天新开仍 open ${prs.open.length}</li>` : '<li>未取 GitHub</li>'}<li>CL 入库 ${m.delivery.cls.submitted.length}（来源：${m.delivery.cls.source === 'p4' ? 'p4 changes' : '工单流水线'}）：${
    m.delivery.cls.submitted.map(cl => `${cl.changelist}${cl.ticket ? `（${escapeHtml(cl.ticket)}）` : ''}`).join('、') || '无'}</li></ul>`

  const funnel = `<p>人类消息 <b>${fmt(m.intake.human)}</b>（${Object.entries(m.intake.bySource).map(([k, v]) => `${escapeHtml(k)} ${v}`).join('、')}）→ 决策 ${
    Object.entries(m.intake.decisions).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(' · ')} → 直通已订阅工单 ${m.intake.fanoutOnly} 条；交回 ${m.intake.handbacks} 次，接单回执 ${m.intake.acks} 次。</p>`

  const known = new Set(NARRATIVE_SECTIONS.map(([k]) => k))
  const extra = Object.keys(narrative).filter(k => !known.has(k))
  const sections = [
    ['结论与第一屏', `${narrativeBlock(narrative, 'summary', missing)}<div class="kpis">${kpis}</div>${firstScreen}`],
    ['采访人的感受', `${narrativeBlock(narrative, 'interview', missing)}<p class="small muted">这一节只放人的话与采访者的观察：原话逐字引用并标时间，不是原话的解读一律标「推断」；没有采访就写「今天没有采访」，不要用数字反推情绪。</p>`],
    ['一天怎么过的', `<h3>人类消息 → agent 工作（按小时，CST）</h3>${hourlyChart(m.hourly)}<h3>今天的工单</h3>${ticketRows}<h3>消息漏斗</h3>${funnel}<h3>交付</h3>${deliveries}`],
    ['承诺对账', ledgerRows],
    ['哪里卡住', `<h3>失败构成（一条报告只归一类）</h3>${counterTable(m.reports.causes, causeLabels, ['根因', '条数'])}${failures}<h3>assignment 结束原因</h3>${counterTable(m.assignments.endedReasons)}<h3>瓶颈</h3>${narrativeBlock(narrative, 'bottlenecks', missing)}`],
    ['四类复盘', narrativeBlock(narrative, 'review', missing)],
    ['明日方案', `${narrativeBlock(narrative, 'plan', missing)}<p class="small muted">每条要兑现的方案都用 <code>ledger add</code> 记进台账并指向工单；指不到工单的，明天第一屏会标“未开单”。</p>`],
    ['外部对照与调研', narrativeBlock(narrative, 'research', missing)],
    ['附录：口径、限制与模板', `<ul class="small"><li>窗口：${escapeHtml(m.window.since)} – ${escapeHtml(m.window.until)}（${escapeHtml(m.window.tz)}），metrics schema v${m.schemaVersion}，模板 v${TEMPLATE_VERSION}，生成于 ${escapeHtml(m.generatedAt)}。</li><li>数据源：${
      escapeHtml(JSON.stringify(m.sources))}</li>${previous ? `<li>对比基线：${escapeHtml(previous.window.date ?? previous.window.since)}</li>` : '<li>没有前一天的 metrics.json，数字不带对比。</li>'}${
      m.limits.map(limit => `<li>${escapeHtml(limit)}</li>`).join('')}</ul><h3>模板本身要改的</h3>${narrativeBlock(narrative, 'template', missing)}${
      extra.map(k => `<h3>${escapeHtml(k)}</h3>${markdown(narrative[k])}`).join('')}`],
  ]
  const body = sections.map(([title, html], i) => `<section id="s${i + 1}"><h2><span class="no">${String(i + 1).padStart(2, '0')}</span>${title}</h2>${html}</section>`).join('\n')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>每日复盘 · ${escapeHtml(date)}</title><style>${CSS}</style></head><body><main><header><h1>每日复盘 · ${escapeHtml(date)}</h1><div class="sub">数字来自 daily-metrics（只读），叙述由模型基于这些数字撰写；口径见第 ${sections.length} 节。</div></header>\n${body}\n<footer>本报告由自动化代理生成（非人类）。发现数字与看板不一致时，以数据库与本机日志为准。</footer></main></body></html>\n`
  return { html, missing }
}

async function ticketLookup (dbPath) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const statement = db.prepare('select value from ticket where id like ? limit 2')
  return prefix => {
    const rows = statement.all(`${prefix}%`)
    return rows.length === 1 ? JSON.parse(rows[0].value) : undefined
  }
}

const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)

export async function main (argv = process.argv.slice(2)) {
  const [command, sub, ...rest] = argv
  if (command === 'ledger') {
    const { options, flags, positional } = parseArgs(rest)
    const path = options.ledger ?? defaultLedger()
    const ledger = readLedger(path)
    if (sub === 'list') {
      for (const item of ledger.items) console.log(`${item.id}\t${item.status}\t${item.due}\t${item.ticket ?? '未开单'}\t${item.text}`)
      return 0
    }
    if (sub === 'add') {
      const item = addCommitment(ledger, { text: options.text, due: options.due, ticket: options.ticket, from: options.from ?? today() })
      writeLedger(path, ledger)
      console.log(`${item.id} 已记入 ${path}`)
      return 0
    }
    if (sub === 'set') {
      const [id] = positional
      setCommitment(ledger, id, { status: options.status, note: options.note, ticket: options.ticket }, options.date ?? today())
      writeLedger(path, ledger)
      console.log(`${id} 已更新`)
      return 0
    }
    if (sub === 'reconcile') {
      const date = options.date ?? today()
      const dbPath = options.db ?? join(homedir(), '.dsh', 'state', 'superagent', 'orchestrator.sqlite')
      const changes = reconcile(ledger, date, await ticketLookup(dbPath))
      for (const change of changes) console.log(`${change.id}\t${change.from} → ${change.to}\t${change.reason}`)
      if (flags.has('apply')) {
        for (const change of changes) if (change.to !== change.from) setCommitment(ledger, change.id, { status: change.to, note: change.reason }, date)
        writeLedger(path, ledger)
        console.log(`已写回 ${path}`)
      }
      return 0
    }
    throw new Error('ledger 子命令：list | add | set | reconcile')
  }
  if (command === 'render') {
    const { options } = parseArgs([sub, ...rest].filter(arg => arg !== undefined))
    if (!options.metrics || !options.out) throw new Error('render 需要 --metrics 与 --out')
    const metrics = JSON.parse(readFileSync(options.metrics, 'utf8'))
    const previous = options.previous ? JSON.parse(readFileSync(options.previous, 'utf8')) : undefined
    const ledgerPath = options.ledger ?? defaultLedger()
    const ledger = existsSync(ledgerPath) ? readLedger(ledgerPath) : emptyLedger()
    const narrative = options.narrative ? parseNarrative(readFileSync(options.narrative, 'utf8')) : {}
    const { html, missing } = renderReport({ metrics, previous, ledger, narrative })
    writeFileSync(options.out, html)
    console.error(`report → ${options.out}${missing.length ? `；缺叙述段：${missing.join(', ')}` : ''}`)
    return 0
  }
  throw new Error('用法：daily-retro.mjs ledger <list|add|set|reconcile> … | render --metrics m.json --out r.html')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => { process.exitCode = code }, error => { console.error(error?.message ?? error); process.exitCode = 1 })
}
