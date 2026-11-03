import { describe, expect, it } from 'vitest'
import { EXECUTOR_VARIABLES, environmentOf, p4Client, p4Prepare } from '../src/app/execution-environment.ts'
import { baseAssignment, deliveryInstructions, sharingInstructions, ticketExecution } from '../src/executor/dsh.ts'
import { ExecutorConfigSchema, SettingsSchema } from '../src/policy.ts'
import type { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** `environmentOf` only asks the registry for Source-declared variables; a deployment without Sources declares none. */
const noSources = { environments: () => [] } as unknown as SourceRegistry
const settingsWith = (executor: Record<string, unknown>) => SettingsSchema.parse({ executor })
const valueOf = (variables: ReturnType<typeof environmentOf>, key: string): string | undefined =>
  variables.find(variable => variable.key === key)?.value

describe('p4 delivery settings', () => {
  it('default to the git backend, so nothing about a GitHub installation changes', () => {
    const executor = ExecutorConfigSchema.parse({})
    expect(executor.backend).toBe('git')
    expect(executor.prepare).toBe('')
    expect(executor.p4.depot).toBe('')
    expect(executor.p4.stream).toBe('')
    expect(executor.p4.jenkinsToken).toBe('')
    expect(executor.p4.jenkinsUrl).toBe('')
  })
  it('accept the p4 backend with its depot, revision and review settings', () => {
    const executor = ExecutorConfigSchema.parse({ backend: 'p4', p4: { port: 'p4.example.com:1666', user: 'agent',
      clientTemplate: 'dsh-<name>', depot: '//depot/mainline', syncSpec: '@head', swarmUrl: 'https://swarm.example.com', reviewApi: '/api/v11' } })
    expect(executor.backend).toBe('p4')
    expect(executor.p4.depot).toBe('//depot/mainline')
  })
})

describe('p4 execution variables', () => {
  it('are declared once, so the Execution settings list them even with the git backend', () => {
    const keys = EXECUTOR_VARIABLES.map(variable => variable.key)
    for (const key of ['DSH_SUPERAGENT_BACKEND', 'DSH_SUPERAGENT_P4_CLIENT', 'DSH_SUPERAGENT_P4_PORT',
      'DSH_SUPERAGENT_P4_DEPOT', 'DSH_SUPERAGENT_P4_STREAM', 'DSH_SUPERAGENT_P4_SYNC', 'DSH_SUPERAGENT_P4_CL', 'DSH_SUPERAGENT_SWARM_URL',
      'DSH_SUPERAGENT_SWARM_REVIEW']) expect(keys).toContain(key)
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('carry the configured port, depot, revision and Swarm URL, and a client per ticket', () => {
    const settings = settingsWith({ backend: 'p4', p4: { port: 'p4.example.com:1666', depot: '//depot/mainline',
      syncSpec: '@12345', swarmUrl: 'https://swarm.example.com' } })
    const variables = environmentOf({ deployment: testDeployment(), sources: noSources, settings,
      ticket: { id: 't1', name: 'fix-thing', directory: '/work/fix-thing' } })
    expect(valueOf(variables, 'DSH_SUPERAGENT_BACKEND')).toBe('p4')
    expect(valueOf(variables, 'DSH_SUPERAGENT_P4_PORT')).toBe('p4.example.com:1666')
    expect(valueOf(variables, 'DSH_SUPERAGENT_P4_DEPOT')).toBe('//depot/mainline')
    expect(valueOf(variables, 'DSH_SUPERAGENT_P4_SYNC')).toBe('@12345')
    expect(valueOf(variables, 'DSH_SUPERAGENT_SWARM_URL')).toBe('https://swarm.example.com')
    expect(valueOf(variables, 'DSH_SUPERAGENT_P4_CLIENT')).toBe('dsh-fix-thing')
  })
  it('leave the changelist and review empty until the worker records them', () => {
    const variables = environmentOf({ deployment: testDeployment(), sources: noSources,
      settings: settingsWith({ backend: 'p4' }), ticket: { id: 't1', name: 'fix-thing', directory: '/work/fix-thing' } })
    expect(valueOf(variables, 'DSH_SUPERAGENT_P4_CL')).toBe('')
    expect(valueOf(variables, 'DSH_SUPERAGENT_SWARM_REVIEW')).toBe('')
  })
  it('take the backend a ticket records over the deployment default', () => {
    // A ticket whose work belongs in the deployment's git source is launched with the git backend even when the
    // installation's configured backend is p4.
    const variables = environmentOf({ deployment: testDeployment(), sources: noSources, settings: settingsWith({ backend: 'p4' }),
      ticket: { id: 't1', name: 'fix-thing', directory: '/work/fix-thing', backend: 'git' } })
    expect(valueOf(variables, 'DSH_SUPERAGENT_BACKEND')).toBe('git')
  })
  it('omit the ticket variables, including the client, when no ticket is given', () => {
    const variables = environmentOf({ deployment: testDeployment(), sources: noSources, settings: settingsWith({ backend: 'p4' }) })
    expect(variables.map(variable => variable.key)).not.toContain('DSH_SUPERAGENT_P4_CLIENT')
  })
})

describe('p4 workspace', () => {
  it('names the client after the ticket through the configured template', () => {
    expect(p4Client('dsh-<name>', 'fix-thing')).toBe('dsh-fix-thing')
    expect(p4Client('sun_<name>_ws', 'a-b')).toBe('sun_a-b_ws')
  })
  it('maps the depot into the ticket directory and syncs the configured revision', () => {
    const command = p4Prepare()
    // The view maps the depot only through the variables, so no depot path is baked into the command.
    expect(command).toContain('"$DSH_SUPERAGENT_P4_DEPOT"')
    expect(command).toContain('"$DSH_SUPERAGENT_P4_CLIENT"')
    expect(command).toContain('$DSH_SUPERAGENT_P4_SYNC')
    expect(command).toContain('p4 -c "$DSH_SUPERAGENT_P4_CLIENT" client -i < "$spec"')
    expect(command).toContain('sync "$DSH_SUPERAGENT_P4_DEPOT/...$DSH_SUPERAGENT_P4_SYNC"')
    // Credentials are never named: p4 reads the installation's own ticket file.
    expect(command).not.toMatch(/P4PASSWD|P4TICKETS|--password/)
  })
  it('builds a stream client from the server\'s own template when a stream is configured, and never forces it', () => {
    const command = p4Prepare()
    // A stream depot refuses a hand-written view; the template carries the Host and Options its form trigger validates.
    expect(command).toContain('client -S "$DSH_SUPERAGENT_P4_STREAM" -o | sed')
    // A non-admin user may save its own client but not force one: `-f` is refused with "You don't have permission".
    expect(command).not.toContain('-f -i')
    // `@head` is not a valid sync path spec, so it means head and is left off.
    expect(command).toContain('"$DSH_SUPERAGENT_P4_SYNC" != "@head"')
  })
})

describe('p4 delivery instructions', () => {
  const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { rules: [] }, actor: { source: 'feishu', id: 'ou_a' }, scope: '' } } as never
  const accept = { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-thing', note: 'the typo' } as never
  it('tell a p4 worker to shelve, keep its edits, and after a person submits the changelist start a new one', () => {
    const settings = settingsWith({ backend: 'p4', workspaces: [{ id: 'sun', directory: 'E:/workspace' }] })
    const execution = ticketExecution(ticket, accept, settings, '/state')
    // The launch message composes the ticket's assignment with the delivery instructions of its environment.
    const assignment = execution.assignment + deliveryInstructions(execution.backend ?? 'git')
    expect(execution.backend).toBe('p4')
    expect(assignment).toContain('p4 shelve -c <CL>')
    // The revert that cleaned the shared tree after shelving is gone: the local edits stay for testing and the next round.
    expect(assignment).toContain('do not p4 revert')
    expect(assignment).not.toContain('so the shared tree is clean')
    // `describe` takes the changelist as an argument; `-c` is invalid there.
    expect(assignment).toContain('p4 describe -S <CL>')
    expect(assignment).not.toContain('p4 describe -S -c')
    // After a person submits, the follow-up syncs the files and continues in a new changelist.
    expect(assignment).toContain('start a new changelist')
    expect(assignment).toContain('Never reuse the submitted changelist')
    // The target recorded at accept chose the channel, so a p4 worker is not told to stop at P1 and ask for a move.
    expect(assignment).not.toContain('report blocked at P1')
  })
  it('leave the git assignment without the p4 flow', () => {
    const execution = ticketExecution(ticket, accept, settingsWith({}), '/state')
    const assignment = execution.assignment + deliveryInstructions(execution.backend ?? 'git')
    expect(assignment).toContain('the typo')
    expect(assignment).not.toContain('p4 shelve')
    expect(assignment).not.toContain('p4 revert')
    expect(deliveryInstructions('git')).toBe('')
  })
  it('record the resolved target and backend, so a git ticket under the p4 default gets no p4 instructions', () => {
    const execution = ticketExecution(ticket, accept, settingsWith({ backend: 'p4' }), '/state', 'git', 'acme/widgets')
    expect(execution.backend).toBe('git')
    expect(execution.target).toBe('acme/widgets')
    expect(execution.assignment + deliveryInstructions(execution.backend ?? 'git')).not.toContain('p4 shelve')
  })
  it('strip the old environment instructions when a ticket is moved, leaving what the accept wrote', () => {
    // A ticket accepted before the move carries the p4 instructions, and its shared-workspace rules, inside its assignment.
    const settings = settingsWith({ backend: 'p4', workspaces: [{ id: 'sun', directory: 'E:/workspace' }] })
    const old = 'the typo' + deliveryInstructions('p4') + sharingInstructions(settings, 'p4')
    expect(old).toContain('You share this workspace')
    expect(old).toContain('p4 shelve')
    expect(baseAssignment(old)).toBe('the typo')
    // A git assignment already has neither block, so it comes back unchanged.
    const git = ticketExecution(ticket, accept, settingsWith({}), '/state').assignment
    expect(baseAssignment(git)).toBe(git)
  })
})

