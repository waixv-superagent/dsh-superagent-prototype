# 2026-11-06 — the status card before and after the fix

The reported case: the Feishu status card showed `🟠 14 张工单疑似卡住` while 14 queued `P2` Tickets never started and no idle
worker ran, even with a free worker slot and processing not paused. The Tickets were not stuck: the idle gate was holding
them (a `P0`/`P1` Ticket had runnable work), and a bookkeeping bug made the gate hold them forever.

Both cards come from this deployment's own script, `scripts/feishu-status.mjs --print-card`, which builds the card from the
management API and prints it instead of sending it. Nothing was posted to Feishu, and the running service was only read.

## Before

`card-before-facts.json` — the running host (installed build `b54f496`), `2026-11-06T04:44:48Z`: `stall.tickets = 14`, all
of them `queued` `P2` Tickets, the oldest waiting 967 minutes; the launch effect had been waiting since 2026-11-05T12:34Z.

## After

`card-after-facts.json` — the same state with the stall set this branch computes: the idle gate holds those 14, so none of
them is a queued stall, and the card falls back to what actually needs a person. Only the `stall` / `health.stall` fields
differ; every other count on the card is the live host's.

## Why there is no rendered image

The card is drawn by Feishu, and this branch changes neither its schema, its template nor its copy — it changes which
Tickets the stall count includes. The facts above are the card's own header and summary lines, so a reader can compare the
two states without a screenshot of a card whose layout is identical.

## Limitation

The "after" card is the fixed build's *input* to the same script, not a card a host running this branch sent: this branch was
verified by tests and a build, not by deploying it. The running host keeps the old build until it restarts with this change.
