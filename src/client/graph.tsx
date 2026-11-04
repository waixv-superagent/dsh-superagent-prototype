/**
 * The overview's relation view: every recent Ticket as a node and how Tickets relate as edges, in two layouts. The
 * timeline is a time DAG, one lane per conversation, with each Ticket drawn as the span it ran; the cloud is a
 * force-directed layout where related Tickets cluster. Both are plain SVG with no layout library.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Pill, SegmentedControl } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint, LoadState } from './widgets.tsx'

type Graph = ApiResponse<'GET tickets/graph'>
type GraphNode = Graph['nodes'][number]
type GraphEdge = Graph['edges'][number]
type Layout = 'timeline' | 'cloud'
const KINDS = ['spawned', 'supersedes', 'blocks', 'related'] as const

/** The colour family a node takes: the stage, with ended Tickets split by whether their work landed. */
export function nodeTone(node: Pick<GraphNode, 'stage' | 'outcome'>): string {
  if (node.stage !== 'ended') return node.stage
  return node.outcome === 'completed' || node.outcome === 'merged' ? 'done' : 'closed'
}
/** The tickets a ticket touches through its edges, itself included. */
function neighbours(edges: GraphEdge[], id: string | undefined): Set<string> {
  const near = new Set<string>()
  if (!id) return near
  near.add(id)
  for (const edge of edges) if (edge.from === id || edge.to === id) { near.add(edge.from); near.add(edge.to) }
  return near
}
const shortTitle = (title: string, max = 18) => Array.from(title).length > max ? `${Array.from(title).slice(0, max - 1).join('')}…` : title

export interface TimelineLayout { width: number; height: number; lanes: { key: string; title: string; y: number }[]
  spans: Map<string, { x0: number; x1: number; y: number }>; ticks: { x: number; label: string }[] }
