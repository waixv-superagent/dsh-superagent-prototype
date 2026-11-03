/**
 * The host's automatic pipeline follow-up. It polls Swarm (and Jenkins for a failure's error lines) for every open ticket
 * whose change was delivered to p4, and hands the Engine one observation per state change: a failure to fix, a green
 * review waiting for a person, an approval, a manual blocker, or the submit. Because the host polls, no follow-up worker
 * starts a subagent to poll, and a message is queued only for a fact a person can act on.
 */
import type { EngineForPipeline, PipelineObservation, Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { PipelineChecks, PipelineStatus } from './pipeline.ts'

export interface PipelineWatchHost {
  /** The open tickets to check; the watcher filters them to delivered p4 work. */
  tickets: { open: () => Ticket[] }
  settings: () => Settings
  engine: EngineForPipeline
  checks: Pick<PipelineChecks, 'review' | 'status' | 'changeState' | 'jenkins'>
  paused?: () => boolean
  /** A failed poll of one ticket is logged and does not stop the others. */
  warn?: (message: string) => void
  now?: () => number
}

/** How long a recorded review id may stay unknown right after delivery before it counts as missing. */
const REVIEW_GRACE_MS = 5 * 60_000
/** The light heartbeat that only wakes the watcher when its configured interval is due. */
const HEARTBEAT_MS = 5_000
const MAX_DETAIL = 3_500

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
    const review = ticket.execution?.review
    const changelist = ticket.execution?.changelist
    const url = ticket.pipeline?.url
    if (!review) {
      if (changelist === undefined) return
      const state = await this.host.checks.changeState(changelist)
      if (state === 'pending') this.report(ticket, { kind: 'running', check: 'CL 仍在 pending，等待提交', ...(url ? { url } : {}) })
      else this.report(ticket, { kind: 'blocked', check: 'CL 状态无法确认',
        reason: `本单没有记录 Swarm review，CL ${changelist} 在服务器上也不存在；请确认它是否已提交，或补一个 review。`, ...(url ? { url } : {}) })
      return
    }
    const info = await this.host.checks.review(review)
    if (!info) {
      // A submitted review disappears from this Swarm: the submit deletes the pending changelist, so `missing` is its trail.
      if (changelist === undefined) {
        this.report(ticket, { kind: 'blocked', check: 'Swarm review 已不存在',
          reason: `review ${review} 在 Swarm 上已不存在，且本单没有记录 CL；请确认它是否已提交。`, ...(url ? { url } : {}) })
        return
      }
      const state = await this.host.checks.changeState(changelist)
      if (state !== 'missing' && state !== 'submitted') {
        const started = Date.parse(ticket.pipeline?.at ?? '') || now
        if (now - started < REVIEW_GRACE_MS) {
          this.report(ticket, { kind: 'running', check: '等待 Swarm review 可读', ...(url ? { url } : {}) })
          return
        }
        this.report(ticket, { kind: 'blocked', check: 'Swarm review 已不存在',
          reason: `review ${review} 已不存在，但 CL ${changelist} 仍在 pending；请确认 review 是否被删除或关闭。`, ...(url ? { url } : {}) })
        return
      }
      this.report(ticket, { kind: 'merged', check: 'CL 已提交入库', ...(url ? { url } : {}) })
      return
    }
    if (info.state === 'committed' || info.state === 'archived' || (info.state === 'approved' && info.commits.length > 0)) {
      this.report(ticket, { kind: 'merged', check: info.state === 'approved' ? 'review 已审核通过并提交' : `review ${info.state}`, ...(url ? { url } : {}) })
      return
    }
    if (info.state === 'approved') {
      this.report(ticket, { kind: 'approved', check: 'Swarm 已审核通过，等待提交', ...(url ? { url } : {}), signature: `${info.version}:approved` })
      return
    }
    if (info.state === 'rejected' || info.state === 'needsRevision') {
      await this.failure(ticket, settings, now, `${info.version}:${info.state}`, { check: `Swarm 审核要求修改（${info.stateLabel || info.state}）`,
        detail: `Swarm 审核人要求修改（${info.stateLabel || info.state}），见 review 评论：${url ?? review}。按要求修改后 reshelve 同一个 CL。` })
      return
    }
    const version = info.version
    if (info.testStatus === 'fail') {
      if (ticket.pipeline?.observed === `${version}:fail`) return this.stuckOrRunning(ticket, settings, now, url)
      const status = await this.host.checks.status(review, version)
      const detail = await this.failureDetail(this.host.checks, settings, info.id, status, url)
      await this.failure(ticket, settings, now, `${version}:fail`, { check: `Swarm 检查失败：${status.failures.map(item => item.title).slice(0, 3).join('、') || '见 review'}`,
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
        await this.failure(ticket, settings, now, `${version}:ai`, { check: `AI 审核未通过：${status.ai.verdict}`,
          detail, ...(url ? { url } : {}) })
        return
      }
      const advice = status.ai?.advice ? '（AI 有修改建议）' : ''
      this.report(ticket, { kind: 'review', check: `Swarm 已通过${advice}，待人工审核`, ...(url ? { url } : {}), signature: `${version}:pass` })
      return
    }
    if (info.testStatus === 'running') {
      this.report(ticket, { kind: 'running', check: '流水线检查中', ...(url ? { url } : {}) })
      return
    }
    // No result yet. The review's current version says when checks should have appeared; an old one means they never did.
    const since = info.changedAt ? info.changedAt * 1000 : (Date.parse(ticket.pipeline?.at ?? '') || now)
    if (now - since > settings.executor.p4.stuckMinutes * 60_000) {
      this.report(ticket, { kind: 'blocked', check: '流水线没有结果',
        reason: `review ${review} 第 ${version} 版已有 ${settings.executor.p4.stuckMinutes} 分钟没有流水线结果；请确认 Swarm 是否触发了检查，必要时人工重跑。`,
        ...(url ? { url } : {}) })
      return
    }
    this.report(ticket, { kind: 'running', check: '等待流水线结果', ...(url ? { url } : {}) })
  }

  /** Wake a worker for a failure, unless the automatic attempts are used up; a repeated signature only waits. */
  private async failure (ticket: Ticket, settings: Settings, now: number, signature: string, observation: {
    check: string; detail: string; url?: string
  }): Promise<void> {
    if (ticket.pipeline?.observed === signature) return this.stuckOrRunning(ticket, settings, now, observation.url)
    const fixes = ticket.pipeline?.fixes ?? 0
    if (fixes >= settings.executor.p4.fixAttempts) {
      this.report(ticket, { kind: 'blocked', check: observation.check,
        reason: `连续 ${fixes} 次自动修复后流水线仍失败（${observation.check}）；请人工判断是继续修、重跑，还是接受现状。`,
        signature: `attempts:${signature}`, ...(observation.url ? { url: observation.url } : {}) })
      return
    }
    this.report(ticket, { kind: 'failure', check: observation.check, signature, detail: observation.detail, ...(observation.url ? { url: observation.url } : {}) })
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
    const minutes = settings.executor.p4.stuckMinutes
    if (acted && now - acted > minutes * 60_000) {
      this.report(ticket, { kind: 'blocked', check: '失败后没有新的流水线结果',
        reason: `上次失败后 ${minutes} 分钟没有新的流水线结果：reshelve 内容没有变化时 Swarm 不会重跑。需要人工在 Jenkins/Swarm 重跑，或确认这次失败是否可忽略。`,
        signature: `stuck:${ticket.pipeline?.observed ?? 'unknown'}`, ...(url ? { url } : {}) })
      return
    }
    this.report(ticket, { kind: 'running', check: '流水线失败，等待修复后重跑', ...(url ? { url } : {}) })
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
