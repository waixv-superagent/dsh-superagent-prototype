/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForPipeline, type EngineForSettings,
  type EngineForSources, type EngineForWatchdog, type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { canRetry, ownPull, ticketStage, type TicketStage } from './stage.ts'
export { missingPlanLabels, pendingPlan, planChoice, planDecision, planLines, planOverdue, PLAN_CARD_QUESTION, PLAN_GATE_HOURS, PLAN_LABELS, PLAN_QUESTION,
  PLAN_REPLY_HINT, ticketPhase, TICKET_PHASES, type Plan, type PlanDecision, type PlanOption, type PlanVia, type TicketPhase } from './plan.ts'
export { key } from './ids.ts'
export { REPAIR_LIMIT, REPROJECT_AFTER_MS, reprojectable, type Liveness, type Reprojection } from './invariants.ts'
