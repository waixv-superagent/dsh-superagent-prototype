/** The management routes of the local reproduction cases (docs/024): the list, the run, and the files a run wrote. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import type { ReproRun } from '../src/app/repro-runner.ts'

const T0 = '2026-11-05T01:00:00.000Z'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'repro-http-')); dirs.push(dir); return dir }

type Handler = (req: unknown, res: unknown) => Promise<void>
/** Mounts the management routes on a fake web server and returns the one prefix handler it registered. */
function mount(runtime: Partial<Record<keyof HttpHost, unknown>>): Handler {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return handler
}
/** Answers one JSON management request; the panel's own header is on by default. */
async function call(handler: Handler, method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}) {
  let status = 0, text = ''
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers })
    .filter(([, value]) => value !== undefined))
  const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
  await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data || '' } })
  return { status, body: text ? JSON.parse(text) as Record<string, unknown> : undefined }
}
/** A response a readable stream can pipe into, which records the head and the bytes. */
class Sink extends Writable {
  status = 0
  headers: Record<string, string> = {}
  body = Buffer.alloc(0)
  writeHead(code: number, headers: Record<string, string> = {}) { this.status = code; this.headers = headers }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.body = Buffer.concat([this.body, chunk]); done()
  }
}
/** Answers one file request under the raw path the panel opens a report in. */
async function file(handler: Handler, path: string, { method = 'GET', host = '127.0.0.1:3082' } = {}) {
  const req = { method, url: path, headers: { host } }
  const res = new Sink()
  await handler(req, res)
  await new Promise<void>(resolve => { const timer = setTimeout(resolve, 2_000); res.once('finish', () => { clearTimeout(timer); resolve() }) })
  return { status: res.status, headers: res.headers, body: res.body.toString('utf8') }
}

function harness() {
  const root = temp()
  mkdirSync(join(root, 'pivot', 'reports'), { recursive: true })
  writeFileSync(join(root, 'pivot', 'case.json'), JSON.stringify({ name: '急转', description: '镜头转动', command: 'py -3 run.py',
    report: 'reports/out.html' }))
  writeFileSync(join(root, 'pivot', 'reports', 'out.html'), '<html><body>ok</body></html>')
  writeFileSync(join(root, 'pivot', 'secret.txt'), 'secret')
  const runs: ReproRun[] = [{ id: 'r1', caseId: 'pivot', caseName: '急转', state: 'succeeded', startedAt: T0, endedAt: T0,
    exitCode: 0, summary: 'ok', report: 'reports/out.html', log: join(root, 'r1.log') }]
  const called: string[] = []
  const stopped: string[] = []
  const repro = {
    root: () => root,
    tick: () => runs,
    run: (id: string) => { called.push(id); return runs[0]! },
    stop: (id: string) => { stopped.push(id) },
    log: (id: string) => id === 'r1' ? 'step 1\nstep 2' : '',
  }
  return { root, runs, repro, called, stopped }
}

it('lists what the case directory holds and serves the output of a run', async () => {
  const { repro, root } = harness()
  const handler = mount({ repro, editorScheduler: { read: () => ({ lease: null }) } })
  const listed = await call(handler, 'GET', 'repro')
  expect(listed.status).toBe(200)
  expect(listed.body).toMatchObject({ root, problem: null, blocked: null, active: null,
    cases: [{ id: 'pivot', name: '急转', description: '镜头转动', command: 'py -3 run.py', report: 'reports/out.html' }] })
  const logged = await call(handler, 'GET', 'repro/log?run=r1')
  expect(logged).toEqual({ status: 200, body: { text: 'step 1\nstep 2' } })
})

it('runs a case for a person, but never while an agent or a host job holds the editor', async () => {
  const { repro, called, stopped } = harness()
  const handler = mount({ repro, editorScheduler: { read: () => ({ lease: { holder: { kind: 'person' } } }) } })
  expect(await call(handler, 'POST', 'repro/run', { case: 'pivot' })).toEqual({ status: 200, body: { started: true } })
  expect(called).toEqual(['pivot'])
  expect(await call(handler, 'POST', 'repro/stop', { run: 'r1' })).toEqual({ status: 200, body: { stopped: true } })
  expect(stopped).toEqual(['r1'])
  for (const [kind, code] of [['agent', 'reproBlockedAgent'], ['job', 'reproBlockedJob']] as const) {
    const blocked = mount({ repro, editorScheduler: { read: () => ({ lease: { holder: { kind } } }) } })
    expect(await call(blocked, 'POST', 'repro/run', { case: 'pivot' })).toMatchObject({ status: 400, body: { code } })
  }
  expect(called).toEqual(['pivot'])
})

it('serves a report inside its run\'s case folder only, and never over a foreign host', async () => {
  const { repro } = harness()
  const handler = mount({ repro })
  const report = await file(handler, '/orchestrator/repro/file/r1/reports/out.html')
  expect(report.status).toBe(200)
  expect(report.headers['content-type']).toBe('text/html; charset=utf-8')
  expect(report.headers['content-security-policy']).toBe('sandbox allow-scripts')
  expect(report.body).toContain('<body>ok</body>')
  // A sibling file inside the case folder is readable, since a report loads its relative assets from there.
  expect((await file(handler, '/orchestrator/repro/file/r1/secret.txt')).body).toBe('secret')
  for (const path of ['/orchestrator/repro/file/r1/%2E%2E%2Fsecret.txt', '/orchestrator/repro/file/none/reports/out.html']) {
    expect(await file(handler, path)).toMatchObject({ status: 404 })
  }
  expect(await file(handler, '/orchestrator/repro/file/r1/reports/out.html', { host: 'evil.example:3082' })).toMatchObject({ status: 404 })
  expect(await file(handler, '/orchestrator/repro/file/r1/reports/out.html', { method: 'POST' })).toMatchObject({ status: 405 })
})

it('answers a host without the runner as it answers any missing operation', async () => {
  const handler = mount({})
  expect(await call(handler, 'GET', 'repro')).toEqual({ status: 404, body: { error: 'This host has no local reproduction runner' } })
  expect(await call(handler, 'POST', 'repro/run', { case: 'pivot' }))
    .toEqual({ status: 404, body: { error: 'This host has no local reproduction runner' } })
  expect(await file(handler, '/orchestrator/repro/file/r1/reports/out.html')).toMatchObject({ status: 404 })
})

it('keeps a case id inside the length the directory listing can carry', async () => {
  const { repro } = harness()
  const handler = mount({ repro, editorScheduler: { read: () => ({ lease: null }) } })
  expect(await call(handler, 'POST', 'repro/run', { case: 'x'.repeat(200) })).toMatchObject({ status: 400 })
  expect(await call(handler, 'POST', 'repro/run', {})).toMatchObject({ status: 400 })
})
