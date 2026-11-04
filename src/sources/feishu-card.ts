/**
 * Feishu interactive cards: the P1 plan gate's decision brief (with the choices the worker writes), a question card whose
 * buttons answer a worker's `human_action`, a TAPD ticket's priority question, the forms for a typed direction, the cards
 * that record an answer, and the text fallback when Feishu refuses a card.
 */
import { PLAN_CARD_QUESTION, PLAN_REPLY_HINT, PLAN_TEMPLATES, PRIORITY_LABELS, PRIORITY_LEVELS, planLines, planTemplate, type Plan, type PlanDecision,
  type PlanOption, type PlanTemplate, type PriorityAsk, type PriorityLevel, type QuestionSection, type Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { feishuPostContent, jsonForCmd, textSafe } from './feishu-text.ts'

/** What sending a card needs: the deployment's bot CLI. */
export interface CardHost { readonly commands: Pick<Commands, 'lark'> }
/** A card with the plain-text version used when Feishu rejects the card itself. */
export interface CardMessage { card: Record<string, unknown>; text: string }
/** The short ticket id a card shows, as the panel links it: the first eight characters of the full id. */
const shortId = (ticket: Pick<Ticket, 'id'>): string => ticket.id.slice(0, 8)
/**
 * The card's way back to its ticket: one small line that opens the ticket's panel page. Built without markdown, whose
 * angle-bracket rewrite and link titling must not touch the URL.
 */
const ticketLinkText = (ticketId: string, link: string): string => `[工单 ${shortId({ id: ticketId })} ↗](${link})`
const ticketLinkLine = (ticketId: string, link: string): Record<string, unknown> =>
  ({ tag: 'markdown', content: ticketLinkText(ticketId, link), text_size: 'notation' })
/** The plan's lines by label; a card shows the lines the worker wrote and `—` for one it left out (the gate refuses those). */
const linesOf = (text: string, template: PlanTemplate = 'fix'): Map<string, string> => new Map(planLines(text, template).map(line => [line.label, line.text]))
/** A bare URL's display title: what it is, not the address, while the link still opens the URL. */
const linkTitle = (url: string): string => {
  let parsed: URL
  try { parsed = new URL(url) } catch { return '链接' }
  const host = parsed.hostname.replace(/^www\./i, '')
  const path = parsed.pathname.split('/').filter(Boolean)
  if (/(^|\.)github\.com$/i.test(host)) {
    const [owner = '', repo = '', kind = '', number = ''] = path
    if (kind === 'pull' && number) return `PR #${number}`
    if (kind === 'issues' && number) return `Issue #${number}`
    if (kind === 'commit' && number) return `Commit ${number.slice(0, 7)}`
    return owner && repo ? `${owner}/${repo}` : 'GitHub'
  }
  if (/(^|\.)feishu\.cn$/i.test(host) || /(^|\.)larksuite\.com$/i.test(host)) {
    const kind = path[0]
    return kind === 'docx' ? '飞书文档' : kind === 'wiki' ? '飞书知识库' : kind === 'sheets' ? '飞书表格'
      : kind === 'slides' ? '飞书幻灯片' : kind === 'base' ? '飞书多维表格' : '飞书链接'
  }
  if (/^jenkins[.-]/i.test(host)) return 'Jenkins 构建'
  return host
}
/** A URL a worker wrote as a title is kept; a bare URL becomes `[title](url)`, so the card never shows the address. */
const linkify = (text: string): string => text.replace(
  /(\[[^\]]*\]\([^)]*\))|(https?:\/\/[^\s<>"'()（）[\]【】。，；：！？、]+)/gu,
  (markdown: string, titled?: string, bare?: string) => titled ?? `[${linkTitle(bare!)}](${bare})`)
/** Cards show angle brackets full-width so no message text is read as card markup; the JSON argument escapes the rest. */
const markdown = (content: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ tag: 'markdown', content: textSafe(linkify(content)), ...extra })
const plain = (content: string): Record<string, unknown> => ({ tag: 'plain_text', content: textSafe(content) })
/** How short a sentence may be before it joins the point before it, so a card gets no one-word bullets like "推荐。". */
const POINT_MIN = 12
/** How long a point may get before it splits at its own semicolons; a point reads like a sentence, not a wall of text. */
const POINT_MAX = 180
/**
 * Two points on one line when a short fragment joins the sentence before it: a full stop already ends the line, so only a
 * fragment that was cut mid-sentence (no closing punctuation) gets a space.
 */
