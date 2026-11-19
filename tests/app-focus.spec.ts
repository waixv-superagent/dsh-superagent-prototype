import { describe, expect, it, vi } from 'vitest'
import { appFocusCommand, focusDesktopApp } from '../src/app/app-focus.ts'

describe('bringing the desktop app forward', () => {
  it('builds the fixed protocol launch for each platform and skips one it does not know', () => {
    const win = appFocusCommand('win32')!
    expect(win[0]).toMatch(/cmd(\.exe)?$/i)
    expect(win[1]).toEqual(['/d', '/s', '/c', 'start "" "dsh://open"'])
    expect(appFocusCommand('darwin')).toEqual(['open', ['dsh://open']])
    expect(appFocusCommand('linux')).toEqual(['xdg-open', ['dsh://open']])
    expect(appFocusCommand('freebsd')).toBeUndefined()
  })
  it('launches it once, and reports when there is no launcher or the launch failed', () => {
    const run = vi.fn()
    expect(focusDesktopApp(run, 'darwin')).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith('open', ['dsh://open'])
    run.mockClear()
    expect(focusDesktopApp(run, 'freebsd')).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(focusDesktopApp(() => { throw new Error('no launcher') }, 'darwin')).toBe(false)
  })
})
