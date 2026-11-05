/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
export const USER_ERRORS = {
  unknownTicket: ['missing', 'Unknown ticket'],
  unknownProblem: ['missing', 'Unavailable Eval not found'],
  unknownTrigger: ['missing', 'Unknown trigger'],
  unknownAssignment: ['missing', 'Unknown assignment'],
  unknownBlock: ['missing', 'Unknown settings block: {block}'],
  unknownPromptRevision: ['missing', 'Unknown prompt revision {revision}'],
  unknownPromptPart: ['refused', 'Unknown built-in prompt part {part}'],
  ticketEnded: ['refused', 'Ticket has ended'],
  assignmentEnded: ['refused', 'Assignment has ended; a newer assignment owns this ticket'],
  evalFinished: ['refused', 'Eval {eval} has finished or a later eval replaced it; decide the trigger\'s current eval'],
  notAdmissible: ['refused', 'Trigger is not admissible: {reason}'],
  notExplicit: ['refused', 'An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide'],
  ticketStopped: ['refused', 'A person stopped this ticket; new work needs an accept through orchestrator_route'],
  mandateRevoked: ['refused', 'The current policy no longer holds this ticket\'s mandate; new work needs an accept through orchestrator_route'],
  notRetryable: ['refused', 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed'],
  sourceThread: ['refused', 'This is the thread the ticket started on; it stays subscribed'],
  followedThread: ['refused', 'This thread is the ticket\'s own, such as its pull request\'s; it stays subscribed'],
  notFollowing: ['refused', 'This ticket does not follow that thread'],
  selfRelation: ['refused', 'A ticket cannot be related to itself'],
  unknownRelated: ['missing', 'Unknown ticket {ticket}; link to the id of an existing ticket'],
  questionWithResult: ['refused', 'A question for a person cannot also be a ready result or an answer; report it separately'],
  askerWithoutQuestion: ['refused', 'The message that raised a question needs the question it raised'],
  notAsker: ['refused', 'A question must name the person\'s message that raised it, which reached this ticket'],
  notAnswerable: ['refused', 'An answer must name the person\'s question it answers, which reached this ticket'],
  ackEnded: ['refused', 'Ticket ended; do not acknowledge historical requests'],
  notReached: ['refused', 'Trigger does not belong to this worker'],
  handedBack: ['refused', 'This ticket handed that trigger back already'],
  handedBackHere: ['refused', 'The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it'],
  workerDecides: ['refused', 'This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop'],
  ackNoChannel: ['refused', 'Acknowledgement requires an assigned human source message'],
  ackNotPerson: ['refused', 'Use the original human trigger, not a bot, CI or worker report'],
  notReady: ['refused', 'Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel.'],
  notAttention: ['refused', 'Attention requires the ticket\'s current attention question in human_action. Routine unfinished work stays internal.'],
  notQuestion: ['refused', 'An answer must target the original human question, not a worker report or automated trigger'],
  noAnswer: ['refused', 'No worker answer is ready for this human trigger. Wait for the worker\'s report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer.'],
  noChannel: ['refused', 'No reply channel for this ticket or trigger'],
  panelOnlyEnvironment: ['refused', 'The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel'],
  panelOnlyAccounts: ['refused', 'Source fields that setup reads, such as account CLIs, can only be changed in the management panel'],
  setupComplete: ['refused', 'Setup is complete'],
  modelUnavailable: ['refused', 'The {block} model is not available: {error}'],
  promptTooLong: ['refused', 'Prompt configuration exceeds {limit} characters'],
  promptPlaceholders: ['refused', 'The “{part}” template must keep {placeholders}, which the system fills in'],
  promptPartEmpty: ['refused', 'The “{part}” part cannot be empty; reset it to follow its built-in text'],
  sourceNotInstalled: ['refused', 'The {source} Source kind is not installed'],
  noLabels: ['refused', 'This Source has no names to refresh'],
  nothingToSync: ['refused', 'The {source} Source\'s part of the Policy has nothing to sync from, or the Source is off or waiting for setup'],
  nothingDelivered: ['refused', 'This ticket has no delivered changelist to confirm; a person confirms only what its worker reported it shelved'],
  alreadyConfirmed: ['refused', 'A person already confirmed this ticket; running the submit stays theirs'],
  nothingToVerify: ['refused', 'This ticket has no delivered work waiting for local verification'],
  alreadyVerified: ['refused', 'A person already recorded local verification for this ticket'],
  notVerifying: ['refused', 'This ticket is not waiting for local verification; a person verifies only work its worker delivered'],
  planRequired: ['refused', 'The P1 gate needs a plan first: call orchestrator_plan with the fixed template, and wait for a person to answer 1 before changing files or reporting delivery'],
  planIncomplete: ['refused', 'The plan must keep every {template} template line with its evidence; missing: {labels}'],
  planTemplate: ['refused', 'A design plan needs 2 to 4 options, each with a description stating what choosing it means'],
  planNotPending: ['refused', 'No plan of this ticket waits for a person\'s decision'],
  planOptions: ['refused', 'Plan choices are 2 to 4 unique labels, each mapped to approve, revise, or stop; a design choice also needs a description of at most 160 characters'],
  planQuestion: ['refused', 'A plan question is one non-empty line of at most 200 characters'],
  planSections: ['refused', 'A plan card\'s context sections are 1 to 6 blocks, each with a short unique label and its own text'],
  planDiff: ['refused', 'The plan diff must be one unified diff this panel can render: {problem}'],
  optionsWithoutQuestion: ['refused', 'Options need the question they answer; ask it with human_action'],
  attentionOptions: ['refused', 'A question offers 2 to 4 unique option labels of at most 24 characters'],
  attentionSections: ['refused', 'A question card\'s context sections are 1 to 6 blocks, each with a short unique label and its own text'],
  notAttentionOption: ['refused', 'That option is not one this question offers'],
  notAttentionAnswer: ['refused', 'A written answer cannot be empty'],
  phaseOutOfOrder: ['refused', 'The ticket is in the {from} phase; a worker advances one phase at a time, and implement only once a person approved the plan'],
  notDeliverable: ['refused', 'A changelist, a Swarm review and verification belong to the deliver phase: pass its checks, then call orchestrator_phase with deliver'],
  notImplement: ['refused', 'The ticket is still in its plan phase: a person must approve the plan before this tool changes anything'],
  notAnalysing: ['refused', 'Only the ticket\'s running idle analysis may record a verdict'],
  analysisReadOnly: ['refused', 'This assignment is the ticket\'s read-only idle analysis: it cannot deliver a changelist, review or PR; report the dossier and its verdict instead'],
  unknownReproCase: ['missing', 'Unknown reproduction case {case}'],
  unknownReproRun: ['missing', 'Unknown reproduction run {run}'],
  reproCaseInvalid: ['refused', 'The reproduction case {case} cannot run: {reason}'],
  reproBusy: ['refused', 'A reproduction case is already running; stop it before starting another'],
  reproNotRunning: ['refused', 'That reproduction run has already ended'],
  reproBlockedAgent: ['refused', 'An agent holds the shared editor; let it yield before running a local reproduction case'],
  reproBlockedJob: ['refused', 'A host-run editor job holds the shared editor; wait for it to end before running a local reproduction case']
} as const satisfies Record<string, readonly ['missing' | 'refused', string]>
export type UserErrorCode = keyof typeof USER_ERRORS

/**
 * Structured error thrown by Engine parts and application services when a caller request is invalid or references missing state.
 * Tool handlers and HTTP routes inspect its code and missing flag to return appropriate status responses, while the web panel localizes the code.
 */
export class UserError extends Error {
  readonly missing: boolean
  constructor(readonly code: UserErrorCode, readonly values: Record<string, string> = {}) {
    const [kind, text] = USER_ERRORS[code]
    super(text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match))
    this.missing = kind === 'missing'
  }
}
