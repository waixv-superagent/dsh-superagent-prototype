# UI/UX round: five-lane board with an idle drawer, and an acceptance page that carries the repro case

This round answers the feedback after the six-lane board went live: the idle pool was a full column of 15 cards competing
with the two lanes that need a person, and accepting a delivered Ticket meant hunting for the worker's verification
method and re-running the repro case somewhere else.

- **Baseline:** `origin/main` at `b54f496` (the build the person was looking at).
- **Changed:** branch `agent/uiux-round-2-93949eff7e92`.
- **Scenarios:** the duty desk with 15 pooled Tickets, the idle drawer, a drag to the P0/P1 band, and the same delivered
  Ticket's acceptance page before and after a case run.
- **Viewport/theme:** 1920×1080, dark theme. The acceptance page is captured at its own 960 px column. The panel is the
  real application; only its data is synthetic.

## Lab

The lab is two isolated DSH Web profiles built from the baseline and this branch (`lab/home/profiles/{before,after}`), each
with its own state directory seeded from one real Ticket's field shape: 2 decisions, 5 running, 15 pooled (12 P2 + 3 P3),
5 waiting for local verification and 6 recently ended. One verification package is a real four-block package that names
a local repro case, and the lab state holds that case under `repro-tests/lab-aim-exit` with a runnable stand-in command.
Every Source is off and processing is paused, so the lab can neither launch nor deliver anything. The rendered data is
therefore identical in both captures; only the build differs.

## Images

| File | Shows |
| --- | --- |
| `before-board.png` | Baseline: six lanes, with the idle pool as a full column of 15 cards |
| `after-board.png` | This branch: five lanes, the idle pool as one quiet dock (P2/P3 counts), verification cards leading with 待你判断 |
| `after-board-drawer.png` | The dock's drawer: one line per P2 Ticket, P3 behind its own count, close and drag handles |
| `after-board-drag.png` | A row mid-drag: the P0/P1 drop band and the dragged Ticket's ghost; Escape cancels, so no level changes |
| `before-ticket-verify.png` | Baseline acceptance page: the package flattened into 已确认/已检查 rows, the repro case only mentioned in prose |
| `after-ticket-verify.png` | This branch: 待你判断 on top, worker steps, the matched repro case with Run, evidence, prerequisites, files |
| `after-ticket-verify-ran.png` | After the page's own Run: succeeded, exit code, last report line, and the report link |

The `*-facts.json` files next to the images are the DOM facts the capture read (lane titles/counts/heights, drawer rows,
gate headings and repro state), not hand-written claims. `claude-design.md` is Claude's critique/design that framed this
round.
