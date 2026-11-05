/** Read-only pipeline checks for a delivered change: Swarm testruns and AI review, and Jenkins console errors. */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../policy.ts'
import type { PipelineChoices } from '../core/index.ts'

export interface PipelineTestrun {
  id: string | number | null
  title: string
  status: string
  url: string | null
}

export interface PipelineTestruns {
  verdict: 'pass' | 'fail' | 'running'
  total: number
  pass: number
  fail: number
  running: number
  failures: PipelineTestrun[]
  pending: PipelineTestrun[]
}

export interface PipelineAi {
  verdict: string | null
  approved: boolean
  advice: boolean
  commentCount: number | null
}

export interface PipelineStatus extends PipelineTestruns {
  review: string
  url: string | null
  ai: PipelineAi | null
  aiError?: string
}

/** What a rerun request triggered: the checks Swarm accepted, and those it left alone. */
export interface PipelineRerun {
  review: string
  triggered: PipelineTestrun[]
  skipped: PipelineTestrun[]
}

/** One review as Swarm reports it, before any testrun detail is read. */
export interface PipelineReview {
  id: string
  /** Swarm's review state, such as `needsReview`, `needsRevision`, `approved`, `committed`, or `archived`. */
  state: string
  stateLabel: string
  /** Swarm's aggregate check status for the current version: `pass`, `fail`, `running`, or empty when nothing ran yet. */
  testStatus: 'pass' | 'fail' | 'running' | 'none'
  /** The current review version; a reshelve with content opens the next one. */
  version: number
  /** The changelist the current version was cut from. */
  change: number | null
  /** When the current version was cut, in seconds since the epoch. */
  changedAt: number | null
  /** Changelists Swarm reports as committed for this review. */
  commits: number[]
}

/**
 * The Jenkins build of a review's pre-submit smoke. Swarm owns the review and its pre-approval checks, but the smoke run
 * after approval is a separate Jenkins job, so its build is read from Jenkins rather than from the review's testruns.
 */
export interface PipelineApprovalBuild {
  number: number
  url: string
  state: 'running' | 'passed' | 'failed'
  /** When the build started, in seconds since the epoch. */
  at: number | null
}

/** What a changelist looks like on the server: still pending, or gone because a submit renumbered it. */
export type ChangeState = 'pending' | 'submitted' | 'missing'

/** The editor autobuild that includes a submitted change, and the package link a person may forward. */
export interface PipelineAutobuild {
  number: number
  url: string
  state: 'running' | 'passed' | 'failed'
  /** The changelist the build was cut from, when its parameters name one. */
  change?: number
  artifact: string
}
/** Build parameter names, normalized, that carry the changelist an autobuild built. */
const CHANGE_PARAMS = ['changelist', 'change', 'cl', 'pchangelist', 'pchange', 'revision']

export interface JenkinsLog {
  job: string
  build: string
  url: string
  check?: string
  errors: string[]
  tail: string[]
  truncated: boolean
}

export interface PipelineChecksHost {
  settings: () => Settings
  env?: NodeJS.ProcessEnv
  home?: string
  fetchImpl?: typeof fetch
  /** Runs the p4 client for a changelist state check; tests inject one instead of touching the server. */
  run?: (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
}

const TIMEOUT = 30_000
const MAX_ERRORS = 40
const TAIL_LINES = 60

/** The choices a pipeline card offers from the p4 settings: reviewers to add on Swarm, and where a package may be sent. */
export const pipelineChoices = (settings: Settings): PipelineChoices => ({
  reviewers: settings.executor.p4.reviewers.map(item => ({ label: item.label, value: item.user })),
  targets: settings.executor.p4.autobuildTargets.map(item => ({ label: item.label, value: item.id })),
})

/** Review id from an id or a review URL; throws instead of guessing. */
export function reviewIdOf (input: string): string {
  const text = input.trim()
  const fromUrl = /\/reviews\/(\d+)/.exec(text)?.[1]
  const id = fromUrl ?? (/^\d+$/.test(text) ? text : undefined)
  if (!id) throw new Error(`not a Swarm review id or URL: ${text}`)
  return id
}

/** Normalize a testruns payload into its runs; an unknown shape is an error, never a silent pass. */
export function testrunItems (payload: unknown): PipelineTestrun[] {
  const runs = (payload as { data?: { testruns?: unknown } } | null)?.data?.testruns
  if (!Array.isArray(runs)) throw new Error('unexpected Swarm payload: data.testruns is not an array')
  return runs.map(value => {
    const run = (value ?? {}) as Record<string, unknown>
    return {
      id: typeof run.id === 'string' || typeof run.id === 'number' ? run.id : null,
      title: String(run.title ?? '(untitled)'),
      status: String(run.status ?? '(unknown)'),
      url: run.url ? String(run.url) : null
    }
  })
}

/** Normalize a testruns payload; an unknown shape is an error, never a silent pass. */
export function summarizeTestruns (payload: unknown): PipelineTestruns {
  const runs = testrunItems(payload)
  const failures: PipelineTestrun[] = []
  const pending: PipelineTestrun[] = []
  let pass = 0
  for (const item of runs) {
    if (item.status === 'pass') pass++
    else if (item.status === 'fail') failures.push(item)
    else pending.push(item)
  }
  return {
    verdict: failures.length > 0 ? 'fail' : pending.length > 0 ? 'running' : 'pass',
    total: runs.length,
    pass,
    fail: failures.length,
    running: pending.length,
    failures,
    pending
  }
}

function collectStrings (node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') into.push(node)
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, into)
  else if (node && typeof node === 'object') for (const value of Object.values(node)) collectStrings(value, into)
  return into
}

