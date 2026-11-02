import { expect, it } from 'vitest'
import { PipelineChecks, jenkinsTarget, parseJenkinsConsole, reviewIdOf, summarizeComments, summarizeTestruns } from '../src/app/pipeline.ts'
import { SettingsSchema } from '../src/policy.ts'

const settings = (p4: Record<string, unknown> = {}) => SettingsSchema.parse({ executor: { backend: 'p4', p4: {
  swarmUrl: 'https://swarm.example.com', reviewApi: '/api/v10', user: 'agent', ...p4 } } })

const response = (body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  json: async () => body,
  text: async () => init.text ?? ''
}) as unknown as Response

it('reads a review id or URL and a Blue Ocean or classic Jenkins target', () => {
  expect(reviewIdOf('416666')).toBe('416666')
  expect(reviewIdOf('https://swarm.example.com/reviews/416666/files')).toBe('416666')
  expect(() => reviewIdOf('not-a-review')).toThrow(/review id/)
  expect(jenkinsTarget('https://ci.example.com/blue/organizations/jenkins/PreApproval-ClangTidy/detail/PreApproval-ClangTidy/22610/pipeline'))
    .toEqual({ job: 'PreApproval-ClangTidy', build: '22610' })
  expect(jenkinsTarget('https://ci.example.com/job/Entry/9001/')).toEqual({ job: 'Entry', build: '9001' })
})

it('summarizes testruns and the AI verdict without turning an unknown shape into a pass', () => {
  const runs = summarizeTestruns({ data: { testruns: [
    { id: 1, title: 'Build', status: 'pass' },
    { id: 2, title: 'ClangTidy', status: 'fail', url: 'https://ci.example.com/job/ClangTidy/7/' },
    { id: 3, title: 'Tests', status: 'running' }
  ] } })
  expect(runs).toMatchObject({ verdict: 'fail', total: 3, pass: 1, fail: 1, running: 1 })
  expect(runs.failures[0]).toMatchObject({ title: 'ClangTidy' })
  expect(() => summarizeTestruns({})).toThrow(/testruns/)
  expect(summarizeComments({ data: { comments: [{ body: '审核结论：通过' }] } }))
    .toMatchObject({ verdict: '审核结论：通过', approved: true, advice: false, commentCount: 1 })
  expect(summarizeComments({ data: { comments: [
    { body: '【AI】\n- **结果**: 审核通过✅\n- **建议**: 无任何建议修改或优化' }
  ] } })).toMatchObject({ verdict: '结果: 审核通过✅', approved: true, advice: false, commentCount: 1 })
  expect(summarizeComments({ data: { comments: [{ body: '没有结论' }] } })).toBeNull()
})

it('keeps console errors, drops noise, and redacts the API token', () => {
  const text = [
    '/src/a.cpp:10:3: error: use of undeclared identifier x [clang-diagnostic-error,-warnings-as-errors]',
    '0 errors',
    'token=supersecret',
    '[  FAILED  ] Foo.Bar',
    'Build finished'
  ].join('\n')
  const parsed = parseJenkinsConsole(text, { token: 'supersecret', check: 'ClangTidy' })
  expect(parsed.errors).toHaveLength(2)
  expect(parsed.errors[0]).toContain('use of undeclared identifier')
  expect(parsed.errors[1]).toContain('FAILED')
  expect(parsed.tail.join('\n')).not.toContain('supersecret')
  expect(parsed.tail.join('\n')).toContain('token=***')
})

it('reads Swarm testruns and comments with the P4 ticket, and reports comments failures separately', async () => {
  const calls: { url: string; auth?: string }[] = []
  const checks = new PipelineChecks({ settings: () => settings(), env: { P4USER: 'u', P4TICKET: 't' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization })
      if (String(url).endsWith('/comments')) return response({ error: 'forbidden' }, { ok: false, status: 403 })
      return response({ data: { testruns: [{ id: 1, title: 'Build', status: 'pass' }] } })
    } })
  const status = await checks.status('https://swarm.example.com/reviews/416666')
  expect(status).toMatchObject({ review: '416666', verdict: 'pass', pass: 1, ai: null })
  expect(status.aiError).toMatch(/403/)
  expect(calls[0]?.url).toBe('https://swarm.example.com/api/v10/reviews/416666/testruns')
  expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('u:t').toString('base64')}`)
})

it('reads Jenkins consoleText with the configured token and never returns the token', async () => {
  let seen: { url: string; auth?: string } | undefined
  const checks = new PipelineChecks({ settings: () => settings({ jenkinsUrl: 'https://ci.example.com', jenkinsUser: 'ci',
    jenkinsToken: 'supersecret' }), env: { P4USER: 'u', P4TICKET: 't' },
    fetchImpl: async (url, init) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization }
      return response(null, { text: 'x.cpp:1:1: error: boom\nsupersecret\n' })
    } })
  const log = await checks.jenkins('https://jenkins.example.com/blue/organizations/jenkins/Build/detail/Build/42/pipeline')
  expect(seen?.url).toBe('https://ci.example.com/job/Build/42/consoleText')
  expect(seen?.auth).toBe(`Basic ${Buffer.from('ci:supersecret').toString('base64')}`)
  expect(log.errors.join('\n')).toContain('boom')
  expect(JSON.stringify(log)).not.toContain('supersecret')
})

it('refuses Jenkins when no token is configured, and refuses Swarm without a P4 ticket', async () => {
  const noToken = new PipelineChecks({ settings: () => settings(), env: { P4USER: 'u' }, fetchImpl: async () => response({}) })
  await expect(noToken.jenkins('https://ci.example.com/job/Build/1/')).rejects.toThrow(/token is not configured/)
  const noTicket = new PipelineChecks({ settings: () => settings(), env: {}, home: 'Z:\\nowhere', fetchImpl: async () => response({}) })
  await expect(noTicket.status('1')).rejects.toThrow(/P4 ticket/)
})
