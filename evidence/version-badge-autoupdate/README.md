# Update badge at the sidebar foot

Captured from the live DeepSeek Harness Web GUI (`http://127.0.0.1:3082`) on 2026-11-05 around 02:30 +08:00, headless Edge (`--headless=new`), 1920×1080, DPR 1, light theme, same start page and sidebar state in all frames.

- **Before**: the installed `dsh-superagent` client bundle (`lib/client.js`, sha256 `E53BA276…`), built from `08fa2f8`. The sidebar foot shows only the account row.
- **After**: this branch's `pnpm build` client bundle (sha256 `732F4205…`) swapped into the same live page for the capture; the installed bundle on disk was not changed.

## Redaction

The workspace list, the selected workspace name above the input, and the account avatar are covered with grey boxes. They name this machine's other projects and are not part of the change.

## Method and limitation

The live host runs the deployed build, which has no `/orchestrator/api/upgrade` route. For the after frames, the page answered that route with an `UpgradeView` built from this machine's real fork state: the installed commit `08fa2f8` against `origin/main` `36a10e6`, with the 12 commits between them (the dialog lists 8 and says more exist) and 2 running tickets. The badge, the dialog, their CSS and rendering are the branch's. The host route that produces the view is covered by `tests/upgrade.spec.ts`, not by this live process.

- `before-1920x1080.png`: no badge.
- `after-1920x1080.png`: a red dot and **有新版本** above the account row.
- `after-dialog-1920x1080.png`: the dialog after a click, with the installed and remote commits, the new commits, a note that 2 tickets are running, and **检查更新** / **立即更新** / **空闲后更新**.