const LANE = 30, GUTTER = 168, PAD = 16
/** Places each Ticket as a span on its conversation's lane, on one time axis from the first Ticket to now. */
export function timelineLayout(graph: Pick<Graph, 'nodes' | 'lanes'>, width: number, now: number, lang: string): TimelineLayout {
  const times = graph.nodes.flatMap(node => [Date.parse(node.createdAt), node.endedAt ? Date.parse(node.endedAt) : now])
  const start = Math.min(...times), end = Math.max(now, ...times)
  const span = Math.max(end - start, 3_600_000)
  const x = (time: number) => GUTTER + (time - start) / span * (width - GUTTER - PAD)
  const used = new Set(graph.nodes.map(node => node.thread))
  // Lanes in order of their first Ticket, so the chart reads top-down as the work arrived.
  const first = new Map<string, number>()
  for (const node of graph.nodes) if (!first.has(node.thread)) first.set(node.thread, Date.parse(node.createdAt))
  const lanes = graph.lanes.filter(lane => used.has(lane.key)).sort((a, b) => (first.get(a.key) ?? 0) - (first.get(b.key) ?? 0))
    .map((lane, index) => ({ ...lane, y: 36 + index * LANE + LANE / 2 }))
  const laneY = new Map(lanes.map(lane => [lane.key, lane.y]))
  const spans = new Map(graph.nodes.map(node => {
    const x0 = x(Date.parse(node.createdAt))
    return [node.id, { x0, x1: Math.max(x0 + 6, x(node.endedAt ? Date.parse(node.endedAt) : now)), y: laneY.get(node.thread) ?? 0 }]
  }))
  const day = 86_400_000
  const step = span > 20 * day ? 7 * day : span > 5 * day ? day : span > 2 * day ? day / 2 : span > day / 2 ? day / 6 : day / 24
  const ticks: TimelineLayout['ticks'] = []
  const format = new Intl.DateTimeFormat(lang, step >= day ? { month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric', hour: '2-digit' })
  for (let time = Math.ceil(start / step) * step; time <= end; time += step) ticks.push({ x: x(time), label: format.format(time) })
  return { width, height: 36 + lanes.length * LANE + 12, lanes, spans, ticks }
}

/** A small deterministic hash so the cloud starts from the same positions on every load. */
function seed(text: string): number {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967295
}
/**
 * Force-directed positions: every pair repels, every edge pulls its ends together, and a weak pull keeps the cloud
 * centred. Deterministic for the same graph, and cheap for the few hundred Tickets the view holds.
 */
export function cloudLayout(nodes: Pick<GraphNode, 'id'>[], edges: Pick<GraphEdge, 'from' | 'to' | 'kind'>[], width: number, height: number,
  iterations = 260): Map<string, { x: number; y: number }> {
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const px = nodes.map(node => (seed(node.id) - .5) * width * .8), py = nodes.map(node => (seed(`${node.id}:y`) - .5) * height * .8)
  const links = edges.flatMap(edge => {
    const a = index.get(edge.from), b = index.get(edge.to)
    return a === undefined || b === undefined ? [] : [{ a, b, length: edge.kind === 'related' ? 56 : 44 }]
  })
  const area = width * height, k = Math.min(Math.sqrt(area / Math.max(nodes.length, 1)) * .45, 70)
  for (let step = 0; step < iterations; step++) {
    const heat = 1 - step / iterations
    const dx = new Float64Array(nodes.length), dy = new Float64Array(nodes.length)
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const x = px[i]! - px[j]!, y = py[i]! - py[j]!
      // Repulsion fades out beyond a few spacings, so unrelated clusters settle near each other instead of drifting apart.
      const d2 = Math.max(x * x + y * y, 1)
      if (d2 > 9 * k * k) continue
      const force = k * k / d2
      dx[i]! += x * force; dy[i]! += y * force; dx[j]! -= x * force; dy[j]! -= y * force
    }
    for (const { a, b, length } of links) {
      const x = px[b]! - px[a]!, y = py[b]! - py[a]!
      const d = Math.max(Math.hypot(x, y), .01), pull = (d - length) / d * .5
      dx[a]! += x * pull; dy[a]! += y * pull; dx[b]! -= x * pull; dy[b]! -= y * pull
    }
    for (let i = 0; i < nodes.length; i++) {
      dx[i]! -= px[i]! * .04; dy[i]! -= py[i]! * .04 * width / height
      const move = Math.hypot(dx[i]!, dy[i]!), limit = 18 * heat + .5
      if (move > limit) { dx[i]! *= limit / move; dy[i]! *= limit / move }
      px[i]! += dx[i]!; py[i]! += dy[i]!
    }
  }
  // Fit the result into the box with a margin, keeping its aspect.
  const minX = Math.min(...px), maxX = Math.max(...px), minY = Math.min(...py), maxY = Math.max(...py)
  const scale = Math.min((width - 80) / Math.max(maxX - minX, 1), (height - 80) / Math.max(maxY - minY, 1), 2.4)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  return new Map(nodes.map((node, i) => [node.id, { x: width / 2 + (px[i]! - cx) * scale, y: height / 2 + (py[i]! - cy) * scale }]))
}

function Markers() {
  return <defs>
    {KINDS.map(kind => <marker key={kind} id={`dt-graph-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8"
      orient="auto-start-reverse"><path className="dt-graph-arrow" data-kind={kind} d="M0 1.5 L9 5 L0 8.5 z" /></marker>)}
  </defs>
}
function Legend() {
  const { t } = usePanel()
  return <div className="dt-graph-legend" aria-label={t('graphLegend')}>
    {KINDS.map(kind => <span key={kind} className="dt-graph-legend-item">
      <svg width="26" height="8" aria-hidden="true"><line className="dt-graph-edge" data-kind={kind} x1="1" y1="4" x2="25" y2="4" /></svg>
      {t(`relation.${kind}`)}
    </span>)}
    <span className="dt-graph-legend-sep" />
    {(['working', 'person', 'pipeline', 'idle', 'done', 'closed'] as const).map(tone => <span key={tone} className="dt-graph-legend-item">
      <span className="dt-graph-swatch" data-tone={tone} />{t(`graphTone.${tone}`)}
    </span>)}
  </div>
}

function edgeLabel(t: ReturnType<typeof usePanel>['t'], edge: GraphEdge, nodes: Map<string, GraphNode>): string {
  return `${nodes.get(edge.from)?.title ?? edge.from} → ${nodes.get(edge.to)?.title ?? edge.to} · ${t(`relation.${edge.kind}`)} · ${t(`relationVia.${edge.via}`)}${edge.reason ? ` · ${edge.reason}` : ''}`
}

function Timeline({ graph, hover, setHover, open }: { graph: Graph; hover?: string; setHover: (id?: string) => void; open: (id: string) => void }) {
  const { t } = usePanel()
  const now = useMemo(() => Date.now(), [graph])
  const layout = useMemo(() => timelineLayout(graph, 1100, now, t('lang')), [graph, now, t])
  const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph])
  const near = neighbours(graph.edges, hover)
  const dim = (ids: string[]) => hover !== undefined && !ids.every(id => near.has(id))
  return <div className="dt-graph-scroll">
    <svg className="dt-graph-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="img"
      aria-label={t('graphLabel')}>
      <Markers />
      {layout.ticks.map(tick => <g key={tick.x} className="dt-graph-tick">
        <line x1={tick.x} x2={tick.x} y1={22} y2={layout.height} /><text x={tick.x} y={14}>{tick.label}</text>
      </g>)}
      {layout.lanes.map((lane, index) => <g key={lane.key} className="dt-graph-lane" data-odd={index % 2 === 1 || undefined}>
        <rect x={0} y={lane.y - LANE / 2} width={layout.width} height={LANE} />
        <text x={8} y={lane.y + 4}><title>{lane.title}</title>{shortTitle(lane.title || lane.key, 12)}</text>
      </g>)}
      {graph.edges.filter(edge => edge.via !== 'thread').map(edge => {
        const a = layout.spans.get(edge.from), b = layout.spans.get(edge.to)
        if (!a || !b) return null
        // On one lane an arc runs above the spans from where the parent began to where the child began; across lanes
        // a spawned edge leaves the parent's span at the child's start, so the arrow lands where the child began.
        if (a.y === b.y) {
          const x0 = Math.min(a.x0, b.x0), x1 = Math.max(a.x0, b.x0), lift = Math.min(26, Math.max(9, (x1 - x0) / 3))
          const forward = a.x0 <= b.x0
          const d = `M${forward ? x0 : x1} ${a.y - 6} Q${(x0 + x1) / 2} ${a.y - 6 - lift * 2} ${forward ? x1 : x0} ${a.y - 6}`
          return <path key={`${edge.kind}${edge.from}${edge.to}`} className="dt-graph-edge" data-kind={edge.kind} data-dim={dim([edge.from, edge.to]) || undefined}
            d={d} markerEnd={edge.kind === 'related' ? undefined : `url(#dt-graph-arrow-${edge.kind})`}><title>{edgeLabel(t, edge, nodes)}</title></path>
        }
        const x0 = edge.kind === 'spawned' ? Math.min(Math.max(b.x0, a.x0), a.x1) : a.x0, x1 = b.x0
        const bend = Math.max(Math.abs(b.y - a.y) * .5, 24)
        const d = `M${x0} ${a.y} C${x0 + bend} ${a.y}, ${x1 - bend} ${b.y}, ${x1} ${b.y}`
        return <path key={`${edge.kind}${edge.from}${edge.to}`} className="dt-graph-edge" data-kind={edge.kind} data-dim={dim([edge.from, edge.to]) || undefined}
          d={d} markerEnd={edge.kind === 'related' ? undefined : `url(#dt-graph-arrow-${edge.kind})`}><title>{edgeLabel(t, edge, nodes)}</title></path>
      })}
      {graph.nodes.map(node => {
        const span = layout.spans.get(node.id)!
        return <g key={node.id} className="dt-graph-node" data-tone={nodeTone(node)} data-dim={dim([node.id]) || undefined}
          data-hover={hover === node.id || undefined} tabIndex={0} role="link" aria-label={node.title}
          onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(undefined)} onFocus={() => setHover(node.id)}
          onBlur={() => setHover(undefined)} onClick={() => open(node.id)} onKeyDown={event => { if (event.key === 'Enter') open(node.id) }}>
          <title>{node.title}</title>
          <rect className="dt-graph-span" x={span.x0} y={span.y - 4} width={span.x1 - span.x0} height={8} rx={4} />
          <circle cx={span.x0} cy={span.y} r={5.5} />
          {hover === node.id && <text className="dt-graph-label" x={span.x0 + 9} y={span.y - 9}>{shortTitle(node.title, 28)}</text>}
        </g>
      })}
    </svg>
  </div>
}

