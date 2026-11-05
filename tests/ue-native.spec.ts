/**
 * Unit tests for the UE native tooling scripts (`scripts/ue-clangd.mjs`, `scripts/ue-lldb.mjs`) and
 * the wire/toolchain helpers they share. Nothing here starts clangd or lldb-dap: the framing,
 * argument building and result shaping are pure functions, and the live checks live in docs/026.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, parseMessages } from '../scripts/ue-wire.mjs'
import { findEngineTool, engineLlvmBins, quoteArg, uePaths } from '../scripts/ue-toolchain.mjs'
import {
  databaseDirectory, firstProjectSource, generateArguments, indexCacheDirectory, kindName, normalizeDiagnostics, normalizeLocations,
  normalizeSymbols, parseArgs as parseClangdArgs, parsePosition, pathToUri, severityName, staleness, uriToPath,
} from '../scripts/ue-clangd.mjs'
import {
  formatCapture, groupBreakpoints, initCommands, normalizeFrames, normalizeVariables, parseArgs as parseLldbArgs,
  parseBreakpoint, parseCliCapture,
} from '../scripts/ue-lldb.mjs'

const temporary: string[] = []
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'ue-native-'))
  temporary.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('wire framing', () => {
  it('round-trips messages and leaves an incomplete tail for the next read', () => {
    const first = frame({ jsonrpc: '2.0', id: 1, method: 'initialized' })
    const second = frame({ jsonrpc: '2.0', id: 2, result: [{ name: 'UThing' }] })
    const split = parseMessages(Buffer.concat([first, second.subarray(0, 10)]))
    expect(split.messages).toHaveLength(1)
    expect(split.messages[0]?.id).toBe(1)
    const whole = parseMessages(Buffer.concat([split.rest, second.subarray(10)]))
    expect(whole.messages[0]?.result).toEqual([{ name: 'UThing' }])
    expect(whole.rest).toHaveLength(0)
  })

  it('handles several messages in one chunk and multibyte bodies', () => {
    const one = frame({ name: '武器挂点' })
    const parsed = parseMessages(Buffer.concat([one, frame({ name: 'second' })]))
    expect(parsed.messages.map(message => message.name)).toEqual(['武器挂点', 'second'])
  })

  it('refuses a body that is not JSON and a header without Content-Length', () => {
    expect(() => parseMessages(Buffer.from('Content-Length: 3\r\n\r\nabc'))).toThrow(/not valid JSON/)
    expect(() => parseMessages(Buffer.from('X-Test: 1\r\n\r\n{}'))).toThrow(/no Content-Length/)
  })
})

describe('UE toolchain paths', () => {
  it('derives the project, .uproject and engine beside it', () => {
    const root = workspace()
    const project = join(root, 'Development', 'Project', 'Game')
    mkdirSync(join(project, 'Source'), { recursive: true })
    writeFileSync(join(project, 'Game.uproject'), '{}')
    mkdirSync(join(root, 'Development', 'Project', 'Engine', 'Build', 'BatchFiles'), { recursive: true })
    writeFileSync(join(root, 'Development', 'Project', 'Engine', 'Build', 'BatchFiles', 'RunUBT.bat'), '')
    const paths = uePaths({ root, project: 'Game' })
    expect(paths.project).toBe(resolve(project))
    expect(paths.uproject).toBe(resolve(join(project, 'Game.uproject')))
    expect(paths.engine).toBe(resolve(join(root, 'Development', 'Project', 'Engine')))
  })

  it('orders engine LLVM toolchains newest first and finds a tool in the newest', () => {
    const root = workspace()
    const engine = join(root, 'Engine')
    for (const version of ['18', '20']) {
      mkdirSync(join(engine, 'Binaries', 'ThirdParty', 'LLVM', version, 'Win64', 'bin'), { recursive: true })
      writeFileSync(join(engine, 'Binaries', 'ThirdParty', 'LLVM', version, 'Win64', 'bin', 'clangd.exe'), '')
    }
    const bins = engineLlvmBins(engine)
    expect(bins[0]).toContain('20')
    expect(findEngineTool(engine, 'clangd.exe')).toContain(join('20', 'Win64', 'bin'))
    expect(findEngineTool(engine, 'missing.exe')).toBeUndefined()
  })

  it('quotes only arguments cmd.exe would split', () => {
    expect(quoteArg('E:/sun_mainline')).toBe('E:/sun_mainline')
    expect(quoteArg('C:\\Program Files\\LLVM\\bin')).toBe('"C:\\Program Files\\LLVM\\bin"')
    expect(quoteArg('-Include=Source/Game')).toBe('-Include=Source/Game')
  })
})

describe('compile database', () => {
  it('builds the UBT GenerateClangDatabase command for one editor target', () => {
    const args = generateArguments({
      uproject: 'E:/ws/SunGame.uproject', target: 'SunEditor', configuration: 'Development',
      outputDir: 'E:/ws/Saved/AgentClangd', includes: ['Source/Game', 'Plugins/Fight'], noCodegen: true,
    })
    expect(args[0]).toBe('-Mode=GenerateClangDatabase')
    expect(args).toContain('SunEditor')
    expect(args).toContain('Win64')
    expect(args).toContain('Development')
    expect(args).toContain('-Project=E:/ws/SunGame.uproject')
    expect(args).toContain('-OutputDir=E:/ws/Saved/AgentClangd')
    expect(args).toContain('-Include=Source/Game')
    expect(args).toContain('-NoExecCodeGenActions')
    expect(databaseDirectory({ project: 'E:/ws' })).toBe(join('E:/ws', 'Saved', 'AgentClangd'))
    expect(indexCacheDirectory({ project: 'E:/ws' })).toBe(join('E:/ws', '.cache', 'clangd', 'index'))
  })

  it('picks a project translation unit to start the background index', () => {
    const root = workspace()
    const project = join(root, 'Development', 'Project', 'Game')
    mkdirSync(project, { recursive: true })
    const database = join(root, 'compile_commands.json')
    writeFileSync(database, JSON.stringify([
      { file: join(project, '..', 'Engine', 'Source', 'Engine.cpp'), command: '' },
      { file: join(project, 'Source', 'Game.cpp'), command: '' },
    ]))
    expect(firstProjectSource(database, project)).toBe(join(project, 'Source', 'Game.cpp'))
    expect(firstProjectSource(join(root, 'missing.json'), project)).toBeUndefined()
  })

  it('names concrete reasons to regenerate instead of trusting file times', () => {
    expect(staleness({ databaseExists: false })[0]).toMatch(/missing/)
    const manifest = {
      engine: { major: 5, minor: 8, patch: 3, buildId: 'Fixed-5.7.1' },
      compiler: 'E:/engine/Binaries/ThirdParty/LLVM/20/Win64/bin/clang-cl.exe',
    }
    const engineNow = { major: 5, minor: 8, patch: 3, buildId: 'Newer' }
    const reasons = staleness({ databaseExists: true, manifest, engineNow, compilerExists: true, ageDays: 1 })
    expect(reasons.join(' ')).toMatch(/engine changed/)
    expect(staleness({ databaseExists: true, manifest, engineNow, compilerExists: false, ageDays: 1 }).join(' '))
      .toMatch(/compiler .* is gone/)
    expect(staleness({ databaseExists: true, manifest, engineNow, compilerExists: true, ageDays: 30 }).join(' '))
      .toMatch(/30 days old/)
    expect(staleness({ databaseExists: true, manifest, engineNow: engineNow, compilerExists: true, ageDays: 1 })).toHaveLength(1)
    expect(staleness({ databaseExists: true, manifest: undefined })[0]).toMatch(/no `ue-clangd.json` manifest/)
  })
})

describe('clangd results', () => {
  it('converts Windows paths to file URIs and back', () => {
    const uri = pathToUri('C:\\ws\\Game\\Source\\Game.cpp')
    expect(uri).toBe('file:///C:/ws/Game/Source/Game.cpp')
    expect(uriToPath(uri)).toBe('C:\\ws\\Game\\Source\\Game.cpp')
  })

  it('reads a 1-based position from the right', () => {
    expect(parsePosition('C:\\ws\\Game\\Source\\Game.cpp:12:3')).toEqual({ file: 'C:\\ws\\Game\\Source\\Game.cpp', line: 12, column: 3 })
    expect(() => parsePosition('Game.cpp')).toThrow(/file>:<line>:<column/)
  })

  it('maps symbol kinds and locations, keeping the limit', () => {
    const symbols = normalizeSymbols([
      { name: 'USunAssetManager', kind: 5, containerName: 'SunGame', location: { uri: 'file:///C:/ws/Game.h', range: { start: { line: 9, character: 2 } } } },
      { name: 'Get', kind: 6, location: { uri: 'file:///C:/ws/Game.h', range: { start: { line: 20, character: 1 } } } },
    ], 1)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toEqual({ name: 'USunAssetManager', kind: 'class', container: 'SunGame', file: 'C:\\ws\\Game.h', line: 10, column: 3 })
    expect(kindName(12)).toBe('function')
    expect(kindName(999)).toBe('unknown')
  })

  it('accepts Location, Location[] and LocationLink results', () => {
    const location = { uri: 'file:///C:/ws/A.h', range: { start: { line: 0, character: 0 } } }
    expect(normalizeLocations(location)).toEqual([{ file: 'C:\\ws\\A.h', line: 1, column: 1 }])
    expect(normalizeLocations([location, null])).toHaveLength(1)
    expect(normalizeLocations({ targetUri: 'file:///C:/ws/B.h', targetRange: { start: { line: 4, character: 0 } } }))
      .toEqual([{ file: 'C:\\ws\\B.h', line: 5, column: 1 }])
    expect(normalizeLocations(null)).toEqual([])
  })

  it('shapes diagnostics with severity names', () => {
    const rows = normalizeDiagnostics('file:///C:/ws/A.cpp', [
      { range: { start: { line: 2, character: 4 } }, severity: 1, message: 'use of undeclared identifier', code: 'undeclared_var_use' },
      { range: { start: { line: 7, character: 0 } }, severity: 2, message: 'unused variable' },
    ])
    expect(rows[0]).toEqual({ file: 'C:\\ws\\A.cpp', line: 3, column: 5, severity: 'error', message: 'use of undeclared identifier', code: 'undeclared_var_use' })
    expect(rows[1]?.severity).toBe('warning')
    expect(severityName(4)).toBe('hint')
    expect(severityName(undefined)).toBe('unknown')
  })

  it('parses command options and refuses unknown ones', () => {
    const { options, positional } = parseClangdArgs(['symbol', 'USunAssetManager', '--limit', '5', '--json', '--include', 'Source/Game', '--include', 'Plugins/Fight'])
    expect(positional).toEqual(['symbol', 'USunAssetManager'])
    expect(options.limit).toBe(5)
    expect(options.json).toBe(true)
    expect(options.include).toEqual(['Source/Game', 'Plugins/Fight'])
    expect(options.timeoutMs).toBe(120_000)
    expect(() => parseClangdArgs(['symbol', '--bogus'])).toThrow(/unknown option/)
  })
})

describe('lldb capture', () => {
  it('parses a source breakpoint and groups lines per file', () => {
    expect(parseBreakpoint('C:\\ws\\Game.cpp:42')).toEqual({ file: 'C:\\ws\\Game.cpp', line: 42 })
    expect(() => parseBreakpoint('Game.cpp')).toThrow(/file>:<line>/)
    expect(() => parseBreakpoint('Game.cpp:0')).toThrow(/starts at 1/)
    const groups = groupBreakpoints([
      { file: 'Source/Game.cpp', line: 42 },
      { file: 'Source/Game.cpp', line: 12 },
      { file: 'Source/Game.cpp', line: 42 },
      { file: 'Source/Other.cpp', line: 3 },
    ])
    expect(groups.map(group => group.file)).toEqual([resolve('Source/Game.cpp'), resolve('Source/Other.cpp')])
    expect(groups[0]?.lines).toEqual([12, 42])
  })

  it('flattens frames and variables, keeping the requested limits', () => {
    const frames = normalizeFrames([
      { name: 'main', source: { path: 'C:/ws/fixture.cpp' }, line: 7, moduleId: 1 },
      { name: 'f', line: undefined },
    ])
    expect(frames[0]).toMatchObject({ index: 0, name: 'main', file: 'C:/ws/fixture.cpp', line: 7 })
    expect(frames[1]).toMatchObject({ index: 1, name: 'f', file: undefined })
    const variables = normalizeVariables(0, 'Locals', [
      { name: 'value', type: 'int', value: '41', variablesReference: 0 },
      { name: 'ptr', type: 'UObject *', value: '0x0', variablesReference: 5 },
    ], 1)
    expect(variables).toHaveLength(1)
    expect(variables[0]).toEqual({ frame: 0, scope: 'Locals', name: 'value', type: 'int', value: '41', expandable: false })
  })

  it('starts with inline breakpoints and imports formatters only on request', () => {
    expect(initCommands()).toEqual(['settings set target.inline-breakpoint-strategy always'])
    const commands = initCommands({ formatters: 'C:\\Engine\\Extras\\LLDBDataFormatters\\UEDataFormatters.py' })
    expect(commands).toHaveLength(2)
    expect(commands[1]).toMatch(/command script import "C:\/Engine\/Extras\/LLDBDataFormatters\/UEDataFormatters\.py"/)
  })

  it('parses the lldb CLI text of an attach into the same capture shape', () => {
    const text = [
      '(lldb) settings set target.inline-breakpoint-strategy always',
      '(lldb) process attach --pid 42',
      'Process 42 stopped',
      '* thread #7, stop reason = Exception 0x80000003 encountered at address 0x1',
      '    frame #0: 0x00000001 ntdll.dll`DbgBreakPoint + 1',
      '(lldb) breakpoint set --name UWorld::Tick',
      'Breakpoint 1: where = UnrealEditor-Engine.dll`UWorld::Tick(...) at World.cpp:1234, address = 0x2',
      '(lldb) continue',
      'Process 42 resuming',
      'Process 42 stopped',
      '* thread #7, stop reason = breakpoint 1.1',
      '    frame #0: 0x00000002 UnrealEditor-Engine.dll`UWorld::Tick(...) at World.cpp:1234',
      '(lldb) bt 3',
      '* thread #7',
      '  * frame #0: 0x00000002 UnrealEditor-Engine.dll`UWorld::Tick(...) at World.cpp:1234',
      '    frame #1: 0x00000003 UnrealEditor-Engine.dll`UWorld::TickWorld(...) at World.cpp:1300',
      '(lldb) frame variable',
      '    (UWorld *) this = 0x0000000a',
      '    (float) DeltaSeconds = 0.016',
      '(lldb) detach',
    ].join('\n')
    const parsed = parseCliCapture(text)
    expect(parsed.stop?.reason).toMatch(/breakpoint 1\.1/)
    expect(parsed.stop?.file).toBe('World.cpp')
    expect(parsed.stop?.line).toBe(1234)
    expect(parsed.breakpoints[0]).toMatchObject({ verified: true, file: 'World.cpp', line: 1234 })
    expect(parsed.frames.map((frame: { name?: string }) => frame.name)).toEqual(['UWorld::Tick(...)', 'UWorld::TickWorld(...)'])
    expect(parsed.variables[0]).toMatchObject({ name: 'this', type: 'UWorld *', value: '0x0000000a' })
    expect(parsed.variables[1]).toMatchObject({ name: 'DeltaSeconds', value: '0.016' })
  })

  it('refuses unsafe or incomplete captures, and renders a stop', () => {
    expect(() => parseLldbArgs(['--pid', '1234', '--launch', 'x.exe', '--break', 'a.cpp:1'])).toThrow(/exclusive/)
    expect(() => parseLldbArgs(['--pid', '1234', '--terminate', '--break', 'a.cpp:1'])).toThrow(/never killed/)
    expect(() => parseLldbArgs(['--pid', '0', '--break', 'a.cpp:1'])).toThrow(/refusing to attach/)
    expect(() => parseLldbArgs(['--pid', '1234'])).toThrow(/at least one --break/)
    const options = parseLldbArgs(['--pid', '1234', '--break', 'C:\\ws\\a.cpp:9', '--frames', '2', '--vars', '5', '--json'])
    expect(options.pid).toBe(1234)
    expect(options.breakpoints[0]).toEqual({ file: 'C:\\ws\\a.cpp', line: 9 })
    expect(options.frames).toBe(2)
    expect(options.vars).toBe(5)
    expect(parseLldbArgs(['capture', '--pid', '1234', '--break', 'a.cpp:1']).pid).toBe(1234)
    const text = formatCapture({
      stop: { reason: 'breakpoint', threadId: 7 },
      frames: [{ index: 0, name: 'main', file: 'C:/ws/a.cpp', line: 9 }],
      variables: [{ frame: 0, scope: 'Locals', name: 'value', type: 'int', value: '41' }],
      breakpoints: [],
    })
    expect(text).toContain('stopped: breakpoint')
    expect(text).toContain('Locals: value = 41 (int)')
  })
})
