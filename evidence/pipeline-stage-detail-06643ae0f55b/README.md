# Pipeline fine stages on the board and the Ticket page

Captured from the live Superagent panel on 2026-11-04 at 17:04–17:07 +08:00, viewport **1440 × 1120 CSS px at DPR 2**,
light theme. Images are clipped to the panel page (1160 × 1120 CSS px), so the DSH sidebar stays out.

The Ticket under test is `948b5a48…`: its Swarm review 585334 was approved, and the pre-submit Jenkins build
`PostApproval-Entry` #21674 was running for that review. Both phases render **one snapshot** of the panel responses taken
at 16:59 +08.

| | Before | After |
| --- | --- | --- |
| Board — 流水线 lane | all three cards say **跟进中** | **待提交 / 待提交 / 冒烟中**, each with the four-step track; the target is outlined in gold |
| Ticket page | **跟进中**, 状态 跟进中, 最后检查 `Swarm 已审核通过，等待提交`; no stage strip, no Jenkins link | **冒烟中**; stage strip `自动测试 ✓ · 人工审核 ✓ · 提交前冒烟 ● · 入库`; 状态 冒烟中; 最后检查 `已审核通过 · Jenkins 冒烟中（#21674）`; **打开冒烟构建** |

## What each side is

- **Before** — the deployed `dsh-superagent` client bundle from the installed profile (`lib/client.js`, SHA-256
  `ee08b5dc…f89b`) over the live snapshot. The board and Ticket page are the current UI.
- **After** — this branch's built client (`lib/client.js`, SHA-256 `5b2cce21…2c61`) over the same snapshot. The module was
  served to the capture browser by splicing it into the served `plugins/??…` batch through CDP request interception; no
  file of the deployment was changed. The after snapshot only adds the fields this branch's server records for that same
  review and build: `step: 'smoke'`, `check: '已审核通过 · Jenkins 冒烟中（#21674）'` and
  `stageUrl: http://jenkins.sun.kuro.com/job/PostApproval-Entry/21674/`.

The two API responses (`GET orchestrator/api/overview`, `GET orchestrator/api/tickets/948b5a48…`) came from the snapshot;
every other request went to the live host. The deployment was not restarted or modified.

## Masking

Ticket titles, CL and review values, report bodies, thread names, the execution history and the worker's latest lines are
masked with `●`. The stage tags, the track, the check sentence, the buttons and the panel chrome stay readable; no Feishu
content is identifiable.

## Files

- `board-before.png` / `board-after.png` — the 流水线 lane, with the Ticket under test outlined in gold.
- `ticket-before.png` / `ticket-after.png` — the Ticket page's 流水线跟进 card.
