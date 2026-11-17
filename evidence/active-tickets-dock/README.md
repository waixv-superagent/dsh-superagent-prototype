# Active-Tickets dock: before and after

The dock is the plugin's browser UI, so both captures come from the real DSH Web shell rendered by an isolated lab
profile of this deployment, not from a mockup. The lab runs the DSH 0.2.2-alpha.3 packages and a copy of the live
orchestrator database (266 Tickets, processing paused and every Source disabled, so nothing can run). The app, the
shell, the plugin's client bundle and the `GET overview` path are real; the copy's Ticket titles were replaced with
`示例：…` labels so no private work titles leave this machine, and the panel body was left on the new-Session page.

- **Before**: `origin/main` at `29238f0`, built with `pnpm build` and served as the profile's `dsh-superagent`
  package. The frame-wide bottom strip is empty (`before.png`).
- **After**: this branch, same lab home, state copy, viewport, theme and page; the only difference is the
  `dsh-superagent` build (`after.png`).

Both captures: headless Chrome (`--headless=new`), **1800 × 1100 CSS px at DPR 1**, dark theme, no browser chrome or
scrollbars. `before-dock-detail.png` / `after-dock-detail.png` are 2× crops of the same bottom 120 px, so the strip
is readable.

The after strip reads `活跃工单 · 6`, then one chip per active Ticket with its state glyph (spinner while a worker
runs, otherwise a dot), title, quiet stage (执行中 / 排队中 / 等待新触发), and age; the Tickets waiting on a person
carry the amber stage pill (待回答, 待你验证, …). `看板` at the right opens the panel's board. A row is one button:
it switches to that Ticket's worker Session and falls back to the Ticket page when DSH does not list the Session;
the small icon at the row's end always opens the Ticket page. The strip scrolls sideways; the amber sliver at the
right edge is the next (partly visible) person-stage row, not a button. It disappears entirely when no open Ticket
has recent activity.

The lab profile, the copied state and the capture commands are under this Ticket's `lab/` directory on the worker
machine and are not committed, because they point at that machine's live deployment. To reproduce: build the branch,
point an isolated DSH profile's `dsh-superagent` dependency at the built package, give it a paused copy of the
orchestrator database, start that lab host on another port, and capture the same URL at the same viewport.
