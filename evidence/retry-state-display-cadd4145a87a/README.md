# A Report speaks for a Ticket only while its worker has nothing newer

Captured on 2026-11-03 from the live Superagent panel: before, headless Chromium (`--headless=new`), viewport
**1344 × 1400 CSS px at DPR 2**, dark theme, one phase per page load from the same browser profile, so the two sides share
the theme, the locale and the layout. The Before images are the deployed panel with the repository's pre-change server views;
the After images are this branch's server views. This branch changes no client code, so both phases render the same served
client bundle.

The Ticket under test is `cadd4145…` (outlined in gold on the board). It is a Ticket whose worker is running, and whose
card kept saying the old failed report.

| | Before | After |
| --- | --- | --- |
| board: running Tickets and lanes | ![Before: 正在跑 8, 流水线 3](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/retry-state-display-cadd4145a87a/evidence/retry-state-display-cadd4145a87a/before-board.png) | ![After: 正在跑 9, 流水线 2](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/retry-state-display-cadd4145a87a/evidence/retry-state-display-cadd4145a87a/after-board.png) |
| Ticket page: the running card | ![Before: 执行中 with a stale 最近进展 line](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/retry-state-display-cadd4145a87a/evidence/retry-state-display-cadd4145a87a/before-ticket.png) | ![After: 执行中 with no stale 最近进展 line](https://github.com/waixv-superagent/dsh-superagent-prototype/raw/agent/retry-state-display-cadd4145a87a/evidence/retry-state-display-cadd4145a87a/after-ticket.png) |

- **Board** — before, the watchdog Ticket (which reported `ready` and then took up a person's follow-up) waits in 流水线 ·
  待你处理; after it is in 正在跑 (正在跑 8 → 9, 流水线 3 → 2). The running cards also stop carrying a stale report body.
- **Ticket page** — the running Ticket showed a 最近进展 line made of its last failed report; after, the card has no stale
  report, while the status (执行中) and the elapsed time are unchanged.

## Both sides render the same restored snapshot

Both phases render one consistent `sqlite3` backup of the live database taken at `2026-11-03T12:41:17Z` (20:41 +08). The
snapshot already held the states under test, so nothing in it was edited: the running Tickets had a Report whose worker was
given newer Inputs after it (or, after a retry, no report of its own while an older Assignment's failure was still shown),
and one of them still had its pull request open.

For both phases the two panel responses (`GET orchestrator/api/overview`, `GET orchestrator/api/tickets/cadd4145…`) were
answered locally by the two builds' own server views over that snapshot; every other request (state polling, health, flow,
activity) went to the live host unchanged. The deployment was not restarted and its files were not modified.

## Masking

Ticket titles, report bodies, thread names, people, CL and review numbers, the running worker's tool arguments and the
Ticket's history are covered with solid blocks; the Ticket's own title is covered like any other. What stays readable is the
panel's own furniture: the tabs and segment bar, lane names and counts, status tags (执行中, 待你处理, 待回答, 正在跑, 流水线),
the elapsed/updated times, the buttons, and the block structure of the running Ticket's "now" card. No Feishu message
content is identifiable.