const joinPoint = (last: string, piece: string): string => `${last}${/[。！？；;]$/u.test(last) ? '' : ' '}${piece}`
/**
 * The points a card block shows: the worker's own line breaks first, then one point per sentence and a very long sentence
 * at its semicolons. A fragment too short to stand alone joins the point before it, except the closing sentence of the
 * block, which keeps its own last line so a conclusion like "推荐 B。" is not read as part of the point above it. No
 * character is dropped, so the card and its text fallback carry the whole plan and only its layout changes.
 */
const planPoints = (text: string): string[] => {
  const pieces: string[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const clauses = line.trim().replace(/^[-*•·]\s+/u, '').split(/(?<=[。！？])\s*/u)
      .map(piece => piece.trim()).filter(Boolean)
    for (const clause of clauses) {
      pieces.push(...(Array.from(clause).length <= POINT_MAX ? [clause]
        : clause.split(/(?<=[；;])/u).map(piece => piece.trim()).filter(Boolean)))
    }
  }
  const points: string[] = []
  pieces.forEach((piece, index) => {
    const last = points.length ? points[points.length - 1] : undefined
    if (last !== undefined && index < pieces.length - 1 && Array.from(piece).length < POINT_MIN) {
      points[points.length - 1] = joinPoint(last, piece)
    } else {
      points.push(piece)
    }
  })
  return points
}
/** A point that already carries its own number keeps it, in Chinese numbering so no list markdown nests. */
const NUMBERED = /^\d{1,2}(?:[)、]|\.(?!\d))\s*/u
/** One point as its own line: a dot, not a markdown list, so the text keeps the card's left edge on a phone. */
const pointLine = (point: string): string => NUMBERED.test(point)
  ? point.replace(NUMBERED, (marker: string) => `${marker.trim().replace(/[).、]$/u, '')}、`)
  : `• ${point}`
/** The lines of a multi-point block: the closing sentence keeps its own line (no dot) so a conclusion does not hide. */
const pointLines = (points: string[]): string[] => {
  const last = points[points.length - 1] ?? ''
  const closing = points.length > 1 && !NUMBERED.test(last) && Array.from(last).length < POINT_MIN
  return points.map((point, index) => closing && index === points.length - 1 ? point : pointLine(point))
}
/** One plan block as the card shows it: its bold label, then a line per point when it has more than one. */
const block = (label: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const points = planPoints(text)
  const body = points.length > 1 ? pointLines(points).join('\n') : points[0] ?? '—'
  return markdown(`**${label}**\n${body}`, extra)
}
/** The same block as multi-line text for the fallback a person reads when Feishu refuses the card. */
const blockText = (label: string, text: string): string => {
  const points = planPoints(text)
  return points.length > 1
    ? `${label}：\n${pointLines(points).map(point => linkify(point)).join('\n')}`
    : `${label}：${linkify(points[0] ?? '—')}`
}
/** A card button that calls this plugin back with one decision and, when the plan offers choices, their index; stop asks
 * once more because it withdraws the Mandate. The label and its note stay in the plan, not the callback value, so no worker
 * text has to survive the command line inside the card's JSON. */
