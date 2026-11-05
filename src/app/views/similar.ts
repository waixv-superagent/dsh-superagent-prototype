/**
 * Likely relations between tickets that nothing recorded: the relation view's `similar` edges, guessed from the titles, the
 * modules and ids a person's request and the workers' reports name, shared neighbours, and timing. A guess only, shown
 * faint and switchable; it never becomes a ticket relation and grants nothing. Pure and deterministic: the same tickets
 * always give the same edges, ordered the same way.
 *
 *     content = 0.45·title + 0.25·entity + 0.20·common          (each 0–1)
 *     score   = content + [content ≥ 0.15]·(0.10·time + 0.05·sameTarget)
 *
 * A pair with an explicit edge, or on the same Thread, is never a candidate; the kept pairs score at least `THRESHOLD`, rank
 * in either end's top `TOP_K`, and number at most `CAP_RATIO` per explicit edge.
 */
import type { Ticket } from '../../core/index.ts'

/** One ticket as the guess reads it: the ticket, the Thread it started on, and the text of the message that started it. */
export interface SimilarInput { ticket: Ticket; thread: string; message: string }
export interface SimilarEdge { from: string; to: string; kind: 'similar'; via: 'fuzzy'; strength: number; reason: string; at: string }

export const SIMILAR = {
  weights: { title: .45, entity: .25, common: .20, time: .10, target: .05 },
  /** The final score a pair needs; below it guesses turn to "same evening, both mention the board". */
  threshold: .30,
  /** A pair is kept when it ranks in either end's top k, so the kept set is symmetric. */
  topK: 3,
  /** At most this many guesses per explicit edge (and at least one). */
  capRatio: 1.0,
  /** Timing and a shared target only add once the content signals already reach this. */
  contentGate: .15,
  timeWindowMin: 30,
  /** A title cosine of 0.4 already reads as the same topic for these short titles, so it is scaled to 1 there. */
  titleFull: .4,
  /** An entity on more than this share of the tickets says nothing. */
  entityCommon: .25,
  /** What one mention of another ticket's id counts for when its text mentions more than `mentionMany` of them. */
  mentionMany: 2, mentionWeak: .5,
} as const

/** Module and domain words the team uses, matched as lower-case substrings; each group counts as one entity. */
const MODULES: Record<string, string[]> = {
  '看板': ['看板', '概览', 'dashboard'], '工单页': ['工单页'], '状态卡': ['状态卡'], '卡片': ['卡片', '方案卡', '回复卡', '确认卡'],
  '关系图': ['关系图', '网状视图', '点云', '图谱', '时间线'], '流水线': ['流水线', 'pipeline', 'jenkins', 'presubmit', 'autobuild'],
  'p4/swarm': ['swarm', 'shelve', 'changelist'], 'github pr': ['pull request', 'github.com'],
  '计费': ['计费', '花费', '用量', '额度', '402', 'gateway', 'provider', '余额'], '复盘': ['复盘', 'daily-metrics'],
  '飞书': ['飞书', 'lark', 'feishu'], '优先级': ['优先级', '闲时'], '部署/重启': ['部署', '重启', '3082', '重编', '自动更新'],
  'ue-mcp/编辑器': ['ue-mcp', '编辑器'], '动画': ['动画', 'motionmatch', 'posesearch', 'blendstack', 'montage'],
  '跳跃': ['跳跃', '起跳', '离地'], '移动': ['移动', 'mover', 'layeredmove', '行走', '转向', '停步'], '战斗': ['【战斗】', '技能', '闪避', '命中'],
  '交互': ['【交互】', '交互动作'], '验证': ['验证', '验收', '夹具'], '需求流程': ['需求推进', '流程优化', '方案过程化', 'agent team'],
  'deepseek': ['deepseek'], 'claude': ['claude'], '现场上报': ['现场上报'],
}
/** Build, platform and tool names that workers and templates repeat across unrelated tickets. */
const INFRA_SYMBOLS = new Set(['GitHub', 'PlayGround', 'LlmError', 'WindowsEditor', 'SunEditor', 'SunGame', 'ClientBuild', 'MacBuild',
  'EditorTest', 'ClangTidy', 'AggregateError', 'DeepSeek', 'ClientCodeReview', 'MapleCheck'])
