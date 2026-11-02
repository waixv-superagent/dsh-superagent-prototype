/**
 * The compact "now" block of a running Ticket: what the worker is doing, the latest progress it reported and who acts next.
 * It deliberately keeps no reasoning stream, token totals or speed: a supervisor needs a decision surface, not a console.
 */
import { usePoll, type ActivityView } from './api.ts'
import { StateDot } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'

/** A short duration for the running tool; the card never shows a token rate. */
const seconds = (ms: number): string => ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round(ms % 60_000 / 1000)}s`

/** The ticket page's current-work card. */
export function TicketNow({ id, queued = false, startedAt, updatedAt, summary }: {
  id: string
  queued?: boolean
  startedAt?: string
  updatedAt: string
  summary: string
}) {
  const { t, call } = usePanel()
  const view = usePoll(() => call('GET tickets/:id/activity', { id }), [id], 5000)
  const data: ActivityView | undefined = view.data
  const tool = data?.live ? data.tool : null
  const changed = data?.live && data.updatedAt ? data.updatedAt : Date.parse(updatedAt)
  const started = startedAt ? Date.parse(startedAt) : NaN
  const minutes = Number.isFinite(started) ? Math.max(1, Math.round((Date.now() - started) / 60_000)) : 0
  const latest = summary.split(/\r?\n/)[0]?.trim().slice(0, 180) ?? ''
  return <section className="dt-now">
    <div className="dt-now-head">
      <StateDot state="ongoing" />
      <span className="dt-now-title">{queued ? t('nowQueued') : t('nowWorking')}</span>
      {minutes > 0 && <span className="dt-now-meta">{t('nowElapsed', { minutes })}</span>}
      {Number.isFinite(changed) && <span className="dt-now-meta">{t('nowUpdated', { time: when(new Date(changed).toISOString(), t('lang')) })}</span>}
    </div>
    <dl className="dt-now-facts">
      <div className="dt-now-fact">
        <dt>{t('nowDoing')}</dt>
        <dd>{tool ? <span className="dt-now-tool">
          <span>{tool.name}</span>
          {tool.digest && <code className="dt-now-digest">{tool.digest}</code>}
          <span className="dt-now-elapsed">{seconds(tool.elapsed)}</span>
        </span> : <span className="dt-now-meta">{queued ? t('nowWaitingSlot') : t('nowPreparing')}</span>}</dd>
      </div>
      {latest && <div className="dt-now-fact">
        <dt>{t('nowLatest')}</dt>
        <dd className="dt-now-latest" title={summary}>{latest}</dd>
      </div>}
      <div className="dt-now-fact">
        <dt>{t('nowNext')}</dt>
        <dd className="dt-now-next">{queued ? t('nowNextQueued') : t('nowNextWorking')}</dd>
      </div>
    </dl>
  </section>
}
