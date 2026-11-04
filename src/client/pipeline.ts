/** Reading a delivered change's pipeline as stages: the Swarm submitter flow the panel draws on a card and a ticket. */
import type { PipelineProgress, PipelineStep, TicketPipeline } from '../core/model.ts'
import type { DshSuperagentKey } from './locales.ts'
import type { T } from './text.ts'

/** The part of a pipeline the panel reads; the full record also carries the follow-up's signatures and counters. */
export type PipelineView = Pick<TicketPipeline, 'state' | 'manual' | 'step' | 'progress' | 'check' | 'stageUrl' | 'url' | 'reason' | 'submitted'>

/** The four steps the panel draws, in order: pre-approval checks, the person's review, the pre-submit smoke, the submit. */
export const PIPELINE_TRACK: readonly PipelineStep[] = ['tests', 'review', 'smoke', 'merged']
/** The track with the editor autobuild after the submit, for a pipeline that follows one. */
export const AUTOBUILD_TRACK: readonly PipelineStep[] = [...PIPELINE_TRACK, 'autobuild']
/** The track a pipeline draws: the autobuild step joins it once the change was submitted with an autobuild to follow. */
export const pipelineTrack = (pipeline: Pick<TicketPipeline, 'step' | 'submitted'> | undefined): readonly PipelineStep[] =>
  pipeline?.submitted || pipeline?.step === 'autobuild' ? AUTOBUILD_TRACK : PIPELINE_TRACK

/**
 * The fine stage of a pipeline. A pipeline recorded before the stage existed has no `step`, so its last check sentence and
 * coarse state stand in; the host writes the field on its next observation.
 */
export function pipelineStep (pipeline: PipelineView | undefined): PipelineStep | undefined {
  if (!pipeline) return undefined
  if (pipeline.step) return pipeline.step
  if (pipeline.state === 'merged') return 'merged'
  const check = pipeline.check ?? ''
  if (/冒烟中|冒烟失败|冒烟进行/.test(check)) return 'smoke'
  if (/CL .*pending|等待提交/.test(check)) return 'ready'
  if (pipeline.state === 'blocked' && pipeline.manual && /已通过/.test(check)) return 'review'
  if (pipeline.state === 'running' && /审核通过/.test(check)) return 'ready'
  return 'tests'
}

/** A failed pre-submit smoke is a real block, not the "only your approval remains" wait a manual review is. */
export function pipelineSmokeFailed (pipeline: PipelineView | undefined): boolean {
  return pipeline?.state === 'blocked' && pipelineStep(pipeline) === 'smoke'
}

/** Where the pipeline stands, in words a card tag or a ticket fact can show. */
export function pipelineStageLabel (t: T, pipeline: PipelineView | undefined): string {
  const step = pipelineStep(pipeline)
  if (step === 'autobuild' && pipeline?.state !== 'merged') return t('pipelineStage.autobuild')
  if (pipeline?.state === 'blocked') {
    if (pipeline.manual) {
      if (step === 'review') return t('pipelineStage.review')
      if (step === 'smoke') return t('pipelineStage.smokeFailed')
      return t('pipelineWaiting')
    }
    return t('pipelineBlocked')
  }
  return step ? t(`pipelineStage.${step}`) : t('pipelineRunning')
}

/** The stage's position on the four-step track: tests 0, review 1, smoke/approval 2, submit 3. */
export function pipelineTrackIndex (step: PipelineStep | undefined): number {
  switch (step) {
    case 'tests': return 0
    case 'review': return 1
    case 'smoke': return 2
    case 'ready':
    case 'merged': return 3
    case 'autobuild': return 4
    default: return 0
  }
}

/** Whether a track node is behind the pipeline, the one it is on, or still ahead of it. */
export function pipelineTrackState (step: PipelineStep | undefined, index: number): 'done' | 'current' | 'pending' {
  if (step === 'merged') return 'done'
  const current = pipelineTrackIndex(step)
  return index < current ? 'done' : index === current ? 'current' : 'pending'
}

/** The running checks' counts, as one short line, when the review reports them. */
export function pipelineProgressText (t: T, progress: PipelineProgress | undefined): string | undefined {
  if (!progress || progress.total <= 0) return undefined
  const base = t('pipelineChecksProgress', { pass: String(progress.pass), total: String(progress.total) })
  if (progress.fail > 0) return `${base} · ${t('pipelineChecksFailed', { fail: String(progress.fail) })}`
  if (progress.running > 0) return `${base} · ${t('pipelineChecksRunning', { running: String(progress.running) })}`
  return base
}

/** Locale key of one track node's label, for the ticket's step strip. */
export const pipelineTrackLabel = (step: PipelineStep): DshSuperagentKey => `pipelineTrack.${step}` as DshSuperagentKey
