// @vitest-environment jsdom
// The Execution status, a Ticket, and the Execution settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: '执行中的工单', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' },
      value: { zh: '已开启', en: 'on' } } } }] })]
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7自动合并已开启')
  await click(zh.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  expect(text()).toContain('执行器结束了当前回合')
  await click(zh['ticket.ended'])
  expect(text()).toContain('旧工单')
  expect(text()).toContain(zh['outcome.stopped'])
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2', '排队 0'])
  // The pause is its own action: an Execution settings draft started before it still saves.
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(tab(zh['tab.execution']))
  await click(zh.pauseProcessing)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  expect(text()).toContain(zh.processingPaused)
  expect(find(zh.resumeProcessing).textContent).toBe(zh.resumeProcessing)
  await click(tab(zh['tab.settings']))
  await click(zh.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
})

it('reads the execution history from the Ticket own records', async () => {
  await mount()
  await click(all('.dt-deck-card-title').find(title => title.textContent === '修复回归')!)
  expect(all('.dt-history-title').map(item => item.textContent)).toEqual(['创建工单', '第 1 次派工', '第 1 次派工 · 进展',
    'Alice · 顺便改标题', '策略变更'])
  expect(all('.dt-history-item').map(item => item.dataset.state)).toEqual(['idle', 'ongoing', 'ongoing', 'warning', 'done'])
  expect(text()).toContain('顺便改标题')
  expect(text()).toContain('working')
})

