# 013 — Agent Teams and the ticket board

Status: draft, nothing below is implemented. Written 2026-11-02 after measuring `@deepseek-ai/dsh-experimental-agent-team@0.2.1-rc.5` against the harness this deployment runs.

The question this document answers: a worker that manages sub-agents has no place to see *all* code tasks at once — which depend on which, what may run in parallel, what is waiting and why. Upstream Agent Teams ships a shared task DAG, but only inside one Team. This document records what upstream actually provides, why it does not reach our tickets, and the cheapest way to get the board we need.

## 1. What upstream ships

| Fact | Measurement |
| --- | --- |
| Packages | `@deepseek-ai/dsh-experimental-agent-team` (roster, peer messaging, shared task DAG) and `@deepseek-ai/dsh-experimental-tool-agent-team` (the nine model-visible tools) |
| Version | `0.2.1-rc.5`, peer-pinned to the harness we run; `latest` on npm is an older `0.1.5-alpha.2`, so an unpinned install silently mismatches |
| License | MIT, in the `deepseek-ai/deepseek-harness` monorepo under `packages/experimental/` |
| Scope | One implicit Team per root Session. No nested teams, no cross-Team view |
| Storage | Durable in the session (persistence service), projected as `team/member` and `team/task` events |
| Board UI | `dsh-client-ui-agent-team` is **not published** (npm 404); the projection is there for a UI to render, but we would write that UI |

The task semantics upstream are small enough to copy: `ready` is `status === 'pending' && every blockedBy is completed`, and the only advisory warning is a path-prefix overlap between `writeScopes` of tasks in progress. There is no priority, no resource lock, no ownership release on idle, and `writeScopes` never blocks a write — the same "lease is a promise, not a sandbox" stance as our own task center (see 011).

Verified end to end on a scratch profile, not inferred from the README:

| Call | Observed result |
| --- | --- |
| `spawn_teammate(reviewer)` | member created, `provisioning → active`, ran its own turn, then `inactive` |
| `team_task_create` | `task-1`, `pending`, `ready: true`, `blockedBy: []` |
| `team_task_list` | returns the board with `ready` and `writeScopeWarnings` |
| `wait_agent(timeout_ms: 10000)` | `{"timedOut": false}` — edge-triggered on the teammate's message |
| `list_agents` | lead plus teammate, with status and model |

Two deployment details that cost time and are worth keeping (appendix A): the team tools reuse the model-visible names `send_message`, `list_agents`, `interrupt_agent`, so the old continuable-control entries must be disabled; and patch entries that insert new plugins need an `insert:` list, not `id` + `name` (the latter is only an override and is skipped when the id is unknown).

## 2. The gap

A Team is a *root Session* and its durable task DAG. Our Tickets are independent root Sessions, each with its own worker, its own lease, and its own lifecycle. Three consequences:

1. A ticket's board lives inside that ticket's session. The Router has no read of it, so it cannot say "these two are blocked on the same file" or "this one may start now".
2. A worker that spawns children gets a roster, not a board: the children are members, their work is invisible unless someone registers it as a task, and upstream explicitly does not support a Team inside a teammate.
3. Priority does not exist. Upstream's `ready` is binary; nothing expresses "this hotfix outranks that refactor", and nothing carries a *reason* for waiting.

The board we actually need is ticket-level, cross-ticket, and readable by the Router: dependencies between tickets, priority, a ready set, and a waiting reason per queued ticket.

## 3. Two ways to close it

### 3.1 Option A — Router as Lead, tickets as teammates

One long-lived Router session is the Team Lead; each accepted ticket becomes a teammate with one team task carrying its lease as `writeScopes`.

| Team concept | Our concept |
| --- | --- |
| Lead | Router session |
| Teammate | Ticket worker |
| `TeamTaskSnapshot` | Ticket |
| `blockedBy` | Ticket dependency |
| `writeScopes` | `execution.lease` |

It fits our single-process, shared-checkout constraint for the same reason upstream accepts it: no worktree, no merge. It reuses the tools and the projection, and `wait_agent` gives the Lead a natural wake-up.

It fails on three points. Our orchestrator is a plugin, not a resident root session, so being a Lead means restructuring the Router into a session that stays alive and owns the whole ticket lifecycle — a much larger change than the board itself. The Team is flat and nested Teams do not exist, so a worker's own sub-agents still cannot appear on the board. And every board operation becomes a model turn: the Router would ask its own session for state it already holds in SQLite.

### 3.2 Option B — carry the task DAG into the orchestrator (recommended)

Keep the Team concept out of the runtime and copy the *schema*:

