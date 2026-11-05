/**
 * Render the management panel's server views over a database snapshot, written as one JSON file a browser can be given.
 * Usage: node views.ts <repo-root> <db-path> <ticket-id> <out.json>
 */
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [root, dbPath, ticketId, out] = process.argv.slice(2) as [string, string, string, string]
const load = (path: string) => import(pathToFileURL(join(root, path)).href)

const { Store } = await load('src/app/store.ts')
const { SourceRegistry } = await load('src/sources/registry.ts')
const { HealthBoard } = await load('src/infra/health.ts')
const { overview } = await load('src/app/views/overview.ts')
const { executorLoad, ticketDetail, ticketList } = await load('src/app/views/tickets.ts')
const { policyVersion } = await load('src/policy.ts')
const { feishuKind } = await load('src/sources/feishu.ts')
const { githubKind } = await load('src/sources/github.ts')
const { tapdKind } = await load('src/sources/tapd.ts')

const store = new Store(dbPath)
const board = new HealthBoard()
const sources = new SourceRegistry(() => store.settings(), board)
for (const kind of [feishuKind, githubKind, tapdKind]) {
  try { sources.register(kind as never) } catch (failure) { console.error('kind not registered', (failure as Error).message) }
}
const links = () => ({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_demo',
  label: { zh: '示例话题', en: 'Example thread' } })
const host = { store, sources, links } as never
const health = (board as unknown as { snapshot?: () => unknown }).snapshot
  ? (board as unknown as { snapshot: () => unknown }).snapshot() : {}
const settings = store.settings()
const payload = {
  'GET overview': overview(host, health as never, policyVersion(settings), executorLoad(store, 0)),
  'GET tickets': ticketList(host, 'open', 0, 1000),
  [`GET tickets/${ticketId}`]: { ...ticketDetail(host, ticketId), environment: [] },
}
writeFileSync(out, JSON.stringify(payload, undefined, 1))
console.log('wrote', out, Object.keys(payload).join(', '))
