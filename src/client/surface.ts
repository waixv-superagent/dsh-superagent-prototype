/**
 * The panel's frame-wide view of which client the person is using, and the desktop app's way of taking a Ticket a Feishu
 * link handed over. Both run from the always-mounted active-Tickets dock, the frame's one `shell.bottom` entry: the host
 * needs the report before it can open a ticket link in the app instead of a browser, and only the app may take a handoff.
 */
import { useEffect, useRef } from 'react'
import { useApiCall } from './panel-call.ts'
import type { T } from './text.ts'
import { electronShell } from './widgets.tsx'

/** How often an idle page still confirms which client it is and whether its window is in use. */
const REPORT_MS = 15_000
/** How often the app's panel asks for a handoff; a window coming back into focus asks at once instead of waiting. */
const HANDOFF_MS = 2_000

/**
 * Report this page's client and take the Ticket the host handed to the app.
 *
 * A background page still reports, so the host keeps a recent view of both clients, but the store only counts a focused or
 * visible report: switching to Feishu blurs the page and must not make the browser the "current" client. Only a page in
 * the desktop shell polls for a handoff, and it polls on focus because a hidden page's timers are throttled: the host has
 * just brought the app forward, which is the moment the command must be taken.
 * @param t - the panel translator, for the shared caller's error messages.
 * @param openTicket - moves the mounted panel to the handed-over Ticket.
 */
export function useSurfaceLink(t: T, openTicket: (ticketId: string) => void): void {
  const call = useApiCall(t)
  const opener = useRef(openTicket)
  opener.current = openTicket
  const desktop = electronShell()
  useEffect(() => {
    let stopped = false
    let last = ''
    const report = (force = false): void => {
      if (stopped) return
      const body = { surface: desktop ? 'app' as const : 'web' as const, focused: document.hasFocus(), visible: !document.hidden,
        origin: typeof window === 'undefined' ? undefined : window.location.origin }
      // A burst of focus/blur/visibility events describes one state: report a state once rather than on every event. The
      // periodic report is forced so a host that was restarting when the page loaded still learns this client.
      const signature = JSON.stringify(body)
      if (!force && signature === last) return
      last = signature
      void call('POST surface', { body }).catch(() => { last = '' /* the next report retries the state */ })
    }
    const changed = (): void => { report() }
    report(true)
    const timer = setInterval(() => { report(true) }, REPORT_MS)
    addEventListener('focus', changed)
    addEventListener('blur', changed)
    document.addEventListener('visibilitychange', changed)
    return () => {
      stopped = true
      clearInterval(timer)
      removeEventListener('focus', changed)
      removeEventListener('blur', changed)
      document.removeEventListener('visibilitychange', changed)
    }
  }, [call, desktop])
  useEffect(() => {
    if (!desktop) return
    let stopped = false
    const take = async (): Promise<void> => {
      if (stopped) return
      try {
        const answer = await call('GET app-open', { query: { surface: 'app' } })
        if (!stopped && answer.ticketId) opener.current(answer.ticketId)
      } catch { /* a host restart is not a reason to stop asking. */ }
    }
    void take()
    const timer = setInterval(() => { if (!document.hidden) void take() }, HANDOFF_MS)
    const wake = (): void => { void take() }
    addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      stopped = true
      clearInterval(timer)
      removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [call, desktop])
}
