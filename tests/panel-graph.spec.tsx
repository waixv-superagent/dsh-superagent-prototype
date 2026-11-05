// @vitest-environment jsdom
// The relation view of 概览: how Tickets started, superseded and blocked one another, in two layouts.
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cloudLayout, edgeEnds, FUZZY, fuzzyAlpha, LIFE, NODE, nodeRadius, nodeTone, placeLabels, specks, timelineLayout } from '../src/client/graph.tsx'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, tab, settle } from './fixtures/panel.tsx'
import { graphView, server } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => { vi.unstubAllGlobals() })
const openGraph = async () => {
  await mount()
  const top = tab(zh['tab.editor'])
  if (top.getAttribute('aria-selected') !== 'true') await click(top)
  await click(tab(zh.homeViewGraph))
}
const openCloud = async () => { await openGraph(); await click(tab(zh.graphLayoutCloud)) }
/** Animation frames that run only when a test steps them, 17ms apart, so the cloud's loop is driven frame by frame. */
function fakeFrames() {
  const queue = new Map<number, FrameRequestCallback>()
  let id = 0, time = 1000
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queue.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { queue.delete(frame) })
  return {
    get pending() { return queue.size },
    step(frames = 1, each?: () => void) {
      act(() => {
        for (let i = 0; i < frames; i++) {
          time += 17
          const due = [...queue.values()]
          queue.clear()
          for (const callback of due) callback(time)
          each?.()
        }
      })
    },
  }
}
const reduceMotion = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query,
  addEventListener() {}, removeEventListener() {} }))
const node = (title: string) => all('.dt-graph-node').find(item => item.getAttribute('aria-label') === title)!
const dot = (title: string) => node(title).querySelector<SVGCircleElement>('.dt-graph-dot')!

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

it('puts the hovered timeline Ticket\'s title beside its node, vertically centred, flipping left where the right runs out', async () => {
  await openGraph()
  const label = async (title: string) => {
    await act(async () => { node(title).focus() })
    const span = node(title).querySelector('.dt-graph-span')!, text = all('.dt-graph-label')
    expect(text).toHaveLength(1)
    return { x0: Number(span.getAttribute('x')), x1: Number(span.getAttribute('x')) + Number(span.getAttribute('width')),
      y: Number(span.getAttribute('y')) + 4, text: text[0]! }
  }
  // An ended Ticket's span stops early, so its title sits right of where the span ends.
  const done = await label('README 更新')
  expect(Number(done.text.getAttribute('x'))).toBeCloseTo(done.x1 + 8)
  expect(Number(done.text.getAttribute('y'))).toBeCloseTo(done.y)
  expect(done.text.getAttribute('dominant-baseline')).toBe('central')
  expect(done.text.getAttribute('text-anchor')).toBeNull()
  // An open one runs to the right edge, so its title flips left of where it began, right-aligned.
  const open = await label('修复移动普攻后接 Q 技能无法起飞')
  expect(Number(open.text.getAttribute('x'))).toBeCloseTo(open.x0 - 9)
  expect(Number(open.text.getAttribute('y'))).toBeCloseTo(open.y)
  expect(open.text.getAttribute('dominant-baseline')).toBe('central')
  expect(open.text.getAttribute('text-anchor')).toBe('end')
  expect(open.text.textContent).toBe('修复移动普攻后接 Q 技能无法起飞')
})

