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

A Ticket is placed when it is accepted, from the leases it declares. A Ticket whose assessment named no paths never enters the pool at all: it runs in its own `work/<name>` directory, read-only toward the shared tree, so an analysis Ticket neither waits for a slot nor blocks a code Ticket that needs the tree.

1. Prefer a workspace with a free slot and no lease overlap. Its own lease then joins that workspace's active set.
2. If every free slot overlaps, wait. A queued ticket is launched when a peer delivers or stops, exactly like a ticket waiting for a slot does today.
3. If a second workspace exists and only it can take the lease, the Executor uses it. That is the escape hatch for work that genuinely cannot share: a second physical project with the same shared engine, not a second copy of everything.

Lease overlap is a prefix test in both directions: `Source/A/` overlaps `Source/A/B.cpp`, and `Source/` overlaps everything under it. An empty lease means the whole workspace and would exclude every other ticket, which is why the Executor keeps such a Ticket out of the pool instead of placing it.

## 3. Where a lease comes from

The assessment that accepts a Ticket also records the paths it expects the change to touch, because it has the bug text and the repository in front of it:

- a bug that names a file or a test gives the directory of that file;
- a bug that names a subsystem without a file gives the subsystem's directory when the assessment is confident, otherwise nothing;
- nothing named, or not confident, is an empty lease: that Ticket runs outside the pool, in its own directory, and never claims the shared tree. Two workers in one file is not acceptable; an analysis Ticket does not need the tree to begin with.

The lease is stored on the Ticket (`execution.lease`), so the panel, the follow-up turns and a resumed assignment all see the same set.

## 4. Peers

Every worker's environment names its lease, and its launch message names its peers:

| Where | Value |
| --- | --- |
| `DSH_SUPERAGENT_LEASE` (environment) | The Ticket's leased paths, space-separated; empty means the Ticket is outside the pool and writes only in its own directory |
| `peers` (launch message) | One entry per peer: `{ ticket_id, title, lease }`, the tickets running in the same workspace right now |

A worker that needs a file outside its lease does not take it: it reports the need in its result, and the assessment either widens the lease (when the peer holding the path delivers first) or splits the work into another ticket. A worker may read anything in the workspace; the lease governs writes.

## 5. p4 under a shared workspace

A workspace has one p4 client, created once, not one per ticket:

- a Ticket's edits go into its own changelist: `p4 change -i`, `p4 reopen -c <CL> <its files>`, `p4 shelve -c <CL>`;
- after shelving, the Ticket keeps its files and edits in the workspace instead of reverting them, so a person can test the change and the next round continues from the same edits; the lease, not a clean tree, keeps peers off those paths;
- a worker never runs a whole-workspace `p4 sync`, `p4 submit`, or a `p4 revert` without `-c`: those are the commands that would disturb a peer. Once its changelist has been submitted, it syncs only its own files to the new revision and opens a new changelist for follow-up work.

The engine stays shared: it is mounted in the workspace as the same directory every time, and no ticket may write outside its lease, which never includes the engine's `Intermediate` or `Binaries`.

## 6. What exists today

| Part | Status |
| --- | --- |
| Lease overlap and placement, as pure logic (`src/executor/workspace.ts`) | Implemented and tested (`tests/workspace.spec.ts`) |
| Workspace pool in settings (`executor.workspaces`), slots per workspace | Implemented |
| Lease declared by the assessment (`paths` on the accept outcome, `execution.lease`) | Implemented, and told to the worker as `DSH_SUPERAGENT_LEASE` |
| Placement wired into the Executor's launch path, waiting when it cannot place | Implemented: a launch that cannot place throws `Later` and is re-queued |
| A Ticket that named no paths stays out of the pool | Implemented: `claimsWorkspace()` keeps it in its own directory, with no slot and no p4 client |
| Peers in the launch message (`peers`) | Implemented |
| One p4 client per workspace, created once, rooted at the workspace directory | Implemented: `workspaceClient()` names it, and the p4 prepare runs only for a pooled workspace whose directory does not exist yet |
| A ticket keeps its own changelist in the shared tree and leaves its edits in place after shelving | Instructed in the assignment; not enforced by a shim |
| Second physical workspace with a shared engine | Configurable in the pool, not yet exercised on this machine |

A queued placement is re-tried by the queue's retry, not by an immediate wake-up when a peer delivers; that delay is acceptable because launches are already serialized by worker slots.

Until the pool exists, the `p4` backend is configured for one workspace and runs one ticket at a time, because a second concurrent ticket in the same directory is the failure this document is about.

