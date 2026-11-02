# 014 Editor occupancy

This document proposes how the overview board should handle tasks that all want the shared editor: waiting, priority, and human intervention. Today the board only observes the editor; it does not arbitrate it. The design below turns the editor into a first-class resource with a lease, a queue, priority with aging, and human override, and keeps the process probe as a safety net.

## Verdict

The board cannot do this today. It has a read-only probe (process table, 15 s cache, four states: person / agent / free / unknown) that answers "who is using it right now", not "who should go first, who waits, or whether a person should interrupt". To support waiting, priority and human intervention, the editor has to become a first-class resource: **lease + wait queue + priority aging + human override**, with the probe demoted to a safety net.

| Question | Today | Design |
| --- | --- | --- |
| Waiting | No queue; workers retry on their own and waits are invisible | Lease + wait queue with visible position, ETA and ahead list |
| Priority | None; whoever probes first runs | P0 person > P1 someone waiting on the result > P2 normal > P3 background, FIFO within a class plus aging, reserved windows |
| Human intervention | A person can only see who holds it; cannot hand over or jump the queue | claim / release / preempt(reason) / reorder / reserve(window) / cancel, all audited |

## Why observation is not enough

- A probe is not exclusion: two workers that both see "free" start at the same time; one fails or they step on each other.
- A person does not take a lock: they just open the editor, so a probe is the only way to notice them — and a 15 s cache with a 5 s timeout leaves a race window.
- There is no queue or priority: workers sleep and retry, which jitters, starves and hides the wait.
- There is no human surface: a person cannot see who waits or ask a running agent to yield.

## Goals and non-goals

Goals: one host, one SQLite database, TypeScript runtime; workers are long-running and can crash; the editor is a GUI a person can open at any time.

Non-goals: a distributed scheduler; killing a person's editor; locking a person out; multi-host GPU scheduling.

## Model

`editor_slot` (one row per editable host / editor instance):

- `id, host, kind, state`
- Lease: `holder_kind (person|agent), ticket_id, session_id, acquired_at, heartbeat_at, expires_at, preemptible, reason`
- Wait queue: `editor_wait (ticket_id, session_id, priority, enqueued_at, requested_ttl, note)`

States:

