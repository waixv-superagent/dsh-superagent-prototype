/** Localization, reason formatting, message marker cleanup, and relative timestamp helpers. */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { DshSuperagentKey } from './locales.ts'
import type { Localized } from '../sources/kind.ts'
import type { SetupProblem } from '../setup.ts'
import type { Health } from '../sources/host.ts'
import { reasonText, type Reason } from '../core/reasons.ts'

export type T = Translate<DshSuperagentKey>
export const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)
export const localized = (t: T, text: Localized | string | undefined): string =>
  typeof text === 'string' ? text : text ? text[t('lang') === 'en' ? 'en' : 'zh'] : ''
export const actorName = (t: T, actor: { name?: Localized } | undefined): string => actor?.name ? localized(t, actor.name)
  : t('automatedNotice')
export function valueLabel(t: T, group: string, key: string | undefined): string {
  if (!key) return ''
  const name = `${group}.${key}` as DshSuperagentKey
  const text = t(name)
  return text === name ? key : text
}
/** Format one or more structured or raw reasons in the active UI language, truncating multi-line host errors to their first line. */
export function reasonLabel(t: T, reason: string | Reason | readonly Reason[] | undefined): string {
  if (typeof reason === 'string') return reason ? label(t, { code: reason }) : ''
  return [reason ?? []].flat().map(item => label(t, item)).filter(Boolean).join('；')
}
function label(t: T, reason: Reason): string {
  const key = `reason.${reason.code}` as DshSuperagentKey
  const text = reason.code === 'said' ? reason.values?.text ?? '' : t(key, reason.values)
  if (reason.code !== 'said' && text !== key) return text
  const written = reason.code === 'said' ? text : reasonText({ ...reason, triggerId: undefined })
  if (/^\w*Error\b/.test(written)) { const first = written.split('\n')[0]!; return first.length > 140 ? `${first.slice(0, 140)}…` : first }
  return written
}
export const setupText = (t: T, problem: Pick<SetupProblem, 'code' | 'values'>): string => t(`setup.${problem.code}`, problem.values)
export const healthText = (t: T, health: Pick<Health, 'detail' | 'code' | 'values'>): string =>
  health.code ? t(`healthCode.${health.code}` as const, health.values) : health.detail
/** Replaces Feishu and GitHub content placeholders (images, cards, media, forwards, unresolved mentions) with localized labels. */
export function readableMarkers(t: T, text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, t('imageMarker'))
    .replace(/\[Chat card: [^\]]*\]/g, t('cardMarker'))
    .replace(/\[Media: [^\]]*\]/g, t('mediaMarker')).replace(/\[Merged forward\]/g, t('forwardMarker'))
    .replace(/@_user_\d+/g, t('unknownMention'))
}
const timeLocale = (lang: string) => lang === 'en' ? 'en' : 'zh-CN'
export function when(value: string | undefined, lang: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (Math.abs(seconds) < 86_400) {
    const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return relative.format(0, 'second')
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute')
    return relative.format(Math.round(seconds / 3600), 'hour')
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const year = sameYear ? {} : { year: 'numeric' } as const
  return date.toLocaleString(timeLocale(lang), { ...year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export function fullTime(value: string | undefined, lang: string): string {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(timeLocale(lang))
}
export interface CheckLine { text: string; state: 'pass' | 'fail' | 'skip' | 'note' }
/**
 * Splits a worker's free-text verification summary into scannable check lines. The worker writes prose, not structured
 * results, so this only classifies what each line says; the full text stays available as the original evidence. A line
 * that neither ran nor failed is a recorded fact (`note`), not a check that was skipped: calling a shelve or a review
 * link "not run" would misreport work the worker actually did.
 */
export function checkLines(text: string): CheckLine[] {
  return text.split(/\r?\n|；|;/).map(line => line.trim()).filter(Boolean).slice(0, 8).map(line => {
    // "0 failed" reports a clean run; strip it before the failure test so the count cannot flip the verdict.
    const failures = line.replace(/\b0\s+fail(?:ed|ures?)\b/gi, '')
    return { text: line.slice(0, 200),
      state: /未运行|未跑|没有跑|未执行|未测|没测|not run|unable to run/i.test(line) ? 'skip'
        : /失败|未通过|不通过|\bfail(?:ed|ure)?\b|✗|×/i.test(failures) ? 'fail'
        : /通过|成功|已检查|已验证|\bpass(?:ed)?\b|\bsucceed(?:ed)?\b|✓|exit\s*(?:code\s*)?0\b|\b(\d+)\/\1\b|\bbuild complete\b|\b0\s+errors?\b/i.test(line)
          ? 'pass'
          : /skipped/i.test(line) ? 'skip' : 'note' }
  }) as CheckLine[]
}
