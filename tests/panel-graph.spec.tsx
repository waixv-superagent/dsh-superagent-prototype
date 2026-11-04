// @vitest-environment jsdom
// The relation view of 概览: how Tickets started, superseded and blocked one another, in two layouts.
import { act } from 'react'
import { expect, it } from 'vitest'
import { cloudLayout, nodeTone, timelineLayout } from '../src/client/graph.tsx'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, tab, settle } from './fixtures/panel.tsx'
import { graphView, server } from './fixtures/panel-server.ts'

usePanel()
const openGraph = async () => {
  await mount()
  const top = tab(zh['tab.editor'])
  if (top.getAttribute('aria-selected') !== 'true') await click(top)
  await click(tab(zh.homeViewGraph))
}

it('opens the relation view from 概览 as a timeline with one lane per conversation, and a node opens its Ticket', async () => {
  await openGraph()
  expect(all('.dt-home-switch [role="tab"]').map(item => item.textContent)).toEqual(['编辑器', '看板', '关系图'])
  expect(document.querySelector('.dt-graph-count')?.textContent).toBe('6 张工单 · 4 条关系')
  expect(all('.dt-graph-lane title').map(item => item.textContent)).toEqual(['旧话题', '这个文案好奇怪', '#42 Fix login'])
  // The same-conversation edge is the lane itself, so the timeline draws only the relations between Tickets.
  expect(all('.dt-graph-edge').filter(edge => edge.tagName === 'path').map(edge => edge.dataset.kind)).toEqual(['spawned', 'spawned', 'supersedes', 'blocks'])
  expect(all('.dt-graph-node').map(node => [node.getAttribute('aria-label'), node.dataset.tone])).toEqual([['旧工单', 'closed'],
    ['修复回归', 'working'], ['补 i18n 文案', 'working'], ['升级依赖', 'person'], ['README 更新', 'done'], ['修复移动普攻后接 Q 技能无法起飞', 'person']])
  await act(async () => { all('.dt-graph-node')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle()
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(true)
})

it('switches to the cloud, and hides Tickets with no relation unless a person asks for every one', async () => {
  server.graph = { ...graphView(), nodes: [...graphView().nodes, { id: 't9', title: '孤立工单', stage: 'idle', source: 'feishu',
    createdAt: '2026-09-22T10:00:00Z', thread: 'github:42' }], total: 7 }
  await openGraph()
  await click(tab(zh.graphLayoutCloud))
  expect(document.querySelector('.dt-graph-cloud')).not.toBeNull()
  expect(all('.dt-graph-node')).toHaveLength(6)
  await click(zh.graphOnlyLinked)
  await settle()
  expect(all('.dt-graph-node')).toHaveLength(7)
})

it('lays the timeline out on one time axis and the cloud deterministically inside its box', () => {
  const graph = graphView()
  const layout = timelineLayout(graph, 1000, Date.parse('2026-09-23T00:00:00Z'), 'zh')
  const t1 = layout.spans.get('t1')!, t5 = layout.spans.get('t5')!, t0 = layout.spans.get('t0')!
  expect(t1.x0).toBeLessThan(t5.x0)
  expect(t1.y).toBe(t5.y)
  expect(t0.y).toBeLessThan(t1.y)
  // An open Ticket runs to now, the right edge.
  expect(t1.x1).toBeCloseTo(1000 - 16)
  const first = cloudLayout(graph.nodes, graph.edges, 800, 500), again = cloudLayout(graph.nodes, graph.edges, 800, 500)
  expect([...first.entries()]).toEqual([...again.entries()])
  expect([...first.values()].every(p => p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 500)).toBe(true)
  expect(nodeTone({ stage: 'ended', outcome: 'merged' })).toBe('done')
  expect(nodeTone({ stage: 'ended', outcome: 'dropped' })).toBe('closed')
})

it('lists a Ticket\'s related Tickets on its page, read from its own side', async () => {
  await mount(zh, { page: 'execution', id: 't1' })
  expect(all('.dt-section-title').some(title => title.textContent?.includes('关联工单'))).toBe(true)
  const row = all('.dt-row').find(item => item.textContent?.includes('补 i18n 文案'))!
  expect(row.textContent).toContain('开出')
  expect(row.textContent).toContain('交回的消息开出新单')
})
