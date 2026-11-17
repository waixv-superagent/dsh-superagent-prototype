/**
 * Capture the Superagent board and one Ticket page in headless Chrome with one build's client module served in place of
 * the live host's, and the board/Ticket answers served from a fixture database, so a before/after pair renders the same
 * app, viewport, theme and data and the only difference is the branch under capture. Usage:
 *   node shoot.mjs before|after <views.json> <client.js> <base-url> <out-dir>
 * The base URL is the operator's panel URL (its token authenticates the page); it is never written to a file.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [mode, viewsPath, clientPath, baseUrl, outDir] = process.argv.slice(2)
if (!mode || !viewsPath || !clientPath || !baseUrl || !outDir) throw new Error('usage: shoot.mjs before|after <views.json> <client.js> <base-url> <out-dir>')
const views = JSON.parse(readFileSync(viewsPath, 'utf8'))
const client = readFileSync(clientPath, 'utf8')
const out = resolve(outDir)
const PORT = 9435
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'sa-priority-shot-'))
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

// Load the page once to authenticate the browser session and to read the boot manifest the live host serves.
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
console.log(`patched batch: ${original.length} -> ${patched.length} bytes`)

// Serve the patched module, the fixture board and Ticket answers, and a quiet activity stub; every other request goes to
// the live host, so the app shell, theme and routes are the deployed ones.
eventHandlers.push(message => {
  if (message.method !== 'Fetch.requestPaused') return
  const { requestId, request } = message.params
  if (request.url.includes('dsh-superagent') && !request.url.includes('/orchestrator/api/')) {
    void call('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/javascript; charset=utf-8' }],
      body: Buffer.from(patched).toString('base64') })
    return
  }
  const api = /\/orchestrator\/api\/([^?]+)/.exec(request.url)
  if (api && request.method === 'GET') {
    const key = `GET ${api[1]}`
    if (key.endsWith('/activity')) {
      void jsonFulfil(requestId, { live: false, updatedAt: 0, tool: null, recent: [] })
      return
    }
    if (views[key]) { void jsonFulfil(requestId, views[key]); return }
  }
  void call('Fetch.continueRequest', { requestId })
})
await call('Fetch.enable', { patterns: [{ urlPattern: '*dsh-superagent*' }, { urlPattern: '*/orchestrator/api/*' }] })
const init = `(() => {
  ${process.env.FREEZE_NOW ? `{ const fixed = ${Number(process.env.FREEZE_NOW)}; Date.now = () => fixed }` : ''}
  try { sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'editor', query: { view: 'board' } }, stack: [] })) } catch {}
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
await waitFor(`!!document.querySelector('.dt-page')`)
await waitFor(`document.querySelectorAll('.dt-board-col-title').length === 5`)
await evaluate(`(() => { const page = document.querySelector('.dt-page'); if (page) page.scrollTop = 0; window.scrollTo(0, 0) })()`)
await sleep(1200)

async function shot(name) {
  const rect = await evaluate(`(() => {
    const element = document.querySelector('.dt-page');
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  })()`)
  const height = Math.min(rect.height, Number(process.env.CLIP_HEIGHT ?? 1200))
  // Not `captureBeyondViewport`: a fixed popup is painted relative to the viewport, and a beyond-viewport clip omits it.
  const data = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
    clip: { x: rect.x, y: rect.y, width: rect.width, height, scale: 1 } })
  writeFileSync(join(out, name), Buffer.from(data.data, 'base64'))
  console.log('wrote', name, `${rect.width}x${height} at 2x`)
}

await shot(`${mode}-board.png`)
if (mode === 'after') {
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('.dt-board-col[data-tone="run"] .dt-run .dt-priority-trigger')
      || document.querySelector('.dt-deck-card .dt-priority-trigger');
    if (!trigger) return false; trigger.click(); return true })()`)
  if (!opened) throw new Error('the board has no priority trigger to open')
  await waitFor(`!!document.querySelector('.dt-priority-pop')`)
  await sleep(500)
  await shot('after-board-menu.png')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await sleep(400)
}

// The Ticket page of the decision card: one live Ticket waiting on a person, with its level control under the title.
const openedTicket = await evaluate(`(() => {
  const title = [...document.querySelectorAll('.dt-deck-card-title')].find(node => (node.textContent || '').includes('方案里的一句话'));
  if (!title) return false; title.click(); return true })()`)
if (!openedTicket) throw new Error('could not open the fixture Ticket')
await waitFor(`!!document.querySelector('.dt-page-title h2')`)
await sleep(1500)
await evaluate(`(() => { const page = document.querySelector('.dt-page'); if (page) page.scrollTop = 0; window.scrollTo(0, 0) })()`)
await sleep(400)
await shot(`${mode}-ticket.png`)
if (mode === 'after') {
  const openedMenu = await evaluate(`(() => {
    const trigger = document.querySelector('.dt-page-head .dt-priority-trigger');
    if (!trigger) return false; trigger.click(); return true })()`)
  if (!openedMenu) throw new Error('the Ticket page has no priority trigger to open')
  await waitFor(`!!document.querySelector('.dt-priority-pop')`)
  await sleep(500)
  await shot('after-ticket-menu.png')
}
try { await send('Browser.close') } catch { /* closing anyway */ }
chrome.kill()
socket.close()