const STOP_BIGRAMS = new Set(['实现', '优化', '问题', '工单', '显示', '支持', '改为', '一个', '需要', '以及', '进行', '当前', '处理', '调整', '分析', '对比'])
const STOP_WORDS = new Set(['the', 'and', 'to', 'of', 'in', 'for', 'on', 'with', 'by'])
const BOILER = /You share this workspace[\s\S]*/
/** Lines of the bug-report template (who, when, which build) that every report carries. */
const TEMPLATE = /^.*(?:用户：|时间：|IP：|版本：|场景：|详细信息网页|现场截图).*$/gm
const CJK = /[一-鿿]+/g
const LATIN = /[A-Za-z][A-Za-z0-9_.+-]{1,}|\d{2,}/g
// Word boundaries as Unicode reads them, so `接手CL 575897` is not a boundary in the middle of a word.
const W = '[\\p{L}\\p{N}_]', B0 = `(?<!${W})`, B1 = `(?!${W})`
const CL = new RegExp(`(?:${B0}CL\\s*#?|changelist[= ])(\\d{6})${B1}`, 'giu')
const PR = new RegExp(`${B0}PR\\s*#(\\d{1,5})${B1}|/pull/(\\d{1,5})${B1}`, 'gu')
const TAPD = new RegExp(`${B0}(11\\d{8,})${B1}`, 'gu')
const FILE = new RegExp(`(?:[\\p{L}\\p{N}_.-]+/)+[\\p{L}\\p{N}_.-]+\\.(?:ts|tsx|cpp|h|md|py|mjs|json|uasset)${B1}`, 'gu')
const SYMBOL = new RegExp(`${B0}[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+${B1}`, 'gu')
const HEX = new RegExp(`${B0}([0-9a-f]{12,32})${B1}`, 'gu')

/** Code-point order, never the locale's, so the result is the same on every host. */
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
/** Rounded as the reference analysis rounds, on the exact value rather than on a scaled one. */
const round = (value: number, digits: number) => Number(value.toFixed(digits))

/** CJK character bigrams (a single character stays whole) and lower-case Latin words and numbers, stop words left out. */
export function titleTokens(title: string): string[] {
  const tokens: string[] = []
  for (const [run] of title.matchAll(CJK)) {
    if (run.length < 2) { tokens.push(run); continue }
    for (let i = 0; i < run.length - 1; i++) if (!STOP_BIGRAMS.has(run.slice(i, i + 2))) tokens.push(run.slice(i, i + 2))
  }
  for (const [word] of title.matchAll(LATIN)) if (!STOP_WORDS.has(word.toLowerCase())) tokens.push(word.toLowerCase())
  return tokens
}
/** Everything a ticket says, and what a person asked: title, scope, the origin message and the routing note. */
function textOf({ ticket, message }: SimilarInput): { all: string; asked: string } {
  const routing = (ticket.execution?.assignment ?? '').replace(BOILER, '').split('\n')[0]!
  const asked = [ticket.title, ticket.mandate.scope ?? '', message.replace(TEMPLATE, '').slice(0, 400),
    routing.startsWith('Routing note') ? routing : ''].join('\n')
  const reports = ticket.assignments.map(assignment => (assignment.report?.summary ?? '').slice(0, 400))
  return { all: [asked, ...reports].join('\n'), asked }
}
/**
 * The entities a ticket names, by key to display name: CL, PR, TAPD and file names and other tickets' ids from all its
 * text; module words and code symbols only from what a person asked, since worker reports repeat build and tool names on
 * every run. A mention of another ticket's id is keyed `提及:` with the ticket it names.
 */
function entities(input: SimilarInput, shortIds: Map<string, string>): Map<string, string> {
  const { all, asked } = textOf(input), low = ` ${asked.toLowerCase()} `, out = new Map<string, string>()
  for (const [name, keys] of Object.entries(MODULES)) if (keys.some(key => low.includes(key))) out.set(`模块:${name}`, name)
  for (const m of all.matchAll(CL)) out.set(`CL:${m[1]}`, `CL ${m[1]}`)
  for (const m of all.matchAll(PR)) out.set(`PR:${m[1] ?? m[2]}`, `PR #${m[1] ?? m[2]}`)
  for (const m of all.matchAll(TAPD)) out.set(`TAPD:${m[1]}`, `TAPD ${m[1]}`)
  for (const [path] of all.matchAll(FILE)) { const name = path.split('/').at(-1)!; out.set(`文件:${name}`, name) }
  for (const [symbol] of asked.matchAll(SYMBOL)) if (!INFRA_SYMBOLS.has(symbol)) out.set(`符号:${symbol}`, symbol)
  for (const m of all.matchAll(HEX)) {
    const hit = shortIds.get(m[1]!.slice(0, 12))
    if (hit && hit !== input.ticket.id) out.set(`提及:${hit}`, '提及工单')
  }
  return out
}
/**
 * The shared title tokens as a person reads them: adjacent shared CJK bigrams joined back into the word both titles hold
 * (`流水线` rather than `流水 / 水线`), in the order of their strongest bigram.
 */
