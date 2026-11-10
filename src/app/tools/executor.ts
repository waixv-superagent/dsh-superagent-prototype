/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, submitting the P1 plan, advancing phases, checking a delivered change's pipeline, approving a subagent model or agent team, and reporting status. */
import { z } from 'zod'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { LINKED_RELATION_KINDS, analysisRunning, liveTicket, missingVerifyLabels, modelRoute, PLAN_DIFF_LIMITS, TEAM_ROLE_CHARS, TEAM_ROLES_MAX,
  TEAM_TASK_CHARS, ticketPhase, VERIFY_LABELS, type EngineForExecutor, type ModelGrant, type ModelRoute, type RoutedModel, type TeamRoute, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { matchDeliveryTarget, deliveryTargets } from '../delivery-targets.ts'
import { claimPull, readPull } from '../../sources/github-pull.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { PipelineChecks } from '../pipeline.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'
import { EDITOR_JOB_KINDS, EDITOR_PURPOSES, MAX_LEASE_MS, ordered } from '../editor-schedule.ts'
import type { EditorScheduler } from '../editor-scheduler.ts'
import type { EditorGatekeeper } from '../editor-gatekeeper.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext' | 'link' | 'submitPlan' | 'advancePhase' | 'redispatchTicket'
    | 'recordPipeline' | 'rerunPipeline' | 'authorizeModelFromPerson'>
  readonly store: Pick<Store, 'tickets' | 'settings' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify' | 'prompt'>
  readonly resources: ResourceHost
  /** Swarm and Jenkins checks, and a write only for asking Swarm to rerun checks; the Jenkins token stays in this host and never reaches the Session. */
  readonly pipeline: Pick<PipelineChecks, 'review' | 'status' | 'changeState' | 'jenkins' | 'rerun'>
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** The deployment's routable models, which a subagent model request is checked against. */
  models(): Promise<ModelCatalog>
  /** Sends a submitted P1 plan to the person who decides it, and returns the card's message id when it went out. */
  notifyPlan(ticket: Ticket): Promise<string | undefined>
  sendReplies(): Promise<void>
  /** The shared editor's scheduler; absent on a host built without it. */
  readonly editor?: EditorScheduler
  /** The shared editor's gatekeeper, which owns the editor processes a lease started; absent on a host built without it. */
  readonly gatekeeper?: Pick<EditorGatekeeper, 'close'>
  /** The directory a ticket's worker runs in, which a host-run job builds or tests. */
  workspaceOf(ticket: Ticket): string
}

/** What a worker reads about the editor: who holds it and for what, its place in the queue, the jobs, and ue-mcp's view. */
function editorStatusFor(scheduler: EditorScheduler, ticketId: string) {
  const schedule = scheduler.read()
  const lease = schedule.lease
  const mine = scheduler.standing(ticketId)
  const engine = scheduler.engine()
  const view = scheduler.view()
  return {
    you: mine.state === 'holding' ? { holding: true, expires_at: mine.lease.expiresAt, draining: mine.lease.draining ?? null }
      : mine.state === 'queued' ? { queued: mine.position } : { holding: false },
    holder: lease ? { kind: lease.holder.kind, purpose: lease.purpose, note: lease.note, since: lease.acquiredAt,
      tickets: lease.holder.kind === 'agent' ? [lease.holder.ticketId] : lease.holder.kind === 'job' ? lease.holder.ticketIds : [] } : null,
    /** Why agents are held back, so a worker waits for its turn instead of starting its own editor. */
    blocked: scheduler.blocked(),
    /** The editors the probe sees now: a person's editor is open and running, not a broken scheduler. */
    editors: (view?.editors ?? []).map(process => ({ pid: process.pid, started: process.started })),
    queue: ordered(schedule.queue).map((request, index) => ({ position: index + 1, purpose: request.purpose, tickets: request.ticketIds,
      ...request.person ? { person: true } : {}, ...request.jobId ? { job: request.jobId } : {} })),
    jobs: schedule.jobs.filter(job => job.ticketIds.includes(ticketId)).slice(-5),
    ...engine ? { engine: { phase: engine.phase, modal: engine.modal, handler: engine.handler, slow_task: engine.slowTask,
      compiling: engine.compiling, stale: engine.stale, ...engine.detail ? { detail: engine.detail } : {} } } : {},
  }
}

