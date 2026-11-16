/**
 * Seed a small synthetic database for the recently-active board band: open Tickets in every lane whose newest real event
 * is minutes, hours or days old, plus one past the seven-day window, so before/after captures render the real panel over
 * the same data without publishing any real Ticket.
 * Usage: node seed.ts <repo-root> <db-path> [now-iso]
 * `now-iso` pins every timestamp; the captures freeze their clock to it, so both images show the same ages.
 */
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const [root, dbPath, at] = process.argv.slice(2) as [string, string, string | undefined]
const load = (path: string) => import(pathToFileURL(join(root, path)).href)
const { Store } = await load('src/app/store.ts')
const { SettingsSchema } = await load('src/policy.ts')

rmSync(dbPath, { force: true })
const store = new Store(dbPath)
store.saveSettings(SettingsSchema.parse({ policy: {
  sources: { feishu: { allowed: [{ id: 'ou_demo', name: '示例发起人' }] }, github: { allowed: [] } },
  rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }],
} }))

const now = at ? Date.parse(at) : Date.now()
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const DAY = 24 * 60
const ticket = (fields: Record<string, unknown>) => ({
  decisionId: 'demo-decision',
  mandate: { strength: 'explicit' as const, policyVersion: 'demo', basis: { via: 'listed' as const },
    actor: { source: 'feishu', id: 'ou_demo' }, scope: '示例：看板最近活跃' },
  channels: [],
  origin: { triggerId: 'demo-trigger', triggerIds: ['demo-trigger'] },
  createdAt: ago(10 * DAY),
  updatedAt: ago(30),
  assignments: [],
  inputs: [],
  undelivered: [],
  phase: 'implement',
  ...fields,
})

// 待你决定: a question has waited three minutes, the newest activity on the board.
store.tickets.save(ticket({
  id: 'demo-plan-0001',
  title: '示例：方案卡等你拍板（改哪一条验收口径）',
  createdAt: ago(2 * DAY), updatedAt: ago(3),
  attention: { id: 'demo-attention-1', question: '这处改动的验收口径用哪一版？' },
  assignments: [{ id: 'demo-a1', state: 'running', createdAt: ago(3), startedAt: ago(3),
    report: { state: 'progress', summary: '等确认验收口径后再改代码。', at: ago(3) } }],
  inputs: [{ id: 'demo-i1', kind: 'text', at: ago(3), person: true, text: '人对「先改哪一处？」的答复：先改验收口径。' }],
}))

// 正在跑: a worker turn started six minutes ago.
store.tickets.save(ticket({
  id: 'demo-run-0002',
  title: '示例：worker 正在改实现（六分钟前开工）',
  createdAt: ago(1 * DAY), updatedAt: ago(6),
  assignments: [{ id: 'demo-a2', state: 'running', createdAt: ago(7), startedAt: ago(6) }],
}))

// 待你验证: delivered twenty-five minutes ago, waiting for the local check.
store.tickets.save(ticket({
  id: 'demo-verify-0003',
  title: '示例：已交付，等你本地验证',
  createdAt: ago(1 * DAY), updatedAt: ago(25),
  execution: { name: 'demo-verify', directory: '/tmp/demo-verify', assignment: 'demo', changelist: 9101, review: '9101',
    verification: ['版本与前置：origin/main 示例构建，示例地图；CL 9101', '复现步骤：打开面板看板，再打开这张 Ticket',
      '预期与证据：交付后 Ticket 显示「待你验证」', '待你判断：这个分类是否符合你的预期'].join('\n') },
  verification: { at: ago(25), state: 'pending' },
  assignments: [{ id: 'demo-a3', state: 'ended', createdAt: ago(2 * 60), startedAt: ago(2 * 60), endedAt: ago(25),
    report: { state: 'ready', at: ago(25), summary: '已修复并交付 CL 9101 / Swarm 9101。' } }],
}))

// 流水线: the local check passed forty minutes ago, the review is blocked for a person.
store.tickets.save(ticket({
  id: 'demo-pipeline-0004',
  title: '示例：已过本地验证，Swarm 审核等你点通过',
  createdAt: ago(3 * DAY), updatedAt: ago(40),
  execution: { name: 'demo-pipeline', directory: '/tmp/demo-pipeline', assignment: 'demo', changelist: 9102, review: '9102' },
  verification: { at: ago(40), state: 'passed', by: 'person' },
  pipeline: { state: 'blocked', at: ago(39), manual: true, step: 'review', check: 'Swarm 已通过，待人工审核',
    url: 'https://swarm.example/reviews/9102', progress: { pass: 2, running: 0, fail: 0, total: 2 } },
  assignments: [{ id: 'demo-a4', state: 'ended', createdAt: ago(3 * 60), startedAt: ago(3 * 60), endedAt: ago(40),
    report: { state: 'ready', at: ago(40), summary: '已交付 CL 9102 / Swarm 9102。' } }],
}))

// 正在跑 (between turns): the worker reported waiting two hours ago.
store.tickets.save(ticket({
  id: 'demo-idle-0005',
  title: '示例：等下一次触发的已交付工单',
  createdAt: ago(2 * DAY), updatedAt: ago(120),
  assignments: [{ id: 'demo-a5', state: 'ended', createdAt: ago(3 * 60), startedAt: ago(3 * 60), endedAt: ago(120),
    report: { state: 'waiting', at: ago(120), summary: '没有新触发，先待命。' } }],
}))

// 闲时池: a P2 defect whose last real event is five hours old.
store.tickets.save(ticket({
  id: 'demo-pool-0006',
  title: '示例：闲时池里的 P2 缺陷',
  createdAt: ago(4 * DAY), updatedAt: ago(5 * 60),
  priority: { level: 'P2', source: 'default', at: ago(4 * DAY), note: 'human-mention' },
  assignments: [{ id: 'demo-a6', state: 'pending', createdAt: ago(5 * 60) }],
}))

// A delivered Ticket whose local check has waited eight days: it stays in 待你验证 but is past the band's window.
store.tickets.save(ticket({
  id: 'demo-backlog-0007',
  title: '示例：八天前交付，仍在等本地验证',
  createdAt: ago(10 * DAY), updatedAt: ago(8 * DAY),
  execution: { name: 'demo-backlog', directory: '/tmp/demo-backlog', assignment: 'demo', changelist: 9103, review: '9103' },
  verification: { at: ago(8 * DAY), state: 'pending' },
}))

// 最近结束: a completed delivery an hour ago.
store.tickets.save(ticket({
  id: 'demo-ended-0008',
  title: '示例：一小时前完成并验收',
  createdAt: ago(5 * DAY), updatedAt: ago(60),
  execution: { name: 'demo-ended', directory: '/tmp/demo-ended', assignment: 'demo', changelist: 9104, review: '9104' },
  verification: { at: ago(70), state: 'passed', by: 'person' },
  ended: { at: ago(60), by: 'executor', outcome: 'completed' },
  assignments: [{ id: 'demo-a8', state: 'ended', createdAt: ago(3 * 60), startedAt: ago(3 * 60), endedAt: ago(60),
    report: { state: 'ready', at: ago(60), summary: '已交付 CL 9104 / Swarm 9104。' } }],
}))

store.close()
console.log('seeded', dbPath, '8 tickets')
