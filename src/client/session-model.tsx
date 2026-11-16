/**
 * Read-only model route for an addressed child Session.
 *
 * DSH shows a model only through the composer's model seat, and that seat is
 * withheld from an addressed subagent Session because its Agent-bound RPCs
 * would activate persisted history outside the direct-parent continuation path
 * (see `ui-model-selection`). The child still records every request's route in
 * its durable `modelSelection` projection, so its header names that route
 * instead: the one fact a person needs to tell which model a worker's subagent
 * actually ran.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { T } from './text.ts'

/** Standard Session-list selector the DSH renderer hands a Session-scoped header action. */
export type UseSessions = SnapshotSelectorHook<SessionListState>

/** Props of the child-Session model chip. */
export interface SessionModelProps {
  sessionId: SessionId
  useSessions: UseSessions
  t: T
}

/**
 * Read the route an addressed child Session ran its latest model request on.
 * The list summary already carries the durable selection for a Session nobody
 * has opened; the attached value wins once the conversation is open and live.
 * @param state - current Session list state.
 * @param sessionId - Session whose route to read.
 * @returns `provider/model`, or undefined for a root Session or one that has recorded no request.
 */
export function childModelRoute(state: SessionListState, sessionId: SessionId): string | undefined {
  const row = state.byId[sessionId]
  if (row?.origin !== 'subagent') return undefined
  const selection = state.projectionsBySession[sessionId]?.values.modelSelection
    ?? row.projectionValues?.modelSelection
  const route = selection?.next ?? selection?.lastUsed
  return route === null || route === undefined ? undefined : `${route.provider}/${route.model}`
}

/**
 * Render the model route beside an addressed child Session's title.
 * @param props - Session identity, the standard Session-list selector, and the locale seat.
 * @returns the chip, or null for a root Session or a child with no recorded route.
 */
export function SessionModel({ sessionId, useSessions, t }: SessionModelProps) {
  const route = useSessions((state: SessionListState) => childModelRoute(state, sessionId))
  if (route === undefined) return null
  return (
    <span className="dt-header-model" title={t('subagentModelHint')} data-model-route={route}>
      <span className="dt-header-model-label">{t('subagentModel')}</span>{route}
    </span>
  )
}
