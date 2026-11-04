/**
 * Ticket priority: the four levels, who decided a level and, above all, the rule that only a person may set `P0`.
 * A TAPD bug starts with a question of its own (`priorityAsk`): until a person answers it the ticket does not start, and an
 * unanswered question falls back to `P2` after `priorityAskMin` minutes, after which the ticket waits in the idle pool
 * instead of competing with the mainline. A person's mention is `P1` by default, and anything the system decides besides a
 * person's explicit words is a default that a person may change at any time.
 */
import type { Ticket, Trigger } from './model.ts'

/** The levels, from the only one a person may declare to the one that waits the longest: `P0` 紧急, `P1` 主线/今天, `P2` 闲时/排期, `P3` 暂存. */
export const PRIORITY_LEVELS = ['P0', 'P1', 'P2', 'P3'] as const
export type PriorityLevel = typeof PRIORITY_LEVELS[number]
/** Who decided a level: a person, or the system's default. A person's decision is sticky; a default is not. */
export type PrioritySource = 'human' | 'default'
/** Where a person said it: a card button, the panel, or a short reply in the conversation. */
export type PriorityVia = 'feishu' | 'panel' | 'session'
/** A ticket's priority, with the decision it came from so the card and the panel can answer "who set this, and why". */
export interface TicketPriority {
  level: PriorityLevel
  source: PrioritySource
  at: string
  /** The person who set a `human` one, by their Source identity. */
  by?: string
  /** Where a person set it; absent on a system default. */
  via?: PriorityVia
  /**
   * Why the system chose its default: `explicit` (a person wrote the level), `human-mention` (`P1` for an addressed request),
   * `automatic` (anything else) or `ask-timeout` (a TAPD question nobody answered, defaults to `P2`).
   */
  note?: PriorityNote
}
/** Why a level was decided, as the ticket and the card say it. */
export type PriorityNote = 'explicit' | 'human-mention' | 'automatic' | 'ask-timeout'
/**
 * The question a TAPD ticket asks before it may start: `pending` from its creation until a person answers or the deadline
 * passes, `answered` once they do, `expired` once the default applied. An expired question still accepts a later answer,
 * because the person may change the priority at any time; the card only stops asking.
 */
export interface PriorityAsk {
  state: 'pending' | 'answered' | 'expired'
  /** When the question was asked. */
  at: string
  /** When nobody's answer applies the default (`priorityAskMin` minutes after `at`, or the deployment's setting). */
  deadline: string
  /** The card's message id, once it went out, so the panel can open the question itself. */
  cardId?: string
  /** When the question was answered or expired. */
  settledAt?: string
  /** The person who answered it. */
  by?: string
}
/** How long a TAPD ticket's priority question waits before the `P2` default applies. */
export const PRIORITY_ASK_MINUTES = 30
/** How a level is shown: a short code and a word for when its work runs. */
export const PRIORITY_LABELS: Readonly<Record<PriorityLevel, { code: string; word: string; hint: string }>> = {
  P0: { code: 'P0', word: '紧急', hint: '立刻插队；只能由人指定' },
  P1: { code: 'P1', word: '主线', hint: '今天的主线工作' },
  P2: { code: 'P2', word: '闲时', hint: '闲时处理 / 排期' },
  P3: { code: 'P3', word: '暂存', hint: '只先存着，等更深的闲时' },
}
/** Whether a level runs with the mainline (P0/P1) or waits in the idle pool (P2/P3). */
export const priorityIsMainline = (level: PriorityLevel): boolean => level === 'P0' || level === 'P1'
/** The `P` codes and words a person may write to set a level, matched in this order. */
const WORDS: readonly { level: PriorityLevel; pattern: RegExp }[] = [
  { level: 'P3', pattern: /暂存|先放着|放着吧/u },
  { level: 'P2', pattern: /不急|不着急|排期|以后再|以后再说/u },
  { level: 'P0', pattern: /(?<!不)紧急|很急|立刻|马上|崩溃/u },
  { level: 'P1', pattern: /今天|尽快/u },
]
/** A `p0`–`p3` code, case-insensitive, not glued to a longer word or to another digit. */
const CODE = /(?<![A-Za-z0-9])P([0-3])(?![0-9A-Za-z])/i
/** A level a person wrote somewhere in their message, such as "线上崩溃，P0" or "不急，先排期". */
export function priorityOfText(text: string): PriorityLevel | undefined {
  const code = CODE.exec(text)
  if (code) return `P${code[1]}` as PriorityLevel
  return WORDS.find(word => word.pattern.test(text))?.level
}
/**
 * The level a person's short reply sets, when the whole message is one level: `p2`, `P2`, `紧急`, `不急`, `排期`,
 * `暂存` or `今天`, with an optional trailing punctuation. A message that also says something else is not an answer and
 * reaches the worker as ordinary work.
 */
