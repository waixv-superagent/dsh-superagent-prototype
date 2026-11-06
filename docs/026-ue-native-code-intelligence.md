# 026 — UE C++ code intelligence without Rider

Status: implemented and verified on 2026-11-06 as `scripts/ue-clangd.mjs` and `scripts/ue-lldb.mjs`;
the clangd index/queries ran on the SunGame workspace and a launched Development editor was stopped at
`UWorld::Tick` through VS Code's C/C++ debugger (`cppvsdbg`). This document records what replaced Rider,
the measurements that decided it, and the limits a worker still has to respect.

## 1. The dependency this removes

A worker used to reach UE C++ code intelligence through Rider's MCP server: `rider-call` wrapped the
read-only tools (symbol search, references, file diagnostics), and `debug-capture` read a debugger
session that a person had already paused. That made two of the most common debugging moves turn on an
IDE being open and a person operating it:

- a breakpoint could only be placed by hand in Rider's UI; the worker could read a session but not
  start one;
- Rider's index, its IDE process and its license sit on every machine, for a channel that is read-only.

This follows the execution model in [003 Execution](003-execution.md): a worker owns its ticket end to
end, so a tool it cannot drive is a tool it does not have.

## 2. Decision

| Concern | Rider before | Now |
| --- | --- | --- |
| Compile flags / index | Rider's own C++ engine | UnrealBuildTool `-Mode=GenerateClangDatabase` + clangd LSP |
| Symbol, definition, references, diagnostics | `rider-call` (IDE must be open) | `node scripts/ue-clangd.mjs` |
| Breakpoint, stack, frame variables | Rider UI + `debug-capture` (read-only) | `node scripts/ue-lldb.mjs capture` through VS Code's C/C++ debugger (`cppvsdbg`); lldb-dap and the lldb CLI remain fallbacks |

Rider stays as a fallback: nothing in the repository or the project removes it, and the skills keep the
Rider path for interactive refactors (`rename_refactoring`, `safe_delete`) that clangd does not offer.

## 3. Measured evidence

Measured on the SunGame workspace (UE 5.8, engine `Fixed-5.7.1`) on 2026-11-06:

| Fact | Measurement |
| --- | --- |
| Build compiler | `Engine/Saved/UnrealBuildTool/BuildConfiguration.xml` and the project's copy both set `WindowsPlatform/Compiler = Clang`; the binaries carry clang-cl CodeView |
| Compile database | `compile_commands.json` at the project root: 42,786 entries, 28 MB, one `UnrealEditorGCD/Development` configuration; `GenerateClangDatabase` sets `bUseUnityBuild=false` and `-NoPCH`, so entries are per source file, not Unity blobs |
| clangd parse | one SunGame translation unit: 80 MB preamble in 11 s, 23 diagnostics on a database generated 5 months earlier |
| clangd LSP | `initialize` 0.1 s, first diagnostics 13.4 s after `didOpen`, `documentSymbol` immediate; a 1.31 GB / 132,689-shard index already exists under the project's `.cache/clangd` |
| LLDB | engine LLVM 20.1.8 ships `lldb.exe` and `lldb-dap.exe`; `liblldb.dll` needs `Engine/Binaries/ThirdParty/Python3/Win64/python311.dll` on `PATH` |
| PDB | `llvm-pdbutil dump -summary` on `UnrealEditor-SunGame-Win64-DebugGame.pdb` reports debug info, types, globals and publics |
| Target setup cost | `lldb` `target create` of `UnrealEditor-Win64-DebugGame.exe`: 58.9 s (the editor PDB is 26 MB; each module has its own much larger PDB) |
| UE formatters | `Engine/Extras/LLDBDataFormatters/UEDataFormatters.py` and `Engine/Extras/VisualStudioDebugging/Unreal.natvis` |

Two conclusions follow. The compile database must come from UBT, not from an IDE project file: only
UBT knows UHT generated includes, `Definitions.h`, the `imsvc` third-party paths and the clang-cl
defines. And the debugger must be the LLVM that built the binaries, because its PDB reader understands
the CodeView clang-cl emits.

