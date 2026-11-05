# Web panel ticket entry — evidence

Captured from two disposable DeepSeek Harness profiles on 2026-11-05 14:21–14:30 +08:00. Viewport is 1440 × 1000 CSS px at DPR 2, light theme. The two runs differ only in the `dsh-superagent` build they load, and the profile patch disables every polling Source (GitHub, Feishu, TAPD) and pauses processing, so neither run contacts GitHub, Feishu, TAPD or the model, and no worker starts.

- **Before**: commit `d8a1a74` (this ticket's base) built to `lib/client.js`, served on `127.0.0.1:3096`.
- **After**: this branch built to `lib/client.js`, served on `127.0.0.1:3099`.

The panel's own responses are identical and empty in both runs (no Tickets, no Threads), so the header is the only thing that differs.

| File | Shows |
| --- | --- |
| `before-header.png` | The panel header before the change: search, glossary and 打开主 Session only |
| `after-header.png` | The same header after the change: 发起工单 between the glossary and 打开主 Session |
| `after-dialog-empty.png` | The 发起工单 dialog: the request field, what the main Session does with it, and the limit |
| `after-dialog-filled.png` | The same dialog with a request typed in |
| `after-queued.png` | After 发给主会话: the queued notice, and the board counting 今日到达 1 |

The submission in the after run created a real `web` Trigger and Thread: `web:b56952cf…`, label 「把工单面板的方案卡改成真实代码 diff 的视图，卡片只留摘要和链接」, actor `operator`, addressed, with no Eval because that lab pauses processing. The flow that follows (candidate → main Session accept → Ticket, and the receipt injected back into the main Session) is covered by `tests/web.spec.ts`; no model turn or worker ran in this lab.

DeepSeek Harness's own first-run preview notice and its "开始使用" account prompt are captured in `after-queued.png`; they are artifacts of a fresh harness home with no model credentials, not part of this change.
