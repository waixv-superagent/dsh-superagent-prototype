/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, submitting the P1 plan, advancing phases, checking a delivered change's pipeline, and reporting status. */
import { z } from 'zod'
import { liveTicket, missingVerifyLabels, ticketPhase, VERIFY_LABELS, type EngineForExecutor, type Ticket } from '../../core/index.ts'
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

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext' | 'submitPlan' | 'advancePhase' | 'redispatchTicket'
    | 'recordPipeline' | 'rerunPipeline'>
  readonly store: Pick<Store, 'tickets' | 'settings' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify' | 'prompt'>
  readonly resources: ResourceHost
  /** Swarm and Jenkins checks, and a write only for asking Swarm to rerun checks; the Jenkins token stays in this host and never reaches the Session. */
  readonly pipeline: Pick<PipelineChecks, 'review' | 'status' | 'changeState' | 'jenkins' | 'rerun'>
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  /** Sends a submitted P1 plan to the person who decides it, and returns the card's message id when it went out. */
  notifyPlan(ticket: Ticket): Promise<string | undefined>
  sendReplies(): Promise<void>
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
      description: 'Submit the P1 plan before any code change: fix uses 现象/代码线/资产线/配置线/修复锚点/影响面/验证方案/预算; analysis uses 问题/结论/依据/建议; design uses 问题/选项/证据/推荐. One label per line with evidence. A person answers 1 (approve), 2 (change direction) or 3 (stop); the card question and 2–4 choices may use your own wording. Files and shells stay refused until 1.',
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
      }).strict(),
      execute: async args => {
        const updated = host.engine.submitPlan(ticketId, args.plan, args.question, args.options, args.sections, args.template)
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
        const result = host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const delivery = { ...(args.changelist != null ? { changelist: args.changelist } : {}),
            ...(args.swarm_review ? { review: args.swarm_review } : {}), ...(args.verification ? { verification: args.verification } : {}) }
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.options ? { options: args.options } : {}), ...(args.sections ? { sections: args.sections } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(Object.keys(delivery).length ? { delivery } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
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

