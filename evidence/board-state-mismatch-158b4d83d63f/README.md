# A retry lifts the question it answers

Captured on 2026-11-04 from the live Superagent panel (`http://127.0.0.1:3082`) in headless Chromium (`--headless=new`),
viewport **1344 × 1400 CSS px at DPR 2**, dark theme, one page load per phase from the same browser profile. Both phases
render the same served client bundle; only the panel's own server answers differ.

The Ticket under test is `e425c320…`, the one a person reported as "执行看板 状态和实际情况不一致": its worker had asked
whether to rebuild the Session, the host then recorded a failed Assignment (`LlmError`), and the person pressed 重试. Both
phases render that Ticket's **recorded value** — the one the panel held at 2026-11-04 15:55 +08, when the mismatch was
reported, copied beside these images as `ticket-e425.json` — restored into a copy of the live database, because the live
Ticket has moved on since. Nothing else in the copy was edited. Each build then runs the same panel command on it,
`retryTicket` — a person pressing 重试 — and the two phases show what that build records.

| | Before — `ef0ffcf` (origin/main before this branch) | After — this branch |
| --- | --- | --- |
| Board | ![Before: 1 件等你决定, the card still says 待回答 with the old question](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/board-state-mismatch-158b4d83d63f/evidence/board-state-mismatch-158b4d83d63f/before-board.png) | ![After: 现在没有需要你的事, the card is in 正在跑 as 排队中 第 6 次执行](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/board-state-mismatch-158b4d83d63f/evidence/board-state-mismatch-158b4d83d63f/after-board.png) |
| Ticket page | ![Before: 待回答, with the 待人工决定 banner of the earlier question](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/board-state-mismatch-158b4d83d63f/evidence/board-state-mismatch-158b4d83d63f/before-ticket.png) | ![After: 排队中, with no question banner](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/board-state-mismatch-158b4d83d63f/evidence/board-state-mismatch-158b4d83d63f/after-ticket.png) |

- **Board** — before, the retried Ticket still counts as "1 件等你决定", and its card says 待回答 with the question the
  previous Assignment asked, while the lane beside it already shows the retry as 第 6 次执行. After, the headline reads
  "现在没有需要你的事", 待你决定 is 0, and the Ticket sits in 正在跑 as 排队中 第 6 次执行.
- **Ticket page** — before, the header says 待回答 and the 待人工决定 banner repeats the old question; after, it says
  排队中 and no question is shown. The stale question and its pending reply are withdrawn, as a person's message in the
  Session already did before this change.

## How it was captured

Both phases use the same client bundle and the same database copy: the panel's `GET /orchestrator/api/overview`,
`GET /orchestrator/api/tickets` and `GET /orchestrator/api/tickets/e425c320…` answers were produced by each build's own
server views over the copy and injected into the page, while every other request went to the live host unchanged. The
deployment was not restarted and its files were not modified.

## Masking

The crop leaves out the sidebar and every other Ticket's row; the neighbouring card in the running lane is covered with a
solid block. What stays readable is the panel's own furniture — tabs, lane names and counts, status tags (待回答, 排队中,
执行中, 正在跑), the Ticket's title, its TAPD source, the run counts and the elapsed times.
