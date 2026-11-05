// @vitest-environment jsdom
// The local reproduction cases card on the editor view (docs/024): what a folder lists, the run a person clicks and the
// report it opens, without starting another editor.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, find, mount, tab, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
/** 概览 opens on the board now; the editor view, where the cases sit, enters through the switch. */
const openEditor = async () => {
  await mount()
  await click(tab(zh['tab.editor']))
  await click(tab(zh.homeViewEditor))
}

it('lists the cases beside the editor, with the latest run and its report', async () => {
  server.repro = { ...server.repro, cases: [
    { id: 'pivot', name: '急转滑动', description: '转镜头时采样 pivot', command: 'py -3 run.py', report: 'reports/out.html' },
    { id: 'draft', name: 'draft', description: '', problem: { code: 'invalidManifest', detail: 'command: Required' } },
  ], runs: [{ id: 'r1', caseId: 'pivot', caseName: '急转滑动', state: 'succeeded', startedAt: '2026-11-05T10:00:00.000Z',
    endedAt: '2026-11-05T10:01:00.000Z', exitCode: 0, summary: 'Result: ok', report: 'reports/out.html' }] }
  await openEditor()
  expect(document.querySelector('.dt-repro')).not.toBeNull()
  expect(document.querySelector('.dt-repro .dt-editor-col-title')?.textContent).toBe('复现用例2')
  expect(document.querySelector('.dt-repro-path')?.textContent).toContain('/w/SunGame/Saved/ReproTests')
  expect(all('.dt-repro-case')).toHaveLength(2)
  expect(all('.dt-repro-case-name').map(name => name.textContent)).toEqual(['急转滑动', 'draft'])
  expect(document.querySelector('.dt-repro-desc')?.textContent).toBe('转镜头时采样 pivot')
  // The valid case runs and opens its report; the invalid one says why and offers no run button.
  const first = all('.dt-repro-case')[0]!
  expect(first.querySelector('.dt-repro-case-head .dt-tag')?.textContent).toBe('成功')
  expect(first.querySelector('.dt-repro-meta')?.textContent).toContain('退出码 0')
  expect(first.querySelector('.dt-repro-meta')?.textContent).toContain('Result: ok')
  const report = first.querySelector('a.dt-btn')!
  expect(report.getAttribute('href')).toBe('/orchestrator/repro/file/r1/reports/out.html')
  expect(report.getAttribute('target')).toBe('_blank')
  expect(first.textContent).toContain('运行')
  const second = all('.dt-repro-case')[1]!
  expect(second.textContent).toContain('配置有误')
  expect(second.textContent).toContain('case.json 不合法 · command: Required')
  expect(second.querySelector('.dt-repro-case-actions')?.textContent).not.toContain('运行')
})

it('runs a case on a click and reads the output of a finished run', async () => {
  server.repro = { ...server.repro, cases: [{ id: 'pivot', name: '急转滑动', description: '', command: 'py -3 run.py' }],
    runs: [{ id: 'r1', caseId: 'pivot', caseName: '急转滑动', state: 'failed', startedAt: '2026-11-05T10:00:00.000Z',
      endedAt: '2026-11-05T10:01:00.000Z', exitCode: 2, summary: 'boom' }] }
  await openEditor()
  await click(find('运行'))
  expect(server.requests.filter(item => item.method === 'POST')).toContainEqual({ path: 'repro/run', method: 'POST', body: { case: 'pivot' } })
  await click(find('输出'))
  expect(server.requests.filter(item => item.method === 'GET').map(item => item.path)).toContain('repro/log?run=r1')
  expect(document.querySelector('.dt-repro-log')?.textContent).toBe('first line\nlast line')
  // A second click folds the output away again.
  await click(find('收起输出'))
  expect(document.querySelector('.dt-repro-log')).toBeNull()
})

it('shows the run in flight with its live output and no run button elsewhere', async () => {
  server.repro = { ...server.repro,
    cases: [{ id: 'pivot', name: '急转滑动', description: '', command: 'py -3 run.py' },
      { id: 'other', name: '另一个用例', description: '', command: 'py -3 other.py' }],
    runs: [{ id: 'r2', caseId: 'pivot', caseName: '急转滑动', state: 'running', startedAt: '2026-11-05T10:00:00.000Z', summary: '' }],
    active: { runId: 'r2', caseId: 'pivot', tail: 'step 2 of 5' } }
  await openEditor()
  const [running, other] = all('.dt-repro-case')
  expect(running!.textContent).toContain('运行中')
  expect(running!.querySelector('.dt-repro-live')?.textContent).toBe('step 2 of 5')
  expect(running!.textContent).toContain('停止')
  expect(other!.querySelector<HTMLButtonElement>('button.dt-btn')?.disabled).toBe(true)
})

it('refuses to start a run while an agent holds the editor', async () => {
  server.repro = { ...server.repro, blocked: 'agent',
    cases: [{ id: 'pivot', name: '急转滑动', description: '', command: 'py -3 run.py' }] }
  await openEditor()
  expect(document.querySelector('.dt-repro')?.getAttribute('data-blocked')).toBe('agent')
  expect(document.querySelector('.dt-repro-blocked')?.textContent).toContain('agent 正占着编辑器')
  expect(find('运行')).toHaveProperty('disabled', true)
})

it('says when the case folder does not exist yet and how a case is added', async () => {
  server.repro = { ...server.repro, problem: { code: 'missing' }, cases: [], runs: [] }
  await openEditor()
  expect(document.querySelector('.dt-repro-problem')?.textContent).toBe('用例目录还不存在')
  expect(document.querySelector('.dt-repro-empty')?.textContent).toContain('case.json')
})
