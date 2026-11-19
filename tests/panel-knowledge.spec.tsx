// @vitest-environment jsdom
// The Knowledge settings group: its switch, MCP server name and save block (docs/033).
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('toggles the team knowledge base and saves its own block', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.knowledge'], '.dt-settings-link'))
  expect(text()).toContain(zh.knowledgeTitle)
  expect(server.settings.knowledge).toEqual({ enabled: false, server: 'knowledge' })
  await click(find(zh.knowledgeEnabled, '[role="switch"]'))
  await type(field<HTMLInputElement>(zh.knowledgeServer), 'kb')
  await click(zh.save)
  expect(server.settings.knowledge).toEqual({ enabled: true, server: 'kb' })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/knowledge'])
})

it('shows the group in the Settings navigation and its save bar only while edited', async () => {
  await mount()
  await click(zh['tab.settings'])
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual([zh['settingsGroup.source'], zh['settingsGroup.eval'],
    zh['settingsGroup.execution'], zh['settingsGroup.knowledge'], zh['settingsGroup.prompts'], zh['settingsGroup.deployment']])
  await click(find(zh['settingsGroup.knowledge'], '.dt-settings-link'))
  expect(all('.dt-savebar')).toHaveLength(0)
  await click(find(zh.knowledgeEnabled, '[role="switch"]'))
  expect(all('.dt-savebar')).toHaveLength(1)
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
})
