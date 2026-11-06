/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import { NO_UPGRADE, type Deployment, type Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, ticketOfSession, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { Editor } from './editor.ts'
import { EditorScheduler, killTree } from './editor-scheduler.ts'
import { EditorGuard } from './editor-guard.ts'
import { EditorGatekeeper } from './editor-gatekeeper.ts'
import { ReproRunner } from './repro-runner.ts'
import { BuildRunner } from './build-runner.ts'
import { hostPlatform } from '../core/editor-composition.ts'
import { reproRoot } from './repro.ts'
import { notifyPlan as sendPlanCard } from './plan.ts'
import { notifyPriority as sendPriorityCard } from './priority.ts'
import { IdleScheduler } from './idle.ts'
import { NightRepro } from './night-repro.ts'
import { Billing, gatewayAccount, publishedPrices } from './billing.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Activity } from './activity.ts'
import { PipelineChecks, pipelineChoices } from './pipeline.ts'
import { PipelineWatch } from './pipeline-watch.ts'
import { Watchdog } from './watchdog.ts'
import { Upgrade } from './upgrade.ts'
import { StallWatch } from './stall-watch.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, sourceState, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/** The title of the main Session, which a restart or the watchdog creates it with again. */
const MASTER_TITLE = 'dsh-superagent orchestrator'

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly activity: Activity
  readonly editor: Editor
  readonly editorScheduler: EditorScheduler
  /** Owns the editor processes a lease starts and reclaims them when the lease lapses (docs/021). */
  readonly editorGatekeeper: EditorGatekeeper
  /** Watches workers' shell calls for editor use outside the lease (docs/021). */
  readonly editorGuard: EditorGuard
  /** Runs the local reproduction cases a person clicks on the editor page (docs/024). */
  readonly repro: ReproRunner
  /** Replays a delivered Ticket's local case in the night window, silently (docs/029). */
  readonly nightRepro: NightRepro
  /** Runs the person's compile-and-launch targets under the shared editor's slot (docs/021). */
  readonly build: BuildRunner
  readonly billing: Billing
  readonly pipeline: PipelineChecks
  readonly pipelineWatch: PipelineWatch
  /** The idle five-signal judgement the Executor asks before starting `P2`/`P3` work. */
  readonly idlePool: IdleScheduler
  readonly watchdog: Watchdog
  /** Checks the fork for a newer build and runs the one-click update the sidebar badge offers. */
  readonly upgrade: Upgrade
  readonly stallWatch: StallWatch
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'),
        toolsHealth: board.claim('worker-tools', { state: 'starting', detail: 'No worker Session has started yet' }),
        masterId, lifetime: this.lifetime, wroteInSession: (id, text) => this.engine.wroteInSession(id, text),
        closing: () => this.closing(), environment,
        restoreBilling: (id, events) => this.billing.restore(id, events),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, get repository() { return setup.deployment.repository },
        effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        idleAdmission: (ticket, load) => this.idlePool.admission(ticket, load),
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.activity = new Activity(ctx)
      this.editor = new Editor({ warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The shared editor's lease and queue live in the ticket database; a grant or a job's end reaches the worker as a
      // steering message, and a Ticket that ended loses its place (docs/021).
      this.editorScheduler = new EditorScheduler({ store, live: id => { const value = store.tickets.get(id); return !!value && !value.ended },
        editor: () => this.editor.read(), commands: () => store.settings().executor.editor, logDir: join(machine.stateDir, 'editor-jobs'),
        notify: (ticketId, id, text) => sessions.prompt(workerSessionId(ticketId), id, text, 'steer'),
        warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The gatekeeper owns the editor's operating-system processes: a lapsed lease stops its build tools but hands an
      // interactive editor to the next holder, instead of making every Ticket pay the editor's load again (docs/021).
      this.editorGatekeeper = new EditorGatekeeper({ store, schedule: this.editorScheduler, rows: () => this.editor.last(),
        alive: pid => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } },
        kill: pid => killTree(pid), live: id => { const value = store.tickets.get(id); return !!value && !value.ended },
        notify: (ticketId, id, text) => sessions.prompt(workerSessionId(ticketId), id, text, 'steer'),
        health: board.claim('editor-gatekeeper', { state: 'starting', detail: 'The editor gatekeeper starts with the orchestrator' }),
        warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The lease's teeth: a worker's shell call that opens, builds or stops the editor without the lease it should hold
      // is recorded, and an editor it started is stopped before the two fight over one workspace (docs/021).
      this.editorGuard = new EditorGuard({ ticketOf: ticketOfSession,
        live: id => { const value = store.tickets.get(id); return !!value && !value.ended },
        standing: id => {
          const value = this.editorScheduler.standing(id)
          if (value.state === 'holding') return { state: 'holding', purpose: value.lease.purpose }
          return value.state === 'queued' ? { state: 'queued' } : { state: 'none' }
        },
        agentPids: () => this.editorScheduler.read().agentPids,
        known: () => this.editor.last() ?? [],
        processes: async () => { await this.editor.refresh(); return this.editor.last() ?? [] },
        kill: pid => killTree(pid), record: (id, detail) => this.editorScheduler.noteBypass(id, detail),
        adopt: (id, pid, kind, started) => { this.editorGatekeeper.adopt(id, pid, kind, started) },
        notify: (id, noticeId, text) => sessions.prompt(workerSessionId(id), noticeId, text, 'steer'),
        warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The local reproduction cases live outside the repository: the host runs only what its directory lists, one at a
      // time, and keeps each run's output and report so a case re-runs against the editor that is already open (docs/024).
      this.repro = new ReproRunner({ store, root: () => reproRoot(store.settings().executor.editor.project, machine.stateDir),
        logDir: join(machine.stateDir, 'repro-logs'), warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The person's compile-and-launch targets run as host processes under the shared editor's slot: a run refuses
      // while an agent or a host job holds it, claims the slot for its duration, and gives it back when it ends (docs/021).
      this.build = new BuildRunner({ store, logDir: join(machine.stateDir, 'build-logs'),
        targets: () => store.settings().executor.editor.targets,
        buildCommand: () => store.settings().executor.editor.build,
        launchCommand: () => store.settings().executor.editor.restart,
        platforms: () => [hostPlatform(process.platform)],
        paths: () => ({ project: store.settings().executor.editor.project, engine: store.settings().executor.editor.engine,
          editorExe: store.settings().executor.editor.editorExe }),
        exists: path => existsSync(path),
        project: () => store.settings().executor.editor.project,
        cwd: () => { const project = store.settings().executor.editor.project; return project ? dirname(resolve(project)) : machine.stateDir },
        blocked: () => {
          const holder = this.editorScheduler.read().lease?.holder.kind
          return holder === 'agent' ? 'agent' : holder === 'job' ? 'job' : null
        },
        takeSlot: () => {
          const alreadyPerson = this.editorScheduler.read().lease?.holder.kind === 'person'
          this.editorScheduler.act({ kind: 'claim' })
          const granted = this.editorScheduler.read().lease?.holder.kind === 'person'
          return { granted, owned: granted && !alreadyPerson }
        },
        releaseSlot: () => { this.editorScheduler.act({ kind: 'release' }) },
        warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The board's billing strip reads actual Session usage priced from the routes' published lists, and the gateway account's own
      // settled hour and quota when the default route is a gateway it can read.
      this.billing = new Billing({ store, catalog: () => ctx.sessionController.modelCatalog(),
        prices: provider => publishedPrices(ctx, provider),
        account: (provider, from, to) => gatewayAccount(ctx, provider, from, to), warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      this.pipeline = new PipelineChecks({ settings: () => store.settings() })
      this.idlePool = new IdleScheduler({ store })
      // The night queue replays a delivered Ticket's local case by itself inside the quiet window (docs/029). It uses the same
      // idle judgement as every pooled launch and respects the editor lease, but it never messages anyone: its result lands in
      // the Ticket's `idle.repro` and the 复现用例 card a person already reads.
      this.nightRepro = new NightRepro({ store, repro: this.repro, idle: this.idlePool,
        blocked: () => {
          const holder = this.editorScheduler.read().lease?.holder.kind
          return holder === 'agent' ? 'agent' : holder === 'job' ? 'job' : null
        },
        warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, state: sourceState(store), paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, pipelineSkill: machine.pipelineSkill, swarmUrl: () => store.settings().executor.p4.swarmUrl,
        // Both follow the ticket's own delivery environment, falling back to the deployment's configured backend.
        pipelineFollowup: ticket => (ticket.execution?.backend ?? store.settings().executor.backend) === 'p4',
        pipelineChoices: () => pipelineChoices(store.settings()),
        priorityAskMinutes: () => store.settings().executor.idle.priorityAskMin,
        prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome),
        reprepareTicket: (ticket, backend, target) => executor.rePrepare(ticket, backend, target), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself. A person writing in a
          // worker's Session resumes its ticket with no Trigger, so there is no message to follow up on.
          const resumedBy = event.type === 'ticket.resumed' ? event.data.triggerId : undefined
          const triggerId = event.type === 'trigger.received' || event.type === 'trigger.followup' ? event.data.triggerId : resumedBy
          const followed = !this.quiet && triggerId !== undefined
          // A message a ticket's own plan gate decided is not the main Session's: its answer was recorded already.
          const gate = followed ? store.triggers.disposition(triggerId)?.acked?.length : 0
          const followup = followed && !gate ? followupNotice(store, sources, triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // A Source may open its own conversation for the new ticket, such as a Feishu topic, and move its replies there.
          if (event.type === 'ticket.created') {
            const ticket = store.tickets.get(event.data.ticketId)
            const kind = ticket ? sources.kind(store.triggers.get(ticket.origin.triggerId)?.source ?? '') : undefined
            if (ticket && kind?.opened) {
              void Promise.resolve(kind.opened(this.context(kind), ticket)).catch(error => {
                ctx.logger.warn('dsh-superagent: could not open a conversation for ticket %s: %s', ticket.id, String(error))
              })
            }
            // A TAPD ticket asks its person for a priority before it may start. The question goes to the ticket's Feishu
            // conversation; a TAPD ticket has none of its own, so the Source's intervention chat carries it.
            if (ticket?.priorityAsk?.state === 'pending') {
              const id = ticket.id
              void sendPriorityCard({ store, sources, commands, warn: message => ctx.logger.warn('dsh-superagent: %s', message) }, ticket)
                .then(message => { if (message) runtime.engine.priorityCardSent(id, message) })
                .catch(error => ctx.logger.warn('dsh-superagent: could not record the priority card of ticket %s: %s', id, String(error)))
            }
          }
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      this.pipelineWatch = new PipelineWatch({ tickets: store.tickets, settings: () => store.settings(), engine, checks: this.pipeline,
        paused: () => this.paused(), warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The watchdog recovers from a passing model or network outage: it retries stopped Tickets on a growing backoff, keeps the
      // main Session alive, and tells its retry chain when the gateway answers again (docs/003).
      this.watchdog = new Watchdog({ context: ctx, tickets: store.tickets, engine,
        master: { id: masterId, title: MASTER_TITLE, directory: () => machine.stateDir }, sessions,
        health: board.claim('watchdog', { state: 'ready', detail: 'No passing model or network failure waits for automatic recovery' }),
        paused: () => this.paused(), warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      // The stall alert says once in a Ticket's conversation that it made no progress, instead of waiting for a person to ask.
      this.stallWatch = new StallWatch({ tickets: store.tickets, settings: () => store.settings(), activity: this.activity,
        background: id => this.executor.inBackground(id),
        // A `P2`/`P3` Ticket the idle gate has not admitted waits by design, however long the mainline runs; the queued alert
        // is for a slot that never came free, so the gate's own verdict decides which it is.
        idleHeld: ticket => !this.idlePool.admission(ticket, this.executor.load()).admitted,
        channel: ticket => ticket.replyChannel ?? store.triggers.get(ticket.origin.triggerId)?.channel ?? ticket.channels[0],
        request: ticket => store.triggers.get(ticket.origin.triggerId)?.text ?? '', outbox,
        health: board.claim('stall', { state: 'ready', detail: 'No open ticket is stalled' }),
        paused: () => this.paused(), warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      this.upgrade = new Upgrade({ config: machine.upgrade ?? NO_UPGRADE, stateDir: machine.stateDir,
        activeCount: () => this.executor.activeCount(), paused: () => store.settings().paused,
        pause: paused => this.settings.pause(paused, 'panel'),
        url: () => ctx.webServer.port === undefined ? undefined : `http://127.0.0.1:${ctx.webServer.port}`,
        // The launcher's bounded shutdown stops every plugin as a signal would; without it, the process ends itself.
        exit: () => { const exit = ctx.get('appExit') as ((code: number) => void) | undefined; if (exit) exit(0); else process.kill(process.pid, 'SIGTERM') },
        warn: message => ctx.logger.warn('dsh-superagent: %s', message) })
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing(),
        // The idle judgement reads a slot's free time; recording the load every pass keeps it current after the mainline ends.
        observe: () => { const load = this.executor.load(); this.idlePool.observe(load.running, load.max) },
        reproject: () => this.executor.reproject() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger),
        // A conversation control, such as the Feishu resume word, is a person's command; only a person the Policy lets
        // originate work may issue one, and it changes the same pause setting the panel writes.
        mayControl: trigger => trigger.human && !!allowedSender(store.settings(), trigger.actor),
        pauseProcessing: paused => this.settings.pause(paused, 'command').then(result => result.paused),
        pipeline: this.pipeline }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get repository() { return setup.deployment.repository },
        models: () => ctx.sessionController.modelCatalog(),
        pipeline: this.pipeline, editor: this.editorScheduler, gatekeeper: this.editorGatekeeper,
        workspaceOf: ticket => this.executor.workspaceOf(ticket),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        notifyPlan: ticket => sendPlanCard({ store, sources, commands, warn: message => ctx.logger.warn('dsh-superagent: %s', message) }, ticket),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    // Update checks run even while setup waits: an update may be what fixes setup.
    this.upgrade.start()
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    // Every managed Session's model messages feed the rolling spend, including a worker's subagent calls; a worker's
    // shell call also feeds the editor lease guard, which reads no other Session.
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      this.billing.observe(session.id, event)
      if (event.type === 'tool/call') this.editorGuard.observe(session.id, String(event.data.callId), event.data.name, event.data.arguments)
    }))
    this.billing.start()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, MASTER_TITLE, 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.watchdog.start()
    this.stallWatch.start()
    this.passes.start()
    this.effects.start()
    this.pipelineWatch.start()
    this.editorScheduler.start()
    this.editorGatekeeper.start()
    this.repro.start()
    this.nightRepro.start()
    this.build.tick()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, outbox, executor, activity, editor, editorScheduler, repro, build, health, machine, masterId, ready, sourceLinks, setup, passes, watchdog, billing, stallWatch, upgrade } = this
    return { store, sources, prompts, sessions, settings, engine, outbox, executor, activity, editor, editorScheduler, repro, build, billing, upgrade, health, machine, masterId, ready, sourceLinks, watchdog, stallWatch,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      receive: trigger => passes.receive(trigger),
      admissible: trigger => engine.admissible(trigger),
      describeThread: (thread, description) => runtime.context({ kind: thread.source, health: [] }).threads.describe(`${thread.source}:${thread.id}`, description),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); const watch = this.pipelineWatch.stop(); const watchdog = this.watchdog.stop()
    const gatekeeper = this.editorGatekeeper.stop()
    this.stallWatch.stop()
    this.nightRepro.stop()
    this.billing.stop()
    this.upgrade.stop()
    this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, watch, watchdog, gatekeeper, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      this.activity.dispose()
      this.editorGuard.dispose()
      this.editor.dispose()
      this.editorScheduler.dispose()
      this.repro.dispose()
      this.build.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      // A flush failure must not keep the host from stopping and starting again: the event log is durable for the next open,
      // whose write path truncates a torn tail, and the failure is logged instead of rejecting the stop.
      await this.ctx.sessionPersistence.flush().catch(error => {
        this.ctx.logger.warn('dsh-superagent could not flush the session store before shutdown: %s', String(error))
      })
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}



