// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PlanDiffView } from '../src/client/diff.tsx'
import { zh } from '../src/client/locales.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { parsePlanDiff, type PlanDiff } from '../src/core/diff.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: string, values?: Record<string, unknown>) => {
  const text = (zh as Record<string, string>)[key] ?? key
  return values ? text.replace(/\{(\w+)\}/gu, (_, name: string) => String(values[name] ?? '')) : text
}) as never
const DIFF = [
  'diff --git a/Source/SkillRotateAPI.cpp b/Source/SkillRotateAPI.cpp',
  '--- a/Source/SkillRotateAPI.cpp',
  '+++ b/Source/SkillRotateAPI.cpp',
  '@@ -326,2 +326,3 @@ void USkillRotateAPI::RotateToTarget()',
  '-\tActor->SetActorRotation(Delta.Rotation());',
  '+\tUSunMoverAPI::SetRotation(Actor, Delta.Rotation());',
  '+\tRun();',
  ' unchanged();',
  'diff --git a/Source/NewName.h b/Source/NewName.h',
  '--- a/Source/OldName.h',
  '+++ b/Source/NewName.h',
  '@@ -10 +10 @@',
  '-old',
  '+new',
].join('\n')
function sample(): PlanDiff {
  const parsed = parsePlanDiff(DIFF, 'origin/main')
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.diff
}
async function render(diff: PlanDiff) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<PanelProvider t={t}><PlanDiffView diff={diff} /></PanelProvider>) })
  return { container, dispose: () => { act(() => root.unmount()); container.remove() } }
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('.dt-diff-modes button')]
  .find(item => item.textContent === label) as HTMLButtonElement
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })
it('renders the diff inline first, with line numbers, file stats and the changed tokens marked', async () => {
  const { container, dispose } = await render(sample())
  expect(container.querySelector('.dt-diff-title')?.textContent).toContain('代码改动')
  expect(container.querySelector('.dt-diff-total')?.textContent).toBe('+3−2')
  expect(container.querySelector('.dt-diff-base')?.textContent).toBe('对比 origin/main')
  expect([...container.querySelectorAll('.dt-diff-file-head')].map(head => head.textContent)).toEqual([
    'MSource/SkillRotateAPI.cpp+2−1', 'RSource/NewName.h原名 Source/OldName.h+1−1'])
  // Inline mode: old and new number columns on every row, and the hunk header names both ranges.
  expect(container.querySelectorAll('.dt-diff-row').length).toBe(6)
  expect(container.querySelector('.dt-diff-hunk-head')?.textContent).toBe('@@ -326,2 +326,3 @@ void USkillRotateAPI::RotateToTarget()')
  expect([...container.querySelectorAll('.dt-diff-row')].map(row => [...row.querySelectorAll('.dt-diff-no')].map(no => no.textContent))).toEqual([
    ['326', ''], ['', '326'], ['', '327'], ['327', '328'], ['10', ''], ['', '10']])
  // A word-level mark inside a changed line, not only a coloured row.
  const marks = [...container.querySelectorAll('.dt-diff-mark')].map(mark => mark.textContent).join('')
  expect(marks).toContain('USunMoverAPI')
  expect(container.querySelector('.dt-diff-index')).not.toBeNull()
  dispose()
})
it('switches to side by side, remembers the choice for the next diff, and switches back', async () => {
  const first = await render(sample())
  expect(button(first.container, '并排').getAttribute('aria-pressed')).toBe('false')
  await act(async () => button(first.container, '并排').click())
  expect(first.container.querySelectorAll('.dt-diff-split-row').length).toBe(4)
  expect(first.container.querySelectorAll('.dt-diff-row').length).toBe(0)
  expect(localStorage.getItem('dsh-superagent.plan-diff-mode')).toBe('split')
  expect(button(first.container, '并排').getAttribute('aria-pressed')).toBe('true')
  first.dispose()
  const second = await render(sample())
  expect(second.container.querySelectorAll('.dt-diff-split-row').length).toBe(4)
  await act(async () => button(second.container, '内联').click())
  expect(second.container.querySelectorAll('.dt-diff-row').length).toBe(6)
  expect(localStorage.getItem('dsh-superagent.plan-diff-mode')).toBe('inline')
  second.dispose()
})
it('names a binary file instead of drawing hunks it does not have', async () => {
  const parsed = parsePlanDiff('diff --git a/icon.uasset b/icon.uasset\nBinary files a/icon.uasset and b/icon.uasset differ')
  if ('problem' in parsed) throw new Error(parsed.problem)
  const { container, dispose } = await render(parsed.diff)
  expect(container.querySelector('.dt-diff-binary')?.textContent).toContain('二进制文件')
  expect(container.querySelectorAll('.dt-diff-hunk')).toHaveLength(0)
  dispose()
})
