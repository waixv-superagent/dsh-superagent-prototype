# 021 Editor schedule

This document records how dsh-superagent shares one Unreal Editor and its workspace build across Tickets. It implements the lease, queue and human-override phases that [014 Editor occupancy](014-editor-occupancy.md) proposed, adds host-run jobs that batch waiting builds, and reads the editor's own state through ue-mcp's bridge files. The process probe of 014 stays as the safety net that keeps agents away from a person's editor.

## Why

Tickets that verify SunGame changes all need the same things in the same workspace: compile, restart the editor, open it, and run automation tests. Before this, each worker ran `CompileSunGame.bat` or `UnrealEditor-Cmd` on its own. Two builds fought for the module DLLs, a restart killed another worker's PIE run, and the overview could only guess from a tool name that "someone" was using the editor. A person could see the process but not which Ticket held it, for what, or who waited.

## Model

All state is one record, `KV.editor.schedule` (`src/app/editor-schedule.ts`), changed only through pure functions so every decision is testable:

| Part | Meaning |
| --- | --- |
| `lease` | Who holds the editor now: an agent (one Ticket), a host job (one or more Tickets), or a person. It carries a purpose (`build` / `restart` / `test` / `use`), a note, the grant time and an expiry renewed by heartbeats. A person's claim does not expire, and neither does a host job's lease: it ends with the job's process. |
| `queue` | Waits in grant order: a person's claim first, then waits a person moved to the front, then first come first served. A wait is a worker's own request or a host job's. |
| `jobs` | Builds, restarts and tests the host runs, with their Tickets, state, exit code, one-line summary and log path. |
| `events` | The last 200 grants, releases, expiries, preemptions, claims and job ends; the overview's timeline draws lease and wait spans from them. |
| `agentPids` / `yielded` | Interactive editors an agent started under its lease, and those a person said agents may use. Any other interactive `UnrealEditor` reads as a person using it. An editor counts as the agent's only when the lease was taken to open one (`restart` or `use`, or a restart job) and it is the only editor that started since the grant. When two appear, either may be a person's, so neither counts. |

`advance` runs on every change, on the overview's poll and on a 15-second timer. It drops the leases and waits of ended Tickets, expires a lease without a heartbeat, forgets editors that have exited, and grants the head of the queue once nothing holds the editor and no person is using it.

## Priority

1. **A person.** An interactive editor that no agent started, an unreadable probe, or a claim from the overview holds every agent back. The overview's buttons are the person's controls:
   - **我要用 (claim)**: take the editor, ask the agent holding it to save and yield, and make the queue wait.
   - **让 agent 用 (yield)**: the open editor stops counting as the person's, so the queue moves.
   - **我用完了 (release)**: end a claim. An editor the person still has open stays theirs.
   - **请它让出 (preempt)**: ask the holder to yield.
   - **插到最前 (front)** and **移出队列 (remove)**: reorder or drop a wait.
2. **Waits a person moved forward**, the latest move first, so "move to front" always puts that wait first.
3. **Everyone else**, first come first served.

Nothing of a person's is killed. A preempted agent gets a steering message and releases. Its heartbeats cannot push the lease past the five-minute grace, and once the grace runs out the lease lapses. A host job the person preempts or stops is killed, because the host owns that process. Its lease stays until the process has exited, so the next build never starts over a compile still writing, and it reports `cancelled`, never its exit code.

## Worker tool

Workers get `orchestrator_editor` (`src/app/tools/executor.ts`):

| Action | Behaviour |
| --- | --- |
| `acquire purpose note min wait` | Granted at once when free; otherwise queued with a position. It waits up to `wait_seconds`, and a later grant arrives as a message. |
| `heartbeat min note` | Keeps the lease alive through a long step. |
| `release note` | Ends the lease or leaves the queue. The gatekeeper closes the editor, commandlet or build processes the lease started. |
| `close` | Stops the editor, commandlet or build this Ticket's lease started and gives the lease back; the gatekeeper refuses it when the Ticket does not hold the editor. |
| `run purpose filter wait` | Queues a host job. A build waiting in the same workspace absorbs this Ticket instead of starting a second compile, and the worker gets that build's result. A Ticket that holds the editor hands its lease to its own job instead of waiting behind itself. The result, including a log tail, comes back when the job ends within the wait or as a message later. |
| `capture window` | Requires this Ticket's lease. Lists the editor's top-level Slate windows, brings the one whose title contains `window` to the front (the active window when omitted), and stores a PNG of it with a JSON sidecar under `<stateDir>/evidence/<ticket>/` (docs/027). The pixels are the editor's own Slate rendering, so the capture still works while the desktop is locked. |
| `status` | Shows the holder, the queue, this Ticket's jobs and ue-mcp's reading. |

The worker prompt asks for a lease before a worker opens, builds, restarts or tests, and prefers `run` so builds batch. A call that bypasses the lease is not silently lost: the status names the `blocked` reason and the editors the probe sees, and the guard below reports and stops an editor a worker starts without its lease.

