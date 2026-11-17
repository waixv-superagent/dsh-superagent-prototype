/** The package's test script runs again only the files whose vitest workers did not start. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUNDS, filesWithoutWorkers, testRunOutcome } from '../scripts/test-suite.mjs'

const poolFailure = ['⎯⎯ Unhandled Error ⎯⎯',
  'Error: [vitest-pool]: Failed to start forks worker for test files C:/x/tests/panel-trigger.spec.tsx.',
  'Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond'].join('\n')

/** A vitest entry whose first (whole-suite) run fails to start two workers and whose second run records the files it got. */
const fakeVitest = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args.length > 1) {
  writeFileSync(join(process.cwd(), 'ran.txt'), args.slice(1).join('\\n'))
  process.exit(0)
}
console.error('Error: [vitest-pool]: Failed to start forks worker for test files ' +
  join(process.cwd(), 'tests', 'a.spec.ts') + ', ' + join(process.cwd(), 'tests', 'b.spec.tsx') + '.')
process.exit(1)
`

describe('test script', () => {
  it('tells a test failure from workers that did not start', () => {
    expect(testRunOutcome(poolFailure)).toBe('pool')
    expect(testRunOutcome(' FAIL  tests/a.spec.ts > fails\nAssertionError: expected 1 to be 2')).toBe('test')
    // The reporter colors its failure lines; the escape codes do not hide them from the decision.
    expect(testRunOutcome('\u001b[31m FAIL \u001b[39m tests/a.spec.ts > fails')).toBe('test')
    // A real test failure is not retried even when an unrelated worker also failed to start.
    expect(testRunOutcome(`${poolFailure}\n FAIL  tests/a.spec.ts > fails`)).toBe('test')
    expect(testRunOutcome('Error: something else')).toBe('other')
    expect(ROUNDS).toBeGreaterThan(1)
  })
  it('names the test files vitest could not start, also when it names several on one line', () => {
    const output = ['\u001b[31mError: [vitest-pool]: Failed to start forks worker for test files C:/x/tests/panel-trigger.spec.tsx.\u001b[39m',
      'Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond',
      'Error: [vitest-pool]: Failed to start forks worker for test files C:/x/tests/a.spec.ts, C:/x/tests/b.spec.tsx.'].join('\n')
    expect(filesWithoutWorkers(output)).toEqual(['C:/x/tests/panel-trigger.spec.tsx', 'C:/x/tests/a.spec.ts', 'C:/x/tests/b.spec.tsx'])
    expect(filesWithoutWorkers('No start failure here')).toEqual([])
  })
  it('runs again only the files whose workers did not start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-suite-'))
    try {
      mkdirSync(join(dir, 'node_modules', 'vitest'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'vitest', 'vitest.mjs'), fakeVitest)
      const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'test-suite.mjs')], { cwd: dir, encoding: 'utf8' })
      expect(result.status).toBe(0)
      const ran = readFileSync(join(dir, 'ran.txt'), 'utf8').split(/\r?\n/).map(file => file.replaceAll('\\', '/'))
      expect(ran).toEqual(['tests/a.spec.ts', 'tests/b.spec.tsx'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