const decisionButton = (label: string, type: string, decision: PlanDecision, choice?: number): Record<string, unknown> => ({
  tag: 'button', text: plain(label), type, width: 'fill',
  behaviors: [{ type: 'callback', value: { v: 1, decision, ...choice !== undefined ? { choice } : {} } }],
  ...decision === 'stop' ? { confirm: { title: plain('停止工单？'), text: plain('停止后这个工单不再继续，需要重新接单。') } } : {},
})
/** The gate's own choices when the worker does not write any: the three labels this card has always shown. */
const DEFAULT_PLAN_OPTIONS: readonly PlanOption[] = [
  { label: '通过', decision: 'approve' }, { label: '改一下', decision: 'revise' }, { label: '停', decision: 'stop' },
]
/** The choices a plan card shows, in the worker's order, falling back to the gate's three. */
export const planChoices = (plan: Pick<Plan, 'options'>): readonly PlanOption[] => plan.options?.length ? plan.options : DEFAULT_PLAN_OPTIONS
/** One row of choices: two split in half, three in thirds, four flow and wrap when the screen is narrow. */
const flexOf = (count: number): string => count <= 2 ? 'bisect' : count === 3 ? 'trisect' : 'flow'
const buttonType = (decision: PlanDecision): string => decision === 'approve' ? 'primary_filled' : decision === 'stop' ? 'danger' : 'default'
/** `text` on one line, cut to `max` characters (code points, so an emoji is never split) with `…` when it was longer. */
const clip = (text: string, max: number): string => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').replace(/[\s，,、；;：:（(「]+$/, '')}…`
}
/** A section's points without its bold label; a fold header that already names a lone section does not repeat it. */
const bodyMarkdown = (text: string): Record<string, unknown> => {
  const points = planPoints(text)
  return markdown(points.length > 1 ? pointLines(points).join('\n') : points[0] ?? '—')
}
/** The context sections a person can expand: a worker's own `fold` blocks, or the plan's four evidence lines. */
const foldPanel = (sections: readonly QuestionSection[], title: string): Record<string, unknown> => ({
  tag: 'collapsible_panel', expanded: false,
  header: {
    title: plain(`${title} · ${sections.map(section => section.label).join(' / ')}`),
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'right', icon_expanded_angle: -180,
  },
  border: { color: 'grey', corner_radius: '5px' },
  vertical_spacing: '8px', padding: '8px 8px 8px 8px',
  elements: sections.length === 1 ? [bodyMarkdown(sections[0]?.text ?? '')] : sections.map(section => block(section.label, section.text)),
})
/** The four evidence lines the fix plan card folds away; a worker's custom sections replace them. */
const EVIDENCE = ['代码线', '资产线', '配置线', '验证方案'] as const
/** Which plan lines a card leads with and which it folds, per template: the fix layout is the original one. */
const PLAN_LAYOUTS: Readonly<Record<PlanTemplate, { front: readonly string[]; fold: readonly string[] }>> = {
  fix: { front: ['现象', '修复锚点', '影响面', '预算'], fold: EVIDENCE },
  analysis: { front: ['问题', '结论', '建议'], fold: ['依据'] },
  design: { front: ['问题', '推荐'], fold: ['选项', '证据'] },
}
const evidencePanel = (sections: readonly { label: string; text: string }[]): Record<string, unknown> => foldPanel(sections, '证据')
/** The deadline as month, day and minute in China time, which is all a person needs to know when the gate stops. */
const deadlineText = (deadline: string): string => new Date(deadline).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
/**
 * The P1 plan gate card as a decision brief: the worker's question (or the gate's standard one), then the plan's own key
 * lines for its template in full (the fix template leads with 现象/修复锚点/影响面/预算, an analysis with 问题/结论/建议, a design
 * with 问题/推荐), the rest folded behind one tap, what approving does, the deadline, the choices in full and the worker's 2–4
 * buttons (the standard three when it wrote none). The text fallback carries the key lines and the labels in full, since only
 * a person who cannot see the card reads it.
 */