/**
 * AI review verdict from a comments payload; null when the payload carries no verdict, never an approval. Swarm tags each
 * AI comment with the review version it reviewed, so `version` keeps an old round's verdict from deciding the current one.
 */
export function summarizeComments (payload: unknown, version?: number): PipelineAi | null {
  if (!payload || typeof payload !== 'object') throw new Error('unexpected Swarm comments payload')
  const data = (payload as { data?: { comments?: unknown[] } }).data
  const comments = Array.isArray(data?.comments) ? data.comments : []
  const bodies = comments
    .map(comment => {
      const body = comment && typeof comment === 'object' ? (comment as { body?: unknown }).body : undefined
      const context = comment && typeof comment === 'object' ? (comment as { context?: { version?: unknown } }).context : undefined
      return { body, version: typeof context?.version === 'number' ? context.version : undefined }
    })
    .filter((item): item is { body: string; version: number | undefined } => typeof item.body === 'string' && item.body.trim() !== '')
  const versioned = bodies.filter(item => item.version !== undefined)
  // An old round's verdict must not decide a newer version: when Swarm tagged comments, only the current version (or one
  // without a tag) speaks for it. A version Swarm has not reviewed yet carries no verdict, never an approval.
  const eligible = version === undefined || versioned.length === 0 ? bodies
    : bodies.filter(item => item.version === undefined || item.version === version)
  const strings = eligible.length > 0 ? eligible.map(item => item.body)
    : bodies.length > 0 ? [] : collectStrings((payload as { data?: unknown }).data ?? payload)
  // The AI review comments are the ones that say what the review concluded. Keep the latest one; earlier rounds may still
  // carry a request for changes that a reshelve already answered.
  const candidates = strings.filter(text => /【AI】|审核结论|审核(?:通过|不通过|未通过)/.test(text))
  const body = candidates[candidates.length - 1] ?? strings[strings.length - 1]
  if (!body) return null
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const verdictLine = [...lines].reverse().find(line => /审核结论|审核(?:通过|不通过|未通过)/.test(line))
    ?? lines.find(line => /结果/.test(line))
  if (!verdictLine) return null
  const verdict = verdictLine.replace(/^[-*\s]+/, '').replace(/\*\*/g, '').trim()
  const approved = (/审核通过|通过✅/.test(verdict) || /[:：]\s*通过/.test(verdict)) && !/不通过|未通过/.test(verdict)
  return {
    verdict,
    approved,
    advice: /建议/.test(body) && !/无任何建议|无建议|无修改建议/.test(body),
    commentCount: comments.length > 0 ? comments.length : null
  }
}

/** Jenkins job and build from a testrun URL, in the Blue Ocean or the classic form. */
export function jenkinsTarget (input: string): { job: string; build: string } {
  const path = new URL(input).pathname
  const blue = /\/blue\/organizations\/jenkins\/([^/]+)\/detail\/[^/]+\/(\d+)(?:\/|$)/.exec(path)
  const classic = /\/job\/([^/]+)\/(\d+)(?:\/|$)/.exec(path)
  const match = blue ?? classic
  if (!match) throw new Error(`not a Jenkins build URL: ${input}`)
  return { job: decodeURIComponent(match[1]!), build: match[2]! }
}

