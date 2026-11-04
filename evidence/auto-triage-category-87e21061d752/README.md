# Ticket kinds on the execution page and the board

Captured from the live Superagent panel (`http://127.0.0.1:3082`) on 2026-11-05 at 01:10–01:11 +08:00, headless Chrome,
viewport 1440 × 1000 CSS px at DPR 1, light theme. Each image is clipped to the panel (execution page) or to the board's
待你决定 lane, the lane whose cards change.

- **Before**: the deployed `dsh-superagent` client (`lib/client.js`, SHA-256 `E53BA276…`, mainline `8c15f79`) and the live
  host responses.
- **After**: this branch's built client (`lib/client.js`, SHA-256 `4CC7D36F…`), spliced into the served plugin batch for
  the capture browser only. The `GET tickets` and `GET overview` responses are the live ones plus the fields this branch's
  host adds: `kind`/`kindSource` per ticket row, computed by the branch's `ticketKind` over a read-only open of the live
  `orchestrator.sqlite`, and the per-kind `kinds` counts with the `kind=` filter applied the way `ticketList` does.
  The deployment was not restarted or modified.

Ticket titles, notes, thread chips and summaries are masked with ●. The stage marks, kind tags, filter pills and buttons
stay readable.

| File | Shows |
| --- | --- |
| `exec-before.png` / `exec-after.png` | 执行 → 进行中: no kind before; after, a kind pill row (全部分类 16 · 需求 0 · 缺陷 2 · 自迭代 13 · 问询 1) and a kind tag on every row |
| `exec-after-bug.png` | the same list with 缺陷 selected: the two bug tickets, the counts unchanged |
| `board-before.png` / `board-after.png` | 概览 → 看板, 待你决定: each decision card gains its kind tag |

Live data moves between frames: rows can reorder and the queue count can change by one.