const CLOUD = { width: 1100, height: 620 }
function Cloud({ graph, hover, setHover, open }: { graph: Graph; hover?: string; setHover: (id?: string) => void; open: (id: string) => void }) {
  const { t } = usePanel()
  const base = useMemo(() => cloudLayout(graph.nodes, graph.edges, CLOUD.width, CLOUD.height), [graph])
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({})
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | undefined>(undefined)
  const svg = useRef<SVGSVGElement>(null)
  const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph])
  const at = (id: string) => moved[id] ?? base.get(id)!
  const near = neighbours(graph.edges, hover)
  const dim = (ids: string[]) => hover !== undefined && !ids.every(id => near.has(id))
  const now = Date.now()
  const radius = (node: GraphNode) => {
    const hours = ((node.endedAt ? Date.parse(node.endedAt) : now) - Date.parse(node.createdAt)) / 3_600_000
    return Math.min(4 + Math.sqrt(Math.max(hours, 0)) * 1.6, 15)
  }
  const point = (event: ReactPointerEvent) => {
    const box = svg.current?.getBoundingClientRect()
    if (!box || !box.width) return { x: 0, y: 0 }
    return { x: (event.clientX - box.left) / box.width * CLOUD.width, y: (event.clientY - box.top) / box.height * CLOUD.height }
  }
  // The six Tickets with the most relations other than a shared conversation carry their name; the rest show it on hover.
  const degree = new Map<string, number>()
  for (const edge of graph.edges) if (edge.via !== 'thread') for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const hubs = new Set([...degree.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id))
  return <svg ref={svg} className="dt-graph-svg dt-graph-cloud" viewBox={`0 0 ${CLOUD.width} ${CLOUD.height}`} role="img" aria-label={t('graphLabel')}
    onPointerMove={event => {
      const current = drag.current
      if (!current) return
      const p = point(event)
      if (Math.hypot(p.x - current.x, p.y - current.y) > 3) current.moved = true
      if (current.moved) setMoved(value => ({ ...value, [current.id]: p }))
    }}
    onPointerUp={() => { const current = drag.current; drag.current = undefined; if (current && !current.moved) open(current.id) }}
    onPointerLeave={() => { drag.current = undefined }}>
    <Markers />
    {graph.edges.map(edge => {
      const a = at(edge.from), b = at(edge.to)
      const target = nodes.get(edge.to)
      // Stop the line at the target's rim so the arrowhead stays visible.
      const d = Math.max(Math.hypot(b.x - a.x, b.y - a.y), .01), r = target ? radius(target) + 2 : 0
      const x1 = b.x - (b.x - a.x) / d * r, y1 = b.y - (b.y - a.y) / d * r
      return <line key={`${edge.kind}${edge.from}${edge.to}`} className="dt-graph-edge" data-kind={edge.kind} data-dim={dim([edge.from, edge.to]) || undefined}
        x1={a.x} y1={a.y} x2={x1} y2={y1} markerEnd={edge.kind === 'related' ? undefined : `url(#dt-graph-arrow-${edge.kind})`}>
        <title>{edgeLabel(t, edge, nodes)}</title></line>
    })}
    {graph.nodes.map(node => {
      const p = at(node.id), r = radius(node)
      // Name the hubs, which a person reads first, and whatever the pointer is on.
      const named = hover === node.id || (hover === undefined && hubs.has(node.id))
      return <g key={node.id} className="dt-graph-node" data-tone={nodeTone(node)} data-dim={dim([node.id]) || undefined}
        data-hover={hover === node.id || undefined} tabIndex={0} role="link" aria-label={node.title}
        onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(undefined)} onFocus={() => setHover(node.id)}
        onBlur={() => setHover(undefined)} onKeyDown={event => { if (event.key === 'Enter') open(node.id) }}
        onPointerDown={event => { event.preventDefault(); drag.current = { id: node.id, ...point(event), moved: false } }}>
        <title>{node.title}</title>
        <circle className="dt-graph-halo" cx={p.x} cy={p.y} r={r + 5} />
        <circle cx={p.x} cy={p.y} r={r} />
        {named && <text className="dt-graph-label" x={p.x + r + 4} y={p.y + 4}>{shortTitle(node.title, hover === node.id ? 28 : 14)}</text>}
      </g>
    })}
  </svg>
}