export function planCard(ticket: Pick<Ticket, 'id' | 'title'>, plan: Pick<Plan, 'text' | 'template' | 'question' | 'options' | 'deadline' | 'sections'>,
  ticketLink?: string): CardMessage {
  const template = planTemplate(plan)
  const lines = linesOf(plan.text, template)
  const get = (label: string): string => lines.get(label) ?? ''
  const layout = { front: [...PLAN_LAYOUTS[template].front], fold: [...PLAN_LAYOUTS[template].fold] }
  const choices = planChoices(plan)
  const described = choices.some(choice => choice.description)
  const question = plan.question || PLAN_CARD_QUESTION
  const custom = plan.sections?.length ? plan.sections : undefined
  const body = custom?.filter(section => !section.fold) ?? []
  const folded = custom?.filter(section => section.fold) ?? []
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: plain(`待确认 · ${clip(question, 40)}`),
      subtitle: plain(`${clip(ticket.title, 24)} · 工单 ${shortId(ticket)}`),
      template: 'blue',
    },
    body: {
      direction: 'vertical', padding: '16px 16px 20px 16px', vertical_spacing: '12px',
      elements: [
        markdown(`**${question}**`),
        ...body.length ? body.map(section => block(section.label, section.text))
          : custom ? [] : layout.front.map(label => block(label, get(label), ['影响面', '预算'].includes(label) ? { text_size: 'notation' } : {})),
        ...folded.length ? [foldPanel(folded, '补充')] : custom ? [] : [evidencePanel(layout.fold.map(label => ({ label, text: get(label) || '—' })))],
        ...described ? [markdown(`**选项说明**\n${choices.map((choice, index) =>
          `${index + 1}、${choice.label}${choice.description ? `：${choice.description}` : ''}`).join('\n')}`, { text_size: 'notation' })] : [],
        { tag: 'hr', margin: '4px 0px 0px 0px' },
        markdown([
          '**通过后** worker 开始实现并按验证方案自测，交你确认后才交付，不会直接 submit',
          ...plan.deadline ? [`⏳ ${deadlineText(plan.deadline)} 前不答会自动停`] : [],
        ].join('\n'), { text_size: 'notation' }),
        {
          tag: 'column_set', flex_mode: flexOf(choices.length), horizontal_spacing: '8px',
          columns: choices.map((choice, index) => ({ tag: 'column', elements: [
            decisionButton(choice.label, buttonType(choice.decision), choice.decision, index)] })),
        },
        ...ticketLink ? [ticketLinkLine(ticket.id, ticketLink)] : [],
      ],
    },
  }
  const context = custom ?? layout.front.map(label => ({ label, text: get(label) || '—' }))
  const text = textSafe([`待确认 · 方案已出：${ticket.title}（工单 ${shortId(ticket)}）`,
    `要你定：${question}`,
    ...context.map(section => blockText(section.label, section.text)),
    '通过后：开始实现，按验证方案验证，再交给你确认交付；不会直接 submit。',
    `选项：${choices.map(choice => choice.description ? `${choice.label}（${choice.description}）` : choice.label).join(' ｜ ')}`,
    custom ? '卡片按这次对话的语境用了自定义分块。' : `证据（${layout.fold.join('/')}）在卡片折叠与工单面板里。`, PLAN_REPLY_HINT].join('\n'))
    + (ticketLink ? `\n${ticketLinkText(ticket.id, ticketLink)}` : '')
  return { card, text }
}
/**
 * The card a click on 改一下 turns into: it keeps the original question and the whole plan one tap away, so switching views
 * no longer hides what is being revised, and it offers a way back to the plan card. The form itself cannot upload files, so
 * the hint sends a person with a screenshot to reply to the card instead of losing the evidence.
 */