- `ticket.execution.blockedBy: string[]` — ticket ids that must deliver first.
- `ticket.execution.priority: 'hot' | 'normal' | 'low'` — an ordering input, not a guarantee.
- `ticket.execution.waitingReason` — `blocked | overlap | slots | human | none`, derived, never stored.
- `ready(ticket) = queued && every blockedBy delivered` — a pure function over the ticket table, the same shape as upstream's `taskReady`.
- Parallel admission = `ready && no lease overlap with a running ticket in the target workspace && a free slot`, which is `overlap()` in `src/executor/workspace.ts` plus the slot check the Executor already performs.

The board is then a read of one table, not a model conversation, and the Router can include a compact digest in its context ("ready: 3, blocked: 1 (on 822033bb), waiting for slot: 1") without spending a turn.

Why this is the cheaper path: the lease and overlap machinery already exists and already means what `writeScopes` means upstream; the panel already renders the ticket table; and the two pure functions we would add are the two upstream ships (`taskReady`, `scopesOverlap`), which is evidence that the semantics are small.

## 4. Data model (draft)

| Field | Where | Notes |
| --- | --- | --- |
| `blockedBy` | `ticket.execution.blockedBy` | Written when an assessment splits a ticket into parts; must be acyclic; validated on write |
| `priority` | `ticket.execution.priority` | Default `normal`; a human may raise it; the assessment may not lower it |
| `waitingReason` | derived | Not stored, so it cannot go stale |
| `revision` | existing ticket revision | Every board mutation is a compare-and-set, as upstream does with `expectedRevision` |

A dependency on a deleted ticket is a broken edge: treat it as unsatisfied and surface it on the board rather than silently dropping it.

## 5. Scheduling rules

1. Admission order: ready and unblocked first, then `priority`, then oldest first. Ties are stable so the queue does not reshuffle every tick.
2. Never start a ticket that overlaps a running lease in the same workspace, even when a slot is free — that is the existing rule and the board must not weaken it.
3. A queued ticket always carries a reason. "Queued" without a reason is the failure mode we are fixing.
4. No preemption in the first version. A higher-priority ticket waits for a slot; interrupting a running worker loses work we cannot reconstruct.
5. A dependency is satisfied by `delivered`, not by `running`; a ticket that stops without delivering leaves its dependents blocked and visible.

## 6. Board surfaces

- Panel: `queued / running / waiting / delivered` columns, dependency edges drawn from `blockedBy`, the waiting reason on every queued row, and an overlap warning on a running pair.
- Router digest: a handful of lines per round, not the whole board — ready count, the oldest ready ticket, blocked edges, and any waiting reason that needs a human.

## 7. Rollout

| Phase | Change | Value | Risk |
| --- | --- | --- | --- |
| P0 | Read-only board: derive `ready`, show edges and reasons, change no scheduling | The Router stops guessing | None; no write path |
| P1 | `blockedBy` written by the assessment, enforced at admission | Real dependency ordering | A bad edge stalls a ticket; needs a visible override |
| P2 | `priority` as an ordering input | Hotfixes stop queueing behind refactors | Starvation unless age is a tiebreaker |
| P3 | Optional: a worker registers its own children as subtasks | Nested work becomes visible without nested Teams | Upstream has no nested Team; do not build on it |

## 8. Open questions

- Who assigns `blockedBy`? The assessment knows the split it just made; a human editing the board must be able to add or remove an edge.
- Does `priority` survive a re-assessment? Today an assessment may rewrite execution fields; priority should be sticky across reassessment.
- Do we want a per-ticket board inside the worker's session (upstream tools) at all, or is the panel enough? The measured cost of the tools is a nine-tool surface and a policy block in every worker prompt.

## Appendix A — the configuration that works today

Two packages into a profile whose bundles are `@deepseek-ai/dsh-base` + an app bundle:

```yaml
# cordis.patch.yml
- id: tool-subagent-control      # old continuable control: same model-visible names
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
    - id: tool-agent-team
      name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

The harness version must match the package's peers exactly (`0.2.1-rc.5` at the time of writing); an unversioned install takes npm's `latest`, which is an older alpha.

Separately, `@deepseek-ai/dsh-llm-pi-ai` maps `./src/*` in its `exports` but does not ship `src/` in `files`, so any plugin importing `.../src/config.ts` fails to load. Our local `/ask-gpt` command depended on that path for `resolveProfiles`, which the package defines but does not export. The fix here is a pnpm patch that appends one export line; see `pnpm-workspace.yaml` → `patchedDependencies` in the superagent profile. This is an upstream packaging bug worth re-checking on every upgrade.

