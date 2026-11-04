/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, readUntil, runningAssignment, settled, threadKey, waitsForPerson } from './model.ts'
import type { Assignment, Backend, ChannelRef, Evaluation, Follow, LinkedRelationKind, Mandate, PipelineObservation, PolicyEffect, QuestionSection, ThreadRef, Ticket, TicketEndBy,
  TicketInput, TicketOutcome, TicketPipeline, TicketRepair, Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import { classifyTicket } from './kind.ts'
import { missingPlanLabels, pendingPlan, PLAN_GATE_HOURS, PLAN_QUESTION, planOverdue, planTemplate, ticketPhase, validPlanOptions, validQuestionSections,
  type PlanDecision, type PlanOption, type PlanTemplate, type PlanVia, type TicketPhase } from './plan.ts'
import { defaultPriority, priorityAskDeadline, PRIORITY_ASK_MINUTES, priorityAskOverdue, systemPriority, waitsForIdle, type PriorityLevel,
  type PriorityVia } from './priority.ts'
import type { IdleLevel } from './idle.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed. An escalated chat
   * reaches this same path with the escalation's title, scope and category, and no acknowledgement (its reply went out with
   * the chat).
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    const fallback = defaultPriority(primary)
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin, ...(outcome.category ? { category: outcome.category } : {}) }
    // Who set a level, and why, is part of the ticket: a person's explicit words are `human` and sticky, everything else is
    // a default that an idle window or a later person may change, and only a person may make a ticket `P0`.
    ticket.priority = { level: fallback.level, source: fallback.source, at, note: fallback.note, ...fallback.source === 'human' && primary ? { by: primary.actor.id } : {} }
    // A TAPD bug asks its person first; an unanswered question falls back to P2 after the configured delay.
    if (fallback.ask) ticket.priorityAsk = { state: 'pending', at, deadline: priorityAskDeadline(at, this.askMinutes()) }
    // P2/P3 work waits for an idle window instead of competing with the mainline: record when it entered the pool.
    if (waitsForIdle(fallback.level)) ticket.idle = { enteredAt: at }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    // Every new ticket gets a kind, once its delivery environment is known: the router's, else the Source's, else the title's.
    const kind = classifyTicket({ ...outcome.ticketKind ? { routed: outcome.ticketKind } : {}, ...outcome.category ? { category: outcome.category } : {},
      source: primary?.source ?? mandate.actor.source, ...ticket.execution?.backend ? { backend: ticket.execution.backend } : {}, title: ticket.title })
    ticket = { ...ticket, kind: kind.kind, kindSource: kind.source }
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(ticket, primary, outcome.acknowledgement)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Moves a ticket's replies to `channel` and subscribes it to `thread`, so a Source can open its own conversation for
   * the ticket, such as a topic, and send its later replies there; `channels` keeps the messages it was accepted from.
   * @throws UserError when the ticket is unknown or has ended.
   */
  retarget(ticketId: string, channel: ChannelRef, thread: ThreadRef): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    const ticket = this.require(ticketId)
    ticket.replyChannel = channel
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.subscribe(ticketId, thread)
    return ticket
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // Work resumed after the close and finished ends now.
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
   * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
   * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
    // its worker had it, so the worker gets it again.
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // The worker has the message already, so the note comes with it again.
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments.
   * @throws UserError when the ticket is unknown.
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * Records a person's confirmation that a delivered ticket may be submitted. Nothing here submits: the changelist, the
   * review and the verification stay as the worker reported them, and the person runs the submit themselves.
   * @throws UserError when the ticket is unknown, has ended, reported no changelist, or was already confirmed.
   */
  confirm(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticket.execution?.changelist === undefined) throw new UserError('nothingDelivered')
    if (ticket.confirmed) throw new UserError('alreadyConfirmed')
    const at = this.now()
    ticket.confirmed = { at }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Records a person's local verification of delivered work. On a p4 ticket the check is recorded but the ticket stays open:
   * the host's pipeline follow-up completes it when the change is submitted. A git ticket, or one with nothing delivered,
   * completes here. An ended completed ticket may be verified afterwards, so the backlog of work closed before this gate can
   * still be accounted for. It never submits, and it changes no changelist.
   * @throws UserError when the ticket has nothing awaiting verification or was verified already.
   */
  verify(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const pending = ticket.verification?.state === 'pending'
    const backlog = !liveTicket(ticket) && ticket.ended?.outcome === 'completed' && ticket.verification === undefined
    if (!pending && !backlog) throw new UserError(ticket.verification?.state === 'passed' ? 'alreadyVerified' : 'nothingToVerify')
    const at = this.now()
    ticket.verification = { at, state: 'passed', by: 'person' }
    ticket.updatedAt = at
    if (liveTicket(ticket)) {
      // A delivered change does not end at the local check: its pipeline follow-up runs on the host and completes the ticket
      // when the change is submitted. A change already merged completes at once; a git backend has no Swarm/Jenkins pipeline,
      // so its local check is the last gate and the ticket completes there. The person's check is recorded either way.
      const delivered = ticket.execution?.changelist !== undefined || !!ticket.execution?.review
      if (ticket.pipeline?.state === 'merged' || !delivered || !this.followsPipeline(ticket)) {
        this.repo.tickets.save(ticket)
        this.end(ticketId, 'human', 'completed', at, '人已本地验证')
      } else {
        // A ticket delivered before the host followed pipelines itself has none yet; start it here rather than end the ticket.
        this.beginPipeline(ticket, at)
        this.repo.tickets.save(ticket)
      }
    } else {
      this.repo.tickets.save(ticket)
    }
    return this.require(ticketId)
  }
  /** Whether a delivered change has a pipeline to follow: the p4 backend does, a git backend's change is done at the local check. */
  private followsPipeline(ticket: Ticket): boolean { return this.options.pipelineFollowup?.(ticket) ?? true }
  /**
   * Records a pipeline observation from the host's watcher or a person. `merged` completes the ticket immediately, since the
   * change is already in the mainline; a `blocked` observation keeps the ticket open and puts it at the top of the pipeline
   * lane, with the reason a person must act on.
   * @throws UserError when the ticket is unknown or has ended.
   */
  recordPipeline(ticketId: string, update: Omit<TicketPipeline, 'at'>): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    ticket.pipeline = { ...update, at }
    ticket.updatedAt = at
    if (update.state === 'merged') {
      // The change is already in the mainline; an outstanding local check is no longer a gate, and calling it a person's
      // verification would be a lie. Mark how it actually completed so the board can say so. The GitHub Source already posts
      // the concise "PR 已合并" message for a pull request; nobody needs an automatic "已提交入库" notice on top of it.
      if (ticket.verification?.state === 'pending') ticket.verification = { at, state: 'passed', by: 'pipeline' }
      this.repo.tickets.save(ticket)
      this.end(ticketId, 'executor', 'completed', at, '流水线已入库')
    } else {
      this.repo.tickets.save(ticket)
    }
    return this.require(ticketId)
  }
  /**
   * Start following a delivered change's pipeline without waiting for a person: the host polls Swarm and Jenkins itself, so a
   * green review, a failing check, an approval and the submit each reach the ticket as an observation. The caller saves; a
   * ticket without a changelist or review, one of a git backend, or one whose pipeline already merged keeps no new pipeline.
   */
  beginPipeline(ticket: Ticket, at = this.now(), restart = false): void {
    if (!liveTicket(ticket)) return
    const review = ticket.execution?.review
    const changelist = ticket.execution?.changelist
    if (changelist === undefined && !review) return
    if (!this.followsPipeline(ticket)) return
    if (ticket.pipeline?.state === 'merged') return
    if (ticket.pipeline && !restart) return
    const url = this.pipelineUrl(ticket)
    ticket.pipeline = { state: 'running', at, step: 'tests', check: '等待 Swarm 流水线结果', ...(url ? { url } : {}),
      ...(ticket.pipeline?.fixes ? { fixes: ticket.pipeline.fixes } : {}) }
    ticket.updatedAt = at
  }
  /**
   * Records one observation the host made about a delivered change. A failure whose signature is new wakes the worker with
   * the failing checks and Jenkins errors; the same signature is not handed over twice. A green review waits for a person
   * and a blocked pipeline that needs one stops the automatic fix loop. `merged` completes the ticket, as before.
   * @throws UserError when the ticket is unknown.
   */
  observePipeline(ticketId: string, observation: PipelineObservation): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return ticket
    const at = this.now()
    if (observation.kind === 'merged') {
      const url = observation.url ?? this.pipelineUrl(ticket)
      return this.recordPipeline(ticketId, { state: 'merged', step: 'merged', ...(observation.check ? { check: observation.check } : {}), ...(url ? { url } : {}) })
    }
    // A merged pipeline is history; a later round of the ticket is not pipeline work again.
    if (ticket.pipeline?.state === 'merged') return ticket
    const previous = ticket.pipeline
    const url = observation.url ?? previous?.url ?? this.pipelineUrl(ticket)
    const signature = 'signature' in observation ? observation.signature : undefined
    // The fine stage is what the panel draws; an observation without one falls back to the coarse kind so an older caller
    // still records a usable step.
    const step = observation.step ?? (observation.kind === 'review' ? 'review'
      : observation.kind === 'approved' ? 'ready' : undefined)
    const base = { ...previous, seenAt: at, ...(step ? { step } : {}),
      ...(observation.progress ? { progress: observation.progress } : {}),
      ...(observation.stageUrl ? { stageUrl: observation.stageUrl } : {}),
      ...(url ? { url } : {}), ...(signature ? { observed: signature } : {}) }
    // A moved stage is no longer the person's blocker: each branch below sets these again only when it still is one.
    delete base.manual
    delete base.reason
    // A green review or an approval means the rerun question is settled; a failure keeps `rerunAt` so its grace window works.
    if (observation.kind === 'review' || observation.kind === 'approved') delete base.rerunAt
    const reviewId = (text?: string): string | undefined => {
      const value = text?.trim() ?? ''
      return /(?:reviews?\/)(\d+)/.exec(value)?.[1] ?? (/^\d+$/.test(value) ? value : undefined) ?? /\/reviews\/(\d+)/.exec(url ?? '')?.[1]
    }
    const id = reviewId(ticket.execution?.review)
    const reviewName = id ? `Swarm - ${id}` : 'Swarm'
    const reviewLink = url ? `[${reviewName}](${url})` : reviewName
    if (observation.kind === 'running') {
      // A person's blocked pipeline stays theirs until they resume it; polling must not overwrite their decision.
      if (previous?.state === 'blocked' && previous.manual) return this.savePipelineSeen(ticket, previous, at)
      // Keep the state's start time: a review that stays missing for long enough is a blocker, and a fresh `at` on every
      // poll would hide how long it has been missing.
      ticket.pipeline = { ...base, state: 'running', at: previous?.state === 'running' ? previous.at : at, check: observation.check }
    } else if (observation.kind === 'review') {
      // Green checks still wait for a person's review: ask once, and keep the card in the waiting style.
      ticket.pipeline = { ...base, state: 'blocked', manual: true, at, check: observation.check }
      this.replies.pipelineNotice(ticket, `review:${signature ?? 'ready'}`,
        `${reviewLink} 已通过，待人工审核。`)
    } else if (observation.kind === 'approved') {
      ticket.pipeline = { ...base, state: 'running', at, check: observation.check }
      const notice = observation.step === 'smoke' ? `${reviewLink} 已审核通过，Jenkins 冒烟中。`
        : `${reviewLink} 已审核通过，等待提交。`
      this.replies.pipelineNotice(ticket, `approved:${signature ?? 'approved'}`, notice)
    } else if (observation.kind === 'failure') {
      // A person's blocker stays theirs, but a green review is not a decision yet: an AI verdict that posts after the
      // testruns passed still wakes the worker.
      if (previous?.state === 'blocked' && previous.manual && !previous.check?.startsWith('Swarm 已通过')) return this.savePipelineSeen(ticket, previous, at)
      if (previous?.observed === observation.signature) {
        ticket.pipeline = { ...previous, seenAt: at, ...(url ? { url } : {}) }
      } else {
        const fixes = (previous?.fixes ?? 0) + 1
        // The worker is woken for this failure now; a rerun request it made before is no longer pending.
        const failureBase = { ...base }
        delete failureBase.rerunAt
        ticket.pipeline = { ...failureBase, state: 'running', at, check: observation.check, fixes, fixAt: at }
        this.repo.tickets.save(ticket)
        this.nudgePipeline(ticket, observation.detail, observation.signature)
        return this.require(ticketId)
      }
    } else {
      // Blocked for a person: a repeated observation keeps the message out of the outbox twice.
      ticket.pipeline = { ...base, state: 'blocked', manual: true, at, check: observation.check, reason: observation.reason }
      this.replies.pipelineNotice(ticket, `blocked:${observation.signature ?? 'blocked'}`,
        `${reviewLink} 需要人工：${observation.reason}`)
    }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /**
   * A worker asked Swarm to rerun the current version's checks. Clearing `observed` lets a still-failing rerun wake the worker
   * once; `rerunAt` keeps the old failure from waking it again before Swarm has switched the checks to running.
   * @throws UserError when the ticket is unknown or has ended.
   */
  rerunPipeline(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (!ticket.pipeline || ticket.pipeline.state === 'merged') throw new Error('this ticket has no live pipeline to rerun')
    const at = this.now()
    const rest = { ...ticket.pipeline }
    delete rest.observed
    ticket.pipeline = { ...rest, step: 'tests', at, rerunAt: at, check: '已请求重跑检查，等待新结果' }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /**
   * A person asks the follow-up to look again after clearing a blocker: the pipeline runs again and the host polls on its
   * next tick, without another worker Assignment. Their decision grants a fresh set of automatic fix attempts.
   * @throws UserError when the ticket is unknown or has ended.
   */
  resumePipeline(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    const url = this.pipelineUrl(ticket)
    ticket.pipeline = { state: 'running', at, step: 'tests', check: '等待 Swarm 流水线结果', ...(url ? { url } : {}) }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /** The review URL from what the worker recorded, resolving a bare id against the configured Swarm URL. */
  private pipelineUrl(ticket: Ticket): string | undefined {
    const review = ticket.execution?.review
    if (!review) return undefined
    if (/^https?:\/\//i.test(review)) return review
    const base = this.options.swarmUrl?.().trim() ?? ''
    return base ? `${base.replace(/\/$/, '')}/reviews/${encodeURIComponent(review)}` : review
  }
  /** The delivery facts a failure nudge needs: the changelist, review, TAPD short id and the source message that holds it. */
  private pipelineFacts(ticket: Ticket): string[] {
    const changelist = ticket.execution?.changelist
    const url = this.pipelineUrl(ticket)
    const trigger = this.source(ticket)
    const source = trigger?.text.trim() ?? ''
    const bugId = String(trigger?.meta.bugId ?? '').trim()
    const shortId = String(trigger?.meta.shortId ?? '').trim()
      || (bugId.length > 10 ? bugId.slice(10).replace(/^0+/, '') : '')
    return [
      `本单交付：CL ${changelist ?? '未记录'}；review ${url ?? '未记录'}。`,
      source ? `来源消息（TAPD 短单号可能只在这里；找不到就报 blocked，不要猜）：${source.slice(0, 800)}` : '',
      shortId ? `本单 TAPD 短单号：${shortId}（P4_Check 首行用它）` : '来源里没有结构化的 TAPD 短单号；先按来源消息和 TAPD 页面核对，找不到就报 blocked。',
      'P4_Check 要求 CL 描述首行是「短单号 + 空格」（如 123456 xxx），只取纯数字短单号，不要用长 ID、URL 或前缀；缺就先补描述再 reshelve。'
    ].filter(Boolean)
  }
  /**
   * Hand a failing pipeline to the ticket's worker as one new Input. The worker fixes the cause in the same workspace and
   * reshelves the same changelist; a reshelve without a content change opens no Swarm version, so the nudge says not to do it.
   */
  private nudgePipeline(ticket: Ticket, detail: string, signature: string): void {
    const inputId = key('input', ticket.id, 'pipeline-fix', signature)
    if (ticket.inputs.some(input => input.id === inputId)) return
    const skill = this.options.pipelineSkill?.trim()
    const skillFile = skill && !/\.md$/i.test(skill) ? `${skill.replace(/[\\/]$/, '')}/SKILL.md` : skill
    const text = [
      '流水线自动跟进：最近一次 Swarm/Jenkins 检查失败。这是本单交付后的同一件工作，不是新需求；请在当前工作区修复。',
      detail,
      ...this.pipelineFacts(ticket),
      skill ? `需要时先读这个 skill：${skillFile}。` : '',
      '修复后 reshelve 同一个 CL（p4 edit 后 p4 shelve -f/-r；不要 p4 submit），然后报 ready；主机上的跟进会自动看到新版本。',
      '如果确认失败与本单改动无关，不要空 reshelve——内容没有变化时 Swarm 不会重跑：直接报 blocked，写明需要谁在 Jenkins/Swarm 重跑或如何处理。'
    ].filter(Boolean).join('\n')
    if (!runningAssignment(ticket) && latestAssignment(ticket)?.state !== 'pending') this.newAssignment(ticket)
    this.addInput(ticket, { id: inputId, kind: 'text', text, at: this.now() })
  }
  /** Keep a person's blocked decision, recording only that the host looked again. */
  private savePipelineSeen(ticket: Ticket, pipeline: TicketPipeline, at: string): Ticket {
    ticket.pipeline = { ...pipeline, seenAt: at }
    this.repo.tickets.save(ticket)
    return this.require(ticket.id)
  }
  /**
   * A person's local check found a problem: records it, returns the ticket to implement, and starts a new Assignment whose
   * first Input is the person's words, so the worker fixes the delivered work instead of starting over.
   * @throws UserError when the ticket is not open and waiting for local verification.
   */
  rework(ticketId: string, note = ''): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticket.verification?.state !== 'pending') throw new UserError('notVerifying')
    const at = this.now()
    ticket.verification = { at, state: 'failed', by: 'person', ...note ? { note: note.slice(0, 2000) } : {} }
    ticket.phase = 'implement'
    ticket.updatedAt = at
    const current = latestAssignment(ticket)
    if (current?.state === 'running') this.endAssignment(ticket, current, 'verificationReturned')
    const assignment = this.newAssignment(ticket)
    const input: TicketInput = { id: key('input', ticket.id, 'verify-rework', at), kind: 'text', at,
      text: `人做了本地验证，未通过：${note || '（没有附说明）'}\n请按上面的问题修复，然后重新验证、报 ready；不要提交，改动仍属于本单。`,
      person: true }
    ticket.inputs.push(input); ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    return this.require(ticketId)
  }
  /**
   * A worker's P1 plan, as the fixed template with evidence, now waits for a person: the ticket stays in `plan`, its
   * attention asks the plan question, and its deadline stops it if nobody answers (see `PLAN_GATE_HOURS`). A worker may
   * word the card's question and offer 2–4 choices that map to the gate's own decisions.
   * @throws UserError when the ticket is unknown or ended, its plan was approved already, a template line is missing, or
   * the question or choices are not a card's.
   */
  submitPlan(ticketId: string, text: string, question?: string, options?: PlanOption[], sections?: QuestionSection[], template: PlanTemplate = 'fix'): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticket.plan?.approved) throw new UserError('phaseOutOfOrder', { from: ticketPhase(ticket) })
    const missing = missingPlanLabels(text, template)
    if (missing.length) throw new UserError('planIncomplete', { template, labels: missing.join(', ') })
    const asked = question?.trim()
    if (asked !== undefined && (!asked || Array.from(asked).length > 200)) throw new UserError('planQuestion')
    const choices = options?.map(option => ({ ...option, label: option.label.trim(), ...option.description ? { description: option.description.trim() } : {} }))
    // A design plan is a choice between alternatives: the card needs them, and each must say what choosing it means.
    if (template === 'design' && (!choices || choices.length < 2)) throw new UserError('planTemplate', { template })
    if (choices && (!validPlanOptions(choices, template === 'design')
      || choices.some(option => !['approve', 'revise', 'stop'].includes(option.decision)))) throw new UserError('planOptions')
    if (sections && !validQuestionSections(sections)) throw new UserError('planSections')
    const context = sections?.map(section => ({ ...section, label: section.label.trim(), text: section.text.trim() }))
    const at = this.now()
    const previous = ticket.attention
    ticket.plan = { text, at, waiting: true, deadline: new Date(Date.parse(at) + PLAN_GATE_HOURS * 3_600_000).toISOString(),
      ...(template !== 'fix' ? { template } : {}), ...(asked ? { question: asked } : {}), ...(choices?.length ? { options: choices } : {}), ...(context?.length ? { sections: context } : {}) }
    ticket.phase = 'plan'
    ticket.attention = { id: key('attention', ticketId, PLAN_QUESTION, at), question: PLAN_QUESTION }
    if (previous && previous.id !== ticket.attention.id) this.replies.withdrawAttention(previous.id)
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * A person's decision on the waiting plan: `1` approves it and moves the ticket to implement, `2` asks for another
   * direction with `note` and leaves the plan phase for the worker to revise, `3` stops the ticket. `option` is the label
   * of the card choice that was clicked, recorded with the decision when the card offered choices.
   * @throws UserError when the ticket is unknown or no plan of it waits for a decision.
   */
  decidePlan(ticketId: string, decision: PlanDecision, note = '', via: PlanVia = 'feishu', option = ''): Ticket {
    const ticket = this.require(ticketId)
    const plan = pendingPlan(ticket)
    if (!plan) throw new UserError('planNotPending')
    const at = this.now()
    const where = via === 'panel' ? '面板' : via === 'session' ? '会话' : '飞书'
    const choice = option.trim()
    delete ticket.attention
    if (decision === 'approve') {
      plan.approved = { at, via, ...(choice ? { option: choice } : {}) }
      delete plan.waiting
      ticket.phase = 'implement'
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
      this.addInput(ticket, { id: key('input', ticketId, 'plan-approved', at), kind: 'text', at,
        text: `人已通过 P1 方案（${where}${choice ? ` · ${choice}` : ''}）。进入实现阶段：可以改文件。实现完成后调用 orchestrator_phase 进入 verify，验证通过后进入 deliver。` })
    } else if (decision === 'revise') {
      plan.feedback = [...plan.feedback ?? [], { text: note || '请换一个方向，重新给方案。', at, via, ...(choice ? { option: choice } : {}) }]
      delete plan.waiting
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
      this.addInput(ticket, { id: key('input', ticketId, 'plan-revise', at), kind: 'text', at,
        text: `人要求换方向（${where}${choice ? ` · ${choice}` : ''}）：${note || '（没有附说明）'}\n仍处于方案阶段：继续只读定位，再用 orchestrator_plan 交新方案。` })
    } else {
      // A stop answers the gate too: clear `waiting` so a later resume does not reopen a plan a person already closed.
      delete plan.waiting
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
      this.end(ticketId, 'human', 'stopped', at, `人停在 P1 方案门（${where}）`)
    }
    return this.require(ticketId)
  }
  /**
   * A person clicked one of a question card's choices: the answer is recorded as their message to the worker, the question
   * is cleared, and the answer is delivered to the running Assignment (or starts one) so the worker continues from it.
   * @throws UserError when the ticket is unknown or ended, its question is gone or was replaced, or the option is not one
   * the question offered.
   */
  answerAttention(ticketId: string, attentionId: string, option: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const attention = ticket.attention
    if (!attention || attention.id !== attentionId) throw new UserError('notAttention')
    if (!attention.options?.includes(option)) throw new UserError('notAttentionOption')
    const at = this.now()
    this.replies.withdrawAttention(attention.id)
    delete ticket.attention
    this.addInput(ticket, { id: key('input', ticketId, 'answer', attentionId, at), kind: 'text', at,
      text: `人对「${attention.question}」选了：${option}` })
    return this.require(ticketId)
  }
  /**
   * A worker moves its ticket one phase forward: implement (only through a person's plan approval) → verify → deliver, the
   * last only with verification recorded. A step that skips a phase or goes backwards is refused, so the gate cannot be
   * talked around by reporting delivery early.
   * @throws UserError when the ticket is unknown or ended, or the move is out of order.
   */
  advancePhase(ticketId: string, phase: TicketPhase): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const from = ticketPhase(ticket)
    if (phase === 'implement' || phase === 'plan') throw new UserError('phaseOutOfOrder', { from })
    if (phase === 'verify' ? from !== 'implement' : from !== 'verify') throw new UserError('phaseOutOfOrder', { from })
    if (phase === 'deliver' && !ticket.execution?.verification) throw new UserError('notDeliverable')
    ticket.phase = phase
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Applies the idle default to every open ticket whose priority question nobody answered: the question expires, the level
   * becomes the `P2` default (a person's level, if they set one meanwhile, stands), and the ticket joins the idle pool. Run
   * on every pass, since no message arrives for a timeout.
   * @returns the tickets whose question it expired.
   */
  expirePriorityAsks(now = this.now()): string[] {
    const expired: string[] = []
    for (const ticket of this.repo.tickets.open()) {
      const ask = ticket.priorityAsk
      if (!priorityAskOverdue(ask, now)) continue
      ticket.priorityAsk = { ...ask!, state: 'expired', settledAt: now }
      const applied = systemPriority(ticket.priority, { level: 'P2', source: 'default', note: 'ask-timeout' }, now)
      if (applied) ticket.priority = applied
      if (waitsForIdle(ticket.priority?.level ?? 'P2') && !ticket.idle) ticket.idle = { enteredAt: now }
      ticket.updatedAt = now
      this.repo.tickets.save(ticket)
      expired.push(ticket.id)
    }
    return expired
  }
  /**
   * A person sets a ticket's level, by a card button, a short reply, or the panel: the value becomes `human`, which an
   * assessment or a later default never overwrites, their answer settles the priority question, and a level that runs with
   * the mainline releases the ticket from the idle pool. A change never preempts a worker that already runs.
   * @throws UserError when the ticket is unknown or has ended.
   */
  decidePriority(ticketId: string, level: PriorityLevel, by: string, via: PriorityVia = 'feishu'): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    ticket.priority = { level, source: 'human', at, by, via }
    if (ticket.priorityAsk && (ticket.priorityAsk.state !== 'answered' || ticket.priorityAsk.by !== by)) {
      ticket.priorityAsk = { ...ticket.priorityAsk, state: 'answered', settledAt: at, by }
    }
    if (waitsForIdle(level)) {
      if (!ticket.idle) ticket.idle = { enteredAt: at }
    } else delete ticket.idle
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return ticket
  }
  /** Remember the message a TAPD ticket's priority question went out as, so the panel can open that card. */
  notePriorityCard(ticketId: string, cardId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket?.priorityAsk) return
    ticket.priorityAsk = { ...ticket.priorityAsk, cardId }
    this.repo.tickets.save(ticket)
  }
  /** Record that a ticket waited in the idle pool and that depth let its work start, which the daily budget counts. */
  noteIdleLaunch(ticketId: string, level: IdleLevel): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    const at = this.now()
    ticket.idle = { enteredAt: ticket.idle?.enteredAt ?? at, launchedIn: level, launchedAt: at }
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
  }
  /** How long a TAPD ticket's priority question waits, from the deployment's `executor.idle.priorityAskMin`. */
  private askMinutes(): number { return this.options.priorityAskMinutes?.() ?? PRIORITY_ASK_MINUTES }
  /**
   * Ends every open ticket whose waiting plan passed its deadline, with `stopped` and why: a gate nobody answered defaults
   * to stop, never to continue.
   * @returns the tickets it ended.
   */
  expireGates(now = this.now()): string[] {
    const ended: string[] = []
    for (const ticket of this.repo.tickets.open()) {
      if (!planOverdue(ticket, now)) continue
      // The gate is closed by the timeout, so it must not wait again if the ticket is later resumed.
      if (ticket.plan) delete ticket.plan.waiting
      ticket.updatedAt = now
      this.repo.tickets.save(ticket)
      this.end(ticket.id, 'executor', 'stopped', now, 'P1 plan gate timed out: nobody answered, so the ticket stopped (gate timeouts default to stop)')
      ended.push(ticket.id)
    }
    return ended
  }
  /**
   * Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
   * `by` records who ended it: a person, or the host recovering the ticket after a passing model or network failure.
   * @throws UserError when the ticket is unknown or not retryable.
   */
  retry(ticketId: string, by: 'person' | 'recovered' = 'person'): Ticket {
    const ticket = this.require(ticketId)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    const reason = by === 'person' ? 'retried' : 'recovered'
    this.endAssignment(ticket, latest, reason)
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, reason)
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * Re-dispatches an open ticket into another delivery environment: records `backend` on its execution, ends the
   * assignment that stalled, and starts a new one whose input names the channel its work belongs in. The worker continues
   * in the ticket's existing workspace, so a ticket accepted under the wrong environment finishes where it belongs
   * without being ended and accepted again.
   * @throws UserError when the ticket is unknown or has ended.
   */
  redispatch(ticketId: string, backend: Backend, target?: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    const current = latestAssignment(ticket)
    if (current && (current.state === 'running' || current.state === 'pending')) this.endAssignment(ticket, current, 'redispatched')
    // The p4 pipeline gates code changes behind the P1 plan; a git dispatch drops that gate and keeps any later phase.
    // Moving the channel never decides a plan that waits for a person: that gate stays until the card is answered.
    const pendingPlan = ticket.plan?.waiting && !ticket.plan.approved
    if (backend === 'p4') ticket.phase = 'plan'
    else if (ticket.phase === undefined || (ticket.phase === 'plan' && !pendingPlan)) ticket.phase = 'implement'
    // The previous environment's delivery instructions are dropped, so the next launch reads only the new channel's.
    ticket.execution = this.options.reprepareTicket?.(ticket, backend, target)
      ?? { ...(ticket.execution ?? { name: '', directory: '', assignment: '' }), backend, ...(target ? { target } : {}) }
    ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    const input: TicketInput = { id: key('input', ticket.id, 'redispatch', at), kind: 'text', at,
      text: `人确认把这张单改派到 ${backend === 'git' ? 'git 通道（本部署的源码仓库）' : 'p4 通道（depot 工作区）'}${target ? `（${target}）` : ''}：`
        + '按该通道的准备和交付方式继续这张单的工作，交付时按对应要求报告。'
        + (pendingPlan ? '这张单的方案还在等人确认，改派不改变这一步：按方案卡回答后再动代码。' : '') }
    ticket.inputs.push(input); ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (current) this.options.executor.stop(ticket, current, 'redispatched')
    this.options.executor.start(ticket, assignment)
    return this.require(ticketId)
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    // A person's own message answers whatever the ticket asked them, wherever they wrote it; the plan gate has its own answer.
    const fromPerson = input.kind === 'trigger' ? !!input.human && !input.context : input.kind === 'session-resume'
    if (fromPerson && ticket.attention && ticket.attention.question !== PLAN_QUESTION) {
      this.replies.withdrawAttention(ticket.attention.id); delete ticket.attention
    }
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // Hold back automated inputs while the worker is waiting on a person.
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
   * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
   * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
   * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // Prepend the resumed marker so it is delivered ahead of the waiting messages.
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, by: 'thread', triggerId: first.triggerId })
  }
  /**
   * A person wrote in a ticket's worker Session. The Web UI delivers that message into the Session itself, so it reaches no
   * Source and leaves no Trigger behind; the person's act is the authorization, under the ticket's unchanged Mandate, and no
   * Decision is recorded for it, as with `wake`. An ended ticket resumes; one whose worker's turn is over, such as after a
   * blocked report, starts the next Assignment; one still working takes the message as the input its turn reads. What the
   * ticket asked the person is answered by the same act, so its `attention` question and any unsent reply to it go. `text`
   * is what they wrote: the record reads it, while the Session already holds the message itself.
   * @returns false when the ticket is unknown, a person stopped it (its Mandate was withdrawn), processing is paused, or the
   * Policy no longer holds its Mandate (which refuses it).
   */
  wroteInSession(ticketId: string, text: string): boolean {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || ticket.ended?.by === 'human') return false
    const policy = this.policy()
    if (policy.paused) return false
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return false }
    const at = this.now()
    const ended = !!ticket.ended
    delete ticket.ended; ticket.updatedAt = at
    if (ticket.attention) { this.replies.withdrawAttention(ticket.attention.id); delete ticket.attention }
    // A worker still in its turn reads the message where it arrived, so it needs no delivery; one whose turn is over, or
    // whose report ended the round, needs the next Assignment, as a follow-up does, which the message authorizes.
    const current = latestAssignment(ticket)
    const midRound = current !== undefined && current.state === 'running' && !current.idleAt
      && (current.report === undefined || current.report.state === 'progress' || current.report.state === 'waiting')
    if (!midRound && current?.state === 'running') this.endAssignment(ticket, current, 'followUp')
    const assignment = midRound && current ? current : this.newAssignment(ticket)
    if (!midRound) { assignment.state = 'running'; assignment.startedAt = at }
    const wrote: TicketInput = { id: key('input', ticket.id, 'wrote-in-session', at), kind: 'session-resume',
      text: text.slice(0, 4000), at }
    ticket.inputs.push(wrote)
    if (!midRound) ticket.undelivered.push(wrote.id)
    this.repo.tickets.save(ticket)
    if (!midRound) this.options.executor.deliver(ticket, assignment)
    if (ended) this.emit('ticket.resumed', { ticketId, by: 'person' })
    return true
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // The Assignments the end stops end with it; the ticket's end says why.
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /**
   * Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket, and neither does a
   * question an earlier round asked a person. Every path that starts one does so on a person's act (a retry, a re-dispatch,
   * a resume, a message written in the Session) or on the host's own recovery of the ticket, and each of those acts answers
   * what the ticket asked that person, as a message of theirs does. Keeping the question would leave the board saying it
   * awaits an answer while the new Assignment works, which is the state a person retried precisely to leave. A P1 plan's
   * question is not answered by any of those acts, so it stays until a person decides the plan.
   */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now() }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    if (ticket.attention && ticket.attention.question !== PLAN_QUESTION) { this.replies.withdrawAttention(ticket.attention.id); delete ticket.attention }
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * Record a state the host found provably inconsistent and repaired on its own, keeping the last five as the system's trace
   * (the "system handled it" line the board reads). A person's own notes are separate fields and are never rewritten.
   * @throws UserError when the ticket is unknown.
   */
  recordRepair(ticketId: string, repair: Omit<TicketRepair, 'at'>, at = this.now()): Ticket {
    const ticket = this.require(ticketId)
    ticket.repairs = [...ticket.repairs ?? [], { ...repair, at }].slice(-5)
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * Record that a ticket's worker found it is to another ticket as `kind` says (see `TicketRelation`). Recording the same
   * kind to the same ticket again changes nothing, so a retry is safe; the first reason stays.
   * @returns false when the ticket recorded that relation already.
   * @throws UserError when either ticket is unknown, the ticket has ended, or it names itself.
   */
  link(ticketId: string, kind: LinkedRelationKind, otherId: string, reason: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (otherId === ticketId) throw new UserError('selfRelation')
    if (!this.repo.tickets.get(otherId)) throw new UserError('unknownRelated', { ticket: otherId })
    if (ticket.relations?.some(item => item.kind === kind && item.ticketId === otherId)) return false
    const at = this.now()
    ticket.relations = [...ticket.relations ?? [], { kind, ticketId: otherId, reason, at }]
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return true
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
