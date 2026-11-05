/** Tests for scripts/repro-ab.mjs: manifest validation, the differential expectations, the CLI end to end, the report and init. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AB_DIR, evaluateExpectations, parseAbManifest, renderReport, runSelfTest } from '../scripts/repro-ab.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'repro-ab.mjs')
const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath
let dirs: string[] = []
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = [] })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'repro-ab-')); dirs.push(dir); return dir }
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const PROBE = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.REPRO_RUN_DIR
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'observation.json'), JSON.stringify({ state: 'idle', metrics: { slide: process.env.REPRO_ARM === 'A' ? 7.8 : 0.42, fps: 59.2 } }))
writeFileSync(join(dir, 'trace.json'), JSON.stringify({ arm: process.env.REPRO_ARM }))
`

/** A case folder with a probe and a manifest; `probe` and `manifest` are overridable so one helper serves every scenario. */
function makeCase(probe = PROBE, manifest: Record<string, unknown> = {}) {
  const dir = temp()
  writeFileSync(join(dir, 'probe.mjs'), probe)
  writeFileSync(join(dir, 'ab.json'), json({ version: 1, probe: `${NODE} probe.mjs`, observation: 'observation.json',
    timeoutSeconds: 30, repeat: 1, tolerance: 0.1, relativeTolerance: 0,
    expect: [{ path: 'metrics.slide', op: 'decrease', min: 3 }, { path: 'metrics.fps', op: 'unchanged', tolerance: 1 }], ...manifest }))
  return dir
}
const cli = (args: string[], cwd: string): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'))

describe('ab.json', () => {
  it('normalizes defaults and per-arm commands', () => {
    const manifest = parseAbManifest({ probe: 'run.sh', arms: { A: 'old.sh', B: 'new.sh' }, expect: [{ path: 'a.b', op: 'changed' }] })
    expect(manifest).toMatchObject({ version: 1, probe: 'run.sh', arms: { A: 'old.sh', B: 'new.sh' }, observation: 'observation.json',
      timeoutSeconds: 900, repeat: 1, tolerance: 0, relativeTolerance: 0 })
    expect(manifest.expect[0]).toEqual({ path: 'a.b', op: 'changed' })
  })
  it('refuses unknown keys instead of silently dropping assertions', () => {
    expect(() => parseAbManifest({ probes: 'run.sh' })).toThrow(/未知字段 "probes"/)
    expect(() => parseAbManifest({ probe: 'run.sh', expect: [{ path: 'a', op: 'changed', typo: 1 }] })).toThrow(/未知字段 "typo"/)
  })
  it('refuses a bad op, a missing equals value and an escaping observation path', () => {
    expect(() => parseAbManifest({ probe: 'x', expect: [{ path: 'a', op: 'looksBetter' }] })).toThrow(/op 必须是/)
    expect(() => parseAbManifest({ probe: 'x', expect: [{ path: 'a', op: 'equals' }] })).toThrow(/需要 value/)
    expect(() => parseAbManifest({ probe: 'x', observation: '../o.json' })).toThrow(/相对路径/)
    expect(() => parseAbManifest({ probe: 'x', repeat: 9 })).toThrow(/repeat/)
  })
})

describe('differential expectations', () => {
  const evaluate = (op: string, a: unknown, b: unknown, extra: Record<string, unknown> = {}) =>
    evaluateExpectations([{ path: 'v', op: op as never, ...extra }], { v: a }, { v: b })[0]!
  it('passes a decrease above the minimum and fails one below it', () => {
    expect(evaluate('decrease', 7.8, 0.42, { min: 3 })).toMatchObject({ status: 'pass' })
    expect(evaluate('decrease', 1, 0.9, { min: 0.5 })).toMatchObject({ status: 'fail' })
  })
  it('treats changed and unchanged with the tolerance', () => {
    expect(evaluate('changed', 1, 1.05, { tolerance: 0.1 })).toMatchObject({ status: 'fail' })
    expect(evaluate('changed', 1, 1.2, { tolerance: 0.1 })).toMatchObject({ status: 'pass' })
    expect(evaluate('unchanged', 1, 1.05, { tolerance: 0.1 })).toMatchObject({ status: 'pass' })
    expect(evaluate('unchanged', 1, 1.2, { tolerance: 0.1 })).toMatchObject({ status: 'fail' })
  })
  it('supports equals, within and relative tolerance', () => {
    expect(evaluate('equals', 'idle', 'idle', { value: 'idle' })).toMatchObject({ status: 'pass' })
    expect(evaluate('equals', 59.2, 59.4, { value: 59.2, tolerance: 0.5 })).toMatchObject({ status: 'pass' })
    expect(evaluate('within', 10, 10.4, { value: 0.5 })).toMatchObject({ status: 'pass' })
    expect(evaluate('within', 10, 10.6, { value: 0.5 })).toMatchObject({ status: 'fail' })
    expect(evaluateExpectations([{ path: 'v', op: 'unchanged', relativeTolerance: 0.01 }], { v: 100 }, { v: 100.5 })[0])
      .toMatchObject({ status: 'pass' })
  })
  it('is incomplete when a field is missing or not comparable, never a pass', () => {
    expect(evaluateExpectations([{ path: 'missing', op: 'changed' }], { v: 1 }, { v: 1 })[0]).toMatchObject({ status: 'incomplete' })
    expect(evaluate('increase', 'high', 2)).toMatchObject({ status: 'incomplete' })
  })
})

