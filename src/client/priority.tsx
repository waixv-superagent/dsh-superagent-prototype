/**
 * The one control a person uses to set a Ticket's level by hand. Every board surface that names a live Ticket — the
 * decision, verification, running and pipeline lanes, the idle drawer and the Ticket page — renders this same menu, so a
 * Ticket waiting anywhere can be put into the low-priority idle pool, and a pooled one can be picked back out, without
 * first finding it in the drawer. `P0`/`P1` go through `promote`, which also starts the next turn when nothing else waits;
 * `P2`/`P3` only change the level through `priority`, so a demotion is never a hidden "run now" (docs/019).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PriorityLevel } from '../core/priority.ts'
import { Icon, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'

/** The levels whose pick also starts the work, as opposed to a level-only change. */
export const startsNow = (level: PriorityLevel): level is 'P0' | 'P1' => level === 'P0' || level === 'P1'
const LEVELS: readonly PriorityLevel[] = ['P0', 'P1', 'P2', 'P3']
/** How large the popup is, so it opens above the trigger when there is no room below it. */
const MENU_WIDTH = 236
const MENU_HEIGHT = 190
/**
 * The fields this menu reads: every live board row and the Ticket page carry them, whichever view projection built them.
 * A person-set level is `source: human`, and a ticket counts as pooled at `P2`/`P3`; that stays the host's rule.
 */
export interface PriorityTicket {
  id: string
  priority: { level: PriorityLevel; hint: string }
  pool: boolean
}
/**
 * The level tag plus its four-level menu. The trigger shows the current level (a small settings icon in the idle drawer's
 * one-line rows), and the popup is portaled to the page so a clipped card or a scrolling drawer never hides it.
 */
export function PriorityTag({ ticket }: { ticket: PriorityTicket }) {
  const { t } = usePanel()
  const level = ticket.priority.level
  const tone = level === 'P0' ? 'danger' : level === 'P1' ? 'warning' : 'quiet'
  return <Tag tone={tone} title={ticket.priority.hint}>{t(`priorityWord.${level}`)}</Tag>
}
export function PriorityMenu({ ticket, onChanged, variant = 'tag', className }: {
  ticket: PriorityTicket
  onChanged: () => Promise<void>
  /** `tag` is the board's visible level control; `icon` keeps the idle drawer's row compact. */
  variant?: 'tag' | 'icon'
  className?: string
}) {
  const { t, call, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [at, setAt] = useState<{ left: number; top: number }>()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const close = useCallback(() => { setOpen(false); setFailure('') }, [])
  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(MENU_WIDTH, Math.max(180, window.innerWidth - 16))
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = rect.bottom + 6
    setAt({ left, top: below + MENU_HEIGHT > window.innerHeight ? Math.max(8, rect.top - MENU_HEIGHT - 6) : below })
  }, [])
  useLayoutEffect(() => { if (open) place() }, [open, place])
  // A pointer outside, Escape, or the page moving under a fixed popup closes the menu; focus returns to its trigger.
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (trigger.current?.contains(target) || popup.current?.contains(target)) return
      close()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      close()
      trigger.current?.focus()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, close])
  const apply = async (level: PriorityLevel) => {
    if (level === ticket.priority.level) { close(); return }
    setBusy(true); setFailure('')
    try {
      if (startsNow(level)) await call('POST tickets/:id/promote', { id: ticket.id, body: { level } })
      else await call('POST tickets/:id/priority', { id: ticket.id, body: { level } })
      // The same level means a different thing in the pool and outside it: only a pooled pick starts a turn at once.
      notify(startsNow(level)
        ? ticket.pool ? t('poolPromoted') : t('prioritySet', { level: t(`priorityWord.${level}`) })
        : t('prioritySetIdle', { level: t(`priorityWord.${level}`) }))
      close()
      await onChanged()
    } catch (reason) {
      setFailure(t('poolLevelFailed', { reason: errorText(reason) }))
    } finally { setBusy(false) }
  }
  const level = ticket.priority.level
  return <span className={className ? `dt-priority ${className}` : 'dt-priority'}>
    <button ref={trigger} type="button" className={variant === 'icon' ? 'dt-idle-menu dt-priority-trigger' : 'dt-priority-trigger'}
      aria-haspopup="menu" aria-expanded={open} aria-label={t('priorityAdjust')} title={t('priorityAdjust')} disabled={busy}
      onClick={() => { if (open) close(); else { place(); setOpen(true) } }}>
      {variant === 'icon'
        ? <Icon name="settings" size={13} />
        : <><PriorityTag ticket={ticket} /><Icon name="chevron-down" size={10} /></>}
    </button>
    {open && createPortal(<div ref={popup} className="dt-idle-pop dt-priority-pop" role="menu" aria-label={t('priorityAdjust')}
      style={{ left: at?.left, top: at?.top }}>
      {LEVELS.map(choice => <button key={choice} type="button" role="menuitem" data-level={choice} disabled={busy}
        onClick={() => { void apply(choice) }}>
        <span className="dt-idle-pop-level">{t(`priorityWord.${choice}`)}</span>
        <small>{startsNow(choice) ? t('poolDropStart') : t(choice === 'P2' ? 'priorityToIdle' : 'priorityToParked')}</small>
        {choice === level && <span className="dt-idle-pop-current" aria-hidden="true"><Icon name="check" size={12} /></span>}
      </button>)}
      <p className="dt-priority-hint">{t('priorityMenuHint')}</p>
      {failure && <p className="dt-priority-failure" role="alert">{failure}</p>}
    </div>, document.body)}
  </span>
}
