/**
 * The overview's relation view: every recent Ticket as a node and how Tickets relate as edges, in two layouts. The
 * timeline is a time DAG, one lane per conversation, with each Ticket drawn as the span it ran; the cloud is a
 * force-directed layout where related Tickets cluster, drawn silver on charcoal, that keeps drifting gently with specks
 * running along its edges, and faint dotted lines for the likely relations the host guessed (`similar`). Both are plain
 * SVG with no layout library; the cloud's motion is written straight to the DOM on each animation frame, with a canvas
 * behind it for the soft rims and specks.
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
/**
 * Guessed (`similar`) edges in the cloud: a weak spring whose rest length shrinks with strength (`rest`, strongest to
 * weakest) at `pull × strength` of an explicit edge's pull, so they nudge isolated Tickets towards their likely topic without
 * reshaping the explicit clusters; a stroke opacity from `alpha[0]` at the threshold (`floor`) to `alpha[1]` at `full`; and
 * on hover a reason of at most `why` characters along the edge, `along` of the way out from the hovered Ticket by preference.
 */
export const FUZZY = { pull: .3, rest: [64, 150], alpha: [.08, .14], floor: .3, full: .7, why: 26, along: [.62, .5, .76, .38] } as const
/** The stroke opacity of a guessed edge of this strength. */
export const fuzzyAlpha = (strength = 0) => FUZZY.alpha[0] + (FUZZY.alpha[1] - FUZZY.alpha[0])
  * Math.min(1, Math.max(0, (strength - FUZZY.floor) / (FUZZY.full - FUZZY.floor)))
/** How hard an edge pulls in the layout and the drift, against an explicit edge's 1. */
const pullOf = (edge: Pick<GraphEdge, 'kind' | 'strength'>) => edge.kind === 'similar' ? FUZZY.pull * (edge.strength ?? 0) : 1
const guessed = (edge: Pick<GraphEdge, 'kind'>) => edge.kind === 'similar'

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
 * Force-directed positions: every pair repels, every edge pulls its ends together (a guessed one weakly, see `FUZZY`), and
 * a weak pull keeps the cloud centred. Deterministic for the same graph, and cheap for the few hundred Tickets the view holds.
 */
