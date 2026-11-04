# Billing strip on the Overview board

Captured from the live Superagent panel (`http://127.0.0.1:3082`, Overview → 看板) on 2026-11-04
between 17:03 and 17:10 +08:00, headless Edge (`--headless=new`), 1920×1080, DPR 1, light theme.

- **Before** — the installed `dsh-superagent` client bundle
  (`lib/client.js`, sha256 `EE08B5DC…F89B`), the deployed mainline without this branch.
- **After** — this branch, `pnpm build`, its `lib/client.js` (sha256 `438AE774…CDE1`) served by the
  same live panel for the capture. The installed bundle was restored afterwards; its sha256
  matched `EE08B5DC…F89B` again.

The board data is live and the revived Tickets were working during the captures, so counts differ
slightly between the two frames.

## What the after frame shows

The strip sits directly above the five board lanes:

- `正在计费` names the route of the latest booked request: `kurogames / DeepSeek V4.1 Flash`.
- `+1` is the other route that charged in the window: the personal `DeepSeek Account` route.
- `¥29.38` is the rolling hour priced from the gateway's published `/v1/models` list.
- The orange `+` after the money means tokens from the unpriced `DeepSeek Account` route are not in
  that figure.
- The sparkline is one bar per minute over the same 60 minutes; `1803 次请求` and `507.6M tokens`
  are the window totals.

## Method and limitation

The before frame is the live panel as deployed. The after frame uses the branch's built client
bundle in the same live panel, but the live host process still runs the deployed server build, so it
does not yet emit the `billing` field. For the capture, the overview response was augmented with a
`billing` object computed by `evidence/build-billing.mjs` from the actual `assistant/message` usage of
every Session in the preceding 60 minutes and the gateway's public price list. The client, CSS and
rendering path are the branch's; the host route that produces the same field is covered by
`tests/billing.spec.ts`, `tests/http.spec.ts` and the runtime/overview suites, not by this live
process. The production first load after deployment will therefore show the same strip from the
host route without the injection.