it('stops an open Ticket from its page after confirmation', async () => {
  await mount()
  await click('修复回归')
  await click(zh.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止“修复回归”')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  await mount()
  await click(all('.dt-deck-card-title').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  // Progress is in the Channels and the Session, so the page has no report section.
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['执行过程', '授权详情', '未送达的输入', '订阅的线程'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(zh.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(zh.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['授权 明确', '发起 飞书 · Alice', expect.stringMatching(/^更新 /)])
  for (const expected of ['修复登录页回归', '点名方式@ 智能体', '名单里的人明确请求，由主 Session 接单', '未送达：等待派工运行',
    'Alice：顺便改标题']) expect(text()).toContain(expected)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('飞书团队群')
  await click(zh['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['飞书消息',
    'feishu://applink/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  await click(zh['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('decides a waiting plan on the Ticket page, with the evidence behind its own fold', async () => {
  const planText = ['现象：翻页闪一下', '代码线：AvatarList.cpp:42 — 复用控件时清空了纹理', '资产线：已排除', '配置线：已排除',
    '修复锚点：AvatarList.cpp 清空纹理；补回复用时的重置', '影响面：只影响列表', '验证方案：基线 3 例 → 改后 3 例', '预算：约 20 分钟'].join('\n')
  const lines = planText.split('\n').map(line => { const at = line.indexOf('：'); return { label: line.slice(0, at), text: line.slice(at + 1) } })
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, plan: { text: planText, lines, at: '2026-09-22T00:05:00Z', waiting: true,
    deadline: '2026-09-23T00:05:00Z' }, attention: { id: 'q1', question: 'P1 方案待确认：回 1 通过 ｜ 回 2 换方向 ｜ 回 3 停' } }
  await mount()
  await click('修复回归')
  // The decision leads; the card's chat protocol is not repeated in the panel.
  expect(text()).toContain('方案待确认')
  expect(text()).toContain('翻页闪一下')
  // The gate says what approval does, like a question that states its next step.
  expect(text()).toContain('通过后')
  expect(text()).toContain('不会 submit')
  // The card lists the files the plan would touch, with the plan's own sentence about each.
  expect(all('.dt-plan-files li code').map(item => item.textContent)).toEqual(['AvatarList.cpp'])
  expect(all('.dt-plan-file-note').map(item => item.textContent)).toEqual(['AvatarList.cpp 清空纹理'])
  await click(document.querySelector<HTMLButtonElement>('.dt-plan-file')!)
  expect(all('.dt-plan-file-points li').map(item => item.textContent)).toEqual(['AvatarList.cpp 清空纹理'])
  expect(all('.dt-plan-points li').map(item => item.textContent)).toContain('补回复用时的重置')
  expect(text()).not.toContain('回 1 通过')
  // The code line is evidence, so it is absent until its fold opens.
  expect(text()).not.toContain('AvatarList.cpp:42')
  await click(zh.planEvidence)
  expect(text()).toContain('AvatarList.cpp:42')
  await click(zh.planApprove)
  expect(server.requests.find(request => request.path === 'tickets/t1/plan')).toMatchObject({ method: 'POST', body: { decision: 'approve' } })
  await click(zh.planRevise)
  const area = document.querySelector<HTMLTextAreaElement>('.dt-plan textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), 'value')!.set!.call(area, '走 B，先上工具链')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(zh.planSubmitRevise)
  expect(server.requests.filter(request => request.path === 'tickets/t1/plan').at(-1)).toMatchObject({ method: 'POST',
    body: { decision: 'revise', note: '走 B，先上工具链' } })
})

it('copies the worker Session id from the Ticket page', async () => {
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  await mount()
  await click('修复回归')
  await click(document.querySelector<HTMLButtonElement>(`button[title="${zh.copySession}"]`)!)
  expect(writes).toEqual([server.ticketDetails.t1!.sessionId])
  expect(text()).toContain(zh.copied)
})

it('shows the text of a note the orchestrator delivered, not only that one arrived', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, inputs: [{ id: 'i9', kind: 'text',
    text: '人已通过 P1 方案（面板）。进入实现阶段：可以改文件。', at: '2026-09-22T00:07:00Z', delivered: true }] }
  await mount()
  await click(all('.dt-deck-card-title').find(button => button.textContent === '修复回归')!)
  expect(text()).toContain('人已通过 P1 方案（面板）')
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(zh.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', reply: t1.channels[0],
    attention: { id: 'q1', question: '需要确认按钮颜色' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  await mount()
  await click(all('.dt-deck-card-title').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'feishu://applink/client/chat/open?openChatId=oc_1']])
  await click('已送达的输入 · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['自动通知：CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  await click('同一发送者之前还有 1 条自动消息')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('到期后记为未完成')
  const tip = field(zh.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('到期后记为未完成')
  expect(tip.closest('.dt-field')!.textContent).not.toContain('到期后记为未完成')
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('opens the Feishu question from the Ticket banner through the client scheme, without a browser tab', async () => {
  const url = 'feishu://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=9'
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' },
    reply: { source: 'feishu', url, label: { zh: '飞书消息', en: 'Feishu message' } } }
  await mount()
  await click(all('.dt-deck-card-title').find(button => button.textContent === '修复回归')!)
  const link = all('.dt-banner a')[0]!
  expect(link.getAttribute('href')).toBe(url)
  expect(link.hasAttribute('target')).toBe(false)
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['打开 GitHub 原文',
    'https://github.com/acme/widgets/pull/42']])
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const blocked = () => field<HTMLInputElement>(zh.blockedCommands), root = () => field<HTMLInputElement>(zh.executionDirectory),
    workers = () => field<HTMLInputElement>(zh.maxWorkers)
  // A separator typed before the next command, a space inside a path and a cleared number stay as typed.
  await type(blocked(), 'gh-personal ')
  expect(blocked().value).toBe('gh-personal ')
  await type(blocked(), 'gh-personal, gh-other')
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work ', maxWorkers: 2 } })
  expect(server.settings.executor).toMatchObject({ blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work', maxWorkers: 2 })
})

it('says why an Input was not delivered on its Ticket\'s page, in either language', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${zh.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(zh.inputRetryHint)
  expect(text()).not.toContain(zh.inputWaitingHint)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/9月\d+日/)
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.ticketNotFound)
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(zh.ticketNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(zh.threadNotFound)
  expect(text()).toContain(zh.hostNotRunning)
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: '评审机器人',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 相关 Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: { zh: 'Alice', en: 'Alice' } }, human: true, preview: '顺便加一个页面',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[zh['basis.sender'], '评审机器人'], [zh['basis.bot'], zh.yes], [zh['basis.mode'], zh['mode.auto']]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, zh.contextOnly])
  await click(zh.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('已交回评估：Asks for a new page')
  await remount(en)
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.bot'], en.yes]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  const fields = { id: 't3', title: '已合并的工单', state: 'ended' as const, actions: { retry: false, stop: false, confirm: false, verify: false, rework: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticket.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([zh['outcome.merged'], zh['outcome.stopped']])
  await click('已合并的工单')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['outcome.merged'])
  expect(text()).toContain(zh['outcome.merged'])
  expect(text()).not.toContain('执行器结束')
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: '不需要了' } }
  await remount(en)
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: 不需要了$/)
})

it('shows delivered work waiting for a person\'s local verification, with the worker evidence and both ways out', async () => {
  const detail = { ...server.ticketDetails.t1!, id: 't8', title: '修复移动普攻后接 Q 技能无法起飞', stage: 'person' as const,
    action: 'verify' as const, summary: 'CL 123456 已 shelve，等你在本地 PIE 里验证。',
    verification: { at: '2026-09-23T00:00:00Z', state: 'pending' as const },
    actions: { retry: false, stop: true, confirm: true, verify: true, rework: true },
    delivery: { lease: ['Source/Game/Player/'], changelist: 123456, review: 'Swarm 654321',
      verification: 'Compile Result: Succeeded; Automation 19/19 passed' } }
  server.ticketDetails.t8 = detail
  at({ page: 'execution', id: 't8' })
  await mount()
  expect(text()).toContain(zh.verifyGateTitle)
  expect(all('.dt-verify-gate-facts')[0]?.textContent).toContain('CL123456')
  expect(document.querySelector('.dt-verify-gate-evidence')?.textContent).toContain('Compile Result: Succeeded; Automation 19/19 passed')
  await click(find(zh.verifyPass, '.dt-verify-gate-foot button'))
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t8/verify' && request.method === 'POST')).toBe(true)

  await click(find(zh.verifyReturn, '.dt-verify-gate-foot button'))
  await type(document.querySelector('#dt-verify-rework') as HTMLTextAreaElement, 'PIE 里 Q 技能仍然会卡住')
  await click(zh.verifyReturnSubmit)
  expect(server.requests.some(request => request.path === 'tickets/t8/rework' && request.method === 'POST'
    && JSON.stringify(request.body).includes('PIE 里 Q 技能仍然会卡住'))).toBe(true)
})

it('renders a blocked report as paragraphs and a list instead of one collapsed line', async () => {
  const base = server.ticketDetails.t1!
  const summary = 'P1 阶段报 blocked：目标不是这个工作区映射的 //sun/mainline，需要改派到 git 通道。\n\n'
    + '【阻塞证据（只读）】\n1) p4 client dsh-pipeline-pending-state 实际不存在。\n2) depot 里没有 superagent 源码。\n\n'
    + '【需要的动作】\n把本单改派到 git。'
  server.ticketDetails.t12 = { ...base, id: 't12', title: '阻塞报告单', stage: 'person' as const, action: 'blocked' as const,
    actions: { retry: true, stop: true, confirm: false, verify: false, rework: false }, verification: undefined, summary }
  at({ page: 'execution', id: 't12' })
  await mount()
  const report = document.querySelector('.dt-report[data-tone="warning"]')!
  expect(report.querySelector('.dt-report-head')?.textContent).toBe(zh.blockedPrefix)
  expect(all('.dt-report .dt-md > p').length).toBe(4)
  expect(all('.dt-report .dt-md > ol > li').map(item => item.textContent)).toEqual([
    'p4 client dsh-pipeline-pending-state 实际不存在。', 'depot 里没有 superagent 源码。'])
  expect(report.textContent).toContain('【需要的动作】')
  // A worker error keeps the monospace banner: its text must stay recognisable, not be reflowed as prose.
  server.ticketDetails.t12 = { ...server.ticketDetails.t12, action: 'failed' as const,
    summary: 'LlmError: no adapter registered for provider "provider-a"' }
  await remount()
  expect(document.querySelector('.dt-banner.dt-danger.dt-mono')?.textContent)
    .toBe(`${zh.failedPrefix}LlmError: no adapter registered for provider "provider-a"`)
})

it('shows the pipeline gate with the last check and clears a blocker on the ticket page', async () => {
  const base = server.ticketDetails.t1!
  server.ticketDetails.t11 = { ...base, id: 't11', title: '流水线阻塞单', stage: 'pipeline' as const, action: 'blocked' as const,
    actions: { retry: false, stop: false, confirm: false, verify: false, rework: false },
    verification: { at: '2026-09-23T00:00:00Z', state: 'passed' as const, by: 'person' as const },
    pipeline: { state: 'blocked' as const, at: '2026-09-23T00:00:00Z', reason: 'P4_Check 缺少 TAPD 单号',
      url: 'https://swarm.example/reviews/9', check: 'Entry 失败: no TAPD id' },
    delivery: { lease: [], changelist: 9001, review: '9' } }
  at({ page: 'execution', id: 't11' })
  await mount()
  expect(text()).toContain(zh.pipelineGateBlockedTitle)
  expect(document.querySelector('.dt-pipeline-gate-reason')?.textContent).toBe('P4_Check 缺少 TAPD 单号')
  expect(text()).toContain('Entry 失败: no TAPD id')
  expect(document.querySelector('.dt-pipeline-gate-facts a')?.getAttribute('href')).toBe('https://swarm.example/reviews/9')
  await click(find(zh.pipelineResume, '.dt-pipeline-gate-foot button'))
  expect(server.requests.some(request => request.path === 'tickets/t11/pipeline/check' && request.method === 'POST')).toBe(true)
})

it('shows a historical delivery as a backfill with concrete checks, not a generic pass template', async () => {
  const base = server.ticketDetails.t1!
  server.ticketDetails.t9 = { ...base, id: 't9', title: '历史交付单', state: 'ended' as const, stage: 'ended' as const,
    ended: { at: '2026-09-22T20:00:00Z', by: 'executor' as const, outcome: 'completed' as const },
    actions: { retry: false, stop: false, confirm: false, verify: true, rework: false },
    verification: undefined,
    summary: '只改了 Source/Game/Player/Foo.cpp；流水线全绿，本地未编译。',
    delivery: { lease: [], changelist: 123456, review: 'https://review.example.com/reviews/654321/',
      verification: 'Pipeline 11/11 pass；未执行本地编译' } }
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.verifyBackfillTitle)
  expect(text()).toContain(zh.verifyScopeUnknown)
  expect(text()).toContain(zh.verifyNoFilesRecorded)
  expect(text()).toContain(zh.verifyEvidenceNote)
  expect(text()).toContain('Source/Game/Player/Foo.cpp')
  expect(document.querySelector('.dt-verify-gate-facts a')?.getAttribute('href')).toBe('https://review.example.com/reviews/654321/')
  await click(find(zh.verifyBackfillMark, '.dt-verify-gate-foot button'))
  expect(text()).toContain('CL 123456')
  expect(text()).toContain('review 654321')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t9/verify' && request.method === 'POST')).toBe(true)
})

it('does not offer a backfill pass when a historical delivery has nothing concrete to check', async () => {
  const base = server.ticketDetails.t1!
  server.ticketDetails.t10 = { ...base, id: 't10', title: '没有依据的历史单', state: 'ended' as const, stage: 'ended' as const,
    ended: { at: '2026-09-22T20:00:00Z', by: 'executor' as const, outcome: 'completed' as const },
    actions: { retry: false, stop: false, confirm: false, verify: true, rework: false }, verification: undefined,
    delivery: { lease: [] } }
  at({ page: 'execution', id: 't10' })
  await mount()
  expect(text()).toContain(zh.verifyNoBasis)
  expect(all('.dt-verify-gate-foot button').map(button => button.textContent)).not.toContain(zh.verifyBackfillMark)
})

it('sends one stop for a double click on Confirm', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.stop)
  const confirm = find(zh.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
})

