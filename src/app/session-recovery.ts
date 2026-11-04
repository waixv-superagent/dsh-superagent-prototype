/** Session store recovery: how a Session DSH cannot open is retried, and the error the Executor reports when it stays unreadable. */
/** How many times a Session that could not be opened is reopened before the ticket reports blocked, and the first backoff. */
export const SESSION_REOPEN_RETRIES = 2, SESSION_REOPEN_MS = 250
/**
 * A Session whose stored event log the host could not open even after bounded reopen attempts, such as a corrupt session
 * file or a store another process still owns. Its files are left in place: the ticket reports blocked with the reason
 * instead of the host deleting history, and a person can repair or archive the store and retry.
 */
export class SessionUnavailable extends Error {
  constructor(readonly sessionId: string, readonly detail: string) {
    super(`The Session ${sessionId} could not be opened after retrying: ${detail}. Its stored history was kept and the ticket was not started.`)
    this.name = 'SessionUnavailable'
  }
}
/** A failed resolve's code and detail, as DSH returns them. */
export const resolveFailure = (error: { code: string; message?: string }): string => error.message ? `${error.code}: ${error.message}` : error.code
/** Waits `ms` before reopening a Session, so a store another process was writing is given a moment to settle. */
export const reopenDelay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })
