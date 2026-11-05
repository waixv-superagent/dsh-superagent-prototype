/** Tests for scripts/daily-metrics.mjs and scripts/daily-retro.mjs: windows, aggregation over a fixture store, session decoding, the ledger, and the report. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMetrics, causeOf, collectChanges, dayWindow, decodeSession, diffMetrics, kindOf, localHour } from '../scripts/daily-metrics.mjs'
import { addCommitment, emptyLedger, hourlyChart, markdown, parseNarrative, reconcile, renderReport, setCommitment } from '../scripts/daily-retro.mjs'

const window = dayWindow('2026-11-04', '+08:00')
let dirs: string[] = []
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = [] })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'retro-')); dirs.push(dir); return dir }

/** An in-memory store with the tables daily-metrics reads. */
function store () {
  const db = new DatabaseSync(':memory:')
  db.exec(`create table ticket (id text primary key, value text not null);
    create table trigger (id text primary key, value text not null, at text not null);
    create table disposition (id text primary key, value text not null);
    create table decision (id text primary key, thread text not null, value text not null);`)
  const put = {
    ticket: (value: Record<string, unknown>) => db.prepare('insert into ticket values (?, ?)').run(value.id as string, JSON.stringify(value)),
    trigger: (value: Record<string, unknown>) => db.prepare('insert into trigger values (?, ?, ?)').run(value.id as string, JSON.stringify(value), value.at as string),
    disposition: (id: string, value: Record<string, unknown>) => db.prepare('insert into disposition values (?, ?)').run(id, JSON.stringify(value)),
    decision: (value: Record<string, unknown>) => db.prepare('insert into decision values (?, ?, ?)').run(value.id as string, 't', JSON.stringify(value)),
  }
  return { db, put }
}

function fixture () {
  const { db, put } = store()
  // 2026-11-04 CST = [11-03T16:00Z, 11-04T16:00Z)
  put.trigger({ id: 'tr1', source: 'feishu', human: true, at: '2026-11-04T06:10:00.000Z' }) // 14 时
  put.trigger({ id: 'tr2', source: 'tapd', human: true, at: '2026-11-04T06:40:00.000Z' })
  put.trigger({ id: 'tr3', source: 'feishu', human: false, at: '2026-11-04T07:00:00.000Z' })
  put.trigger({ id: 'old', source: 'github', human: true, at: '2026-11-03T15:59:59.000Z' }) // 前一天 23:59
  put.disposition('tr1', { fanout: ['a'], evalId: 'e', acked: ['a'], handbacks: [{ ticketId: 'x' }] })
  put.disposition('tr2', { fanout: ['b'], acked: [] })
  put.decision({ id: 'd1', kind: 'accept', at: '2026-11-04T06:10:01.000Z' })
  put.decision({ id: 'd2', kind: 'ignore', at: '2026-11-04T06:11:00.000Z' })
  put.decision({ id: 'd3', kind: 'accept', at: '2026-11-02T06:11:00.000Z' })
  put.ticket({ id: 'aaaaaaaa1111', title: '实现日报导出', createdAt: '2026-11-04T06:10:02.000Z', origin: { triggerId: 'tr1' },
    execution: { target: 'me/repo' }, ended: { outcome: 'merged', at: '2026-11-04T09:00:00.000Z' },
    assignments: [
      { id: 'x1', startedAt: '2026-11-04T06:10:03.000Z', endedAt: '2026-11-04T06:50:00.000Z', endedReason: 'hostRestarted',
        report: { state: 'failed', summary: 'Error 402 Insufficient Balance', at: '2026-11-04T06:49:00.000Z' } },
      { id: 'x2', startedAt: '2026-11-04T07:00:00.000Z', endedAt: '2026-11-04T08:00:00.000Z',
        report: { state: 'ready', summary: 'PR ready', at: '2026-11-04T07:59:00.000Z' } },
    ] })
  put.ticket({ id: 'bbbbbbbb2222', title: '修复导入报错', createdAt: '2026-11-04T06:40:05.000Z', origin: { triggerId: 'tr2' },
    execution: { backend: 'p4', changelist: 1001 }, pipeline: { state: 'merged', at: '2026-11-04T10:00:00.000Z', url: 'http://swarm/r/1' },
    assignments: [{ id: 'y1', startedAt: '2026-11-04T06:41:00.000Z', report: { state: 'blocked', summary: 'TAPD 403 forbidden', at: '2026-11-04T06:45:00.000Z' } }] })
  put.ticket({ id: 'cccccccc3333', title: '昨天的单', createdAt: '2026-11-02T06:40:05.000Z', assignments: [] })
  return db
}

