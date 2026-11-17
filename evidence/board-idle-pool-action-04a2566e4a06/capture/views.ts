/**
 * Render the management panel's board and one Ticket page over a database snapshot, as the JSON answers a capture serves
 * into the live panel. Usage: node views.ts <repo-root> <db-path> <out.json>
 */
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [root, dbPath, out] = process.argv.slice(2) as [string, string, string]
const load = (path: string) => import(pathToFileURL(join(root, path)).href)

const { Store } = await load('src/app/store.ts')
const { SourceRegistry } = await load('src/sources/registry.ts')
const { HealthBoard } = await load('src/infra/health.ts')
const { overview } = await load('src/app/views/overview.ts')
const { ticketDetail, executorLoad } = await load('src/app/views/tickets.ts')
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
const host = { store, sources, links: () => ({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_demo',
  label: { zh: '示例话题', en: 'Example thread' } }) } as never
const settings = store.settings()
writeFileSync(out, JSON.stringify({
  'GET overview': overview(host, {}, policyVersion(settings), executorLoad(store, 0)),
  'GET tickets/demo-decision-01': { ...ticketDetail(host, 'demo-decision-01'), environment: [] },
}, undefined, 1))
store.close()
console.log('wrote', out)
