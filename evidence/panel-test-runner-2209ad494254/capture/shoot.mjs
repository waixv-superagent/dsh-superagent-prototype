// Captures the 概览 editor view before and after the reproduction-case card, from two disposable local DSH Web
// instances. Usage: node shoot.mjs before|after <url> <out-dir>
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mode = process.argv[2] ?? 'before'
const url = process.argv[3]
const out = resolve(process.argv[4] ?? '.')
if (!url) throw new Error('usage: node shoot.mjs before|after <url> <out-dir>')
mkdirSync(out, { recursive: true })
const W = 1440, H = 1800
const port = Number(process.env.CDP_PORT ?? (mode === 'before' ? 9371 : 9372))
const work = resolve('.')
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(work, `.chrome-${mode}`)}`,
  'about:blank'], { stdio: 'ignore', detached: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function endpoint() {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json() } catch { /* still starting */ }
    await sleep(100)
  }
  throw new Error('Chrome did not expose CDP')
}
let nextId = 0, ws
const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
  const id = ++nextId; pending.set(id, { done, fail })
  ws.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }))
})
const evaluate = (sessionId, expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  .then(result => { if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value })
const clickText = (sessionId, selector, text) => evaluate(sessionId, `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => (e.textContent || '').trim() === ${JSON.stringify(text)}
    || (e.textContent || '').trim().startsWith(${JSON.stringify(text)}));
  if (!el) return false; el.click(); return true })()`)
const clip = async (sessionId, selector) => evaluate(sessionId, `(() => {
  const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, window.innerWidth - Math.max(0, r.x)),
    height: Math.min(r.height, window.innerHeight - Math.max(0, r.y)) } })()`)
const shot = async (sessionId, file, selector) => {
  const area = selector ? await clip(sessionId, selector) : undefined
  if (selector && !area) throw new Error(`No ${selector}`)
  const data = (await send('Page.captureScreenshot', { format: 'png', ...area ? { clip: { ...area, scale: 2 } } : {} }, sessionId)).data
  writeFileSync(resolve(out, file), Buffer.from(data, 'base64'))
  console.log(`wrote ${file}`)
}

async function main() {
  ws = new WebSocket((await endpoint()).webSocketDebuggerUrl)
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { done, fail } = pending.get(message.id); pending.delete(message.id)
      message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result)
    }
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sessionId)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId)
  await send('Page.navigate', { url }, sessionId)
  await sleep(9000)
  // A fresh DeepSeek Harness home may show its own preview notice first; dismiss it so the panel is visible.
  await clickText(sessionId, 'button', '继续')
  await sleep(800)
  const opened = await clickText(sessionId, 'a,button,[role="button"],[role="tab"]', 'Superagent')
  console.log('opened Superagent:', opened)
  await sleep(3000)
  // A fresh DeepSeek Harness home also shows a "开始使用" sign-in dialog over the panel; close it so the page is visible.
  console.log('dismissed sign-in:', await evaluate(sessionId, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const close = dialog && dialog.querySelector('button[aria-label="关闭"]')
    if (!close) return false; close.click(); return true })()`))
  await sleep(800)
  // 概览 opens on the board; the editor view, where the cases sit, is one switch away.
  console.log('概览 tab:', await clickText(sessionId, '.dt-tabs [role="tab"], .dt-tabs button', '概览'))
  await sleep(1500)
  console.log('编辑器 switch:', await clickText(sessionId, '.dt-home-switch [role="tab"], .dt-home-switch button', '编辑器'))
  await sleep(2500)
  const state = await evaluate(sessionId, `(() => ({
    hero: !!document.querySelector('.dt-editor-hero'),
    schedule: !!document.querySelector('.dt-editor-schedule'),
    repro: !!document.querySelector('.dt-repro'),
    cards: [...document.querySelectorAll('.dt-repro-case')].map(c => (c.querySelector('.dt-repro-case-name') || {}).textContent),
  }))()`)
  console.log('page:', JSON.stringify(state))
  await shot(sessionId, `${mode}-editor.png`)
  if (mode === 'after') {
    await shot(sessionId, 'after-card.png', '.dt-repro')
    const clicked = await evaluate(sessionId, `(() => {
      const card = [...document.querySelectorAll('.dt-repro-case')].find(c => (c.textContent || '').includes('急转'))
      const button = card && [...card.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '运行')
      if (!button) return false; button.click(); return true })()`)
    console.log('run clicked:', clicked)
    await sleep(5_500)
    await shot(sessionId, 'after-running.png', '.dt-repro')
    await sleep(6_000)
    const fact = await evaluate(sessionId, `(() => {
      const card = [...document.querySelectorAll('.dt-repro-case')].find(c => (c.textContent || '').includes('急转'))
      if (!card) return null
      const link = card.querySelector('a.dt-btn')
      return { text: (card.textContent || '').replace(/\\s+/g, ' ').trim(), report: link ? link.href : null,
        log: (card.querySelector('.dt-repro-log') || {}).textContent || null } })()`)
    console.log('after run:', JSON.stringify(fact))
    await shot(sessionId, 'after-succeeded.png', '.dt-repro')
    await shot(sessionId, 'after-editor-run.png')
    if (fact?.report) {
      // The report opens in a new tab in the real panel; here the same page navigates to it after the panel shots.
      await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 2, mobile: false }, sessionId)
      await send('Page.navigate', { url: fact.report }, sessionId)
      await sleep(2500)
      const data = (await send('Page.captureScreenshot', { format: 'png' }, sessionId)).data
      writeFileSync(resolve(out, 'after-report.png'), Buffer.from(data, 'base64'))
      console.log('wrote after-report.png')
    }
  }
  ws.close()
  chrome.kill()
}
main().catch(error => { console.error(error); try { chrome.kill() } catch { /* already gone */ } ; process.exit(1) })
