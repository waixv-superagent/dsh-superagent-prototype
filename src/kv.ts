/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { BillingSnapshot } from './app/billing.ts'
import type { EditorSchedule } from './app/editor-schedule.ts'
import type { GatekeeperState } from './app/editor-gatekeeper.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { ReceiptReaction } from './sources/feishu-receipt.ts'
import type { FeishuSent } from './sources/feishu-sent.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Billing: the rolling model-spend window the board's strip reads across host restarts. */
  billing: { snapshot: record<BillingSnapshot>('billing-snapshot') },
  /** EditorScheduler: the shared editor's lease, wait queue, host-run jobs and recent events (docs/021). */
  editor: { schedule: record<EditorSchedule>('editor-lease'),
    /** EditorGatekeeper: the processes each lease started, so a lapsed heartbeat can close them (docs/021). */
    gatekeeper: record<GatekeeperState>('editor-owned') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; the topics an addressed message has activated; per-polled-thread seen message IDs and
   * initialization flag; and the receipt reactions the bot holds on the messages it took, by message ID.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    /** `<chat>:<root>` to the time of its last addressed message; messages in the topic count as addressed until it expires. */
    active: record<Record<string, string>>('feishu-active-topics'),
    receipts: record<Record<string, ReceiptReaction>>('feishu-receipts'),
    /** Plan card `message_id` to the ticket, plan and message link it asks about, so a button click decides without a Trigger. */
    cards: record<Record<string, { ticketId: string; planAt: string; url?: string }>>('feishu-plan-cards'),
    /** Question message (card or plain text) `message_id` to the ticket, attention, and its own message link, so a click
     * answers it and the panel's answer button opens the question rather than the chat. */
    attentionCards: record<Record<string, { ticketId: string; attentionId: string; at: string; url?: string }>>('feishu-attention-cards'),
    /** Priority card `message_id` to the ticket and the priority question it asks, so a button click records the level. */
    priorityCards: record<Record<string, { ticketId: string; askAt: string; url?: string }>>('feishu-priority-cards'),
    /**
     * A message the bot sent for a ticket, by its `message_id`: the reverse index that turns a bot message a person copied
     * from Feishu (its id, or the topic it sits in) back into the ticket. Kept like outbox receipts, one small row each.
     */
    sent: family<FeishuSent, [message: string]>('feishu-sent:'),
    /** Pipeline stage card `message_id` to the ticket it is about, so a click on its reviewer, send, rerun or close action finds it. */
    pipelineCards: record<Record<string, { ticketId: string; at: string }>>('feishu-pipeline-cards'),
    /** Control messages (挂起/恢复) already applied, by message ID and time, so a history replay never toggles processing again. */
    controls: record<Record<string, string>>('feishu-controls'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