export function reviseCard(ticket: Pick<Ticket, 'id' | 'title'>, plan: Pick<Plan, 'text' | 'template' | 'question'>): CardMessage {
  const question = plan.question?.trim() || PLAN_CARD_QUESTION
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: { title: plain('改一下 · 说清哪里不对'), subtitle: plain(`${clip(ticket.title, 40)} · 工单 ${shortId(ticket)}`), template: 'orange' },
    body: {
      direction: 'vertical', padding: '12px 12px 20px 12px', vertical_spacing: '10px',
      elements: [
        markdown(`**原问题**\n${question}`, { text_size: 'notation' }),
        {
          tag: 'collapsible_panel', expanded: false,
          header: {
            title: plain('原方案 · 点开对照'),
            icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
            icon_position: 'right', icon_expanded_angle: -180,
          },
          border: { color: 'grey', corner_radius: '5px' },
          vertical_spacing: '8px', padding: '8px 8px 8px 8px',
          elements: planLines(plan.text, planTemplate(plan)).map(line => block(line.label, line.text)),
        },
        markdown('**要改什么？** 写一句方向就行；提交后回到方案阶段，worker 按它重新给方案。'),
        {
          tag: 'form', name: 'plan_revise',
          elements: [
            { tag: 'input', name: 'note', input_type: 'text', required: true, max_length: 1000,
              placeholder: plain('一句话说清新方向；要贴图或写长文，直接回复这张卡') },
            { tag: 'button', name: 'submit_revise', form_action_type: 'submit', type: 'primary_filled',
              text: plain('提交新方向') },
          ],
        },
        markdown('要贴图或写长文，直接回复这张卡（表单里只能填文字）。', { text_size: 'notation' }),
        {
          tag: 'column_set', flex_mode: 'bisect',
          columns: [{ tag: 'column', elements: [{ tag: 'button', width: 'fill', text: plain('返回方案'), type: 'default',
            behaviors: [{ type: 'callback', value: { v: 1, back: true } }] }] }],
        },
      ],
    },
  }
  return { card, text: textSafe(`改一下 · ${ticket.title}：回复 2 并附一句新方向；原方案见上一条方案卡。`) }
}
/** The card that replaces the question once a person answered, so the chat record says what was decided. */
export function resolvedCard(ticket: Pick<Ticket, 'id' | 'title'>, decision: PlanDecision, note = '', option = ''): CardMessage {
  const chosen = option ? `（你选的是「${option}」）` : ''
  const outcome = decision === 'approve' ? { title: '已通过 · 开始实现', template: 'green', body: `方案已通过，worker 进入实现阶段。${chosen}` }
    : decision === 'revise' ? { title: '已换方向 · 等新方案', template: 'orange',
        body: `已把新方向交给 worker：${note || '（没有附说明）'}${chosen}` }
      : { title: '已停止', template: 'red', body: `这个工单停在方案门，不再继续。${chosen}` }
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain(outcome.title), subtitle: plain(`${ticket.title} · 工单 ${shortId(ticket)}`), template: outcome.template },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown(outcome.body), markdown('决定已记录，可在工单面板查看完整方案与执行过程。',
        { text_size: 'notation' })] },
  }
  return { card, text: textSafe(`${outcome.title}：${ticket.title}。${outcome.body}`) }
}
/**
 * What a TAPD priority card says about the bug, taken from its origin Trigger; every field is optional because a card is
 * still worth sending when TAPD gave fewer facts.
 */
export interface PriorityFacts { shortId?: string; status?: string; tapdPriority?: string; suggestion?: PriorityLevel; reason?: string }
/** The level buttons' colours: P0 is the danger one, P1 the primary, and the two idle levels are plain. */
const priorityButtonType = (level: PriorityLevel): string => level === 'P0' ? 'danger' : level === 'P1' ? 'primary_filled' : 'default'
/** A level as a person reads it, such as `P1 主线`. */
export const priorityLabel = (level: PriorityLevel): string => `${PRIORITY_LABELS[level].code} ${PRIORITY_LABELS[level].word}`
/**
 * A TAPD ticket's priority question: what the bug is, what the system suggests and why, one button per level, and the
 * deadline after which the `P2` default applies and the ticket joins the idle pool. A short chat reply (`p0`–`p3`, 紧急,
 * 不急, 排期) answers it as well, so the card is a question with defaults, not a notification.
 */
