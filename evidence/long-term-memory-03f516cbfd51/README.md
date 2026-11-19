# Knowledge settings group — before / after

Captured from the live Superagent panel (`http://127.0.0.1:3082`) on 2026-11-18 (Asia/Shanghai), headless Chrome
(`--headless=new`), viewport 1440 × 1200 CSS px at DPR 2, light theme, clipped to the panel page. Both runs serve the same
fixture and the deployed DSH shell; the only difference is the `dsh-superagent` client build in the page.

| | Image | What it shows |
| --- | --- | --- |
| Before — Settings → Execution | `before-settings.png` | the group navigation has no Knowledge entry; Execution is the group the Before build can open |
| After — Settings → Knowledge | `after-settings.png` | the new 知识库 group in the navigation and its page: the access switch, the MCP server name and the setup hint |
| After — switch on | `after-enabled.png` | the same page with the switch on and its own save bar (unsaved draft) |

## How the captures were made

- **Before** is the deployed `dsh-superagent` client module the live host serves; **After** is this branch's built
  `lib/client.js`, spliced into the served plugin batch through CDP `Fetch`. Every other request went to the live host,
  so the shell, theme, navigation and routes are the deployed ones — these are captures of the real panel, not a mockup.
- **Fixture**: `capture.mjs` reads the live `GET state` and `GET settings` answers and replaces them for both runs with a
  quiet state (no setup problem, no running or queued work), a neutral executor block (no directories, Unreal project,
  P4 host or credentials) and an added `knowledge` block (`{ enabled: false, server: "knowledge" }`). The knowledge page
  therefore renders the same values in both runs, and no live path or credential appears in the images.
- **Route**: the Before build has no Knowledge group, so it opens Settings → Execution; the After build opens
  Settings → Knowledge. Both images include the full group navigation, which is what this change adds.

## Commands

```sh
pnpm build
# The operator URL (with its token) is passed as an argument and never written to the repository.
node capture.mjs before lib/client.js "<operator-url>" .
node capture.mjs after lib/client.js "<operator-url>" .
```

`capture.json` records the capture metadata; the operator URL and its token are not part of the evidence.
