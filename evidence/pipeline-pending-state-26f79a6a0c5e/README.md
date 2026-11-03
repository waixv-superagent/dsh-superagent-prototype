# A delivered pull request waits at the pipeline gate

Captured on 2026-11-03 from the live Superagent panel, 概览 → 看板, headless Chromium
(`--headless=new`), viewport **1344 × 1400 CSS px at DPR 2**, dark theme, one phase per page load
from the same browser profile, so the two sides share the theme, the locale and the layout.

The Ticket under test is `b05e393b…`. Its worker reported ready after it had opened the Ticket's
pull request, so the person should find it waiting at the pipeline gate (流水线 · 待你处理), not in
待你决定 · 待验收.

| | Before | After |
| --- | --- | --- |
| board lane | 待你决定 (3 件) | 流水线 (3 件) — the Ticket moves across, 待你决定 drops to 2 |
| status tag | 待验收 | 待你处理 |
| Ticket page | report 「报告已就绪，等你验收」, no gate | gate 「只差你确认，不算阻塞」 |
| gate actions | — | 标记已入库 · 继续跟进 · 打开 review |

`before-board.png` / `before-ticket.png` and `after-board.png` / `after-ticket.png`. The outlined
card in the board captures is the Ticket under test.

## Both sides render the same restored snapshot

While this evidence was being prepared, the deployed host noticed that the Ticket's pull request
(26) had merged and ended the Ticket as `merged` — a minute after the report, and before this
comparison could be captured. The live panel therefore no longer holds the state under test.

So both captures render one `sqlite3` backup of the live database with exactly two changes to that
Ticket: its `ended` record removed, and the `closed` field removed from its own follow of
`github:26`. Everything else — every other Ticket, lane, time and number — is the live database as
it was.

- **Before** is the deployed panel with the repository's pre-change server views: the installed
  `dsh-superagent` client module the host serves (requested unchanged, not spliced) and the
  `overview()` / `ticketDetail()` of `origin/main` at `426f8e4` — the commit this branch is based on —
  from the `before-repo` worktree, over that snapshot.
- **After** is this branch: its built client module (`lib/client.js`, 587 651 bytes, SHA-256
  `e705068b…`) spliced into the served plugin bundle in place of the `dsh-superagent` registration
  only, and this branch's `overview()` / `ticketDetail()` over the same snapshot.

For both phases the two panel responses (`GET orchestrator/api/overview`, `GET
orchestrator/api/tickets/b05e393b…`) were answered locally; every other request (state polling,
health, flow) went to the live host unchanged. The deployment was not restarted, and its files
were not modified. The capture scripts live outside this repository; they measure the redaction
rectangles from the render, not from the images.

## Masking

Ticket titles, report bodies, thread names, people, CL and review numbers, backlog counts and the
Ticket's history are covered with solid blocks; the Ticket's own title is covered like any other.
What stays readable is the panel's own furniture: the tab and segment bar, lane names and counts,
status tags (待验收, 待你处理, 待回答, PR 已合并), the aggregate figures, the buttons, and the gate's
title, copy and actions. Nothing from a Feishu message is identifiable.
