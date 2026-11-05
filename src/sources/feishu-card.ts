/**
 * Feishu interactive cards: the P1 plan gate's decision brief (with the choices the worker writes), a question card whose
 * buttons answer a worker's `human_action`, a TAPD ticket's priority question, the forms for a typed direction, the cards
 * that record an answer, and the text fallback when Feishu refuses a card.
 */
import { PLAN_CARD_QUESTION, PLAN_REPLY_HINT, PLAN_TEMPLATES, PRIORITY_LABELS, PRIORITY_LEVELS, planLines, planTemplate, type Plan, type PlanDecision,
  type PlanDiff, type PlanOption, type PlanTemplate, type PipelineCard, type PriorityAsk, type PriorityLevel, type QuestionSection, type Ticket } from '../core/index.ts'
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
/**
 * Every card's frame, so they read alike: the header says what state the card is in (its colour is that state, its title
 * a few words such as `待确认 · 方案`) and which ticket it is about, the body says the content once, and the chat list
 * previews the card by `summary` rather than by a generic "[卡片]". The header never repeats the question the body leads
 * with, and the ticket id appears once: in the footer link when there is one, else in the subtitle.
 */
const shell = (input: { title: string; subtitle?: string; template: string; summary: string; elements: Record<string, unknown>[] }):
  Record<string, unknown> => ({
  schema: '2.0',
  config: { update_multi: true, width_mode: 'default', summary: { content: textSafe(clip(input.summary, 60)) } },
  header: { title: plain(input.title), ...input.subtitle ? { subtitle: plain(input.subtitle) } : {}, template: input.template },
  body: { direction: 'vertical', padding: '12px 16px 16px 16px', vertical_spacing: '12px', elements: input.elements },
})
/**
 * The subtitle that names a ticket: its title, plus its short id only when no footer link carries the id already. With the
 * id after it the title keeps 14 characters, so the subtitle still fits one line of a 375px phone and does not push the
 * buttons down; the body names the question in full.
 */
const ticketSubtitle = (ticket: Pick<Ticket, 'id' | 'title'>, linked: boolean): string =>
  linked ? clip(ticket.title, 24) : `${clip(ticket.title, 14)} · 工单 ${shortId(ticket)}`
/**
 * The small grey closing lines of a card, joined into one block so the card ends with one quiet paragraph instead of a stack
 * of separate notes: what happens next, the deadline, and the way back to the ticket on the last line.
 */
const footer = (lines: readonly string[], ticketId?: string, link?: string): Record<string, unknown> | undefined => {
  const all = [...lines.filter(Boolean)]
  if (ticketId && link) all.push(ticketLinkText(ticketId, link))
  // The link line is built without markdown's rewrite (see ticketLinkLine), so the notes are made safe on their own.
  return all.length ? { tag: 'markdown', content: all.map((line, index) => index === all.length - 1 && ticketId && link ? line : textSafe(line)).join('\n'),
    text_size: 'notation' } : undefined
}
/** The plan's lines by label; a card shows the lines the worker wrote and `—` for one it left out (the gate refuses those). */
const linesOf = (text: string, template: PlanTemplate = 'fix'): Map<string, string> => new Map(planLines(text, template).map(line => [line.label, line.text]))
/** How many files a card names before it only says how many more the diff changes. */
const CARD_DIFF_FILES = 3
/** A changed file's path as a card line: a long depot path keeps its tail, where the file name is. */
const diffPath = (path: string): string => {
  const chars = Array.from(path)
  return chars.length <= 64 ? path : `…${chars.slice(chars.length - 63).join('')}`
}
/**
 * The plan's code diff as a card can carry it: how many files and lines it changes, the baseline, and the first files.
 * Hunks are unreadable in a chat card, so the panel page renders them (inline or side by side) and this block only
 * says what the change costs; without a panel link it stays a summary.
 */
