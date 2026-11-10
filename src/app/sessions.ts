/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, analysisRunning, analysisSection, liveTicket, modelRoute, ticketPhase, type ModelRoute, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { BillingEvent } from './billing.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { ProviderFailover, type FailoverSwitch } from './provider-failover.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'
import { MissingWorkerTools, missingWorkerTools, SHELL_TOOLS } from './worker-tools.ts'
import { reopenDelay, resolveFailure, SESSION_REOPEN_MS, SESSION_REOPEN_RETRIES, SessionUnavailable } from './session-recovery.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  /** The `worker-tools` health entry: whether the last worker Session resolved the tools a worker needs. */
  readonly toolsHealth: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** A person wrote in a ticket's worker Session: it resumes, takes the message, or starts its next Assignment; returns whether it did. */
  wroteInSession(ticketId: string, text: string): boolean
  /** Replays a Session's durable events into the rolling billing window without counting what its snapshot already holds. */
  restoreBilling?(sessionId: string, events: readonly BillingEvent[]): void
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/**
 * The tools a main Session keeps: no shell and no file writer, so the router cannot do a worker's work even when its prompt
 * leaves room for it. Reading and image reads stay for judging what a Source sent; everything else a router needs arrives
 * through the plugin's own tools. A deployment that gave its router a shell could not keep the two roles apart by prompt.
 */