export function priorityAnswer(text: string): PriorityLevel | undefined {
  const answer = text.trim().replace(/[。.!！~～]+$/u, '').trim()
  if (!answer || answer.length > 12) return undefined
  const code = new RegExp(`^${CODE.source}$`, 'i').exec(answer)
  if (code) return `P${code[1]}` as PriorityLevel
  const word = WORDS.find(item => new RegExp(`^(?:${item.pattern.source})$`, 'u').test(answer))
  return word?.level
}
/**
 * What a Trigger does to a new ticket's priority before anyone answers: a TAPD bug asks (with `P2` as the fallback), a
 * person's addressed request is `P1`, and anything else is `P2`. A person's explicit level in their own message wins over
 * every default, including `P0`: that is the one way a ticket becomes `P0` without a card.
 */
export interface PriorityDefault {
  level: PriorityLevel
  source: PrioritySource
  note: PriorityNote
  /** The ticket asks a person before it may start; `level` is the fallback that applies when nobody answers. */
  ask?: true
}
export function defaultPriority(trigger: Trigger | undefined): PriorityDefault {
  // A TAPD bug's text is a report, not an instruction to the scheduler: only its own ask sets the level. The bug's TAPD
  // priority is a suggestion for the card, never the value (the design calls TAPD priorities inflated).
  if (!trigger) return { level: 'P2', source: 'default', note: 'automatic' }
  if (trigger.source === 'tapd') return { level: 'P2', source: 'default', note: 'automatic', ask: true }
  const explicit = trigger.human ? priorityOfText(trigger.text) : undefined
  if (explicit) return { level: explicit, source: 'human', note: 'explicit' }
  if (trigger.human && trigger.addressed) return { level: 'P1', source: 'default', note: 'human-mention' }
  return { level: 'P2', source: 'default', note: 'automatic' }
}
/** How TAPD's own priority reads on the card: a suggestion, never the ticket's value. */
export function tapdSuggestion(origin: { meta: Record<string, unknown> } | undefined): PriorityLevel | undefined {
  const value = String(origin?.meta.priority ?? '').trim()
  if (!value) return undefined
  if (/紧急|urgent|highest/i.test(value)) return 'P1'
  if (/^高|high/i.test(value)) return 'P1'
  if (/^中|middle|normal|medium/i.test(value)) return 'P2'
  if (/^低|low/i.test(value)) return 'P3'
  const code = CODE.exec(value)
  if (code) {
    // TAPD priorities are P1–P3 at most in practice; a TAPD P0 is a suggestion for today, never an automatic P0.
    const level = `P${code[1]}` as PriorityLevel
    return level === 'P0' ? 'P1' : level
  }
  return undefined
}
/**
 * The priority a system decision may apply, which is never `P0` and never overrides a person's level: a sticky human
 * decision keeps its level, and only a default may be replaced by another default. Returns what to store, or undefined
 * when the current priority already stands or the system may not apply the proposed value.
 */
export function systemPriority(current: TicketPriority | undefined, next: PriorityDefault, at: string): TicketPriority | undefined {
  if (current?.source === 'human') return undefined
  // A system decision never applies a person's level and never sets P0, whatever it is handed.
  if (next.source === 'human' || next.level === 'P0') return undefined
  if (current && current.level === next.level && current.note === next.note) return undefined
  return { level: next.level, source: 'default', at, note: next.note }
}
/** Whether a level waits in the idle pool rather than running with the mainline. */
export const waitsForIdle = (level: PriorityLevel): boolean => !priorityIsMainline(level)
/**
 * A ticket's level; one stored before priorities existed counts as `P1`, because a person's accepted request used to start
 * at once and an upgrade must not suddenly hold that work back.
 */
export const ticketPriority = (ticket: Pick<Ticket, 'priority'>): PriorityLevel => ticket.priority?.level ?? 'P1'
/** Whether a priority question's deadline passed at `now`. */
export const priorityAskOverdue = (ask: Pick<PriorityAsk, 'state' | 'deadline'> | undefined, now: string): boolean =>
  ask?.state === 'pending' && !!ask.deadline && ask.deadline <= now
/** The question's deadline, counted from `at`. */
export const priorityAskDeadline = (at: string, minutes = PRIORITY_ASK_MINUTES): string =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString()
