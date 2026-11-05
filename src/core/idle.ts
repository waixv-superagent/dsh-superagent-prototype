/**
 * Idle time as a property of the system, not of the clock (the priority × idle addendum, 2026-11-04): a ticket's `P2`/`P3`
 * work may start only while no `P0`/`P1` work waits, a worker slot has been free long enough, nobody is mid-conversation,
 * and no guard holds. The three depths then decide what may start: `L1` (a slot is free, shallow) admits `P2`, `L2` (the
 * evening window, quiet person) admits `P2` and `P3`, and `L3` (the night, guard clear) also admits `P2` and `P3` for the
 * batch. Windows are configurable; their defaults are the addendum's.
 */
import { waitsForIdle, type PriorityLevel } from './priority.ts'
import { ANALYSIS_RELATED } from './analysis.ts'

/** The three depths of idle time: a free slot's shallow triage, the evening window, and the silent night. */
export type IdleLevel = 'L1' | 'L2' | 'L3'
/** A time of day, `HH:MM`, in the deployment's local time (Asia/Shanghai on this installation). */
export type ClockTime = string
/** A configured window that admits one depth; the night window crosses midnight when `to` is before `from`. */
export interface IdleWindow { from: ClockTime; to: ClockTime; level: IdleLevel }
/** A window in which the person is meant to be available, so only shallow work may use it; kept for the settings view. */
export interface IdleRange { from: ClockTime; to: ClockTime }
/**
 * What an idle-window launch does (docs/025): by default it runs the ticket's read-only analysis, which gathers evidence and
 * ends in a verdict for a person, instead of starting implementation nobody asked for yet. Turning it off restores the
 * earlier behavior, where `P2`/`P3` work implements in an idle window.
 */
