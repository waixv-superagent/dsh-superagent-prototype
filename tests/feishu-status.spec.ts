/** Tests for scripts/feishu-status.mjs: the counts it reads, the card it builds, and send/patch/recreate through a fake CLI. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ago, cardExpired, composeCard, idleMood, runOnce, shortTitle, snapshotOf } from '../scripts/feishu-status.mjs'

const overview = {
  working: [
    { id: 'a', title: '工单 A 正在写状态卡', updatedAt: '2026-11-03T01:58:00.000Z' },
    { id: 'b', title: '工单 B 跑测试', updatedAt: '2026-11-03T01:00:00.000Z' },
  ],
  verification: [
    { id: 'c', title: '工单 C', action: 'verify', updatedAt: '2026-11-02T18:00:00.000Z' },
    { id: 'd', title: '工单 D', action: 'verify', updatedAt: '2026-11-02T17:00:00.000Z' },
    { id: 'e', title: '工单 E', action: 'verify', updatedAt: '2026-11-02T16:00:00.000Z' },
    { id: 'f', title: '工单 F', action: 'verify', updatedAt: '2026-11-02T15:00:00.000Z' },
  ],
  person: [
    { id: 'g', title: '工单 G 卡住了', action: 'blocked', updatedAt: '2026-11-03T00:30:00.000Z' },
    { id: 'h', title: '工单 H', action: 'confirm', updatedAt: '2026-11-03T00:00:00.000Z' },
    { id: 'i', title: '工单 I', action: 'confirm', updatedAt: '2026-11-02T23:00:00.000Z' },
    { id: 'j', title: '工单 J', action: 'confirm', updatedAt: '2026-11-02T22:00:00.000Z' },
    { id: 'k', title: '工单 K', action: 'confirm', updatedAt: '2026-11-02T21:00:00.000Z' },
  ],
  pipeline: [{ id: 'l', title: '工单 L 待提交', action: 'blocked', pipeline: { manual: true, at: '2026-11-02T15:00:00.000Z' }, updatedAt: '2026-11-02T15:00:00.000Z' }],
  idle: [{ id: 'm', title: '工单 M' }],
  problems: [],
  executor: { running: 3, queued: 0, maxWorkers: 5 },
}
const runtime = { paused: false, health: { runtime: { state: 'ready' } }, setup: { problem: null, feishuProblem: null } }
const snapshot = snapshotOf(overview, runtime)
const at = new Date(2026, 10, 3, 10, 0, 0)
const CHAT = 'oc_test_chat'

interface Harness {
  directory: string
  stateFile: string
  calls: string[][]
  lark: (args: string[]) => Promise<unknown>
  fetcher: (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
  runtimeState: unknown
  failOverview: boolean
  failPatch: boolean
  patchError: string
}

const harnesses: Harness[] = []
function harness (): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'feishu status '))
  const stateFile = join(directory, 'state.json')
  const calls: string[][] = []
  let sent = 0
  const state: Harness = {
    directory,
    stateFile,
    calls,
    failOverview: false,
    failPatch: false,
    patchError: '',
    runtimeState: runtime,
    lark: async (args) => {
      calls.push(args)
      if (args[0] === 'im' && args[1] === '+messages-send') {
        sent += 1
        return { ok: true, data: { message_id: `om_test_${sent}` } }
      }
      if (args[0] === 'api' && args[1] === 'PATCH' && state.failPatch) throw new Error(state.patchError)
      return { ok: true, data: {} }
    },
    fetcher: async (url) => {
      if (state.failOverview) throw new Error('ECONNREFUSED')
      return { ok: true, json: async () => url.endsWith('/overview') ? overview : state.runtimeState }
    },
  }
  harnesses.push(state)
  return state
}
afterEach(() => {
  for (const item of harnesses.splice(0)) rmSync(item.directory, { recursive: true, force: true })
})

const argAt = (args: string[], flag: string): string => {
  const index = args.indexOf(flag)
  return index < 0 ? '' : args[index + 1] ?? ''
}
const cardOf = (args: string[]): Record<string, unknown> => JSON.parse(argAt(args, '--content')) as Record<string, unknown>
const dataOf = (args: string[]): Record<string, unknown> => JSON.parse(argAt(args, '--data')) as Record<string, unknown>
const run = (h: Harness, now: Date) => runOnce({ chat: CHAT, panelUrl: 'http://127.0.0.1:9',
  stateFile: h.stateFile, lark: h.lark, fetchImpl: h.fetcher, now, log: () => {} })

describe('snapshotOf', () => {
  it('counts the three lanes the person asked for and the executor load', () => {
    expect(snapshot.counts).toEqual({ working: 2, verification: 4, person: 5, pipeline: 1, idle: 1 })
    expect(snapshot.executor).toEqual({ running: 3, queued: 0, maxWorkers: 5 })
    expect(snapshot.online).toBe(true)
  })

  it('treats a missing overview lane as zero instead of throwing', () => {
    expect(snapshotOf({}, {}).counts).toEqual({ working: 0, verification: 0, person: 0, pipeline: 0, idle: 0 })
  })
})

describe('composeCard', () => {
  it('shows all three counts, the ticket detail, and the dashboard link', () => {
    const view = composeCard(snapshot, { now: at, lastOkAt: at.toISOString() })
    expect(view.template).toBe('orange')
    expect(view.title).toContain('5 件等你拍板')
    expect(view.summary).toContain('在跑 2 · 待验证 4 · 待拍板 5')
    const body = view.card.body as { elements: { tag: string; expanded?: boolean; columns?: { elements: { content: string }[] }[]; content?: string }[] }
    const columns = body.elements[0]!.columns!
    expect(columns[0]!.elements[0]!.content).toContain('2')
    expect(columns[0]!.elements[1]!.content).toContain('执行中')
    expect(columns[1]!.elements[0]!.content).toContain('4')
    expect(columns[2]!.elements[0]!.content).toContain('5')
    expect(columns[2]!.elements[1]!.content).toContain('待拍板')
    const panel = body.elements[1]!
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    const detail = JSON.stringify(panel)
    expect(detail).toContain('工单明细 · 12 件')
    expect(detail).toContain('工单 A 正在写状态卡')
    expect(detail).toContain('工单 G 卡住了')
    expect(detail).toContain('阻塞')
    expect(detail).toContain('待提交')
    expect(body.elements[2]!.content).toContain('执行器 3/5')
    expect((view.card.config as { update_multi: boolean; width_mode: string }).update_multi).toBe(true)
    expect((view.card.config as { width_mode: string }).width_mode).toBe('compact')
    const linked = composeCard(snapshot, { now: at, link: 'https://example.com/?view=board' })
    expect((linked.card as { card_link: { url: string } }).card_link.url).toBe('https://example.com/?view=board')
    expect((view.card as { card_link?: unknown }).card_link).toBeUndefined()
  })

  it('turns blue while work runs and green when idle', () => {
    const working = snapshotOf({ ...overview, person: [], verification: [], pipeline: [] }, runtime)
    expect(composeCard(working, { now: at }).template).toBe('blue')
    const idle = snapshotOf({ ...overview, person: [], verification: [], working: [], pipeline: [], executor: { running: 0, queued: 0, maxWorkers: 5 } }, runtime)
    const view = composeCard(idle, { now: at })
    expect(view.template).toBe('green')
    expect(view.title).toContain(idleMood(at))
  })

  it('turns red and hides the stale numbers when the service does not answer', () => {
    const offline = { ...snapshot, online: false, counts: null, executor: null }
    const view = composeCard(offline, { now: at, lastOkAt: '2026-11-03T01:55:00.000Z' })
    expect(view.template).toBe('red')
    expect(view.title).toContain('掉线')
    const body = view.card.body as { elements: { tag: string; columns?: { elements: { content: string }[] }[]; content?: string }[] }
    const numbers = body.elements[0]!.columns!.map(column => column.elements[0]!.content)
    expect(numbers.every(content => content.includes('—'))).toBe(true)
    expect((view.card.header as { subtitle?: { content: string } }).subtitle?.content).toContain('最后心跳')
    expect(body.elements[1]!.content).toContain('主机服务没响应')
    // A dead panel has no trustworthy tickets, so the detail fold stays out of the red card.
    expect(body.elements.some(element => element.tag === 'collapsible_panel')).toBe(false)
    expect(view.title).not.toMatch(/[<>]/)
  })

  it('turns orange when paused or when setup reports a problem', () => {
    expect(composeCard({ ...snapshot, paused: true }, { now: at }).template).toBe('orange')
    expect(composeCard({ ...snapshot, setupProblem: true }, { now: at }).title).toContain('问题')
  })

  it('says a model-gateway outage is being recovered, and asks for a person when the retries stopped', () => {
    const recovering = snapshotOf(overview, { ...runtime, watchdog: { recovering: true, tickets: 2, master: true, gaveUp: false, missing: false } })
    const view = composeCard(recovering, { now: at })
    expect(view.template).toBe('orange')
    expect(view.title).toContain('自动恢复中')
    expect(view.summary).toContain('自动恢复中')
    const note = ((view.card.body as { elements: { content?: string }[] }).elements.at(-1)!)
    expect(note.content).toContain('模型上游断连')
    expect(note.content).toContain('2 张工单待恢复')
    expect(note.content).toContain('主会话自动续跑')
    const stopped = snapshotOf(overview, { ...runtime, watchdog: { recovering: false, tickets: 0, master: false, gaveUp: true, missing: false } })
    const red = composeCard(stopped, { now: at })
    expect(red.template).toBe('red')
    expect(red.title).toContain('自动恢复已停止')
    expect(((red.card.body as { elements: { content?: string }[] }).elements.at(-1)!).content).toContain('人工处理')
    const missing = snapshotOf(overview, { ...runtime, watchdog: { recovering: false, tickets: 0, master: false, gaveUp: false, missing: true } })
    expect(composeCard(missing, { now: at }).title).toContain('正在重建')
    // A state API without the field keeps the card it had before the watchdog reported one.
    expect(snapshotOf(overview, runtime).watchdog).toBeNull()
  })
})

describe('ago', () => {
  it('reads as a short relative time for a phone glance', () => {
    expect(ago(new Date(2026, 10, 3, 10, 0, 0), at)).toBe('刚刚')
    expect(ago(new Date(2026, 10, 3, 9, 55, 0), at)).toBe('5 分钟前')
    expect(ago(new Date(2026, 10, 3, 8, 0, 0), at)).toBe('2 小时前')
    expect(ago(new Date(2026, 10, 2, 10, 0, 0), at)).toBe('昨天')
    expect(ago(new Date(2026, 9, 20, 10, 0, 0), at)).toBe('2 周前')
    expect(ago('not a date', at)).toBe('')
  })
})

describe('shortTitle', () => {
  it('keeps a detail row on one line', () => {
    expect(shortTitle('短标题')).toBe('短标题')
    expect(shortTitle('一'.repeat(40))).toHaveLength(27)
    expect(shortTitle('a\nb')).toBe('a b')
  })
})

describe('idleMood', () => {
  it('uses lunch and night phrases at those hours', () => {
    expect(idleMood(new Date(2026, 10, 3, 12, 0, 0))).toBe('吃饭饭')
    expect(idleMood(new Date(2026, 10, 3, 23, 30, 0))).toBe('打盹中')
    expect(idleMood(new Date(2026, 10, 3, 10, 0, 0))).toBe('甩尾巴中')
  })
})

describe('cardExpired', () => {
  it('replaces a card before the 14-day update window closes', () => {
    const now = new Date('2026-11-03T02:00:00.000Z')
    expect(cardExpired('2026-10-20T02:00:00.000Z', now)).toBe(true)
    expect(cardExpired('2026-10-22T02:00:00.000Z', now)).toBe(false)
    expect(cardExpired(undefined, now)).toBe(true)
  })
})

describe('runOnce', () => {
  it('sends and pins the first card, then updates it in place', async () => {
    const h = harness()
    const first = await run(h, at)
    expect(first.action).toBe('sent')
    expect(h.calls.map(args => args[1])).toEqual(['+messages-send', 'POST'])
    const sent = cardOf(h.calls[0]!)
    const sentBody = sent.body as { elements: { columns?: { elements: { content: string }[] }[] }[] }
    expect(sentBody.elements[0]!.columns![0]!.elements[0]!.content).toContain('2')
    expect(sentBody.elements[0]!.columns![2]!.elements[0]!.content).toContain('5')
    expect(dataOf(h.calls[1]!)).toEqual({ message_id: 'om_test_1' })
    const saved = JSON.parse(readFileSync(h.stateFile, 'utf8'))
    expect(saved).toMatchObject({ chatId: CHAT, messageId: 'om_test_1', pinned: true })

    const second = await run(h, new Date(2026, 10, 3, 10, 1, 0))
    expect(second.action).toBe('patched')
    expect(h.calls.length).toBe(3)
    const patch = h.calls[2]!
    expect(patch.slice(0, 4)).toEqual(['api', 'PATCH', '/open-apis/im/v1/messages/om_test_1', '--data'])
    const patched = JSON.parse(dataOf(patch).content as string)
    expect(JSON.stringify(patched)).toContain('执行器 3/5')
  })

  it('puts the dashboard link on the sent card', async () => {
    const h = harness()
    await runOnce({ chat: CHAT, panelUrl: 'http://127.0.0.1:9', stateFile: h.stateFile,
      lark: h.lark, fetchImpl: h.fetcher, now: at, link: 'https://example.com/?view=board' })
    const sent = cardOf(h.calls[0]!)
    expect((sent as { card_link: { url: string } }).card_link.url).toBe('https://example.com/?view=board')
  })

  it('keeps the same card when the service stops answering and paints it red', async () => {
    const h = harness()
    await run(h, at)
    h.failOverview = true
    const result = await run(h, new Date(2026, 10, 3, 10, 2, 0))
    expect(result.action).toBe('patched')
    expect(result.online).toBe(false)
    const patch = h.calls.at(-1)!
    const content = JSON.parse(dataOf(patch).content as string)
    const header = content.header as { template: string; subtitle: { content: string } }
    expect(header.template).toBe('red')
    expect(header.subtitle.content).toContain('最后心跳')
  })

  it('patches the card to the recovery state while the watchdog retries a model outage', async () => {
    const h = harness()
    await run(h, at)
    h.runtimeState = { ...runtime, watchdog: { recovering: true, tickets: 1, master: true, gaveUp: false, missing: false } }
    const result = await run(h, new Date(2026, 10, 3, 10, 1, 0))
    expect(result.action).toBe('patched')
    const patched = JSON.parse(dataOf(h.calls.at(-1)!).content as string) as { header: { title: { content: string } }; config: { summary: { content: string } } }
    expect(patched.header.title.content).toContain('自动恢复中')
    expect(patched.config.summary.content).toContain('自动恢复中')
  })

  it('retires an old card and sends a new one once it is 13 days old', async () => {
    const h = harness()
    await run(h, at)
    const saved = JSON.parse(readFileSync(h.stateFile, 'utf8'))
    saved.sentAt = new Date(2026, 9, 20, 10, 0, 0).toISOString()
    writeFileSync(h.stateFile, JSON.stringify(saved))
    const result = await run(h, at)
    expect(result.action).toBe('sent')
    expect(result.messageId).toBe('om_test_2')
    const expired = h.calls.find(args => args[1] === 'PATCH' && args[2] === '/open-apis/im/v1/messages/om_test_1')
    expect(expired).toBeDefined()
    expect(((JSON.parse(dataOf(expired!).content as string)).header as { template: string }).template).toBe('grey')
    expect(h.calls.some(args => args[0] === 'im' && args[1] === '+messages-send')).toBe(true)
  })

  it('sends a new card when the old message was deleted', async () => {
    const h = harness()
    await run(h, at)
    h.failPatch = true
    h.patchError = '230011 message not found'
    const result = await run(h, new Date(2026, 10, 3, 10, 2, 0))
    expect(result.action).toBe('sent')
    expect(result.messageId).toBe('om_test_2')
  })

  it('does nothing while another run holds the lock', async () => {
    const h = harness()
    writeFileSync(`${h.stateFile}.lock`, '{}')
    expect(await run(h, at)).toEqual({ action: 'locked' })
    expect(h.calls).toEqual([])
  })

  it('prints the card without calling the CLI', async () => {
    const h = harness()
    const result = await runOnce({ chat: CHAT, panelUrl: 'http://127.0.0.1:9', stateFile: h.stateFile,
      lark: h.lark, fetchImpl: h.fetcher, now: at, print: true })
    expect(result.action).toBe('print')
    expect(result.card).toBeDefined()
    expect(h.calls).toEqual([])
  })
})
