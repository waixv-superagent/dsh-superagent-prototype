import { describe, expect, it } from 'vitest'
import { checkLines } from '../src/client/text.ts'

const states = (text: string) => checkLines(text).map(line => line.state)

describe('checkLines', () => {
  it('reads an exit code and a full test ratio as a check that passed', () => {
    expect(states('pnpm typecheck exit 0')).toEqual(['pass'])
    expect(states('pnpm build exit code 0 (Build complete in 1758ms)')).toEqual(['pass'])
    expect(states('pnpm exec vitest run tests/core-engine.spec.ts = 150/150')).toEqual(['pass'])
    expect(states('pnpm typecheck: 0 errors')).toEqual(['pass'])
    expect(states('pnpm build: Build complete in 1774ms')).toEqual(['pass'])
    expect(states('pnpm exec vitest run: 1379 passed, 22 skipped, 0 failed')).toEqual(['pass'])
  })

  it('does not turn a clean zero-failure count into a failure', () => {
    expect(states('Automation 1/2 failed')).toEqual(['fail'])
    expect(states('Build Result: Failed')).toEqual(['fail'])
    expect(states('22 skipped / 0 failed')).toEqual(['skip'])
  })

  it('keeps a recorded fact apart from a check that was skipped', () => {
    expect(states('p4 shelve -f -c 581411：5 个文件 shelve')).toEqual(['note'])
    expect(states('P4_Check 未运行')).toEqual(['skip'])
    expect(states('Swarm review 581502 testruns 11/11 pass')).toEqual(['pass'])
  })
})
