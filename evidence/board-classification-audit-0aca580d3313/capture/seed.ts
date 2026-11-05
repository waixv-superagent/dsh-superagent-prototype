/**
 * Seed a small synthetic database reproducing the board-classification report (a delivered Ticket that waits for the
 * person's local check while a question and a blocked pipeline are also open), so before/after captures render the real
 * panel over the same data without publishing any real Ticket. Usage: node seed.ts <repo-root> <db-path>
 */
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const [root, dbPath] = process.argv.slice(2) as [string, string]
const load = (path: string) => import(pathToFileURL(join(root, path)).href)
const { Store } = await load('src/app/store.ts')
const { SettingsSchema } = await load('src/policy.ts')

rmSync(dbPath, { force: true })
const store = new Store(dbPath)
store.saveSettings(SettingsSchema.parse({ policy: {
  sources: { feishu: { allowed: [{ id: 'ou_demo', name: '示例发起人' }] }, github: { allowed: [] } },
  rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }],
} }))

const at = '2026-11-05T07:53:00.000Z'
const ticketId = '9a1b2c3d4e5f60718293a4b5c6d7e8f9'
store.tickets.save({
  id: ticketId,
  title: '示例：已交付，等本地验证（同时有一个提问）',
  decisionId: 'demo-decision',
  mandate: { strength: 'explicit', policyVersion: 'demo', basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'ou_demo' }, scope: '示例：交付后等本地验证' },
  channels: [{ source: 'feishu', thread: 'feishu:oc_demo:om_demo',
    address: { chatId: 'oc_demo', messageId: 'om_demo', direct: 'true' } }],
  origin: { triggerId: 'demo-trigger', triggerIds: ['demo-trigger'] },
  createdAt: '2026-11-04T08:00:00.000Z',
  updatedAt: '2026-11-05T07:49:46.000Z',
  assignments: [{ id: 'demo-assignment', state: 'ended', createdAt: '2026-11-05T06:00:00.000Z',
    startedAt: '2026-11-05T06:00:00.000Z', deliveredAt: '2026-11-05T07:04:42.000Z', idleAt: '2026-11-05T07:49:46.000Z',
    report: { state: 'ready', at: '2026-11-05T07:04:42.000Z',
      summary: '已修复并交付 CL 9001 / Swarm 9001：只改示例资产的过渡表，不改代码与协议。' } }],
  inputs: [], undelivered: [],
  execution: { name: 'board-demo', directory: '/tmp/board-demo', assignment: 'demo', changelist: 9001, review: '9001',
    verification: [
      '版本与前置：origin/main 示例构建，示例地图；CL 9001',
      '复现步骤：打开面板看板，再打开这张 Ticket',
      '预期与证据：交付后 Ticket 显示「待你验证」，看板进入「待你验证」列',
      '待你判断：这个分类是否符合你的预期',
    ].join('\n') },
  verification: { at: '2026-11-05T07:04:42.000Z', state: 'pending' },
  attention: { id: 'demo-attention', question: '这 9 处审核问题要谁继续处理？' },
  pipeline: { state: 'blocked', at: '2026-11-05T07:45:00.000Z', manual: true, step: 'review',
    check: 'Swarm 已通过，待人工审核', url: 'https://swarm.example/reviews/9001',
    progress: { pass: 2, running: 0, fail: 0, total: 2 } },
  phase: 'deliver',
})
store.close()
console.log('seeded', dbPath, ticketId)
