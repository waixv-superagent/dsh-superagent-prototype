// @vitest-environment jsdom
// Panel navigation through browser history (Back/Forward, mouse side buttons), page transitions, and crash recovery.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { PageBoundary } from '../src/client/boundary.tsx'
import { zh } from '../src/client/locales.ts'
import { backRoute, historyEntry, parentRoute, type Route } from '../src/client/route.ts'
import { translator, usePanel, mount, remount, settle, click, tab, text, at } from './fixtures/panel.tsx'
import { createRoot } from 'react-dom/client'

usePanel()
const title = () => document.querySelector('.dt-page-title h2')?.textContent
const route = () => historyEntry(window.history.state)?.location.route
/** Step the browser history and wait for jsdom's asynchronous popstate to land. */
async function step(direction: 'back' | 'forward') {
  await act(async () => {
    const landed = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }))
    window.history[direction]()
    await landed
  })
  await settle()
}
async function side(button: 3 | 4) {
  await act(async () => {
    const landed = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }))
    const target = document.querySelector('.dt-page')!
    const down = new MouseEvent('mousedown', { button, bubbles: true, cancelable: true })
    const up = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })
    target.dispatchEvent(down)
    target.dispatchEvent(up)
    // The browser's own side-button handling is cancelled, so the panel's history step is the only one.
    expect([down.defaultPrevented, up.defaultPrevented]).toEqual([true, true])
    await landed
  })
  await settle()
}
/** A Ticket id a `?ticket=` deep link accepts: 32 lowercase hex digits, as the host writes them. */
const LINKED = 'a'.repeat(32)
/** The fake server answers Ticket t1 under the deep link's id, as the host would for that Ticket. */
function linkTicket(id: string) {
  const real = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return real(url.split(id).join('t1'), init)
  }))
}
/** Open the panel the way a Feishu bot message does: the URL names a Ticket and the entry has no panel history behind it. */
async function mountLinked() {
  linkTicket(LINKED)
  window.history.replaceState(null, '', `/?ticket=${LINKED}`)
  await mount(zh, null)
}
/** Press the page's Back button and wait for the browser history step it takes. */
async function pageBack() {
  await act(async () => {
    const landed = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }))
    document.querySelector<HTMLButtonElement>('.dt-page-head button')!.click()
    await landed
  })
  await settle()
}

it('steps back and forward through panel pages with the browser history', async () => {
  await mount()
  await click('修复回归')
  expect(title()).toBe('修复回归')
  expect(route()).toEqual({ page: 'execution', id: 't1' })
  await step('back')
  expect(document.querySelector('.dt-board')).not.toBeNull()
  expect(route()).toEqual({ page: 'editor', query: { view: 'board' } })
  await step('forward')
  expect(title()).toBe('修复回归')
})

it('turns the mouse side buttons into Back and Forward', async () => {
  await mount()
  await click(tab(zh['tab.eval']))
  await click(tab(zh['tab.source']))
  await side(3)
  expect(tab(zh['tab.eval']).getAttribute('aria-selected')).toBe('true')
  await side(3)
  expect(document.querySelector('.dt-board')).not.toBeNull()
  await side(4)
  expect(tab(zh['tab.eval']).getAttribute('aria-selected')).toBe('true')
})

it('does not leave DSH Web with the mouse Back button on the panel\'s first page', async () => {
  await mount()
  const back = vi.spyOn(window.history, 'back')
  const up = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })
  await act(async () => { document.querySelector('.dt-page')!.dispatchEvent(up) })
  expect(up.defaultPrevented).toBe(true)
  expect(back).not.toHaveBeenCalled()
  back.mockRestore()
})

it('lets the page Back button take the same history step as the browser', async () => {
  await mount()
  await click('修复回归')
  const before = window.history.length
  await act(async () => {
    const landed = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }))
    document.querySelector<HTMLButtonElement>('.dt-page-head button')!.click()
    await landed
  })
  await settle()
  expect(document.querySelector('.dt-board')).not.toBeNull()
  // Back moved within the existing entries, so Forward reopens the Ticket instead of a new entry being added.
  expect(window.history.length).toBe(before)
  await step('forward')
  expect(title()).toBe('修复回归')
})

it('replaces the current entry for a filter, without a step to undo it or a page transition', async () => {
  await mount()
  await click(tab(zh['tab.execution']))
  const entries = window.history.length
  const page = document.querySelector('.dt-route')!
  await click(zh['ticketFilter.idle'])
  expect(window.history.length).toBe(entries)
  // The page element stays mounted: a filter keeps the page's state and plays no entrance.
  expect(document.querySelector('.dt-route')).toBe(page)
  expect((route() as Extract<Route, { page: 'execution' }>).query).toEqual({ filter: 'idle' })
})

it('marks how each page enters: deeper, back, beside, or without motion on mount', async () => {
  await mount()
  const motion = () => document.querySelector('.dt-route')?.getAttribute('data-motion')
  expect(motion()).toBe('none')
  await click('修复回归')
  expect(motion()).toBe('forward')
  await step('back')
  expect(motion()).toBe('back')
  await click(tab(zh['tab.source']))
  expect(motion()).toBe('tab')
})