export interface IdleAnalysisConfig {
  /** Run idle-window launches as read-only analyses with a verdict; `false` starts the ticket's ordinary work instead. */
  enabled: boolean
  /** How many likely related tickets an analysis brief names, from the relation graph's own guess. */
  related: number
}
/** The configurable part of the judgement; the `executor.idle` settings block carries these values. */
export interface IdleConfig {
  enabled: boolean
  windows: readonly IdleWindow[]
  protectedWindows: readonly IdleRange[]
  /** Minutes a worker slot must stay free before it counts as capacity. */
  slotFreeMin: number
  /** Minutes since the newest human message before the person counts as quiet. */
  humanQuietMin: number
  /** How many idle-launched tickets one day admits, so the idle pool never becomes a second mainline. */
  dailyItems: number
  /** How many tickets the idle pool may run at once, at most a third of the worker slots. */
  analysisWorkers: number
  /** Minutes a `P2`/`P3` ticket's priority question waits before the default applies. */
  priorityAskMin: number
  /** What an idle-window launch does: a read-only analysis (the default) or the ticket's ordinary implementation. */
  analysis: IdleAnalysisConfig
}
/** The addendum's defaults: lunch for `L1`, the evening for `L2`, the night for `L3`, and the working day protected. */
export const IDLE_DEFAULTS: IdleConfig = {
  enabled: true,
  windows: [{ from: '12:00', to: '13:30', level: 'L1' }, { from: '19:30', to: '23:00', level: 'L2' }, { from: '23:00', to: '08:00', level: 'L3' }],
  protectedWindows: [{ from: '09:30', to: '12:00' }, { from: '14:00', to: '18:00' }],
  slotFreeMin: 10,
  humanQuietMin: 15,
  dailyItems: 6,
  analysisWorkers: 1,
  priorityAskMin: 30,
  analysis: { enabled: true, related: ANALYSIS_RELATED },
}
/** The five signals of the judgement: queue, capacity, window, human quiet, and the guard. */
export interface IdleSignals { queue: boolean; capacity: boolean; window: boolean; human: boolean; guard: boolean }
/** The judgement: the depth the system is at now (none outside), the window it matched, its signals and a sentence why. */
export interface IdleState { level?: IdleLevel; window?: IdleLevel; signals: IdleSignals; reason: string }
/** What the judgement reads; the app fills it from the store and the worker slots on each launch attempt. */
export interface IdleInput {
  now: Date
  config: Pick<IdleConfig, 'windows' | 'protectedWindows' | 'slotFreeMin' | 'humanQuietMin'>
  /** A `P0`/`P1` ticket still has runnable work (a pending or running Assignment). */
  queuedMainline: boolean
  /** When a worker slot last became free with no mainline work waiting; undefined while no slot is free. */
  capacitySince?: number
  /** When the newest human message arrived, if the deployment has one. */
  lastHumanAt?: string
  /** Processing is paused, which holds all idle work. */
  paused: boolean
  /** An unresolved `P0` ticket is open. */
  openP0: boolean
}
/** `HH:MM` as minutes of the day. */
export function clockMinutes(time: ClockTime): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return Number.NaN
  return Number(match[1]) * 60 + Number(match[2])
}
/** The minutes of the day a clock reads, in the deployment's local time. */
export const minuteOfDay = (now: Date): number => now.getHours() * 60 + now.getMinutes()
/** Whether `minutes` falls in `from`–`to`, the end excluded; a range whose end is before its start crosses midnight. */
export function inWindow(minutes: number, from: ClockTime, to: ClockTime): boolean {
  const start = clockMinutes(from), end = clockMinutes(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}
/** The window matching a minute, if any; the first match wins when windows overlap. */
export function windowAt(minutes: number, windows: readonly IdleWindow[]): IdleWindow | undefined {
  return windows.find(window => inWindow(minutes, window.from, window.to))
}
/** Whether a minute falls in a protected window, where only a shallow `L1` may run. */
export const protectedAt = (minutes: number, ranges: readonly IdleRange[]): boolean =>
  ranges.some(range => inWindow(minutes, range.from, range.to))
/** The depth a level admits by priority: `L1` runs `P2` only, while `L2` and `L3` also run `P3`. */
export function idleAdmits(level: IdleLevel | undefined, priority: PriorityLevel): boolean {
  if (!waitsForIdle(priority)) return true
  if (!level) return false
  return level === 'L1' ? priority === 'P2' : priority === 'P2' || priority === 'P3'
}
/** The levels `L1`, `L2` and `L3` admit, for a settings label or a log line. */
export const IDLE_ADMITS: Readonly<Record<IdleLevel, string>> = { L1: 'P2', L2: 'P2/P3', L3: 'P2/P3' }
/**
 * Classifies the system's idle depth from the five signals. `queue`, `capacity` and `guard` must all hold for any depth at
 * all; the window and the person's quiet then pick the depth: the night window is `L3`, the evening window with a quiet
 * person is `L2`, and a free slot whose queue is empty is `L1` (a shallow triage that may also use a protected window).
 */
export function idleState(input: IdleInput): IdleState {
  const now = input.now.getTime()
  const window = windowAt(minuteOfDay(input.now), input.config.windows)
  const quiet = input.lastHumanAt === undefined || now - Date.parse(input.lastHumanAt) >= input.config.humanQuietMin * 60_000
  const capacity = input.capacitySince !== undefined && now - input.capacitySince >= input.config.slotFreeMin * 60_000
  const signals: IdleSignals = { queue: !input.queuedMainline, capacity, window: window !== undefined, human: quiet, guard: !input.paused && !input.openP0 }
  const base = { signals, ...(window ? { window: window.level } : {}) }
  if (!signals.queue) return { ...base, reason: 'a P0/P1 ticket still has runnable work' }
  if (!signals.capacity) return { ...base, reason: `no worker slot has been free for ${input.config.slotFreeMin} minutes` }
  if (!signals.guard) return { ...base, reason: input.paused ? 'processing is paused' : 'an unresolved P0 ticket is open' }
  if (window?.level === 'L3') return { ...base, level: 'L3', reason: 'the night window, with the guard clear' }
  if (window?.level === 'L2' && quiet) return { ...base, level: 'L2', reason: 'the evening window, with a quiet person and a free slot' }
  // A free slot whose queue is empty is the shallow level: it may also use a protected window, and it produces triage only.
  return { ...base, level: 'L1', reason: window?.level === 'L2'
    ? 'the evening window, but the person is not quiet yet: shallow only'
    : 'a free worker slot with no P0/P1 work waiting' }
}
/** Whether the day has room for one more idle-launched ticket, per the configured daily budget. */
export const dailyIdleRoom = (launchedToday: number, config: Pick<IdleConfig, 'dailyItems'>): boolean => launchedToday < config.dailyItems
/** The local calendar day an ISO timestamp falls on, so a daily budget counts days the deployment's way. */
export const localDay = (at: string): string => {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0'), day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