const diffBlock = (diff: PlanDiff): Record<string, unknown> => {
  const lines = [`**代码改动 · ${diff.files.length} 个文件 · +${diff.added} −${diff.removed}**`,
    ...diff.base ? [`对比基线：${diff.base}`] : [],
    ...diff.files.slice(0, CARD_DIFF_FILES).map(file => `• ${diffPath(file.path)}${file.binary ? '（二进制）' : ` +${file.added} −${file.removed}`}`),
    ...diff.files.length > CARD_DIFF_FILES ? [`• 等 ${diff.files.length} 个文件`] : []]
  return markdown(lines.join('\n'))
}
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
const buttonType = (decision: PlanDecision): string => decision === 'approve' ? 'primary_filled' : decision === 'stop' ? 'danger' : 'default'
/** A label's width in CJK characters: a Latin letter, digit or space is about half as wide as a Chinese character. */
const labelWidth = (label: string): number => Array.from(label).reduce((width, char) => width + (/[\u0000-\u024f]/u.test(char) ? 0.5 : 1), 0)
/**
 * The widest label that still fits one row of equal buttons on a 375px phone: a card's content area there is about 300px,
 * a third of it holds four Chinese characters beside the button's own padding, and half of it holds six.
 */
const rowFits = (labels: readonly string[]): boolean =>
  labels.length >= 2 && labels.length <= 3 && labels.every(label => labelWidth(label) <= (labels.length === 2 ? 6 : 4))
/** One choice as the card shows it: its button and, when the worker wrote one, what choosing it means. */
export interface CardChoice { button: Record<string, unknown>; description?: string }
/**
 * The choices of a card. Short labels share one row, split in halves or thirds. Anything longer, four choices, or choices
 * with descriptions get one full-width button per line, each description in small text right under its button, so a phone
 * never cuts a label into an ellipsis and a consequence is read beside the button it belongs to.
 */
const choiceRows = (choices: readonly CardChoice[], labels: readonly string[]): Record<string, unknown>[] => {
  if (rowFits(labels) && !choices.some(choice => choice.description)) {
    return [{
      tag: 'column_set', flex_mode: labels.length === 2 ? 'bisect' : 'trisect', horizontal_spacing: '8px',
      columns: choices.map(choice => ({ tag: 'column', elements: [choice.button] })),
    }]
  }
  return choices.map(choice => ({
    tag: 'column_set', flex_mode: 'none',
    columns: [{ tag: 'column', width: 'weighted', weight: 1, vertical_spacing: '4px', elements: [choice.button,
      ...choice.description ? [markdown(choice.description, { text_size: 'notation' })] : []] }],
  }))
}
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
    // One section is named; several are counted, so the header stays one short line on a phone (the labels are inside).
    title: plain(sections.length === 1 ? `${title} · ${sections[0]?.label ?? ''}` : `${title} · ${sections.length} 项`),
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
/** What a plan card's header calls the plan, by template: a fix plan, an analysis, a design choice. */
const PLAN_KIND: Readonly<Record<PlanTemplate, string>> = { fix: '方案', analysis: '分析', design: '取舍' }
/** A row of equal buttons for a card's own controls (priority levels, 返回方案), where no label is long. */
const buttonRow = (buttons: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  tag: 'column_set', flex_mode: buttons.length <= 2 ? 'bisect' : buttons.length === 3 ? 'trisect' : 'flow', horizontal_spacing: '8px',
  columns: buttons.map(button => ({ tag: 'column', elements: [button] })),
})
/**
 * The P1 plan gate card as a decision brief. The header says only the state and the kind (`待确认 · 方案`) and which ticket;
 * the body leads with the one question the person answers, then the plan's key lines for its template in full (the fix
 * template leads with 现象/修复锚点/影响面/预算, an analysis with 问题/结论/建议, a design with 问题/推荐), the rest folded
 * behind one tap, what each choice means when the worker described them, and the 2–4 buttons (the standard three when it
 * wrote none). One grey footer closes the card: what approving does, the deadline and the link to the ticket. The chat list
 * previews the card by its question. The text fallback carries the key lines and the labels in full, since only a person
 * who cannot see the card reads it.
 */
