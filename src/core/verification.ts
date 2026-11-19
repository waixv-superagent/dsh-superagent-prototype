/** The verification package a delivered change carries (docs/012 §3.1): what a person needs to reproduce and judge it. */

/**
 * The four blocks a verification package states, in the order a worker writes them: the version and its prerequisites,
 * the reproduction steps, the expected result with the evidence captured, and the one point the person must judge.
 */
export const VERIFY_LABELS = ['版本与前置', '复现步骤', '预期与证据', '待你判断'] as const
/** How long the whole package and one line may get, so a person can still follow it on a phone. */
export const VERIFY_LIMITS = { text: 2_000, line: 800 } as const
/** The package's lines as label and content; text before the first label is dropped. */
export function verifyLines(text: string): { label: string; text: string }[] {
  const lines: { label: string; text: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:[-*]\\s*)?(${VERIFY_LABELS.join('|')})\\s*[：:]\\s*(.*)$`).exec(line)
    if (match) lines.push({ label: match[1]!, text: match[2]! })
    else if (lines.length) lines.at(-1)!.text += `\n${line}`
  }
  return lines.map(line => ({ ...line, text: line.text.trim() })).filter(line => line.text)
}
/** The blocks the package leaves out: a delivered change is not ready until a person can reproduce it. */
export const missingVerifyLabels = (text: string): string[] => {
  const found = new Set(verifyLines(text).map(line => line.label))
  return VERIFY_LABELS.filter(label => !found.has(label))
}
/**
 * How long a handover still asks for a person's local check now. A Ticket delivered inside this window is the work the
 * branch just landed and the next step waits on that check; an older live delivery, a pooled P2/P3 one and an ended
 * Ticket waiting for a backfill are the standing queue, which the board counts and folds away (docs/005).
 */
export const VERIFY_FOCUS_MS = 24 * 3_600_000
/**
 * What the rule reads: a host Ticket and the panel's row of it both carry these fields; the row keeps only the level,
 * so the rule names that instead of the host's whole priority record.
 */
export interface VerifyCandidate {
  verification?: { state?: string; at?: string }
  ended?: unknown
  priority?: { level?: string }
}
/**
 * Whether a pending local check deserves a person's attention now: the Ticket is live and was handed over within the
 * day, or it is urgent enough that its age does not matter. Everything else waits in the queue rather than leading.
 */
export function verifyFocus(ticket: VerifyCandidate, now = Date.now()): boolean {
  if (ticket.verification?.state !== 'pending' || ticket.ended) return false
  if (ticket.priority?.level === 'P0') return true
  const at = Date.parse(ticket.verification.at ?? '')
  return Number.isFinite(at) && now - at <= VERIFY_FOCUS_MS
}
