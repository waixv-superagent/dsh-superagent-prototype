/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import type { Activity } from './activity.ts'
import type { Billing } from './billing.ts'
import type { Editor } from './editor.ts'
import type { EditorScheduler } from './editor-scheduler.ts'
import type { ReproRunner } from './repro-runner.ts'
import { VISIBLE_RUNS } from './repro-runner.ts'
import type { BuildRunner } from './build-runner.ts'
import { VISIBLE_BUILD_RUNS } from './build-runner.ts'
import { buildPage } from './views/build.ts'
import { EDITOR_CONFIGURATIONS, EDITOR_PLATFORMS, EDITOR_TARGET } from '../core/editor-composition.ts'
import { inside, readReproCases } from './repro.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { PRIORITY_LEVELS, TICKET_KINDS, ticketPriority, UserError, type EngineForPeople, type ReceiveResult, type ThreadRef, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health, ThreadDescription } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { WEB_SOURCE, webLabel, webTrigger } from '../sources/web.ts'
import { LIMITS } from '../limits.ts'
import type { Outbox } from './outbox.ts'
import type { Sessions } from './sessions.ts'
import type { Watchdog } from './watchdog.ts'
import { UpgradeRefused, type Upgrade } from './upgrade.ts'
import type { StallWatch } from './stall-watch.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { editorPage } from './views/editor.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList, ticketSearch } from './views/tickets.ts'
import { ticketGraph } from './views/graph.ts'
import { reproPage } from './views/repro.ts'
import { ticketRepro } from './views/ticket-repro.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly outbox: Pick<Outbox, 'status' | 'retry' | 'withdraw'>
  readonly executor: Pick<DshExecutor, 'activeCount'>
  /** What the outage recovery is doing, which `/state` carries for the status card and `dsh-superagent status`. */
  readonly watchdog: Pick<Watchdog, 'status'>
  /** The open Tickets the stall alert counts as stalled, which `/state` carries for the status card; absent on an older host. */
  readonly stallWatch?: Pick<StallWatch, 'status'>
  /** Live worker activity the ticket page reads; only the bounded summary and reasoning text, never the transcript. */
  readonly activity: Pick<Activity, 'read'>
  /** Cached editor occupancy the overview reads; null until the first process probe finishes. */
  readonly editor: Pick<Editor, 'read'>
  /** The shared editor's lease, queue and jobs; absent on a host built before it. */
  readonly editorScheduler?: Pick<EditorScheduler, 'tick' | 'engine' | 'act' | 'cancelJob' | 'read'>
  /** The local reproduction cases' runs (docs/024); absent on a host built before them. */
  readonly repro?: Pick<ReproRunner, 'tick' | 'run' | 'stop' | 'log' | 'root'>
  /** The person's compile-and-launch targets and runs (docs/021); absent on a host built before them. */
  readonly build?: Pick<BuildRunner, 'read' | 'start' | 'stop' | 'targets' | 'platforms' | 'preview' | 'blocked' | 'logTail'>
  /** Rolling model spend the overview's billing strip reads; absent on a host built before it. */
  readonly billing?: Pick<Billing, 'view'>
  /** The one-click update the sidebar badge offers; absent on a host built before it. */
  readonly upgrade?: Pick<Upgrade, 'view' | 'check' | 'begin' | 'cancel'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Ingests a Trigger a panel action produces, as a Source's own loop would. */
  readonly receive: (trigger: Trigger) => ReceiveResult
  /** Whether the Policy admits a Trigger now, so a panel action can refuse before it records one that would only be ignored. */
  readonly admissible: (trigger: Trigger) => boolean
  /** Publishes the display name a Source gives one of its Threads, such as the first line of a Web panel request. */
  readonly describeThread: (thread: ThreadRef, description: ThreadDescription) => void
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number | undefined): boolean {
  if (port === undefined) return false
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UpgradeRefused) return [409, { error: error.message, upgrade: error.code }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health, watchdog: runtime.watchdog.status(),
    ...runtime.stallWatch ? { stall: runtime.stallWatch.status() } : {} }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/**
 * One Ticket's page view; `environment` is empty while waiting for setup because it requires the resolved deployment.
 * A delivered Ticket also carries the local reproduction cases its verification package names (docs/024), so the
 * acceptance page can show the worker's case and re-run it without leaving the Ticket.
 */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  const repro = runtime.repro && ticket.execution?.verification ? ticketReproView(runtime, ticket) : undefined
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [], ...repro ? { repro } : {} }
}
/** The cases the Ticket names and their runs, read from the same root the editor page's card lists. */
function ticketReproView(runtime: HttpHost, ticket: Ticket) {
  const repro = runtime.repro!
  const root = repro.root()
  const found = readReproCases(root)
  const runs = repro.tick().slice(0, VISIBLE_RUNS)
  const active = runs.find(run => run.state === 'running')
  return ticketRepro({ root, cases: found.cases, runs,
    active: active ? { runId: active.id, caseId: active.caseId, tail: repro.log(active.id, ACTIVE_TAIL) } : null,
    blocked: reproBlocked(runtime) }, ticket)
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), kind: z.enum(TICKET_KINDS).optional().catch(undefined), offset,
  limit: limit(20, 1000) })
