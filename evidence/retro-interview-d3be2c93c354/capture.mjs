#!/usr/bin/env node
/**
 * capture.mjs — screenshot a local report page with headless Chrome.
 *
 * Chrome's screenshot covers the viewport, so pass the viewport you want the reviewer to see
 * (for this report 1280 x 1500 CSS px shows the first screen plus the next section). A page taller
 * than the viewport is cut; the committed report HTML is the full-page artifact.
 *
 * Usage: node capture.mjs <file-url> <out.png> [width=1280] [height=1500]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [, , url, out, widthArg = '1280', heightArg = '1500'] = process.argv
if (!url || !out) {
  console.error('usage: node capture.mjs <file-url> <out.png> [width] [height]')
  process.exit(2)
}
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const profile = join(tmpdir(), `dsh-report-shot-${Date.now()}`)
const result = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--force-device-scale-factor=1', `--user-data-dir=${profile}`,
  `--window-size=${Number(widthArg)},${Number(heightArg)}`, `--screenshot=${out}`, url,
], { stdio: 'ignore' })
if (result.error) throw result.error
if (!existsSync(out)) throw new Error(`Chrome wrote no screenshot (exit ${result.status})`)
console.log(`captured ${widthArg}x${heightArg} -> ${out} (${statSync(out).size} bytes)`)
