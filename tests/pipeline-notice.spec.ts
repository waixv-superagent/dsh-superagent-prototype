import { describe, expect, it } from 'vitest'
import { pipelineNotice, rerunNotice, type Ticket } from '../src/core/index.ts'

const ticket = { id: 'abcdef1234', title: '修复跳跃', execution: { name: 'w', directory: '/w', assignment: '', review: '585334' } } as Pick<Ticket, 'id' | 'title' | 'execution'>
const URL = 'https://swarm.example.com/reviews/585334'
const choices = { reviewers: [{ label: '张三', value: 'zhangsan' }], targets: [{ label: '编辑器群', value: 'oc_1' }] }

describe('pipeline notices', () => {
  it('asks for a review with the check counts and the reviewer choices', () => {
    const notice = pipelineNotice(ticket, { kind: 'review', signature: '3:pass', check: 'Swarm 已通过，待人工审核',
      progress: { pass: 11, running: 0, fail: 0, total: 11 } }, URL, choices)
    expect(notice.event).toBe('review:3:pass')
    expect(notice.text).toBe(`[Swarm - 585334](${URL}) 已通过，待人工审核。`)
    expect(notice.card).toMatchObject({ tone: 'waiting', heading: '检查已通过 · 待人工审核', lines: ['自动检查 11/11 通过'],
      links: [{ label: 'Swarm - 585334', url: URL }], reviewers: choices.reviewers })
    expect(notice.card.targets).toBeUndefined()
  })
  it('offers no reviewer choice when none is configured', () => {
    const notice = pipelineNotice(ticket, { kind: 'review', check: 'Swarm 已通过（AI 有修改建议），待人工审核' }, URL)
    expect(notice.card.reviewers).toBeUndefined()
    expect(notice.card.lines).toContain('AI 有修改建议，见 review 评论')
  })
  it('names each presubmit stage apart, so a passed smoke is a different event from the approval', () => {
    const smoking = pipelineNotice(ticket, { kind: 'approved', step: 'smoke', signature: '3:approved:smoke', check: '已审核通过 · Jenkins 冒烟中（#7）',
      stageUrl: 'https://ci/7' }, URL)
    const passed = pipelineNotice(ticket, { kind: 'approved', step: 'ready', signature: '3:approved:smoke:pass', check: 'Jenkins 冒烟已通过，等待提交',
      stageUrl: 'https://ci/7' }, URL)
    const plain = pipelineNotice(ticket, { kind: 'approved', step: 'ready', signature: '3:approved', check: 'Swarm 已审核通过，等待提交' }, URL)
    expect(new Set([smoking.event, passed.event, plain.event]).size).toBe(3)
    expect(smoking.card).toMatchObject({ tone: 'info', heading: '已审核通过 · presubmit 冒烟中', links: [{ label: 'presubmit 构建', url: 'https://ci/7' }, { url: URL }] })
    expect(passed.card).toMatchObject({ tone: 'success', heading: 'presubmit 通过 · 待提交' })
    expect(passed.text).toContain('presubmit 通过')
    expect(plain.card.heading).toBe('已审核通过 · 待提交')
  })
  it('gives each blocker its own headline, and a stuck failure a rerun button', () => {
    const stuck = pipelineNotice(ticket, { kind: 'blocked', topic: 'stuck', signature: 'stuck:3:fail', check: '失败后没有新的流水线结果',
      reason: '45 分钟没有新结果；请重跑或确认是否可忽略。' }, URL)
    expect(stuck.card).toMatchObject({ heading: '检查卡住 · 需要重跑', rerun: true, lines: ['45 分钟没有新结果；请重跑或确认是否可忽略。'] })
    const smoke = pipelineNotice(ticket, { kind: 'blocked', topic: 'smokeFailed', check: '提交前冒烟失败（#8）', reason: '看日志', stageUrl: 'https://ci/8' }, URL)
    expect(smoke.card).toMatchObject({ tone: 'danger', heading: 'presubmit 失败', links: [{ url: URL }, { label: 'Jenkins 构建', url: 'https://ci/8' }] })
    expect(smoke.card.rerun).toBeUndefined()
    const generic = pipelineNotice(ticket, { kind: 'blocked', check: 'x', reason: '原因' }, URL)
    expect(generic.text).toBe(`[Swarm - 585334](${URL}) 需要人工：原因`)
  })
  it('announces the submit, and with an autobuild says the ticket waits for it', () => {
    const done = pipelineNotice(ticket, { kind: 'merged', check: 'CL 已提交入库', change: 590001 }, URL)
    expect(done.card).toMatchObject({ tone: 'success', heading: '提交成功', lines: ['CL 590001 已入库', '工单已完成'] })
    const waits = pipelineNotice(ticket, { kind: 'merged', check: 'CL 已提交入库', autobuild: true }, URL)
    expect(waits.card.lines).toEqual(['已入库', '等待 autobuild 出编辑器包'])
    expect(waits.event).toBe('merged')
  })
  it('lets a passed autobuild send its package or close, and a failed one close', () => {
    const passed = pipelineNotice(ticket, { kind: 'autobuild', result: 'passed', signature: '41:passed', check: 'autobuild #41 已出编辑器包',
      artifact: 'https://pkg/41.zip', stageUrl: 'https://ci/ab/41' }, URL, choices)
    expect(passed.event).toBe('autobuild:41:passed')
    expect(passed.card).toMatchObject({ tone: 'success', heading: 'autobuild 出包成功', targets: choices.targets, close: true,
      links: [{ label: '编辑器包', url: 'https://pkg/41.zip' }, { label: 'autobuild 构建', url: 'https://ci/ab/41' }] })
    const failed = pipelineNotice(ticket, { kind: 'autobuild', result: 'failed', signature: '41:failed', check: 'autobuild #41 构建失败' }, URL, choices)
    expect(failed.card).toMatchObject({ tone: 'danger', close: true })
    expect(failed.card.targets).toBeUndefined()
    const running = pipelineNotice(ticket, { kind: 'autobuild', result: 'running', signature: '41:running', check: 'autobuild #41 构建中' }, URL, choices)
    expect(running.card.close).toBeUndefined()
  })
  it('says a requested rerun once per request', () => {
    expect(rerunNotice(ticket, URL, '2026-11-05T00:00:00Z')).toMatchObject({ event: 'rerun:2026-11-05T00:00:00Z', card: { heading: '检查重跑中' } })
  })
})
