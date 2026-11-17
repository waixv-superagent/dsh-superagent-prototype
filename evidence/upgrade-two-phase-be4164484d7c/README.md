# Update dialog: prepare, then upgrade and restart

Captured from the live DeepSeek Harness Web GUI (`http://127.0.0.1:3082`) on 2026-11-17 around 11:52 +08:00, headless Edge (`--headless=new`), 1920×1080, DPR 1, light theme, same start page, sidebar state and dialog in all frames.

- **Before**: the installed `dsh-superagent` client bundle, built from `904480d` (the deployed build). The dialog offers one action, **更新** / **空闲后更新**, which builds and then restarts in one go.
- **After, action offered**: this branch's `pnpm build` client bundle, built from `de14126`. The first action is now **准备更新** (prepare), and the dialog says the prepare phase neither pauses dispatch nor touches the running service.
- **After, build prepared**: the same bundle with a prepared run. The dialog shows the prepared commit, the completed build steps, and the explicit **升级并重启** / **空闲时升级重启** (upgrade and restart) choice; the sidebar badge turns green and reads **可以升级重启**.

## Redaction

The workspace list, the selected-workspace fragment above the input, and the account avatar are covered with grey boxes. They name this machine's other projects and are not part of the change.

## Method and limitation

The live host runs the deployed build, which has neither the new management routes nor the prepared state. For the after frames, the page's `GET /orchestrator/api/upgrade` was answered from this machine's real fork state: installed `904480d`, and the branch commit `de14126` with the commit between them. The prepared frame adds the run the prepare phase writes (`state: prepared`, the six build steps done). The badge, the dialog, their CSS and rendering are this branch's. The state machine behind the view, including the explicit restart and its refusal without a prepared build, is covered by `tests/upgrade.spec.ts`.

The live 3082 instance was not restarted, switched or modified for these captures; only the response of the client bundle in that one headless browser was swapped.