export function planCard(ticket: Pick<Ticket, 'id' | 'title'>, plan: Pick<Plan, 'text' | 'template' | 'question' | 'options' | 'deadline' | 'sections' | 'diff'>,
  ticketLink?: string): CardMessage {
  const template = planTemplate(plan)
  const lines = linesOf(plan.text, template)
  const get = (label: string): string => lines.get(label) ?? ''
  const layout = { front: [...PLAN_LAYOUTS[template].front], fold: [...PLAN_LAYOUTS[template].fold] }
  const choices = planChoices(plan)
  const question = plan.question || PLAN_CARD_QUESTION
  const custom = plan.sections?.length ? plan.sections : undefined
  const body = custom?.filter(section => !section.fold) ?? []
  const folded = custom?.filter(section => section.fold) ?? []
  const card = shell({
    title: `待确认 · ${PLAN_KIND[template]}`, subtitle: ticketSubtitle(ticket, !!ticketLink), template: 'blue', summary: `待确认：${question}`,
    elements: [
      markdown(`**${question}**`, { text_size: 'heading' }),
      ...body.length ? body.map(section => block(section.label, section.text))
        : custom ? [] : layout.front.map(label => block(label, get(label), ['影响面', '预算'].includes(label) ? { text_size: 'notation' } : {})),
      ...plan.diff ? [diffBlock(plan.diff), ...ticketLink ? [markdown(`[在面板看完整 diff（内联 / 并排）](${ticketLink})`, { text_size: 'notation' })] : []] : [],
      ...folded.length ? [foldPanel(folded, '补充')] : custom ? [] : [evidencePanel(layout.fold.map(label => ({ label, text: get(label) || '—' })))],
      { tag: 'hr', margin: '0px 0px 0px 0px' },
      ...choiceRows(choices.map((choice, index) => ({
        button: decisionButton(choice.label, buttonType(choice.decision), choice.decision, index),
        ...choice.description ? { description: choice.description } : {},
      })), choices.map(choice => choice.label)),
      footer(['通过后开始实现，交付前再请你确认，不会直接 submit', ...plan.deadline ? [`⏳ ${deadlineText(plan.deadline)} 前不答会自动停`] : []],
        ticket.id, ticketLink)!,
    ],
  })
  const context = custom ?? layout.front.map(label => ({ label, text: get(label) || '—' }))
  const diffText = plan.diff ? `代码改动：${plan.diff.files.length} 个文件 +${plan.diff.added} −${plan.diff.removed}`
    + `${plan.diff.base ? `（对比 ${plan.diff.base}）` : ''}；逐行 diff 在工单面板里，可切内联 / 并排。` : ''
  const text = textSafe([`待确认 · ${PLAN_KIND[template]}：${ticket.title}（工单 ${shortId(ticket)}）`,
    `要你定：${question}`,
    ...context.map(section => blockText(section.label, section.text)),
    diffText,
    '通过后：开始实现，交付前再请你确认；不会直接 submit。',
    `选项：${choices.map(choice => choice.description ? `${choice.label}（${choice.description}）` : choice.label).join(' ｜ ')}`,
    custom ? '' : `证据（${layout.fold.join('/')}）在卡片折叠与工单面板里。`, PLAN_REPLY_HINT].filter(Boolean).join('\n'))
    + (ticketLink ? `\n${ticketLinkText(ticket.id, ticketLink)}` : '')
  return { card, text }
}
/**
 * The card a click on 改一下 turns into: it keeps the original question and the whole plan one tap away, so switching views
 * no longer hides what is being revised, and it offers a way back to the plan card. The form itself cannot upload files, so
 * the footer sends a person with a screenshot to reply to the card instead of losing the evidence.
 */
