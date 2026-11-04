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