it('keeps the cloud moving on animation frames without breathing the radius, and eases a hovered node up', async () => {
  const frames = fakeFrames()
  await openCloud()
  // 修复回归 has two relations besides its conversation, so it carries a gleam; 补 i18n 文案 has one and stays plain.
  const r = nodeRadius(2), start = dot('修复回归').getAttribute('cx')
  expect(node('修复回归').querySelector('.dt-graph-gleam')).not.toBeNull()
  expect(node('补 i18n 文案').querySelector('.dt-graph-gleam')).toBeNull()
  expect(all('.dt-graph-ring')).toHaveLength(0)
  const radii = new Set<string>(), opacity: number[] = []
  frames.step(150, () => { radii.add(dot('修复回归').getAttribute('r')!); opacity.push(Number(dot('修复回归').style.fillOpacity)) })
  expect([...radii]).toEqual([r.toFixed(2)])
  expect(Math.min(...opacity)).toBeGreaterThanOrEqual(1 - 2 * LIFE.breath - 1e-9)
  expect(Math.max(...opacity)).toBeLessThanOrEqual(1)
  expect(new Set(opacity).size).toBeGreaterThan(1)
  expect(dot('修复回归').getAttribute('cx')).not.toBe(start)
  expect(frames.pending).toBe(1)
  // Arrows show only on the hovered Ticket's edges, and the hovered name is the brightest label.
  expect(all('.dt-graph-cloud .dt-graph-edge').some(edge => edge.getAttribute('marker-end'))).toBe(false)
  await act(async () => { node('修复回归').focus() })
  frames.step(30)
  expect(Number(dot('修复回归').getAttribute('r'))).toBeCloseTo(r + NODE.lift, 2)
  expect(all('.dt-graph-cloud .dt-graph-edge[data-lit]').map(edge => edge.getAttribute('marker-end'))).toEqual(['url(#dt-graph-arrow-spawned)',
    'url(#dt-graph-arrow-spawned)'])
  expect(all('.dt-graph-label[data-hover]').map(label => label.textContent)).toEqual(['修复回归'])
  expect(all('.dt-graph-label').every(label => label.dataset.hover !== undefined || label.dataset.minor !== undefined)).toBe(true)
})

it('pauses the cloud\'s loop while the tab is hidden and picks it up again when the tab comes back', async () => {
  const frames = fakeFrames()
  await openCloud()
  frames.step(2)
  expect(frames.pending).toBe(1)
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  try {
    frames.step(1)
    expect(frames.pending).toBe(0)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.pending).toBe(0)
  } finally { delete (document as { hidden?: boolean }).hidden }
  document.dispatchEvent(new Event('visibilitychange'))
  expect(frames.pending).toBe(1)
})

it('runs no standing loop under reduced motion, paints one still frame, and rings the hubs', async () => {
  reduceMotion()
  const frames = fakeFrames()
  const leaves = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, title: `子单 ${id}`, stage: 'idle' as const, source: 'feishu',
    createdAt: '2026-09-22T10:00:00Z', thread: 'github:42' }))
  server.graph = { nodes: [{ id: 'hub', title: '今日复盘任务', stage: 'working', source: 'feishu', createdAt: '2026-09-22T09:00:00Z',
    thread: 'github:42' }, ...leaves], edges: leaves.map(leaf => ({ from: 'hub', to: leaf.id, kind: 'spawned' as const, via: 'handback' as const,
    at: '2026-09-22T10:00:00Z' })), lanes: [{ key: 'github:42', title: '#42' }], total: 7 }
  await openCloud()
  frames.step(5)
  expect(frames.pending).toBe(0)
  expect(dot('今日复盘任务').getAttribute('r')).toBe(nodeRadius(NODE.hub).toFixed(2))
  expect(dot('今日复盘任务').style.fillOpacity).toBe('1')
  // Only the Ticket with `NODE.hub` relations wears the ring.
  expect(all('.dt-graph-ring')).toHaveLength(1)
  expect(node('今日复盘任务').querySelector('.dt-graph-ring')).not.toBeNull()
  // The sheen's gradient is the cloud's own, set inline: a fill attribute loses to the stylesheet's node fill, which would
  // paint the sheen flat over the node.
  const gradient = document.querySelector('.dt-graph-cloud radialGradient')!.id, sheen = node('今日复盘任务').querySelector<SVGCircleElement>('.dt-graph-sheen')!
  expect(sheen.style.fill.replaceAll('"', '')).toBe(`url(#${gradient})`)
  expect(sheen.getAttribute('fill')).toBeNull()
  // The hub is the one name shown before anything is hovered; hovering jumps straight to the lifted radius.
  expect(all('.dt-graph-label').map(label => label.textContent)).toEqual(['今日复盘任务'])
  await act(async () => { node('子单 a').focus() })
  expect(dot('子单 a').getAttribute('r')).toBe((nodeRadius(1) + NODE.lift).toFixed(2))
  expect(frames.pending).toBe(0)
  // A press without a drag still opens the Ticket.
  await act(async () => {
    node('子单 a').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    node('子单 a').dispatchEvent(new Event('pointerup', { bubbles: true }))
  })
  await settle()
  expect(server.requests.some(request => request.path === 'tickets/a')).toBe(true)
})