export function priorityCard(ticket: Pick<Ticket, 'id' | 'title'>, ask: Pick<PriorityAsk, 'deadline'>, facts: PriorityFacts = {},
  ticketLink?: string): CardMessage {
  const suggested = facts.suggestion ? `**建议** ${priorityLabel(facts.suggestion)}${facts.reason ? `：${facts.reason}` : ''}` : ''
  const source = [facts.shortId ? `TAPD ${facts.shortId}` : '', facts.status ? `状态 ${facts.status}` : '',
    facts.tapdPriority ? `TAPD 优先级 ${facts.tapdPriority}` : ''].filter(Boolean).join(' · ')
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: { title: plain('待确认 · 这张单的优先级'), subtitle: plain(`${clip(ticket.title, 24)} · 工单 ${shortId(ticket)}`), template: 'orange' },
    body: {
      direction: 'vertical', padding: '16px 16px 20px 16px', vertical_spacing: '12px',
      elements: [
        ...source ? [markdown(`**${source}**`, { text_size: 'notation' })] : [],
        ...suggested ? [markdown(suggested)] : [],
        markdown('**优先级**'),
        {
          tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px',
          columns: PRIORITY_LEVELS.map(level => ({ tag: 'column', elements: [{
            tag: 'button', text: plain(priorityLabel(level)), type: priorityButtonType(level), width: 'fill',
            behaviors: [{ type: 'callback', value: { v: 1, priority: level } }],
          }] })),
        },
        { tag: 'hr', margin: '4px 0px 0px 0px' },
        markdown(`⏳ ${deadlineText(ask.deadline)} 前不回复默认 **P2**，进闲时池等系统有空时处理；之后也能随时改。直接回 \`p0\` / \`p1\` / \`p2\` / \`p3\` 也一样。`,
          { text_size: 'notation' }),
        ...ticketLink ? [ticketLinkLine(ticket.id, ticketLink)] : [],
      ],
    },
  }
  const text = textSafe([`待确认 · 这张单的优先级：${ticket.title}（工单 ${shortId(ticket)}）`,
    ...source ? [source] : [], ...suggested ? [suggested.replace(/\*\*/g, '')] : [],
    `选项：${PRIORITY_LEVELS.map(priorityLabel).join(' ｜ ')}`,
    `${deadlineText(ask.deadline)} 前不回复默认 P2，进闲时池；之后也能随时改。`,
    '回 p0 / p1 / p2 / p3，或 紧急 / 不急 / 排期。'].join('\n')) + (ticketLink ? `\n${ticketLinkText(ticket.id, ticketLink)}` : '')
  return { card, text }
}
/** The card that replaces a priority question once it is answered, so the chat record says where the ticket now stands. */
export function priorityResolvedCard(ticket: Pick<Ticket, 'id' | 'title'>, level: PriorityLevel): CardMessage {
  const label = priorityLabel(level)
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain(`已记录 · ${label}`), subtitle: plain(`${clip(ticket.title, 24)} · 工单 ${shortId(ticket)}`), template: 'green' },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown(`这张单按 **${label}** 排队：${PRIORITY_LABELS[level].hint}。`), markdown('之后也能随时改。', { text_size: 'notation' })] },
  }
  return { card, text: textSafe(`已记录 · ${ticket.title} 的优先级是 ${label}（${PRIORITY_LABELS[level].hint}）。`) }
}
/** The card for a click on a priority question that is already settled: idempotent, and it never changes the ticket. */
export function priorityStaleCard(ticketId: string): CardMessage {
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain('已处理 · 这张卡的优先级已记过'), subtitle: plain(`工单 ${ticketId.slice(0, 8)}`), template: 'grey' },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown('这张单的优先级已经有人答过，或者已经默认过了；在工单面板里能看到当前值。')] },
  }
  return { card, text: '已处理 · 这张卡的优先级已记过' }
}
/**
 * A worker's question card: the question in full, then one button per choice the worker wrote (2–4), and the note that a
 * plain chat reply reaches the same ticket. A click carries the attention id, so a card whose question was replaced never
 * answers the newer one.
 */