export function reviseCard(ticket: Pick<Ticket, 'id' | 'title'>, plan: Pick<Plan, 'text' | 'template' | 'question'>): CardMessage {
  const question = plan.question?.trim() || PLAN_CARD_QUESTION
  const card = shell({
    title: '改一下 · 写一句新方向', subtitle: ticketSubtitle(ticket, false), template: 'orange', summary: `改一下：${question}`,
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
      {
        tag: 'form', name: 'plan_revise', vertical_spacing: '8px',
        elements: [
          // A chat box: three lines tall, growing to eight on desktop (a phone keeps three and scrolls); a return is a new line.
          { tag: 'input', name: 'note', input_type: 'multiline_text', rows: REVISE_ROWS, auto_resize: true, max_rows: REVISE_MAX_ROWS,
            width: 'fill', required: true, max_length: 1000, placeholder: plain('写新方向，可以分几行写') },
          { tag: 'button', name: 'submit_revise', form_action_type: 'submit', type: 'primary_filled', width: 'fill',
            text: plain('提交新方向') },
        ],
      },
      buttonRow([{ tag: 'button', width: 'fill', text: plain('返回方案'), type: 'default',
        behaviors: [{ type: 'callback', value: { v: 1, back: true } }] }]),
      footer(['提交后 worker 按新方向重出方案；要贴图，直接回复这张卡'])!,
    ],
  })
  return { card, text: textSafe(`改一下 · ${ticket.title}：回复 2 并附一句新方向；原方案见上一条方案卡。`) }
}
/** The 改一下 input's starting height and the height it grows to, in lines. */
const REVISE_ROWS = 3
const REVISE_MAX_ROWS = 8
/** A person's note as the lines they wrote: Windows and old Mac returns read as one, and blank lines at either end go. */
const noteLines = (note: string): string[] => {
  const lines = note.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines
}
/** The card that replaces the question once a person answered, so the chat record says what was decided. */
export function resolvedCard(ticket: Pick<Ticket, 'id' | 'title'>, decision: PlanDecision, note = '', option = ''): CardMessage {
  const chosen = option ? `你选的是「${option}」。` : ''
  const lines = noteLines(note)
  // A direction written over several lines keeps them: it is shown as its own grey block, one line per line the person wrote.
  const direction = decision === 'revise' && lines.length > 1 ? lines : []
  const outcome = decision === 'approve' ? { title: '已通过 · 开始实现', template: 'green', body: `${chosen}worker 进入实现阶段，交付前会再请你确认。` }
    : decision === 'revise' ? { title: '已换方向 · 等新方案', template: 'orange',
        body: direction.length ? `${chosen}新方向：` : `${chosen}新方向：${lines[0] ?? '（没有附说明）'}` }
      : { title: '已停止', template: 'red', body: `${chosen}这个工单停在方案门，不再继续。` }
  const card = shell({ title: outcome.title, subtitle: ticketSubtitle(ticket, false), template: outcome.template,
    summary: `${outcome.title}：${ticket.title}`, elements: [markdown(outcome.body),
      ...direction.length ? [{ tag: 'column_set', flex_mode: 'none', background_style: 'grey-50', margin: '0px 0px 0px 0px',
        columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '8px 12px 8px 12px',
          elements: [{ tag: 'markdown', content: textSafe(direction.join('\n')) }] }] }] : []] })
  const said = direction.length ? `${outcome.body}\n${direction.join('\n')}` : outcome.body
  return { card, text: textSafe(`${outcome.title}：${ticket.title}。${said}`) }
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
  const suggested = facts.suggestion ? `**建议 ${priorityLabel(facts.suggestion)}**${facts.reason ? `：${facts.reason}` : ''}` : ''
  const source = [facts.shortId ? `TAPD ${facts.shortId}` : '', facts.status ? `状态 ${facts.status}` : '',
    facts.tapdPriority ? `TAPD 优先级 ${facts.tapdPriority}` : ''].filter(Boolean).join(' · ')
  const card = shell({
    title: '待确认 · 优先级', subtitle: ticketSubtitle(ticket, !!ticketLink), template: 'orange', summary: `定优先级：${ticket.title}`,
    elements: [
      ...source || suggested ? [markdown([source, suggested].filter(Boolean).join('\n'))] : [],
      buttonRow(PRIORITY_LEVELS.map(level => ({
        tag: 'button', text: plain(priorityLabel(level)), type: priorityButtonType(level), width: 'fill',
        behaviors: [{ type: 'callback', value: { v: 1, priority: level } }],
      }))),
      footer([`⏳ ${deadlineText(ask.deadline)} 前不选默认 P2（闲时处理），之后随时能改`, '直接回 p0–p3 也行'], ticket.id, ticketLink)!,
    ],
  })
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
  const card = shell({ title: `已记录 · ${label}`, subtitle: ticketSubtitle(ticket, false), template: 'green', summary: `优先级 ${label}：${ticket.title}`,
    elements: [markdown(`${PRIORITY_LABELS[level].hint}。之后也能随时改。`)] })
  return { card, text: textSafe(`已记录 · ${ticket.title} 的优先级是 ${label}（${PRIORITY_LABELS[level].hint}）。`) }
}
/** A grey "already handled" card: one line on why the click changed nothing, and where the current state is. */
const handledCard = (title: string, subtitle: string, line: string): Record<string, unknown> =>
  shell({ title, subtitle, template: 'grey', summary: title, elements: [markdown(line, { text_size: 'notation' })] })
