# 031 — 阶段回退与对话内开新单

> 2026-11-10 · 由自动化代理实现，依据工单 9ab954f6 的自迭代需求：单子进入 verify 后，人在本单对话里要追加范围、
> 要回退阶段、要开新单，都没有入口，worker 还回了一句「请去面板 / 找 host」。本文说明这一版的规则、审计和边界。

## 0. 一句话

阶段仍然是单向前进的状态机（[012](012-gates-and-cards.md) 的 P1 → P2 → P3 → P4），但**人可以把一张活着的工单退回
plan 或 implement**：在面板上点「回退阶段」，或在对话里明确要求、由 worker 代为调用 `orchestrator_phase`。每次回退都留
记录。对话里要开新单，worker 一律用 `orchestrator_trigger_handback` 交回主会话评估；不再让人去面板或找 host。

## 1. 回退阶段

| 入口 | 谁触发 | 授权依据 | 理由 |
| --- | --- | --- | --- |
| 面板 `POST tickets/:id/phase`（工单页状态行「回退阶段」） | 人自己点 | 人的点击本身 | 可选的一句备注 |
| `orchestrator_phase` 的 `plan` / `implement` | worker，仅在人明确要求时 | `basis`：到达本单的那条人的消息——话题上的 trigger id，或人在 worker Session 里写的那条 `session-resume` Input（id 或 `read` 路径） | 必填 `reason` |

规则：

- **只退不进**：目标必须早于当前阶段；已结束的工单不能回退。前进仍然只有 `verify` / `deliver` 两步，各自一次一步，
  `implement` 仍然只能由人批准方案进入。回退不提供任何跳过闸口的捷径。
- **basis 必须是人的话**：bot、CI、只为上下文跟随的话题上的消息，以及工单的原始消息（它不是本单的 Input）都不算，
  被拒为 `phaseBasis`；没有理由被拒为 `phaseReason`。
- **退回 plan**：当前方案（含批准、反馈）移入 `ticket.planHistory`，P1 门重新打开；worker 交新方案、人重新批准后才能改文件。
  旧方案作为记录留在工单里，不再显示为待决策的方案。
- **两份验证都作废**：待人本地验收的 `ticket.verification`（P4.5）撤回；worker 报过的 `execution.verification` 也清掉，
  所以重开的一轮必须重新验证才能再进 deliver。
- **worker 怎么知道**：面板回退是人的指令，作为一条 `text` Input（`person`）发给 worker——它还在本轮就直接收到；
  本轮已结束（例如已报 ready）就开下一轮 Assignment，旧的那轮以 `phaseReset` 结束。对话里的回退是 worker 自己在读到人
  那条消息的这一轮里做的，不再另发 Input。

### 1.1 审计

每次回退在 `ticket.phaseResets` 追加一条 `{ at, from, to, via: 'panel' | 'conversation', reason?, basis? }`。
工单页的「执行过程」把它显示为「阶段回退：验证 → 方案」，副标题是理由（没写理由时显示来源：面板 / 对话中的请求）。
工单视图同时给出 `phase`（当前阶段）和 `phaseBack`（现在能退回的阶段，已结束为空），面板只在 `phaseBack` 非空时显示按钮。

## 2. 对话内开新单

人在工单对话里要的工作超出本单，包括明说「另开一单」，worker 用 `orchestrator_trigger_handback` 交回，附一句新单目标，
不确认、不推给人：

- **话题上的消息**：传 `trigger_id`。这是已有的路径：消息记录这次交回，没有别的工单还在判断它时排进评估，
  主会话的候选卡带 `handed_back`，按原话开新单或改挂。
- **人在 worker Session 里打的话**：这类话不经过 Source，没有 Trigger。传 `request`（人的原话），宿主把它变成一个
  Web Source 的 Trigger：话题由「本单 + 原话」派生，所以同一句话交两次只得到同一个 Trigger（第二次返回
  `state: 'duplicate'`），不会开两张单；交回记录先写在这个 Trigger 上，关系图显示新单由本单派生；回执和回复进主会话。
  只有确实有人在本单 Session 里写过话时才接受 `request`（否则 `noSessionRequest`），Web Source 的操作员也必须在名单里，
  与面板发起请求的准入一致。

提示词同时规定：不要回答「没有开单工具」，也不要把 worker 自己能做的事推给面板或 host；确实没有工具能做时，只点名那一个
能做的入口。

## 3. 没做的

- 不支持人直接把工单「前进」到某个阶段：前进仍由 worker 证明每一步。
- verify 阶段直接追加一张 P1 方案（不回退）这条备选没有做：回退到 plan 已经覆盖，且旧方案留在 `planHistory`，不必两套语义。
- 回退不改代码、不撤 CL / PR；已经 shelve 的 CL 由 worker 在新一轮里按需更新。
