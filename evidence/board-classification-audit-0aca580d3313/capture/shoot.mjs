/**
 * Capture the Superagent panel in headless Chrome with one build's server views served in place of the live host's, so a
 * before/after pair renders the same client against each build's own answers. Usage:
 *   node shoot.mjs <views.json> <base-url> <out-prefix> [ticket-id]
 * Writes <out-prefix>-board.png and, with a ticket id, <out-prefix>-ticket.png.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [viewsPath, baseUrl, outPrefix, ticketId] = process.argv.slice(2)
const data = JSON.parse(readFileSync(viewsPath, 'utf8'))
const PORT = 9333
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'sa-shot-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1344,1400', '--force-device-scale-factor=2', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function version() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(400) }
  }
  throw new Error('Chrome did not open its debugging port')
}

const ver = await version()
const socket = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let sequence = 0
const pending = new Map()
socket.onmessage = ({ data: text }) => {
  const message = JSON.parse(text)
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
  }
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
await call('Page.enable')
await call('Runtime.enable')
await call('Emulation.setDeviceMetricsOverride', { width: 1344, height: 1400, deviceScaleFactor: 2, mobile: false })

const patch = `(() => {
  const data = ${JSON.stringify(data)};
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let path = url;
    try { path = new URL(url, location.href).pathname } catch {}
    const marker = '/orchestrator/api/';
    const at = path.indexOf(marker);
    if (at >= 0) {
      const rest = decodeURIComponent(path.slice(at + marker.length));
      const answer = data['GET ' + rest] ?? (rest === 'tickets' ? data['GET tickets'] : undefined);
      if (answer) return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return real(input, init);
  };
  try { sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: window.__SA_ROUTE__, stack: [] })) } catch {}
})()`

async function openBoardThen(route) {
  await call('Page.addScriptToEvaluateOnNewDocument', { source: patch.replace('window.__SA_ROUTE__', JSON.stringify(route)) })
  await call('Page.navigate', { url: baseUrl })
  await sleep(9000)
  const clicked = await call('Runtime.evaluate', { returnByValue: true, expression: `
    (() => {
      const wanted = ['Superagent'];
      const nodes = [...document.querySelectorAll('button, a, [role="button"], li, div')];
      const hit = nodes.find(node => node.children.length < 6 && wanted.includes((node.textContent || '').trim()));
      if (!hit) return 'not found';
      hit.click();
      return 'clicked: ' + (hit.textContent || '').trim();
    })()` })
  await sleep(6000)
  return clicked.result?.value
}

async function shot(path) {
  const clipParts = (process.env.CLIP ?? '').split(',').map(Number)
  const clip = clipParts.length === 4 && clipParts.every(Number.isFinite)
    ? { x: clipParts[0], y: clipParts[1], width: clipParts[2], height: clipParts[3], scale: 2 } : undefined
  const result = await call('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  console.log('wrote', path, clip ? `clip ${JSON.stringify(clip)}` : 'full page')
}

try {
  console.log('board:', await openBoardThen({ page: 'editor', query: { view: 'board' } }))
  await shot(`${outPrefix}-board.png`)
  if (ticketId) {
    console.log('ticket:', await openBoardThen({ page: 'execution', id: ticketId }))
    await shot(`${outPrefix}-ticket.png`)
  }
} finally {
  try { await send('Browser.close') } catch { /* closing anyway */ }
  chrome.kill()
  socket.close()
}
