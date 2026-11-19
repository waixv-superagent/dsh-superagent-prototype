# 011 — Task center: workspaces, leases, and peers

One machine hosts one mainline workspace large enough that a second copy is impractical. Tickets therefore cannot each own a physical workspace, and they also cannot all share one blindly: two workers editing the same file in the same directory would overwrite each other.

This document describes the task center that sits between Tickets and the Executor: it places a Ticket in a workspace, grants it a lease over the paths it may write, and tells every worker which peers share its workspace.

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| Workspace | A physical directory plus the p4 client that maps it. The unit of isolation on disk |
| Slot | One worker that may run inside a workspace at the same time |
| Lease | The path prefixes a Ticket is allowed to write while it runs, such as `Source/Game/Tests/Performance/` |
| Peer | Another Ticket holding a lease in the same workspace at the same time |

A lease is a promise, not a sandbox: nothing stops a worker from writing outside it. It exists to place tickets and to tell peers what not to touch, and the reviewer sees the shelved changelist if a worker breaks it.

## 2. Placement

A Ticket's Execution pins the workspace it works in. Under the `p4` backend that is the task centre's **default
workspace** — the first one configured in `executor.workspaces` — so Sun source Tickets implement and verify in the
mainline tree and client a person already uses, instead of in a private copy of it whose per-ticket client the prepare
command would have to create. A Ticket with no configured workspace, such as a `git` Ticket, keeps its own `work/<name>`
directory.

A Ticket's lease then decides what runs beside it: an empty lease is the whole workspace, so a Ticket that named no paths
waits for that workspace to be free and runs alone, while a Ticket that named paths may run beside peers whose leases do
not overlap it. A `git` Ticket that named no paths never enters the pool: it runs in its own directory, read-only toward
the shared tree.

1. The pinned workspace must have a free slot and no running lease overlapping this ticket's; otherwise wait. A queued
   ticket is launched when a peer delivers or stops, exactly like a ticket waiting for a slot does today.
2. Without a pinned workspace, prefer the first workspace with a free slot and no lease overlap. Its own lease then joins
   that workspace's active set.
3. A second workspace is the escape hatch for work that genuinely cannot share: a second physical project with the same
   shared engine, not a second copy of everything. A pinned Ticket never moves to it.

Lease overlap is a prefix test in both directions: `Source/A/` overlaps `Source/A/B.cpp`, and `Source/` overlaps everything under it. An empty lease means the whole workspace and would exclude every other ticket, which is why a `git` Ticket that named no paths stays out of the pool instead of serializing it.

## 3. Where a lease comes from

The assessment that accepts a Ticket also records the paths it expects the change to touch, because it has the bug text and the repository in front of it:

- a bug that names a file or a test gives the directory of that file;
- a bug that names a subsystem without a file gives the subsystem's directory when the assessment is confident, otherwise nothing;
- nothing named, or not confident, is an empty lease: a p4 Ticket still works in its pinned default workspace, but waits for the workspace and runs alone there, because an empty lease is the whole workspace. A Ticket with no pinned workspace stays in its own directory and never claims the shared tree. Two workers in one file is not acceptable.

The lease is stored on the Ticket (`execution.lease`), so the panel, the follow-up turns and a resumed assignment all see the same set.

A lease also grows without another decision from the person who approved the work:

- a plan that changes a shared workspace declares `paths`, the workspace-relative prefixes it will write (docs/012 §2); approving the plan merges them into `execution.lease`, so the one approval that opens implementation also places the paths it named;
- a path the worker needs later is a lease re-request: `orchestrator_report` carries `lease` with the prefixes, and the host merges them itself and returns the new lease in the report's result. A lease is placement, not another authorization — the request or plan a person already approved authorized the work — so the re-request never becomes a question for a person;
- a path is normalized to forward slashes without leading or trailing separators, must be relative to the workspace (an absolute path or a `..` segment is refused), and a prefix another entry already covers is skipped. The widening does not stop a running peer that already holds a requested path: the worker sees its peers in the launch message and avoids them, and the next placement of either ticket treats the overlap as a conflict and waits like any queued Ticket.

