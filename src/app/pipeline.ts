/** Read-only pipeline checks for a delivered change: Swarm testruns and AI review, and Jenkins console errors. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../policy.ts'

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
}

const TIMEOUT = 30_000
const MAX_ERRORS = 40
const TAIL_LINES = 60

/** Review id from an id or a review URL; throws instead of guessing. */
export function reviewIdOf (input: string): string {
  const text = input.trim()
  const fromUrl = /\/reviews\/(\d+)/.exec(text)?.[1]
  const id = fromUrl ?? (/^\d+$/.test(text) ? text : undefined)
  if (!id) throw new Error(`not a Swarm review id or URL: ${text}`)
  return id
}

/** Normalize a testruns payload; an unknown shape is an error, never a silent pass. */
export function summarizeTestruns (payload: unknown): PipelineTestruns {
  const runs = (payload as { data?: { testruns?: unknown } } | null)?.data?.testruns
  if (!Array.isArray(runs)) throw new Error('unexpected Swarm payload: data.testruns is not an array')
  const failures: PipelineTestrun[] = []
  const pending: PipelineTestrun[] = []
  let pass = 0
  for (const value of runs) {
    const run = (value ?? {}) as Record<string, unknown>
    const item: PipelineTestrun = {
      id: typeof run.id === 'string' || typeof run.id === 'number' ? run.id : null,
      title: String(run.title ?? '(untitled)'),
      status: String(run.status ?? '(unknown)'),
      url: run.url ? String(run.url) : null
    }
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

/** AI review verdict from a comments payload; null when the payload carries no verdict, never an approval. */
export function summarizeComments (payload: unknown): PipelineAi | null {
  if (!payload || typeof payload !== 'object') throw new Error('unexpected Swarm comments payload')
  const data = (payload as { data?: { comments?: unknown[] } }).data
  const comments = Array.isArray(data?.comments) ? data.comments : []
  const bodies = comments
    .map(comment => (comment && typeof comment === 'object' ? (comment as { body?: unknown }).body : undefined))
    .filter((body): body is string => typeof body === 'string' && body.trim() !== '')
  const strings = bodies.length > 0 ? bodies : collectStrings((payload as { data?: unknown }).data ?? payload)
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

  private async json (url: string, auth: string, what: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}` },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    if (response.status === 401 || response.status === 403) throw new Error(`${what} rejected the credentials (HTTP ${response.status})`)
    if (!response.ok) throw new Error(`${what} returned HTTP ${response.status} for ${url}`)
    return response.json()
  }

  /** Swarm testruns plus the AI review verdict; comments are optional and their failure is reported separately. */
  async status (review: string): Promise<PipelineStatus> {
    const base = this.p4.swarmUrl.trim()
    if (!base) throw new Error('Swarm URL is not configured; set executor.p4.swarmUrl first')
    const id = reviewIdOf(review)
    const { user, ticket } = this.credentials()
    const auth = `${user}:${ticket}`
    const api = `${base.replace(/\/$/, '')}${this.p4.reviewApi || '/api/v11'}/reviews/${id}`
    const testruns = summarizeTestruns(await this.json(`${api}/testruns`, auth, 'Swarm'))
    let ai: PipelineAi | null = null
    let aiError: string | undefined
    try {
      ai = summarizeComments(await this.json(`${api}/comments`, auth, 'Swarm'))
    } catch (error) {
      aiError = error instanceof Error ? error.message : String(error)
    }
    return { ...testruns, review: id, url: `${base.replace(/\/$/, '')}/reviews/${id}`, ai, ...(aiError ? { aiError } : {}) }
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
