# 018 · 需求推进流程优化 S1–S6：本单落点

> 2026-11-04 · 由自动化代理（大肥鱼）实现，依据《需求推进画像与流程优化建议》v2 第 8 节的 S1–S6。
> 目标不是再加功能，而是把「接住一句话、一段对话、一次交付」做成协议。协议本身写在
> [012 分阶段闸口](012-gates-and-cards.md)、[003 执行](003-execution.md) 与本文件；本文说明每一项落在哪里、
> 哪些是强制、哪些留待后续工作包。

## 0. 一句话

P0 的 S1–S3 是强制协议：方案有轻模板与自含选项、接单回执与多目标拆单、ready 前的交付完整性校验。
P1 的 S4–S6 落了一部分领域机制（等待分类、目标改派、验证包），依赖未完成设计的那几块明确留在后面，不假装做完。

## 1. 落点总表

| 建议 | 本单落点 | 强制点 | 未做 |
| --- | --- | --- | --- |
| S1 方案过程化与选项自含 | `fix` / `analysis` / `design` 三套模板；`PlanOption.description`；设计型必须 2–4 个带描述的选项；grill 文档写进 `work` 提示词 | `missingPlanLabels` 按模板校验；设计型缺选项/描述被拒 | 单独的 grill 文档工具；面板之外的移动端排版 |
| S2 线程即工单与接单回执 | 同话题输入在交付前继续归原单（已有订阅）；单子交付（`ready`）或结束（`dropped` 等）后同话题消息转入评估，主会话 `attach` 续做或开新单；接单回执改 2–3 行并由主机补工单号；`orchestrator_route` 的 `parts` 把一个消息的 2–4 个目标拆成同 Decision 的子单，只有主单发回执 | 一个 Trigger 一个 Decision、1–4 张单；回执缺失渠道时回退到工单渠道 | 跨目标的一批输入按子单精确分流（当前所有子单共享话题订阅） |
| S3 交付完整性闸 | ready 前重读交付事实：PR 必须仍 open，p4 CL 必须仍 pending，review 必须仍可读；任何一项不成立直接拒绝 ready | `orchestrator_report` 的 ready 分支 | 任意文档链接的存活探测；CL「过期」的深度比对（需要同步基线） |
| S4 状态语义 | `waitingOf`：每单一句「等谁 / 在做什么 / 唯一已知截止」，进入 ticket 卡片与 `orchestrator_read` | 由现有 stage 机派生，不改状态机 | 三卡注意力预算/每日摘要：依赖尚未设计的注意力子系统 |
| S5 路由错配 | `orchestrator_redispatch`：worker 按真实目标把票改派到配置的仓库/depot，无需人点；`redispatch` 记录目标 | 未配置目标被拒并点名；改派换 Assignment | 016 的一项目一实例/独立 Router：仍是后续设计 |
| S6 验证预演与验证包 | `verification` 固定四块：版本与前置 / 复现步骤 / 预期与证据 / 待你判断；ready 带交付物时必须四块齐全 | `orchestrator_report` 拒绝缺块；p4 的 deliver 仍要求非空 | MCP/编辑器自动预演、编辑器租约队列：依赖 M1 与 [014 编辑器占用](014-editor-occupancy.md) |

## 2. S1：方案过程化与选项自含

三套模板都按 `label：content` 一行一条：

- `fix`（默认）：现象 / 代码线 / 资产线 / 配置线 / 修复锚点 / 影响面 / 验证方案 / 预算；旧方案没有
  `template` 字段，按 `fix` 读取。
- `analysis`：问题 / 结论 / 依据 / 建议。分析型工单不再被迫写不存在的代码、资产、配置三线。
- `design`：问题 / 选项 / 证据 / 推荐；必须带 2–4 个选项，每个选项有 `description`，在卡片上直接写出
  选它意味着什么、代价是什么。按钮仍只放短标签，描述排在按钮上方，卡片和文本兜底都带全。