/** The relation view of 概览: a layout switch, the chart, and its legend. */
export function GraphPage() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET tickets/graph'), [], 30_000)
  const [layout, setLayout] = useState<Layout>('timeline')
  const [linked, setLinked] = useState(true)
  const [hover, setHover] = useState<string>()
  const graph = useMemo(() => {
    if (!data || !linked) return data
    // Only Tickets with a relation other than sharing a conversation, which the lanes already show.
    const strong = data.edges.filter(edge => edge.via !== 'thread')
    const ids = new Set(strong.flatMap(edge => [edge.from, edge.to]))
    return { ...data, nodes: data.nodes.filter(node => ids.has(node.id)), edges: data.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) }
  }, [data, linked])
  if (!data || !graph) return <LoadState error={error} loading={!error} />
  const open = (id: string) => navigate({ page: 'execution', id })
  return <section className="dt-graph" aria-label={t('graphLabel')}>
    <div className="dt-graph-head">
      <SegmentedControl className="dt-graph-switch" label={t('graphLayoutLabel')} value={layout} onChange={setLayout}
        options={[{ value: 'timeline', label: t('graphLayoutTimeline') }, { value: 'cloud', label: t('graphLayoutCloud') }]} />
      <Pill active={linked} onClick={() => setLinked(value => !value)}>{t('graphOnlyLinked')}</Pill>
      <span className="dt-graph-count">{t('graphCount', { nodes: String(graph.nodes.length), edges: String(graph.edges.filter(edge =>
        edge.via !== 'thread').length) })}{data.total > data.nodes.length ? ` · ${t('graphCapped', { shown: String(data.nodes.length),
        total: String(data.total) })}` : ''}</span>
    </div>
    <Hint>{t(layout === 'timeline' ? 'graphHint' : 'graphCloudHint')}</Hint>
    {graph.nodes.length === 0 ? <Hint>{t('graphEmpty')}</Hint> : <div className="dt-graph-frame">
      {layout === 'timeline' ? <Timeline graph={graph} hover={hover} setHover={setHover} open={open} />
        : <Cloud graph={graph} hover={hover} setHover={setHover} open={open} />}
    </div>}
    <Legend />
  </section>
}
