// @vitest-environment jsdom
// The editor page: who holds the editor, which Tickets are working with their live tool, and what waits on a person.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, mountHome, remount, all, click, tab } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
/** 概览 opens on the board now; the editor cases enter through the switch. */
const openEditor = async () => {
  await click(tab(zh['tab.editor']))
  await click(tab(zh.homeViewEditor))
}
const counts = () => all('.dt-editor-counts [data-count]').map(count => count.textContent)

it('opens on the board view, with the editor one switch away', async () => {
  await mountHome()
  expect(tab(zh['tab.editor']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-tabs [role="tab"]').map(tab => tab.textContent)).toEqual(['概览', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-home-switch [role="tab"]').map(tab => tab.textContent)).toEqual(['编辑器', '看板'])
  expect(tab(zh.homeViewBoard).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-verdict')).not.toBeNull()
  expect(document.querySelector('.dt-editor-hero')).toBeNull()

  await click(tab(zh.homeViewEditor))
  expect(tab(zh.homeViewEditor).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-editor-hero')).not.toBeNull()
  expect(document.querySelector('.dt-editor-timeline')).not.toBeNull()
  expect(document.querySelector('.dt-verdict')).toBeNull()
  // The switch is a view, not a second tab bar: the page tab stays 概览 while the editor shows.
  expect(tab(zh['tab.editor']).getAttribute('aria-selected')).toBe('true')
  await click(tab(zh.homeViewBoard))
  expect(document.querySelector('.dt-verdict')).not.toBeNull()
})

it('opens the board at the Tickets behind a hero count and rings just those cards', async () => {
  server.working = [
    ticketSummary({ id: 't5aaaaaaaaaa', title: '补 i18n 文案' }),
    ticketSummary({ id: 't6', title: '升级依赖' }, { stage: 'working', action: 'queued' }),
  ]
  await mount()
  await openEditor()
  const door = (focus: string) => all('.dt-editor-counts button').find(button => button.getAttribute('data-count') === focus)!
  // Every count with something behind it is a door, and its title says where it goes.
  expect(all('.dt-editor-counts button').map(button => button.getAttribute('data-count')))
    .toEqual(['working', 'queued', 'verification', 'person'])
  expect(door('person').getAttribute('title')).toBe('跳到看板，高亮对应的工单')

  await click(door('person'))
  expect(document.querySelector('.dt-editor-hero')).toBeNull()
  expect(tab(zh.homeViewBoard).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-deck-card[data-board-focus]')).toHaveLength(2)
  expect(all('[data-board-focus]')).toHaveLength(2)

  await click(tab(zh.homeViewEditor))
  await click(door('verification'))
  expect(all('.dt-verify-card[data-board-focus]')).toHaveLength(2)
  expect(all('[data-board-focus]')).toHaveLength(2)

  await click(tab(zh.homeViewEditor))
  await click(door('queued'))
  expect(all('.dt-run[data-board-focus]').map(row => row.getAttribute('data-state'))).toEqual(['queued'])

  await click(tab(zh.homeViewEditor))
  await click(door('working'))
  expect(all('.dt-run[data-board-focus]').map(row => row.getAttribute('data-state'))).toEqual(['working'])

  // The switch's own arrival carries no cue, so the same board reads plain and no card stays ringed.
  await click(tab(zh.homeViewEditor))
  await click(tab(zh.homeViewBoard))
  expect(all('[data-board-focus]')).toHaveLength(0)
})

it('says who holds the editor, lists working Tickets with their live tool, and the verification and decisions that wait', async () => {
  server.working = [
    ticketSummary({ id: 't5aaaaaaaaaa', title: '补 i18n 文案', summary: '第 12 步 · 修改 zh-CN.json\n其余细节' }),
    ticketSummary({ id: 't6', title: '升级依赖', summary: '' }, { stage: 'working', action: 'queued' }),
  ]
  const callAt = Date.now() - 12_000
  server.activity = id => id === 't5aaaaaaaaaa'
    ? { live: true, updatedAt: Date.now(), tool: { name: 'Bash', digest: 'E:/game/CompileSunGame.bat -target', elapsed: 12_000 },
      recent: [{ name: 'Bash', digest: 'E:/game/CompileSunGame.bat -target', at: callAt, endedAt: null }] }
    : undefined
  await mount()
  await openEditor()
  expect(tab(zh['tab.editor']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-editor-hero')?.getAttribute('data-holder')).toBe('person')
  expect(document.querySelector('.dt-editor-holder')?.textContent).toBe('你正在用')
  expect(document.querySelector('.dt-editor-hero-side')?.textContent).toContain('PID 1')
  expect(document.querySelector('.dt-editor-hero-side')?.textContent).toContain('1 个工单运行中')
  expect(counts()).toEqual(['1 个工单正在工作', '1 个排队', '2 单等你验', '2 单等你决定'])
  // The last-hour timeline: one editor lane and one lane for the running Ticket; the queued Ticket has no span.
  expect(document.querySelector('.dt-editor-timeline-title')?.textContent).toBe('最近 60 分钟')
  expect(all('.dt-editor-timeline-row').length).toBe(2)
  expect(all('.dt-editor-timeline-name').map(name => name.textContent)).toEqual(['编辑器', '补 i18n 文案'])
  expect(all('.dt-editor-timeline-ticks span').map(tick => tick.textContent)).toHaveLength(5)
  expect(document.querySelector('.dt-editor-timeline-band[data-tone="person"]')).not.toBeNull()
  expect(document.querySelector('.dt-editor-timeline-band[data-tone="run"]')).not.toBeNull()
  expect(document.querySelector('.dt-editor-timeline-sub')?.textContent).toContain('不预测你什么时候用完')

  // The working list leads with the rows that use the editor and keeps the rest under their own heading.
  expect(all('.dt-editor-working-group').map(group => group.textContent)).toEqual(['占用编辑器1', '其他工作与排队1'])
  const rows = all('.dt-editor-run')
  expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['live', 'queued'])
  expect(rows.map(row => row.querySelector('.dt-editor-run-title')?.textContent)).toEqual(['补 i18n 文案', '升级依赖'])
  expect(rows[0]!.querySelector('.dt-editor-run-meta .dt-mono')?.textContent).toBe('#t5aaaaaa')
  expect(rows[0]!.querySelector('.dt-editor-run-live')?.textContent).toBe('Bash · E:/game/CompileSunGame.bat -target · 12s')
  expect(rows[0]!.querySelector('.dt-editor-run-summary')?.textContent).toBe('第 12 步 · 修改 zh-CN.json')
  expect(rows[0]!.querySelector('.dt-editor-badge')?.textContent).toBe('正在用编辑器')
  expect(rows[0]!.querySelector('.dt-editor-badge')?.getAttribute('title')).toBe('按当前工具名或 MCP server 判断，仅供参考')
  expect(rows[1]!.querySelector('.dt-editor-run-live')?.textContent).toBe('排队中，等执行器槽位')
  expect(rows[1]!.querySelector('.dt-editor-badge')).toBeNull()

  // A row opens the tools behind it: the call, what it touched and how long it has run.
  const toggle = rows[0]!.querySelector<HTMLElement>('.dt-editor-tools-toggle')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toBe('工具调用 1 次')
  await click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(all('.dt-editor-tool-name').map(name => name.textContent)).toEqual(['Bash'])
  expect(all('.dt-editor-tool-digest').map(digest => digest.textContent)).toEqual(['E:/game/CompileSunGame.bat -target'])
  expect(all('.dt-editor-tool-duration').map(duration => duration.textContent)).toEqual(['进行中'])

  expect(all('.dt-editor-group-title').map(title => title.textContent)).toEqual(['待你验2', '待你决定2'])
  const verify = all('.dt-editor-wait[data-kind="verify"]')
  expect(verify.map(row => row.querySelector('.dt-editor-run-title')?.textContent)).toEqual(['修复移动普攻后接 Q 技能无法起飞', 'README 更新'])
  expect(verify[0]!.querySelector('.dt-editor-wait-fact')?.textContent).toBe('CL 123456 · Swarm 654321')
  expect(verify[0]!.querySelector('.dt-btn')?.textContent).toBe('去验收')
  expect(all('.dt-editor-wait[data-kind="decide"] .dt-editor-wait-fact').map(fact => fact.textContent)).toEqual(['待回答', '待处理失败'])
  expect(document.querySelector('.dt-editor-foot')?.textContent).toBe('只读页面：这里不启动、不停止、不关闭编辑器；所有操作在工单页。')
  // The page is read-only: it offers no handoff, and nothing on it posts.
  expect(server.requests.filter(request => request.method !== 'GET')).toEqual([])

  await click(rows[0]!.querySelector<HTMLElement>('.dt-editor-run-title')!)
  expect(server.requests.some(request => request.path === 'tickets/t5aaaaaaaaaa' && request.method === 'GET')).toBe(true)
})

it('reads a live MCP tool as using the editor and names its server in the tool trail', async () => {
  server.working = [ticketSummary({ id: 't9', title: '搭测试关卡' })]
  const callAt = Date.now()
  server.activity = () => ({ live: true, updatedAt: callAt,
    tool: { name: 'mcp__unreal__spawn_actor', digest: '{"actor":"BP_Test"}', elapsed: 4_000 },
    recent: [{ name: 'mcp__unreal__spawn_actor', digest: '{"actor":"BP_Test"}', at: callAt - 4_000, endedAt: null },
      { name: 'Read', digest: 'Content/Test.umap', at: callAt - 9_000, endedAt: callAt - 8_000 }] })
  await mount()
  await openEditor()
  const row = all('.dt-editor-run')[0]!
  expect(row.querySelector('.dt-editor-badge')?.textContent).toBe('正在用编辑器')
  expect(row.querySelector('.dt-editor-run-live')?.textContent).toBe('MCP unreal · spawn_actor · {"actor":"BP_Test"} · 4s')
  expect(all('.dt-editor-working-group').map(group => group.textContent)).toEqual(['占用编辑器1'])
  const toggle = row.querySelector<HTMLElement>('.dt-editor-tools-toggle')!
  expect(toggle.textContent).toBe('工具调用 2 次')
  await click(toggle)
  expect(all('.dt-editor-tool-name').map(name => name.textContent)).toEqual(['MCP unreal · spawn_actor', 'Read'])
  expect(all('.dt-editor-tool-duration').map(duration => duration.textContent)).toEqual(['进行中', '1s'])
})

it('opens a Ticket waiting for verification from its row', async () => {
  await mount()
  await openEditor()
  await click(all('.dt-editor-wait[data-kind="verify"] button').find(button => button.textContent === '去验收')!)
  expect(server.requests.some(request => request.path === 'tickets/t8' && request.method === 'GET')).toBe(true)
})

it('keeps an unreadable editor on the safe side and says when nothing is working or waiting', async () => {
  server.editor = { holder: 'unknown', activity: 'unknown', since: null, pid: null, build: null, at: '2026-09-22T08:10:00.000Z',
    detail: '读取进程表失败，按人在用' }
  server.working = []
  server.person = []
  server.verification = []
  await mount()
  await openEditor()
  expect(document.querySelector('.dt-editor-hero')?.getAttribute('data-holder')).toBe('unknown')
  expect(document.querySelector('.dt-editor-holder')?.textContent).toBe('无法确认，按人在用')
  expect(document.querySelector('.dt-editor-title')?.getAttribute('title')).toBe('读取进程表失败，按人在用')
  expect(counts()).toEqual(['0 个工单正在工作', '0 单等你验', '0 单等你决定'])
  expect(all('.dt-editor-empty p').map(line => line.textContent)).toEqual(['现在没有工单在跑。', '没有等你处理的事。',
    '编辑器开着时，这里不会出现 agent 的排队提醒。'])

  // While a person holds the editor, the empty working list says agent work waits until after.
  server.editor = { holder: 'person', activity: 'editing', since: '2026-09-22T08:00:00.000Z', pid: 1, build: null,
    at: '2026-09-22T08:10:00.000Z' }
  await remount()
  await openEditor()
  expect(all('.dt-editor-empty p')[1]?.textContent).toBe('你用编辑器时，agent 的活会排到之后。')
})

it('reads the editor as loading before the first probe, and as free while an agent builds', async () => {
  server.editorPage = () => ({ editor: null, build: null, working: [], person: [], verification: [], schedule: null,
    executor: { running: 0, queued: 0, maxWorkers: 3 },
    timeline: { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), editor: [],
      workers: [], hidden: 0 },
    counts: { working: 0, queued: 0, person: 0, verification: 0 } })
  await mount()
  await openEditor()
  expect(document.querySelector('.dt-editor-holder')?.textContent).toBe('读取中')
  server.editorPage = undefined
  // A host that predates the build holder still reports free + building; the page keeps that fallback.
  server.editor = { holder: 'none', activity: 'building', since: null, pid: null, build: null, at: '2026-09-22T08:10:00.000Z' }
  await remount()
  await openEditor()
  expect(document.querySelector('.dt-editor-holder')?.textContent).toBe('空着，agent 在编译')
})

it('shows a running build as the holder and tags the Tickets delivered before it started', async () => {
  const since = new Date(Date.now() - 20 * 60_000).toISOString()
  server.editor = { holder: 'build', activity: 'building', since, pid: 42, build: { pid: 42, since },
    at: '2026-09-22T08:10:00.000Z' }
  server.build = { pid: 42, since, included: ['t8'] }
  await mount()
  await openEditor()
  expect(document.querySelector('.dt-editor-hero')?.getAttribute('data-holder')).toBe('build')
  expect(document.querySelector('.dt-editor-holder')?.textContent).toBe('编译中')
  expect(document.querySelector('.dt-editor-facts')?.textContent).toContain('编译前已交付 1 张待验单')
  expect(document.querySelector('.dt-editor-facts')?.textContent).toContain('起')
  expect(all('.dt-editor-hero-side dt').map(term => term.textContent)).toEqual(['编译进程', '执行器', '进程读取'])
  expect(document.querySelector('.dt-editor-hero-side dd')?.textContent).toBe('PID 42')
  const rows = all('.dt-editor-wait[data-kind="verify"]')
  expect(rows.map(row => row.querySelector('.dt-editor-run-title')?.textContent))
    .toEqual(['修复移动普攻后接 Q 技能无法起飞', 'README 更新'])
  expect(rows.map(row => row.querySelector('.dt-tag')?.textContent ?? null)).toEqual(['编译前已交付', null])
  expect(rows[0]!.querySelector('.dt-tag')?.getAttribute('title')).toBe('按交付时间早于编译开始推断')

  // A build that started before any delivery contains none of the waiting Tickets, and says so.
  server.build = { pid: 42, since, included: [] }
  await remount()
  await openEditor()
  expect(document.querySelector('.dt-editor-facts')?.textContent).toContain('编译前没有待验单交付')
  expect(all('.dt-editor-wait[data-kind="verify"] .dt-tag')).toHaveLength(0)
})

it('shows the running build time beside a person who is also using the editor', async () => {
  const editorSince = new Date(Date.now() - 60 * 60_000).toISOString()
  const buildSince = new Date(Date.now() - 20 * 60_000).toISOString()
  server.editor = { holder: 'person', activity: 'building', since: editorSince, pid: 7,
    build: { pid: 42, since: buildSince }, at: '2026-09-22T08:10:00.000Z' }
  server.build = { pid: 42, since: buildSince, included: ['t8'] }
  await mount()
  await openEditor()
  const facts = document.querySelector('.dt-editor-facts')?.textContent ?? ''
  expect(document.querySelector('.dt-editor-hero')?.getAttribute('data-holder')).toBe('person')
  expect(facts).toMatch(/编译 \d{2}:\d{2} 起/)
  expect(facts).toContain('编译前已交付 1 张待验单')
  expect(facts).not.toContain('构建中')
})

it('shows who holds the editor for what, ue-mcp\'s reading, the queue and the jobs, and sends a person\'s actions', async () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString()
  const named = (id: string, title: string) => ({ id, title })
  server.schedule = {
    holder: { kind: 'agent', purpose: 'test', note: 'Game.Smoke.Jump', since: at, expiresAt: new Date(Date.now() + 600_000).toISOString(),
      tickets: [named('t5aaaaaaaaaa', '补跳跃测试')], draining: null },
    queue: [
      { id: 'q1', position: 1, purpose: 'build', note: '', at, person: false, front: false, tickets: [named('t6', '冲刺停止动画')], jobId: 'j1' },
      { id: 'q2', position: 2, purpose: 'use', note: 'PIE 看落地', at, person: false, front: false, tickets: [named('t7', '落地动画')] },
    ],
    jobs: [{ id: 'j1', kind: 'build', ticketIds: ['t6', 't8'], directory: 'E:/sun', state: 'queued', createdAt: at,
      tickets: [named('t6', '冲刺停止动画'), named('t8', '闪避停止')] }],
    events: [], blocked: null, yielded: false,
    engine: { source: 'status.json', phase: 'ready', pid: 1, ticking: true, stalledSeconds: 0, slowTask: null, modal: null,
      compiling: { shaders: 0, assets: 0 }, handler: { method: 'run_automation_tests', elapsedSeconds: 42 }, writtenAt: at, stale: false,
      bridges: [{ pid: 1, port: 51240, state: 'listening', startedAt: at }], summary: { tone: 'busy', text: 'run_automation_tests 42s' } },
  }
  await mount()
  await openEditor()
  const card = document.querySelector('.dt-editor-schedule')!
  expect(card.getAttribute('data-holder')).toBe('agent')
  expect(card.querySelector('.dt-editor-schedule-holder')?.textContent).toMatch(/^补跳跃测试 正在跑测试 · \d\d:\d\d 起$/)
  expect(card.querySelector('.dt-editor-engine')?.textContent).toContain('run_automation_tests 42s')
  expect(card.querySelector('.dt-editor-engine')?.textContent).toContain('1 个桥在线')
  expect(all('.dt-editor-queue-item').map(item => item.querySelector('.dt-editor-run-head')?.textContent))
    .toEqual(['冲刺停止动画编译', '落地动画用编辑器'])
  expect(document.querySelector('.dt-editor-job')?.textContent).toContain('合并 2 单')
  await click('插到最前')
  await click('请它让出')
  await click('我要用')
  expect(server.requests.filter(request => request.path === 'editor/act').map(request => request.body)).toEqual([
    { action: 'front', id: 'q2' }, { action: 'preempt', reason: '人在概览上要求让出' }, { action: 'claim' }])
  expect(document.querySelector('.dt-editor-foot')?.textContent).toContain('不会关掉任何编辑器')
})

it('offers to let agents use an open editor while a person\'s editor holds the queue back', async () => {
  server.schedule = { holder: null, queue: [], jobs: [], events: [], blocked: 'editor', yielded: false, engine: null }
  await mount()
  await openEditor()
  expect(document.querySelector('.dt-editor-schedule-holder')?.textContent).toBe('你开着编辑器，agent 不会动它')
  await click('让 agent 用')
  expect(server.requests.filter(request => request.path === 'editor/act').map(request => request.body)).toEqual([{ action: 'yield' }])
})