过程上，设计型或需求型方案先在原话题发 grill 文档（要拍板的问题、每个选项的证据与代价、自己的推荐），
再用 `orchestrator_plan` 交一张只问「现在能不能开工」的卡。工具本身不强制两步：grill 文档的内容可以由
worker 写进 `sections` 或对话，协议要求的是别把长分析硬塞进一张卡。

## 3. S2：线程即工单与接单回执

- 同一话题的后续消息本来就按订阅进入原单；本单不改变这一点，补的是回执和拆单。
- 接单回执：`acknowledgement` 写成 2–3 行（我理解的目标 / 接下来三步），主机在建单后追加
  `工单 <8位>`；一个消息拆成多张单时，回执仍是一条，但把这次开出的**全部**工单号列在同一行，
  人不用到面板里逐张找；主消息没有渠道时回退到工单自己的渠道，不再静默丢掉回执。
- 多目标拆单：`orchestrator_route` 的 accept 可以带 1–3 个 `parts`，每个有自己的标题、短名、leased paths
  和目标。它们与主单共用同一个 Decision（所以重放仍然幂等），各建一张单、各自订阅源话题；
  只有主单发回执。后续同一话题的消息会同时到达各子单，各单 worker 判断是否属于自己的部分并交回不属的，
  这是拆单的已知代价，换来的是不再让一个 worker 把第二个目标整体退回。
- 对话内开新单：人在本单话题上要另开一单，worker 对那条原始消息调 `orchestrator_trigger_handback`（`trigger_id`）；
  人在 worker Session 里打的话没有 Trigger，就把原话作为 `request` 交回，宿主把它变成一个 Web Source 请求交主会话评估，
  同一句话只成一个 Trigger。worker 不再让人去面板或找 host 开单（见 docs/031）。

## 4. S3 + S6：ready 前先证明交付还在

`orchestrator_report` 在 `ready` 且带交付物时做两件事：

1. **交付事实还成立**：git PR 仍 `open`；p4 CL 仍 `pending`（未提交、未消失）；Swarm review 仍可读。
   任何一项不成立，报告被拒并说明该怎么补，而不是把「已交付」写进工单。
2. **验证包四块齐全**：`版本与前置` / `复现步骤` / `预期与证据` / `待你判断`，一行一条。
   没有交付物的分析单不受影响。

验证包是给人照着做的，不是给 agent 再读一遍的报告：机器预演能做的部分写进「预期与证据」，没预演的
写明「未预演，原因」。自动预演与编辑器租约属于后续 M1 工作包，不在本单伪装成已实现。

## 5. S4 / S5 的边界

- S4 的等待分类用 `waitingOf` 从现有 stage 机派生，不新造状态：`person` / `pipeline` / `worker` / `none`，
  并只报领域里真实存在的截止（目前是 P1 方案门的 deadline）。每日三卡摘要需要注意力子系统先定设计，
  本单不擅自发明通知频率或静默规则。
- S5 的 accept 目标解析、按目标分槽并发与「人消息额外槽位」已在 [003](003-execution.md) 与
  [016](016-worktree-partitioning.md) 的已实现部分里；本单补的是 worker 侧的一条捷径：
  `orchestrator_redispatch` 按真实目标直接改派，不再先报 blocked 等人点。

## 6. 兼容性

- 所有新字段都是可选的：`Plan.template`、`PlanOption.description`、`Decision.ticketIds`、
  `AcceptPart`、`waitingOf` 的投影、报告工具的 `verification` 文本。
- 旧方案按 `fix` 读取；旧工单的 `verification` 文本在下次 ready 时才按四块校验，已结束的单不受影响。
- `ticketCard` 增加 `next`，面板 API 的 plan 视图增加 `template` / `question` / `options` / `sections`；
  它们是增量字段，旧客户端忽略即可。

## 7. 验证

- `pnpm typecheck`
- `pnpm exec vitest run tests/core-engine.spec.ts tests/feishu-card.spec.ts tests/stage.spec.ts tests/cards.spec.ts tests/views.spec.ts tests/runtime.spec.ts tests/tools.spec.ts tests/followups.spec.ts tests/model-surface.spec.ts tests/docs.spec.ts`
- `pnpm build`

具体命令与结果以 PR 描述为准；本文件只记录协议与边界。