/** The build parameters Jenkins reports for one build, flattened across its actions. */
function buildParameters (build: unknown): { name: string; value: string }[] {
  const actions = (build as { actions?: unknown } | null)?.actions
  if (!Array.isArray(actions)) return []
  const params: { name: string; value: string }[] = []
  for (const action of actions) {
    const values = (action as { parameters?: unknown } | null)?.parameters
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const name = (value as { name?: unknown } | null)?.name
      if (typeof name !== 'string') continue
      params.push({ name, value: String((value as { value?: unknown }).value ?? '') })
    }
  }
  return params
}

/** A parameter name normalized to the words Jenkins jobs use for the review and its changelist. */
const paramKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '')

function redact (text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text
}

function isErrorLine (line: string): boolean {
  const text = line.trim()
  if (!text || /(?:^|\s)0 errors?\b/i.test(text)) return false
  if (/\b(?:error|fatal error)\s*(?::|C\d+)/i.test(text)) return true
  if (/\b(?:FAILED|Test failed|Assertion failed|Unhandled exception)\b/i.test(text)) return true
  return false
}

/** Error lines and a bounded tail from a Jenkins consoleText, with any API token removed. */
export function parseJenkinsConsole (text: string, options: { token?: string; check?: string } = {}): { errors: string[]; tail: string[]; truncated: boolean } {
  const token = options.token ?? ''
  const lines = text.split(/\r?\n/).map(line => redact(line, token))
  const errors: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!isErrorLine(line)) continue
    const key = line.trim()
    if (seen.has(key)) continue
    seen.add(key)
    errors.push(key)
    if (errors.length >= MAX_ERRORS) break
  }
  return { errors, tail: lines.slice(-TAIL_LINES), truncated: lines.length > TAIL_LINES }
}

/** Reads Swarm and Jenkins with the executor's own credentials; secrets stay out of the worker and its prompt. */
export class PipelineChecks {
  constructor (private readonly host: PipelineChecksHost) {}

  private get p4 () { return this.host.settings().executor.p4 }
  private get fetchImpl () { return this.host.fetchImpl ?? fetch }
  private get env () { return this.host.env ?? process.env }

