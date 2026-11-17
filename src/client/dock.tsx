/**
 * The always-visible active-Tickets dock in DSH's frame-wide `shell.bottom` strip: one quiet row per open Ticket with the
 * newest real activity (the same `active` list the board's 最近活跃 band reads), so a person switches which worker Session
 * they watch without returning to the panel. Rows that wait on a person carry a loud pill; everything else stays quiet.
 * It renders outside the panel provider, so it polls with its own caller, injects its own stylesheet, and receives every
 * navigation as a prop instead of reaching for DSH services.
 */
import { usePoll, type RecentActiveRow } from './api.ts'
import { Icon } from './controls.tsx'
import DOCK_STYLES from './dock.css?raw'
import { activeAgo, ticketMark, type Mark } from './marks.ts'
import { useApiCall } from './panel-call.ts'
import { fullTime, type T } from './text.ts'

const DOCK_STYLE_ID = 'dsh-superagent-dock'
const DOCK_POLL_MS = 5000

/** The dock lives outside the panel, where provider.tsx mounts the panel stylesheet, so it injects its own once. */
export function ensureDockStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(DOCK_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = DOCK_STYLE_ID
  style.textContent = DOCK_STYLES
  document.head.append(style)
}
ensureDockStyles()

export interface ActiveTicketsDockProps {
  t: T
  /** Switch to the Ticket's worker Session (the caller falls back to the Ticket page when the Session is not listed). */
  openWorker: (ticketId: string) => void
  /** Open the Ticket's page in the panel. */
  openTicket: (ticketId: string) => void
  /** Open the panel's board. */
  openBoard: () => void
}

/** Status glyph: a spinner while a worker turn runs, a dot otherwise. */
function Glyph({ mark }: { mark: Mark }) {
  if (mark.dot === 'ongoing') {
    return <svg className="dt-dock-spin" width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
      <g><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /></g>
    </svg>
  }
  return <span className="dt-dock-dot" data-state={mark.dot} aria-hidden="true" />
}

function DockRow({ t, ticket, openWorker, openTicket }: { t: T; ticket: RecentActiveRow } & Pick<ActiveTicketsDockProps, 'openWorker' | 'openTicket'>) {
  const mark = ticketMark(t, ticket)
  const person = ticket.stage === 'person'
  const ago = activeAgo(t, ticket.activeAt)
  const label = `${t('dockOpenWorker', { title: ticket.title })} · ${mark.label} · ${ago}`
  return <li className="dt-dock-item" data-person={person || undefined}>
    <button type="button" className="dt-dock-row" title={`${ticket.title}\n${mark.label} · ${fullTime(ticket.activeAt, t('lang'))}`}
      aria-label={label} onClick={() => openWorker(ticket.id)}>
      <Glyph mark={mark} />
      <span className="dt-dock-title">{ticket.title}</span>
      {person
        ? <span className="dt-dock-pill" data-tone={mark.tone}><Icon name={mark.icon} size={11} />{mark.label}</span>
        : <span className="dt-dock-stage">{mark.label}</span>}
      <time className="dt-dock-age" dateTime={ticket.activeAt}>{ago}</time>
    </button>
    <button type="button" className="dt-dock-open" title={t('dockOpenTicket')} aria-label={`${t('dockOpenTicket')}: ${ticket.title}`}
      onClick={() => openTicket(ticket.id)}>
      <Icon name="review" size={13} />
    </button>
  </li>
}

/** The dock itself; renders nothing until the first answer and whenever no open Ticket has recent activity. */
export function ActiveTicketsDock({ t, openWorker, openTicket, openBoard }: ActiveTicketsDockProps) {
  const call = useApiCall(t)
  // Transient failures keep the last answer (usePoll preserves it); with no answer at all the dock stays absent.
  const { data } = usePoll(() => call('GET overview'), [call], DOCK_POLL_MS)
  const tickets = data?.active ?? []
  if (!tickets.length) return null
  return <section className="dt-dock" aria-label={t('dockRegion')}>
    <div className="dt-dock-bar">
      <span className="dt-dock-label"><span className="dt-dock-label-text">{t('dockLabel')}</span>
        <span className="dt-dock-count" aria-hidden="true">{tickets.length}</span></span>
      <ol className="dt-dock-list">
        {tickets.map(ticket => <DockRow key={ticket.id} t={t} ticket={ticket} openWorker={openWorker} openTicket={openTicket} />)}
      </ol>
      <button type="button" className="dt-dock-board" title={t('dockBoardHint')} onClick={openBoard}>
        <Icon name="queue" size={13} /><span>{t('dockBoard')}</span>
      </button>
    </div>
  </section>
}