function titleWords(shared: string[], a: string, b: string): string[] {
  const rank = new Map(shared.map((token, i) => [token, i])), words = new Map<string, number>()
  const put = (word: string, at: number) => words.set(word, Math.min(words.get(word) ?? Infinity, at))
  for (const [run] of a.matchAll(CJK)) {
    for (let i = 0; i < run.length - 1;) {
      if (!rank.has(run.slice(i, i + 2))) { i++; continue }
      let end = i
      while (end + 1 < run.length - 1 && rank.has(run.slice(end + 1, end + 3))) end++
      const word = run.slice(i, end + 2), parts = Array.from({ length: end - i + 1 }, (_, k) => run.slice(i + k, i + k + 2))
      const best = Math.min(...parts.map(part => rank.get(part)!))
      if (b.includes(word)) put(word, best)
      else for (const part of parts) put(part, rank.get(part)!)
      i = end + 1
    }
  }
  for (const token of shared) if (!/[一-鿿]/.test(token)) put(token, rank.get(token)!)
  for (const token of shared) if (/^[一-鿿]$/.test(token)) put(token, rank.get(token)!)
  return [...words].sort((x, y) => x[1] - y[1] || order(x[0], y[0])).map(([word]) => word)
}

interface Pair { a: number; b: number; score: number; reason: string }
/**
 * The `similar` edges among `inputs`, given their explicit edges (all of them, the same-Thread chain too). `from` is the
 * older ticket and `at` when the newer one began.
 */