Live checks on 2026-11-06, after regenerating the database for `SunEditor Win64 Development`:

| Check | Result |
| --- | --- |
| `ue-clangd index` | 39,917 compile commands in 181 s, written to `SunGame/Saved/AgentClangd` |
| `ue-clangd status` | manifest matches the engine (`5.8.3`, `Fixed-5.7.1`); no stale reason |
| `ue-clangd definition` on `USunAssetManager::Get` | `SunAssetManager.h:13:19`, 13.7 s |
| `ue-clangd diagnostics` on `SunAssetManager.cpp` | 0 diagnostics; the stale database reported 23, including `KuroContentVariantPlatform.h` not found |
| `ue-lldb capture --launch <clang-cl fixture>` | stopped at `fixture.cpp:4`; frames and locals (`value`, `result`) returned |
| `ue-lldb capture --backend vscode --launch <loop fixture>` | the C/C++ debugger started inside VS Code, stopped at `loop.cpp:1`, and returned the `f`/`main` frames and the `i` variable |
| `ue-lldb capture --backend vscode --launch <Development editor>` | launched the editor, bound the `UWorld::Tick` function breakpoint and stopped at `LevelTick.cpp:1657`; 3 frames, 165 threads, 83 variables with NatVis (`UEditorEngine::this` = `Name="SunEditorEngine"_0`); the launched editor was terminated |
| `ue-lldb capture --pid <Development editor>` (lldb) | the engine LLDB aborts on the editor PDB type completion (`0xC0000409`; `lldb -b` `0xC0000005`), which is why this route is not used |

## 4. `ue-clangd.mjs`

```sh
node scripts/ue-clangd.mjs status --json
node scripts/ue-clangd.mjs index --root E:/sun_mainline --project SunGame
node scripts/ue-clangd.mjs symbol USunAssetManager --limit 5
node scripts/ue-clangd.mjs definition Source/SunGame/BasicSystem/AssetManager/SunAssetManager.cpp:177:20
node scripts/ue-clangd.mjs references Source/SunGame/BasicSystem/AssetManager/SunAssetManager.cpp:177:20
node scripts/ue-clangd.mjs diagnostics Source/SunGame/BasicSystem/AssetManager/SunAssetManager.cpp
```

- `index` runs `RunUBT.bat -Mode=GenerateClangDatabase <target> Win64 <configuration> -Project=<uproject>
  -OutputDir=<project>/Saved/AgentClangd` and records a `ue-clangd.json` manifest beside the database.
  The database lives under `Saved/` so it never enters source control; `--print` shows the command,
  `--target`/`--configuration` select another target, `--include` narrows it to paths, `--no-codegen`
  skips UHT/codegen actions when the generated headers are already present.
- clangd is taken from the engine's LLVM (`Binaries/ThirdParty/LLVM/<version>/Win64/bin`) first, then
  `PATH`, then the stock LLVM install. Its cache environment (`XDG_CACHE_HOME`, and `LOCALAPPDATA` on
  Windows) is pointed at `<project>/.cache`, so any index shards land beside the project and `status`
  can count them.
- `warm` keeps clangd alive with `--background-index` for `--minutes` and opens one project source,
  which is what queues the database's remaining translation units for indexing. This is the only
  command that costs real time (a full engine-sized database is hours; a project-only database via
  `--include` is much smaller). `symbol` is the command that needs those shards; `definition`,
  `references`, `hover` and `diagnostics` answer from the open file and its preamble.
- `status` judges staleness from the recorded engine version and the compiler path, not from file times:
  a p4 sync rewrites every mtime. It exits 4 and says so when a query has no database to run against.
- Every command takes `--json`; agents parse that, people read the text form.

## 5. `ue-lldb.mjs`

```sh
# attach to a running DebugGame editor and stop in the suspect function
node scripts/ue-lldb.mjs capture --pid 64104 --break Source/SunGame/GameplayFramework/SunGameCharacter.cpp:212 --json

# or start a small program under the debugger
node scripts/ue-lldb.mjs capture --launch build/fixture.exe --break fixture.cpp:7 --json
```

