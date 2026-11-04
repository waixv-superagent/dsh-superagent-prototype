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
export { ANALYSIS_PLAN_LABELS, DESIGN_PLAN_LABELS, missingPlanLabels, pendingPlan, planChoice, planDecision, planLines, planOverdue, planTemplate,
  PLAN_CARD_QUESTION, PLAN_GATE_HOURS, PLAN_LABELS, PLAN_OPTION_LIMITS, PLAN_QUESTION, PLAN_REPLY_HINT, PLAN_TEMPLATES, ticketPhase, TICKET_PHASES,
  validPlanOptions, type Plan, type PlanDecision, type PlanOption, type PlanTemplate, type PlanVia, type TicketPhase } from './plan.ts'
export { key } from './ids.ts'
export { missingVerifyLabels, verifyLines, VERIFY_LABELS, VERIFY_LIMITS } from './verification.ts'
export { REPAIR_LIMIT, REPROJECT_AFTER_MS, reprojectable, type Liveness, type Reprojection } from './invariants.ts'
