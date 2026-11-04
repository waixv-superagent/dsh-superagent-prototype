/**
 * The host's automatic pipeline follow-up. It polls Swarm (and Jenkins for a failure's error lines) for every open ticket
 * whose change was delivered to p4, and hands the Engine one observation per state change: a failure to fix, a green
 * review waiting for a person, an approval, a manual blocker, or the submit. Because the host polls, no follow-up worker
 * starts a subagent to poll, and a message is queued only for a fact a person can act on.
 */
import type { EngineForPipeline, PipelineObservation, PipelineProgress, PipelineStep, Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { PipelineApprovalBuild, PipelineChecks, PipelineReview, PipelineStatus } from './pipeline.ts'

export interface PipelineWatchHost {
  /** The open tickets to check; the watcher filters them to delivered p4 work. */
  tickets: { open: () => Ticket[] }
  settings: () => Settings
  engine: EngineForPipeline
  checks: Pick<PipelineChecks, 'review' | 'status' | 'changeState' | 'jenkins' | 'approvalBuild' | 'autobuildBuild'>
  paused?: () => boolean
  /** A failed poll of one ticket is logged and does not stop the others. */
  warn?: (message: string) => void
  now?: () => number
}

/** How long a recorded review id may stay unknown right after delivery before it counts as missing. */
const REVIEW_GRACE_MS = 5 * 60_000
/** How long after a worker asked Swarm to rerun checks its old result is not treated as a new failure. */
const RERUN_GRACE_MS = 5 * 60_000
/** The light heartbeat that only wakes the watcher when its configured interval is due. */
const HEARTBEAT_MS = 5_000
const MAX_DETAIL = 3_500

/** The counts a running review reports, shaped for the panel's compact progress line. */
const progressOf = (status: PipelineStatus): PipelineProgress =>
  ({ pass: status.pass, running: status.running, fail: status.fail, total: status.total })

/** Whether a submit waits for the editor autobuild: the job is set and Jenkins is readable. */
export const autobuildFollowed = (settings: Settings): boolean => {
  const p4 = settings.executor.p4
  return !!(p4.autobuildJob.trim() && p4.jenkinsUrl.trim() && p4.jenkinsToken.trim())
}

/**
 * Polls and reports. `poll` checks every delivered p4 ticket once; `start` repeats it at the configured interval, so a
 * failure wakes the worker, a green review asks a person once, and the submit completes the ticket.
 */
export class PipelineWatch {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<void>
  private lastPoll = 0
  private stopped = false
  constructor (private readonly host: PipelineWatchHost) {}

  /** Begin the heartbeat; the first tick checks at once, since `lastPoll` starts at zero. */
  start (): void {
    this.stopped = false
    this.timer = setInterval(() => { void this.tick() }, HEARTBEAT_MS)
    this.timer.unref?.()
    this.tick()
  }

  /** Stop scheduling and wait for a check already in flight, so no observation reaches a closed store. */
  async stop (): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  private tick (): void {
    if (this.stopped || this.inFlight) return
    const seconds = this.host.settings().executor.p4.followupSeconds
    if (!seconds) return
    const now = this.host.now?.() ?? Date.now()
    if (now - this.lastPoll < seconds * 1000) return
    this.lastPoll = now
    void this.poll()
  }

  /** Check every delivered p4 ticket once. Overlapping calls share the in-flight check. */
  async poll (): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.stopped || this.host.paused?.()) return
    this.inFlight = (async () => {
      const settings = this.host.settings()
      if (!settings.executor.p4.followupSeconds) return
      const now = this.host.now?.() ?? Date.now()
      for (const ticket of this.host.tickets.open()) {
        if (this.stopped || this.host.paused?.()) return
        if (!this.follows(ticket, settings)) continue
        try {
          await this.observe(ticket, settings, now)
        } catch (error) {
          this.host.warn?.(`pipeline check for ticket ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** Whether this ticket's open pipeline is one the host follows. */
  private follows (ticket: Ticket, settings: Settings): boolean {
    if (ticket.ended || !ticket.pipeline || ticket.pipeline.state === 'merged') return false
    if ((ticket.execution?.backend ?? settings.executor.backend) !== 'p4') return false
    return !!ticket.execution?.review || ticket.execution?.changelist !== undefined
  }

  private report (ticket: Ticket, observation: PipelineObservation): void {
    this.host.engine.observePipeline(ticket.id, observation)
  }

  private async observe (ticket: Ticket, settings: Settings, now: number): Promise<void> {
    if (ticket.pipeline?.submitted) return this.autobuild(ticket, settings, now)
    const review = ticket.execution?.review
    const changelist = ticket.execution?.changelist
    const url = ticket.pipeline?.url
    const previousStep = ticket.pipeline?.step
    // With an autobuild job, a submit leaves the ticket open for the editor build that includes it.
    const autobuild = autobuildFollowed(settings)
    const merged = (check: string, change?: number): PipelineObservation =>
      ({ kind: 'merged', step: 'merged', check, ...(url ? { url } : {}), ...(change !== undefined ? { change } : {}), ...(autobuild ? { autobuild } : {}) })
    if (!review) {
      if (changelist === undefined) return
      const state = await this.host.checks.changeState(changelist)
      // A change with no review has no Swarm flow to draw: it only waits for its submit.
      if (state === 'pending') this.report(ticket, { kind: 'running', step: 'ready', check: 'CL 仍在 pending，等待提交', ...(url ? { url } : {}) })
      else this.report(ticket, { kind: 'blocked', step: 'ready', check: 'CL 状态无法确认', topic: 'reviewGone',
        reason: `本单没有记录 Swarm review，CL ${changelist} 在服务器上也不存在；请确认它是否已提交，或补一个 review。`, ...(url ? { url } : {}) })
      return
    }
    const info = await this.host.checks.review(review)
    if (!info) {
      // A submitted review disappears from this Swarm: the submit deletes the pending changelist, so `missing` is its trail.
      if (changelist === undefined) {
        this.report(ticket, { kind: 'blocked', step: previousStep ?? 'tests', check: 'Swarm review 已不存在', topic: 'reviewGone',
          reason: `review 已不存在，且本单没有记录 CL；请确认是否已提交。`, ...(url ? { url } : {}) })
        return
      }
      const state = await this.host.checks.changeState(changelist)
      if (state !== 'missing' && state !== 'submitted') {
        const started = Date.parse(ticket.pipeline?.at ?? '') || now
        if (now - started < REVIEW_GRACE_MS) {
          this.report(ticket, { kind: 'running', step: 'tests', check: '等待 Swarm review 可读', ...(url ? { url } : {}) })
          return
        }
        this.report(ticket, { kind: 'blocked', step: previousStep ?? 'tests', check: 'Swarm review 已不存在', topic: 'reviewGone',
          reason: `review 已不存在，但 CL ${changelist} 仍 pending；请确认 review 状态。`, ...(url ? { url } : {}) })
        return
      }
      this.report(ticket, merged('CL 已提交入库'))
      return
    }
    if (info.state === 'committed' || info.state === 'archived' || (info.state === 'approved' && info.commits.length > 0)) {
      this.report(ticket, merged(info.state === 'approved' ? 'review 已审核通过并提交' : `review ${info.state}`,
        info.commits.length ? Math.max(...info.commits) : undefined))
      return
    }
    if (info.state === 'approved') {
      await this.approved(ticket, settings, info, url)
      return
    }
    if (info.state === 'rejected' || info.state === 'needsRevision') {
      await this.failure(ticket, settings, now, `${info.version}:${info.state}`, { step: 'review',
        check: `Swarm 审核要求修改（${info.stateLabel || info.state}）`,
        detail: `Swarm 审核人要求修改（${info.stateLabel || info.state}），见 review 评论：${url ?? review}。按要求修改后 reshelve 同一个 CL。` })
      return
    }
    const version = info.version
    const rerunAt = ticket.pipeline?.rerunAt ? Date.parse(ticket.pipeline.rerunAt) : 0
    if (rerunAt && now - rerunAt < RERUN_GRACE_MS && info.testStatus !== 'pass') {
      // The worker asked for a rerun; until Swarm replaces the old result, it is not a new failure to hand over.
      this.report(ticket, { kind: 'running', step: 'tests', check: '已请求重跑检查，等待新结果', ...(url ? { url } : {}) })
      return
    }
    if (info.testStatus === 'fail') {
      if (ticket.pipeline?.observed === `${version}:fail`) return this.stuckOrRunning(ticket, settings, now, url)
      const status = await this.host.checks.status(review, version)
      const detail = await this.failureDetail(this.host.checks, settings, info.id, status, url)
      await this.failure(ticket, settings, now, `${version}:fail`, { step: 'tests', progress: progressOf(status),
        check: `Swarm 检查失败：${status.failures.map(item => item.title).slice(0, 3).join('、') || '见 review'}`,
        detail, ...(url ? { url } : {}) })
      return
    }
    if (info.testStatus === 'pass') {
      const status = await this.host.checks.status(review, version)
      if (status.ai && !status.ai.approved) {
        if (ticket.pipeline?.observed === `${version}:ai`) return this.stuckOrRunning(ticket, settings, now, url)
        const detail = [
          `Swarm 的自动检查已通过，但 AI 审核结论是「${status.ai.verdict}」，需要按建议处理：`,
          ...status.ai.advice ? [`AI 提出了修改建议，见 review 的 AI 评论：${url ?? review}。`] : [],
          '处理后在当前工作区 reshelve 同一个 CL；不要 p4 submit。'
        ].join('\n')
        await this.failure(ticket, settings, now, `${version}:ai`, { step: 'tests', progress: progressOf(status),
          check: `AI 审核未通过：${status.ai.verdict}`, detail, ...(url ? { url } : {}) })
        return
      }
      const advice = status.ai?.advice ? '（AI 有修改建议）' : ''
      this.report(ticket, { kind: 'review', step: 'review', progress: progressOf(status),
        check: `Swarm 已通过${advice}，待人工审核`, ...(url ? { url } : {}), signature: `${version}:pass` })
      return
    }
    if (info.testStatus === 'running') {
      // The aggregate says checks are running; the testrun list is what turns that into "3/11". A failure to read the detail
      // still reports the stage, just without counts.
      let progress: PipelineProgress | undefined
      try { progress = progressOf(await this.host.checks.status(review, version)) } catch { /* counts are optional */ }
      this.report(ticket, { kind: 'running', step: 'tests', ...(progress ? { progress } : {}), check: '审核前测试中', ...(url ? { url } : {}) })
      return
    }
    // No result yet. The review's current version says when checks should have appeared; an old one means they never did.
    const since = info.changedAt ? info.changedAt * 1000 : (Date.parse(ticket.pipeline?.at ?? '') || now)
    if (now - since > settings.executor.p4.stuckMinutes * 60_000) {
      this.report(ticket, { kind: 'blocked', step: 'tests', check: '流水线没有结果', topic: 'noResult',
        reason: `${settings.executor.p4.stuckMinutes} 分钟没有检查结果；请确认 Swarm 是否触发。`, ...(url ? { url } : {}) })
      return
    }
    this.report(ticket, { kind: 'running', step: 'tests', check: '等待流水线结果', ...(url ? { url } : {}) })
  }

  /**
   * An approved review enters the pre-submit smoke. Swarm itself reports only the pre-approval checks, so the smoke state
   * comes from the configured Jenkins job: a running build is its own stage, a passed one leaves the person to submit, and a
   * failed one is a manual blocker with the build to read. Without a readable job the approval is the old "waiting to
   * submit" fact.
   */
  private async approved (ticket: Ticket, settings: Settings, info: PipelineReview, url?: string): Promise<void> {
    const review = ticket.execution!.review!
    const p4 = settings.executor.p4
    if (p4.postApprovalJob.trim() && p4.jenkinsUrl.trim() && p4.jenkinsToken.trim()) {
      let build: PipelineApprovalBuild | null = null
      try {
        build = await this.host.checks.approvalBuild(review, ticket.execution?.changelist)
      } catch (error) {
        this.host.warn?.(`pre-submit smoke check for review ${info.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (build?.state === 'running') {
        this.report(ticket, { kind: 'approved', step: 'smoke', check: `已审核通过 · Jenkins 冒烟中（#${build.number}）`,
          stageUrl: build.url, ...(url ? { url } : {}), signature: `${info.version}:approved:smoke` })
        return
      }
      if (build?.state === 'failed') {
        this.report(ticket, { kind: 'blocked', step: 'smoke', check: `提交前冒烟失败（#${build.number}）`, topic: 'smokeFailed',
          reason: `Jenkins 提交前冒烟 #${build.number} 失败；查看构建日志，修复后重新 shelve 再提交。`,
          stageUrl: build.url, ...(url ? { url } : {}), signature: `${info.version}:smoke:fail` })
        return
      }
      if (build?.state === 'passed') {
        this.report(ticket, { kind: 'approved', step: 'ready', check: 'Jenkins 冒烟已通过，等待提交',
          stageUrl: build.url, ...(url ? { url } : {}), signature: `${info.version}:approved:smoke:pass` })
        return
      }
    }
    this.report(ticket, { kind: 'approved', step: 'ready', check: 'Swarm 已审核通过，等待提交',
      ...(url ? { url } : {}), signature: `${info.version}:approved` })
  }

  /**
   * The editor autobuild after a submit. The build that includes the submitted change is followed until it finishes: a
   * running one is reported once, a passed one carries its package link to the person's card, a failed one its build. A
   * submit no build picked up within `autobuildMinutes` asks the person instead of waiting forever.
   */
  private async autobuild (ticket: Ticket, settings: Settings, now: number): Promise<void> {
    const submitted = ticket.pipeline!.submitted!
    const url = ticket.pipeline?.url
    // A passed build waits only for the person's send or close; nothing about it changes on Jenkins.
    if (ticket.pipeline?.state === 'blocked' && ticket.pipeline.observed?.endsWith(':passed')) return
    // A deployment that stopped following autobuilds lets its open submits finish the way they did before.
    if (!autobuildFollowed(settings)) {
      this.report(ticket, { kind: 'autobuild', result: 'timeout', check: '已不再跟进 autobuild，确认后可关单', signature: 'off', ...(url ? { url } : {}) })
      return
    }
    const at = Date.parse(submitted.at) || now
    const build = await this.host.checks.autobuildBuild({ ...(submitted.change !== undefined ? { change: submitted.change } : {}), at })
    if (!build) {
      if (now - at > settings.executor.p4.autobuildMinutes * 60_000) {
        this.report(ticket, { kind: 'autobuild', result: 'timeout', signature: 'timeout', ...(url ? { url } : {}),
          check: `入库 ${settings.executor.p4.autobuildMinutes} 分钟仍没有 autobuild 构建包含它` })
      }
      return
    }
    const name = `autobuild #${build.number}`
    const common = { stageUrl: build.url, ...(url ? { url } : {}) }
    if (build.state === 'running') this.report(ticket, { kind: 'autobuild', result: 'running', check: `${name} 构建中`, signature: `${build.number}:running`, ...common })
    else if (build.state === 'passed') this.report(ticket, { kind: 'autobuild', result: 'passed', check: `${name} 已出编辑器包`, signature: `${build.number}:passed`,
      artifact: build.artifact, ...common })
    else this.report(ticket, { kind: 'autobuild', result: 'failed', check: `${name} 构建失败`, signature: `${build.number}:failed`, ...common })
  }

  /** Wake a worker for a failure, unless the automatic attempts are used up; a repeated signature only waits. */
  private async failure (ticket: Ticket, settings: Settings, now: number, signature: string, observation: {
    check: string; detail: string; url?: string; step?: PipelineStep; progress?: PipelineProgress; stageUrl?: string
  }): Promise<void> {
    if (ticket.pipeline?.observed === signature) return this.stuckOrRunning(ticket, settings, now, observation.url)
    const fixes = ticket.pipeline?.fixes ?? 0
    const extra = { ...(observation.step ? { step: observation.step } : {}),
      ...(observation.progress ? { progress: observation.progress } : {}),
      ...(observation.stageUrl ? { stageUrl: observation.stageUrl } : {}) }
    if (fixes >= settings.executor.p4.fixAttempts) {
      this.report(ticket, { kind: 'blocked', check: observation.check, topic: 'attempts',
        reason: `连续 ${fixes} 次自动修复仍失败；请人工处理。`,
        signature: `attempts:${signature}`, ...extra, ...(observation.url ? { url: observation.url } : {}) })
      return
    }
    this.report(ticket, { kind: 'failure', check: observation.check, signature, detail: observation.detail,
      ...extra, ...(observation.url ? { url: observation.url } : {}) })
  }

  /**
   * A failure already handed to the worker waits for a new version. If no new result has appeared for longer than the
   * stuck window after the worker last acted, say so: a reshelve with no content change opens no Swarm version and
   * triggers no rerun, which a person must know rather than have the worker reshelve in circles.
   */
  private stuckOrRunning (ticket: Ticket, settings: Settings, now: number, url?: string): void {
    const latest = ticket.assignments.at(-1)
    const acted = Math.max(
      Date.parse(ticket.pipeline?.fixAt ?? '') || 0,
      Date.parse(ticket.pipeline?.at ?? '') || 0,
      Date.parse(latest?.idleAt ?? '') || 0,
      Date.parse(latest?.deliveredAt ?? '') || 0,
      Date.parse(latest?.report?.at ?? '') || 0
    )
    const extra = { ...(ticket.pipeline?.step ? { step: ticket.pipeline.step } : {}),
      ...(ticket.pipeline?.progress ? { progress: ticket.pipeline.progress } : {}),
      ...(ticket.pipeline?.stageUrl ? { stageUrl: ticket.pipeline.stageUrl } : {}) }
    const minutes = settings.executor.p4.stuckMinutes
    if (acted && now - acted > minutes * 60_000) {
      this.report(ticket, { kind: 'blocked', check: '失败后没有新的流水线结果', topic: 'stuck',
        reason: `${minutes} 分钟没有新结果；请重跑或确认是否可忽略。`,
        signature: `stuck:${ticket.pipeline?.observed ?? 'unknown'}`, ...extra, ...(url ? { url } : {}) })
      return
    }
    this.report(ticket, { kind: 'running', check: '流水线失败，等待修复后重跑', ...extra, ...(url ? { url } : {}) })
  }

  /** Failing checks, their Jenkins error lines, and the AI conclusion, bounded for one worker message. */
  private async failureDetail (checks: Pick<PipelineChecks, 'jenkins'>, settings: Settings, review: string, status: PipelineStatus, url?: string): Promise<string> {
    const lines = [`Swarm review ${review} 的当前版本检查失败${url ? `（${url}）` : ''}。`]
    if (status.failures.length) {
      lines.push('失败项：')
      for (const failure of status.failures.slice(0, 10)) lines.push(`- ${failure.title}${failure.url ? `：${failure.url}` : ''}`)
    } else lines.push('Swarm 报告检查失败，但没有列出失败项；请打开 review 查看。')
    if (status.ai && !status.ai.approved) lines.push(`AI 审核结论：${status.ai.verdict}`)
    if (settings.executor.p4.jenkinsToken.trim()) {
      for (const failure of status.failures.filter(item => item.url).slice(0, 3)) {
        try {
          const log = await checks.jenkins(failure.url!, failure.title)
          if (log.errors.length) {
            lines.push(`Jenkins ${failure.title} 错误：`)
            for (const error of log.errors.slice(0, 15)) lines.push(`  ${error}`)
          }
        } catch (error) {
          lines.push(`（${failure.title} 的 Jenkins 日志读取失败：${error instanceof Error ? error.message : String(error)}）`)
        }
      }
    } else if (status.failures.some(item => item.url)) {
      lines.push('（未配置 Jenkins API token，未读构建日志；失败项链接见上。）')
    }
    return lines.join('\n').slice(0, MAX_DETAIL)
  }
}