export function attentionCard(question: string, attentionId: string, options: readonly string[], ticketId?: string, sections?: readonly QuestionSection[],
  ticketLink?: string): CardMessage {
  const body = sections?.filter(section => !section.fold) ?? []
  const folded = sections?.filter(section => section.fold) ?? []
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: plain(`要你选 · ${clip(question, 40)}`),
      subtitle: plain(ticketId ? `工单 ${ticketId.slice(0, 8)} · 人在等你的答复` : '人在等你的答复'),
      template: 'orange',
    },
    body: {
      direction: 'vertical', padding: '16px 16px 20px 16px', vertical_spacing: '12px',
      elements: [
        markdown(`**${question}**`),
        ...body.map(section => block(section.label, section.text)),
        ...folded.length ? [foldPanel(folded, '补充')] : [],
        {
          tag: 'column_set', flex_mode: flexOf(options.length), horizontal_spacing: '8px',
          columns: options.map((option, index) => ({ tag: 'column', elements: [{
            tag: 'button', text: plain(option), type: 'default', width: 'fill',
            behaviors: [{ type: 'callback', value: { v: 1, attention: attentionId, choice: index } }],
          }] })),
        },
        markdown('点一个就行；也可以直接在对话里回复。', { text_size: 'notation' }),
        ...ticketLink && ticketId ? [ticketLinkLine(ticketId, ticketLink)] : [],
      ],
    },
  }
  const text = textSafe([`要你选：${question}`, ...sections?.map(section => blockText(section.label, section.text)) ?? [],
    `可选项：${options.map((option, index) => `${index + 1}. ${option}`).join(' ｜ ')}`,
    '点卡片或直接回复都可以。'].join('\n')) + (ticketLink && ticketId ? `\n${ticketLinkText(ticketId, ticketLink)}` : '')
  return { card, text }
}
/** The card that replaces a question once a person clicked one of its choices. */
export function attentionResolvedCard(question: string, option: string, ticketId?: string): CardMessage {
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain('已收到你的答复 · worker 继续处理'), subtitle: plain(ticketId ? `工单 ${ticketId.slice(0, 8)}` : '问题已记下'), template: 'green' },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown(`你选了：**${option}**`), markdown(question, { text_size: 'notation' }),
        markdown('worker 会按这个继续。', { text_size: 'notation' })] },
  }
  return { card, text: textSafe(`已收到你的答复：${option}（${question}）`) }
}
/** The card for a click on a question that no longer waits: idempotent, and it never changes the ticket. */
export function attentionStaleCard(ticketId?: string): CardMessage {
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain('已处理 · 这个问题不用再答'), subtitle: plain(ticketId ? `工单 ${ticketId.slice(0, 8)}` : '问题已关闭'), template: 'grey' },
    body: { direction: 'vertical', padding: '12px 12px 20px 12px',
      elements: [markdown('这张卡片的问题已经有人答过，或者已经换了一个问题；在工单面板里能看到最新状态。')] },
  }
  return { card, text: '已处理 · 这个问题不用再答' }
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
  return { card, text: textSafe(`已处理：${ticket.title}（这版方案不再等人）`) }
}
/** Replaces a card in place with the delayed-update token its button callback carries (valid 30 minutes, two uses). */
export async function updateCard(host: CardHost, token: string, message: CardMessage): Promise<void> {
  await host.commands.lark(['api', 'POST', '/open-apis/interactive/v1/card/update', '--data',
    jsonForCmd({ token, card: message.card })])
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
    return messageIdOf(await send('--content', jsonForCmd(message.card), 'interactive'))
  } catch {
    // A card Feishu refuses (such as a schema change) still reaches the person as text; anything else would fail there too.
    return messageIdOf(await send('--content', feishuPostContent(message.text), 'post'))
  }
}
