/** Who a ticket's milestone card should mention on Feishu, from the ticket itself rather than from a guess. */
import type { Ticket } from '../core/index.ts'
import { FEISHU_OPEN_ID } from '../sources/feishu-text.ts'
import type { Store } from './store.ts'

/**
 * The Feishu open_id a ticket's plan, grill or pipeline milestone should mention: the person whose Feishu message started
 * it, else the first person the Feishu Policy allows, since the Source opens that ticket's Feishu conversation for them.
 * Undefined when the ticket has no Feishu actor and the Policy lists nobody: the message still goes out, without an @.
 */
export function mentionTargetOf(store: Pick<Store, 'settings' | 'triggers'>, ticket: Pick<Ticket, 'mandate' | 'origin'>): string | undefined {
  const actor = ticket.mandate?.actor
  if (actor?.source === 'feishu' && FEISHU_OPEN_ID.test(actor.id)) {
    // A bot or CI message can start a proactive ticket; its id is a Feishu identity but nobody is paged for it.
    const trigger = store.triggers.get(ticket.origin?.triggerId ?? '')
    if (trigger?.human) return actor.id
  }
  const allowed = store.settings().policy?.sources?.feishu?.allowed ?? []
  return allowed.find(entry => FEISHU_OPEN_ID.test(entry.id))?.id
}
