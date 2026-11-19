/** The team knowledge base's model-facing surface (docs/033): the MCP tools a Session may use and their server's prefix. */
import type { Settings } from '../policy.ts'

/** The prefix of the configured MCP server's tool names: `mcp__<server>__`. */
export const knowledgeToolPrefix = (server: string): string => `mcp__${server}__`

/**
 * The visible MCP tools of the configured knowledge server when the knowledge base is enabled, and none when it is off.
 * The server and its tools belong to the deployment's profile; this only decides whether a Session may see them.
 */
export function knowledgeToolNames(settings: Pick<Settings, 'knowledge'>, visible: readonly string[]): string[] {
  if (!settings.knowledge.enabled) return []
  const prefix = knowledgeToolPrefix(settings.knowledge.server)
  return visible.filter(name => name.startsWith(prefix))
}
