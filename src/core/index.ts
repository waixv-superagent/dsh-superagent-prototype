/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForPipeline, type EngineForSettings,
  type EngineForSources, type EngineForWatchdog, type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { canRetry, ownPull, ticketStage, type TicketStage } from './stage.ts'
export { waitingOf, type Waiting, type WaitWho } from './waiting.ts'
export { parsePlanDiff, PLAN_DIFF_LIMITS, type PlanDiff, type PlanDiffFile, type PlanDiffHunk, type PlanDiffLine, type PlanDiffParse,
  type PlanDiffStatus } from './diff.ts'
export { ANALYSIS_PLAN_LABELS, DESIGN_PLAN_LABELS, missingPlanLabels, pendingPlan, phaseRank, planChoice, planDecision, planLines, planOverdue, planTemplate,
  PLAN_CARD_QUESTION, PLAN_GATE_HOURS, PLAN_LABELS, PLAN_OPTION_LIMITS, PLAN_QUESTION, PLAN_REPLY_HINT, PLAN_TEMPLATES, ticketPhase, TICKET_PHASES,
  validPlanOptions, type Plan, type PlanDecision, type PlanOption, type PlanTemplate, type PlanVia, type TicketPhase } from './plan.ts'
export { key } from './ids.ts'
export { pipelineNotice, rerunNotice, reviewLabel, type PipelineChoices, type PipelineNotice } from './pipeline-notice.ts'
export { classifyTicket, ticketKind, TICKET_KINDS, type KindInput, type TicketKind, type TicketKindOf, type TicketKindSource } from './kind.ts'
export { missingVerifyLabels, verifyLines, VERIFY_LABELS, VERIFY_LIMITS } from './verification.ts'
export { REPAIR_LIMIT, REPROJECT_AFTER_MS, reprojectable, type Liveness, type Reprojection } from './invariants.ts'
export { PRIORITY_LEVELS, PRIORITY_LABELS, PRIORITY_ASK_MINUTES, defaultPriority, priorityAnswer, priorityAskDeadline, priorityAskOverdue, priorityIsMainline,
  priorityOfText, systemPriority, tapdSuggestion, ticketPriority, waitsForIdle, type PriorityAsk, type PriorityDefault, type PriorityLevel, type PriorityNote, type PriorityVia,
  type PrioritySource, type TicketPriority } from './priority.ts'
export { IDLE_ADMITS, IDLE_DEFAULTS, clockMinutes, dailyIdleRoom, idleAdmits, idleState, inWindow, localDay, minuteOfDay, nightKey, protectedAt, windowAt,
  type ClockTime, type IdleConfig, type IdleLevel, type IdleRange, type IdleReproConfig, type IdleSignals, type IdleState, type IdleWindow } from './idle.ts'
export { ANALYSIS_ADVICE_LABELS, ANALYSIS_RELATED, ANALYSIS_SECTIONS, ANALYSIS_SUMMARY_CHARS, ANALYSIS_VERDICTS, ANALYSIS_VERDICT_LABELS, analysisAdvice,
  analysisAdviceFromSections, analysisBrief, analysisFailed, analysisOf, analysisReady, analysisRunning, analysisSection, worthAttention, type AnalysisRelated } from './analysis.ts'