it('schedules each edge\'s specks deterministically from its own clock', () => {
  expect(specks('k', 12_345, 3000, 1600, true)).toEqual(specks('k', 12_345, 3000, 1600, true))
  const seen: { t: number; back: boolean }[] = []
  for (let clock = 0; clock < 60_000; clock += 37) seen.push(...specks('k', clock, 3000, 1600, true))
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(speck => speck.t >= 0 && speck.t < 1)).toBe(true)
  // A related edge's specks run either way; a directed edge's always from its source.
  expect(new Set(seen.map(speck => speck.back))).toEqual(new Set([true, false]))
  expect(Array.from({ length: 200 }, (_, i) => specks('k', i * 97, 3000, 1600, false)).flat().every(speck => !speck.back)).toBe(true)
  // A crossing longer than the interval puts several on the edge at once.
  expect(Math.max(...Array.from({ length: 100 }, (_, i) => specks('long', i * 50, 2000, 5000, false).length))).toBeGreaterThanOrEqual(2)
  // As the clock runs on, each speck moves forward without jumping.
  const before = specks('k', 20_000, 3000, 5000, false), after = specks('k', 20_100, 3000, 5000, false)
  expect(after).toHaveLength(before.length)
  after.forEach((speck, i) => { expect(speck.t - before[i]!.t).toBeCloseTo(100 / 5000) })
})

it('places cloud names right of their node, else left, never over another name or node, and always keeps the hovered one', () => {
  const at = new Map([['a', { x: 100, y: 100, r: 5 }], ['b', { x: 100, y: 108, r: 4 }], ['c', { x: 100, y: 102, r: 4 }],
    ['edge', { x: 395, y: 200, r: 5 }], ['far', { x: 300, y: 50, r: 5 }]])
  const placed = placeLabels([{ id: 'a', text: 'abc' }, { id: 'b', text: 'abc' }, { id: 'c', text: 'abc' }, { id: 'edge', text: 'abc' },
    { id: 'missing', text: 'x' }], at, 400, 300)
  // b's right side is taken by a's name, c's both sides are, and edge's right side runs off the box.
  expect(placed.map(label => [label.id, label.side])).toEqual([['a', 'right'], ['b', 'left'], ['edge', 'left']])
  const forced = placeLabels([{ id: 'a', text: 'abc' }, { id: 'b', text: 'abc' }, { id: 'c', text: 'abc', force: true, minor: true }], at, 400, 300)
  expect(forced.map(label => [label.id, label.minor])).toEqual([['a', false], ['b', false], ['c', true]])
  // A name with a node on either side of it is dropped rather than drawn across one.
  expect(placeLabels([{ id: 'far', text: 'mm' }], new Map([['far', at.get('far')!], ['l', { x: 290, y: 50, r: 4 }], ['r', { x: 312, y: 50, r: 4 }]]),
    400, 300)).toEqual([])
})

it('sizes cloud nodes by their relations, growing with each and capped, and ends an edge at its target\'s rim', () => {
  const radii = Array.from({ length: 60 }, (_, degree) => nodeRadius(degree))
  expect(radii[0]).toBe(3.5)
  expect(radii.every((r, i) => i === 0 || r > radii[i - 1]! || r === 13)).toBe(true)
  expect(Math.max(...radii)).toBe(13)
  // One relation is a small plain node; two or more earn the gleam.
  expect(nodeRadius(1)).toBeLessThan(NODE.gleam)
  expect(nodeRadius(2)).toBeGreaterThanOrEqual(NODE.gleam)
  expect(edgeEnds({ x: 0, y: 0 }, { x: 100, y: 0, r: 8 })).toEqual({ x1: 0, y1: 0, x2: 90, y2: 0 })
})