## Enforcement

The worker prompt is the rule; `EditorGuard` (`src/app/editor-guard.ts`) makes it hold. The host already receives every worker Session event, so the guard reads each `pwsh`/`bash` call's command text when it starts:

- **A launch** (`& "…\UnrealEditor.exe"`, `Start-Process`, `cmd /c`, and the headless or `UnrealBuildTool` equivalents) requires the matching lease at that moment: `use` or `restart` for the interactive editor, `use`, `test` or `restart` for a headless commandlet (an automation run's natural lease is `test`), and `build` for a compile. Without it, the guard watches the process table for a few seconds, matches the process by the executable path the command named and a start time not older than the call, and stops that process tree. The editor has not finished loading at that point, so nothing is lost; the Ticket gets a steering message and the schedule records a `bypass` event visible on the overview.
- **A stop** (`taskkill /PID`, `Stop-Process -Id`, or an image-name kill) aimed at an editor the Ticket did not start is recorded and reported. Only a pid the last probe saw as an editor process counts, so a worker stopping its own job is not an editor stop. The process is already gone by the time the event arrives, so the guard cannot undo it; the rule and the report are what keep it from happening again.
- **Only evidence counts.** A command that merely names an editor path (`Get-Item`, `Test-Path`) starts nothing and is not a violation, because the guard acts only on a new process that matches. A person's Rider or Explorer launch, an MCP tool call and a subagent Session are outside the guard.

## Gatekeeper

The scheduler decides who may use the editor and the guard reads a worker's shell calls; neither owns the editor's operating-system processes. The gatekeeper (`src/app/editor-gatekeeper.ts`) does. It is a resident loop of its own (5 s, independent of any worker call), keeps the processes each lease started in `KV.editor.gatekeeper`, and runs even when nobody touches the editor.

- **Ownership.** An allowed launch the guard matched to a worker's shell command is handed to the gatekeeper with its exact pid, executable and start time. What the guard cannot see — a batch script that starts the build inside itself, an MCP tool, a subagent — is read from the process table for the current lease: one new interactive editor for `use`/`restart`, the headless commandlet for `test`, and UnrealBuildTool/ShaderCompileWorker for `build`. A `use`/`restart` lease also adopts the interactive editors the scheduler already attributes to an agent (`agentPids`), such as one a restart job opened or a previous lease left open, so they close with the lease too.
- **Heartbeat reclamation.** When a lease's `expiresAt` has passed, its Ticket ended, or it was released, the gatekeeper stops the processes the lease owns, records the reclamation on the schedule (the lease's expiry, ended or release event, or a `reclaimed` cleanup event when the lease was already gone), tells a live holder whose heartbeat lapsed, and lets the scheduler grant the next waiter. It only stops a pid the probe still reports as the same process (same start time); a person's editor, a yielded one and a recycled pid are left alone.
- **Start and stop.** A launch needs the matching lease; the guard stops one without it. `orchestrator_editor op=close` is the gated way for a holder to stop what its lease started before giving the editor back, and the gatekeeper refuses it when the caller does not hold the lease. A person's preempt or claim still drains the holder first; the gatekeeper closes the lapsed holder's processes after the grace. A host job's lease still ends with its process, which the scheduler already stops; the gatekeeper owns the processes a worker's own lease starts.
- **Collection stays scripts.** The process probe, the ue-mcp bridge files and the job logs stay read-only inputs. The gatekeeper never reads a log and never calls the editor's game thread.

The gatekeeper's health entry (`editor-gatekeeper`) says how many processes belong to a lease and how many were reclaimed, so a stuck slot is visible on the overview instead of waiting for a person to notice.

## Host-run jobs and batching

`EditorScheduler` (`src/app/editor-scheduler.ts`) runs a job once its wait is granted. It uses the command configured under Execution settings → editor:
| Setting | Meaning |
| --- | --- |
| `project` | The `.uproject` path. ue-mcp's bridge files are read beside it, and `<project>` in a command is replaced with it. |
| `build`, `restart`, `test` | Shell commands. `<dir>` is replaced with the Ticket's workspace and `<filter>` with the automation filter. An empty command makes that job kind unavailable, and workers fall back to a lease plus their own command. |

When a build is granted, every other build waiting for the same workspace is folded into it. One compile then serves every delivered change waiting to be verified, and each Ticket receives the same result. Output goes to `<stateDir>/editor-jobs/<job>.log`. The summary is UBT's `Result:` line, the automation pass/fail count, or the exit code with the last line. The host records each job's pid. After a restart, a job whose process still runs is stopped and keeps the editor until it has exited. A job whose process is gone reads as `interrupted`. A worker's test filter may only hold letters, digits, spaces and `. _ + - : /`, and a workspace path with command-line syntax characters is refused, so neither can break out of the configured command.

## ue-mcp as a second source

