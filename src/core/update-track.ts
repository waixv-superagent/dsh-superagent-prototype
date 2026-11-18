/**
 * How a ticket's change reaches the running system. `hot` ships by replacing this plugin's package in place, which the
 * one-click update applies after the change merged; `package` needs a new desktop app build the deployment's app track
 * produces and a person installs (docs/006). The track decides what the host does after a merge: a hot change is deployed
 * on its own, a package change waits for its app build. It is recorded at accept or in the worker's report, and an
 * unrecorded track defaults to `hot` for the agent's own work, whose repository's package carries it (docs/020).
 */
import type { Ticket } from './model.ts'
import { ticketKind } from './kind.ts'

/** `hot` the plugin package carries the change; `package` needs a new desktop app build. */
export const UPDATE_TRACKS = ['hot', 'package'] as const
export type UpdateTrack = typeof UPDATE_TRACKS[number]
/** Who decided a track: the router's accept, the worker's report, or the default for the agent's own work. */
export type UpdateTrackSource = 'router' | 'worker' | 'rule'
export interface UpdateTrackOf { track: UpdateTrack; source: UpdateTrackSource }

/**
 * A ticket's update track: the one recorded at accept or in its worker's report, else `hot` for the agent's own work,
 * whose repository is the package this deployment updates. Work in another repository gets none: this host does not deploy
 * it.
 */
export function ticketUpdateTrack(ticket: Pick<Ticket, 'update' | 'kind' | 'kindSource' | 'category' | 'mandate' | 'execution' | 'title'>): UpdateTrackOf | undefined {
  if (ticket.update) return { track: ticket.update.track, source: ticket.update.source }
  return ticketKind(ticket).kind === 'self' ? { track: 'hot', source: 'rule' } : undefined
}