const TicketSearchQuery = z.object({ q: z.string().trim().max(200).default(''), limit: z.coerce.number().int().min(1).max(20).default(8) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const PlanRequest = z.object({ decision: z.enum(['approve', 'revise', 'stop']), note: z.string().trim().max(2000).optional() })
/** A person lifts a ticket out of the idle pool; the level defaults to the mainline and is what the ticket becomes. */
const PromoteRequest = z.object({ level: z.enum(['P0', 'P1']).optional() }).strict()
/** A level-only change from the board's idle drawer: it never starts a worker turn, unlike promote. */
const PriorityRequest = z.object({ level: z.enum(PRIORITY_LEVELS) }).strict()
/** A person's answer to a ticket's open question: one of the question's choices, or a written answer, never both. */
const AnswerRequest = z.object({ attentionId: z.string().trim().min(1).max(64), option: z.string().trim().min(1).max(120).optional(),
  text: z.string().trim().min(1).max(4000).optional() }).strict()
  .refine(value => (value.option === undefined) !== (value.text === undefined), { message: 'Answer with either option or text' })
/** A person moves a ticket's work to another delivery environment, such as when it was accepted under the wrong one. */
const RedispatchRequest = z.object({ backend: z.enum(['git', 'p4']), target: z.string().trim().min(1).max(300).optional() }).strict()
/** A person's action on the shared editor from the overview. */
const EditorActRequest = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['claim', 'release', 'yield']) }).strict(),
  z.object({ action: z.literal('preempt'), reason: z.string().trim().max(300).optional() }).strict(),
  z.object({ action: z.enum(['front', 'cancel', 'cancel-job']), id: z.string().trim().min(1).max(64) }).strict(),
])
const UpgradeRequest = z.object({ force: z.boolean().optional() }).strict()
const VerificationRequest = z.object({ note: z.string().trim().max(2000).optional() })
/** A follow-up observation: `merged` completes, `blocked` needs a person, `running` records a check still in flight. */
const PipelineRequest = z.object({ state: z.enum(['running', 'blocked', 'merged']),
  url: z.string().trim().max(500).optional(), reason: z.string().trim().max(2000).optional(),
  manual: z.boolean().optional(), check: z.string().trim().max(500).optional() }).strict()
/** A request a person submits from the panel: the text the main Session assesses, bounded like any Trigger a model reads. */
const RequestRequest = z.object({ text: z.string().trim().min(1).max(LIMITS.requestChars) }).strict()
/** A person's click on a local reproduction case, the run to stop, and the run whose output the panel reads (docs/024). */
const ReproRunRequest = z.object({ case: z.string().trim().min(1).max(120) }).strict()
const ReproStopRequest = z.object({ run: z.string().trim().min(1).max(64) }).strict()
const ReproLogQuery = z.object({ run: z.string().trim().min(1).max(64) })
const BuildRunRequest = z.object({ target: z.string().trim().regex(EDITOR_TARGET), configuration: z.enum(EDITOR_CONFIGURATIONS),
  platform: z.enum(EDITOR_PLATFORMS) }).strict()
const BuildStopRequest = z.object({ run: z.string().trim().min(1).max(64) }).strict()

