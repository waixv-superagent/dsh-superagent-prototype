/**
 * `card.action.trigger` handling: a person's click on a plan card decides the ticket directly, with no Trigger, Eval, or
 * chat round-trip. The card's message id maps to the ticket and plan it asked about, and the callback's delayed-update
 * token replaces the card with the recorded answer.
 */
import { z } from 'zod'
import { pendingPlan, type PlanDecision } from '../core/index.ts'
import { KV } from '../kv.ts'
import { resolvedCard, reviseCard, staleCard, updateCard } from './feishu-card.ts'
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
/** The button's `action_value`, JSON-serialized by Feishu; an unknown shape is ignored rather than guessed. */
export function actionValue(value: string | undefined): { decision: PlanDecision; note: string } | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { decision?: unknown; note?: unknown }
    const decision = decisions.find(item => item === parsed?.decision)
    if (!decision) return undefined
    return { decision, note: typeof parsed.note === 'string' ? parsed.note.trim() : '' }
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
 * Applies one card callback. A click on 改一下 replaces the card with a form first; the form's submit carries the note.
 * Every step is idempotent: a card whose plan no longer waits is answered with the "already handled" card and changes
 * nothing. Only the ticket's own actor may decide it.
 */
export async function handleCardAction(ctx: SourceContext, action: CardAction): Promise<void> {
  const ref = (ctx.state.get(KV.feishu.cards) ?? {})[action.message_id]
  if (!ref) return
  const ticket = ctx.tickets.get(ref.ticketId)
  if (!ticket) return
  if (ticket.mandate.actor.source !== 'feishu' || ticket.mandate.actor.id !== action.operator_id) return
  const replace = async (message: ReturnType<typeof staleCard>): Promise<void> => {
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
  if (!value) return
  if (value.decision === 'revise' && !action.form_value) { await replace(reviseCard(ticket)); return }
  const note = formNote(action.form_value) || value.note
  try { ctx.decidePlan(ticket.id, value.decision, note, 'feishu') } catch { forget(); await replace(staleCard(ticket)); return }
  forget()
  await replace(resolvedCard(ticket, value.decision, note))
}
