/**
 * 合成演示探针（不接引擎）：在 A 臂模拟未修复的急转滑动，在 B 臂模拟修复后的结果。
 * 观测必须写到 REPRO_RUN_DIR 下，产物也写在那里，报告会把它们挂到对应的一次运行上。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.REPRO_RUN_DIR
if (!dir) {
  console.error('REPRO_RUN_DIR 未设置：这个探针要通过 repro-ab harness 运行')
  process.exit(2)
}
const arm = process.env.REPRO_ARM === 'A' ? 'A' : 'B'
const slide = arm === 'A' ? 7.8 : 0.42
const observation = {
  scene: 'demo-flat',
  input: { sequence: 'stand-still -> camera-turn-90', seed: 7 },
  metrics: { slideMax: slide, slideMean: Number((slide * 0.6).toFixed(2)), fps: 59.2 },
  state: 'idle',
}
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'observation.json'), `${JSON.stringify(observation, null, 2)}\n`)

const samples = Array.from({ length: 18 }, (_, index) => {
  const x = index * 16
  const drift = arm === 'A' ? Math.round(Math.min(46, index * 4.2)) : 2
  return `${x + 24},${96 - drift}`
})
writeFileSync(join(dir, 'trajectory.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" fill="#0f172a"/>
  <path d="M24 96H296" stroke="#334155" stroke-width="1"/>
  <path d="M24 16V96" stroke="#334155" stroke-width="1"/>
  <polyline points="${samples.join(' ')}" fill="none" stroke="${arm === 'A' ? '#f87171' : '#4ade80'}" stroke-width="2"/>
  <text x="24" y="112" fill="#94a3b8" font-size="10">arm ${arm} · 18 samples · seed 7</text>
</svg>
`)
writeFileSync(join(dir, 'trace.json'), `${JSON.stringify({ arm, samples: 18, seed: 7, slideMax: slide }, null, 2)}\n`)
console.log(`[demo] arm=${arm} slideMax=${slide} fps=59.2`)