it('keeps its history position when the panel remounts on the entry it wrote', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(title()).toBe('修复回归')
  await step('back')
  expect(document.querySelector('.dt-board')).not.toBeNull()
})

it('shows a recoverable error instead of a blank panel when a page crashes, and retries in place', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  let broken = true
  function Page() {
    if (broken) throw new Error('boom: unexpected field')
    return <p>page content</p>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const home = vi.fn()
  await act(async () => { root.render(<PageBoundary t={translator(zh)} resetKey="a" onHome={home}><Page /></PageBoundary>) })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(zh.pageCrashed)
  expect(container.textContent).toContain('boom: unexpected field')
  broken = false
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === zh.retry)!.click() })
  expect(container.textContent).toBe('page content')
  // Leaving for another page also clears a crash.
  broken = true
  await act(async () => { root.render(<PageBoundary t={translator(zh)} resetKey="a" onHome={home}><Page key="again" /></PageBoundary>) })
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === zh.pageCrashedHome)!.click() })
  expect(home).toHaveBeenCalledOnce()
  broken = false
  await act(async () => { root.render(<PageBoundary t={translator(zh)} resetKey="b" onHome={home}><Page /></PageBoundary>) })
  expect(container.textContent).toBe('page content')
  act(() => { root.unmount() }); container.remove()
  expect(error).toHaveBeenCalled()
  error.mockRestore()
})

it('keeps the header and tabs usable when one page crashes', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await mount()
  // A Ticket answer of a shape the page cannot render crashes that page only.
  const real = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => String(url).includes('tickets/t1') && !String(url).includes('?')
    && !String(url).includes('/activity') ? Response.json({ broken: true }) : real(url, init)))
  await click('修复回归')
  expect(document.querySelector('.dt-crash')).not.toBeNull()
  expect(document.querySelector('.dt-head')).not.toBeNull()
  vi.stubGlobal('fetch', real)
  await click(tab(zh['tab.source']))
  expect(document.querySelector('.dt-crash')).toBeNull()
  expect(text()).not.toContain(zh.pageCrashed)
  error.mockRestore()
})

it('writes the parent menu behind a Ticket the panel opens without history', async () => {
  await mountLinked()
  expect(title()).toBe('修复回归')
  expect(route()).toEqual({ page: 'execution', id: LINKED })
  // The page Back button names the list the Ticket belongs to, and that list is the entry just behind the page: the
  // browser's Back/Forward — and so the macOS trackpad's two-finger swipe — steps between the two inside the panel.
  expect(document.querySelector('.dt-page-head button')?.textContent).toBe(zh['tab.execution'])
  await step('back')
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  expect(route()).toEqual({ page: 'execution' })
  await step('forward')
  expect(title()).toBe('修复回归')
})

it('sends the page Back button up to the parent menu when the panel has no history', async () => {
  await mountLinked()
  const entries = window.history.length
  await pageBack()
  // Back moved within the existing entries instead of jumping home or adding one.
  expect(window.history.length).toBe(entries)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  expect(title()).toBeUndefined()
})

it('steps to the parent menu from a deep-linked Ticket with the mouse Back button', async () => {
  await mountLinked()
  await side(3)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('sends a Thread opened without history back to the Trigger list', async () => {
  await mount(zh, { page: 'trigger', id: 'feishu:oc_1:om_root' })
  expect(title()).toBe('这个文案好奇怪')
  expect(document.querySelector('.dt-page-head button')?.textContent).toBe(zh['tab.trigger'])
  await pageBack()
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('continues at the entry a reload shows, not at the deep link the tab was opened with', async () => {
  await mountLinked()
  await step('back')
  expect(route()).toEqual({ page: 'execution' })
  // A reload keeps the entry the browser is on; the URL still names the Ticket the tab opened with, which must not reopen
  // a page the person already left.
  await remount(zh)
  expect(route()).toEqual({ page: 'execution' })
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('opens a Ticket a Session asks for one step on from the page the panel showed', async () => {
  await mount()
  // A Session's 工单 link writes the remembered route, then selects the panel (which remounts it).
  at({ page: 'execution', id: 't1' })
  await remount(zh)
  expect(title()).toBe('修复回归')
  expect(document.querySelector('.dt-page-head button')?.textContent).toBe(zh['tab.editor'])
  await step('back')
  expect(document.querySelector('.dt-board')).not.toBeNull()
})

it('takes the parent menu as the fallback Back target of a record, and none above a tab', () => {
  expect(backRoute({ route: { page: 'execution', id: 't1' }, stack: [] })).toEqual({ page: 'execution' })
  expect(backRoute({ route: { page: 'trigger', id: 'feishu:oc_1:om_root' }, stack: [] })).toEqual({ page: 'trigger' })
  expect(backRoute({ route: { page: 'execution', id: 't1' }, stack: [{ page: 'editor' }] })).toEqual({ page: 'editor' })
  expect(parentRoute({ page: 'execution' })).toBeUndefined()
  expect(parentRoute({ page: 'editor', query: { view: 'graph' } })).toBeUndefined()
  expect(backRoute({ route: { page: 'settings', query: { group: 'source' } }, stack: [] })).toEqual({ page: 'editor' })
})
