/**
 * Which DSH client a person is working in right now. The panel runs both in a browser page and in the desktop app's
 * Electron page; each reports the state of its own window, so a Feishu ticket link can open where the person already is
 * instead of always in a browser. The newest report from a focused or visible page decides, and the store also holds the
 * one Ticket an app handoff asks the app's panel to show.
 */
export type Surface = 'app' | 'web'
/** How long a report counts as "currently using it"; beyond that a link opens the browser, which every client reaches. */
export const SURFACE_ACTIVE_MS = 10 * 60_000
/** How long a handoff waits for the app's panel to poll for it; an old click never moves a person's page later. */
export const OPEN_TICKET_MS = 5 * 60_000
/** One client window's report: which surface it is, whether the window has focus, whether it is visible, and where it is. */
export interface SurfaceReport { surface: Surface; focused: boolean; visible: boolean; origin?: string }
/** The http(s) origin of a reported page, without a path, credentials or a malformed value; undefined otherwise. */
function httpOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}
/** The last active surface and the Ticket an app handoff asked the app's panel to open. */
export class SurfaceState {
  private last: { surface: Surface; at: number } | undefined
  private pending: { ticketId: string; at: number } | undefined
  /** The addresses at which each client was last used, which is how a message links a panel nobody configured by hand. */
  private readonly origins: Partial<Record<Surface, string>> = {}
  /**
 * Records a report. Only a focused window counts as "being used": after the person switches to Feishu the client they
 * just left blurs, and a second visible window must not take that client's place just because it is still on screen. A
 * visible but unfocused page fills in only when nothing has been reported yet, which is the browser fallback anyway.
 */
  touch(report: SurfaceReport, now = Date.now()): void {
    const origin = httpOrigin(report.origin)
    if (origin) this.origins[report.surface] = origin
    if (report.focused) this.last = { surface: report.surface, at: now }
    else if (report.visible && this.last === undefined) this.last = { surface: report.surface, at: now }
  }
  /**
   * The panel address a message links: the operator's configured one, else the address the panel was last opened at in a
   * browser. Only the browser origin counts as the fallback: the desktop app's own origin is a loopback address whose
   * session the system browser does not share, so a link there would only show the panel's login. Empty when neither is
   * known, and a message then carries no link rather than an address nobody has opened.
   */
  panelBase(configured: string): string {
    return (configured.trim() || this.origins.web || '').replace(/\/+$/, '')
  }
  /** The client to open a link in: the last one the person interacted with, else the browser. */
  active(now = Date.now()): Surface {
    return this.last !== undefined && now - this.last.at <= SURFACE_ACTIVE_MS ? this.last.surface : 'web'
  }
  /**
   * Asks the app's panel to show `ticketId`, answered the next time it polls.
   * @returns false when the same request is already waiting, so a reload does not focus the app again.
   */
  open(ticketId: string, now = Date.now()): boolean {
    if (this.pending?.ticketId === ticketId && now - this.pending.at <= OPEN_TICKET_MS) return false
    this.pending = { ticketId, at: now }
    return true
  }
  /** Takes the waiting request, if any, and forgets it; a request older than the wait is dropped rather than replayed. */
  take(now = Date.now()): string | undefined {
    const pending = this.pending
    if (pending === undefined) return undefined
    this.pending = undefined
    return now - pending.at <= OPEN_TICKET_MS ? pending.ticketId : undefined
  }
}