const MASTER_TOOLS = ['skill', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']
/** The tools the plan phase refuses: each would change the ticket's workspace. */
const PLAN_BLOCKED = ['write', 'edit']
/** The plan gate's refusal, worded so a model submits the plan instead of retrying the tool. */
const PLAN_CLOSED = 'The P1 plan gate is closed: submit the plan with orchestrator_plan and wait for a person to answer 1 before changing files'
/** Tools the idle analysis refuses besides the write tools: it neither plans nor delivers, and its dossier is its whole output. */
const ANALYSIS_BLOCKED = ['write', 'edit', 'orchestrator_plan', 'orchestrator_phase']
/** The idle analysis's refusal, worded so a model reports its dossier instead of retrying the change. */
const ANALYSIS_CLOSED = 'This assignment is the ticket\'s read-only idle analysis: change nothing, submit no plan and deliver nothing; '
  + 'finish with orchestrator_report ready, putting the verdict in its sections, and leave implementation to a person'
/** Shell commands that change a workspace; a read-only investigation during the plan phase does not run them. */
const WRITE_COMMAND = /(?:^|[;&|]\s*|\b)(?:p4\s+(?:edit|add|delete|revert|shelve|submit)|git\s+(?:add|commit|push|checkout|switch|reset|rm|mv|restore|clean)|set-content|out-file|new-item|remove-item|move-item|copy-item|sed\s+-i|tee|mkdir|rm|mv|cp|touch)\b/i
/** The subagent tool name the worker preset registers; a call to it may select a child model explicitly. */
const SUBAGENT_TOOL = 'subagent'
/** The durable event DeepSeek Harness folds into a Session's allowed child model routes. */
const MODEL_POLICY_EVENT = 'subagent/model-selection-policy'
/** What a worker is told when it selects a model route no person allowed on its ticket. */
const MODEL_NOT_APPROVED = (route: ModelRoute): string => `The subagent model route "${modelRoute(route)}" is not approved for this ticket. `
  + 'If a person\'s own message on this ticket already named that route, record it with orchestrator_report: state progress and '
  + 'subagent_model {provider, model}, without human_action, and the host records their message as the grant. Otherwise ask the '
  + 'person with orchestrator_report: state progress, human_action (the question) and subagent_model {provider, model} for one '
  + 'route, or subagent_team for an agent team, one role and job per route. The host puts 允许 and 不允许 on the card, and only '
  + '允许 records the routes; list_subagent_models lists the routes this deployment provides.'
/** The model route a subagent call selects explicitly, when it passes both ids together; an inherited call selects none. */
function selectedModel(execution?: { name: string; arguments: unknown }): ModelRoute | undefined {
  if (execution?.name !== SUBAGENT_TOOL) return undefined
  const args = (execution.arguments ?? {}) as { provider?: unknown; model?: unknown }
  return typeof args.provider === 'string' && args.provider && typeof args.model === 'string' && args.model
    ? { provider: args.provider, model: args.model } : undefined
}
/** The route a Session itself runs on, from its last model selection; an explicit selection of it needs no approval. */
function sessionModel(agent: Agent): ModelRoute | undefined {
  const events = agent.session.snapshotEvents() as readonly { type: string; data: unknown }[]
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type !== 'model/selection') continue
    const data = event.data as { provider?: unknown; model?: unknown }
    return typeof data.provider === 'string' && typeof data.model === 'string' ? { provider: data.provider, model: data.model } : undefined
  }
  return undefined
}
/** Whether the ticket's person allowed `route`, or it is the Session's own model (which needs no new approval). */
function modelAllowed(agent: Agent, ticket: Ticket, route: ModelRoute): boolean {
  if (ticket.execution?.modelGrants?.some(grant => grant.provider === route.provider && grant.model === route.model)) return true
  const own = sessionModel(agent)
  return own?.provider === route.provider && own.model === route.model
}
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: a job wait longer than 5 seconds, and a shell command that runs sleep or asks to hold the step
 * longer than 30 seconds, are refused, because a waiting step holds back the next candidate. The router preset ends both
 * after 5 seconds; under `standard` the shell holds a command 60 seconds and a job wait 30, so either needs a timeout or the
 * background. `MASTER_TOOLS` gives a router no shell today, so that branch reaches only a deployment that adds one back.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (SHELL_TOOLS.includes(name)) {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 * A provider that ran out of its account quota does not get a new Session's first request, and a Session that stopped on one is moved to another provider offering the same model (`ProviderFailover`, docs/003).
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  /** Seeding away from a provider that ran out of quota, and switching a Session that stopped on one (see `ProviderFailover`). */
  private readonly providers: ProviderFailover
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.providers = new ProviderFailover({ context: host.context })
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    this.providers.install()
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => {
      try { await this.decorate(agent) } catch (error) {
        // A missing-tool gap reaches the ticket as a blocked Assignment and the worker-tools health entry; any other
        // decoration failure leaves the Session usable, so record it without failing the event that emitted it.
        if (!(error instanceof MissingWorkerTools)) this.ctx.logger.warn('dsh-superagent could not decorate a Session: %s', String(error))
      }
      return undefined
    })
    // A message a person types in a worker's Session is the person's own request: the ticket that Session works on takes it,
    // resuming an ended one and starting the next Assignment of one whose turn is over, under its Mandate (see
    // Tickets.wroteInSession), so the worker answers instead of every tool refusing. Plugin-delivered messages carry the
    // plugin's own source and change nothing.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      const ticketId = ticketOfSession(session.id)
      if (ticketId === undefined) return
      const text = event.data.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim()
      if (text) this.host.wroteInSession(ticketId, text)
    })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    const agent = await this.open(id, cwd, role)
    const settings = this.host.store.settings()
    // A provider that ran out of quota recently does not get a new Session's first request: the same model starts on a provider
    // that still has quota (see `ProviderFailover`). An existing Session keeps the model it already runs on.
    const configured = role === 'orchestrator' ? settings.eval.model : settings.executor.model
    await initializeRoleModel(ctx, agent, await this.providers.preferred(configured))
    await this.decorate(agent)
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    // A worker Session shares its workspace with the person's own conversations, so its title must say what it is:
    // a ticket's title alone reads exactly like a chat a person started in that workspace.
    await ctx.sessionController.rename({ sessionId: id as SessionId, title: role === 'worker' ? `🛠️ ${title}` : title })
    return agent
  }
  /**
   * Seed the Session's durable subagent model-selection policy with the deployment's routable models, once. DeepSeek Harness
   * refuses every explicit child model selection without this policy, so the seed is what makes a person's approval
   * actionable; which route a worker may actually pass to `subagent` stays gated by the ticket's granted routes (see
   * `workOnly`). An operator's own `subagent-model-selection-settings` policy wins, and the seed does not override it.
   */
  async ensureModelSelectionPolicy(agent: Agent): Promise<void> {
    const events = agent.session.snapshotEvents() as readonly { type: string; data: unknown }[]
    if (events.some(event => event.type === MODEL_POLICY_EVENT)) return
    const setting = (this.ctx as unknown as { get(name: string): unknown }).get('subagentModelSelection') as
      { current?: () => { enabled?: boolean } } | undefined
    // An operator's enabled policy owns the release, also when its configuration is broken: never seed over it.
    let governed = false
    try { governed = !!setting?.current?.().enabled } catch { governed = true }
    if (governed) return
    let catalog
    try { catalog = await this.ctx.sessionController.modelCatalog() } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not read the model catalog to authorize subagent models: %s', String(error))
      return
    }
    const routes = new Map<string, ModelRoute>()
    for (const group of catalog.groups) for (const model of group.models) routes.set(`${group.id}\0${model.id}`, { provider: group.id, model: model.id })
    const allowedModels = [...routes.values()]
    if (!allowedModels.length || this.ctx.agents.get(agent.id as SessionId) !== agent) return
    try {
      ;(agent.session as unknown as { append(type: string, data: { allowedModels: ModelRoute[] }): unknown })
        .append(MODEL_POLICY_EVENT, { allowedModels })
    } catch (error) {
      // The Session may have been disposed while the catalog was read; the approval still records the grant, and a later
      // launch seeds the policy again.
      this.ctx.logger.warn('dsh-superagent could not seed a Session\'s subagent model-selection policy: %s', String(error))
    }
  }
  /**
   * Switches `agent`'s Session to another provider that offers its current model after that provider's account quota ran out
   * (see `ProviderFailover`); undefined when the failure chain has no provider left or the route does not resolve.
   */
  failover(agent: Agent): Promise<FailoverSwitch | undefined> { return this.providers.failover(agent) }
  /**
   * Resolves `id` to its live Agent, creating the Session when the store has none. A store that DSH cannot open is reopened
   * with backoff up to `SESSION_REOPEN_RETRIES` times: the common `jsonl flush` failure leaves a torn tail that the write path
   * truncates on its next open, so reopening recovers it while the event log stays intact. A store that still fails is
   * reported through `SessionUnavailable`, never deleted and never retried without limit.
   * @throws SessionUnavailable when the Session could not be opened after the bounded attempts.
   */
  private async open(id: string, cwd: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    let created = false
    for (let attempt = 0; ; attempt++) {
      const result = await ctx.sessionController.resolveAgent(id as SessionId)
      if ('error' in result) {
        // The store has no Session under this id: create it once, then reopen through the same retry path.
        if (result.error.code === 'session/not-found' && !created) {
          const workspace = await ctx.workspaceRegistry.create(cwd)
          await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
            agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
          created = true
          continue
        }
        if (attempt >= SESSION_REOPEN_RETRIES) throw new SessionUnavailable(id, resolveFailure(result.error))
        await reopenDelay(SESSION_REOPEN_MS * 2 ** attempt)
        continue
      }
      return result.agent
    }
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    // DeepSeek Harness refuses every explicit child model selection without a durable policy, so a worker Session is seeded
    // with the deployment's routable models before its first model request; which of them a call may use stays the ticket's
    // person's decision (see `workOnly`).
    if (ticket) await this.ensureModelSelectionPolicy(agent)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    this.host.restoreBilling?.(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      // A running idle analysis replaces this turn's delivery and handoff expectations with the read-only dossier (docs/025).
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
        + (current && analysisRunning(current) ? `\n\n${analysisSection()}` : '')
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      // DSH refuses a restriction that names a tool this profile does not register, so keep only the ones it has:
      // a Windows profile registers `pwsh`, a POSIX one `bash`. The Agent is the scope key its tools resolve in, so
      // asking its own view reads the preset's tools whatever module instance mounted them.
      const keep = MASTER_TOOLS.filter(name => agent.ctx.tools.get(name, agent) !== undefined)
      binding.disposers.push(agent.ctx.tools.restrict({ allow: keep }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /** The tools a worker Session resolves and the required ones it lacks, read through the Agent's own scope. */
  private workTools(agent: Agent): { allow: string[]; missing: string[] } {
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, agent))
    return { allow, missing: missingWorkerTools(allow) }
  }
  /** Records the worker tool check on the `worker-tools` health entry, red while a required tool is missing. */
  private reportWorkerTools(allow: readonly string[], missing: readonly string[]): void {
    this.host.toolsHealth.set(missing.length
      ? { state: 'error', at: new Date().toISOString(), detail: `The worker Session is missing required tools: ${missing.join(', ')}; `
        + `it resolves ${allow.length ? allow.join(', ') : 'none'}. The Executor reports such an Assignment blocked instead of starting work` }
      : { state: 'ready', at: new Date().toISOString(), detail: `Worker tools check passed; the worker resolves ${allow.join(', ')}` })
  }
  /**
   * The required worker tools `agent`'s scope cannot resolve; the Executor re-checks this right after `ensure`, so a
   * Session another listener decorated first cannot start a worker with an empty tool face either.
   */
  workerToolGap(agent: Agent): readonly string[] { return this.workTools(agent).missing }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). The Agent is the scope key its tools resolve in, so its own view holds the preset's tools; the
   * names the plugin registers itself are not in `WORK_TOOLS`, and `restrict` refuses only names outside the preset.
   * A worker that lacks a required tool throws `MissingWorkerTools` instead of being narrowed to nothing (`required`), and a
   * subagent of a worker that already passed keeps its preset's tools when a later check fails.
   */
  private workOnly(agent: Agent, ticketId: string, required = true): (() => void)[] {
    const store = this.host.store
    const { allow, missing } = this.workTools(agent)
    this.reportWorkerTools(allow, missing)
    if (missing.length && required) {
      // Release what this decoration registered before failing: the Session must not stay semi-decorated, so a later launch
      // retries it after the profile is fixed.
      this.release(agent)
      throw new MissingWorkerTools(missing)
    }
    // A subagent of a worker that already passed this check is left as it is rather than restricted to an empty list.
    if (missing.length) return []
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(execution => {
      const current = store.tickets.get(ticketId)
      if (!current || !liveTicket(current)) return 'Ticket ended; new work needs a new authorized ticket'
      // A subagent may select a child model only after a person allowed that route on this ticket; the route a Session itself
      // runs on needs no new approval. This is the gate behind the request flow: the seeded policy releases the routes for the
      // harness, and this check decides which of them this ticket may use.
      const route = selectedModel(execution)
      if (route && !modelAllowed(agent, current, route)) return MODEL_NOT_APPROVED(route)
      // An idle analysis is read-only (docs/025): no file tool, no plan, no delivery, and no shell command that would change
      // the workspace. This is the teeth behind the analysis brief, which also tells the model why.
      if (analysisRunning(current)) {
        if (execution && ANALYSIS_BLOCKED.includes(execution.name)) return ANALYSIS_CLOSED
        const command = execution && SHELL_TOOLS.includes(execution.name) ? String((execution.arguments as { command?: unknown } | undefined)?.command ?? '') : ''
        return command && WRITE_COMMAND.test(command) ? `${ANALYSIS_CLOSED}; this command would change the workspace` : undefined
      }
      // The P1 gate is closed until a person approves the plan: no file tool, and no shell command that would change the workspace.
      if (ticketPhase(current) !== 'plan') return undefined
      if (execution && PLAN_BLOCKED.includes(execution.name)) return PLAN_CLOSED
      const command = execution && SHELL_TOOLS.includes(execution.name) ? String((execution.arguments as { command?: unknown } | undefined)?.command ?? '') : ''
      return command && WRITE_COMMAND.test(command) ? `${PLAN_CLOSED}; this command would change the workspace` : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId, false), subagent: true })
    // A nested subagent may itself delegate: give it the same release, fire-and-forget because its own model is already
    // chosen and only a later delegation reads the policy.
    void this.ensureModelSelectionPolicy(agent).catch(error => this.ctx.logger.warn(
      'dsh-superagent could not seed a subagent\'s model-selection policy: %s', String(error)))
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { this.providers.dispose(); for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