/** The card for a click on a priority question that is already settled: idempotent, and it never changes the ticket. */
export function priorityStaleCard(ticketId: string): CardMessage {
  return { card: handledCard('已处理 · 优先级已记过', `工单 ${ticketId.slice(0, 8)}`, '已经有人答过或已按默认处理，当前值在工单面板里。'),
    text: '已处理 · 这张卡的优先级已记过' }
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
  const linked = !!ticketLink && !!ticketId
  const card = shell({
    title: '要你选', ...ticketId && !linked ? { subtitle: `工单 ${ticketId.slice(0, 8)}` } : {}, template: 'orange', summary: `要你选：${question}`,
    elements: [
      markdown(`**${question}**`, { text_size: 'heading' }),
      ...body.map(section => block(section.label, section.text)),
      ...folded.length ? [foldPanel(folded, '补充')] : [],
      ...choiceRows(options.map((option, index) => ({ button: {
        tag: 'button', text: plain(option), type: 'default', width: 'fill',
        behaviors: [{ type: 'callback', value: { v: 1, attention: attentionId, choice: index } }],
      } })), options),
      footer(['点一个就行，也可以直接回复'], ticketId, linked ? ticketLink : undefined)!,
    ],
  })
  const text = textSafe([`要你选：${question}`, ...sections?.map(section => blockText(section.label, section.text)) ?? [],
    `可选项：${options.map((option, index) => `${index + 1}. ${option}`).join(' ｜ ')}`,
    '点卡片或直接回复都可以。'].join('\n')) + (linked ? `\n${ticketLinkText(ticketId, ticketLink)}` : '')
  return { card, text }
}
/** The card that replaces a question once a person clicked one of its choices. */
export function attentionResolvedCard(question: string, option: string, ticketId?: string): CardMessage {
  const card = shell({
    title: '已收到你的答复 · worker 继续处理', ...ticketId ? { subtitle: `工单 ${ticketId.slice(0, 8)}` } : {}, template: 'green',
    summary: `你选了：${option}`,
    elements: [markdown(`你选了：**${option}**`), markdown(question, { text_size: 'notation' })],
  })
  return { card, text: textSafe(`已收到你的答复：${option}（${question}）`) }
}
/** The card for a click on a question that no longer waits: idempotent, and it never changes the ticket. */
export function attentionStaleCard(ticketId?: string): CardMessage {
  return { card: handledCard('已处理 · 这个问题不用再答', ticketId ? `工单 ${ticketId.slice(0, 8)}` : '问题已关闭',
    '已经有人答过，或已换成新问题，最新状态在工单面板里。'), text: '已处理 · 这个问题不用再答' }
}
/** The card for a click on a plan that no longer waits: idempotent, and it never changes the ticket. */
export function staleCard(ticket: Pick<Ticket, 'id' | 'title'>): CardMessage {
  return { card: handledCard('已处理 · 这版方案不再等人', ticketSubtitle(ticket, false), '已经有人答过，或已换成新一版，最新状态在工单面板里。'),
    text: textSafe(`已处理：${ticket.title}（这版方案不再等人）`) }
}
/** Feishu's "open in the system browser" switch: Jenkins and Swarm ask for a login the embedded web view cannot show. */
export function browserLink (url: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { return url }
  if (!/^https?:$/.test(parsed.protocol)) return url
  for (const name of ['lk_jump_to_browser', 'lk_mobile_jump_to_browser']) if (!parsed.searchParams.has(name)) parsed.searchParams.append(name, 'true')
  return parsed.href
}
const PIPELINE_TEMPLATES: Record<PipelineCard['tone'], string> = { info: 'blue', success: 'green', waiting: 'orange', danger: 'red' }
/** A button that opens a link in the system browser. */
const linkButton = (label: string, url: string, primary = false): Record<string, unknown> => ({
  tag: 'button', text: plain(label), type: primary ? 'primary' : 'default', width: 'fill',
  behaviors: [{ type: 'open_url', default_url: browserLink(url), pc_url: browserLink(url), android_url: browserLink(url), ios_url: browserLink(url) }],
})
/** A pipeline card button that calls this plugin back with an action on the ticket. */
const pipelineButton = (label: string, ticketId: string, action: 'reviewers' | 'send' | 'close' | 'rerun', type: string,
  extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag: 'button', text: plain(label), type, width: 'fill',
  behaviors: [{ type: 'callback', value: { v: 1, pipeline: action, ticket: ticketId } }], ...extra,
})
/** A form with a multi-select of `options` and one submit button, for reviewers or package targets. */
const choiceForm = (name: string, placeholder: string, options: readonly { label: string; value: string }[], submit: Record<string, unknown>): Record<string, unknown> => ({
  tag: 'form', name,
  elements: [
    { tag: 'multi_select_static', name: 'choice', placeholder: plain(placeholder), required: true, width: 'fill',
      options: options.map(option => ({ text: plain(option.label), value: option.value })) },
    submit,
  ],
})
/**
 * One stage of a delivered change's pipeline as a card: a coloured headline (blue running, green passed, orange waiting,
 * red failed), one or two short lines, the review and build links (opened in the system browser, where their login works),
 * and the actions this stage offers — pick reviewers to add on Swarm, rerun the checks, send the editor package to people or
 * chats, or close the ticket. The text fallback is the same one-line notice the chat used to get.
 */