describe('windows and classification', () => {
  it('maps a local calendar day to a half-open UTC window and buckets local hours', () => {
    expect(window).toMatchObject({ since: '2026-11-03T16:00:00.000Z', until: '2026-11-04T16:00:00.000Z' })
    expect(localHour('2026-11-03T16:00:00.000Z', window)).toBe(0)
    expect(localHour('2026-11-04T15:59:59.999Z', window)).toBe(23)
    expect(localHour('2026-11-04T16:00:00.000Z', window)).toBeUndefined()
    expect(localHour(Date.parse('2026-11-04T06:10:00Z'), window)).toBe(14)
    expect(() => dayWindow('11-04')).toThrow()
  })

  it('assigns each failure exactly one cause in table order', () => {
    expect(causeOf('402 and also 403')).toBe('quota')
    expect(causeOf('SessionFormatError: format v4')).toBe('session-format')
    expect(causeOf('TAPD 返回 403')).toBe('permission')
    expect(causeOf('本地 git 无远端')).toBe('delivery-target')
    expect(causeOf('something else')).toBe('other')
  })

  it('prefers a recorded kind, then the source, then the title', () => {
    expect(kindOf({ kind: 'inquiry', title: '修 bug' }, 'tapd')).toBe('inquiry')
    expect(kindOf({ title: '加功能' }, 'tapd')).toBe('bug')
    expect(kindOf({ title: '加功能', execution: { target: 'me/repo' } }, 'feishu', 'me/repo')).toBe('self')
    expect(kindOf({ title: '修复看板报错' }, 'feishu')).toBe('bug')
    expect(kindOf({ title: '复盘今天' }, 'feishu')).toBe('inquiry')
    expect(kindOf({ title: '做一个导出' }, 'feishu')).toBe('feature')
  })
})

describe('buildMetrics', () => {
  it('aggregates tickets, reports, intake, restarts and hourly human/agent series inside the window only', () => {
    const pulls = [
      { number: 7, title: 'feat', state: 'MERGED', createdAt: '2026-11-04T01:00:00Z', mergedAt: '2026-11-04T09:30:00Z', closedAt: '2026-11-04T09:30:00Z' },
      { number: 8, title: 'old', state: 'MERGED', createdAt: '2026-11-01T01:00:00Z', mergedAt: '2026-11-02T09:30:00Z', closedAt: '2026-11-02T09:30:00Z' },
      { number: 9, title: 'gone', state: 'CLOSED', createdAt: '2026-11-04T01:00:00Z', mergedAt: null, closedAt: '2026-11-04T02:00:00Z' },
    ]
    const m = buildMetrics({ db: fixture(), window, repository: 'me/repo', pulls, sources: {} })
    expect(m.tickets).toMatchObject({ created: 2, ended: 1, open: 1, kinds: { self: 1, bug: 1 } })
    expect(m.tickets.list.map((t: { id: string }) => t.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(m.assignments).toMatchObject({ started: 3, ended: 2, endedReasons: { hostRestarted: 1, normal: 1 } })
    expect(m.reports).toMatchObject({ total: 3, states: { ready: 1, failed: 1, blocked: 1 }, causes: { quota: 1, permission: 1 } })
    expect(m.restarts).toEqual({ interrupted: 1, events: [{ at: '14:50', interrupted: 1 }] })
    expect(m.intake).toMatchObject({ total: 3, human: 2, bySource: { feishu: 1, tapd: 1 }, decisions: { accept: 1, ignore: 1 }, fanoutOnly: 1, handbacks: 1, acks: 1 })
    expect(m.delivery).toMatchObject({ ready: 1, prsMerged: 1, clsSubmitted: 1, total: 3 })
    expect(m.delivery.prs?.closed.map(pr => pr.number)).toEqual([9])
    const at = (hour: number) => m.hourly[hour]
    expect(at(14)).toMatchObject({ human: 2, failed: 1, progress: 1, deliveries: 0 })
    expect(at(15)).toMatchObject({ deliveries: 1 }) // ready report 07:59Z
    expect(at(17)).toMatchObject({ deliveries: 1 }) // PR merged 09:30Z
    expect(at(18)).toMatchObject({ deliveries: 1 }) // tracked CL 10:00Z
    expect(m.limits.join('\n')).toContain('未扫描会话归档')
    expect(m.limits.join('\n')).toContain('未取 p4')
  })

  it('counts p4 submits by their submit time and links them back to tickets through oldChange', () => {
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, human: 0, progress: 0, deliveries: 0, failed: 0, toolCalls: 0 }))
    const tracked = [{ changelist: 1001, ticket: 'bbbbbbbb', at: '18:00', review: 'r' }]
    const changes = [
      { change: '2002', oldChange: '1001', time: String(Date.parse('2026-11-04T03:00:00Z') / 1000), desc: 'fix' },
      { change: '2003', time: String(Date.parse('2026-11-04T17:00:00Z') / 1000), desc: 'tomorrow' },
    ]
    const cls = collectChanges(changes, tracked, window, hourly)
    expect(cls.submitted).toEqual([{ changelist: 2002, ticket: 'bbbbbbbb', at: '11:00', desc: 'fix' }])
    expect(hourly[11]!.deliveries).toBe(1)
  })

  it('scans multi-frame zstd session archives for tool calls in the window and attributes worker sessions to tickets', () => {
    const dir = temp()
    const lines = [
      { type: 'session', id: 'worker-aaaaaaaa1111ffff' },
      { type: 'tool/call', time: Date.parse('2026-11-04T06:10:00Z'), data: { name: 'pwsh' } },
      { type: 'tool/call', time: Date.parse('2026-11-04T06:20:00Z'), data: { name: 'read' } },
      { type: 'tool/call', time: Date.parse('2026-11-02T06:20:00Z'), data: { name: 'read' } },
    ].map(line => JSON.stringify(line) + '\n')
    // One frame per line, like the session persistence writer appends.
    const file = Buffer.concat(lines.map(line => zstdCompressSync(Buffer.from(line))))
    expect(decodeSession(file)).toMatchObject({ frames: 4, bad: 0 })
    mkdirSync(join(dir, 'a', 'worker'), { recursive: true })
    writeFileSync(join(dir, 'a', 'worker', 'session.v4.jsonl.zstd'), file)
    mkdirSync(join(dir, 'stale'), { recursive: true })
    writeFileSync(join(dir, 'stale', 'session.v4.jsonl.zstd'), file)
    utimesSync(join(dir, 'stale', 'session.v4.jsonl.zstd'), new Date('2026-11-01'), new Date('2026-11-01'))
    const m = buildMetrics({ db: fixture(), window, sessionsDir: dir, sources: {} })
    expect(m.tools).toMatchObject({ calls: 2, sessions: 1, files: 1, byName: { pwsh: 1, read: 1 }, byTicket: { aaaaaaaa: 2 } })
    expect(m.hourly[14]?.toolCalls).toBe(2)
    expect(m.tickets.list[0]?.toolCalls).toBe(2)
  })

  it('diffs numeric counters of two days and refuses different schema versions', () => {
    const a = buildMetrics({ db: fixture(), window, sources: {} })
    const b = structuredClone(a)
    b.tickets.created = 5
    const rows = diffMetrics(a, b)
    expect(rows.find(row => row.key === 'tickets.created')).toEqual({ key: 'tickets.created', previous: 2, current: 5, delta: 3 })
    expect(rows.some(row => row.key.startsWith('hourly'))).toBe(false)
    expect(() => diffMetrics(a, { ...b, schemaVersion: 99 })).toThrow(/schemaVersion/)
  })
})

