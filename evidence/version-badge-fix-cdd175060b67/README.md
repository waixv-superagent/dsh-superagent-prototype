# One-click update acceptance on 3082 (2026-11-09)

The one-click update went from `cb2d8c3` (the deployed build) to `e138019` on the live `127.0.0.1:3082` panel,
through the real switch:

- `GET upgrade` offered 24 commits from `origin/main`; `POST upgrade {"force":true}` started the run.
- `fetch` → `worktree` → `install` → `typecheck` → `test` → `build` all finished; the host paused, waited for zero
  running workers with **立即更新** (`forced`), stopped the old host (`stop done`), backed up the package and the
  database, replaced the package, started the new host, and recorded `done`.
- The old host pid was 26720; the new host is pid 45288 and started at 14:37:46.
- The installed `build-info.json` now records `e138019b5c5849006a7c1f8481632e77c1b0ddbb`; `GET upgrade` reports
  `installed == remote`, `available: false`; processing runs (5 running, 2 queued at 14:39).
- The final `resume` step recorded a timeout while the cold-started host was still bringing its executor up; the
  dispatch is not paused (`paused: false`), so the update itself completed.

Before: badge visible (`有新版本`), installed `cb2d8c3`, remote `e138019`; the previous attempt's dialog showed the
switch dying and "The switch process stopped before it finished".
After: update `done`, badge cleared, installed `e138019`.

The workspace list and account row are covered in grey; the commit list is the public repository's own history.
