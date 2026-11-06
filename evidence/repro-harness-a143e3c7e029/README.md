# A/B reproduction harness — evidence

Ticket `repro-harness-a143e3c7e029`, base `main` at `f6d9f8d` (the local reproduction-case runner merged as PR #85, and the verification-methodology doc merged as PR #86). This change adds a reusable A/B harness around a reproduction case; it does not change the
panel UI or the host's case runner.

Deliverable: [`scripts/repro-ab.mjs`](../../scripts/repro-ab.mjs), [`docs/026-repro-ab.md`](../../docs/026-repro-ab.md) (the A/B step of [`docs/025`](../../docs/025-reproducible-verification.md)),
[`examples/repro-ab/`](../../examples/repro-ab), [`tests/repro-ab.spec.ts`](../../tests/repro-ab.spec.ts).
The panel entry is the existing `case.json`: `command` points at `.repro/harness.mjs replay`, `report` at
`.repro/report.html`, so a person still clicks “运行” and “报告” in the 复现用例 card.

## Commands and results

### 1. Harness self-test (no editor, temporary directories)

```text
$ node scripts/repro-ab.mjs --self-test
self-test passed
```

Covers: A/B pass, a failing assertion, a missing observation, repeated runs that disagree, missing baseline,
HTML escaping, and the `init` snapshot/template/panel entry.

### 2. Synthetic example, full A→B walk

```text
$ node scripts/repro-ab.mjs run examples/repro-ab --arm A --label "baseline (demo)"
A 臂已记录：20261105-161038-A-1c366a（2/2 次有观测）

$ node scripts/repro-ab.mjs replay examples/repro-ab --label "fixed (demo)"
判定：通过
  通过 decrease metrics.slideMax — 减少 7.3800（阈值 2）
  通过 unchanged metrics.fps — A 与 B 一致
  通过 equals state — 符合期望值
报告：.../examples/repro-ab/.repro/report.html
(exit 0)
```

The report is the self-contained HTML shown in [`report-pass.png`](report-pass.png) (1280×2600, Chrome
headless, dark observation blocks are the two arms' observations and the generated trajectory SVG).

### 3. Negative path: an assertion that should not hold

```text
判定：不通过
  不通过 unchanged metrics.slideMax — A 与 B 不一致（出现了非期望变化）
  说明：有断言不通过
(exit 2)
```

See [`report-fail.png`](report-fail.png); the same ledger shows the red verdict, the failing row, and the
full A/B diff rather than only the declared checks.

### 4. Missing baseline and a UTF-8 BOM manifest

```text
$ node scripts/repro-ab.mjs replay <fresh case>
判定：信息不足
  说明：还没有 baseline（A 臂）的观测：先在改动前跑 run --arm A
(exit 3; report written with the reason)

$ node scripts/repro-ab.mjs run . --arm A      # ab.json starts with U+FEFF
A 臂已记录：...（1/1 次有观测） (exit 0)
```

Exit code is the conclusion (0 pass / 1 usage / 2 assertion failed / 3 not enough information) so the
panel's runner shows the same verdict the report does.

### 5. Repository checks

```text
$ pnpm typecheck
(exit 0)

$ pnpm exec vitest run tests/repro-ab.spec.ts tests/docs.spec.ts
Test Files  2 passed (2)
Tests       21 passed (21)

$ pnpm exec vitest run tests/model-surface.spec.ts tests/environment.spec.ts
Test Files  2 passed (2)
Tests       23 passed (23)

$ pnpm build
✔ Build complete (exit 0)
```

The full `pnpm test` run after the prompt-budget fix passed 1845 of 1868 (22 skipped) with one failure:
the `tests/environment.spec.ts` case that starts 13+ `cmd.exe` shims timed out at 30 s under the parallel
suite. That file passes alone (16/16, 7.3 s) and was the first file of a serial run, where it also passed.
Later full-suite attempts on this shared machine stalled before reporting a result, so the full suite is
not claimed green here; no code-level assertion failed. The pull request records the same limitation.

## Limitations

- **No real editor case was run for this evidence.** The host's editor project setting is empty (so the
  panel's case root is `<stateDir>/repro-tests/`), and the shared editor is held by other tickets. The
  retro's minimum landing — a first real case from `673d05c3` or `8bf631e4` — needs that editor/build and
  is the next step; the harness itself is editor-agnostic and runs whatever probe the case names.
- **The envreporter field report is not auto-converted to an A-arm manifest yet.** The A arm is recorded
  by running the probe once before the change; docs/026 §8 names this gap.
- **No pixel/video diff and no cluster/idle queue.** The report gives a machine verdict only on declared
  metrics and leaves feel/visual judgment to a person; grouping and overnight scheduling are other
  workstreams (docs/019).
- **Harness snapshot drift.** `init` copies the script into the case's `.repro/`; re-run
  `init --force` to update an old case. This is deliberate so a case keeps running after the ticket
  checkout is gone.
