# 019 — 优先级与闲时消化（P1）

> 2026-11-05 · 由自动化代理（大肥鱼）实现，依据《优先级确认与闲时处理池 · 补充设计 · 2026-11-04》与已批准的四条默认规则。
> 本文说明这一版真正落地的部分、它的默认值、数据字段与边界；没做的部分写清楚，不当作已完成。

## 0. 一句话

TAPD 自动建单先发一张优先级确认卡，30 分钟不答默认 `P2` 进闲时池；人工 @ 默认 `P1`；`P0` 只能由人指定；
`P2`/`P3` 的工单只有在系统真的闲下来（五信号）才启动，主线工作永远先走。

## 1. 落地的规则

| 来源 / 动作 | 默认优先级 | 确认方式 | 无回复 / 超时 |
| --- | --- | --- | --- |
| TAPD 自动建单 | 待定（不启动，只挂起） | 发一张优先级确认卡 | `P2`，进闲时池 |
| 人工 @ 排单 | `P1` | 消息里明确写 `p0`–`p3`、紧急 / 不急 / 排期才改 | 不适用 |
| 人工明确指定 `P0` | `P0` | 只有人写出或点出 `P0` | `P0` 从不自动降级 |
| 其他（机器人 / CI / 推断出来的单、闲聊升级的单） | `P2` | 不打扰人 | 进闲时池 |

落地方式：

- **建单时**（`Tickets.create`）用 `defaultPriority(trigger)` 算出级别与来源，写进 `ticket.priority`
  `{ level, source, at, by?, note? }`。`source` 只有 `human`（人写的）与 `default`（系统默认）两种；
  人的值粘性，之后任何评估或超时都改不动。
- **TAPD 单**同时写 `ticket.priorityAsk { state, at, deadline, cardId?, by?, settledAt? }`：`pending` 期间
  **不启动 worker**（启动门拒绝并说明“等优先级答复”）。卡发到工单的飞书会话；TAPD 单自己没有飞书会话，
  于是走 Feishu Source 的「介入卡片私聊」。
- **卡的回调**（`sources/feishu-cards.ts` 的 `handlePriorityAction`）与**线程里回一个字**（`intake` 的
  `priorityAnswer`）都走 `Engine.decidePriority`：级别变 `human`、问题变 `answered`、`P0`/`P1` 同时离开闲时池。
  只有工单的 actor 能点卡。
- **超时**由 `Engine.evaluateDue` 每次 pass 检查（`Tickets.expirePriorityAsks`）：问题变 `expired`，级别取
  `P2`（`note: 'ask-timeout'`），工单进闲时池。超时后仍可随时改。
- `P0` 只能由人指定：`systemPriority` 拒绝任何系统默认设 `P0`，也拒绝覆盖 `human` 的值；TAPD 自带优先级只出现在
  卡面的“建议”里（`tapdSuggestion`：紧急/高 → 建议 `P1`，中 → `P2`，低 → `P3`，TAPD 的 `P0` 也只会建议 `P1`）。

## 2. 闲时怎么判定

闲时是系统属性，不是钟表属性。`core/idle.ts` 的 `idleState` 读五个信号：

| 信号 | 成立条件 |
| --- | --- |
| Q 队列 | 没有任何 `P0`/`P1` 工单还有可跑的 assignment（`working` / `working/queued`） |
| C 容量 | 至少一个 worker 槽位连续空闲 ≥ `slotFreeMin`（默认 10 分钟） |
| W 窗口 | 命中配置的窗口：默认 12:00–13:30 `L1`、19:30–23:00 `L2`、23:00–08:00 `L3`；窗口之外仍可 `L1` |
| H 人 | 最近一条人工消息距今 ≥ `humanQuietMin`（默认 15 分钟）；`L3` 不看这一条（夜里人在休息） |
| G 护栏 | 未暂停处理，且没有未解决的 `P0` |

Q + C + G 全成立才有闲时；W 与 H 决定深度：

| 深度 | 条件 | 允许启动 |
| --- | --- | --- |
| `L1` 微闲 | Q + C + G | `P2` |
| `L2` 窗口闲 | `L1` + 晚间窗口 + H | `P2`、`P3` |
| `L3` 静默闲 | `L1` + 夜间窗口（H 不看） | `P2`、`P3` |

启动门在 `DshExecutor.launchQueued`：`IdleScheduler.admission` 说不可以时抛 `Later` **挂起**这次 launch（不失败、
不结束 assignment），效果队列 5 秒后重试；条件成立就正常启动，并把 `idle.launchedIn` 记在工单上。
人的动作不受门限制：人的消息在等这个工单（`personWaiting`，含本地验收退回的人写输入）或人按了重试（上一段
assignment 以 `retried` 结束）都直接启动；主线级别（`P0`/`P1`）与没有优先级的旧单也永远直接启动。

预算与并发：同一时刻最多 `analysisWorkers`（默认 1）个闲时启动的工单在跑；每天最多 `dailyItems`（默认 6）个
闲时启动（按 `idle.launchedAt` 的本地日期计数）。

配置在 `executor.idle`（设置块里可保存，默认值即上表；`enabled: false` 恢复“所有单立刻启动”的旧行为）：

