// @vitest-environment jsdom
/** The always-visible active-Tickets dock in DSH's bottom strip: rows from the board's active list, and where each control goes. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ActiveTicketsDock } from '../src/client/dock.tsx'
import { zh } from '../src/client/locales.ts'
import { all, settle, translator } from './fixtures/panel.tsx'
import { server, ticketSummary, usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined
let container: HTMLElement | undefined
usePanelServer(() => {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
})

async function mountDock() {
  const calls = { worker: [] as string[], ticket: [] as string[], board: 0 }
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<ActiveTicketsDock t={translator(zh)} openWorker={id => calls.worker.push(id)} openTicket={id => calls.ticket.push(id)}
      openBoard={() => { calls.board++ }} />)
  })
  await settle()
  return calls
}
const rows = () => all('.dt-dock-row')
const press = async (element: HTMLElement) => { await act(async () => { element.click() }); await settle() }

describe('active-Tickets dock', () => {
  it('lists only live work and rows that wait on a person, live first, and never the all-identical six-row dump', async () => {
    server.active = [...server.active, { ...ticketSummary({ id: 't9', title: '排队的工单' }, { stage: 'working', action: 'queued' }),
      activeAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }]
    await mountDock()
    expect(document.querySelector('.dt-dock-label')?.textContent).toBe('活跃工单2')
    // A queued turn is not moving, so it stays on the board rather than on the always-visible strip.
    expect(rows().map(row => row.querySelector('.dt-dock-title')?.textContent)).toEqual(['升级依赖', '修复移动普攻后接 Q 技能无法起飞'])
    const [working, person] = rows()
    expect(working!.closest('.dt-dock-item')?.getAttribute('data-live')).toBe('true')
    expect(working!.querySelector('.dt-dock-stage')?.textContent).toBe(zh['stage.working'])
    expect(working!.querySelector('.dt-dock-spin')).not.toBeNull()
    expect(working!.querySelector('.dt-dock-age')?.textContent).toBe('4 分钟前')
    expect(person!.querySelector('.dt-dock-pill')?.textContent).toBe(zh['stage.verify'])
    expect(person!.querySelector('.dt-dock-stage')).toBeNull()
    expect(person!.querySelector('.dt-dock-age')?.textContent).toBe('30 分钟前')
    // The live group and the group that waits on a person are visibly separate.
    expect(document.querySelectorAll('.dt-dock-sep')).toHaveLength(1)
    // The full title stays reachable when the visible one is cut.
    expect(person!.getAttribute('aria-label')).toContain('修复移动普攻后接 Q 技能无法起飞')
  })

  it('keeps an older handover off the strip, where it is queue rather than active work', async () => {
    server.active = [{ ...ticketSummary({ id: 't9', title: '上周交付的工单', verification: { at: new Date(Date.now() - 3 * 86_400_000)
      .toISOString(), state: 'pending' } }, { stage: 'person', action: 'verify' }), activeAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }]
    await mountDock()
    expect(container!.innerHTML).toBe('')
  })

  it('renders nothing when no open Ticket has recent activity', async () => {
    server.active = []
    await mountDock()
    expect(container!.innerHTML).toBe('')
  })

  it('switches to the worker Session on a row click, without opening the Ticket page', async () => {
    const calls = await mountDock()
    await press(rows()[1]!)
    expect(calls.worker).toEqual(['t8'])
    expect(calls.ticket).toEqual([])
  })

  it('opens the Ticket page from the secondary button, and the board from the header action', async () => {
    const calls = await mountDock()
    await press(all('.dt-dock-open')[0]!)
    expect(calls.ticket).toEqual(['t6'])
    expect(calls.worker).toEqual([])
    await press(all('button').find(button => button.textContent === '看板')!)
    expect(calls.board).toBe(1)
  })
})
