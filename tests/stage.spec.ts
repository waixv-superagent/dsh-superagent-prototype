import { describe, expect, it } from 'vitest'
import { canRetry, completedArchived, currentReport, ticketStage, waitingOf, type Assignment, type ReportState, type Ticket } from '../src/core/index.ts'

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({ id: 'a', state: 'running', createdAt: '', ...overrides })
const reported = (state: ReportState, overrides: Partial<Assignment> = {}) => assignment({ report: { state, summary: '', at: '' }, ...overrides })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' },
  channels: [], assignments: [assignment()], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides })
const attention = { id: 'q', question: '?' }
/** A person's message that reached the Ticket after its report. */
const answered = { inputs: [{ id: 'i', kind: 'trigger' as const, triggerId: 'e', at: 'later', human: true as const }] }
const reportedAt = (state: ReportState) => reported(state, { report: { state, summary: '', at: 'earlier' } })
/** A Report its worker has been busy with newer Inputs since: the Executor continues the work by itself. */
const busy = (state: ReportState) => ({ ...reportedAt(state), deliveredAt: 'later' })
const ended = { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }

// The rows of the docs/003 table, in order; a Ticket that matches several rows takes the first.
describe('ticketStage', () => {
  it.each([
    ['an undelivered Input', ticket({ delivery: { error: 'offline', at: '' } }), { stage: 'person', action: 'delivery' }],
    ['delivery before answer and review', ticket({ delivery: { error: 'offline', at: '' }, attention, assignments: [reported('ready')] }), { stage: 'person', action: 'delivery' }],
    ['an Attention', ticket({ attention }), { stage: 'person', action: 'answer' }],
    ['answer before review', ticket({ attention, assignments: [reported('ready')] }), { stage: 'person', action: 'answer' }],
    ['answer before a failure', ticket({ attention, assignments: [reported('failed')] }), { stage: 'person', action: 'answer' }],
    ['a ready Report', ticket({ assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
    // The pipeline runs on the host from delivery on, so it comes before the person's parallel local check.
    ['a running pipeline before the local check', ticket({ pipeline: { state: 'running', at: '' }, verification: { at: '', state: 'pending' } }),
      { stage: 'pipeline', action: 'running' }],
    ['a delivered ticket whose pipeline has not started', ticket({ verification: { at: '', state: 'pending' } }), { stage: 'person', action: 'verify' }],
    ['a ready Report of an ended Assignment', ticket({ assignments: [reported('ready', { state: 'ended' })] }), { stage: 'person', action: 'review' }],
    ['a blocked Report', ticket({ assignments: [reported('blocked')] }), { stage: 'person', action: 'blocked' }],
    ['a failed Report', ticket({ assignments: [reported('failed')] }), { stage: 'person', action: 'failed' }],
    ['a running pipeline after verification', ticket({ pipeline: { state: 'running', at: '' },
      assignments: [assignment({ state: 'ended' })] }), { stage: 'pipeline', action: 'running' }],
    ['a blocked pipeline before an answer', ticket({ pipeline: { state: 'blocked', at: '', manual: true }, attention, assignments: [reported('ready')] }),
      { stage: 'person', action: 'answer' }],
    ['a blocked pipeline', ticket({ pipeline: { state: 'blocked', at: '', manual: true }, assignments: [assignment({ state: 'ended' })] }),
      { stage: 'pipeline', action: 'blocked' }],
    // A change delivered into the pull request the Ticket opened is approved and merged there, not reviewed locally.
    ['a ready Report of a change delivered as its own pull request', ticket({ follows: [{ thread: 'github:7', own: true }],
      assignments: [reported('ready')] }), { stage: 'pipeline', action: 'blocked' }],
    ['a ready Report of a pull request that closed', ticket({ follows: [{ thread: 'github:7', own: true,
      closed: { at: '', outcome: 'merged' } }], assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
    ['a ready Report of a pull request it only follows', ticket({ follows: [{ thread: 'github:7', own: false }],
      assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
    // A merged pipeline is history: a round a person's later message resumed is not pipeline work again.
    ['a ready Report after a merged pipeline resumed the Ticket', ticket({ pipeline: { state: 'merged', at: '' },
      follows: [{ thread: 'github:7', own: true }], assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
    // A merged pipeline ended the ticket once; a person's later message may resume it for a round that is not pipeline work.
    ['a merged pipeline a person\'s message resumed', ticket({ pipeline: { state: 'merged', at: '' } }), { stage: 'working' }],
    ['an ended pipeline', ticket({ pipeline: { state: 'merged', at: '' }, ended }), { stage: 'ended' }],
    ['a blocked Report a person answered since', ticket({ ...answered, assignments: [reportedAt('blocked')] }), { stage: 'working' }],
    // A Report its worker has newer Inputs than is history: the Ticket is working again on what was delivered after it.
    ['a ready Report whose worker got an Input after it', ticket({ assignments: [busy('ready')] }), { stage: 'working' }],
    ['a waiting Report whose worker got an Input after it', ticket({ assignments: [busy('waiting')] }), { stage: 'working' }],
    ['a progress Report whose worker got an Input after it', ticket({ assignments: [busy('progress')] }), { stage: 'working' }],
    // A blocked or failed Report is not continued by the worker on its own: it keeps waiting for a person.
    ['a blocked Report whose worker got an Input after it', ticket({ assignments: [busy('blocked')] }), { stage: 'person', action: 'blocked' }],
    ['a failed Report whose worker got an Input after it', ticket({ assignments: [busy('failed')] }), { stage: 'person', action: 'failed' }],
    ['a ready Report whose worker got an Input after it, on an ended Assignment', ticket({ assignments: [reported('ready', { state: 'ended',
      deliveredAt: 'later' })] }), { stage: 'idle' }],
    ['no Assignment', ticket({ assignments: [] }), { stage: 'working', action: 'queued' }],
    ['a pending Assignment', ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] }), { stage: 'working', action: 'queued' }],
    ['a waiting Report', ticket({ assignments: [reported('waiting')] }), { stage: 'idle' }],
    ['an ended Assignment', ticket({ assignments: [assignment({ state: 'ended' })] }), { stage: 'idle' }],
    ['a running Assignment', ticket(), { stage: 'working' }],
    ['a progress Report', ticket({ assignments: [reported('progress')] }), { stage: 'working' }],
    ['an ended Ticket', ticket({ ended, attention, assignments: [reported('failed')] }), { stage: 'ended' }],
  ])('%s', (_name, value, stage) => { expect(ticketStage(value)).toEqual(stage) })
})

// The same rows as a wait a person or the router can act on: who it is for, the action, and the one real deadline.
describe('waitingOf', () => {
  const plan = { text: '', at: '', waiting: true as const, deadline: '2026-09-24T00:00:00Z' }
  it.each([
    ['a question for a person', ticket({ attention, plan, updatedAt: 'now' }), { who: 'person', action: 'answer', since: 'now', until: '2026-09-24T00:00:00Z' }],
    ['delivered work waiting for the person\'s check', ticket({ verification: { at: 'delivered', state: 'pending' } }),
      { who: 'person', action: 'verify', since: 'delivered' }],
    ['a pipeline waiting on Swarm', ticket({ pipeline: { state: 'running', at: 'piped' }, assignments: [assignment({ state: 'ended' })] }),
      { who: 'pipeline', action: 'running', since: 'piped' }],
    ['a queued ticket', ticket({ assignments: [] }), { who: 'worker', action: 'queued', since: '' }],
    ['a running worker', ticket(), { who: 'worker', action: 'running', since: '' }],
    ['an ended ticket', ticket({ ended }), { who: 'none', action: 'closed', since: '' }],
  ])('%s', (_name, value, waiting) => { expect(waitingOf(value)).toEqual(waiting) })
})

// A Report speaks for the Ticket only while its worker has nothing newer, which is what the stage and the summary read.
describe('currentReport', () => {
  it('keeps the report its worker still waits on, and drops the one newer work or a person superseded', () => {
    expect(currentReport(ticket({ assignments: [reported('ready')] }))?.state).toBe('ready')
    expect(currentReport(ticket({ assignments: [reported('failed')] }))?.state).toBe('failed')
    expect(currentReport(ticket({ assignments: [busy('ready')] }))).toBeUndefined()
    expect(currentReport(ticket({ ...answered, assignments: [reportedAt('failed')] }))).toBeUndefined()
    // A retry or a re-dispatch starts a new Assignment: the old report is history, and the new one has said nothing yet.
    expect(currentReport(ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] }))).toBeUndefined()
    expect(currentReport(ticket({ assignments: [assignment()] }))).toBeUndefined()
  })
})

describe('completedArchived', () => {
  const completedAt = '2026-10-01T00:00:00.000Z'
  const done = ticket({ ended: { at: completedAt, by: 'executor', outcome: 'completed' } })
  it('keeps a completed Ticket for seven days, then archives it without touching the record', () => {
    expect(completedArchived(done, '2026-10-07T23:59:59.999Z')).toBe(false)
    expect(completedArchived(done, '2026-10-08T00:00:00.000Z')).toBe(true)
    expect(done.ended?.outcome).toBe('completed')
  })
  it('does not archive any other outcome', () => {
    expect(completedArchived(ticket({ ended: { at: completedAt, by: 'human', outcome: 'stopped' } }), '2027-01-01T00:00:00.000Z')).toBe(false)
    expect(completedArchived(ticket(), '2027-01-01T00:00:00.000Z')).toBe(false)
  })
})

describe('canRetry', () => {
  it.each([
    ['a failed open Ticket', true, ticket({ assignments: [reported('failed')] })],
    ['a blocked open Ticket', true, ticket({ assignments: [reported('blocked')] })],
    ['a failed Ticket that also awaits an answer', true, ticket({ attention, assignments: [reported('failed')] })],
    ['a blocked Ticket whose Input is undelivered', true, ticket({ delivery: { error: 'offline', at: '' }, assignments: [reported('blocked')] })],
    ['a failed Ticket that ended', false, ticket({ ended, assignments: [reported('failed')] })],
    ['a Ticket retried already, whose new Assignment is pending', false, ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] })],
    ['a ready Ticket', false, ticket({ assignments: [reported('ready')] })],
    ['a running Ticket', false, ticket()],
    ['a Ticket without an Assignment', false, ticket({ assignments: [] })],
    // The worker has the person's message, as the Ticket's stage says, so a retry would only interrupt it.
    ['a failed Ticket a person answered since', false, ticket({ ...answered, assignments: [reportedAt('failed')] })],
    // Unless delivering that message failed: a new Assignment starts the worker again and takes the message.
    ['a failed Ticket whose delivery of a person\'s answer failed', true,
      ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })],
    ['a working Ticket whose Input could not be delivered', true, ticket({ delivery: { error: 'offline', at: '' } })],
    ['an ended Ticket whose Input could not be delivered', false, ticket({ ended, delivery: { error: 'offline', at: '' } })],
  ])('%s: %s', (_name, expected, value) => { expect(canRetry(value)).toBe(expected) })
  it('offers a retry in each person stage a new Assignment remedies', () => {
    const delivery = ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })
    expect(ticketStage(delivery)).toEqual({ stage: 'person', action: 'delivery' })
    expect(canRetry(delivery)).toBe(true)
  })
})