/** Why a local case may not start now: an agent or a host job holds the shared editor, never a person's own claim. */
function reproBlocked(runtime: HttpHost): 'agent' | 'job' | null {
  const lease = runtime.editorScheduler?.read().lease
  return lease?.holder.kind === 'agent' || lease?.holder.kind === 'job' ? lease.holder.kind : null
}

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const executor = () => ({ ...executorLoad(store, runtime.executor.activeCount()),
    maxWorkers: store.settings().executor.maxWorkers })
  const upgrade = () => { if (!runtime.upgrade) throw new RouteError(404, 'This host has no update'); return runtime.upgrade }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    // The billing strip is optional: an older host without the ledger still serves the board.
    'GET overview': async () => {
      const page = overview(views(runtime), runtime.health, policyVersion(store.settings()),
        executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem, runtime.editor.read())
      const billing = runtime.billing ? await runtime.billing.view() : undefined
      return billing ? { ...page, billing } : page
    },
    'GET editor': () => editorPage(views(runtime), runtime.activity, runtime.editor.read(), executor(),
      runtime.editorScheduler ? { schedule: runtime.editorScheduler.tick(), engine: runtime.editorScheduler.engine() } : undefined),
    // A person's hand on the shared editor: claim it, let agents use the editor they have open, ask the holder to yield,
    // move a wait to the front or drop it, or stop a host-run job. Nothing here kills a person's editor.
    'POST editor/act': async ({ body }) => {
      const scheduler = runtime.editorScheduler
      if (!scheduler) throw new RouteError(404, 'This host has no editor scheduler')
      const request = EditorActRequest.parse(await body(2_048))
      try {
        if (request.action === 'cancel-job') { scheduler.cancelJob(request.id); return { done: true as const } }
        scheduler.act(request.action === 'preempt' ? { kind: 'preempt', reason: request.reason ?? '' }
          : request.action === 'front' || request.action === 'cancel' ? { kind: request.action, requestId: request.id }
          : { kind: request.action })
      } catch (error) { throw new RouteError(400, error instanceof Error ? error.message : String(error)) }
      return { done: true as const }
    },
    // Local reproduction cases (docs/024): the host lists what a local directory holds, runs one on a person's click and
    // serves the output and report it wrote. Cases stay outside the repository, so a case re-runs against the editor that
    // is already open instead of starting another one.
    'GET repro': () => {
      const repro = runtime.repro
      if (!repro) throw new RouteError(404, 'This host has no local reproduction runner')
      const root = repro.root()
      const found = readReproCases(root)
      const runs = repro.tick().slice(0, VISIBLE_RUNS)
      const active = runs.find(run => run.state === 'running')
      return reproPage({ root, ...found.problem ? { problem: found.problem } : {}, cases: found.cases, runs,
        ...active ? { active: { runId: active.id, caseId: active.caseId, tail: repro.log(active.id, ACTIVE_TAIL) } } : {},
        blocked: reproBlocked(runtime) })
    },
    // A person runs one case: one at a time, and never while an agent or a host job drives the shared editor.
    'POST repro/run': async ({ body }) => {
      const repro = runtime.repro
      if (!repro) throw new RouteError(404, 'This host has no local reproduction runner')
      const request = ReproRunRequest.parse(await body(2_048))
      const blocked = reproBlocked(runtime)
      if (blocked === 'agent') throw new UserError('reproBlockedAgent')
      if (blocked === 'job') throw new UserError('reproBlockedJob')
      repro.run(request.case)
      return { started: true as const }
    },
    'POST repro/stop': async ({ body }) => {
      const repro = runtime.repro
      if (!repro) throw new RouteError(404, 'This host has no local reproduction runner')
      repro.stop(ReproStopRequest.parse(await body(2_048)).run)
      return { stopped: true as const }
    },
    'GET repro/log': ({ query }) => {
      const repro = runtime.repro
      if (!repro) throw new RouteError(404, 'This host has no local reproduction runner')
      return { text: repro.log(ReproLogQuery.parse(query).run) }
    },
    // The person's compile-and-launch targets (docs/021): configured commands the host runs under the shared editor's
    // slot, one at a time, with their output. The panel never guesses an engine or a project layout.
    'GET build': () => {
      const build = runtime.build
      if (!build) throw new RouteError(404, 'This host has no build runner')
      const runs = build.read().slice(0, VISIBLE_BUILD_RUNS)
      const active = runs.find(run => run.state === 'running')
      const editor = runtime.store.settings().executor.editor
      return buildPage({ targets: build.targets(), configurations: [...EDITOR_CONFIGURATIONS], platforms: build.platforms(),
        build: editor.build, launch: editor.restart,
        runs: runs.map(run => ({ id: run.id, name: run.name, target: run.target, configuration: run.configuration,
          platform: run.platform, state: run.state, startedAt: run.startedAt,
          ...run.endedAt ? { endedAt: run.endedAt } : {}, ...run.exitCode !== undefined ? { exitCode: run.exitCode } : {}, summary: run.summary })),
        ...active ? { active: { runId: active.id, name: active.name, tail: build.logTail(active.id, ACTIVE_TAIL) } } : {},
        blocked: build.blocked() })
    },
    'POST build/run': async ({ body }) => {
      const build = runtime.build
      if (!build) throw new RouteError(404, 'This host has no build runner')
      build.start(BuildRunRequest.parse(await body(2_048)))
      return { started: true as const }
    },
    'POST build/stop': async ({ body }) => {
      const build = runtime.build
      if (!build) throw new RouteError(404, 'This host has no build runner')
      build.stop(BuildStopRequest.parse(await body(2_048)).run)
      return { stopped: true as const }
    },
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    // A request submitted from the panel becomes a Trigger of the Web Source, exactly as a message a Source's own loop
    // reads would; the main Session assesses it and opens the Ticket. The request is its own Thread, named after it.
    'POST requests': async ({ body }) => {
      if (!runtime.configured()) throw new RouteError(400, 'The deployment is not configured yet')
      const { text } = RequestRequest.parse(await body(64 * 1024))
      const trigger = webTrigger({ text, at: new Date().toISOString(), session: runtime.masterId })
      // Refuse before recording a Trigger the Policy would only ignore: the operator must be on the Web Source's list.
      if (!runtime.admissible(trigger)) throw new RouteError(400,
        'The request was not admitted: sync the Web panel Source in Settings → Policy so its operator is on the list')
      const state = runtime.receive(trigger)
      if (state === 'filtered') {
        const code = runtime.store.triggers.disposition(trigger.id)?.filtered?.code
        throw new RouteError(400, code === 'source_disabled'
          ? 'The Web panel Source is off; enable it in Settings → Sources'
          : `The request was not admitted (${code ?? 'not admitted'}); sync the Web panel Source in Settings → Policy so its operator is on the list`)
      }
      runtime.describeThread(trigger.threads[0]!, { label: webLabel(text) })
      return { trigger_id: trigger.id, thread: `${WEB_SOURCE}:${trigger.threads[0]!.id}`, state }
    },
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'POST outbox/:id/retry': ({ params }) => {
      if (!runtime.outbox.retry(params.id)) throw new RouteError(404, 'No such message waits')
      return { retried: true }
    },
    'POST outbox/:id/withdraw': ({ params }) => {
      if (runtime.outbox.status(params.id) !== 'pending') throw new RouteError(404, 'No such message waits')
      runtime.outbox.withdraw(params.id)
      return { withdrawn: true }
    },
    'GET tickets': ({ query }) => {
      const { state, kind, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit, kind)
    },
    // Dedicated Ticket-first search: the Overview box and the header search must not each invent their own ranking.
    'GET tickets/search': ({ query }) => {
      const { q, limit } = TicketSearchQuery.parse(query)
      return ticketSearch(views(runtime), q, limit)
    },
    'GET tickets/graph': () => ticketGraph(runtime),
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'GET tickets/:id/activity': ({ params }) => runtime.activity.read(ticket(params.id)),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/redispatch': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = RedispatchRequest.parse(await body(1_024))
      runtime.engine.redispatchTicket(id, request.backend, request.target)
      return { redispatched: true }
    },
    'POST tickets/:id/plan': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = PlanRequest.parse(await body(8_192))
      runtime.engine.decidePlan(id, request.decision, request.note ?? '', 'panel')
      return { decided: true }
    },
    // A person picks a pooled ticket into the attention pool: it becomes their P0/P1 and starts now when its worker is
    // between turns, so the board's pool is a scheduling surface rather than only a list.
    'POST tickets/:id/promote': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = PromoteRequest.parse(await body(1_024))
      const updated = runtime.engine.promoteTicket(id, request.level ?? 'P1', 'panel', 'panel')
      runtime.requestPass()
      return { level: ticketPriority(updated) }
    },
    // A person changes a ticket's level without starting it: the idle drawer's P2/P3 drop zones park a Ticket again
    // instead of launching it, so a drag is never a hidden "run now".
    'POST tickets/:id/priority': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = PriorityRequest.parse(await body(1_024))
      const updated = runtime.engine.decidePriority(id, request.level, 'panel', 'panel')
      runtime.requestPass()
      return { level: ticketPriority(updated) }
    },
    // A person answers the ticket's open question in place: a choice, or a written answer that becomes the worker's input.
    'POST tickets/:id/answer': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = AnswerRequest.parse(await body(16_384))
      if (request.option !== undefined) runtime.engine.answerAttention(id, request.attentionId, request.option)
      else runtime.engine.answerAttentionText(id, request.attentionId, request.text!)
      return { answered: true as const }
    },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    // A person confirms a delivered ticket; the changelist is theirs to submit, which this route never does.
    'POST tickets/:id/confirm': ({ params }) => { const id = ticket(params.id); runtime.engine.confirmTicket(id); return { confirmed: true } },
    // A person's local check passed: the ticket records it and, while open, ends as completed by a person.
    'POST tickets/:id/verify': ({ params }) => { const id = ticket(params.id); runtime.engine.verifyTicket(id); return { verified: true } },
    // A follow-up worker or a person records the pipeline state: a merged change completes, a blocked one stays for a person.
    'POST tickets/:id/pipeline': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = PipelineRequest.parse(await body(8_192))
      const updated = runtime.engine.recordPipeline(id, request)
      return { updated: true as const, completed: !!updated.ended }
    },
    // A person clears the blocker and asks the independent follow-up to run again.
    'POST tickets/:id/pipeline/check': ({ params }) => { runtime.engine.resumePipeline(ticket(params.id)); return { resumed: true as const } },
    // A person's local check failed: the ticket goes back to implement with their note as the worker's next Input.
    'POST tickets/:id/rework': async ({ params, body }) => {
      const id = ticket(params.id)
      const request = VerificationRequest.parse(await body(8_192))
      runtime.engine.reworkTicket(id, request.note ?? '')
      return { reworking: true }
    },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET upgrade': () => upgrade().view(),
    'POST upgrade/check': async () => { await upgrade().check(); return upgrade().view() },
    'POST upgrade': async ({ body }) => upgrade().begin(UpgradeRequest.parse(await body(1_024)).force ?? false),
    'POST upgrade/cancel': async () => ({ cancelled: await upgrade().cancel() }),
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
/** How much of the running case's output the page shows while it runs; the rest is a click away in its log. */
const ACTIVE_TAIL = 8 * 1024
/** The prefix a run's files are served under; the run id and the path below it identify the file. */
const REPRO_FILE = '/orchestrator/repro/file/'
/** What a browser may render inline from a case folder; anything else downloads as an opaque file. */
const REPRO_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
}
/** Whether a request names the loopback host, where the panel and the tab it opens a report in run (DNS-rebinding guard). */
function loopback(req: Pick<IncomingMessage, 'headers'>, port: number | undefined): boolean {
  if (port === undefined) return false
  return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`
}
function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('Not found')
}
/**
 * Serves one file inside the case folder of a recorded run. The report opens in its own browser tab, so it cannot carry
 * the management header; the loopback host and the run's own folder are the boundary instead. A report HTML runs in a
 * sandboxed origin, so its scripts cannot reach the panel's management API with the page's credentials.
 */
function serveReproFile(runtime: HttpHost, url: URL, res: ServerResponse, method: string): void {
  const repro = runtime.repro
  const parts = url.pathname.slice(REPRO_FILE.length).split('/').map(part => {
    try { return decodeURIComponent(part) } catch { return part }
  })
  const [runId, ...rest] = parts
  const run = runId && repro ? repro.tick().find(item => item.id === runId) : undefined
  const full = run && rest.length ? inside(join(repro!.root(), run.caseId), rest.join('/')) : undefined
  if (!run || !full) { notFound(res); return }
  let size: number
  try { const stat = statSync(full); if (!stat.isFile()) { notFound(res); return } size = stat.size } catch { notFound(res); return }
  const type = REPRO_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  const sandboxed = type.startsWith('text/html') || type.startsWith('image/svg')
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...sandboxed ? { 'content-security-policy': 'sandbox allow-scripts' } : {} })
  if (method === 'HEAD') { res.end(); return }
  // The file was statted just above; a failure to open it now must end the response rather than hang the browser tab.
  createReadStream(full).on('error', () => { res.destroy() }).pipe(res)
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // A case's report opens in its own browser tab, so it cannot carry the management header; the loopback host and
      // the run's own case folder are what bound it instead.
      if (url.pathname.startsWith(REPRO_FILE)) {
        if (!loopback(req, ctx.webServer.port)) { notFound(res); return }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return }
        try { await runtime.ready } catch { notFound(res); return }
        serveReproFile(runtime, url, res, req.method)
        return
      }
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}

