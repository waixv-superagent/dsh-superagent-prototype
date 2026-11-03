# Overview default view: the board

Captured from the live Superagent panel on 2026-11-03 at 15:11–15:12 +08:00: the default
route `https://10.104.0.40:9443/` (no `?view=` parameter), headless Edge, light theme, DPR 1,
1920×1080. Ticket titles and bodies are masked with `●`; the switch, page chrome and lane
headers are real.

- **Before** — the deployed bundle before this change (the installed profile's
  `lib/client.js`, sha256 `5BD20B0D…9C78`): the overview opened on 编辑器.
- **After** — this branch, `pnpm build`, its `lib/client.js` served by the same live panel
  (sha256 `87DCAD8E…D82B`): the overview opens on 看板. The build was installed into the
  profile for the capture; the previously installed `lib` is in the ticket's local evidence
  directory, not in the repository.

## Measurements

| | Before | After |
| --- | --- | --- |
| Selected view at `/` | 编辑器 | 看板 |
| `.dt-editor-hero` present | yes | no |
| `.dt-verdict` (board) present | no | yes |
| Column / board width | — | 1440px / 1440px |
| Board scroller at 1920 | — | 1440px viewport, no overflow |

The editor remains one click away through the switch, and `?view=editor` still opens it
directly; the board segment returns to the clean `/` route.
