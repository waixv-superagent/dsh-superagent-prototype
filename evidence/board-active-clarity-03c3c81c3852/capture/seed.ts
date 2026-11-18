/**
 * Seed a synthetic database for the board's information hierarchy: a verification lane holding one fresh handover, two
 * day-old live deliveries and an ended backlog, beside live work, decisions and a pipeline wait. Ticket text is invented
 * ("示例：…") so the before/after captures publish no real Ticket. Usage: node seed.ts <repo-root> <db-path> [now-iso]
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
  rules: [{ id: 'demo', name: '示例规则', enabled: true, instruction: 'Fix the reported bug' }],
} }))

const now = Date.parse(at ?? '2026-11-18T16:00:00.000Z')
const MIN = 1, HOUR = 60, DAY = 24 * 60
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const ticket = (fields: Record<string, unknown>) => ({
  decisionId: 'demo-decision',
  mandate: { strength: 'explicit' as const, policyVersion: 'demo', basis: { via: 'listed' as const },
    actor: { source: 'feishu', id: 'ou_demo' }, scope: '示例：看板信息层级' },
  channels: [],
  origin: { triggerId: 'demo-trigger', triggerIds: ['demo-trigger'] },
  createdAt: ago(5 * DAY),
  updatedAt: ago(30),
  assignments: [],
  inputs: [],
  undelivered: [],
  phase: 'implement',
  ...fields,
})

// 待你决定: a question has waited two days, and a failed report three.
store.tickets.save(ticket({
  id: 'demo-decision-0001', title: '示例：方案卡等你拍板（入口放哪一栏）',
  createdAt: ago(4 * DAY), updatedAt: ago(2 * DAY),
  attention: { id: 'demo-attention-1', question: '入口放概览还是执行页？' },
  assignments: [{ id: 'demo-a1', state: 'running', createdAt: ago(3 * DAY), startedAt: ago(3 * DAY),
    report: { state: 'progress', summary: '等确认入口位置后再改。', at: ago(2 * DAY) } }],
  inputs: [{ id: 'demo-i1', kind: 'text', at: ago(2 * DAY), person: true, text: '人回复：先放概览。' }],
}))
store.tickets.save(ticket({
  id: 'demo-decision-0002', title: '示例：构建失败等你决定是否重试',
  createdAt: ago(3 * DAY), updatedAt: ago(3 * DAY),
  assignments: [{ id: 'demo-a2', state: 'running', createdAt: ago(4 * DAY), startedAt: ago(4 * DAY),
    report: { state: 'failed', summary: '示例：编译在 PlayLevel 阶段失败。', at: ago(3 * DAY) } }],
}))

// 待你验证: a fresh handover, two live deliveries older than a day, and one ended delivery waiting for a backfill.
const handover = (fields: { id: string; title: string; minutesAgo: number; changelist: number; review?: string
  level?: 'P1' | 'P2'; endedAgo?: number }) => store.tickets.save(ticket({
  id: fields.id, title: fields.title, createdAt: ago(6 * DAY), updatedAt: ago(fields.minutesAgo),
  ...fields.level ? { priority: { level: fields.level, source: 'default', at: ago(6 * DAY), note: 'automatic' } } : {},
  execution: { name: fields.id, directory: `/tmp/${fields.id}`, assignment: 'demo', changelist: fields.changelist,
    ...fields.review ? { review: fields.review } : {},
    verification: ['版本与前置：示例面板构建；CL 示例', '复现步骤：打开看板，再打开这张工单',
      '预期与证据：工单显示「待你验证」', '待你判断：这张单是否仍需要现在看'].join('\n') },
  verification: { at: ago(fields.minutesAgo), state: 'pending' },
  assignments: [{ id: `${fields.id}-a`, state: 'ended', createdAt: ago(fields.minutesAgo + 60), startedAt: ago(fields.minutesAgo + 60),
    endedAt: ago(fields.minutesAgo), report: { state: 'ready', summary: '示例：已交付，等本地验证。', at: ago(fields.minutesAgo) } }],
  ...fields.endedAgo !== undefined ? { ended: { at: ago(fields.endedAgo), by: 'human', outcome: 'completed' } } : {},
}))
handover({ id: 'demo-verify-0003', title: '示例：刚交付的转向修复等你本地验证', minutesAgo: 2 * HOUR, changelist: 620101,
  review: '620101', level: 'P1' })
handover({ id: 'demo-verify-0004', title: '示例：一天前交付的镜头跟随修复', minutesAgo: 30 * HOUR, changelist: 620077,
  review: '620077', level: 'P2' })
handover({ id: 'demo-verify-0005', title: '示例：两天前交付的动画融合调整', minutesAgo: 36 * HOUR, changelist: 620065,
  review: '620065', level: 'P1' })
handover({ id: 'demo-verify-0006', title: '示例：三天前交付的界面文案修正', minutesAgo: 3 * DAY, changelist: 620012,
  level: 'P2' })
handover({ id: 'demo-verify-0007', title: '示例：已结束的历史交付待补验', minutesAgo: 2 * DAY, changelist: 620090,
  endedAgo: DAY })

// 正在跑: two worker turns running now, one turn queued for a slot, and one Ticket between turns.
store.tickets.save(ticket({
  id: 'demo-run-0008', title: '示例：worker 正在改转向门控',
  createdAt: ago(1 * DAY), updatedAt: ago(12 * MIN),
  assignments: [{ id: 'demo-a8', state: 'running', createdAt: ago(20 * MIN), startedAt: ago(12 * MIN) }],
}))
store.tickets.save(ticket({
  id: 'demo-run-0009', title: '示例：worker 正在跑回归用例',
  createdAt: ago(2 * DAY), updatedAt: ago(25 * MIN),
  assignments: [{ id: 'demo-a9', state: 'running', createdAt: ago(40 * MIN), startedAt: ago(25 * MIN) }],
}))
store.tickets.save(ticket({
  id: 'demo-queued-0010', title: '示例：排队等执行槽的工单',
  createdAt: ago(1 * DAY), updatedAt: ago(5 * MIN),
  assignments: [{ id: 'demo-a10', state: 'pending', createdAt: ago(5 * MIN) }],
}))
store.tickets.save(ticket({
  id: 'demo-idle-0011', title: '示例：等待新触发的工单',
  createdAt: ago(9 * DAY), updatedAt: ago(4 * DAY),
  assignments: [{ id: 'demo-a11', state: 'ended', createdAt: ago(5 * DAY), startedAt: ago(5 * DAY), endedAt: ago(4 * DAY),
    report: { state: 'waiting', summary: '没有新触发，先待命。', at: ago(4 * DAY) } }],
}))

// 流水线: the local check passed days ago; the review waits for a person now (the pipeline poll is not activity).
store.tickets.save(ticket({
  id: 'demo-pipeline-0012', title: '示例：已过本地验证，Swarm 审核等你点通过',
  createdAt: ago(8 * DAY), updatedAt: ago(1 * HOUR),
  execution: { name: 'demo-pipeline', directory: '/tmp/demo-pipeline', assignment: 'demo', changelist: 619900, review: '619900' },
  verification: { at: ago(5 * DAY), state: 'passed', by: 'person' },
  pipeline: { state: 'blocked', at: ago(1 * HOUR), manual: true, step: 'review', check: 'Swarm 已通过，待人工审核',
    url: 'https://swarm.example/reviews/619900', progress: { pass: 2, running: 0, fail: 0, total: 2 } },
  assignments: [{ id: 'demo-a12', state: 'ended', createdAt: ago(6 * DAY), startedAt: ago(6 * DAY), endedAt: ago(5 * DAY),
    report: { state: 'ready', summary: '已交付 CL 619900 / Swarm 619900。', at: ago(5 * DAY) } }],
}))

// 闲时池: one P2 defect, which the band and the dock both keep out of the live rows.
store.tickets.save(ticket({
  id: 'demo-pool-0013', title: '示例：闲时池里的 P2 缺陷',
  createdAt: ago(4 * DAY), updatedAt: ago(5 * HOUR),
  priority: { level: 'P2', source: 'default', at: ago(4 * DAY), note: 'human-mention' },
  assignments: [{ id: 'demo-a13', state: 'pending', createdAt: ago(5 * HOUR) }],
}))

// 最近结束: work that ended after its local check passed.
store.tickets.save(ticket({
  id: 'demo-ended-0014', title: '示例：一小时前完成并验收',
  createdAt: ago(5 * DAY), updatedAt: ago(1 * HOUR),
  execution: { name: 'demo-ended-14', directory: '/tmp/demo-ended-14', assignment: 'demo', changelist: 619880, review: '619880' },
  verification: { at: ago(2 * HOUR), state: 'passed', by: 'person' },
  ended: { at: ago(1 * HOUR), by: 'executor', outcome: 'completed' },
  assignments: [{ id: 'demo-a14', state: 'ended', createdAt: ago(3 * HOUR), startedAt: ago(3 * HOUR), endedAt: ago(1 * HOUR),
    report: { state: 'ready', summary: '已交付 CL 619880 / Swarm 619880。', at: ago(1 * HOUR) } }],
}))

store.close()
console.log('seeded', dbPath, '14 tickets')
