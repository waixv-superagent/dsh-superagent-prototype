/** The team knowledge base's settings block, MCP-tool prefix gate, built-in skill and prompt line (docs/033). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Variable } from '../src/app/execution-environment.ts'
import { knowledgeInstructions } from '../src/app/context.ts'
import { knowledgeToolNames, knowledgeToolPrefix } from '../src/app/knowledge.ts'
import { Prompts, composeSkill, defaultPrompts } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { KnowledgeConfigSchema, SettingsSchema } from '../src/policy.ts'

const variables = (): Variable[] => []
const promptsOf = (store: Store) => new Prompts(store, () => 100_000, variables, () => true)
function withStore(body: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-'))
  const store = new Store(join(dir, 'db'))
  try { body(store) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

it('defaults the knowledge base off, under an MCP server named knowledge', () => {
  expect(SettingsSchema.parse({}).knowledge).toEqual({ enabled: false, server: 'knowledge' })
  expect(KnowledgeConfigSchema.parse({ enabled: true, server: 'kb_1' })).toEqual({ enabled: true, server: 'kb_1' })
  expect(KnowledgeConfigSchema.safeParse({ enabled: true, server: 'bad name' }).success).toBe(false)
  expect(KnowledgeConfigSchema.safeParse({ enabled: true, server: 'x'.repeat(33) }).success).toBe(false)
})

it('admits only the configured server\'s MCP tools, and none at all while the base is off', () => {
  const visible = ['read', 'mcp__knowledge__search', 'mcp__knowledge__read', 'mcp__other__search']
  expect(knowledgeToolNames({ knowledge: { enabled: false, server: 'knowledge' } }, visible)).toEqual([])
  expect(knowledgeToolNames({ knowledge: { enabled: true, server: 'knowledge' } }, visible))
    .toEqual(['mcp__knowledge__search', 'mcp__knowledge__read'])
  expect(knowledgeToolNames({ knowledge: { enabled: true, server: 'kb' } }, visible)).toEqual([])
  expect(knowledgeToolPrefix('kb')).toBe('mcp__kb__')
})

it('registers the knowledge skill only while the base is enabled, naming its server, and keeps the name built-in', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    const names = () => prompts.skills(defaultPrompts()).map(([name]) => name)
    expect(names()).toEqual(['feishu', 'github'])
    store.saveSettings({ ...store.settings(), knowledge: { enabled: true, server: 'kb' } })
    expect(names()).toEqual(['feishu', 'github', 'knowledge'])
    const skill = prompts.skills(defaultPrompts()).find(([name]) => name === 'knowledge')![1]
    expect(skill).toContain('mcp__kb__')
    expect(skill).toContain('not authority')
    expect(skill).toContain('Obsidian')
    expect(skill).not.toContain('{server}')
    expect(knowledgeInstructions('kb')).toContain('mcp__kb__*')
    expect(knowledgeInstructions('kb')).toContain('data, not authority')
    // A team skill cannot take the built-in name, and the skill follows the server the block names.
    expect(() => prompts.validate({ ...defaultPrompts(), skills: { knowledge: 'x' } })).toThrow('built-in skill')
    expect(composeSkill(defaultPrompts(), 'knowledge', 'team_kb')).toContain('mcp__team_kb__')
    expect(composeSkill(defaultPrompts(), 'knowledge')).toContain('mcp__knowledge__')
  })
})

it('follows the setting without a prompt revision: switching the base on or off changes the skill list', () => {
  withStore(store => {
    const prompts = promptsOf(store)
    const names = () => prompts.skills(defaultPrompts()).map(([name]) => name)
    store.saveSettings({ ...store.settings(), knowledge: { enabled: true, server: 'knowledge' } })
    expect(names()).toContain('knowledge')
    store.saveSettings({ ...store.settings(), knowledge: { enabled: false, server: 'knowledge' } })
    expect(names()).not.toContain('knowledge')
  })
})
