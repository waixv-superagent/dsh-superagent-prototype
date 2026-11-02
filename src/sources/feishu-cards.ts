/**
 * `card.action.trigger` handling: a person's click on a plan card decides the ticket directly, with no Trigger, Eval, or
 * chat round-trip. The card's message id maps to the ticket and plan it asked about, and the callback's delayed-update
 * token replaces the card with the recorded answer.
 */
import { z } from 'zod'
import { pendingPlan, type PlanDecision } from '../core/index.ts'
import { KV } from '../kv.ts'
import { attentionResolvedCard, attentionStaleCard, planCard, planChoices, resolvedCard, reviseCard, staleCard, updateCard, type CardMessage } from './feishu-card.ts'
import type { SourceContext } from './host.ts'

/** The fields of a card callback this plugin reads; `card_content` is large and unnecessary because the card is rebuilt. */
export const CardActionSchema = z.object({
  type: z.literal('card.action.trigger').optional(),
  event_id: z.string().min(1),
  operator_id: z.string().min(1),
  message_id: z.string().min(1),
  chat_id: z.string().optional(),
  token: z.string().optional(),
  action_tag: z.string().optional(),
  action_value: z.string().optional(),
  action_name: z.string().optional(),
  form_value: z.string().optional(),
})
export type CardAction = z.infer<typeof CardActionSchema>
const decisions: readonly PlanDecision[] = ['approve', 'revise', 'stop']
/** The button's `action_value`, JSON-serialized by Feishu; an unknown shape is ignored rather than guessed. A plan card
 * carries the choice's index, not its label, so no worker text has to survive the command line inside the card's JSON.
 * The 改一下 form's 返回方案 button carries only `back`, which changes no plan decision. */
export function actionValue(value: string | undefined): { decision?: PlanDecision; note?: string; choice?: number; back?: boolean } | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { decision?: unknown; note?: unknown; choice?: unknown; back?: unknown }
    if (parsed?.back === true) return { back: true }
    const decision = decisions.find(item => item === parsed?.decision)
    if (!decision) return undefined
    const choice = typeof parsed.choice === 'number' && Number.isInteger(parsed.choice) && parsed.choice >= 0 ? parsed.choice : undefined
    return { decision, note: typeof parsed.note === 'string' ? parsed.note.trim() : '', ...choice !== undefined ? { choice } : {} }
  } catch { return undefined }
}
/** The button's value on a question card: the attention it answers and the index of the choice it carries. */
export function attentionValue(value: string | undefined): { attentionId: string; choice: number } | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { attention?: unknown; choice?: unknown }
    if (typeof parsed?.attention !== 'string' || !parsed.attention.trim()) return undefined
    if (typeof parsed.choice !== 'number' || !Number.isInteger(parsed.choice) || parsed.choice < 0) return undefined
    return { attentionId: parsed.attention, choice: parsed.choice }
  } catch { return undefined }
}
/** The text a form submit carries under its `note` field. */
export function formNote(value: string | undefined): string {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value) as { note?: unknown }
    return typeof parsed?.note === 'string' ? parsed.note.trim() : ''
  } catch { return '' }
}
/**
 * Applies one card callback. A question card's click answers the worker's `human_action`; a plan click on 改一下 replaces
 * the card with a form first; a revise choice that carries a note decides directly. Every step is idempotent: a card whose
 * plan or question no longer waits is answered with the "already handled" card and changes nothing. Only the ticket's own
 * actor may decide it.
 */
export async function handleCardAction(ctx: SourceContext, action: CardAction): Promise<void> {
  const asked = attentionValue(action.action_value)
  if (asked) { await handleAttentionAction(ctx, action, asked); return }
  const ref = (ctx.state.get(KV.feishu.cards) ?? {})[action.message_id]
  if (!ref) return
  const ticket = ctx.tickets.get(ref.ticketId)
  if (!ticket) return
  if (ticket.mandate.actor.source !== 'feishu' || ticket.mandate.actor.id !== action.operator_id) return
  const replace = async (message: CardMessage): Promise<void> => {
    if (!action.token) return
    // The decision is already recorded when this runs; a stale token must not fail the callback.
    try { await updateCard({ commands: ctx.commands }, action.token, message) } catch { /* the card stays as it was */ }
  }
  const plan = pendingPlan(ticket)
  /** A card whose plan no longer waits can decide nothing more, so its mapping goes even when the update fails. */
  const forget = (): void => {
    const cards = { ...(ctx.state.get(KV.feishu.cards) ?? {}) }
    delete cards[action.message_id]
    ctx.state.set(KV.feishu.cards, cards)
  }
  if (!plan || plan.at !== ref.planAt) { forget(); await replace(staleCard(ticket)); return }
  const value = actionValue(action.action_value)
  // The form's 返回方案 button returns to the plan card without deciding anything; its mapping stays, so the card still decides.
  if (value?.back) { await replace(planCard(ticket, plan)); return }
  // A form submit carries the form's fields, not the submit button's decision value: the only form on a plan card is 改一下.
  const submitted = !!action.form_value
  if (!value && !submitted) return
  const decision = value?.decision ?? 'revise'
  const chosen = value?.choice !== undefined ? planChoices(plan)[value.choice] : undefined
  if (decision === 'revise' && !submitted && !chosen?.note) { await replace(reviseCard(ticket, plan)); return }
  const note = formNote(action.form_value) || chosen?.note || value?.note || ''
  const option = chosen?.label || ''
  try { ctx.decidePlan(ticket.id, decision, note, 'feishu', option) } catch { forget(); await replace(staleCard(ticket)); return }
  forget()
  await replace(resolvedCard(ticket, decision, note, option))
}
/**
 * Applies a click on a worker's question card: the choice becomes the person's answer to the worker, and the mapping goes.
 * A question that was answered, replaced, or already gone answers with the "already handled" card and changes nothing.
 */
async function handleAttentionAction(ctx: SourceContext, action: CardAction,
  value: { attentionId: string; choice: number }): Promise<void> {
  const cards = ctx.state.get(KV.feishu.attentionCards) ?? {}
  const ref = cards[action.message_id]
  if (!ref) return
  const ticket = ctx.tickets.get(ref.ticketId)
  if (!ticket) return
  if (ticket.mandate.actor.source !== 'feishu' || ticket.mandate.actor.id !== action.operator_id) return
  const replace = async (message: CardMessage): Promise<void> => {
    if (!action.token) return
    try { await updateCard({ commands: ctx.commands }, action.token, message) } catch { /* the card stays as it was */ }
  }
  const forget = (): void => {
    const next = { ...cards }
    delete next[action.message_id]
    ctx.state.set(KV.feishu.attentionCards, next)
  }
  const current = ticket.attention
  const option = current?.options?.[value.choice]
  if (!current || current.id !== value.attentionId || ref.attentionId !== value.attentionId || !option) {
    forget(); await replace(attentionStaleCard(ref.ticketId)); return
  }
  try { ctx.answerAttention(ticket.id, value.attentionId, option) } catch { forget(); await replace(attentionStaleCard(ref.ticketId)); return }
  forget()
  await replace(attentionResolvedCard(current.question, option, ticket.id))
}
