// Likely (`similar`) relations between tickets: the guess the relation view draws as faint dotted lines.
import { expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { SIMILAR, selectGuesses, similarEdges, type SimilarInput } from '../src/app/views/similar.ts'
import golden from './fixtures/similar-golden.json' with { type: 'json' }

/** Ids as the store makes them, hex, so a message can mention one; the first twelve characters differ. */
const hex = (i: number) => i.toString(16).padStart(2, '0').repeat(16)
interface Row { id: string; title: string; message?: string; createdAt: string; target?: string | null; chat?: string; thread?: string
  scope?: string; report?: string; actor?: string }
function input(row: Row): SimilarInput {
  const ticket = { id: row.id, title: row.title, decisionId: `d${row.id}`, createdAt: row.createdAt, updatedAt: row.createdAt,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: row.actor ?? 'ou_x' }, scope: row.scope ?? '' },
    channels: [{ source: 'feishu', thread: row.chat ?? `oc_${row.id}`, address: {} }], undelivered: [], inputs: [],
    origin: { triggerId: `o${row.id}`, triggerIds: [`o${row.id}`] },
    execution: { name: 'x', directory: '.', assignment: '', ...row.target ? { target: row.target } : {} },
    assignments: row.report ? [{ id: `a${row.id}`, state: 'ended', createdAt: row.createdAt, report: { state: 'ready', summary: row.report, at: row.createdAt } }] : [],
  } as unknown as Ticket
  return { ticket, thread: row.thread ?? `feishu:oc_main:om_${row.id}`, message: row.message ?? '' }
}
const at = (day: number, hour: number, minute = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
/** Unrelated tickets, so the entity IDF has a realistic base and an entity on two tickets is rare. */
const fillers = (from: number) => ['导出报表按钮', '清理旧日志', '升级依赖包', '补齐英文文案', '调大超时时间', '去掉调试输出', '合并重复配置', '修正时区换算']
  .map((title, k) => ({ id: hex(from + k), title, message: title, createdAt: at(20, k + 1) }))
/** The fillers chained by explicit edges, as one split request would be, so the cap leaves room. */
const chain = (rows: Row[]) => rows.slice(1).map((row, i) => ({ from: rows[i]!.id, to: row.id }))
const guess = (rows: Row[], explicit = chain(rows.slice(2))) => similarEdges(rows.map(input), explicit)
const pairOf = (edges: ReturnType<typeof similarEdges>) => edges.map(edge => [edge.from, edge.to])

it('pairs tickets whose titles say the same thing, with the shared words as a person reads them', () => {
  const rows = [{ id: hex(0), title: '登录页按钮文案错位', createdAt: at(1, 1) }, { id: hex(1), title: '登录页按钮文案在暗色主题下错位', createdAt: at(1, 9) },
    ...fillers(2)]
  const [edge, ...rest] = guess(rows)
  expect(rest).toEqual([])
  // The older ticket reads first; the bigrams are joined back into the words both titles hold.
  expect(edge).toMatchObject({ from: hex(0), to: hex(1), kind: 'similar', via: 'fuzzy', reason: '标题都有「登录页按钮文案 / 错位」', at: at(1, 9) })
  expect(edge!.strength).toBeGreaterThanOrEqual(SIMILAR.threshold)
  expect(edge!.strength).toBeLessThanOrEqual(1)
})

it('pairs tickets that share a changelist on top of a near title, and names it', () => {
  const rows = [{ id: hex(0), title: '接手 CL 600001：修复 GripSolver.cpp', message: '请接手 CL 600001', createdAt: at(1, 1) },
    { id: hex(1), title: '重新推进 600001 的移动修复', message: '移动修复的 CL 600001 被打回', createdAt: at(1, 9), report: '已提交 CL 600001' }, ...fillers(2)]
  expect(guess(rows).map(edge => edge.reason)).toEqual(['标题都有「600001 / 修复」；共享「CL 600001」'])
  // The changelist alone is not enough.
  const alone = [{ ...rows[0]!, title: '修复 GripSolver.cpp' }, { ...rows[1]!, title: '登录超时' }, ...rows.slice(2)]
  expect(guess(alone)).toEqual([])
})

it('never pairs on timing alone, nor on the build and tool names every report repeats', () => {
  const near = (titles: [string, string], message = '') => [{ id: hex(0), title: titles[0], message, createdAt: at(1, 1), chat: 'oc_a', target: 'proto' },
    { id: hex(1), title: titles[1], message, createdAt: at(1, 1, 3), chat: 'oc_a', target: 'proto' }, ...fillers(2)]
  // Three minutes apart, the same person in the same chat, the same target: still nothing in common.
  expect(guess(near(['换一个默认字体', '统计接口加缓存']))).toEqual([])
  expect(guess(near(['修复启动崩溃', '统计接口加缓存'], 'WindowsEditor SunEditor LlmError GitHub ClangTidy'))).toEqual([])
  // A code symbol a person named does count, and then timing and the target add to it.
  expect(guess(near(['修复启动崩溃', '统计接口加缓存'], '看下 GripSolver 的调用'))).toEqual([expect.objectContaining({
    reason: '共享「GripSolver」；3 分钟内同一人开单；同一执行目标' })])
})

it('leaves out pairs an explicit edge already joins and pairs on one Thread', () => {
  const rows = [{ id: hex(0), title: '登录页按钮文案错位', createdAt: at(1, 1) }, { id: hex(1), title: '登录页按钮文案在暗色主题下错位', createdAt: at(1, 9) },
    ...fillers(2)]
  expect(guess(rows)).toHaveLength(1)
  expect(guess(rows, [...chain(rows.slice(2)), { from: hex(1), to: hex(0) }])).toEqual([])
  expect(guess([{ ...rows[0]!, thread: 'feishu:oc_1:om_root' }, { ...rows[1]!, thread: 'feishu:oc_1:om_root' }, ...rows.slice(2)])).toEqual([])
})

it('counts a mention of another ticket\'s id, but only half once the text lists more than two', () => {
  const base = [{ id: hex(0), title: '定位额度用尽', createdAt: at(1, 1), chat: 'oc_a' }, { id: hex(1), title: '首页加载变慢', createdAt: at(1, 1, 10), chat: 'oc_a' },
    { id: hex(2), title: '升级 node 版本', createdAt: at(2, 1) }, { id: hex(3), title: '日历控件换色', createdAt: at(2, 5) }, ...fillers(4)]
  const one = base.map(row => row.id === hex(1) ? { ...row, message: `接着 ${hex(0).slice(0, 12)} 做` } : row)
  expect(guess(one).map(edge => [edge.from, edge.to, edge.reason])).toEqual([[hex(0), hex(1), '正文提到了对方工单；10 分钟内同一人开单']])
  // A list of stuck tickets is not about each of them.
  const many = base.map(row => row.id === hex(1) ? { ...row, message: `卡住的：${[0, 2, 3].map(i => hex(i).slice(0, 12)).join('、')}` } : row)
  expect(guess(many)).toEqual([])
})

it('gives the same edges whatever order the tickets come in, from the older ticket, with no pair twice', () => {
  const rows = golden.map(row => ({ ...row, target: row.target ?? undefined }))
  const explicit = chain(rows.filter(row => row.decision === 'dsplit'))
  const edges = similarEdges(rows.map(input), explicit)
  const shuffled = similarEdges([...rows].reverse().map(input).sort((a, b) => a.ticket.title.localeCompare(b.ticket.title)), explicit)
  expect(shuffled).toEqual(edges)
  const created = new Map(rows.map(row => [row.id, row.createdAt]))
  expect(edges.every(edge => created.get(edge.from)! <= created.get(edge.to)!)).toBe(true)
  expect(new Set(edges.map(edge => [edge.from, edge.to].sort().join())).size).toBe(edges.length)
})

it('keeps each ticket\'s top k as a union, then at most one guess per explicit edge, strongest first', () => {
  const pair = (from: string, to: string, score: number) => ({ from, to, score })
  // Hub h ranks four pairs; each leaf has only its own, so the union keeps them all.
  const star = [pair('h', 'a', .9), pair('h', 'b', .8), pair('h', 'c', .7), pair('h', 'd', .6)]
  expect(selectGuesses(star, 10)).toHaveLength(4)
  // In a clique of five, x–y ranks below the top three of both x and y, so it goes.
  const ids = ['v', 'w', 'x', 'y', 'z'], clique = ids.flatMap((a, i) => ids.slice(i + 1).map((b, j) => pair(a, b, .9 - (i * 4 + j) * .01)))
  const kept = selectGuesses(clique, 99)
  expect(kept.length).toBeLessThan(clique.length)
  for (const id of ids) expect(kept.filter(p => p.from === id || p.to === id).length).toBeGreaterThanOrEqual(SIMILAR.topK)
  // The cap: one per explicit edge, and one even with none; ties go to the ids.
  expect(selectGuesses(star, 2).map(p => p.to)).toEqual(['a', 'b'])
  expect(selectGuesses([pair('h', 'b', .5), pair('h', 'a', .5)], 0)).toEqual([pair('h', 'a', .5)])
})

it('matches the reference analysis on a synthetic version of the ten strongest real pairs', () => {
  const rows = golden.map(row => ({ ...row, target: row.target ?? undefined }))
  const id = (i: number) => rows[i]!.id
  const edges = similarEdges(rows.map(input), chain(rows.filter(row => row.decision === 'dsplit')))
  // Strengths from `preview/fuzzy/analysis.py` run on the same rows; the reasons join title bigrams into words, as the
  // reference does not. The tool-name pair and the timing-only pair get nothing.
  expect(edges.map(edge => [rows.findIndex(row => row.id === edge.from), rows.findIndex(row => row.id === edge.to), edge.strength, edge.reason])).toEqual([
    [4, 5, .5965, '标题都有「与昨日 / 每日复盘」；共享「复盘」'],
    [10, 11, .5615, '标题都有「优先级 / 闲时」；共享「优先级」；20 分钟内同一人开单；同一执行目标'],
    [0, 1, .5259, '标题都有「600001 / cl」；共享「CL 600001 / p4/swarm / 流水线」；同一执行目标'],
    [8, 9, .5223, '标题都有「402 / 定位」；正文提到了对方工单；共享「计费」；10 分钟内同一人开单'],
    [6, 7, .4984, '标题都有「mainline / ue-mcp / 启动」；共享「ue-mcp/编辑器 / 验证」'],
    [2, 3, .4822, '标题都有「冲刺后」；共享「CL 600002 / 战斗」'],
    [1, 12, .328, '标题都有「流水线」；共享「流水线」'],
  ])
  expect(edges.some(edge => [id(16), id(17), id(18), id(19)].includes(edge.from))).toBe(false)
})