/** The fixture graph with an unrelated Ticket and two guessed edges, one of them to that Ticket. */
const guessedGraph = () => {
  const graph = graphView()
  const similar = (from: string, to: string, strength: number, reason: string) => ({ from, to, kind: 'similar' as const, via: 'fuzzy' as const,
    strength, reason, at: '2026-09-22T10:00:00Z' })
  return { ...graph, nodes: [...graph.nodes, { id: 't9', title: '孤立工单', stage: 'idle' as const, source: 'feishu', createdAt: '2026-09-22T10:00:00Z',
    thread: 'github:43' }], edges: [...graph.edges, similar('t8', 't9', .49, '标题都有「普攻 / flying」；共享「CL 581604」；同一执行目标'),
    similar('t5', 't7', .72, '标题都有「文案」')], total: 7 }
}

it('draws guessed edges in the cloud as faint dotted lines with no arrow, counts them apart, and switches them off', async () => {
  reduceMotion()
  fakeFrames()
  server.graph = guessedGraph()
  await openCloud()
  // On by default: the Ticket with only a guess counts as related, and the guesses are counted apart from the relations.
  expect(document.querySelector('.dt-graph-count')?.textContent).toBe('7 张工单 · 4 条关系 · 2 条推测')
  expect(all('.dt-graph-legend-item').map(item => item.textContent)).toContain(zh['relation.similar'])
  expect(all('.dt-hint').some(hint => hint.textContent?.includes(zh.graphFuzzyHint))).toBe(true)
  const guesses = all('.dt-graph-cloud .dt-graph-edge[data-kind="similar"]')
  expect(guesses).toHaveLength(2)
  // Fainter the weaker, never stronger than the explicit edges' 14%.
  expect(guesses.map(edge => Number(edge.style.strokeOpacity))).toEqual([fuzzyAlpha(.49), fuzzyAlpha(.72)].map(alpha => expect.closeTo(alpha, 5)))
  expect(fuzzyAlpha(.3)).toBeCloseTo(FUZZY.alpha[0])
  expect(fuzzyAlpha(.72)).toBeCloseTo(FUZZY.alpha[1])
  expect(guesses[0]!.querySelector('title')?.textContent).toBe('修复移动普攻后接 Q 技能无法起飞 ↔ 孤立工单 · 推测相关 49% · '
    + '按标题、共享模块/单号、时间推测，未经确认 · 标题都有「普攻 / flying」；共享「CL 581604」；同一执行目标')
  // A guess is not a relation: it grows no node.
  expect(dot('孤立工单').getAttribute('r')).toBe(nodeRadius(0).toFixed(2))
  expect(dot('README 更新').getAttribute('r')).toBe(nodeRadius(1).toFixed(2))
  // Hovering lights the guess without an arrow and says why along it, beside the hovered name.
  await act(async () => { node('修复移动普攻后接 Q 技能无法起飞').focus() })
  const lit = all('.dt-graph-cloud .dt-graph-edge[data-lit]')
  expect(lit.map(edge => [edge.dataset.kind, edge.getAttribute('marker-end')])).toEqual([['blocks', 'url(#dt-graph-arrow-blocks)'], ['similar', null]])
  expect(lit[1]!.style.strokeOpacity).toBe('')
  expect(all('.dt-graph-why').map(why => why.textContent)).toEqual(['49% · 标题都有「普攻 / flying」；共…'])
  expect(all('.dt-graph-label[data-hover]').map(label => label.textContent)).toEqual(['修复移动普攻后接 Q 技能无法起飞'])
  await act(async () => { node('修复移动普攻后接 Q 技能无法起飞').blur() })
  expect(all('.dt-graph-why')).toHaveLength(0)
  // Off: the guesses, the Ticket they alone kept, their count and legend go; the relations stay as they were.
  await click(zh.graphFuzzy)
  await settle()
  expect(all('.dt-graph-cloud .dt-graph-edge[data-kind="similar"]')).toHaveLength(0)
  expect(all('.dt-graph-node')).toHaveLength(6)
  expect(document.querySelector('.dt-graph-count')?.textContent).toBe('6 张工单 · 4 条关系')
  expect(all('.dt-graph-legend-item').map(item => item.textContent)).not.toContain(zh['relation.similar'])
  expect(dot('README 更新').getAttribute('r')).toBe(nodeRadius(1).toFixed(2))
})

