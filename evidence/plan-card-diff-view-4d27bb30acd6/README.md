# Plan card's code diff: before and after

The panel is the real application; only its state is synthetic. One Ticket waits at the P1 plan gate with a real
unified diff attached (generated from the fixture pair in `lab/fixture/` and parsed by `src/core/diff.ts`). Both
revisions render the same Ticket, viewport (1440×1800), theme (dark) and data:

- **Before**: `origin/main` at `61e8445` — the plan gate's "计划改动 3 个文件" list. Each row carries the same
  budget sentence from the plan text, so the person reads no code (`before-plan.png`).
- **After**: this branch — the same gate leads with the real diff: a file index and per-file stats, hunk headers,
  old/new line-number columns, added/removed rows and token-level marks, with the 内联 / 并排 switch
  (`after-plan-inline.png`, `after-plan-split.png`).

The lab is isolated: processing is paused and every Source is off, so opening the panel can neither launch nor
deliver anything. The Ticket title is synthetic; the diff is a real `git diff --no-index -U3` output of the fixture
pair, not prose about a change.

Files:

- `before-plan.png` — baseline plan gate, file rows with the repeated plan sentence.
- `after-plan-inline.png` — changed plan gate, inline layout.
- `after-plan-split.png` — changed plan gate, side-by-side layout.
- `before-facts.json`, `after-facts.json` — the DOM facts captured next to each screenshot: the baseline rows and
  notes, the changed file names, totals, row counts, marked tokens and the active layout.
