/**
 * UE 项目自动跑测验证：编译 → 跑自动化测试 → 把结果解析成结构化 JSON。
 *
 * 命令与判定遵循项目自己的编译/验证约定：
 *   编译：Build/BatchFiles/Compile/CompileProject.bat（唯一合法入口，参数不能改）
 *   测试：UnrealEditor-Cmd.exe <uproject> -ExecCmds="Automation RunTests <前缀>; Quit"
 *          -unattended -nopause -nosplash -log -TestExit="Automation Test Queue Empty"
 *          （不要加 -nullrhi）
 *   判定：Game/Saved/Logs/Game.log 里 LogAutomationController 的
 *          "Test Completed. Result=" 行，失败时连带 Expected 断言原文
 *
 * 用法：
 *   node scripts/ue-verify.mjs --prefix Game.Performance.EntityImportance [--json]
 *   node scripts/ue-verify.mjs --prefix Game.Smoking.Skill --no-compile
 *   node scripts/ue-verify.mjs --self-test
 *
 * 环境变量（都有默认值，指向本机 mainline 工作区）：
 *   DSH_SUPERAGENT_UE_ROOT  默认 E:\workspace
 *
 * 退出码：0 全部通过；1 用法错误；4 编译失败；5 测试失败；6 环境缺失。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** 从工作区根推导 AGENTS.md 规定的那几个绝对路径。 */
export function pathsOf(root = process.env.DSH_SUPERAGENT_UE_ROOT || 'E:\\workspace') {
  const project = join(root, 'Development', 'Project', 'Game')
  return {
    root,
    project,
    compile: join(project, 'Build', 'BatchFiles', 'Compile', 'CompileProject.bat'),
    editor: join(root, 'Development', 'Project', 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
    uproject: join(project, 'Game.uproject'),
    log: join(project, 'Saved', 'Logs', 'Game.log'),
  }
}

/** 编译脚本的输出判定：只看 UBT 的 `Result: Succeeded/Failed`，别看中间 warning。 */
export function parseCompile(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean)
  const verdict = [...lines].reverse().find(line => /Result:\s*(Succeeded|Failed)/i.test(line))
  const succeeded = /Succeeded/i.test(verdict ?? '')
  const errors = lines.filter(line => /^\s*(?:\S.*:\s*)?error\b/i.test(line) || /\berror\s+[A-Z]+\d+:/.test(line))
  return { succeeded, verdict: (verdict ?? '').trim(), errors: errors.slice(0, 20), tail: lines.slice(-5) }
}

/**
 * 解析自动化测试日志。
 * 容错优先：UE 各版本的 "Test Completed" 行格式不完全一致，所以名字能取就取、取不到留空，
 * 但 Result 必须取到——取不到就认为这次跑测无效（不能当通过）。
 */
export function parseTestLog(text) {
  const tests = []
  const assertions = []
  let lastSeen = ''
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('LogAutomationController')) continue
    const started = /(?:Test Started|Running test)[^:]*:\s*(.+)$/.exec(line)
    if (started) lastSeen = started[1].trim()
    const completed = /Test Completed\.\s*Result=\{?(\w+)\}?/.exec(line)
    if (completed) {
      const name = /Name=\{([^}]+)\}/.exec(line)?.[1]?.trim() || lastSeen || '(未命名)'
      tests.push({ name, result: completed[1] })
      continue
    }
    if (/\b(?:Error|Expected)\b/.test(line)) assertions.push(line.trim().slice(0, 300))
  }
  const failed = tests.filter(test => !/^success$/i.test(test.result))
  return { tests, passed: tests.length - failed.length, failed: failed.length, assertions: assertions.slice(-20), complete: tests.length > 0 }
}

/** 报告人读摘要：一条结论 + 失败用例 + 失败断言原文。 */
export function summarize({ compile, tests }) {
  const lines = []
  if (compile && !compile.succeeded) {
    lines.push(`编译失败：${compile.verdict || '未找到 Result 行'}`)
    for (const error of compile.errors) lines.push(`  ${error}`)
  } else if (compile) {
    lines.push(`编译通过（${compile.verdict}）`)
  }
  if (tests) {
    if (!tests.complete) lines.push('测试日志里没有 Test Completed 行，本次跑测无效（不能当通过）')
    else lines.push(`测试：通过 ${tests.passed}，失败 ${tests.failed}（共 ${tests.tests.length}）`)
    for (const test of tests.tests.filter(item => !/^success$/i.test(item.result))) lines.push(`  FAILED ${test.name} → ${test.result}`)
    for (const assertion of tests.assertions) lines.push(`  断言 ${assertion}`)
  }
  return lines.join('\n')
}

