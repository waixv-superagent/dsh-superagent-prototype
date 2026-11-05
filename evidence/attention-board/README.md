# Board scheduling: the machine lane and the idle pool

Captured 2026-11-06 at 00:26–00:31 +08:00 from the live DeepSeek Harness Web app, `Superagent → 概览 → 看板`
(`?view=board`), headless Chrome driven through CDP, dark theme, 1920 × 1080 CSS px at DPR 1. Ticket titles and
summaries are masked with `●`; the page chrome, lane headers, counts, priority tags, buttons and timings are real.
No chat text, message ids or credentials appear in either image.

- **Before** — the deployed panel, `dsh-superagent`'s installed `lib/client.js`
  (sha256 `B3A16250…F4081416`), served through the deployment's gateway at `https://10.104.0.40:9443/`.
- **After** — this branch, `pnpm build`, both the plugin's host routes and its `lib/client.js`
  (sha256 `57D634C6…8EFF9DF`) booted in a second DSH profile on `127.0.0.1:3083` against a paused snapshot of the
  same state database. The panel on that instance is the same app at the same viewport and view.

## Change

- The board grows from five lanes to six: **待你决定 · 正在跑 · 闲时池 · 待你验证 · 流水线 · 最近结束**.
- **正在跑** is now the executor's own lane: a worker turn running now, mainline work queued for a slot, or a mainline
  ticket waiting for its next trigger. Pooled P2/P3 tickets no longer appear there as if they were running.
- **闲时池** holds P2 tickets that wait for an idle window or a worker slot; each row carries its level, its kind, the
  request as it arrived and an age, and **提到注意力池** lifts it to P1 and starts it now when its worker is between
  turns. P3 stays collapsed behind a count, so the lane only shows work worth a person's attention.
- Every machine and pool row shows its priority (`P0`–`P3`), and the verdict line sums what is running and what is in
  the pool.

## Measurements

| | Before | After |
| --- | --- | --- |
| Board lanes | 5 | 6 |
| `正在跑` count | 19 | 6 |
| `闲时池` count | — | 14 |
| Priority tag on a machine row | absent | `P1 主线` / `P2 闲时` |
| Pool row actions | — | `提到注意力池`, `打开工单 →` |
| P3 in the pool | — | collapsed behind `P3 暂存 N 张` |

## Limit

The captures are minutes apart on a live system, and the after instance is paused (it is a snapshot reviewer, not
a second production host), so counts and the executor figure differ from the before image. Compare the lanes, the
row affordances and the level labels, not the numbers. The before image therefore still contains queued and idle
rows in `正在跑`; that is exactly what the after image splits.