/** The model catalog's display name for an exact route, or undefined when the deployment does not route it. */
function routedModel(catalog: ModelCatalog, provider: string, model: string): string | undefined {
  return catalog.groups.find(group => group.id === provider)?.models.find(item => item.id === model)?.name || undefined
}
/** The routes the deployment serves, as the host compares them with the routes a person's own message names. */
function routableModels(catalog: ModelCatalog): RoutedModel[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, name: model.name })))
}
/** A model-approval question that names the route and its display name, followed by the worker's own question. */
function modelQuestion(model: ModelRoute, name: string, question: string): string {
  return [`模型授权：允许在本工单用 ${name}（${model.provider}/${model.model}）跑子 agent 吗？`, question].join('\n').slice(0, 1000)
}
/** A team-approval question that lists every role, its job and its model route, followed by the worker's own question. */
function teamQuestion(team: readonly TeamRoute[], names: readonly string[], question: string): string {
  return [`模型授权：允许在本工单用以下 agent 团队吗？`,
    ...team.map((item, index) => `- ${item.role}：${names[index]}（${modelRoute(item)}）— ${item.task}`),
    question].join('\n')
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_ticket_link',
      description: 'Record that this ticket supersedes, blocks or relates to another.',
      schema: z.object({
        ticket_id: z.string().trim().min(1),
        kind: z.enum(LINKED_RELATION_KINDS),
        reason: z.string().trim().min(1).max(300),
      }).strict(),
      execute: async args => ({ linked: host.engine.link(ticketId, args.kind, args.ticket_id, args.reason), kind: args.kind, ticket_id: args.ticket_id }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_redispatch',
      description: 'Move this ticket to the configured environment its work belongs in when the current workspace is the wrong channel: a target names it, the host resolves the backend, and the ticket continues there instead of reporting blocked.',
      schema: z.object({
        target: z.string().trim().min(1).max(300).describe('The configured repository or depot the work belongs in, as the accept target spelling.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the current environment is the wrong one, from the evidence you found.'),
      }).strict(),
      execute: async args => {
        const target = host.store.tickets.get(ticketId)
        if (!target || !liveTicket(target)) throw new Error('Ticket ended; do not resume it')
        const settings = host.store.settings()
        const matched = matchDeliveryTarget(args.target, deliveryTargets(settings, host.github.deployment.repository))
        if (!matched) {
          const known = deliveryTargets(settings, host.github.deployment.repository).map(item => `${item.target} (${item.backend})`).join(', ')
          throw new Error(`target "${args.target}" is not configured; ${known ? `use ${known}` : 'this installation configures none'}`)
        }
        if (target.execution?.backend === matched.backend && target.execution?.target === matched.target) {
          return { redispatched: false, backend: matched.backend, target: matched.target, reason: 'the ticket already delivers there' }
        }
        const updated = host.engine.redispatchTicket(ticketId, matched.backend, matched.target)
        return { redispatched: true, backend: matched.backend, target: matched.target, phase: ticketPhase(updated), reason: args.reason }
      },
    }),
    tool({
      name: 'orchestrator_plan',
      description: 'Submit the P1 plan before any code change: fix uses 现象/代码线/资产线/配置线/修复锚点/影响面/验证方案/预算; analysis uses 问题/结论/依据/建议; design uses 问题/选项/证据/推荐. One label per line with evidence. A person answers 1 (approve), 2 (change direction) or 3 (stop); the card question and 2–4 choices may use your own wording. Pass the change as a real unified diff (`diff`) so the person reads code. Files and shells stay refused until 1.',
      schema: z.object({
        plan: z.string().trim().min(40).max(6000).describe('The plan as label：content lines, in the chosen template order, each with evidence; a long line is broken into points on the card.'),
        template: z.enum(['fix', 'analysis', 'design']).optional()
          .describe('fix (default) for bug fixes; analysis for an investigation; design for a choice, which needs 2–4 described options.'),
        question: z.string().trim().min(1).max(200).optional().describe('The card question in your own words, from the conversation; the standard wording when omitted.'),
        options: z.array(z.object({ label: z.string().trim().min(1).max(24), decision: z.enum(['approve', 'revise', 'stop']),
          note: z.string().trim().max(200).optional(), description: z.string().trim().min(1).max(160).optional() }).strict()).min(2).max(4).optional()
          .describe('2–4 card choices; a design plan needs a description for each choice stating what it means and costs; a revise choice without a note opens the feedback form, one with a note records that direction directly.'),
        sections: z.array(z.object({ label: z.string().trim().min(1).max(20), text: z.string().trim().min(1).max(800),
          fold: z.boolean().optional() }).strict()).min(1).max(6).optional()
          .describe('Optional card context sections in your own words when the standard 8-line layout does not fit; write one point per line, and omit to keep the standard layout. Each line or sentence renders as a bullet and a URL stays clickable.'),
        diff: z.string().trim().min(1).max(PLAN_DIFF_LIMITS.chars).optional()
          .describe('The proposed change as one real unified diff (`git diff -U3` / `p4 diff -du`, or the real file against the edited text); the card summarizes it and the panel renders it, so never hand-write it.'),
        diff_base: z.string().trim().min(1).max(PLAN_DIFF_LIMITS.base).optional()
          .describe('What the diff compares against, such as `origin/main`; shown above the diff.'),
      }).strict(),
      execute: async args => {
        const updated = host.engine.submitPlan(ticketId, args.plan, args.question, args.options, args.sections, args.template, args.diff, args.diff_base)
        const message = await host.notifyPlan(updated)
        return { submitted: true, phase: ticketPhase(updated), notified: message !== undefined }
      },
    }),
    tool({
      name: 'orchestrator_phase',
      description: 'Move this ticket one phase forward: verify once implementation is done, deliver once verification passed. A skipped or backward step is refused, and changelist, swarm_review and ready belong to deliver.',
      schema: z.object({
        phase: z.enum(['verify', 'deliver']).describe('The phase to enter, exactly one step forward.'),
      }).strict(),
      execute: async args => ({ phase: ticketPhase(host.engine.advancePhase(ticketId, args.phase)) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say. It is the only channel '
        + 'to the person: a final answer stays in the Session, so ask for a decision, more scope or a new ticket here, not in prose.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        options: z.array(z.string().trim().min(1).max(24)).min(2).max(4).optional()
          .describe('With human_action: 2–4 choices at a key node where a click is fastest, such as confirming a plan; everyday questions stay plain text.'),
        subagent_model: z.object({
          provider: z.string().trim().min(1).max(100),
          model: z.string().trim().min(1).max(200),
        }).strict().optional().describe('With human_action: ask the person to allow this subagent model route; the host asks 允许/不允许. '
          + 'Without human_action, only when a person\'s own message on the ticket already named the route: the host records that message as the grant and sends no card. '
          + 'Call list_subagent_models for the ids.'),
        subagent_team: z.array(z.object({
          role: z.string().trim().min(1).max(TEAM_ROLE_CHARS).describe('What this teammate does in the team, such as 实现 or 复核; unique in one team request.'),
          task: z.string().trim().min(1).max(TEAM_TASK_CHARS).describe('The one-line job this teammate is given, as the person will read it before allowing its route.'),
          provider: z.string().trim().min(1).max(100),
          model: z.string().trim().min(1).max(200),
        }).strict()).min(1).max(TEAM_ROLES_MAX).optional()
          .describe('With human_action: ask the person to allow this agent team, one role and job per model route; the host asks 允许/不允许 for the whole team. Call list_subagent_models for the ids.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        sections: z.array(z.object({ label: z.string().trim().min(1).max(20), text: z.string().trim().min(1).max(800),
          fold: z.boolean().optional() }).strict()).min(1).max(6).optional()
          .describe('With human_action: optional context sections when the question needs more than its own line.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        changelist: z.number().int().positive().nullish().describe('p4: the shelved changelist this report delivers, so the board and a person can see what to submit.'),
        swarm_review: z.string().trim().max(200).nullish().describe('p4: the Swarm review id or URL opened on that changelist.'),
        verification: z.string().trim().max(2_000).nullish().describe(`The verification package: ${VERIFY_LABELS.join(' / ')}, one label per line. Required before a ready report that delivers work, so a person can run and judge it.`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // A subagent model or team request is a permission card, except for a route a person already named in a message:
        // the host words the question with the routes and fixes the choices, so a person's click or that message authorizes
        // them, and the worker cannot offer "允许" itself.
        let humanAction = args.human_action
        let subagentModel: ModelRoute | undefined
        let subagentTeam: TeamRoute[] | undefined
        let authorized: ModelGrant | undefined
        if (args.subagent_model && args.subagent_team) {
          throw new Error('Ask for one subagent_model or one subagent_team, not both: a team request already approves its routes by role')
        }
        if (args.subagent_model) {
          if (analysisRunning(current)) throw new Error('This assignment is the ticket\'s read-only idle analysis; it cannot request a subagent model approval')
          if (args.options?.length) throw new Error('A subagent model request has fixed choices (允许/不允许); omit options')
          const { provider, model: id } = args.subagent_model
          const catalog = await host.models()
          const name = routedModel(catalog, provider, id)
          if (!name) throw new Error(`Unknown model route "${provider}/${id}". list_subagent_models lists the routes this deployment provides; use its provider and model ids`)
          if (current.execution?.modelGrants?.some(grant => grant.provider === provider && grant.model === id)) {
            throw new Error(`The person already approved ${provider}/${id} for this ticket; pass it to subagent instead of asking again`)
          }
          // A person who already named this route in a message on the ticket has authorized it: record that message as the
          // grant and send no card. The card is for a route nobody named yet, which the worker asks the person to allow.
          authorized = host.engine.authorizeModelFromPerson(ticketId, { provider, model: id }, routableModels(catalog))
          if (authorized) humanAction = undefined
          else {
            if (humanAction == null || !humanAction.trim()) {
              throw new Error('A subagent model request needs human_action: the question for the person, unless a person\'s own message already named the route')
            }
            subagentModel = { provider, model: id }
            humanAction = modelQuestion(subagentModel, name, humanAction.trim())
          }
        }
        if (args.subagent_team) {
          if (analysisRunning(current)) throw new Error('This assignment is the ticket\'s read-only idle analysis; it cannot request an agent team')
          if (humanAction == null || !humanAction.trim()) throw new Error('An agent team request needs human_action: the question for the person')
          if (args.options?.length) throw new Error('An agent team request has fixed choices (允许/不允许); omit options')
          const catalog = await host.models()
          const displayName = (provider: string, model: string) => catalog.groups.find(group => group.id === provider)
            ?.models.find(item => item.id === model)?.name || undefined
          const roles = new Set<string>()
          const roster: { route: TeamRoute; name: string }[] = args.subagent_team.map(item => {
            const role = item.role.trim(), task = item.task.trim(), provider = item.provider.trim(), model = item.model.trim()
            const name = displayName(provider, model)
            if (!name) throw new Error(`Unknown model route "${provider}/${model}" for the role "${role}". list_subagent_models lists the routes this deployment provides; use its provider and model ids`)
            const folded = role.toLowerCase()
            if (roles.has(folded)) throw new Error(`The team names the role "${role}" twice; give each teammate a unique role`)
            roles.add(folded)
            if (current.execution?.modelGrants?.some(grant => grant.role === role && grant.provider === provider && grant.model === model)) {
              throw new Error(`The person already approved ${provider}/${model} for the role "${role}"; call that teammate with subagent instead of asking again`)
            }
            return { route: { role, task, provider, model }, name }
          })
          subagentTeam = roster.map(item => item.route)
          humanAction = teamQuestion(subagentTeam, roster.map(item => item.name), humanAction.trim())
          // The person decides on the whole roster, so a card that would cut one role off is refused rather than sent.
          if (humanAction.length > 1000) throw new Error('The agent team card would exceed 1000 characters: shorten the roles, the jobs or your own question')
        }
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Delivery completeness (S3): a ready report may only point at delivery that still exists on the channel's side. A
        // closed pull request, a submitted or deleted changelist, or a vanished review is not ready work; the worker fixes the
        // delivery or reports the real state instead of claiming ready.
        if (args.state === 'ready') {
          const backend = current.execution?.backend ?? host.store.settings().executor.backend
          if (pull && pull.state !== 'open') {
            throw new Error(`PR #${args.pr_number} is ${pull.merged ? 'merged' : pull.state}; a ready report needs the open pull request it delivered, and a merged or closed one is the ticket's outcome instead`)
          }
          if (backend === 'p4' && args.changelist != null) {
            const state = await host.pipeline.changeState(args.changelist)
            if (state !== 'pending') {
              throw new Error(state === 'missing'
                ? `CL ${args.changelist} does not exist on the server; shelve the change and report the changelist that holds it`
                : `CL ${args.changelist} is already submitted; a ready report describes shelved work that a person can still review, so report the current delivery or the merge outcome`)
            }
          }
          if (backend === 'p4' && args.swarm_review) {
            const review = await host.pipeline.review(args.swarm_review)
            if (!review) throw new Error(`Swarm review ${args.swarm_review} no longer exists; open the review for the shelved changelist or report the state a person must act on`)
          }
          // Every delivered change, git pull request included, carries the same package: version and prerequisites, the
          // reproduction steps, the expected result with the evidence captured, and the one point a person must judge.
          if (args.pr_number != null || args.changelist != null || args.swarm_review) {
            const text = args.verification?.trim() ?? ''
            if (!text) throw new Error(`A ready report that delivers work needs verification= with all four blocks: ${VERIFY_LABELS.join(' / ')}`)
            const missing = missingVerifyLabels(text)
            if (missing.length) throw new Error(`The verification package is missing ${missing.join('、')}; a ready report states all four blocks: ${VERIFY_LABELS.join(' / ')}`)
          }
        }
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        // An idle analysis is quiet by design (docs/025): its dossier waits for the person's morning attention, so it wakes
        // neither the main Session nor a card; the verdict is what the board shows.
        const analyzing = analysisRunning(current)
        const result = host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const delivery = { ...(args.changelist != null ? { changelist: args.changelist } : {}),
            ...(args.swarm_review ? { review: args.swarm_review } : {}), ...(args.verification ? { verification: args.verification } : {}) }
          const report = { state: args.state, summary: args.summary, ...(humanAction !== undefined ? { question: humanAction } : {}),
            ...(args.options ? { options: args.options } : {}), ...(args.sections && !authorized ? { sections: args.sections } : {}),
            ...(subagentModel ? { model: subagentModel } : {}), ...(subagentTeam ? { team: subagentTeam } : {}),
            ...(args.question_for_trigger_id && !authorized ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(Object.keys(delivery).length ? { delivery } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = analyzing ? undefined : reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}),
            ...(authorized ? { authorized: { provider: authorized.provider, model: authorized.model, inputId: authorized.inputId, at: authorized.at,
              note: `人已经在本工单的消息里点名 ${authorized.provider}/${authorized.model}，授权已记录；不用再问，直接用 subagent 的 provider/model 指定它。` } } : {}) }
        })
        // The question is raised where the work is, not only on the board: a person reading this Session answers it here or in
        // the ticket's channel, and both reach the ticket as that person's message. It is injected without waking the worker,
        // which has already asked, and a Session that cannot take it never fails the report.
        if (result.attention) await host.sessions.prompt(workerSessionId(ticketId), `question:${result.attention.id}`,
          `Waiting for a person: ${result.attention.question}\nThey can answer here in this Session or in the ticket's channel; either reaches this ticket.`,
          { inject: 'Waiting for a person' }).catch(() => undefined)
        return result
      },
    }),
    tool({
      name: 'orchestrator_pipeline_check',
      description: 'Read a Swarm review\'s testruns/AI verdict, or a failed Jenkins build\'s errors. Read-only; the token stays on the host.',
      schema: z.object({
        target: z.string().trim().max(1000).optional().describe('Swarm review id/URL (defaults to this ticket\'s), or a failed Jenkins URL.'),
      }).strict(),
      execute: async args => {
        const target = args.target?.trim() || ticket.execution?.review
        if (!target) throw new Error('this ticket has no Swarm review yet; pass the review id or URL')
        if (/\/job\/|^https?:\/\/[^/]*jenkins/i.test(target)) return host.pipeline.jenkins(target)
        // Read the review's current version first, so an earlier round's AI verdict never decides this one.
        const current = await host.pipeline.review(target)
        if (!current) throw new Error(`Swarm review ${target} no longer exists; a submitted review is closed here`)
        return host.pipeline.status(target, current.version)
      },
    }),
    tool({
      name: 'orchestrator_pipeline_rerun',
      description: 'Rerun the failing Swarm checks.',
      schema: z.object({}).strict(),
      execute: async () => {
        const target = ticket.execution?.review
        if (!target) throw new Error('this ticket has no Swarm review yet')
        const rerun = await host.pipeline.rerun(target)
        const updated = host.engine.rerunPipeline(ticketId)
        return { ...rerun, pipeline: updated.pipeline?.state }
      },
    }),
    tool({
      name: 'orchestrator_editor',
      description: 'Hold to build, restart, test or open the shared UE editor; release after; yield to people. '
        + 'Acquire it before a shell opens, builds, restarts or tests the editor: the host stops an editor started without it, '
        + 'and a stop aimed at an editor you did not start is reported. close stops what your lease started and gives it back.',
      schema: z.object({
        op: z.enum(['acquire', 'heartbeat', 'release', 'close', 'run', 'status']),
        purpose: z.enum(EDITOR_PURPOSES).optional(),
        note: z.string().optional(),
        min: z.number().optional(),
        wait: z.number().optional(),
        filter: z.string().optional(),
      }).strict(),
      execute: async (args, signal) => {
        const scheduler = host.editor
        if (!scheduler) throw new Error('this host has no editor scheduler')
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended; do not resume it')
        // The scheduler clamps the lease to its bounds; a wait longer than 15 minutes would hold the worker's turn too long.
        const ttlMs = args.min ? Math.min(Math.max(1, args.min), MAX_LEASE_MS / 60_000) * 60_000 : undefined
        const waitMs = Math.min(900, Math.max(0, args.wait ?? 0)) * 1000
        const shown = () => editorStatusFor(scheduler, ticketId)
        switch (args.op) {
          case 'acquire': {
            if (!args.purpose) throw new Error('acquire needs purpose: build, restart, test or use')
            const first = scheduler.acquire({ ticketId, purpose: args.purpose, ...args.note ? { note: args.note } : {}, ...ttlMs ? { ttlMs } : {} })
            const result = first.state === 'granted' ? first : await scheduler.waitFor(() => {
              const now = scheduler.standing(ticketId)
              return now.state === 'holding' ? now : undefined
            }, waitMs, signal) ?? first
            return { ...result.state === 'granted' || result.state === 'holding' ? { state: 'granted' } : { state: 'queued',
              position: (scheduler.standing(ticketId) as { position?: number }).position }, ...shown() }
          }
          case 'heartbeat': return { state: 'granted', lease: scheduler.heartbeat(ticketId, ttlMs, args.note) }
          case 'release': scheduler.release(ticketId, args.note); return { state: 'released', ...shown() }
          case 'close': {
            // The gatekeeper stops only what this Ticket's own lease started, so stopping stays the host's decision.
            if (!host.gatekeeper) throw new Error('this host has no editor gatekeeper')
            const result = host.gatekeeper.close(ticketId)
            return { state: 'closed', ...result, ...shown() }
          }
          case 'run': {
            const kind = EDITOR_JOB_KINDS.find(value => value === args.purpose)
            if (!kind) throw new Error('run needs purpose build, restart or test')
            const directory = host.workspaceOf(current)
            const { job, merged } = scheduler.submit(ticketId, kind, directory, args.filter)
            // A build folded into another reports that build's result, which is this change's too.
            const ended = await scheduler.waitFor(() => {
              const value = scheduler.resolved(job.id)
              return value && value.state !== 'queued' && value.state !== 'running' ? value : undefined
            }, waitMs, signal)
            const value = ended ?? scheduler.resolved(job.id) ?? job
            return { job: value, merged: merged || value.id !== job.id, ...ended ? { log_tail: scheduler.logTail(value.id, 3000) } : {},
              ...ended ? {} : { note: 'The job is not done yet; its end reaches you as a message.' } }
          }
          case 'status': return shown()
        }
      },
    }),
    tool({
      name: 'orchestrator_pipeline',
      description: 'Record where a delivered change stands after local verification: running, blocked with the reason a person must act on, '
        + 'or merged. Merged completes the ticket; blocked keeps it open at the top of the pipeline lane.',
      schema: z.object({
        state: z.enum(['running', 'blocked', 'merged']).describe('merged once the change is in the mainline; blocked when the agent cannot clear it itself.'),
        url: z.string().trim().max(500).optional().describe('The review or pipeline URL a person can open.'),
        reason: z.string().trim().max(2000).optional().describe('Why it is blocked and what a person must do; required for blocked.'),
        manual: z.boolean().optional().describe('True when a person has to intervene; false only when the agent will retry on its own.'),
        check: z.string().trim().max(500).optional().describe('The last observed check, short enough for a board card.'),
      }).strict(),
      execute: async args => {
        const updated = host.engine.recordPipeline(ticketId, args)
        return { state: updated.pipeline?.state, completed: !!updated.ended }
      },
    }),
  ]
}