/** 跑一个子进程并收集输出；注入 runner 便于自检。 */
export function exec(command, args, { runner = defaultRunner } = {}) {
  return runner(command, args)
}

function defaultRunner(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? 0, output }))
  })
}

/** 主流程：编译（可选）→ 跑测 → 解析。任一阶段失败都不再往下走。 */
export async function verify({ prefix, paths = pathsOf(), skipCompile = false, runner, timeoutMs = 45 * 60 * 1000 }) {
  const missing = [paths.compile, paths.editor, paths.uproject].filter(path => !existsSync(path))
  if (missing.length) throw new Error(`UE 项目环境缺失：${missing.join('、')}`)

  let compile
  if (!skipCompile) {
    const result = await exec('powershell', ['-ExecutionPolicy', 'Bypass', '-Command', `& '${paths.compile}'`], { runner })
    compile = parseCompile(result.output)
    if (!compile.succeeded) return { compile, tests: undefined, ok: false }
  }

  // 测试会写 Project.log；先记下文件大小，跑完只解析新增部分，避免上一轮的 Test Completed 干扰
  const before = existsSync(paths.log) ? readFileSync(paths.log, 'utf8').length : 0
  const result = await exec(paths.editor, [
    paths.uproject,
    `-ExecCmds=Automation RunTests ${prefix}; Quit`,
    '-unattended', '-nopause', '-nosplash', '-log',
    '-TestExit=Automation Test Queue Empty',
  ], { runner })
  const full = existsSync(paths.log) ? readFileSync(paths.log, 'utf8') : result.output
  const tests = parseTestLog(full.slice(before))
  return { compile, tests, ok: Boolean(tests.complete) && tests.failed === 0 }
}

/** 自检：编译判定、测试解析、无效日志不当通过、摘要可读。 */
export async function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`自检失败：${message}`)
  }

  const okCompile = parseCompile('Building 12 actions\nTotal execution time: 3.1s\nResult: Succeeded')
  assert(okCompile.succeeded, 'Succeeded 应判通过')
  const badCompile = parseCompile('Foo.cpp(12): error C2065: undeclared\nResult: Failed')
  assert(!badCompile.succeeded && badCompile.errors.length === 1, 'Failed 应判失败并抓到 error 行')

  const log = [
    'LogAutomationController: Test Started. Name={Project.A}',
    'LogAutomationController: Test Completed. Result={Success} Name={Project.A} Path={X}',
    'LogAutomationController: Test Started. Name={Project.B}',
    'LogAutomationController: Expected 3 to equal 4',
    'LogAutomationController: Test Completed. Result={Fail} Name={Project.B} Path={X}',
  ].join('\n')
  const parsed = parseTestLog(log)
  assert(parsed.tests.length === 2 && parsed.passed === 1 && parsed.failed === 1, '应解析出 1 通过 1 失败')
  assert(parsed.assertions.some(line => line.includes('Expected 3')), '应保留失败断言原文')
  assert(parsed.complete, '有 Test Completed 行应算完整')

  // 空日志/只有启动行 → 不完整，绝不能当通过
  const empty = parseTestLog('LogAutomationController: Test Started. Name={Project.C}')
  assert(!empty.complete, '没有 Test Completed 行应判无效')

  const text = summarize({ compile: okCompile, tests: parsed })
  assert(text.includes('编译通过') && text.includes('失败 1') && text.includes('Project.B'), '摘要应含结论与失败用例')

  // 环境缺失必须点名路径
  let named = ''
  try {
    await verify({ prefix: 'X', paths: { compile: 'C:/nope.bat', editor: 'C:/nope.exe', uproject: 'C:/nope.uproject', log: 'C:/nope.log' }, runner: async () => ({ code: 0, output: '' }) })
  } catch (error) {
    named = error.message
  }
  assert(named.includes('UE 项目环境缺失'), '缺路径应明确报错')
  return true
}

async function main(argv) {
  const arg = name => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv.includes('--self-test')) {
    await selfTest()
    console.log('self-test passed')
    return 0
  }
  const prefix = arg('--prefix')
  if (!prefix) {
    console.error('usage: node scripts/ue-verify.mjs --prefix <AutomationTestPrefix> [--no-compile] [--json] [--self-test]')
    return 1
  }
  try {
    const result = await verify({ prefix, skipCompile: argv.includes('--no-compile') })
    console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : summarize(result))
    if (result.compile && !result.compile.succeeded) return 4
    return result.ok ? 0 : 5
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 6
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/ue-verify.mjs')) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}