The script starts `lldb-dap`, initializes it, attaches or launches, sets the requested source and
function breakpoints, sends `configurationDone`, waits for `stopped`, then returns threads, stack frames
and the variables of the first frames. It always disconnects with `terminateDebuggee: false`: an editor
it attached to is never killed, and `--terminate` is refused for `--pid`. A timeout detaches and exits 5;
a target that ends first exits 4. `--frames`, `--scopes` and `--vars` bound the amount of data.

The capture starts lldb-dap with `settings set target.inline-breakpoint-strategy always`, which the
engine's own formatter setup also needs. The engine's `UEDataFormatters.py` is **not** imported by
default: on this installation importing it aborts lldb-dap with `0xC0000409` and no stderr, so it is
opt-in with `--formatters <file>` once a formatter is known to work with the adapter's Python build.
Without it, UObject pointers print as addresses and the raw frame variables are still readable.

The primary route is VS Code's own C/C++ debugger, the engine a person already uses in VS Code. The
verified command for the editor is a launch, not an attach:

```sh
node scripts/ue-lldb.mjs capture --backend vscode --launch <Engine>/Binaries/Win64/UnrealEditor.exe \
  --arg <project>/SunGame.uproject --arg -unattended --arg -log --arg -nosplash \
  --cwd <Engine>/Binaries/Win64 \
  --break-func "UWorld::Tick" \
  --symbols UnrealEditor.exe --symbols UnrealEditor-Engine.dll --symbols UnrealEditor-Core.dll \
  --symbols UnrealEditor-CoreUObject.dll --symbols UnrealEditor-UnrealEd.dll \
  --terminate --json
```

It opened the SunGame Development editor, bound the `UWorld::Tick` function breakpoint and stopped at
`LevelTick.cpp:1657` with three frames, the 165 threads of the process and 83 frame variables; the NatVis
formatters resolved `UEditorEngine::this` to `Name="SunEditorEngine"_0` and `FEngineLoop::this` to its
field values. `--terminate` ends the editor the capture started.

What makes this route work, and what the earlier attempts missed:

- The extension watches the real DAP stream through `vscode.debug.registerDebugAdapterTrackerFactory`
  and waits for the `stopped` event. Polling `stackTrace` on a running process cannot work: cppvsdbg
  answers the request only while the target is stopped, and cppvsdbg reports stop and frame data as
  events, not as request results.
- Function breakpoints are registered as `vscode.FunctionBreakpoint`; a source line in an engine
  function is fragile under optimization, a function name is what cppvsdbg resolves.
- The capture window opens a temporary workspace folder that VS Code reports as **trusted**
  (`workspace.isTrusted`); cppvsdbg does not start a session in an untrusted window.
- `--symbols` maps to `symbolOptions.moduleFilter = loadOnlyIncluded` for just the modules in the
  call path. Without it cppvsdbg loads the PDBs of every loaded module (7.5 GB and more) before the
  editor's first tick, which looked like the editor "stalling at Turnkey".
- The engine's `Unreal.natvis` is passed as `visualizerFile`; the C/C++ extension copy is cached in an
  isolated directory (the OS temp directory, or `--vscode-data <dir>`), and `--capture-dir <dir>` keeps
  the job, the DAP trace and the editor log as evidence.

Attaching to an editor that someone else started is still unverified; the verified route launches the
editor inside the capture. `--backend auto` tries this route first, then `lldb-dap`, then the `lldb` CLI
for an attach. The other routes exist because this machine may not have VS Code or the C/C++ extension:

- `vsdbg.exe` started directly is not usable: the Visual Studio debug engine refuses a client that is
  not Microsoft VS Code (`C/C++ Debugging is supported only in Microsoft versions of VS Code`), so a
  capture must run inside VS Code rather than drive the engine from outside.
- The engine LLDB on this installation cannot attach to the editor: `lldb-dap` aborts (`0xC0000409`)
  and `lldb` crashes (`0xC0000005`) while completing the editor PDB types, after many
  `Class ... does not have a complete definition` errors. `lldb` still works for ordinary clang-cl
  programs, which is what the `dap` and `cli` backends are verified with.