- `free`: no process and no lease
- `held(person)`: an interactive editor was probed, or a person claimed it
- `granted(agent)`: a fresh lease with a fresh heartbeat
- `draining`: a person arrived or the lease was preempted; the agent saves and exits, never killed
- `unknown`: the probe failed; treat as "a person is using it" (today's behaviour)

## Acquire protocol

Before a worker starts the editor:

1. `POST /editor/acquire {ticket, session, priority, ttl}` (runtime-internal API, called by the worker shim).
2. The runtime decides:
   - a person holds it (probe or claim) -> `refused(person)`, no queue entry, "a person is using it".
   - free and the queue is empty -> grant: write the lease and open the host-level named mutex (`Global\superagent-editor-<host>`).
   - otherwise -> `queued(position, eta, ahead[])`.
3. The worker long-polls the queue; once granted it takes the mutex and starts the editor, then heartbeats; it releases when done.
4. The mutex is the second line of defence: non-cooperating tools (scripts, command lines) cannot enter either; a person does not need to take it.

## Priority and fairness

- **P0 person**: never queues; while a person holds the editor no agent starts; when a person opens the editor the current agent enters `draining` (a grace period to save and exit, never a kill).
- **P1** a ticket someone is waiting on (review, answer); **P2** normal; **P3** background batch.
- FIFO within a class; aging across classes: `score = priority_weight + min(wait/aging_window, max_boost)`, so P3 cannot starve.
- Reserved windows: a person can reserve 14:00-15:00; no agent is granted inside it.
- Default is strict FIFO with the person highest; priority is configurable (some teams only want first-come-first-served).

## Preemption

- A person (probe or claim) can always preempt, through the draining grace period.
- A person can preempt an agent from the board with a reason; same path.
- Agent preempting agent: off by default; configurable (P1 may preempt P2 after X minutes), audited.
- Never kill: draining lets the agent save and exit at its next safe point; if it does not exit in time, mark it blocked and hand it to a person.

## Human intervention

- The editor row shows holder / queue / waiters; "needs your call" cards offer grant / preempt / defer.
- Actions: claim (a person holds it), release, preempt(reason), reorder, reserve(window), cancel.
- Every action is audited (who, when, why) and appears on the timeline.
- A person can queue without blocking: a P1 ticket waiting for the editor falls back to work that does not need it.

## Persistence and failure

- Leases and the queue live in SQLite (the ticket database). After a host restart: leases whose session is gone are released at once; a lease whose heartbeat is stale is reaped after the TTL (90 s, 2x TTL).
- Crash: when the worker session ends the lease dies with it; a host restart cleans up.
- Probe conflict: an agent lease but the probe sees a person -> the person wins and the lease goes to draining; an `unknown` probe -> conservatively refuse the agent.
- Clock: the runtime's monotonic clock; never trust a worker's time.

## OS-level exclusion

- A named mutex or file lock only covers cooperating processes; a person is not bound by it, so the probe remains the only way to notice them.
- The lock lives in the runtime data directory; the OS releases a mutex on crash, which is harder than a database lease but only covers one host.
- Two layers plus the probe: the database lease is the truth across restarts, the mutex stops same-host races, the probe notices the person.

## Observability

- Utilisation, wait time P50/P95, preemptions, starvation alarms (waiting longer than N minutes), queue length.
- Timeline: queue, grant and draining segments.

## Rollout

1. **Observation** (done): read-only probe, four states, one overview line.
2. **Lease + queue**: database tables, board display and alarms; not enforced yet.
3. **Enforced acquire**: workers acquire before starting the editor, the shim intercepts, rolled out gradually.
4. **Human controls**: claim / preempt / reorder / reserve plus audit.
5. **Multiple slots / hosts**: one slot per host.

## Reference patterns

- Kubernetes Lease (TTL, renewal, leader election): https://kubernetes.io/docs/concepts/architecture/leases/
- SLURM priority aging (age contribution): https://scc.dipc.org/docs/jobs/priority/#the-age-contribution
- GitHub Actions concurrency groups (serialise or cancel a single resource): https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- CI resource locks (Jenkins lockable resources and similar) as the same pattern.

## Appendix A: alignment with the Super-agent philosophy

Reference: the Super-agent design exploration from the DeepSeek Harness team, https://www.bilibili.com/opus/1265361021143351318

| Article | This design |
| --- | --- |
| Two layers: a resident Router, isolated Workers, Workers do not talk to people | The runtime (Router side) decides the editor lease and queue; workers only call acquire and receive queued/granted, they never negotiate with each other |
| Event-driven: triggers, fast/slow path, subscriptions and direct pass-through | A release or grant is itself a trigger; the probe is the fast path and the lease decision is deterministic; queue changes pass directly to waiting workers instead of the Router |
| Human-facing interaction: asynchronous, shaped per channel | Preempt and claim are the mid-task human entry point; the board only keeps the cards that need a decision, never progress noise |
| Compute, state and environment separation | The editor, a heavy environment, stays on the host; leases and the queue live in SQLite (state), the loop does not own the editor |
| Watchdog: an external control loop that can edit prompts and trigger rules | Lease reaping (TTL/heartbeat) is the infrastructure watchdog; the self-iterating rules below are it reaching into policy |

The article's central claim is that the bottleneck is moving from execution to human attention, so this design deliberately asks a person only three things: **who goes first, whether to interrupt, and when is it my turn**. Ordering and waiting are the system's job.

## Appendix B: self-iterating intake rules

Today: the rules and the admission table in the Policy are maintained by hand; the Router judges each trigger once and the decisions do not flow back systematically.

Goal: let the **intake rules** iterate under human approval, so a person reviews a diff instead of digging for patterns.

1. **Record**: every trigger gets a decision (accept / ignore / handback / requeue) and a later outcome (ready / blocked / dropped / merged / withdrawn after a wrong accept).
2. **Review worker** (a timed trigger in the Watchdog style, outside the main loop): reads the last N days, looks for four signals - wrong accepts (accepted then dropped), missed accepts (ignored then asked again by the same person), repeated handbacks, wrong drops - and proposes a rule diff (wording, thresholds or examples only; never permission or gates).
3. **Replay offline**: replay the stored triggers through the candidate rules and report "N decisions would change, M of them closer to the final outcome"; a diff that fails replay is not submitted.
4. **Human gate**: a person approves, the Policy version goes up one, the change is recorded; a change budget (for example one per day) and a rollback button.
5. **Safety boundary**: self-iteration cannot change the admission table (who may trigger), cannot bypass the P1 gate, cannot auto-accept a new source; those stay human-only.

Consistent with the article: a Watchdog is an external control loop that can already edit prompts and trigger rules; turning its output into "replay evidence + human approval" diffs is safer than letting a model edit rules directly.

## Appendix C: a creative executor preset

Today: worker sessions use a fixed preset; the model and the prompt are the same for every ticket.

Proposal: pick a preset by the ticket's kind.

- **work (default)**: the current execution preset, for engineering and fixes.
- **create**: for UI/UX, design, copy and proposal tickets. The strongest model (Opus 5.5 class), design tools (screenshots, browser, images, references), a prompt that asks for two or three candidate directions with visual evidence and a self-review, and room for exploratory iteration.
- **Routing**: the orchestrator tags a ticket (design / engineering / ops) and the worker session loads the matching preset; a person can switch it by hand.
- **Unchanged**: acceptance criteria, the evidence rules (before/after), human review, and the delivery contract are identical to `work`. The creative preset changes how a worker explores, not what it must prove.

Consistent with the article: worker sessions usually need the strongest model while the Router layer stays light; the creative preset is a worker capability, not a new scheduling layer.

Rollout: first a preset choice (pure configuration, canary), then automatic kind tagging. Both need plan approval and neither changes the default for existing tickets.