export function pipelineStageCard (notice: PipelineCard, text: string, ticketLink?: string): CardMessage {
  const id = notice.ticketId
  const links = notice.links.map((link, index) => linkButton(link.label, link.url, index === 0 && !notice.reviewers && !notice.targets))
  const actions: Record<string, unknown>[] = []
  if (notice.reviewers?.length) {
    actions.push(choiceForm('pipeline_reviewers', '选审核人（可多选）', notice.reviewers,
      pipelineButton('发到 Swarm', id, 'reviewers', 'primary_filled', { name: 'submit_reviewers', form_action_type: 'submit' })))
  }
  if (notice.targets?.length) {
    actions.push(choiceForm('pipeline_send', '选人或群（可多选）', notice.targets,
      pipelineButton('发送编辑器包', id, 'send', 'primary_filled', { name: 'submit_send', form_action_type: 'submit' })))
  }
  const own = [
    ...notice.rerun ? [pipelineButton('重跑检查', id, 'rerun', 'default')] : [],
    ...notice.close ? [pipelineButton('关单', id, 'close', 'default', { confirm: { title: plain('关单？'), text: plain('关单后工单结束，不再跟进 autobuild。') } })] : [],
  ]
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: { title: plain(notice.heading), subtitle: plain(`${clip(notice.title, 30)} · 工单 ${id.slice(0, 8)}`), template: PIPELINE_TEMPLATES[notice.tone] },
    body: {
      direction: 'vertical', padding: '12px 12px 16px 12px', vertical_spacing: '10px',
      elements: [
        ...notice.lines.length ? [markdown(notice.lines.join('\n'))] : [],
        ...links.length ? [buttonRow(links)] : [],
        ...actions,
        ...own.length ? [buttonRow(own)] : [],
        ...ticketLink ? [ticketLinkLine(id, ticketLink)] : [],
      ],
    },
  }
  return { card, text: textSafe(text) }
}
/** The card that replaces a pipeline card after a click: what was done, or why it could not be. */
export function pipelineResultCard (ticket: Pick<Ticket, 'id' | 'title'>, outcome: { ok: boolean; heading: string; line: string }): CardMessage {
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain(outcome.heading), subtitle: plain(`${clip(ticket.title, 30)} · 工单 ${shortId(ticket)}`), template: outcome.ok ? 'green' : 'red' },
    body: { direction: 'vertical', padding: '12px 12px 16px 12px', elements: [markdown(outcome.line)] },
  }
  return { card, text: textSafe(`${outcome.heading}：${outcome.line}`) }
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