it('never draws or counts guessed edges on the timeline, which has no switch for them', async () => {
  server.graph = guessedGraph()
  await openGraph()
  expect(document.querySelector('.dt-graph-count')?.textContent).toBe('6 张工单 · 4 条关系')
  expect(all('.dt-graph-edge').filter(edge => edge.tagName === 'path').map(edge => edge.dataset.kind)).toEqual(['spawned', 'spawned', 'supersedes', 'blocks'])
  expect(all('button').some(button => button.textContent === zh.graphFuzzy)).toBe(false)
  expect(all('.dt-graph-node').map(item => item.getAttribute('aria-label'))).not.toContain('孤立工单')
})

it('draws arrowheads as thin open chevrons sized in user units, tip on the line\'s end', async () => {
  await openGraph()
  const marker = document.querySelector('marker#dt-graph-arrow-spawned')!
  expect(marker.getAttribute('markerUnits')).toBe('userSpaceOnUse')
  expect(marker.getAttribute('refX')).toBe('6.5')
  expect(marker.querySelector('path')!.getAttribute('d')).toBe('M1 2 L6.5 5 L1 8')
  // The legend's samples are lines with no arrowhead.
  expect(all('.dt-graph-legend line').some(line => line.getAttribute('marker-end'))).toBe(false)
})

it('pulls guessed pairs together far more weakly than related ones, the more weakly the less sure', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id }))
  // Against an explicit pair's length in the same layout, since the fit scales the whole cloud into its box.
  const gap = (edges: Parameters<typeof cloudLayout>[1]) => {
    const at = cloudLayout(nodes, edges, 800, 500), d = (x: string, y: string) => Math.hypot(at.get(x)!.x - at.get(y)!.x, at.get(x)!.y - at.get(y)!.y)
    return d('a', 'b') / d('c', 'd')
  }
  const spine = [{ from: 'c', to: 'd', kind: 'spawned' as const }, { from: 'e', to: 'f', kind: 'spawned' as const }]
  const explicit = gap([...spine, { from: 'a', to: 'b', kind: 'spawned' }])
  const strong = gap([...spine, { from: 'a', to: 'b', kind: 'similar', strength: .9 }])
  const weak = gap([...spine, { from: 'a', to: 'b', kind: 'similar', strength: .3 }])
  expect(explicit).toBeCloseTo(1, 1)
  expect(explicit * 1.5).toBeLessThan(strong)
  expect(strong).toBeLessThan(weak)
})

it('puts a guessed edge\'s reason along it where there is room, else drops it rather than cover a name or a node', () => {
  const at = new Map([['h', { x: 100, y: 100, r: 5 }], ['o', { x: 300, y: 100, r: 5 }], ['m', { x: 240, y: 100, r: 4 }]])
  const along = { from: 'h', to: 'o', t: FUZZY.along }
  // The first point (62% out) sits on the node m, so the reason moves to the next one, half way.
  const placed = placeLabels([{ id: 'h', text: '工单', force: true }, { id: 'why', text: '49% · 标题', along }], at, 400, 300)
  expect(placed.map(label => [label.id, label.side, label.along?.t])).toEqual([['h', 'right', undefined], ['why', 'along', .5]])
  // With every point on a node the reason is left out, and the names stay.
  const crowded = new Map([...at, ['n1', { x: 200, y: 100, r: 4 }], ['n2', { x: 252, y: 100, r: 4 }], ['n3', { x: 176, y: 100, r: 4 }]])
  expect(placeLabels([{ id: 'h', text: '工单', force: true }, { id: 'why', text: '49% · 标题', along }], crowded, 400, 300).map(label => label.id))
    .toEqual(['h'])
  // A name placed first keeps its place: the reason does not go over it.
  const named = placeLabels([{ id: 'h', text: '一个很长很长很长很长的工单标题', force: true }, { id: 'why', text: '49% · 标题', along: { from: 'h', to: 'o', t: [.25] } }],
    new Map([['h', at.get('h')!], ['o', at.get('o')!]]), 400, 300)
  expect(named.map(label => label.id)).toEqual(['h'])
})