export function similarEdges(inputs: SimilarInput[], explicit: { from: string; to: string }[]): SimilarEdge[] {
  const items = [...inputs].sort((x, y) => order(x.ticket.createdAt, y.ticket.createdAt) || order(x.ticket.id, y.ticket.id))
  const n = items.length
  if (n < 2) return []
  const w = SIMILAR.weights
  const adj = new Map<string, Set<string>>(items.map(item => [item.ticket.id, new Set()]))
  const explicitPairs = new Set<string>()
  for (const edge of explicit) {
    adj.get(edge.from)?.add(edge.to); adj.get(edge.to)?.add(edge.from)
    explicitPairs.add([edge.from, edge.to].sort(order).join('|'))
  }
  // Title: TF-IDF over this batch of tickets only.
  const tokens = items.map(item => titleTokens(item.ticket.title))
  const df = new Map<string, number>()
  for (const list of tokens) for (const token of new Set(list)) df.set(token, (df.get(token) ?? 0) + 1)
  const vectors = tokens.map(list => {
    const counts = new Map<string, number>()
    for (const token of list) counts.set(token, (counts.get(token) ?? 0) + 1)
    const vector = new Map([...counts].map(([token, count]) => [token, count * Math.log((n + 1) / (df.get(token)! + .5))]))
    const norm = Math.sqrt([...vector.values()].reduce((sum, x) => sum + x * x, 0)) || 1
    for (const [token, x] of vector) vector.set(token, x / norm)
    return vector
  })
  // Entities with IDF; one on more than a quarter of the tickets carries no information and is dropped.
  const shortIds = new Map(items.map(item => [item.ticket.id.slice(0, 12), item.ticket.id]))
  const ents = items.map(item => entities(item, shortIds))
  const edf = new Map<string, number>()
  for (const map of ents) for (const key of map.keys()) if (!key.startsWith('提及:')) edf.set(key, (edf.get(key) ?? 0) + 1)
  const idf = new Map([...edf].filter(([, count]) => count <= SIMILAR.entityCommon * n).map(([key, count]) => [key, Math.log(n / count)]))
  // Two shared entities that each sit on about three tickets saturate the signal.
  const entityFull = Math.max(2 * Math.log(n / 3), 1)
  // A text that lists many other tickets' ids is not about each of them.
  const mentionWeight = ents.map(map => [...map.keys()].filter(key => key.startsWith('提及:')).length > SIMILAR.mentionMany ? SIMILAR.mentionWeak : 1)
  const minutes = items.map(item => Date.parse(item.ticket.createdAt) / 60_000)

  const score = (i: number, j: number): Pair => {
    const a = items[i]!.ticket, b = items[j]!.ticket, va = vectors[i]!, vb = vectors[j]!
    let title = 0
    for (const [token, x] of va) title += x * (vb.get(token) ?? 0)
    const sharedTitle = [...va.keys()].filter(token => vb.has(token))
      .sort((x, y) => va.get(y)! * vb.get(y)! - va.get(x)! * vb.get(x)! || order(x, y))
    const common = [...adj.get(a.id)!].filter(id => adj.get(b.id)!.has(id)).sort(order)
    const aa = common.reduce((sum, id) => sum + 1 / Math.log(Math.max(adj.get(id)!.size, 2)), 0)
    const mention = Math.max(ents[i]!.has(`提及:${b.id}`) ? mentionWeight[i]! : 0, ents[j]!.has(`提及:${a.id}`) ? mentionWeight[j]! : 0)
    const shared = [...ents[i]!.keys()].filter(key => ents[j]!.has(key) && idf.has(key)).sort((x, y) => idf.get(y)! - idf.get(x)! || order(x, y))
    const entity = Math.max(mention, Math.min(1, shared.reduce((sum, key) => sum + idf.get(key)!, 0) / entityFull))
    const samePerson = a.mandate.actor.id === b.mandate.actor.id
    const sameChat = !!a.channels[0] && !!b.channels[0] && a.channels[0].thread === b.channels[0].thread
    const dt = Math.abs(minutes[i]! - minutes[j]!)
    const time = dt <= SIMILAR.timeWindowMin ? (1 - dt / SIMILAR.timeWindowMin) * (.5 * +samePerson + .5 * +sameChat) : 0
    const sameTarget = !!a.execution?.target && a.execution.target === b.execution?.target
    const sig = { title: round(Math.min(1, title / SIMILAR.titleFull), 3), common: round(Math.min(1, aa / 1.5), 3), entity: round(entity, 3),
      time: round(time, 3) }
    const content = w.title * sig.title + w.common * sig.common + w.entity * sig.entity
    const gated = content >= SIMILAR.contentGate
    const total = content + (gated ? w.time * sig.time + w.target * +sameTarget : 0)
    const named = [...new Set(shared.map(key => ents[i]!.get(key)!))]
    const reason: string[] = []
    if (sharedTitle.length && sig.title >= .25) reason.push(`标题都有「${titleWords(sharedTitle, a.title, b.title).slice(0, 3).join(' / ')}」`)
    if (mention) reason.push('正文提到了对方工单')
    if (named.length) reason.push(`共享「${named.slice(0, 4).join(' / ')}」`)
    if (common.length) reason.push(`共同邻居 ${common.length} 张`)
    if (gated && sig.time > 0) reason.push(`${Math.trunc(dt)} 分钟内同一人开单`)
    if (gated && sameTarget) reason.push('同一执行目标')
    return { a: i, b: j, score: round(Math.min(1, total), 4), reason: reason.join('；') }
  }

  const over: Pair[] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = items[i]!, b = items[j]!
    if (explicitPairs.has([a.ticket.id, b.ticket.id].sort(order).join('|'))) continue
    // The same-Thread chain already connects them.
    if (a.thread && a.thread === b.thread) continue
    const pair = score(i, j)
    if (pair.score >= SIMILAR.threshold) over.push(pair)
  }
  return selectGuesses(over.map(pair => ({ ...pair, from: items[pair.a]!.ticket.id, to: items[pair.b]!.ticket.id })), explicit.length)
    .map(pair => ({ from: pair.from, to: pair.to, kind: 'similar', via: 'fuzzy', strength: pair.score, reason: pair.reason, at: items[pair.b]!.ticket.createdAt }))
}
/**
 * Which scored pairs (each at least the threshold) are kept: strongest first with ties on the ids, each ticket's top k as a
 * union so the set stays symmetric, then at most `capRatio` per explicit edge.
 */
export function selectGuesses<P extends { from: string; to: string; score: number }>(over: P[], explicitCount: number): P[] {
  const sorted = [...over].sort((x, y) => y.score - x.score || order(x.from, y.from) || order(x.to, y.to))
  const byNode = new Map<string, P[]>()
  for (const pair of sorted) for (const end of [pair.from, pair.to]) byNode.set(end, [...byNode.get(end) ?? [], pair])
  const keep = new Set([...byNode.values()].flatMap(list => list.slice(0, SIMILAR.topK)))
  return sorted.filter(pair => keep.has(pair)).slice(0, Math.max(1, Math.floor(SIMILAR.capRatio * explicitCount)))
}
