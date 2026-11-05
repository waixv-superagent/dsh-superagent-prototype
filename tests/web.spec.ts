/** The Web Source: a request submitted from the DSH Web panel reaches the domain as an explicit Trigger and opens a Ticket. */
import { expect, it } from 'vitest'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { webKind, webLabel, webTrigger } from '../src/sources/web.ts'
import { startRuntime } from './fixtures/host.ts'

const REQUEST = '把工单面板的方案卡改成真实代码 diff 的视图，卡片只留摘要和链接'

it('builds one Thread per request, from the panel operator, addressed to the main Session', () => {
  const at = '2026-11-05T06:00:00.000Z'
  const trigger = webTrigger({ text: REQUEST, at, session: 'main-1' })
  const thread = key('web', at, REQUEST)
  expect(trigger).toMatchObject({
    source: 'web', human: true, addressed: 'direct', actor: { source: 'web', id: 'operator' }, at, text: REQUEST,
    threads: [{ source: 'web', id: thread }],
    channel: { source: 'web', thread: `web:${thread}`, address: { session: 'main-1' } },
  })
  expect(trigger.id).toBe(key('trigger', 'web', thread))
  expect(webLabel(`${REQUEST}\n第二行`)).toBe(REQUEST)
})

it('opens a Ticket from a panel request through the normal Eval and accept path, and delivers its receipt to the main Session', async () => {
  const sent: OutboundMessage[] = []
  const h = await startRuntime()
  try {
    h.runtime.sources.register(webKind({ deliver: async message => { sent.push(message); return 'sent' } }))
    // The panel submits as one fixed operator, so the Source's Policy part holds it; the surface syncs it.
    await h.runtime.settings.sync('web')
    expect(h.runtime.store.settings().policy.sources.web?.allowed).toContainEqual({ id: 'operator', name: 'Web panel' })
    const answer = await h.api('POST', 'requests', { text: REQUEST })
    expect(answer.status).toBe(200)
    const triggerId = String(answer.body.trigger_id)
    const thread = String(answer.body.thread)
    expect(thread).toMatch(/^web:/)
    // The request is an ordinary Trigger: the main Session receives the candidate and the Thread is named after it.
    await h.runtime.idle()
    expect(h.candidates()).toContain(triggerId)
    expect(h.runtime.store.threads.get(thread)?.meta.label).toBe(REQUEST)
    const accepted = await h.route({ kind: 'accept', trigger_id: triggerId, title: '方案卡真实 diff', worktree_name: 'plan-card-diff',
      acknowledgement: '收到，先出方案。' })
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket.mandate).toMatchObject({ strength: 'explicit', actor: { source: 'web', id: 'operator' },
      basis: { via: 'addressed', addressed: 'direct' } })
    expect(ticket.channels).toEqual([{ source: 'web', thread, address: { session: h.runtime.masterId } }])
    // A person's addressed request is P1, like a Feishu mention.
    expect(ticket.priority).toMatchObject({ level: 'P1' })
    // The receipt goes through the Web Channel, so it shows in the main Session the person submitted from.
    expect(sent.map(message => message.text).join('\n')).toContain('收到，先出方案。')
  } finally { await h.stop() }
})

it('admits no panel request before the operator is on the Web Source Policy list', async () => {
  const h = await startRuntime()
  try {
    const trigger = webTrigger({ text: REQUEST, at: '2026-11-05T06:00:00.000Z', session: h.runtime.masterId })
    expect(h.runtime.engine.admissible(trigger)).toBe(false)
  } finally { await h.stop() }
})

it('refuses a request with a reason while the Web Source is off', async () => {
  const h = await startRuntime()
  try {
    h.runtime.sources.register(webKind({ deliver: async () => 'sent' }))
    await h.runtime.settings.sync('web')
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, web: { enabled: false, config: {} } } })
    const answer = await h.api('POST', 'requests', { text: REQUEST })
    expect(answer.status).toBe(400)
    expect(String(answer.body.error)).toContain('off')
  } finally { await h.stop() }
})