export function cloudLayout(nodes: Pick<GraphNode, 'id'>[], edges: Pick<GraphEdge, 'from' | 'to' | 'kind' | 'strength'>[], width: number,
  height: number, iterations = 260): Map<string, { x: number; y: number }> {
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const px = nodes.map(node => (seed(node.id) - .5) * width * .8), py = nodes.map(node => (seed(`${node.id}:y`) - .5) * height * .8)
  const links = edges.flatMap(edge => {
    const a = index.get(edge.from), b = index.get(edge.to)
    if (a === undefined || b === undefined) return []
    const length = guessed(edge) ? FUZZY.rest[1] - (FUZZY.rest[1] - FUZZY.rest[0]) * (edge.strength ?? 0) : edge.kind === 'related' ? 56 : 44
    return [{ a, b, length, weight: pullOf(edge) }]
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
    for (const { a, b, length, weight } of links) {
      const x = px[b]! - px[a]!, y = py[b]! - py[a]!
      const d = Math.max(Math.hypot(x, y), .01), pull = (d - length) / d * .5 * weight
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

/**
 * Arrowheads: a small filled kite in the edge's colour, about 1.7 times as long as it is wide, with its tip at the
 * line's end, which stops just short of the target's rim. A square marker viewport with no `viewBox` keeps the head its
 * stated size: Chromium renders a non-square viewBox smaller than asked.
 */
function Markers() {
  return <defs>
    {KINDS.map(kind => <marker key={kind} id={`dt-graph-arrow-${kind}`} markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8"
      refX="8" refY="4" orient="auto-start-reverse"><path className="dt-graph-arrow" data-kind={kind} d="M0 1.6 L8 4 L0 6.4 L1.25 4 Z" /></marker>)}
  </defs>
}
function Legend({ fuzzy }: { fuzzy: boolean }) {
  const { t } = usePanel()
  return <div className="dt-graph-legend" aria-label={t('graphLegend')}>
    {[...KINDS, ...fuzzy ? ['similar' as const] : []].map(kind => <span key={kind} className="dt-graph-legend-item">
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
  // A guess has no direction, and says how sure it is.
  const strength = edge.strength === undefined ? '' : ` ${Math.round(edge.strength * 100)}%`
  return `${nodes.get(edge.from)?.title ?? edge.from} ${guessed(edge) ? '↔' : '→'} ${nodes.get(edge.to)?.title ?? edge.to} · ${t(`relation.${edge.kind}`)}${strength} · ${t(`relationVia.${edge.via}`)}${edge.reason ? ` · ${edge.reason}` : ''}`
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
      {graph.edges.filter(edge => edge.via !== 'thread' && !guessed(edge)).map(edge => {
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
        // Stop at the child node's rim, so the arrowhead is not hidden under the node circle drawn above it.
        const dir = x1 >= x0 ? 1 : -1, tip = x1 - dir * Math.min(9, Math.abs(x1 - x0) * .4)
        const d = `M${x0} ${a.y} C${x0 + bend} ${a.y}, ${x1 - dir * bend} ${b.y}, ${tip} ${b.y}`
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
          {/* As in the cloud: beside the node and vertically centred on it, right of where the span ends (left of its start near the edge). */}
          {hover === node.id && (span.x1 + 8 + textWidth(shortTitle(node.title, 28), 12) <= layout.width
            ? <text className="dt-graph-label" x={span.x1 + 8} y={span.y} dominantBaseline="central">{shortTitle(node.title, 28)}</text>
            : <text className="dt-graph-label" x={span.x0 - 9} y={span.y} dominantBaseline="central" textAnchor="end">{shortTitle(node.title, 28)}</text>)}
        </g>
      })}
    </svg>
  </div>
}

const CLOUD = { width: 1100, height: 620 }
/**
 * How the cloud keeps moving once it has settled, as in Obsidian's graph: every node is tied to a home by a soft spring
 * and the home itself wanders on a slow Lissajous loop, edges are springs at the settled length, and a short-range push
 * keeps rims apart. Dragging pins one node, so its neighbours follow through the edge springs and ease back afterwards.
 */
export const MOTION = { drift: 1.8, periodMs: [7000, 12000], anchor: .018, spring: .07, gap: 10, damping: .84, fps: 60 } as const
/**
 * The cloud's quiet life on top of the drift: each node breathes (radius and brightness by `breath`, on its own period
 * and phase), and now and then a speck runs along an edge from the Ticket that started the other (either way along a
 * `related` one), fading in and out at the ends. Both are drawn without React: positions go straight to the SVG through
 * refs, specks and the soft rims onto a canvas behind it.
 */
export const LIFE = { breath: .03, breathMs: [5000, 9000], rim: 4.5, rimAlpha: .08, rimLit: .12, every: [2000, 5000], speed: 34, minMs: 1600,
  speck: 1.1, alpha: .35, litAlpha: .6, litSpeed: 1.35, dimAlpha: .15, cap: 120 } as const
/**
 * The node itself: a flat fill with a frosted sheen, a 1px stroke, and layers only on the bigger ones: a top-left gleam
 * from radius `gleam` up, a thin ring `halo` out around hubs (`hub` relations or more, so the busiest few Tickets of a
 * typical day carry one). Hovering grows the radius by `lift` over `liftMs`; breathing only moves the fill's opacity,
 * so edges stay sharp.
 */
export const NODE = { gleam: 6, hub: 6, halo: 2, lift: .8, liftMs: 200 } as const
/** Obsidian's sizing: the more relations a Ticket has (besides a shared conversation), the bigger its node, up to a cap. */
export const nodeRadius = (degree: number) => Math.min(3.5 + Math.sqrt(degree) * 2.3, 13)
interface Body { x: number; y: number; vx: number; vy: number; hx: number; hy: number; phase: number; period: number; r: number; breath: number; breathMs: number; lift: number }
/** The gleam: a 120° arc on the top-left, just inside the stroke. */
const gleamArc = (r: number) => {
  const at = (deg: number) => `${(Math.cos(deg / 180 * Math.PI) * r).toFixed(2)} ${(Math.sin(deg / 180 * Math.PI) * r).toFixed(2)}`
  return `M${at(165)} A${r} ${r} 0 0 1 ${at(285)}`
}
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
/** Rough label width: CJK at the font size, Latin a little over half of it. */
const textWidth = (text: string, size: number) => Array.from(text).reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? size : size * .58), 0)
/**
 * A placed label: a node's name beside it (`right` or `left`), or a guessed edge's reason (`along`) centred on the edge
 * `t` of the way from `from` to `to`.
 */
export interface Label { id: string; text: string; side: 'right' | 'left' | 'along'; minor: boolean; along?: { from: string; to: string; t: number } }
type Box = { x0: number; y0: number; x1: number; y1: number }
/** What may be labelled: a node by its id, or with `along` an edge, at the first of the fractions `t` that has room. */
export interface WantedLabel { id: string; text: string; force?: boolean; minor?: boolean; along?: { from: string; to: string; t: readonly number[] } }
/** The reasons' font size, smaller than the minor names'. */
const WHY_SIZE = 9.5
/**
 * Greedy placement in priority order: right of the node, else left of it, vertically centred either way; a label that
 * would overlap one already placed or another node is dropped, so names never pile up in the middle. `force` labels
 * (the hovered node) are always kept. An edge's label tries each of its points along the edge and is dropped, never forced,
 * when none is clear of the names and nodes already there.
 */
export function placeLabels(wanted: WantedLabel[], at: Map<string, { x: number; y: number; r: number }>, width: number, height: number): Label[] {
  const boxes: Box[] = [], placed: Label[] = []
  const hits = (b: Box) => boxes.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)
  const covers = (b: Box, self: string) => [...at].some(([id, p]) => id !== self
    && p.x + p.r > b.x0 && p.x - p.r < b.x1 && p.y + p.r > b.y0 && p.y - p.r < b.y1)
  const inside = (b: Box) => b.x0 >= 0 && b.x1 <= width && b.y0 >= 0 && b.y1 <= height
  for (const want of wanted) {
    if (want.along) {
      const a = at.get(want.along.from), b = at.get(want.along.to)
      if (!a || !b) continue
      const w = textWidth(want.text, WHY_SIZE) + 4, h = WHY_SIZE + 4
      const t = want.along.t.find(t => {
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, box = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 }
        if (!inside(box) || hits(box) || covers(box, '')) return false
        boxes.push(box)
        return true
      })
      if (t !== undefined) placed.push({ id: want.id, text: want.text, side: 'along', minor: true, along: { from: want.along.from, to: want.along.to, t } })
      continue
    }
    const p = at.get(want.id)
    if (!p) continue
    const size = want.minor ? 11 : 12, w = textWidth(want.text, size) + 4, h = size + 4
    const options = (['right', 'left'] as const).map(side => ({ side, box: side === 'right'
      ? { x0: p.x + p.r + 3, y0: p.y - h / 2, x1: p.x + p.r + 3 + w, y1: p.y + h / 2 }
      : { x0: p.x - p.r - 3 - w, y0: p.y - h / 2, x1: p.x - p.r - 3, y1: p.y + h / 2 } }))
      .filter(o => inside(o.box))
    const pick = options.find(o => !hits(o.box) && !covers(o.box, want.id))
      ?? (want.force ? options[0] ?? { side: 'left' as const, box: { x0: 0, y0: 0, x1: 0, y1: 0 } } : undefined)
    if (!pick) continue
    boxes.push(pick.box)
    placed.push({ id: want.id, text: want.text, side: pick.side, minor: !!want.minor })
  }
  return placed
}
/** Where an edge's line runs: from the source's centre to the target's rim, so the arrowhead shows. */
export function edgeEnds(a: Pick<Body, 'x' | 'y'>, b: Pick<Body, 'x' | 'y' | 'r'>) {
  const d = Math.max(Math.hypot(b.x - a.x, b.y - a.y), .01), r = b.r + 2
  return { x1: a.x, y1: a.y, x2: b.x - (b.x - a.x) / d * r, y2: b.y - (b.y - a.y) / d * r }
}
/** Where a label's anchor is now: beside its node, or its point along its edge. */
function labelAt(label: Label, map: Map<string, Pick<Body, 'x' | 'y' | 'r'>>): { x: number; y: number } | undefined {
  if (label.along) {
    const a = map.get(label.along.from), b = map.get(label.along.to)
    return a && b ? { x: a.x + (b.x - a.x) * label.along.t, y: a.y + (b.y - a.y) * label.along.t } : undefined
  }
  const p = map.get(label.id)
  return p && { x: label.side === 'right' ? p.x + p.r + 5 : p.x - p.r - 5, y: p.y }
}
const whyId = (edge: Pick<GraphEdge, 'from' | 'to'>) => `why:${edge.from}:${edge.to}`
/** A guess's hover text: its score and its two strongest reasons, shortened. */
const whyText = (edge: Pick<GraphEdge, 'strength' | 'reason'>) =>
  shortTitle(`${Math.round((edge.strength ?? 0) * 100)}% · ${(edge.reason ?? '').split('；').slice(0, 2).join('；')}`, FUZZY.why)
/**
 * The specks on one edge at a moment of that edge's own clock: one leaves every `every` ms and crosses in `ms`, so
 * several can be on a long edge at once. `t` runs 0 → 1 from the edge's source; `back` when a two-way edge's speck runs
 * the other way. Pure, so the schedule is the same on every load.
 */
export function specks(key: string, clock: number, every: number, ms: number, twoWay: boolean): { t: number; back: boolean }[] {
  const offset = seed(`${key}:offset`) * every, out: { t: number; back: boolean }[] = []
  for (let k = Math.ceil((clock - offset - ms) / every); k <= Math.floor((clock - offset) / every); k++) {
    const t = (clock - offset - k * every) / ms
    // The speck's number leads the hashed text: the hash spreads early characters well and trailing ones poorly, so
    // `key:k` would send a run of specks the same way.
    if (t >= 0 && t < 1) out.push({ t, back: twoWay && seed(`${k}:${key}`) < .5 })
  }
  return out
}
function Cloud({ graph, hover, setHover, open }: { graph: Graph; hover?: string; setHover: (id?: string) => void; open: (id: string) => void }) {
  const { t } = usePanel()
  // The sheen's gradient is per cloud, so two clouds on one page never share an id.
  const frost = `dt-graph-frost-${useId().replace(/[^\w-]/g, '')}`
  const base = useMemo(() => cloudLayout(graph.nodes, graph.edges, CLOUD.width, CLOUD.height), [graph])
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | undefined>(undefined)
  const svg = useRef<SVGSVGElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const dots = useRef(new Map<string, SVGCircleElement>())
  const dress = useRef(new Map<string, SVGGElement>())
  const lines = useRef<(SVGLineElement | null)[]>([])
  const names = useRef(new Map<string, SVGTextElement>())
  const [settled, setSettled] = useState(0)
  const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph])
  const near = neighbours(graph.edges, hover)
  const dim = (ids: string[]) => hover !== undefined && !ids.every(id => near.has(id))
  const degree = useMemo(() => {
    const count = new Map<string, number>()
    // A guess is not a relation, so it never grows a node.
    for (const edge of graph.edges) if (edge.via !== 'thread' && !guessed(edge)) for (const id of [edge.from, edge.to]) count.set(id, (count.get(id) ?? 0) + 1)
    return count
  }, [graph])
  const radius = (id: string) => nodeRadius(degree.get(id) ?? 0)
  const bodies = useRef(new Map<string, Body>())
  const links = useMemo(() => graph.edges.flatMap(edge => {
    const a = base.get(edge.from), b = base.get(edge.to)
    return a && b ? [{ a: edge.from, b: edge.to, rest: Math.hypot(b.x - a.x, b.y - a.y), weight: pullOf(edge) }] : []
  }), [graph, base])
  // Keep where known Tickets already are when the poll brings a new graph; new ones start at their layout position.
  const known = bodies.current
  if (known.size !== graph.nodes.length || graph.nodes.some(node => !known.has(node.id))) {
    bodies.current = new Map(graph.nodes.map(node => {
      const old = known.get(node.id), p = base.get(node.id)!
      return [node.id, old ?? { x: p.x, y: p.y, vx: 0, vy: 0, hx: p.x, hy: p.y, phase: seed(`${node.id}:phase`) * Math.PI * 2,
        period: MOTION.periodMs[0] + seed(`${node.id}:period`) * (MOTION.periodMs[1] - MOTION.periodMs[0]), r: radius(node.id),
        breath: seed(`${node.id}:breath`) * Math.PI * 2, breathMs: LIFE.breathMs[0] + seed(`${node.id}:breathMs`) * (LIFE.breathMs[1] - LIFE.breathMs[0]), lift: 0 }]
    }))
  }
  const at = (id: string) => bodies.current.get(id)!
  // Names: with nothing hovered, the hubs that fit; on hover, the hovered Ticket, the reasons of its guessed edges, and then
  // whichever neighbours' names fit. A reason with no room is left to the edge's tooltip.
  const ranked = useMemo(() => [...degree.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).map(([id]) => id), [degree])
  const labels = useMemo(() => {
    const homes = new Map([...bodies.current].map(([id, body]) => [id, { x: body.hx, y: body.hy, r: body.r }]))
    const title = (id: string, max: number) => shortTitle(nodes.get(id)?.title ?? id, max)
    const whys = hover === undefined ? [] : graph.edges.filter(edge => guessed(edge) && edge.reason && (edge.from === hover || edge.to === hover))
      .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0)).map((edge): WantedLabel => ({ id: whyId(edge), text: whyText(edge),
        along: { from: hover, to: edge.from === hover ? edge.to : edge.from, t: FUZZY.along } }))
    const wanted: WantedLabel[] = hover === undefined ? ranked.slice(0, 10).map(id => ({ id, text: title(id, 14) }))
      : [{ id: hover, text: title(hover, 28), force: true }, ...whys, ...[...near].filter(id => id !== hover)
        .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)).map(id => ({ id, text: title(id, 12), minor: true }))]
    return placeLabels(wanted, homes, CLOUD.width, CLOUD.height)
  }, [hover, ranked, nodes, settled, graph])
  const lit = (edge: GraphEdge) => hover !== undefined && (edge.from === hover || edge.to === hover)
  // What the frame loop reads, refreshed on every render so hovering never restarts the loop.
  const scene = useRef({ edges: graph.edges, labels, hover, near })
  scene.current = { edges: graph.edges, labels, hover, near }
  const clocks = useRef(new Map<string, number>())
  /** One frame: positions and breathing straight onto the SVG, then the rims and specks onto the canvas behind it. */
  const paint = (time: number, dt: number, still: boolean) => {
    const { edges, labels, hover, near } = scene.current, map = bodies.current
    for (const [id, body] of map) {
      const dot = dots.current.get(id)
      if (!dot) continue
      // The hover lift eases in over about `liftMs`; reduced motion jumps straight there.
      const target = id === hover ? NODE.lift : 0
      body.lift = still ? target : body.lift + (target - body.lift) * Math.min(1, dt / (NODE.liftMs / 3))
      const breath = still ? 0 : Math.sin(time / body.breathMs * Math.PI * 2 + body.breath), r = body.r + body.lift
      dot.setAttribute('cx', body.x.toFixed(2)); dot.setAttribute('cy', body.y.toFixed(2)); dot.setAttribute('r', r.toFixed(2))
      dot.style.fillOpacity = still ? '1' : (1 - LIFE.breath * (1 - breath)).toFixed(3)
      dress.current.get(id)?.setAttribute('transform', `translate(${body.x.toFixed(2)} ${body.y.toFixed(2)}) scale(${(r / body.r).toFixed(4)})`)
    }
    edges.forEach((edge, i) => {
      const line = lines.current[i], a = map.get(edge.from), b = map.get(edge.to)
      if (!line || !a || !b) return
      for (const [name, value] of Object.entries(edgeEnds(a, b))) line.setAttribute(name, value.toFixed(2))
    })
    for (const label of labels) {
      const text = names.current.get(label.id), p = labelAt(label, map)
      if (!text || !p) continue
      text.setAttribute('x', p.x.toFixed(2)); text.setAttribute('y', p.y.toFixed(2))
    }
    const el = canvas.current, ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const box = el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, w = Math.round(box.width * dpr), h = Math.round(box.height * dpr)
    if (!w || !h) return
    if (el.width !== w || el.height !== h) { el.width = w; el.height = h }
    ctx.setTransform(w / CLOUD.width, 0, 0, h / CLOUD.height, 0, 0)
    ctx.clearRect(0, 0, CLOUD.width, CLOUD.height)
    const faded = (ids: string[]) => hover !== undefined && !ids.every(id => near.has(id))
    // A thin silver rim around each node: enough to give it body, never enough to glow.
    for (const [id, body] of map) {
      const alpha = faded([id]) ? LIFE.rimAlpha * LIFE.dimAlpha : LIFE.rimAlpha + (LIFE.rimLit - LIFE.rimAlpha) * body.lift / NODE.lift
      const r = body.r + body.lift, rim = ctx.createRadialGradient(body.x, body.y, r * .9, body.x, body.y, r + LIFE.rim)
      rim.addColorStop(0, `rgba(215, 218, 222, ${alpha.toFixed(3)})`); rim.addColorStop(1, 'rgba(215, 218, 222, 0)')
      ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(body.x, body.y, r + LIFE.rim, 0, Math.PI * 2); ctx.fill()
    }
    if (still) return
    let count = 0
    for (const edge of edges) {
      const a = map.get(edge.from), b = map.get(edge.to)
      // A guess carries no specks: nothing flowed along it.
      if (!a || !b || guessed(edge)) continue
      const key = `${edge.kind}${edge.from}${edge.to}`, on = hover !== undefined && (edge.from === hover || edge.to === hover)
      // Each edge keeps its own clock, so the hovered Ticket's specks speed up without jumping.
      const clock = (clocks.current.get(key) ?? 0) + dt * (on ? LIFE.litSpeed : 1)
      clocks.current.set(key, clock)
      if (count >= LIFE.cap) continue
      const length = Math.max(Math.hypot(b.x - a.x, b.y - a.y), .01), every = LIFE.every[0] + seed(`${key}:every`) * (LIFE.every[1] - LIFE.every[0])
      const alpha = on ? LIFE.litAlpha : LIFE.alpha * (faded([edge.from, edge.to]) ? LIFE.dimAlpha : 1)
      for (const speck of specks(key, clock, every, Math.max(length / LIFE.speed * 1000, LIFE.minMs), edge.kind === 'related')) {
        // From just outside one rim to just outside the other, fading in and out there.
        const [from, to] = speck.back ? [b, a] : [a, b], s0 = (from.r + 1) / length, s1 = 1 - (to.r + 1) / length
        if (s1 <= s0 || count++ >= LIFE.cap) continue
        const s = s0 + (s1 - s0) * speck.t
        ctx.fillStyle = `rgba(222, 226, 232, ${(alpha * Math.sin(Math.PI * speck.t)).toFixed(3)})`
        ctx.beginPath(); ctx.arc(from.x + (to.x - from.x) * s, from.y + (to.y - from.y) * s, LIFE.speck, 0, Math.PI * 2); ctx.fill()
      }
    }
  }
  const paintRef = useRef(paint)
  paintRef.current = paint
  useEffect(() => {
    // Reduced motion: no drift, breathing or specks, so no loop at all; the still scene is painted after each render
    // below, and a dragged node follows the pointer straight from the pointer handler.
    if (reducedMotion()) return
    let frame = 0, last = 0, visible = true
    // The loop stops while the cloud is scrolled away or the tab is hidden, and starts again when either comes back.
    const resume = () => { if (!frame && visible && !document.hidden) frame = requestAnimationFrame(tick) }
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; resume() }) : undefined
    if (svg.current) observer?.observe(svg.current)
    document.addEventListener('visibilitychange', resume)
    const tick = (time: number) => {
      if (!visible || document.hidden) { frame = 0; last = 0; return }
      frame = requestAnimationFrame(tick)
      if (time - last < 1000 / MOTION.fps - 1) return
      // After a pause the specks carry on from where they were instead of fast-forwarding.
      const dt = last ? Math.min(time - last, 100) : 0
      last = time
      const map = bodies.current, list = [...map.values()], pinned = drag.current?.moved ? drag.current.id : undefined
      const fx = new Map<Body, number>(), fy = new Map<Body, number>()
      for (const body of list) {
        const angle = time / body.period * Math.PI * 2 + body.phase
        fx.set(body, (body.hx + Math.sin(angle) * MOTION.drift - body.x) * MOTION.anchor)
        fy.set(body, (body.hy + Math.cos(angle * .77) * MOTION.drift - body.y) * MOTION.anchor)
      }
      for (const link of links) {
        const a = map.get(link.a), b = map.get(link.b)
        if (!a || !b) continue
        const x = b.x - a.x, y = b.y - a.y, d = Math.max(Math.hypot(x, y), .01), pull = (d - link.rest) / d * MOTION.spring * link.weight
        fx.set(a, fx.get(a)! + x * pull); fy.set(a, fy.get(a)! + y * pull); fx.set(b, fx.get(b)! - x * pull); fy.set(b, fy.get(b)! - y * pull)
      }
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!, x = b.x - a.x, y = b.y - a.y, min = a.r + b.r + MOTION.gap, d2 = x * x + y * y
        if (d2 >= min * min) continue
        const d = Math.max(Math.sqrt(d2), .01), push = (min - d) / d * .25
        fx.set(a, fx.get(a)! - x * push); fy.set(a, fy.get(a)! - y * push); fx.set(b, fx.get(b)! + x * push); fy.set(b, fy.get(b)! + y * push)
      }
      for (const body of list) {
        body.vx = (body.vx + fx.get(body)!) * MOTION.damping; body.vy = (body.vy + fy.get(body)!) * MOTION.damping
        body.x += body.vx; body.y += body.vy
      }
      if (pinned) { const body = map.get(pinned)!; body.x = drag.current!.x; body.y = drag.current!.y; body.vx = body.vy = 0 }
      paintRef.current(time, dt, false)
    }
    resume()
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); document.removeEventListener('visibilitychange', resume) }
  }, [links])
  // Reduced motion runs no loop, so paint the still scene (rims follow the hover) after every render.
  useEffect(() => { if (reducedMotion()) paintRef.current(0, 0, true) })
  const point = (event: ReactPointerEvent) => {
    const box = svg.current?.getBoundingClientRect()
    if (!box || !box.width) return { x: 0, y: 0 }
    return { x: (event.clientX - box.left) / box.width * CLOUD.width, y: (event.clientY - box.top) / box.height * CLOUD.height }
  }
  return <div className="dt-graph-cloud-stage">
    <canvas ref={canvas} className="dt-graph-cloud-life" aria-hidden="true" />
    <svg ref={svg} className="dt-graph-svg dt-graph-cloud" viewBox={`0 0 ${CLOUD.width} ${CLOUD.height}`} role="img" aria-label={t('graphLabel')}
      data-hovering={hover !== undefined || undefined}
      onPointerMove={event => {
        const current = drag.current
        if (!current) return
        const p = point(event)
        if (Math.hypot(p.x - current.x, p.y - current.y) > 3) current.moved = true
        if (current.moved) {
          current.x = p.x; current.y = p.y
          if (reducedMotion()) { const body = at(current.id); body.x = p.x; body.y = p.y; paintRef.current(0, 0, true) }
        }
      }}
      onPointerUp={() => {
        const current = drag.current; drag.current = undefined
        if (current && !current.moved) open(current.id)
        // The dropped node stays where it was put, as its new home; its neighbours ease back towards theirs.
        else if (current) { const body = at(current.id); body.hx = body.x; body.hy = body.y; setSettled(value => value + 1) }
      }}
      onPointerLeave={() => { drag.current = undefined }}>
      <Markers />
      <defs>
        {/* Frosted sheen: a few percent lighter at the top left, a few darker at the bottom right, never a visible sphere. */}
        <radialGradient id={frost} cx=".34" cy=".3" r=".78">
          <stop offset="0" stopColor="#fff" stopOpacity=".035" /><stop offset=".55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".035" />
        </radialGradient>
      </defs>
      <g className="dt-graph-edges">
        {/* Arrows show only on the hovered Ticket's edges, never on a guess, which has no direction; a guess's faintness follows its strength. */}
        {graph.edges.map((edge, i) => <line key={`${edge.kind}${edge.from}${edge.to}`} ref={line => { lines.current[i] = line }} className="dt-graph-edge"
          data-kind={edge.kind} data-dim={dim([edge.from, edge.to]) || undefined} data-lit={lit(edge) || undefined} {...edgeEnds(at(edge.from), at(edge.to))}
          markerEnd={edge.kind === 'related' || guessed(edge) || !lit(edge) ? undefined : `url(#dt-graph-arrow-${edge.kind})`}
          style={guessed(edge) && !lit(edge) ? { strokeOpacity: fuzzyAlpha(edge.strength) } : undefined}>
          <title>{edgeLabel(t, edge, nodes)}</title></line>)}
      </g>
      {graph.nodes.map(node => {
        const p = at(node.id), rank = ranked.indexOf(node.id)
        return <g key={node.id} className="dt-graph-node" data-tone={nodeTone(node)} data-dim={dim([node.id]) || undefined}
          data-hover={hover === node.id || undefined} data-near={(hover !== undefined && near.has(node.id)) || undefined}
          data-rank={rank >= 0 ? rank : undefined} tabIndex={0} role="link" aria-label={node.title}
          onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(undefined)} onFocus={() => setHover(node.id)}
          onBlur={() => setHover(undefined)} onKeyDown={event => { if (event.key === 'Enter') open(node.id) }}
          onPointerDown={event => { event.preventDefault(); drag.current = { id: node.id, ...point(event), moved: false } }}>
          <title>{node.title}</title>
          <circle ref={dot => { if (dot) dots.current.set(node.id, dot); else dots.current.delete(node.id) }} className="dt-graph-dot" cx={p.x} cy={p.y} r={p.r} />
          {/* Layers drawn around the origin and moved as one; small nodes get only the sheen. */}
          <g ref={g => { if (g) dress.current.set(node.id, g); else dress.current.delete(node.id) }} className="dt-graph-dress"
            transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`} aria-hidden="true">
            {/* Inline, since a stylesheet rule outranks a fill attribute and would paint the sheen flat over the node. */}
            <circle className="dt-graph-sheen" r={p.r} style={{ fill: `url(#${frost})` }} />
            {p.r >= NODE.gleam && <path className="dt-graph-gleam" d={gleamArc(p.r - 1)} />}
            {(degree.get(node.id) ?? 0) >= NODE.hub && <circle className="dt-graph-ring" r={p.r + NODE.halo} />}
          </g>
        </g>
      })}
      <g className="dt-graph-labels">
        {labels.map(label => {
          const p = labelAt(label, bodies.current)!, ref = (text: SVGTextElement | null) => { if (text) names.current.set(label.id, text); else names.current.delete(label.id) }
          if (label.side === 'along') return <text key={label.id} ref={ref} className="dt-graph-why" x={p.x} y={p.y} dominantBaseline="central"
            textAnchor="middle">{label.text}</text>
          return <text key={label.id} ref={ref} className="dt-graph-label" data-minor={label.minor || undefined} data-hover={label.id === hover || undefined}
            x={p.x} y={p.y} dominantBaseline="central" textAnchor={label.side === 'right' ? 'start' : 'end'}>{label.text}</text>
        })}
      </g>
    </svg>
  </div>
}

