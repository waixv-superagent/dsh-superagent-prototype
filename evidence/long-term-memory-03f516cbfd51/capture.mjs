/**
 * capture.mjs — before/after screenshots of the Knowledge settings group in the live Superagent panel.
 *
 * The browser loads the operator's panel URL (its token authenticates the page), so the real DSH shell, theme and
 * routes are the deployed ones. For `after`, the served dsh-superagent module is replaced, through CDP Fetch, with
 * this branch's built `lib/client.js`; `before` keeps the deployed module. Both runs answer `GET state` and
 * `GET settings` from one fixture, whose `knowledge` block is added for this comparison, so the only difference
 * between the images is the client build under capture.
 *
 * Usage: node capture.mjs before|after <lib/client.js> <operator-url> <out-dir>
 * The operator URL carries a token: never write it to a file or commit it.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [mode, clientPath, baseUrl, outDir] = process.argv.slice(2)
if (!mode || !clientPath || !baseUrl || !outDir) throw new Error('usage: node capture.mjs before|after <lib/client.js> <operator-url> <out-dir>')
if (!['before', 'after'].includes(mode)) throw new Error('mode is before or after')
const client = readFileSync(clientPath, 'utf8')
const out = resolve(outDir)
const PORT = 9437
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'sa-knowledge-shot-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1200', '--force-device-scale-factor=2', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function version() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(300) }
  }
  throw new Error('Chrome did not open its debugging port')
}

const ver = await version()
const socket = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let sequence = 0
const pending = new Map()
const eventHandlers = []
socket.onmessage = ({ data: text }) => {
  const message = JSON.parse(text)
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
    return
  }
  for (const handler of eventHandlers) handler(message)
}
function send(method, params = {}, sessionId) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (method, params) => send(method, params, sessionId)
const evaluate = async (expression, awaitPromise = false) => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluation failed')
  return result.result?.value
}
async function waitFor(expression, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${expression}`)
}
const jsonFulfil = (requestId, value) => call('Fetch.fulfillRequest', { requestId, responseCode: 200,
  responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(value)).toString('base64') })

await call('Page.enable')
await call('Runtime.enable')
await call('Network.enable')
await call('Network.setCacheDisabled', { cacheDisabled: true })
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 2, mobile: false })
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

// Load once to authenticate the browser session and read the boot manifest the live host serves.
await call('Page.navigate', { url: baseUrl })
await waitFor('!!globalThis.__DSH_BOOT__')
await sleep(2000)
const batchUrl = await evaluate(`(() => {
  const batch = globalThis.__DSH_BOOT__?.batches.find(item => item.entries.includes('dsh-superagent'))
  return batch ? batch.url : ''
})()`)
if (!batchUrl) throw new Error('the live page does not boot dsh-superagent')
const cookies = await call('Network.getCookies', { urls: [baseUrl] })
const cookie = cookies.cookies.map(item => `${item.name}=${item.value}`).join('; ')
const original = await (await fetch(new URL(batchUrl, baseUrl), { headers: cookie ? { cookie } : {} })).text()
const marker = 'window.__ModuleLoader__.load('
const starts = []
for (let at = original.indexOf(marker); at !== -1; at = original.indexOf(marker, at + marker.length)) starts.push(at)
const start = starts.find(at => original.slice(at, at + 400).includes('id: "dsh-superagent"'))
if (start === undefined) throw new Error('the live batch carries no dsh-superagent module')
const next = starts[starts.indexOf(start) + 1] ?? original.length
const patched = `${original.slice(0, start)}${client}\n;\n${original.slice(next)}`
console.log(`mode=${mode} patched batch: ${original.length} -> ${patched.length} bytes`)

// One fixture for both runs: the live deployment's state and settings, with a quiet state and an added knowledge block.
const live = await evaluate(`(async () => {
  const get = async path => (await fetch('/orchestrator/api/' + path, { headers: { 'x-orchestrator-request': '1' } })).json()
  return { state: await get('state'), settings: await get('settings') }
})()`, true)
const state = { ...live.state, paused: false,
  setup: { ...live.state.setup, problem: null, feishuProblem: null },
  load: { ...live.state.load, running: 0, queued: 0 } }
// The same quiet fixture for both runs: no live paths, credentials or P4 host on screen.
const executor = { ...live.settings.blocks.executor.value, model: null, maxWorkers: 3, directory: '', prepare: '',
  backend: 'git', blockedCommands: [],
  editor: { project: '', engine: '', editorExe: '', build: '', restart: '', test: '', targets: [] },
  p4: { ...live.settings.blocks.executor.value.p4, port: '', user: '', jenkinsToken: '', reviewers: [], autobuildTargets: [] } }
const settings = { ...live.settings,
  blocks: { ...live.settings.blocks, executor: { ...live.settings.blocks.executor, value: executor },
    knowledge: { value: { enabled: false, server: 'knowledge' }, revision: 0 } },
  environment: { ...live.settings.environment, root: '/srv/dsh-superagent/work' } }
const views = { 'GET state': state, 'GET settings': settings }

eventHandlers.push(message => {
  if (message.method !== 'Fetch.requestPaused') return
  const { requestId, request } = message.params
  if (mode === 'after' && request.url.includes('dsh-superagent') && !request.url.includes('/orchestrator/api/')) {
    void call('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/javascript; charset=utf-8' }],
      body: Buffer.from(patched).toString('base64') })
    return
  }
  const api = /\/orchestrator\/api\/([^?]+)/.exec(request.url)
  if (api && request.method === 'GET') {
    const key = `GET ${api[1]}`
    if (key.endsWith('/activity')) { void jsonFulfil(requestId, { live: false, updatedAt: 0, tool: null, recent: [] }); return }
    if (views[key]) { void jsonFulfil(requestId, views[key]); return }
  }
  void call('Fetch.continueRequest', { requestId })
})
await call('Fetch.enable', { patterns: [{ urlPattern: '*dsh-superagent*' }, { urlPattern: '*/orchestrator/api/*' }] })
const route = mode === 'after' ? { page: 'settings', query: { group: 'knowledge' } } : { page: 'settings', query: { group: 'execution' } }
const init = `(() => {
  try { sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: ${JSON.stringify(route)}, stack: [] })) } catch {}
})()`
await call('Page.addScriptToEvaluateOnNewDocument', { source: init })
await call('Page.navigate', { url: baseUrl })
await sleep(5000)
if (!(await evaluate(`!!document.querySelector('.dt-page')`))) {
  const clicked = await evaluate(`(() => {
    const hit = [...document.querySelectorAll('button, a, [role="button"], li, div')]
      .find(node => node.children.length < 6 && (node.textContent || '').trim() === 'Superagent');
    if (!hit) return false; hit.click(); return true })()`)
  if (!clicked) throw new Error('could not open the Superagent panel')
}
await waitFor(`!!document.querySelector('.dt-settings')`)
await waitFor(`!!document.querySelector('.dt-settings-link')`)
await sleep(1500)

async function shot(name) {
  const rect = await evaluate(`(() => {
    const element = document.querySelector('.dt-page');
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  })()`)
  const height = Math.min(rect.height, 900)
  const data = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
    clip: { x: rect.x, y: rect.y, width: rect.width, height, scale: 1 } })
  writeFileSync(join(out, name), Buffer.from(data.data, 'base64'))
  console.log('wrote', name, `${rect.width}x${height} at 2x`)
}

await shot(`${mode}-settings.png`)
if (mode === 'after') {
  const toggled = await evaluate(`(() => { const item = document.querySelector('.dt-switch'); if (!item) return false; item.click(); return true })()`)
  if (!toggled) throw new Error('the Knowledge page has no switch')
  await sleep(600)
  await shot('after-enabled.png')
}
try { await send('Browser.close') } catch { /* closing anyway */ }
chrome.kill()
socket.close()