describe('ledger', () => {
  it('adds numbered commitments, records status history and validates input', () => {
    const ledger = emptyLedger()
    expect(addCommitment(ledger, { text: '容灾', due: '2026-11-05' }).id).toBe('C1')
    expect(addCommitment(ledger, { text: '分类', due: '2026-11-05', ticket: 'abc' }).id).toBe('C2')
    expect(() => addCommitment(ledger, { text: '', due: '2026-11-05' })).toThrow()
    expect(() => addCommitment(ledger, { text: 'x', due: 'tomorrow' })).toThrow()
    setCommitment(ledger, 'C1', { status: 'partial', note: '只做了一半' }, '2026-11-05')
    expect(ledger.items[0]).toMatchObject({ status: 'partial', note: '只做了一半', history: [{ on: '2026-11-05', from: 'open', to: 'partial' }] })
    expect(() => setCommitment(ledger, 'C1', { status: 'great' }, '2026-11-05')).toThrow()
    expect(() => setCommitment(ledger, 'C9', {}, '2026-11-05')).toThrow()
  })

  it('reconciles against ticket outcomes and flags commitments without a ticket', () => {
    const ledger = emptyLedger()
    addCommitment(ledger, { text: '无单', due: '2026-11-04' })
    addCommitment(ledger, { text: '已合', due: '2026-11-04', ticket: 'merged' })
    addCommitment(ledger, { text: '被停', due: '2026-11-06', ticket: 'stopped' })
    addCommitment(ledger, { text: '逾期', due: '2026-11-04', ticket: 'open' })
    addCommitment(ledger, { text: '未到期', due: '2026-11-09', ticket: 'open' })
    const tickets: Record<string, { ended?: { outcome: string } }> = { merged: { ended: { outcome: 'merged' } }, stopped: { ended: { outcome: 'stopped' } }, open: {} }
    expect(reconcile(ledger, '2026-11-05', id => tickets[id])).toEqual([
      { id: 'C1', from: 'open', to: 'missed', reason: '未开单' },
      { id: 'C2', from: 'open', to: 'done', reason: '工单已合并' },
      { id: 'C3', from: 'open', to: 'dropped', reason: '工单被停止' },
      { id: 'C4', from: 'open', to: 'missed', reason: '工单未结，已过截止日' },
    ])
  })
})