/** The relation view of 概览: a layout switch, the chart, and its legend. */
export function GraphPage() {
  const { t, call, navigate } = usePanel()
  const { data: raw, error } = usePoll(() => call('GET tickets/graph'), [], 30_000)
  const [layout, setLayout] = useState<Layout>('timeline')
  const [linked, setLinked] = useState(true)
  // Guesses are drawn in the cloud only, and on there by default: the timeline's lanes would be cut up by them.
  const [fuzzy, setFuzzy] = useState(true)
  const [hover, setHover] = useState<string>()
  const guesses = layout === 'cloud' && fuzzy
  const data = useMemo(() => !raw || guesses ? raw : { ...raw, edges: raw.edges.filter(edge => !guessed(edge)) }, [raw, guesses])
  const graph = useMemo(() => {
    if (!data || !linked) return data
    // Only Tickets with a relation other than sharing a conversation, which the lanes already show; a guess counts while shown.
    const strong = data.edges.filter(edge => edge.via !== 'thread')
    const ids = new Set(strong.flatMap(edge => [edge.from, edge.to]))
    return { ...data, nodes: data.nodes.filter(node => ids.has(node.id)), edges: data.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) }
  }, [data, linked])
  if (!data || !graph) return <LoadState error={error} loading={!error} />
  const open = (id: string) => navigate({ page: 'execution', id })
  return <section className="dt-graph" data-layout={layout} aria-label={t('graphLabel')}>
    <div className="dt-graph-head">
      <SegmentedControl className="dt-graph-switch" label={t('graphLayoutLabel')} value={layout} onChange={setLayout}
        options={[{ value: 'timeline', label: t('graphLayoutTimeline') }, { value: 'cloud', label: t('graphLayoutCloud') }]} />
      <Pill active={linked} onClick={() => setLinked(value => !value)}>{t('graphOnlyLinked')}</Pill>
      {layout === 'cloud' && <Pill active={fuzzy} onClick={() => setFuzzy(value => !value)}>{t('graphFuzzy')}</Pill>}
      <span className="dt-graph-count">{t('graphCount', { nodes: String(graph.nodes.length), edges: String(graph.edges.filter(edge =>
        edge.via !== 'thread' && !guessed(edge)).length) })}{guesses ? ` · ${t('graphFuzzyCount', { count: String(graph.edges.filter(guessed).length) })}`
        : ''}{data.total > data.nodes.length ? ` · ${t('graphCapped', { shown: String(data.nodes.length), total: String(data.total) })}` : ''}</span>
    </div>
    <Hint>{layout === 'timeline' ? t('graphHint') : guesses ? `${t('graphCloudHint')}${t('graphFuzzyHint')}` : t('graphCloudHint')}</Hint>
    {graph.nodes.length === 0 ? <Hint>{t('graphEmpty')}</Hint> : <div className="dt-graph-frame" data-layout={layout}>
      {layout === 'timeline' ? <Timeline graph={graph} hover={hover} setHover={setHover} open={open} />
        : <Cloud graph={graph} hover={hover} setHover={setHover} open={open} />}
    </div>}
    <Legend fuzzy={guesses} />
  </section>
}
