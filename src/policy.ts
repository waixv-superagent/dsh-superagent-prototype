/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, type AssessmentOutcome, type Escalation, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Strength, type Thread, type Ticket,
  type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { IDLE_DEFAULTS } from './core/idle.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'
import { WorkspaceSchema } from './executor/workspace.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'chat' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  /** chat 必须带的答复文字。 */
  reply?: string | null
  /** chat 可选携带的、值得单独建单的事；`target` 允许模型传 null，表示没有具体目标。 */
  escalation?: (Omit<Escalation, 'target'> & { target?: string | null }) | null
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * A chat needs only `reply`, since a conversation is not work; an escalation it carries is built like an accept, so it needs
 * the same facts and is likewise recorded as `would_accept` instead in `observe`.
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, an accept omits `intent_evidence`, a chat
 * omits `reply`, or an escalation lacks a settled direction, a matched enabled rule or `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision === 'chat') {
    const reply = assessment.reply?.trim()
    if (!reply) throw new Error('A chat decision requires reply: the answer sent to the person')
    const escalation = assessment.escalation
    if (!escalation) return { kind: 'chat', reply, reason: assessment.reason, audit }
    // escalation 会建单，因此和 accept 一样要方向已定、有命中的启用规则和意图证据。
    if (!directionAllowed(assessment.direction) || !matches.length) {
      throw new Error('An escalation requires a settled direction and at least one matched enabled rule; decide chat without escalation otherwise')
    }
    if (!assessment.intent_evidence) throw new Error('An escalation requires intent_evidence')
    const rules = matches.map(match => match.rule_id)
    const name = assessment.worktree_name ? { name: assessment.worktree_name } : {}
    // 目标只记安装确实配置的那种写法；null 与缺省同义，不进入 core 的 Escalation。
    const settled = { title: escalation.title, scope: escalation.scope, category: escalation.category, reason: escalation.reason,
      ...(escalation.target ? { target: escalation.target } : {}) }
    // observe 下不建单：记下本可建的单，回复照发。
    if (strength === 'inferred' && settings.eval.mode !== 'auto') {
      return { kind: 'chat', reply, rules, reason: assessment.reason, audit: { ...audit, would_accept: true, proposal: settled } }
    }
    return { kind: 'chat', reply, escalation: settled, rules, ...name, reason: assessment.reason, audit }
  }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}) }
}
const DEFAULT_RULES = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
}).strict()
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/**
 * Perforce delivery settings, used only when `backend` is `p4`.
 * Swarm credentials are not stored here: they come from the installation's P4 ticket. The Jenkins API token is the one
 * delivery credential these settings hold, because it cannot be derived from the P4 session; the host uses it only for
 * the read-only pipeline check and redacts it from the result.
 */
export const P4ConfigSchema = z.object({
  /** `P4PORT`, such as `p4.example.com:1666`; empty leaves the installation's own setting in place. */
  port: z.string().trim().max(200).default(''),
  /** `P4USER`; empty leaves the installation's own setting in place. */
  user: z.string().trim().max(100).default(''),
  /** Workspace name for a Ticket, where `<name>` is replaced by the Ticket's short name. */
  clientTemplate: z.string().trim().max(200).default('dsh-<name>'),
  /** Depot path the workspace maps, such as `//depot/mainline`. A stream's path works here too, for the sync and for a classic view. */
  depot: z.string().trim().max(400).default(''),
  /** Stream the workspace is a client of, such as `//sun/mainline`; a stream depot requires this instead of a hand-written view. */
  stream: z.string().trim().max(400).default(''),
  /** Revision synced into a new workspace, such as `@head` or `@12345`. */
  syncSpec: z.string().trim().max(100).default('@head'),
  /** Swarm base URL, used to open and follow reviews; empty disables review actions. */
  swarmUrl: z.string().trim().max(300).default(''),
  /** Swarm API version prefix, such as `/api/v11`. */
  reviewApi: z.string().trim().max(40).default('/api/v11'),
  /** Jenkins base URL used to read consoleText; empty uses the testrun URL's origin. */
  jenkinsUrl: z.string().trim().max(300).default(''),
  /** Jenkins account for reading consoleText; empty falls back to `user`. */
  jenkinsUser: z.string().trim().max(100).default(''),
  /** Jenkins API token for reading consoleText. Stored only in this installation's settings; never printed or committed. */
  jenkinsToken: z.string().trim().max(500).default(''),
  /** Jenkins job Swarm triggers after a review is approved; its build is the pre-submit smoke. Empty disables that step. */
  postApprovalJob: z.string().trim().max(200).default('PostApproval-Entry'),
  /**
   * The people a review-waiting card offers to add as Swarm reviewers: a display name and the p4 account the click adds.
   * Empty keeps the card without a reviewer choice.
   */
  reviewers: z.array(z.object({ label: z.string().trim().min(1).max(60), user: z.string().trim().min(1).max(100) }).strict()).max(40).default([]),
  /**
   * Jenkins job that builds the editor after a submit. With one set, a submitted change waits for its build: the ticket
   * stays open until the build passed and a person sends the package or closes it. Empty completes the ticket at the submit.
   */
  autobuildJob: z.string().trim().max(200).default(''),
  /**
   * The package link of a passed autobuild, with `<build>` (build number), `<cl>` (the build's changelist) and `<url>` (the
   * build page) filled in. Empty uses the build page.
   */
  autobuildArtifact: z.string().trim().max(500).default(''),
  /** Where an autobuild card may send the package: a display name and a Feishu person (`ou_…`) or chat (`oc_…`). */
  autobuildTargets: z.array(z.object({ label: z.string().trim().min(1).max(60), id: z.string().trim().regex(/^o[uc]_[A-Za-z0-9]+$/) }).strict())
    .max(40).default([]),
  /** Minutes after a submit with no autobuild including it before the card says so. */
  autobuildMinutes: z.number().int().min(10).max(1440).default(120),
  /** Seconds between host polls of an open change's Swarm review; 0 turns the automatic follow-up off. */
  followupSeconds: z.number().int().min(0).max(3600).default(60),
  /** How many times a failing pipeline wakes its worker to fix it before it asks a person. */
  fixAttempts: z.number().int().min(1).max(10).default(3),
  /** Minutes without a new review version or check result before the follow-up reports the pipeline stuck. */
  stuckMinutes: z.number().int().min(5).max(240).default(45),
}).strict()
/**
 * Idle time and priority questions: the windows in which `P2`/`P3` work may start, how long a worker slot must stay free,
 * how quiet a person must be, the idle pool's daily and concurrent budget, and how long a TAPD priority question waits.
 * The judgement itself is `core/idle.ts`; this is only what the deployment may tune.
 */
const ClockTimeSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'A time of day, HH:MM')
/**
 * What an idle-window launch does (docs/025): a read-only analysis that ends in a verdict, instead of implementation. The
 * switch restores the earlier behavior; `related` bounds the likely-duplicate list the worker sees.
 */
const IdleAnalysisSchema = z.object({
  enabled: z.boolean().default(IDLE_DEFAULTS.analysis.enabled)
    .describe('Run idle-window launches as read-only analyses with a verdict; false starts the ticket\'s ordinary work instead.'),
  related: z.number().int().min(0).max(3).default(IDLE_DEFAULTS.analysis.related)
    .describe('How many likely related tickets an analysis brief names, from the relation graph\'s own guess.'),
}).strict()
export const IdleConfigSchema = z.object({
  enabled: z.boolean().default(IDLE_DEFAULTS.enabled),
  windows: z.array(z.object({ from: ClockTimeSchema, to: ClockTimeSchema, level: z.enum(['L1', 'L2', 'L3']) }).strict())
    .min(1).max(8).default(() => IDLE_DEFAULTS.windows.map(window => ({ ...window }))),
  protectedWindows: z.array(z.object({ from: ClockTimeSchema, to: ClockTimeSchema }).strict())
    .max(8).default(() => IDLE_DEFAULTS.protectedWindows.map(window => ({ ...window }))),
  slotFreeMin: z.number().int().min(1).max(120).default(IDLE_DEFAULTS.slotFreeMin),
  humanQuietMin: z.number().int().min(1).max(240).default(IDLE_DEFAULTS.humanQuietMin),
  dailyItems: z.number().int().min(1).max(100).default(IDLE_DEFAULTS.dailyItems),
  analysisWorkers: z.number().int().min(1).max(4).default(IDLE_DEFAULTS.analysisWorkers),
  priorityAskMin: z.number().int().min(5).max(720).default(IDLE_DEFAULTS.priorityAskMin),
  analysis: IdleAnalysisSchema.default(() => IdleAnalysisSchema.parse({})),
}).strict()
export type IdleSettings = z.infer<typeof IdleConfigSchema>
/**
 * The host's stall alert: how long a working Ticket may go without visible progress, and a queued one without starting,
 * before its conversation hears of it once. `notify: false` keeps the alert on the board and the status card only.
 */
export const StallConfigSchema = z.object({
  minutes: z.number().int().min(5).max(240).default(15),
  queuedMinutes: z.number().int().min(5).max(480).default(30),
  notify: z.boolean().default(true),
}).strict()
/**
 * The shared editor the host schedules for Tickets (docs/021). Empty commands leave that kind of job unavailable, so
 * workers keep running their own build or test under a lease. Placeholders: `<project>` is the `.uproject`, `<dir>` the
 * Ticket's workspace, `<filter>` a test job's automation filter. The host runs them; a Session never supplies one.
 */
export const EditorConfigSchema = z.object({
  /** The `.uproject` the editor opens; ue-mcp's bridge status is read beside it. Empty turns the bridge reading off. */
  project: z.string().trim().max(400).default(''),
  /** The project's own compile entry, such as `<dir>\Development\Project\SunGame\Build\BatchFiles\Compile\CompileSunGame.bat`. */
  build: z.string().trim().max(1000).default(''),
  /** Restarts the editor, such as ue-mcp's `editor.restart_editor` through its CLI. */
  restart: z.string().trim().max(1000).default(''),
  /** Runs one automation filter headless; `<filter>` is replaced by the worker's filter. */
  test: z.string().trim().max(1000).default(''),
}).strict()
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, blocked commands, and the delivery backend. */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
  /** `git` keeps the GitHub pull-request flow; `p4` shelves a changelist and opens a Swarm review instead. */
  backend: z.enum(['git', 'p4']).default('git'),
  /** When `P2`/`P3` work may start and how a TAPD priority question expires (see `core/idle.ts`). */
  idle: IdleConfigSchema.default(() => IdleConfigSchema.parse({})),
  p4: P4ConfigSchema.default(() => P4ConfigSchema.parse({})),
  /** When a stalled Ticket is announced; a deployment that never set it keeps the defaults. */
  stall: StallConfigSchema.default(() => StallConfigSchema.parse({})),
  /** The task center's workspaces: empty means one implicit directory per ticket under `directory` or `<stateDir>/work`. */
  workspaces: z.array(WorkspaceSchema).default([]),
  editor: EditorConfigSchema.default(() => EditorConfigSchema.parse({})),
}).strict()
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync' | 'command'

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
