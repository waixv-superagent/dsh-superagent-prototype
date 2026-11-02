/**
 * Feishu interactive cards for the P1 plan gate: a decision brief whose evidence folds away, the form that asks for a
 * different direction, the card that records an answer, and the text fallback when Feishu refuses a card.
 */
import { PLAN_REPLY_HINT, planLines, type PlanDecision, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { cmdSafe, feishuPostContent } from './feishu-channel.ts'

/** What sending a card needs: the deployment's bot CLI. */
export interface CardHost { readonly commands: Pick<Commands, 'lark'> }
/** A card with the plain-text version used when Feishu rejects the card itself. */
export interface CardMessage { card: Record<string, unknown>; text: string }
/** The short ticket id a card shows, as the panel links it: the first eight characters of the full id. */
const shortId = (ticket: Pick<Ticket, 'id'>): string => ticket.id.slice(0, 8)
/** The plan's lines by label; a card shows the lines the worker wrote and `—` for one it left out (the gate refuses those). */
const linesOf = (text: string): Map<string, string> => new Map(planLines(text).map(line => [line.label, line.text]))
/**
 * Feishu's CLI runs through `cmd.exe /c` on Windows, where an unquoted-by-cmd `<` or `>` is a redirection: a card carrying
 * `<font …>` failed with "cannot find the file specified" before the CLI ever saw it. `cmdSafe` is shared with plain replies.
 */
const markdown = (content: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ tag: 'markdown', content: cmdSafe(content), ...extra })
const plain = (content: string): Record<string, unknown> => ({ tag: 'plain_text', content: cmdSafe(content) })
/** A card button that calls this plugin back with one decision; stop asks once more because it withdraws the Mandate. */
const decisionButton = (label: string, type: string, decision: PlanDecision): Record<string, unknown> => ({
  tag: 'button', text: plain(label), type, width: 'fill',
  behaviors: [{ type: 'callback', value: { v: 1, decision } }],
  ...decision === 'stop' ? { confirm: { title: plain('停止工单？'), text: plain('停止后这个工单不再继续，需要重新接单。') } } : {},
})
/** The four evidence lines live behind one fold; the card leads with the finding, the fix, and the cost. */
const EVIDENCE = ['代码线', '资产线', '配置线', '验证方案'] as const
const evidencePanel = (get: (label: string) => string): Record<string, unknown> => ({
  tag: 'collapsible_panel', expanded: false,
  header: { title: plain('证据 · 代码线 / 资产线 / 配置线 / 验证方案') },
  elements: [markdown(EVIDENCE.map(label => `**${label}**\n${get(label) || '—'}`).join('\n\n'))],
})
/**
 * The P1 plan gate card: the finding and the fix on top, the impact and budget beneath them, the code/asset/config/
 * verification evidence folded behind one tap, and three buttons. The text fallback keeps the same brief, since the panel
 * holds the full eight-line plan and the evidence; only a person who cannot see the card reads it.
 */
