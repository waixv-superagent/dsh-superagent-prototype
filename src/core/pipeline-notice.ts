/**
 * What a person reads about a delivered change in chat: one short notice per pipeline event — the green review waiting for
 * a reviewer, a rerun, the pre-submit smoke, a blocker, the submit and the autobuild after it — each with a plain-text line
 * and the structured card a chat Source draws from it. The event id makes the notice idempotent: the same stage of the same
 * review version is announced once, however often the host polls.
 */
import type { PipelineBlockTopic, PipelineCard, PipelineObservation, Ticket } from './model.ts'

/** The choices a deployment configured for its pipeline cards: reviewers to add on Swarm, and where a package may go. */
export interface PipelineChoices {
  reviewers: { label: string; value: string }[]
  targets: { label: string; value: string }[]
}
/** One notice: its idempotent event name, the text fallback, and the card. */
export interface PipelineNotice { event: string; text: string; card: PipelineCard }

const NO_CHOICES: PipelineChoices = { reviewers: [], targets: [] }

/** The review a notice names, as `Swarm - <id>` linked to its URL when it has one. */
export function reviewLabel (review: string | undefined, url: string | undefined): { name: string; link: string } {
  const value = review?.trim() ?? ''
  const id = /(?:reviews?\/)(\d+)/.exec(value)?.[1] ?? (/^\d+$/.test(value) ? value : undefined) ?? /\/reviews\/(\d+)/.exec(url ?? '')?.[1]
  const name = id ? `Swarm - ${id}` : 'Swarm'
  return { name, link: url ? `[${name}](${url})` : name }
}

const BLOCK_HEADINGS: Record<PipelineBlockTopic, { heading: string; tone: PipelineCard['tone']; rerun?: true }> = {
  noResult: { heading: '检查没有结果 · 需要人看一下', tone: 'waiting' },
  stuck: { heading: '检查卡住 · 需要重跑', tone: 'waiting', rerun: true },
  attempts: { heading: '自动修复已用完 · 需要人工', tone: 'danger' },
  smokeFailed: { heading: 'presubmit 失败', tone: 'danger' },
  reviewGone: { heading: 'review 不见了 · 需要确认', tone: 'danger' },
}

type Notable = Exclude<PipelineObservation, { kind: 'running' } | { kind: 'failure' }>

/**
 * The notice for one observation, or undefined for a fact nobody needs to read (a running poll, a failure the worker fixes).
 * `signature` is the observation's own dedupe key; `url` the review link the ticket resolved.
 */
export function pipelineNotice (ticket: Pick<Ticket, 'id' | 'title' | 'execution'>, observation: Notable, url: string | undefined,
  choices: PipelineChoices = NO_CHOICES): PipelineNotice {
  const { name, link } = reviewLabel(ticket.execution?.review, url)
  const review = url ? [{ label: name, url }] : []
  const build = (label: string) => observation.stageUrl ? [{ label, url: observation.stageUrl }] : []
  const card = (tone: PipelineCard['tone'], heading: string, lines: string[], links: PipelineCard['links'],
    extra: Partial<PipelineCard> = {}): PipelineCard =>
    ({ ticketId: ticket.id, title: ticket.title, tone, heading, lines: lines.filter(Boolean), links, ...extra })
  const signature = 'signature' in observation ? observation.signature : undefined
  switch (observation.kind) {
    case 'review': {
      const progress = observation.progress && observation.progress.total > 0
        ? `自动检查 ${observation.progress.pass}/${observation.progress.total} 通过` : '自动检查已通过'
      const advice = /AI 有修改建议/.test(observation.check) ? 'AI 有修改建议，见 review 评论' : ''
      return { event: `review:${signature ?? 'ready'}`, text: `${link} 已通过，待人工审核。`,
        card: card('waiting', '检查已通过 · 待人工审核', [progress, advice], review,
          choices.reviewers.length ? { reviewers: choices.reviewers } : {}) }
    }
    case 'approved': {
      if (observation.step === 'smoke') {
        return { event: `approved:${signature ?? 'approved'}`, text: `${link} 已审核通过，presubmit 冒烟中。`,
          card: card('info', '已审核通过 · presubmit 冒烟中', [observation.check], [...build('presubmit 构建'), ...review]) }
      }
      const smoked = !!observation.stageUrl
      return { event: `approved:${signature ?? 'approved'}`,
        text: smoked ? `${link} 已审核通过，presubmit 通过，等待提交。` : `${link} 已审核通过，等待提交。`,
        card: card('success', smoked ? 'presubmit 通过 · 待提交' : '已审核通过 · 待提交', [observation.check],
          [...review, ...build('presubmit 构建')]) }
    }
    case 'blocked': {
      const kind = observation.topic ? BLOCK_HEADINGS[observation.topic] : { heading: '需要人工', tone: 'waiting' as const }
      return { event: `blocked:${signature ?? 'blocked'}`, text: `${link} 需要人工：${observation.reason}`,
        card: card(kind.tone, kind.heading, [observation.reason], [...review, ...build('Jenkins 构建')],
          'rerun' in kind && kind.rerun ? { rerun: true } : {}) }
    }
    case 'merged': {
      const next = observation.autobuild ? '等待 autobuild 出编辑器包' : '工单已完成'
      const change = observation.change ? `CL ${observation.change} 已入库` : '已入库'
      return { event: 'merged', text: `${link} 已提交入库${observation.autobuild ? '，等待 autobuild。' : '。'}`,
        card: card('success', '提交成功', [change, next], review) }
    }
    case 'autobuild': {
      const event = `autobuild:${observation.signature}`
      const links = [...observation.artifact ? [{ label: '编辑器包', url: observation.artifact }] : [], ...build('autobuild 构建')]
      if (observation.result === 'running') {
        return { event, text: `${link} 已入库，autobuild 构建中。`, card: card('info', 'autobuild 构建中', [observation.check], links) }
      }
      if (observation.result === 'passed') {
        const sent = observation.artifact ? `[编辑器包](${observation.artifact})` : '编辑器包'
        return { event, text: `${link} autobuild 出包成功：${sent}。不需要转发就关单。`,
          card: card('success', 'autobuild 出包成功', [observation.check, choices.targets.length ? '选人或群发送；不需要就点关单' : '不需要转发就点关单'], links,
            { ...choices.targets.length ? { targets: choices.targets } : {}, close: true }) }
      }
      if (observation.result === 'failed') {
        return { event, text: `${link} autobuild 失败，看构建日志；处理完可关单。`,
          card: card('danger', 'autobuild 失败', [observation.check], links, { close: true }) }
      }
      return { event, text: `${link} autobuild 一直没有结果；确认后可关单。`,
        card: card('waiting', 'autobuild 没有结果', [observation.check], links, { close: true }) }
    }
  }
}

/** The notice a requested rerun gets: once per request, so a person sees the wait is on Swarm, not on the worker. */
export function rerunNotice (ticket: Pick<Ticket, 'id' | 'title' | 'execution'>, url: string | undefined, at: string): PipelineNotice {
  const { name, link } = reviewLabel(ticket.execution?.review, url)
  return { event: `rerun:${at}`, text: `${link} 已请求重跑检查，等待新结果。`,
    card: { ticketId: ticket.id, title: ticket.title, tone: 'info', heading: '检查重跑中', lines: ['已请求 Swarm 重跑失败的检查，等新结果'],
      links: url ? [{ label: name, url }] : [] } }
}
