# Pipeline stage notices — panel evidence

Captured from the live Superagent panel at `127.0.0.1:3082` on 2026-11-05 02:37 +08:00. Viewport is 1440 × 1120 CSS px at DPR 2, light theme.

- **Before**: the deployed `dsh-superagent` client (`lib/client.js`, SHA-256 `e53ba276…8856`).
- **After**: this branch's built client (`lib/client.js`, SHA-256 `59cc5542…04ca`). It was spliced into the served plugin batch for the capture browser only, through CDP request interception. No deployment file was changed, and the host was not restarted.

Both phases render **the same** panel responses. The capture browser reads the live responses for Ticket `948b5a48…` (Swarm review 585334) and for `GET settings`, then rewrites them identically for both phases:

- **Ticket**: it is set to the state this branch's server records once a change is submitted and its autobuild has passed. That means `step: 'autobuild'`, `submitted`, `stageUrl` set to a sample autobuild build, and the ticket open.
- **Settings**: the new p4 fields hold sample values (two reviewers, `Editor-Autobuild`, one recipient chat).

The deployed client ignores fields it does not know, so the Before images show how the current panel renders the same state.

| | Before | After |
| --- | --- | --- |
| Ticket · 流水线跟进 | Four-step track stuck on 自动测试, tag 待你处理, button 打开冒烟构建 | Five-step track with 出包 current, tag autobuild, button 打开 autobuild 构建 |
| Settings · 执行 | No reviewer or autobuild fields | 可选审核人, autobuild Job, 编辑器包链接 and 发包对象 below the Jenkins 冒烟 Job field |

Ticket facts, the title and the review link are masked with `●`. The Jenkins token field is a password input.