describe('CLI', () => {
  it('records A and B, compares them and writes a self-contained report', () => {
    const dir = makeCase()
    expect(cli(['run', '.', '--arm', 'A', '--label', 'baseline'], dir).status).toBe(0)
    expect(cli(['run', '.', '--arm', 'B', '--label', 'fix'], dir).status).toBe(0)
    const compared = cli(['compare', '.'], dir)
    expect(compared.status).toBe(0)
    expect(compared.stdout).toContain('判定：通过')
    const report = readFileSync(join(dir, AB_DIR, 'report.html'), 'utf8')
    expect(report).toContain('A · baseline')
    expect(report).toContain('B · candidate')
    expect(report).toContain('trace.json')
    expect(report).toContain('metrics.slide')
    expect(readJson(join(dir, AB_DIR, 'result.json')).verdict).toBe('pass')
  })
  it('returns 2 when an assertion does not hold', () => {
    const dir = makeCase(PROBE, { expect: [{ path: 'metrics.slide', op: 'unchanged' }] })
    expect(cli(['run', '.', '--arm', 'A'], dir).status).toBe(0)
    expect(cli(['run', '.', '--arm', 'B'], dir).status).toBe(0)
    const compared = cli(['compare', '.'], dir)
    expect(compared.status).toBe(2)
    expect(compared.stdout).toContain('判定：不通过')
  })
  it('returns 3 without a baseline or without an observation, and still writes a report', () => {
    const noBaseline = makeCase()
    expect(cli(['replay', '.'], noBaseline).status).toBe(3)
    expect(existsSync(join(noBaseline, AB_DIR, 'report.html'))).toBe(true)
    expect(readFileSync(join(noBaseline, AB_DIR, 'report.html'), 'utf8')).toContain('还没有 baseline')

    const silent = makeCase('process.exit(0)')
    expect(cli(['run', '.', '--arm', 'A'], silent).status).toBe(3)
    expect(cli(['run', '.', '--arm', 'B'], silent).status).toBe(3)
    expect(cli(['compare', '.'], silent).status).toBe(3)
  })
  it('reads a manifest with a UTF-8 BOM and keeps UTF-8 output', () => {
    const dir = makeCase()
    writeFileSync(join(dir, 'ab.json'), `\uFEFF${readFileSync(join(dir, 'ab.json'), 'utf8')}`)
    expect(cli(['run', '.', '--arm', 'A'], dir).status).toBe(0)
  })
  it('treats repeated runs that disagree as incomplete', () => {
    const probe = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.REPRO_RUN_DIR
const value = Number(process.env.REPRO_ATTEMPT) === 1 ? 0.42 : 0.1
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'observation.json'), JSON.stringify({ metrics: { slide: process.env.REPRO_ARM === 'A' ? 7.8 : value, fps: 59.2 } }))
`
    const dir = makeCase(probe, { repeat: 2, expect: [{ path: 'metrics.slide', op: 'decrease', min: 3 }] })
    expect(cli(['run', '.', '--arm', 'A'], dir).status).toBe(0)
    expect(cli(['replay', '.'], dir).status).toBe(3)
    expect(readFileSync(join(dir, AB_DIR, 'report.html'), 'utf8')).toContain('重复运行不一致')
  })
  it('init creates a harness snapshot, a template manifest and the panel entry', () => {
    const dir = temp()
    const init = cli(['init', '.', '--probe', `${NODE} probe.mjs`, '--name', '演示'], dir)
    expect(init.status).toBe(0)
    expect(existsSync(join(dir, AB_DIR, 'harness.mjs'))).toBe(true)
    const manifest = readJson(join(dir, AB_DIR, 'ab.json'))
    expect(manifest).toMatchObject({ version: 1, probe: `${NODE} probe.mjs`, observation: 'observation.json', expect: [] })
    const entry = readJson(join(dir, 'case.json'))
    expect(entry).toMatchObject({ name: '演示', command: `node ${AB_DIR}/harness.mjs replay`, report: `${AB_DIR}/report.html` })
  })
})

describe('report', () => {
  it('escapes case names and notes instead of rendering HTML', () => {
    const html = renderReport({ version: 'test', generatedAt: '2026-11-06T00:00:00.000Z',
      case: { name: '<script>alert(1)</script>', description: '', dir: 'C:/case' },
      manifest: { expect: [], notes: '<img src=x onerror=alert(1)>' },
      comparison: { verdict: 'incomplete', reasons: ['<b>not html</b>'], baseline: null, candidate: null,
        attempts: { baseline: 0, candidate: 0, perAttempt: [] }, fields: [], expectations: [], repeat: [], flaky: [], expect: [] } })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;')
  })
  it('passes its own end-to-end self-test', async () => {
    await expect(runSelfTest()).resolves.toBe(true)
  })
})