## 4. Peers

Every worker's environment names its lease, and its launch message names its peers:

| Where | Value |
| --- | --- |
| `DSH_SUPERAGENT_LEASE` (environment) | The Ticket's leased paths, space-separated; empty means the whole workspace: a Ticket with a pinned workspace waits for it and runs alone there, and a Ticket without one writes only in its own directory |
| `peers` (launch message) | One entry per peer: `{ ticket_id, title, lease }`, the tickets running in the same workspace right now |

A worker that needs a file outside its lease does not take it: it reports the lease re-request, which the host merges into the lease (when a peer holds the path, the next placement waits for it) or, when the work belongs elsewhere, splits it into another ticket. A worker may read anything in the workspace; the lease governs writes.

## 5. p4 under a shared workspace

A workspace has one p4 client, created once, not one per ticket:

- the client is the workspace's configured `p4Client` (else the template and the workspace id), so a workspace that names a person's own client lets their P4V list the Tickets' pending changelists, and the edits in the tree are the ones a build or the editor sees;
- a Ticket's edits go into its own changelist: `p4 change -i`, `p4 reopen -c <CL> <its files>`, `p4 shelve -c <CL>`;
- after shelving, the Ticket keeps its files and edits in the workspace instead of reverting them, so a person can test the change and the next round continues from the same edits; the lease, not a clean tree, keeps peers off those paths;
- a worker never runs a whole-workspace `p4 sync`, `p4 submit`, or a `p4 revert` without `-c`: those are the commands that would disturb a peer. Once its changelist has been submitted, it syncs only its own files to the new revision and opens a new changelist for follow-up work.

The engine stays shared: it is mounted in the workspace as the same directory every time, and no ticket may write outside its lease, which never includes the engine's `Intermediate` or `Binaries`.

## 6. What exists today

| Part | Status |
| --- | --- |
| Lease overlap and placement, as pure logic (`src/executor/workspace.ts`) | Implemented and tested (`tests/workspace.spec.ts`) |
| Workspace pool in settings (`executor.workspaces`), slots per workspace | Implemented; the first workspace is the default one |
| A p4 Ticket's execution pins the default workspace, so it works in the mainline tree and client instead of a private copy | Implemented: `ticketExecution()` records the workspace and its directory, and registers the ticket's environment against them |
| Lease declared by the assessment (`paths` on the accept outcome, `execution.lease`) | Implemented, and told to the worker as `DSH_SUPERAGENT_LEASE` |
| A plan's declared paths join the lease when the plan is approved | Implemented: `Plan.paths`, merged by `decidePlan`/`settlePlan`, named in the plan-approved Input |
| A lease re-request widens the lease without a person's decision | Implemented: `orchestrator_report`'s `lease`, applied by `widenLease` in the same transaction as the report |
| Placement wired into the Executor's launch path, waiting when it cannot place | Implemented: a launch that cannot place throws `Later` and is re-queued |
| A Ticket that named no paths | A p4 Ticket runs alone in its pinned workspace, waiting for it first; a Ticket with no pinned workspace stays in its own directory with no slot and no p4 client (`claimsWorkspace()`) |
| Peers in the launch message (`peers`) | Implemented |
| One p4 client per workspace, created once, rooted at the workspace directory | Implemented: `workspaceClient()` takes the workspace's configured client, else the template and its id; the p4 prepare runs only for a workspace whose directory does not exist yet |
| A ticket keeps its own changelist in the shared tree and leaves its edits in place after shelving | Instructed in the assignment; not enforced by a shim |
| Second physical workspace with a shared engine | Configurable in the pool, but a p4 Ticket is pinned to the default one; not yet exercised on this machine |

A queued placement is re-tried by the queue's retry, not by an immediate wake-up when a peer delivers; that delay is acceptable because launches are already serialized by worker slots.

Until the pool exists, the `p4` backend is configured for one workspace and runs one ticket at a time, because a second concurrent ticket in the same directory is the failure this document is about.