`src/app/editor-mcp.ts` reads `Saved/UE_MCP_Bridge/status*.json` and `instances/*.json` beside the configured project. The plugin's writer thread flushes these files even while the game thread is blocked. The overview therefore shows details the process probe cannot see:

- the startup phase or `ready`
- a dialog blocking the engine
- a stalled game thread
- a slow task with its progress
- shader and asset compiles
- the bridge request in flight
- how many bridges are up

A snapshot older than 30 seconds, or one from a dead process, is reported as stale rather than current. These are file reads only. The host never calls the editor's game thread.

## Overview

The editor view gains a schedule card between the hero and the timeline:

- the holder sentence ("<Ticket> 正在跑测试 · 01:12 起"), the lease note and expiry, and the person's buttons
- ue-mcp's reading of the editor
- the queue in grant order, with front and remove
- the jobs, with batched Ticket counts and a stop button for a running job

Every Ticket named in the card opens its Ticket page, where the person sees what the worker is doing now: a single
holding Ticket makes the whole sentence the entry, and a wait or job that covers one Ticket opens it from anywhere in
its row, with front, remove and stop keeping their own action. A batched entry lists each Ticket as its own entry, so
one row never has to guess which Ticket of the batch the person meant.

Working rows show "占用中 · 跑测试" or "排第 2 · 编译". The timeline gains lease spans (labelled by purpose) and dashed wait spans per Ticket.

## A person's compile and launch

The editor page carries the person's own one-click path, composed the way Rider lists its run configurations, so a
compile-and-launch does not require Rider (docs/005):

- **Paths first.** Execution settings → editor holds the **工程路径** (`.uproject`), the **引擎目录** (the directory holding
  `Engine/`) and an optional **编辑器可执行文件** for a non-standard install. With the project and the engine, the panel
  derives `Engine/Build/BatchFiles/Build.bat <target> <platform> <configuration> -Project=<project> -WaitMutex` and the
  editor binary (Win64/Mac/Linux) plus the project; a path that is configured but missing is refused before anything runs.
- **Target names** are configured under the same settings → **目标名**: one Unreal target per line, such as `SunGame` and
  `SunGameEditor`. The **build** and **restart** commands are optional overrides: when set, `<target>`, `<configuration>`,
  `<platform>`, `<project>` and `<dir>` are filled into them per run; when empty the derived commands above are used.
- **Rider's combination.** A run configuration is configuration (`Development`, `DebugGame`, `Shipping`) × type (Editor
  or Game, from the target's `Editor` suffix) × target (`SunGameEditor`) × platform (`Win64` on Windows, `Mac` on macOS,
  `Linux` otherwise). Its name follows Rider: `Development Editor SunGame`, `Shipping Game SunGame`.
- **Only the choice a person changes.** The card leads with one **运行配置** picker and 编译并启动; the configuration,
  target, platform fields and the command templates sit behind **自定义组合**, so the common path stays one select and one
  click.
- **One at a time, under the shared slot.** `BuildRunner` (`src/app/build-runner.ts`) composes `build && launch` and runs
  it as one host process with its output under `<stateDir>/build-logs`. It refuses while an agent or a host job holds the
  editor, claims the person's slot for the run (so the scheduler cannot grant it away mid-build), and gives the slot back
  when the process ends. A run the host started survives in `KV.build.runs`; the next host marks it `interrupted`.
- **Visible.** The card shows the run's live output tail, the exit code and the last runs, with Stop while it runs.
- **Not a lease bypass.** The card is a person's action through the host, not a worker's shell call; the gatekeeper never
  owns its process, but the scheduler's slot is held, so agents stay out.

## Limits

- **A launch is seen as a shell call or as a new process.** The guard reads worker shell calls; the gatekeeper reads the process table for the current lease, so a batch script, an MCP tool or a subagent that starts the editor under a lease is owned too. A launch outside every lease that leaves no process the probe recognizes still escapes both, and so does a person's own editor, which is never adopted. A fresh editor that cannot be told apart from a person's (two new editors under one lease) is not adopted rather than risk stopping a person's; an editor already listed in `agentPids` is an agent's by the scheduler's own rule and is adopted with the lease.
- **A process is known by its path and start time.** The guard matches the process whose path the command named and which started at or after the call; the gatekeeper refuses a pid whose start time changed. A person opening that same executable would still be a person's editor, which is why the guards leave an ambiguous launch alone.
- **A lapsed lease closes what it started.** Releasing, ending a Ticket or letting the heartbeat lapse ends the lease, and the gatekeeper stops the editor, commandlet or build tools it owns. A worker that wants to keep the editor open must keep the lease and heartbeat; nothing is left to the next holder.
- **One editor slot.** The schedule has a single lease. Several workspaces would each need their own slot, which `editor_slot` in 014 anticipated.
- **No time windows.** A person can claim the editor now but cannot reserve a window ahead of time.
- **Command quality.** Batching assumes the configured build compiles the whole workspace. A per-Ticket build that only compiles one module should not be configured as `build`.

