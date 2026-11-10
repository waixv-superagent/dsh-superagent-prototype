/**
 * The Web Source: a request a person submits from the DeepSeek Harness Web panel, which enters the domain as an ordinary
 * explicit Trigger so the main Session assesses it and opens a Ticket exactly as it does for a Feishu message.
 *
 * The panel is the Source's input surface: its request form calls `webTrigger` and hands the result to the Engine. Replies
 * for the Tickets started this way are injected into the main Session, where the person who submitted the request already
 * is, so the panel needs no conversation of its own.
 */
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

/** The one identity the panel submits as: the operator of this loopback-only deployment. */
export const WEB_OPERATOR = 'operator'
/** The Source kind's stable id, and the prefix of its Thread keys. */
export const WEB_SOURCE = 'web'
/** The name the Policy's Web part lists the operator under. */
const OPERATOR_NAME = 'Web panel'

/** The Web Source has no external service, so its configuration is empty. */
export type WebConfig = Record<string, never>
export const WebConfigSchema = z.object({}).strict()

/** What the Web Source's Channel needs from the host: delivery into the main Session. */
export interface WebChannelHost {
  /** Delivers one outbound message into the main Session; `gone` when that Session no longer exists. */
  deliver(message: OutboundMessage): Promise<'sent' | 'gone'>
}

/** What one panel submission carries: the request text, when it was made, and the main Session that receives the replies. */
export interface WebRequest { text: string; at: string; session: string }

/**
 * Build the Trigger for one request submitted from the panel. Each request is its own Thread, like a Feishu direct chat
 * where every message is its own conversation; the Channel addresses the main Session so acknowledgements and replies
 * reach the person there.
 */
export function webTrigger(request: WebRequest): Trigger {
  const thread = key('web', request.at, request.text)
  return {
    id: key('trigger', 'web', thread),
    source: WEB_SOURCE,
    threads: [{ source: WEB_SOURCE, id: thread }],
    actor: { source: WEB_SOURCE, id: WEB_OPERATOR },
    human: true,
    addressed: 'direct',
    at: request.at,
    text: request.text,
    channel: { source: WEB_SOURCE, thread: `${WEB_SOURCE}:${thread}`, address: { session: request.session } },
    meta: { panel: true },
  }
}

/** The Thread label the panel shows for a request: its first line, short enough for a page title. */
export const webLabel = (text: string): string => (text.split('\n')[0] ?? '').trim().slice(0, 100)

/**
 * Build the Trigger for a request a person typed into a worker's Session and the worker handed back: that message reached no
 * Source and left no Trigger, so it enters as a Web request. The Thread is derived from the ticket and the words, so handing
 * the same request back twice is one Trigger rather than two tickets; the host records the ticket's hand-back on it.
 */
export function webHandbackTrigger(request: { ticketId: string; text: string; at: string; session: string }): Trigger {
  const thread = key('web', 'handback', request.ticketId, request.text)
  return {
    id: key('trigger', 'web', thread),
    source: WEB_SOURCE,
    threads: [{ source: WEB_SOURCE, id: thread }],
    actor: { source: WEB_SOURCE, id: WEB_OPERATOR },
    human: true,
    addressed: 'direct',
    at: request.at,
    text: request.text,
    channel: { source: WEB_SOURCE, thread: `${WEB_SOURCE}:${thread}`, address: { session: request.session } },
    meta: { panel: true, handback: true },
  }
}

/**
 * The Web Source kind. It listens to everything it produces (addressed requests only), and its Policy part keeps the
 * panel operator on the allowed list through `sync`: the panel always submits as that one identity, and the list is a
 * Policy record rather than a credential the form could choose.
 * @param host - the delivery into the main Session each Ticket's replies go through.
 */
export const webKind = (host: WebChannelHost): SourceKind<WebConfig> => ({
  kind: WEB_SOURCE,
  title: { zh: 'Web 面板', en: 'Web panel' },
  description: { zh: '在 DeepSeek Harness Web 面板上发起的请求：进入主会话评估，能开工就开单，回复回到主会话。', en: 'Requests submitted from the DeepSeek Harness Web panel: the main Session assesses them, opens a Ticket when the work is clear, and their replies return to the main Session.' },
  schema: WebConfigSchema,
  fields: [],
  health: [],
  // A reply goes into the main Session; an address that names another Session can never receive one.
  channel: {
    allowed: address => typeof address.session === 'string' && address.session.length > 0,
    send: (_host, message) => host.deliver(message),
    link: () => ({ url: '', label: { zh: '主会话', en: 'Main conversation' } }),
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
        .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate ids').default([]),
    }).strict(),
    fields: [],
    explicit: { zh: '面板上发起的请求以操作员（operator）的身份发出，总是明确的请求；面板同步时保证这个身份在名单里。', en: 'A request submitted from the panel is made as the operator and is always an explicit request; syncing the panel keeps that identity on the list.' },
    sync: {
      label: { zh: '同步操作员', en: 'Sync operator' },
      ready: () => true,
      // The panel submits as the operator, so the list must hold it; any other entries a team added stay as they are.
      run: async (_host, part) => part.allowed.some(entry => entry.id === WEB_OPERATOR) ? part
        : { ...part, allowed: [...part.allowed, { id: WEB_OPERATOR, name: OPERATOR_NAME }] },
    },
  },
})
