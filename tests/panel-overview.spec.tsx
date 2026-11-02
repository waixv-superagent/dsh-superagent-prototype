// @vitest-environment jsdom
// The overview: the duty desk.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, at, find, field, settle, tab, click, text, type } from './fixtures/panel.tsx'
import { server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'

usePanel()
/** The first tab is the editor view now; these cases exercise the board, so switch to it explicitly. */
const openOverview = async (dictionary = zh) => {
  const top = tab(dictionary['tab.editor'])
  if (top.getAttribute('aria-selected') !== 'true') await click(top)
  const item = tab(dictionary.homeViewBoard)
  if (item.getAttribute('aria-selected') !== 'true') await click(item)
}
it('leads with a verdict and a five-lane board: decisions, verification, pipeline, running work and recently ended Tickets', async () => {
  await mount()
  await openOverview()
  expect(tab(zh.homeViewBoard).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-tabs [role="tab"]').map(tab => tab.textContent)).toEqual(['概览', '来源', '触发', '评估', '执行', '设置'])
  expect(document.querySelector('.dt-verdict-title')?.textContent).toBe('2件等你验证·2件等你决定')
  expect(document.querySelector('.dt-verdict-sub')?.textContent).toContain('2 件在跑')
  expect(document.querySelector('.dt-verdict-sub')?.textContent).toContain('最久的交付已经等了')
  // The editor row sits under the verdict, before the lanes: it is the one fact an agent must read before it builds.
  expect(document.querySelector('.dt-editor-line')?.getAttribute('data-holder')).toBe('person')
  expect(document.querySelector('.dt-editor-line')?.textContent).toContain('编辑器：你正在用')
  expect(all('.dt-figure').map(figure => figure.textContent)).toEqual(['今日到达12', '已评估5', '接单1', '执行中2 / 3'])
  expect(all('.dt-board-col-title').map(title => title.textContent)).toEqual(['待你决定', '正在跑', '待你验证', '流水线', '最近结束'])
  expect(all('.dt-board-col-count').map(count => count.textContent)).toEqual(['2', '2', '2', '0', '1'])
  expect(all('.dt-deck-card-title').map(title => title.textContent)).toEqual(['修复回归', '截图工具'])
  expect(all('.dt-deck-card-kind').map(kind => kind.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-deck-card-body').map(body => body.textContent)).toEqual(['需要确认按钮颜色',
    'LlmError: no adapter registered for provider "provider-a"'])
  expect(all('.dt-verify-title').map(title => title.textContent)).toEqual(['修复移动普攻后接 Q 技能无法起飞', 'README 更新'])
  expect(all('.dt-verify-cl').map(item => item.textContent)).toEqual(['CL 123456', 'CL 123456'])
  expect(document.querySelector('.dt-backlog-line')?.textContent).toBe('1 张历史交付待补验')
  expect(all('.dt-run-title').map(title => title.textContent)).toEqual(['补 i18n 文案', '升级依赖'])
  expect(all('.dt-ended2-title').map(title => title.textContent)).toEqual(['旧工单'])
  expect(all('.dt-ended2-outcome').map(outcome => outcome.textContent)).toEqual(['人工停止'])
  expect(all('.dt-ended2-meta .dt-tag')).toEqual([])
  // The historical delivery keeps only the pass action; there is no worker turn left to send it back to.
  expect(all('.dt-verify-card')[1]!.querySelectorAll('.dt-verify-foot button').length).toBe(2)
})

it('rings the lane a stored count focus names when the board is opened cold', async () => {
  at({ page: 'editor', query: { view: 'board', focus: 'verification' } })
  await mount()
  expect(tab(zh.homeViewBoard).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-verdict')).not.toBeNull()
  expect(all('.dt-verify-card[data-board-focus]')).toHaveLength(2)
  expect(all('[data-board-focus]')).toHaveLength(2)
})

it('shows the editor row in each state, keeping an unreadable probe on the safe side', async () => {
  server.editor = { holder: 'none', activity: 'unknown', since: null, pid: null, at: '2026-09-22T08:10:00.000Z' }
  await mount()
  expect(document.querySelector('.dt-editor-line')?.getAttribute('data-holder')).toBe('none')
  expect(document.querySelector('.dt-editor-line')?.textContent).toContain('编辑器：空着')

  server.editor = { holder: 'agent', activity: 'building', since: new Date(Date.now() - 3_600_000).toISOString(), pid: 2,
    at: '2026-09-22T08:10:00.000Z' }
  await remount()
  expect(document.querySelector('.dt-editor-line')?.textContent).toContain('编辑器：agent 在用')
  expect(document.querySelector('.dt-editor-line')?.textContent).toContain('构建中')
  expect(document.querySelector('.dt-editor-line')?.textContent).toContain('起')

  server.editor = { holder: 'unknown', activity: 'unknown', since: null, pid: null, at: '2026-09-22T08:10:00.000Z',
    detail: '读取进程表失败，按人在用' }
  await remount()
  expect(document.querySelector('.dt-editor-line')?.textContent).toContain('编辑器：无法确认，按人在用')

  server.editor = null
  await remount()
  expect(document.querySelector('.dt-editor-line')).toBeNull()
})

it('pins a blocked pipeline at the top of its lane and offers the review and a new follow-up', async () => {
  server.pipeline = [
    ticketSummary({ id: 'p1', title: '流水线阻塞', pipeline: { state: 'blocked', at: '2026-09-23T00:00:00Z', reason: 'P4_Check 缺少 TAPD 单号',
      url: 'https://swarm.example/reviews/9', manual: false, check: 'P4_Check 失败' }, delivery: { lease: [], changelist: 9001 } }, { stage: 'pipeline', action: 'blocked' }),
    ticketSummary({ id: 'p2', title: '流水线在跑', pipeline: { state: 'running', at: '2026-09-23T00:00:00Z', check: 'ClangTidy 已过' },
      delivery: { lease: [], changelist: 9002 } }, { stage: 'pipeline', action: 'running' }),
  ]
  await mount()
  expect(all('.dt-board-col-count')[3]?.textContent).toBe('2')
  const cards = all('.dt-pipeline-card')
  expect(cards.map(card => card.querySelector('.dt-pipeline-title')?.textContent)).toEqual(['流水线阻塞', '流水线在跑'])
  expect(cards[0]!.hasAttribute('data-blocked')).toBe(true)
  expect(cards[0]!.hasAttribute('data-waiting')).toBe(false)
  expect(cards[0]!.querySelector('.dt-tag')?.textContent).toBe(zh.pipelineBlocked)
  expect(cards[0]!.querySelector('.dt-pipeline-chip')?.textContent).toBe('P4_Check 失败')
  expect(cards[0]!.textContent).toContain('P4_Check 缺少 TAPD 单号')
  expect(cards[0]!.querySelector<HTMLAnchorElement>('.dt-pipeline-link')?.href).toBe('https://swarm.example/reviews/9')
  await click(find(zh.pipelineResume, '.dt-pipeline-card button'))
  expect(server.requests.some(request => request.path === 'tickets/p1/pipeline/check' && request.method === 'POST')).toBe(true)
})

it('shows a pipeline that only awaits a person as a gold wait, not a red block', async () => {
  server.pipeline = [
    ticketSummary({ id: 'w1', title: '只差你确认', pipeline: { state: 'blocked', at: '2026-09-23T00:00:00Z',
      reason: '全部 11 项流水线 pass、AI 评审无建议；需要人工审批并 p4 submit', manual: true, check: '11/11 testruns pass',
      url: 'https://swarm.example/reviews/11' }, delivery: { lease: [], changelist: 9003 } }, { stage: 'pipeline', action: 'blocked' }),
  ]
  await mount()
  const card = all('.dt-pipeline-card')[0]!
  expect(card.hasAttribute('data-blocked')).toBe(false)
  expect(card.hasAttribute('data-waiting')).toBe(true)
  expect(card.querySelector('.dt-tag')?.textContent).toBe(zh.pipelineWaiting)
  expect(card.querySelector('.dt-tag')?.getAttribute('data-tone')).toBe('warning')
  expect(card.querySelector('.dt-pipeline-chip')?.textContent).toBe('11/11 testruns pass')
  // Only a real block raises the lane's red intervention alert.
  expect(all('.dt-pipeline-alert')).toHaveLength(0)
  expect(server.misuse).toEqual([])
})

it('finds a Ticket from the Overview and opens it, with the field that matched', async () => {
  server.ticketSearch = () => ({ total: 1, tickets: [{ ticket: ticketSummary(), match: { field: 'changelist', text: 'CL 123456' } }] })
  await mount()
  await type(field<HTMLInputElement>(zh.ticketSearchLabel), '123456')
  await settle()
  expect(all('.dt-finder-row')).toHaveLength(1)
  expect(document.querySelector('.dt-finder-match')?.textContent).toBe('CL · CL 123456')
  await click(all('.dt-finder-row')[0]!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('passes delivered work from its verification card, or sends it back with a note', async () => {
  await mount()
  const card = all('.dt-verify-card')[0]!
  expect(card.querySelector('.dt-checks-summary')).toBeNull()
  expect(card.querySelector('.dt-verify-proof')?.textContent).toContain('Compile Result: Succeeded')
  expect(card.querySelector('.dt-verify-proof')?.textContent).toContain('Automation 19/19 passed')
  await click(find(zh.verifyPass, '.dt-verify-foot button'))
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t8/verify' && request.method === 'POST')).toBe(true)

  await click(find(zh.verifyReturn, '.dt-verify-foot button'))
  const input = all('.dt-verify-return-input')[0] as HTMLTextAreaElement
  await type(input, 'PIE 里 Q 技能仍然会卡住')
  await click(zh.verifyReturnSubmit)
  expect(server.requests.some(request => request.path === 'tickets/t8/rework' && request.method === 'POST'
    && JSON.stringify(request.body).includes('PIE 里 Q 技能仍然会卡住'))).toBe(true)
})

it('labels every verification row with a fixed pill and folds past three rows', async () => {
  const proof = ['Compile Result: Succeeded', 'Automation 1/2 failed', 'P4_Check 未运行',
    'p4 shelve -f -c 581411: 5 个文件 shelve'].join('\n')
  server.verification = [ticketSummary({ id: 'v1', title: '气泡验证', delivery: { lease: [], changelist: 581411,
    review: 'Swarm 1', verification: proof }, verification: { at: '2026-09-23T00:00:00Z', state: 'pending' } },
  { stage: 'person', action: 'verify' })]
  await mount()
  await openOverview()
  const card = all('.dt-verify-card')[0]!
  const rows = () => [...card.querySelectorAll('.dt-checks li')]
  expect(card.querySelector('.dt-checks-summary')?.textContent).toBe('1 已检查 · 1 失败 · 1 没跑 · 1 已确认')
  expect(rows().map(row => row.querySelector('.dt-tag')?.textContent)).toEqual(['已检查', '失败', '没跑'])
  expect(rows().map(row => row.getAttribute('data-state'))).toEqual(['pass', 'fail', 'skip'])
  await click(card.querySelector('.dt-checks-more') as HTMLElement)
  expect(rows()).toHaveLength(4)
  expect(rows()[3]!.querySelector('.dt-tag')?.textContent).toBe('已确认')
  expect(rows()[3]!.getAttribute('data-state')).toBe('note')
  await click(card.querySelector('.dt-checks-more') as HTMLElement)
  expect(rows()).toHaveLength(3)
})

it('answers a question, retries a failure and stops a Ticket from its decision card', async () => {
  await mount()
  await openOverview()
  // The answer card keeps the Channel link and its primary action opens the Ticket.
  expect(all('.dt-deck-card-foot a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  await click(zh.boardAnswer)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  await openOverview()
  await click(find(zh.retry, '.dt-deck-card-foot button'))
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  const failed = all('.dt-deck-card').find(card => card.querySelector('.dt-deck-card-title')?.textContent === '截图工具')!
  await click([...failed.querySelectorAll<HTMLElement>('.dt-deck-card-foot button')].find(button => button.textContent === zh.stop)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
})

it('opens a Ticket from its card title and from the running lane', async () => {
  await mount()
  await openOverview()
  await click('修复回归')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  await openOverview()
  await click('补 i18n 文案')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('补 i18n 文案')
})

it('marks a running Ticket that has not reported for ten minutes, and says which Tickets wait for a Trigger', async () => {  server.working = [ticketSummary({ id: 't5', title: '补 i18n 文案', summary: '第 12 步',
    updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() })]
  server.idle = [ticketSummary({ id: 't8', title: '等新消息', summary: '' }, { stage: 'idle' })]
  await mount()
  await openOverview()
  expect(text()).toContain('31 分钟没有更新，可能卡住')
  expect(all('.dt-run').map(row => row.dataset.state)).toEqual(['working', 'idle'])
  expect(all('.dt-run-title').map(title => title.textContent)).toEqual(['补 i18n 文案', '等新消息'])
})

it('goes quiet when nothing needs a person and nothing is running', async () => {
  server.person = []
  server.verification = []
  server.working = []
  server.idle = []
  server.ended = []
  await mount()
  await openOverview()
  expect(document.querySelector('.dt-verdict-title')?.textContent).toBe('现在没有需要你的事')
  expect(text()).toContain(zh.boardDecisionEmpty)
  expect(text()).toContain(zh.boardVerifyEmpty)
  expect(text()).toContain(zh.boardPipelineEmpty)
  expect(text()).toContain(zh.boardRunningEmpty)
  expect(text()).toContain(zh.boardEndedEmpty)
})

it('links the verdict figures to the records behind them', async () => {
  await mount()
  await openOverview()
  const figures = all('.dt-figure button')
  expect(figures.map(button => button.textContent)).toEqual(['5', '1', '2 / 3'])
  await click(figures[0]!)
  expect(tab(zh['tab.eval']).getAttribute('aria-selected')).toBe('true')
  await openOverview()
  await click(all('.dt-figure button')[2]!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('lists the problems that need a person and lets them requeue or dismiss an unjudged Eval', async () => {
  await mount()
  await openOverview()
  expect(all('.dt-problem-title').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('offers the step that fixes a settings problem, and says the Executor waits for setup', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: {
    feishu: { allowed: [], admission: {} }, github: { allowed: [], admission: {} } } } }
  await mount()
  await openOverview()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('shows the duty desk in English', async () => {
  await mount(en)
  expect(document.querySelector('.dt-verdict-title')?.textContent).toBe('2 to verify·2 waiting on you')
  expect(document.querySelector('.dt-verdict-sub')?.textContent).toContain('2 running')
  expect(all('.dt-board-col-title').map(title => title.textContent)).toEqual(['Needs your decision', 'Running', 'To verify', 'Pipeline', 'Recently ended'])
  expect(all('.dt-deck-card-kind').map(kind => kind.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-deck-card-foot button').map(button => button.textContent)).toContain(en.retry)
  expect(all('.dt-verify-badge').map(badge => badge.textContent)).toEqual([en.verifyWorkerBadge, en.verifyWorkerBadge])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4, error: 'HTTP 502 from GitHub', refused: false }]
  await mount()
  await openOverview()
  const titles = () => all('.dt-problem-title').map(item => item.textContent)
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await openOverview()
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})

it('offers retrying or withdrawing a refused reply, which it confirms first, instead of a retry count', async () => {
  server.failing = [{ id: 'm2', channel: { source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
    text: '全量校准仍保留在「收集&更新」', attempts: 1, error: '--content is not valid JSON', refused: true }]
  await mount()
  expect(all('.dt-problem-title').map(item => item.textContent)).toContain('飞书 拒绝了一条回复的参数，已停止自动重试')
  expect(text()).toContain(zh.problemReplyRefusedHint)
  await click(find(zh.retry, '.dt-problem-actions button'))
  expect(server.requests.some(request => request.method === 'POST' && request.path === 'outbox/m2/retry')).toBe(true)
  await click(find(zh.withdrawReply, '.dt-problem-actions button'))
  expect(server.requests.some(request => request.path === 'outbox/m2/withdraw')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.some(request => request.method === 'POST' && request.path === 'outbox/m2/withdraw')).toBe(true)
  expect(all('.dt-problem-title').map(item => item.textContent)).not.toContain('飞书 拒绝了一条回复的参数，已停止自动重试')
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  await openOverview()
  expect(all('.dt-problem-title').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  await openOverview()
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-deck-card-foot button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
})

it('shows paused processing as a system problem with its resume action', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  await openOverview()
  expect(text()).toContain(zh.problemPaused)
  await click(find(zh.resumeProcessing, '.dt-problem-actions button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})