export function planCard(ticket: Pick<Ticket, 'id' | 'title'>, plan: string, deadline?: string): CardMessage {
  const lines = linesOf(plan)
  const get = (label: string): string => lines.get(label) ?? ''
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: plain('待确认 · 方案已出'),
      subtitle: plain(`${ticket.title} · 工单 ${shortId(ticket)}`),
      template: 'blue',
      text_tag_list: [{ tag: 'text_tag', text: plain('等你点头'), color: 'blue' }],
    },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [
        markdown(`**现象**\n${get('现象') || '—'}`),
        markdown(`**修复锚点**\n${get('修复锚点') || '—'}`),
        markdown(`**影响面** ${get('影响面') || '—'}\n**预算** ${get('预算') || '—'}`, { text_size: 'notation' }),
        evidencePanel(get),
        markdown('**通过后** worker 开始实现，按验证方案验证，再把结果交给你确认交付；不会直接 submit。',
          { text_size: 'notation' }),
        ...deadline ? [markdown(`⏳ 截止 ${new Date(deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai',
          hour12: false })}，不答会自动停`, { text_size: 'notation' })] : [],
        {
          tag: 'column_set', flex_mode: 'trisect',
          columns: [
            { tag: 'column', elements: [decisionButton('通过', 'primary_filled', 'approve')] },
            { tag: 'column', elements: [decisionButton('改一下', 'default', 'revise')] },
            { tag: 'column', elements: [decisionButton('停', 'danger', 'stop')] },
          ],
        },
      ],
    },
  }
  const text = cmdSafe([`待确认 · 方案已出：${ticket.title}（工单 ${shortId(ticket)}）`,
    `现象：${get('现象') || '—'}`,
    `修复锚点：${get('修复锚点') || '—'}`,
    `影响面：${get('影响面') || '—'} ｜ 预算：${get('预算') || '—'}`,
    '通过后：开始实现，按验证方案验证，再交给你确认交付；不会直接 submit。',
    '证据与完整方案在工单面板。', PLAN_REPLY_HINT].join('\n'))
  return { card, text }
}
/** The card a click on 改一下 turns into, so a direction is typed once instead of in a chat round-trip. */
export function reviseCard(ticket: Pick<Ticket, 'id' | 'title'>): CardMessage {
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain('改一下 · 说清新方向'), subtitle: plain(`${ticket.title} · 工单 ${shortId(ticket)}`), template: 'orange' },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [
        markdown('写一句你想换的方向，提交后回到方案阶段，worker 会按它重新给方案。'),
        {
          tag: 'form', name: 'plan_revise',
          elements: [
            { tag: 'input', name: 'note', input_type: 'multiline_text', rows: 3, required: true, max_length: 1000,
              placeholder: plain('例如：走 B 方案，先上工具链') },
            { tag: 'button', name: 'submit_revise', form_action_type: 'submit', type: 'primary_filled',
              text: plain('提交新方向') },
          ],
        },
      ],
    },
  }
  return { card, text: cmdSafe(`改一下 · ${ticket.title}：请回复 2 并附一句新方向`) }
}
/** The card that replaces the question once a person answered, so the chat record says what was decided. */
export function resolvedCard(ticket: Pick<Ticket, 'id' | 'title'>, decision: PlanDecision, note = ''): CardMessage {
  const outcome = decision === 'approve' ? { title: '已通过 · 开始实现', template: 'green', body: '方案已通过，worker 进入实现阶段。' }
    : decision === 'revise' ? { title: '已换方向 · 等新方案', template: 'orange',
        body: `已把新方向交给 worker：${note || '（没有附说明）'}` }
      : { title: '已停止', template: 'red', body: '这个工单停在方案门，不再继续。' }
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain(outcome.title), subtitle: plain(`${ticket.title} · 工单 ${shortId(ticket)}`), template: outcome.template },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown(outcome.body), markdown('决定已记录，可在工单面板查看完整方案与执行过程。',
        { text_size: 'notation' })] },
  }
  return { card, text: cmdSafe(`${outcome.title}：${ticket.title}。${outcome.body}`) }
}
/** The card for a click on a question that no longer waits: idempotent, and it never changes the ticket. */
export function staleCard(ticket: Pick<Ticket, 'id' | 'title'>): CardMessage {
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain('已处理 · 这版方案不再等人'), subtitle: plain(`${ticket.title} · 工单 ${shortId(ticket)}`), template: 'grey' },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown('这版方案已经有人答过，或者已经换了一版；在工单面板里能看到最新状态。')] },
  }
  return { card, text: cmdSafe(`已处理：${ticket.title}（这版方案不再等人）`) }
}
/** Replaces a card in place with the delayed-update token its button callback carries (valid 30 minutes, two uses). */
export async function updateCard(host: CardHost, token: string, message: CardMessage): Promise<void> {
  await host.commands.lark(['api', 'POST', '/open-apis/interactive/v1/card/update', '--data',
    JSON.stringify({ token, card: message.card })])
}
/** The `message_id` of a `+messages-send` result, for a later in-place card update; undefined when the output carries none. */
export function messageIdOf(output: unknown): string | undefined {
  const parsed = typeof output === 'string' ? safeJson(output) : output
  const data = (parsed as { data?: unknown } | undefined)?.data ?? parsed
  const id = (data as { message_id?: unknown } | undefined)?.message_id
  return typeof id === 'string' && id ? id : undefined
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
/**
 * The `message_app_link` of a `+messages-mget` result, which opens that message rather than its chat; undefined when the
 * CLI answer carries none.
 */
export function messageUrlOf(output: unknown): string | undefined {
  const parsed = typeof output === 'string' ? safeJson(output) : output
  const data = (parsed as { data?: unknown } | undefined)?.data ?? parsed
  const messages = (data as { messages?: unknown } | undefined)?.messages
  const link = Array.isArray(messages) ? (messages[0] as { message_app_link?: unknown } | undefined)?.message_app_link : undefined
  return typeof link === 'string' && link ? link : undefined
}
/** Asks Feishu where a message lives, so a panel link can open the question itself. */
export async function messageLink(host: CardHost, messageId: string): Promise<string | undefined> {
  return messageUrlOf(await host.commands.lark(['im', '+messages-mget', '--message-ids', messageId]))
}
/**
 * Sends a card to `chat`, or into the thread that `replyTo` belongs to, and falls back to its markdown text when Feishu
 * rejects the card, so a gate question always reaches the person; the idempotency key keeps a retried send from posting twice.
 * @returns the sent message's `message_id`, card or fallback text alike, when Feishu returned one.
 */
export async function sendCard(host: CardHost, chat: string, message: CardMessage, idempotencyKey: string, replyTo?: string): Promise<string | undefined> {
  const send = (flag: '--content' | '--markdown', content: string, type?: 'interactive' | 'post'): Promise<unknown> =>
    replyTo
      ? host.commands.lark(['im', '+messages-reply', '--message-id', replyTo, ...type ? ['--msg-type', type] : [], flag, content,
        '--reply-in-thread', '--idempotency-key', idempotencyKey])
      : host.commands.lark(['im', '+messages-send', '--chat-id', chat, ...type ? ['--msg-type', type] : [], flag, content, '--idempotency-key', idempotencyKey])
  try {
    return messageIdOf(await send('--content', JSON.stringify(message.card), 'interactive'))
  } catch {
    // A card Feishu refuses (such as a schema change) still reaches the person as text; anything else would fail there too.
    return messageIdOf(await send('--content', feishuPostContent(message.text), 'post'))
  }
}
