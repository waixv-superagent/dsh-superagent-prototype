/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { missingPlanLabels, pendingPlan, planDecision, planLines, planOverdue, PLAN_GATE_HOURS, PLAN_LABELS, PLAN_QUESTION, PLAN_REPLY_HINT,
  ticketPhase, TICKET_PHASES, type Plan, type PlanDecision, type PlanVia, type TicketPhase } from './plan.ts'
export { key } from './ids.ts'