```json
{ "enabled": true,
  "windows": [{ "from": "12:00", "to": "13:30", "level": "L1" },
               { "from": "19:30", "to": "23:00", "level": "L2" },
               { "from": "23:00", "to": "08:00", "level": "L3" }],
  "protectedWindows": [{ "from": "09:30", "to": "12:00" }, { "from": "14:00", "to": "18:00" }],
  "slotFreeMin": 10, "humanQuietMin": 15, "dailyItems": 6, "analysisWorkers": 1, "priorityAskMin": 30 }
```

`priorityAskMin` 是 TAPD 确认卡的等待分钟数（默认 30）。

## 3. 数据与兼容

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ticket.priority` | `{ level: 'P0'–'P3', source: 'human' \| 'default', at, by?, note? }` | 可选；旧单没有 |
| `ticket.priorityAsk` | `{ state: 'pending' \| 'answered' \| 'expired', at, deadline, cardId?, settledAt?, by? }` | 只在问过的单上 |
| `ticket.idle` | `{ enteredAt, launchedIn?, launchedAt? }` | 进过闲时池的单 |

- 全部是可选字段，SQLite schema 不变（仍是 `schema 11`），旧记录无需迁移。
- **旧单按 `P1` 读**（`ticketPriority`）：升级不能让已经在跑的主线突然被闲时门挡住。
- `executor.idle` 是新设置块字段，旧 settings 由 schema 默认值补齐；`policyVersion` 不含它，所以保存它不会
  使已有 Mandate 失效。
- 工单卡（`orchestrator_read` 的 ticket card）多出 `priority`、`priority_ask`、`idle` 三个只读字段；面板 UI 没改。

## 4. 明确没做的部分

- **L1/L2/L3 的分析深度与时间盒**：现在三层只决定“哪些级别可以启动”，没有给 worker 换一套只读分析指令。
  p4 单本来就有 P1 计划门（`docs/012`），启动阶段仍是只读；git 单没有这道门，`L1` 启动的 worker 照常可以改文件。
- **Stash 生命周期**（triaged → analyzing → stashed → promoted/dismissed）：没有存储、没有 promote 入口。
- **卡片限流与批量摘要**（每 10 分钟 1 张 / 每天 6 张、≥3 张合并）：只做了“每张单只问一次”，没有限流与合并。
- **夜间早间摘要**、**每日 90 分钟分析预算**：前者依赖注意力卡片子系统，后者需要能量化分析会话时长。
- **P0 抢占**：只保证不抢占正在跑的 worker（本来就不会）；不实现“排队到队首”的额外调度。

这些留给后续工作包；本单不把它们写成已完成。

## 5. 看板：机器、注意力与闲时池

看板把「谁在干活」和「池子里有什么」分开，人的注意力只落在值得看的东西上（本单新增；2026-11-06 的 UI/UX 轮把闲时池从一列改成抽屉）：

| 看板列 | 收什么 | 人的动作 |
| --- | --- | --- |
| 待你决定 | 方案、提问、失败报告 | 就地回答 |
| 待你验证 | 已交付、等本地验收的单 | 验收 / 退回 |
| 正在跑 | **实际在执行器的**：正在跑的 worker、主线排队等槽位、主线等待下一次触发；按 P0→P3 排序 | 打开工单 |
| 流水线 / 最近结束 | 与原看板一致 | 跟进 / 查看 |

闲时池不再占一列，改成看板上方一个安静的 **闲时池 N · P2 x · P3 y** 入口：点开才从右侧滑出抽屉，一行一张单，P3 默认折叠、P2 先列 8 张。这样两条真正等人处理的泳道不必和 15 张「不急的活」抢宽度与高度。

- **提到注意力池**（`POST tickets/:id/promote`，面板入口）把级别写成人的 `P0`/`P1`、把工单移出闲时窗口；如果 worker 的两轮之间没有 assignment，会立即起一轮并把人这句话作为第一条输入（「人从闲时池把这张单提到注意力池（P1）：现在推进它」），所以「挑出来」是调度动作，不只是改标签。正在跑的 worker 不打断；方案仍在等人确认的单只提级，不绕过 P1 方案门。
- **只改级别**（`POST tickets/:id/priority`）只写优先级、不开跑：抽屉里的 P2/P3 落点与行内菜单的 P2/P3 都走这条，避免把「拖回池子」变成一次隐藏的执行。`promote` 只接受 `P0`/`P1`，其余级别由 priority 接口负责。
- **拖拽与键盘等价**：拖到 P0/P1 落点等于 promote，拖到 P2/P3 分区只改级别；行内 `⋯` 菜单和键盘提供同样四个级别。拖拽是增强，不是唯一入口；放到落点之外或按 Esc 取消，不改变级别。
- **P3 默认折叠**在「P3 暂存 N 张」下面，不占眼睛；P2 才是有资格被挑的池子内容。
- 工单行新增只读字段 `priority { level, code, word, hint, source }`、`pool`（是否等闲时）和 `request`（来源触发的前 160 字），看板和搜索结果共用同一套行投影。

**边界**：这一版没有自动分诊分析（接单后的低成本分析仍是原始请求 + 最新报告，不是模型结论），也没有把方案卡批量合并；那些仍在第 4 节的未做清单里。

## 6. 验证

- `pnpm typecheck`
- `pnpm exec vitest run tests/priority.spec.ts tests/core-engine.spec.ts tests/runtime.spec.ts tests/model-surface.spec.ts tests/docs.spec.ts`
- `pnpm build`

具体命令与结果以 PR 描述为准；本文件只记录规则与边界。