  private ticket (): { user?: string; ticket?: string } | undefined {
    const file = join(this.host.home ?? homedir(), 'p4tickets.txt')
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return undefined }
    const wanted = this.p4.port.replace(/^ssl:/i, '').split(':')[0]
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(':')
      if (parts.length < 3) continue
      const server = parts[0]!.replace(/^ssl:/i, '')
      if (wanted && server !== wanted) continue
      const middle = parts.slice(1, -1).join(':')
      const equals = middle.lastIndexOf('=')
      return { user: equals >= 0 ? middle.slice(equals + 1) : middle, ticket: parts[parts.length - 1] }
    }
    return undefined
  }

  private credentials (): { user: string; ticket: string } {
    const cached = this.ticket()
    const user = this.env.P4USER?.trim() || this.p4.user || cached?.user
    const ticket = this.env.P4TICKET?.trim() || cached?.ticket
    if (!user || !ticket) {
      throw new Error('Swarm needs a P4 ticket: set P4USER and P4TICKET in the host environment, or sign in with p4 so p4tickets.txt has one')
    }
    return { user, ticket }
  }

  private async json (url: string, auth: string, what: string, allow404 = false): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}` },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 404 && allow404) return null
    if (response.status === 401 || response.status === 403) throw new Error(`${what} rejected the credentials (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`${what} returned HTTP ${response.status} for ${url}`)
    return response.json()
  }

  /** A JSON POST that changes Swarm, such as asking a testrun to run again. */
  private async post (url: string, auth: string, what: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 401 || response.status === 403) throw new Error(`${what} rejected the credentials (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`${what} returned HTTP ${response.status} for ${url}`)
    return response.json().catch(() => null)
  }

  private swarm (review: string): { id: string; api: string; auth: string; url: string } {
    const base = this.p4.swarmUrl.trim()
    if (!base) throw new Error('Swarm URL is not configured; set executor.p4.swarmUrl first')
    const id = reviewIdOf(review)
    const { user, ticket } = this.credentials()
    return {
      id,
      api: `${base.replace(/\/$/, '')}${this.p4.reviewApi || '/api/v11'}/reviews/${id}`,
      auth: `${user}:${ticket}`,
      url: `${base.replace(/\/$/, '')}/reviews/${id}`
    }
  }

  /**
   * One review's state, aggregate check status and current version. A review Swarm no longer serves returns null, which is
   * what a submitted or deleted review looks like here; the changelist state then says which it was (see `changeState`).
   */
  async review (input: string): Promise<PipelineReview | null> {
    const { id, api, auth } = this.swarm(input)
    const payload = await this.json(api, auth, 'Swarm', true)
    if (payload === null) return null
    const raw = (payload as { data?: { reviews?: unknown[] } } | null)?.data?.reviews?.[0]
    if (!raw || typeof raw !== 'object') throw new Error('unexpected Swarm review payload: data.reviews is empty')
    const record = raw as Record<string, unknown>
    const versions = (Array.isArray(record.versions) ? record.versions : [])
      .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
    const last = versions[versions.length - 1]
    const rawStatus = String(record.testStatus ?? '')
    const testStatus = rawStatus === 'pass' || rawStatus === 'fail' || rawStatus === 'running' ? rawStatus : 'none'
    const commits = (Array.isArray(record.commits) ? record.commits : []).filter((value): value is number => typeof value === 'number')
    return {
      id,
      state: String(record.state ?? ''),
      stateLabel: String(record.stateLabel ?? record.state ?? ''),
      testStatus,
      version: versions.length,
      change: typeof last?.change === 'number' ? last.change : null,
      changedAt: typeof last?.time === 'number' ? last.time : null,
      commits
    }
  }

  /**
   * The Jenkins build of the review's pre-submit smoke, once the review is approved. Swarm triggers this job after an
   * approval but does not report it as a testrun, so the host reads the configured job and matches the build by its
   * `ReviewId` parameter (the job's `Changelist` is the archive change, not the delivered changelist). Null when the step is
   * disabled, unreadable, has no build for this review yet, or the job does not exist.
   */
  async approvalBuild (input: string, changelist?: number): Promise<PipelineApprovalBuild | null> {
    const job = this.p4.postApprovalJob.trim()
    const base = this.p4.jenkinsUrl.trim()
    const token = this.p4.jenkinsToken.trim()
    if (!job || !base || !token) return null
    const id = reviewIdOf(input)
    const user = this.p4.jenkinsUser.trim() || this.p4.user.trim() || this.env.P4USER?.trim()
    if (!user) throw new Error('Jenkins user is not configured; set executor.p4.jenkinsUser or executor.p4.user')
    const url = `${base.replace(/\/$/, '')}/job/${encodeURIComponent(job)}/api/json?tree=builds[number,url,timestamp,result,actions[parameters[name,value]]]{0,30}&depth=1`
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) throw new Error(`Jenkins rejected the credentials (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`Jenkins returned HTTP ${response.status} for ${url}`)
    const body = await response.json() as { builds?: unknown }
    const builds = Array.isArray(body.builds) ? body.builds : []
    const reviewed = builds.filter(build => buildParameters(build).some(param => ['review', 'reviewid'].includes(paramKey(param.name))))
    const pool = reviewed.length
      ? reviewed.filter(build => buildParameters(build).some(param => ['review', 'reviewid'].includes(paramKey(param.name))
        && param.value.trim() === id))
      : changelist === undefined ? [] : builds.filter(build => buildParameters(build).some(param =>
        ['changelist', 'change', 'cl'].includes(paramKey(param.name)) && param.value.trim() === String(changelist)))
    const chosen = pool.sort((left, right) => {
      const a = left as { number?: unknown; timestamp?: unknown }
      const b = right as { number?: unknown; timestamp?: unknown }
      return (typeof b.number === 'number' ? b.number : 0) - (typeof a.number === 'number' ? a.number : 0)
        || (typeof b.timestamp === 'number' ? b.timestamp : 0) - (typeof a.timestamp === 'number' ? a.timestamp : 0)
    })[0] as { number?: unknown; url?: unknown; timestamp?: unknown; result?: unknown } | undefined
    if (!chosen || typeof chosen.number !== 'number') return null
    const result = typeof chosen.result === 'string' ? chosen.result : null
    return {
      number: chosen.number,
      url: typeof chosen.url === 'string' && chosen.url
        ? chosen.url : `${base.replace(/\/$/, '')}/job/${encodeURIComponent(job)}/${chosen.number}/`,
      state: result === null ? 'running' : result === 'SUCCESS' ? 'passed' : 'failed',
      at: typeof chosen.timestamp === 'number' ? Math.floor(chosen.timestamp / 1000) : null
    }
  }

  /**
   * The editor autobuild that includes a submitted change. The configured job's builds are read newest first; a build whose
   * changelist parameter is at or after `change` includes it, and the earliest such build is the one to follow. A job whose
   * builds carry no changelist parameter is matched by time instead: the first build that started after the submit. Null
   * when the step is disabled or unreadable, or no build includes the change yet.
   */
  async autobuildBuild (submit: { change?: number; at: number }): Promise<PipelineAutobuild | null> {
    const job = this.p4.autobuildJob.trim()
    const base = this.p4.jenkinsUrl.trim()
    const token = this.p4.jenkinsToken.trim()
    if (!job || !base || !token) return null
    const user = this.p4.jenkinsUser.trim() || this.p4.user.trim() || this.env.P4USER?.trim()
    if (!user) throw new Error('Jenkins user is not configured; set executor.p4.jenkinsUser or executor.p4.user')
    const root = base.replace(/\/$/, '')
    const url = `${root}/job/${encodeURIComponent(job)}/api/json?tree=builds[number,url,timestamp,result,actions[parameters[name,value]]]{0,30}&depth=1`
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 404) return null
    if (response.status === 401 || response.status === 403) throw new Error(`Jenkins rejected the credentials (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`Jenkins returned HTTP ${response.status} for ${url}`)
    const body = await response.json() as { builds?: unknown }
    const builds = (Array.isArray(body.builds) ? body.builds : [])
      .filter((build): build is { number: number; url?: unknown; timestamp?: unknown; result?: unknown } =>
        !!build && typeof build === 'object' && typeof (build as { number?: unknown }).number === 'number')
    const changeOf = (build: unknown): number | undefined => {
      const value = buildParameters(build).find(param => CHANGE_PARAMS.includes(paramKey(param.name)))?.value.trim()
      return value && /^\d+$/.test(value) ? Number(value) : undefined
    }
    const counted = builds.some(build => changeOf(build) !== undefined)
    const including = builds.filter(build => {
      if (counted && submit.change !== undefined) {
        const change = changeOf(build)
        return change !== undefined && change >= submit.change
      }
      return typeof build.timestamp === 'number' && build.timestamp >= submit.at
    })
    // The earliest build that includes the change answers whether it built; a later one would hide a failure.
    const chosen = including.sort((a, b) => a.number - b.number)[0]
    if (!chosen) return null
    const page = typeof chosen.url === 'string' && chosen.url ? chosen.url : `${root}/job/${encodeURIComponent(job)}/${chosen.number}/`
    const result = typeof chosen.result === 'string' ? chosen.result : null
    const change = changeOf(chosen)
    const template = this.p4.autobuildArtifact.trim()
    const artifact = template
      ? template.replaceAll('<build>', String(chosen.number)).replaceAll('<cl>', change === undefined ? '' : String(change)).replaceAll('<url>', page)
      : page
    return { number: chosen.number, url: page, state: result === null ? 'running' : result === 'SUCCESS' ? 'passed' : 'failed',
      ...(change !== undefined ? { change } : {}), artifact }
  }

  /**
   * Add people to a review as required reviewers, as a person chose on its card. Swarm appends them to the existing
   * participants; a refusal is reported with Swarm's own message rather than retried.
   */
  async addReviewers (input: string, users: readonly string[]): Promise<string[]> {
    const { id, api, auth } = this.swarm(input)
    const wanted = [...new Set(users.map(user => user.trim()).filter(Boolean))]
    if (!wanted.length) throw new Error('no reviewer chosen')
    const response = await this.fetchImpl(`${api}/participants`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ participants: { users: Object.fromEntries(wanted.map(user => [user, { required: 'yes' }])) } }),
      signal: AbortSignal.timeout(TIMEOUT)
    })
    const answer = await response.json().catch(() => null) as { error?: unknown; messages?: { text?: unknown }[] } | null
    const said = answer?.messages?.map(message => String(message?.text ?? '')).filter(Boolean).join('; ')
    if (!response.ok || answer?.error) throw new Error(`Swarm refused to add reviewers to review ${id}${said ? `: ${said}` : ` (HTTP ${response.status})`}`)
    return wanted
  }

  /**
   * What happened to a changelist: still pending, already a submitted changelist number, or missing because a submit deleted
   * the pending number. Submitting a shelf creates a submitted changelist under a new number, so the pending one disappears.
   */
  async changeState (change: number): Promise<ChangeState> {
    const result = await this.p4Run(['describe', '-S', String(change)])
    const text = `${result.stdout}\n${result.stderr}`
    if (result.code === 0) return /\*pending\*/i.test(result.stdout) ? 'pending' : 'submitted'
    if (/no such changelist/i.test(text)) return 'missing'
    throw new Error(`p4 describe -S ${change} failed: ${text.trim().split(/\r?\n/)[0] ?? `exit ${result.code}`}`)
  }

  private p4Run (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const port = this.p4.port.trim() || this.env.P4PORT?.trim()
    const user = this.p4.user.trim() || this.env.P4USER?.trim()
    const argv = [...port ? ['-p', port] : [], ...user ? ['-u', user] : [], ...args]
    if (this.host.run) return this.host.run('p4', argv, TIMEOUT)
    return new Promise(resolve => {
      execFile('p4', argv, { timeout: TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
  }

  /** Swarm testruns plus the AI review verdict; comments are optional and their failure is reported separately. */
  async status (review: string, version?: number): Promise<PipelineStatus> {
    const { id, api, auth, url } = this.swarm(review)
    const testruns = summarizeTestruns(await this.json(`${api}/testruns`, auth, 'Swarm'))
    let ai: PipelineAi | null = null
    let aiError: string | undefined
    try {
      ai = summarizeComments(await this.json(`${api}/comments`, auth, 'Swarm'), version)
    } catch (error) {
      aiError = error instanceof Error ? error.message : String(error)
    }
    return { ...testruns, review: id, url, ai, ...(aiError ? { aiError } : {}) }
  }

  /**
   * Ask Swarm to rerun checks of the current version, without a new version or a reshelve. With no `tests`, the failing
   * checks are rerun; a title or testrun id selects specific ones. Swarm answers with the testrun now in `running`.
   */
  async rerun (input: string, tests: readonly string[] = []): Promise<PipelineRerun> {
    const { id, api, auth } = this.swarm(input)
    const runs = testrunItems(await this.json(`${api}/testruns`, auth, 'Swarm'))
    const wanted = tests.map(test => test.trim()).filter(Boolean)
    const chosen = wanted.length
      ? runs.filter(run => wanted.some(test => String(run.id) === test || run.title === test || run.title.includes(test)))
      : runs.filter(run => run.status === 'fail')
    if (!chosen.length) {
      throw new Error(wanted.length
        ? `Swarm has no testrun matching ${wanted.join(', ')} on review ${id}`
        : `Swarm reports no failing check on review ${id}`)
    }
    for (const run of chosen) {
      if (run.id === null) throw new Error(`Swarm testrun "${run.title}" has no id to rerun`)
      const answer = await this.post(`${api}/testruns/${run.id}/run`, auth, `Swarm rerun of ${run.title}`) as { error?: unknown } | null
      if (answer?.error) throw new Error(`Swarm refused to rerun ${run.title}: ${JSON.stringify(answer.error)}`)
    }
    return { review: id, triggered: chosen, skipped: runs.filter(run => !chosen.includes(run)) }
  }

  /** Jenkins consoleText for a failed testrun; the token is used for Basic auth and redacted from the result. */
  async jenkins (input: string, check?: string): Promise<JenkinsLog> {
    const token = this.p4.jenkinsToken.trim()
    if (!token) throw new Error('Jenkins API token is not configured; set executor.p4.jenkinsToken first')
    const user = this.p4.jenkinsUser.trim() || this.p4.user.trim() || this.env.P4USER?.trim()
    if (!user) throw new Error('Jenkins user is not configured; set executor.p4.jenkinsUser or executor.p4.user')
    const { job, build } = jenkinsTarget(input)
    const parsed = new URL(input)
    const base = (this.p4.jenkinsUrl.trim() || parsed.origin).replace(/\/$/, '')
    const url = `${base}/job/${encodeURIComponent(job)}/${build}/consoleText`
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 401 || response.status === 403) throw new Error(`Jenkins rejected the credentials (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`Jenkins returned HTTP ${response.status} for ${url}`)
    const { errors, tail, truncated } = parseJenkinsConsole(await response.text(), { token, check })
    return { job, build, url, ...(check ? { check } : {}), errors, tail, truncated }
  }
}
