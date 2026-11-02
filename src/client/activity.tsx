/** Live execution block of the ticket page: a collapsed tool/rate summary and an expanded, bounded reasoning stream. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePoll, type ActivityView } from './api.ts'
import { DisclosureRow, StateDot } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { SessionButton } from './widgets.tsx'

/** The retained reasoning the panel renders; the server sends at most this many trailing characters. */
const TEXT_CAP = 64 * 1024
/** Append locally only up to this bound so a long reasoning never grows the DOM text node without limit. */
const TEXT_TRIM = 96 * 1024

const tokens = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
const seconds = (ms: number): string => ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round(ms % 60_000 / 1000)}s`

/** A ticket worker's live execution: the current tool and token speed when collapsed, the reasoning stream when expanded. */
export function LiveActivity({ id, sessionId }: { id: string; sessionId?: string }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [atLatest, setAtLatest] = useState(true)
  const after = useRef(0)
  const follow = useRef(true)
  const stream = useRef<HTMLDivElement>(null)
  const view = usePoll(async () => call('GET tickets/:id/activity', { id, query: { after: after.current, ...open ? { thinking: '1' as const } : {} } }),
    [id, open], open ? 750 : 2000)
  const data: ActivityView | undefined = view.data
  useEffect(() => {
    const next = data?.thinking
    if (!next) return
    if (next.reset) {
      setText(next.text)
      follow.current = true
      setAtLatest(true)
    } else if (next.text) setText(previous => {
      const combined = previous + next.text
      return combined.length > TEXT_TRIM ? combined.slice(-TEXT_CAP) : combined
    })
    after.current = next.total
  }, [data])
  useLayoutEffect(() => {
    const element = stream.current
    if (!element || !follow.current) return
    const selection = window.getSelection()
    // Keep the text still while a person selects a passage; the next update follows the bottom again.
    if (selection && !selection.isCollapsed && selection.anchorNode && element.contains(selection.anchorNode)) return
    element.scrollTop = element.scrollHeight
  }, [text, open])
  if (!data?.live) return null
  const following = () => {
    const element = stream.current
    if (!element) return
    const near = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
    follow.current = near
    setAtLatest(near)
  }
  const jump = () => {
    const element = stream.current
    if (!element) return
    follow.current = true
    setAtLatest(true)
    element.scrollTop = element.scrollHeight
  }
  const title = <>
    <span className="dt-live-state">{t('liveRunning')}</span>
    <span className="dt-live-sep">·</span>
    {data.tool ? <span className="dt-live-tool">{t('liveTool', { name: data.tool.name })}{' '}
      <code className="dt-live-digest">{data.tool.digest}</code>{' '}
      <span className="dt-live-elapsed">{seconds(data.tool.elapsed)}</span></span> : <span>{t('liveThinking')}</span>}
    {data.rate !== null && <><span className="dt-live-sep">·</span><span className="dt-live-rate">{t('liveRate', { rate: data.rate })}</span></>}
    <span className="dt-live-sep">·</span><span className="dt-live-tokens">{t('liveTokens', { count: tokens(data.tokens) })}</span>
  </>
  return <section className="dt-live">
    <DisclosureRow icon={<StateDot state="ongoing" />} title={title} open={open} onToggle={() => setOpen(value => !value)}>
      <div className="dt-live-body">
        {text ? <div className="dt-live-stream" ref={stream} onScroll={following}>
          <div className="dt-live-text">{text}</div>
          {!atLatest && <button type="button" className="dt-live-jump" onClick={jump}>{t('liveJump')}</button>}
        </div> : <p className="dt-live-empty">{data.tokens > 0 ? t('liveNoReasoning') : t('liveWaiting')}</p>}
        <div className="dt-live-foot">
          <span>{t('liveCalls', { count: data.calls })}</span>
          {sessionId && <SessionButton sessionId={sessionId} />}
        </div>
      </div>
    </DisclosureRow>
  </section>
}
