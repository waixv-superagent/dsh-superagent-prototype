/**
 * Regenerates the before/after card payloads for the @ mention evidence. Run from the repository root:
 *   node --experimental-transform-types evidence/card-at-mention-899fac25b3f0/generate-evidence.mjs
 * The before payloads call the card builders without a mention; the after payloads pass the ticket's Feishu open_id.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grillCard, pipelineStageCard, planCard } from '../../src/sources/feishu-card.ts'
import { feishuPostContent } from '../../src/sources/feishu-text.ts'

const dir = dirname(fileURLToPath(import.meta.url))
const ticket = { id: 'a'.repeat(32), title: '翻页头像闪烁' }
const plan = {
  text: `现象：翻页时头像闪一下
代码线：Source/UI/AvatarList.cpp:42 — 复用控件时清空了纹理
资产线：已排除
配置线：已排除
修复锚点：Source/UI/AvatarList.cpp，1 个文件
影响面：只影响该列表
验证方案：基线 3 例 → 改后 3 例
预算：编译 1 次，约 20 分钟`,
  at: '2026-11-19T00:00:00Z',
}
const grill = { id: 'g1', at: '2026-11-19T00:00:00Z', answers: [], questions: [
  { id: 'q1', title: '状态放哪', question: '放 ActionState 还是 ANS 实例？', options: ['ActionState', 'ANS 实例'], recommended: 0 },
] }
const notice = { ticketId: ticket.id, title: ticket.title, tone: 'waiting', heading: '检查已通过 · 待人工审核', lines: ['自动检查 11/11 通过'], links: [] }
const mention = ['ou_70cfed1e3a0e4543b97503e4b3cf8363']
const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n')

write('before-plan-card.json', planCard(ticket, plan).card)
write('after-plan-card.json', planCard(ticket, plan, undefined, mention).card)
write('before-plan-text.json', JSON.parse(feishuPostContent(planCard(ticket, plan).text)))
write('after-plan-text.json', JSON.parse(feishuPostContent(planCard(ticket, plan).text, mention)))
write('before-grill-card.json', grillCard(ticket, grill).card)
write('after-grill-card.json', grillCard(ticket, grill, undefined, mention).card)
write('after-pipeline-card.json', pipelineStageCard(notice, '待人工审核', undefined, mention).card)
console.log(`evidence written under ${dir}`)
