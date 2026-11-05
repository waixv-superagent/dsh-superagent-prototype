// @vitest-environment jsdom
// The panel's request form: a person starts work from DSH Web instead of going to Feishu.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { click, find, mount, settle, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('submits the typed request from the header, closes the form, and says the main Session will assess it', async () => {
  await mount()
  await click(find(zh.newTicket))
  const field = document.querySelector<HTMLTextAreaElement>('.dt-modal textarea')!
  expect(field).not.toBeNull()
  expect(field.getAttribute('maxlength')).toBe('8000')
  await type(field, '把方案卡改成真实 diff')
  await click(find(zh.newTicketSend))
  await settle()
  expect(server.requests.filter(request => request.path === 'requests'))
    .toEqual([{ path: 'requests', method: 'POST', body: { text: '把方案卡改成真实 diff' } }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.requestQueued)
  expect(document.querySelector('.dt-modal')).toBeNull()
})

it('keeps the form open and says why when the host cannot take the request', async () => {
  await mount()
  await click(find(zh.newTicket))
  await type(document.querySelector<HTMLTextAreaElement>('.dt-modal textarea')!, '把方案卡改成真实 diff')
  server.down = true
  await click(find(zh.newTicketSend))
  await settle()
  expect(document.querySelector('.dt-modal')).not.toBeNull()
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.hostNotRunning)
  server.down = false
})
