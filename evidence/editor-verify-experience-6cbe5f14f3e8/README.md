# Acceptance page: where a change lives, and whether the running editor has it

This is the Before/After evidence for the editor/verification ticket `editor-verify-experience-6cbe5f14f3e8`.

- **Before**: the deployed build `cb2d8c3` (`deploy-main`, 2026-11-06 13:52 +08:00), the version the person was looking
  at when they reported the problem.
- **After**: this branch's build.

Both images are the real Superagent panel served by an isolated DSH Web lab profile over the same synthetic state:
one delivered p4 Ticket waits for local verification (`CL 590001`, Swarm review `590002`, workspace
`C:/demo/tickets/verify-editor`), the workspace has one successful build job that started after the delivery, and the
Ticket's package names the local repro case `lab-aim-exit`. Every Source is off and processing is paused, so the page
can neither receive nor deliver anything; the state holds no private Feishu content. Viewport 1920×1080, dark theme;
the ticket page is 960 px wide in the panel layout.

- `before-ticket-verify.png` / `before-ticket-verify-facts.json`: the old gate shows CL, review, delivery time and the
  changed files. It does not say which workspace the change lives in, which p4 client owns the shelf, or whether the
  running editor has loaded it.
- `after-ticket-verify.png` / `after-ticket-verify-facts.json`: the gate adds **工作区** and **交付到** (the delivery
  backend, target and, under p4, the client), and one line for the running editor. In this capture no interactive editor
  runs, so it reads `已编译，编辑器未运行 · 编译于 52分钟前`; a running editor makes it `当前编辑器已包含本单` or
  `需重启编辑器加载`, inferred from the build and process start times.

The "loaded" and "restart" states depend on the start time of a live editor process. They are covered by
`tests/editor-readiness.spec.ts`, not by this capture, because the lab starts no editor process (the shared machine's
editor belongs to the production slot and is not started for screenshots).

The capture script and the lab profile stay outside the repository in the ticket directory's `lab/`; only the images and
the facts JSON are committed.
