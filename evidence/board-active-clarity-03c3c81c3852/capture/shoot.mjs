/**
 * Capture the Superagent board and the frame-wide active-Tickets dock in headless Chrome with one build's board answers
 * and one build's client bundle served in place of the live host's, so a before/after pair renders the same app, viewport
 * and fixture and the only difference is the branch. Usage:
 *   node shoot.mjs <views.json> <client.js> <base-url> <out-board.png> <out-dock.png>
 * The base URL is the operator's panel URL (its token authenticates the page); it is never written to a file.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [viewsPath, clientPath, baseUrl, outPath, dockPath] = process.argv.slice(2)
if (!viewsPath || !clientPath || !baseUrl || !outPath || !dockPath) {
  throw new Error('usage: shoot.mjs <views.json> <client.js> <base-url> <out-board.png> <out-dock.png>')
}
const views = JSON.parse(readFileSync(viewsPath, 'utf8'))
const client = readFileSync(clientPath, 'utf8')
const PORT = 9433
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'sa-hierarchy-shot-'))
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

await call('Page.enable')
await call('Runtime.enable')
await call('Network.enable')
await call('Network.setCacheDisabled', { cacheDisabled: true })
await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 2, mobile: false })

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

// Serve the patched batch and this build's board answers to the new page, and open it directly on the board.
eventHandlers.push(message => {
  if (message.method !== 'Fetch.requestPaused') return
  const { requestId } = message.params
  void call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/javascript; charset=utf-8' }],
    body: Buffer.from(patched).toString('base64') })
})
await call('Fetch.enable', { patterns: [{ urlPattern: '*dsh-superagent*', requestStage: 'Request' }] })
const init = `(() => {
  ${process.env.FREEZE_NOW ? `{ const fixed = ${Number(process.env.FREEZE_NOW)}; Date.now = () => fixed }` : ''}
  const views = ${JSON.stringify(views)};
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let path = url;
    try { path = new URL(url, location.href).pathname } catch {}
    if (path.endsWith('/orchestrator/api/overview')) {
      return Promise.resolve(new Response(JSON.stringify(views['GET overview']), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return real(input, init);
  };
  try { sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'editor', query: { view: 'board' } }, stack: [] })) } catch {}
})()`
await call('Page.addScriptToEvaluateOnNewDocument', { source: init })
await call('Page.navigate', { url: baseUrl })
await sleep(5000)
if (!(await evaluate(`!!document.querySelector('.dt-page')`))) {
  // The panel is a sidebar entry; open it as a person would when the last route is not the panel.
  const clicked = await evaluate(`(() => {
    const hit = [...document.querySelectorAll('button, a, [role="button"], li, div')]
      .find(node => node.children.length < 6 && (node.textContent || '').trim() === 'Superagent');
    if (!hit) return false;
    hit.click();
    return true;
  })()`)
  if (!clicked) throw new Error('could not open the Superagent panel')
}
await waitFor(`!!document.querySelector('.dt-page')`)
await waitFor(`document.querySelectorAll('.dt-board-col-title').length === 5 && !!document.querySelector('.dt-verify-title')
  && !!document.querySelector('.dt-dock')`)
await evaluate(`(() => { const page = document.querySelector('.dt-page'); if (page) page.scrollTop = 0; window.scrollTo(0, 0) })()`)
await sleep(1200)
const board = await evaluate(`(() => {
  const element = document.querySelector('.dt-page');
  const box = element.getBoundingClientRect();
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
})()`)
const height = Math.min(board.height, Number(process.env.CLIP_HEIGHT ?? 1060))
const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
  clip: { x: board.x, y: board.y, width: board.width, height, scale: 1 } })
writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
const dock = await evaluate(`(() => {
  const element = document.querySelector('.dt-dock');
  const box = element.getBoundingClientRect();
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
})()`)
const dockShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
  clip: { x: dock.x, y: dock.y, width: dock.width, height: Math.max(28, dock.height), scale: 1 } })
writeFileSync(dockPath, Buffer.from(dockShot.data, 'base64'))
console.log('wrote', outPath, `${board.width}x${height}`, 'and', dockPath, `${dock.width}x${dock.height}`,
  'at 2x', await evaluate(`document.querySelector('.dt-active') ? 'band visible' : 'no band'`))
try { await send('Browser.close') } catch { /* closing anyway */ }
chrome.kill()
socket.close()