The skill's existing rule still holds: a breakpoint in game module code only binds in a `DebugGame`
(or `Debug`) build. In a `Development` editor the inlined function entry has no line to stop on, and
`setBreakpoints` comes back unverified.

## 6. What a worker should expect

| Action | Command | Typical cost |
| --- | --- | --- |
| Find a symbol | `ue-clangd symbol` | seconds once shards exist; empty until `warm` has indexed something |
| Build the symbol index | `ue-clangd warm --minutes N` | minutes; no shard files appeared in a 2-minute run on this installation, so `symbol` stays best-effort |
| Definition / references | `ue-clangd definition` / `references` | one clangd startup plus a preamble; 13.7 s measured for a large module |
| File diagnostics | `ue-clangd diagnostics` | same; no IDE needed; 0 diagnostics on a freshly generated database |
| Compile database refresh | `ue-clangd index` | a UBT action-graph build; 181 s and 39,917 commands measured |
| Breakpoint capture | `ue-lldb capture` | a VS Code window start plus the filtered PDB load; the first run also copies the C/C++ extension (about 270 MB) |

## 7. Limits and follow-ups

- **Not a refactoring tool.** Rename, signature change and safe delete stay in Rider (or a later change
  to `clangd`'s rename/code-action support). This document replaces search, navigation, diagnostics and
  breakpoint capture.
- **One configuration at a time.** The database describes the editor target's `Development` flags;
  client, server or shipping configurations need their own database, for example under `--target`.
- **Indexing is engine-wide only if you ask for it.** The default target is the project's editor, which
  still includes the engine modules it links; a project-only database via `--include` indexes faster but
  makes `workspace/symbol` blind to engine functions that no project file includes.
- **Windows-first.** Paths, PDBs and `cmd.exe` are what the project builds today; the scripts isolate the
  toolchain lookup so another platform can be added without touching the query work.
- **Live editor capture still shares one editor.** An agent attaching to the editor holds it just as a
  build does; the editor lease in [014 Editor occupancy](014-editor-occupancy.md) still governs who runs.
- **UE formatters are unavailable in this adapter build.** Importing the engine's
  `UEDataFormatters.py` aborts lldb-dap (`0xC0000409`, no stderr); `--formatters <file>` exists for a
  build where it works. Until then, UObject fields are read as raw values and addresses.
- **Workspace symbols may stay empty.** A 2-minute `warm` wrote no shard files on this installation,
  and `workspace/symbol` returned results only for an opened translation unit in an earlier probe.
  Treat `symbol` as best-effort until this clangd build's index persistence is understood;
  `definition`, `references`, `hover` and `diagnostics` do not depend on it.
- **Breakpoints need VS Code and its C/C++ extension.** The capture opens a short-lived VS Code window
  with its own profile and a cached copy of `ms-vscode.cpptools`; the person's own window is not reused.
  A launched editor is verified; attaching to an editor that someone else started is still unverified.
  Use a function breakpoint (`--break-func`) with `--symbols` for the modules in the call path, and
  `--terminate` for an editor the capture started. Without VS Code (or without `code` on `PATH`),
  `auto` falls back to `lldb-dap`/`lldb`, which do not debug the editor here: the engine LLDB aborts on
  the editor PDB type completion (`0xC0000409`; `lldb -b` crashed with `0xC0000005` after
  `Class ... does not have a complete definition` errors), so those fallbacks remain for ordinary
  clang-cl programs only.
- **A CLI attach timeout can leave the target stopped.** Killing `lldb` mid-attach may leave the
  debuggee suspended; keep the timeout short and stop the process afterwards when that happens.
- **Verification.** `tests/ue-native.spec.ts` covers framing, argument building, URI/position conversion
  and result shaping; `tests/ue-vscode.spec.ts` drives the VS Code extension against a DAP-shaped mock
  (real `stopped` events, function breakpoints, failed captures). The live checks are the commands in
  sections 4 and 5 against a real workspace; see [022 Verification fixtures](022-verification-fixtures.md)
  for how evidence is recorded.