describe('report', () => {
  it('draws one row per active hour with the human segment first and the agent segments joined right after it', () => {
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, human: 0, progress: 0, deliveries: 0, failed: 0, toolCalls: 0 }))
    Object.assign(hourly[9]!, { human: 10, toolCalls: 100, progress: 2, deliveries: 4 })
    Object.assign(hourly[10]!, { human: 5, toolCalls: 50, progress: 1, deliveries: 0, failed: 1 })
    const html = hourlyChart(hourly)
    expect(html.match(/class="hrow"/g)).toHaveLength(2)
    const row = html.slice(html.indexOf('09 时'), html.indexOf('10 时'))
    const order = ['seg human', 'class="join"', 'seg tools', 'seg progress', 'seg deliver'].map(marker => row.indexOf(marker))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(row).toContain('width:38.00%') // the human peak takes its full share
    const later = html.slice(html.indexOf('10 时'))
    expect(later).toContain('width:19.00%')
    expect(later).not.toContain('seg deliver')
    expect(later).toContain('失败 1')
    expect(hourlyChart(hourly.map(h => ({ ...h, human: 0, toolCalls: 0, progress: 0, deliveries: 0, failed: 0 })))).toContain('没有')
  })

  it('escapes markdown input and renders lists, tables, links and bold', () => {
    const html = markdown('**粗** `code` [链接](https://example.com)\n\n- a<b>\n- b\n\n| h1 | h2 |\n| --- | --- |\n| x | y |')
    expect(html).toContain('<b>粗</b>')
    expect(html).toContain('<a href="https://example.com">链接</a>')
    expect(html).toContain('<li>a&lt;b&gt;</li>')
    expect(html).toContain('<th>h1</th>')
    expect(html).toContain('<td>y</td>')
    expect(markdown('[x](javascript:alert(1))')).not.toContain('href')
  })

  it('puts unmet commitments on the first screen, compares against the previous day and marks missing narrative sections', () => {
    const metrics = buildMetrics({ db: fixture(), window, sources: {} })
    const previous = structuredClone(metrics)
    previous.tickets.created = 1
    const ledger = emptyLedger()
    addCommitment(ledger, { text: '没开单的承诺', due: '2026-11-03' })
    addCommitment(ledger, { text: '已兑现', due: '2026-11-03', ticket: 'x' })
    setCommitment(ledger, 'C2', { status: 'done' }, '2026-11-04')
    const narrative = parseNarrative('## summary\n- 一句结论\n\n## plan\n明天做 <script>\n')
    const { html, missing } = renderReport({ metrics, previous, ledger, narrative })
    const first = html.slice(0, html.indexOf('id="s2"'))
    expect(first).toContain('一句结论')
    expect(first).toContain('没开单的承诺')
    expect(first).not.toContain('已兑现</li>')
    expect(first).toContain('+1 vs 昨天')
    expect(html).toContain('明天做 &lt;script&gt;')
    expect(html).not.toContain('<script')
    expect(missing).toEqual(['interview', 'bottlenecks', 'review', 'research', 'template'])
    expect(html.match(/<section /g)).toHaveLength(9)
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\/(?!example)/)
  })

  it('gives the interview section a fixed place after the first screen, before the day’s numbers', () => {
    const metrics = buildMetrics({ db: fixture(), window, sources: {} })
    const full = '## summary\n- 一句结论\n\n## interview\n- 「终于把复现跑通了」 —— 23:31\n\n**推断**：他要的是可重跑的证据，不是更多面板。\n\n## review\nr\n\n## bottlenecks\nb\n\n## plan\np\n\n## research\ns\n\n## template\nt\n'
    const { html, missing } = renderReport({ metrics, narrative: parseNarrative(full) })
    expect(missing).toEqual([])
    expect(html).toContain('口径见第 9 节')

    const interview = html.slice(html.indexOf('id="s2"'), html.indexOf('id="s3"'))
    expect(interview).toContain('采访人的感受')
    expect(interview).toContain('终于把复现跑通了')
    expect(interview).toContain('<b>推断</b>')
    expect(interview).toContain('不要用数字反推情绪')
    expect(interview).not.toContain('小时图')
    expect(html.slice(0, html.indexOf('id="s2"'))).toContain('一句结论')

    const withoutInterview = renderReport({ metrics, narrative: parseNarrative(full.replace(/## interview\n[\s\S]*?\n\n## review/, '## review')) })
    expect(withoutInterview.missing).toEqual(['interview'])
    expect(withoutInterview.html).toContain('待填写：narrative.md 的 <code>## interview</code>，采访人的感受')
  })
})
