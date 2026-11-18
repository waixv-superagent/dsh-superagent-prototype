/*
 * Minimal Electron fixture for the desktop link-policy A/B (docs/022): loads the exact anchor HTML the panel renders for
 * the same Feishu AppLink, under the desktop shell's real window-open and will-navigate rules (apps/desktop/src/main.ts),
 * clicks it, records what the shell does, and captures the window to a PNG.
 *
 * Usage: electron link-policy-fixture.cjs before|after <output.png>
 * The shell's openExternal is recorded, not performed, so the fixture never opens a browser or the Feishu client.
 */
const { app, BrowserWindow, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const mode = process.argv.includes('after') ? 'after' : 'before'
const output = process.argv.find(argument => argument.endsWith('.png')) ?? path.join(__dirname, `${mode}.png`)
const anchor = fs.readFileSync(path.join(__dirname, `anchor-${mode === 'after' ? 'after' : 'before'}.html`), 'utf8')
const href = /href="([^"]+)"/.exec(anchor)?.[1] ?? '(missing)'
const revision = mode === 'after' ? 'fixed revision (this branch)' : 'baseline revision (main, 9acd418)'
const calls = []
const events = []

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #17191e; color: #e6e8ee; font: 13px/1.55 "Segoe UI", "Microsoft YaHei", sans-serif; }
  body { box-sizing: border-box; padding: 18px 22px; }
  h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
  .meta { color: #9aa0ac; font-size: 12px; margin-bottom: 14px; }
  .box { border: 1px solid #2b2f38; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; background: #1d2027; }
  .label { color: #9aa0ac; font-size: 12px; margin-bottom: 6px; }
  .anchor { font-size: 13px; }
  .anchor a { color: #8fb4ff; text-decoration: none; display: inline-flex; gap: 5px; align-items: center; border: 1px solid #39404d;
    border-radius: 6px; padding: 4px 9px; background: #232733; }
  code { color: #d7dae2; font: 12px Consolas, monospace; word-break: break-all; }
  .result { border-color: #4a3b1e; background: #2a2416; }
  .result.ok { border-color: #24452f; background: #17251c; }
  #result { word-break: break-all; }
</style></head><body>
  <h1>DSH desktop link policy · Feishu AppLink</h1>
  <div class="meta">${revision} · same link, same window, same theme · click simulated on load</div>
  <div class="box"><div class="label">The anchor the panel renders</div><div class="anchor">${anchor}</div>
    <div class="label" style="margin-top:8px">href <code>${href.replaceAll('&amp;', '&')}</code></div></div>
  <div class="box result${mode === 'after' ? ' ok' : ''}"><div class="label">What the shell did</div><div id="result">clicking…</div></div>
</body></html>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 430, show: false, backgroundColor: '#17191e', paintWhenInitiallyHidden: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
  })
  // The desktop shell's rules, copied from apps/desktop/src/main.ts createWindow() (lines 345-348 and 409-418).
  win.webContents.setWindowOpenHandler(({ url }) => {
    events.push(`window-open ${url}`)
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    events.push(`will-navigate ${url}`)
    const destination = new URL(url)
    const current = new URL(win.webContents.getURL())
    const sameOrigin = ['http:', 'https:'].includes(destination.protocol) && destination.origin === current.origin
    if (destination.protocol !== 'dsh-app:' && !sameOrigin) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  // Record instead of launching anything on this machine; the real shell calls the same function with the same URL.
  shell.openExternal = async (url) => { calls.push(url) }
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
  await new Promise(resolve => setTimeout(resolve, 400))
  await win.webContents.executeJavaScript("document.querySelector('.anchor a').click()")
  await new Promise(resolve => setTimeout(resolve, 700))
  const outcome = calls.length > 0
    ? `window-open → shell.openExternal(${calls[0]}) → system browser opens the AppLink, then the Feishu client`
    : `no openExternal call — the shell drops ${new URL(href).protocol}// and the click opens nothing`
  await win.webContents.executeJavaScript(`document.getElementById('result').textContent = ${JSON.stringify(outcome)}`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const image = await win.capturePage()
  fs.writeFileSync(output, image.toPNG())
  console.log(JSON.stringify({ mode, revision, href, events, calls, outcome, output }, null, 2))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(2) })
