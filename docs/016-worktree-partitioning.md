# 016 — 按 worktree/项目拆分 Super-agent（设计稿）

> Status: draft；本文是设计与迁移方案，尚未实现。Written 2026-11-03.
> 来源：团队内部讨论（触发与线程细节留在 ticket 记录，不入库）。
>
> 用户原话：**「superagent 看板/人管理的粒度，甚至 router session 都应该分，迭代工作流和项目开发之间关系并不那么大，是不是应该先分 worktree 而不是全部一锅炖。底层执行器逻辑可以复用，顺着我这思路，参照官方文档想想，应该怎么改。」**

## 0. 结论（建议）

把 **Super-agent 实例的边界定在 worktree/项目**，而不是继续把一个实例做成多租户：

- **一个项目 = 一个 Super-agent 实例**：自己的看板、人/准入、Router Session、worker 池、执行 home、状态库、事件源配置、提示词/规则。
- **执行器、Engine、交付后端、租约、卡片、队列只维护一套代码**；项目只是它的配置参数。
- **第一阶段用「一项目一个 DSH profile + 独立进程/端口/stateDir」落地**（默认同一个 DSH home 下多个 profile；Stage 0 失败则改独立 home；几乎不改运行时核心，只新增启动器/迁移脚本，先获得隔离和每项目独立的并发上限），再补一个**只读 Hub** 汇总「全项目需要人处理的事」。
- **不把 `project` 维度塞进单实例的 store/查询/UI**；那会把刚拆开的上下文重新耦合，且改动最大。

这个结论与官方文章 8.3 一致：**「需要共享上下文的范围共用同一个实例，需要隔离的范围则各自独立配备」**。worktree/项目正是自然隔离边界。文章 7.2 讲的是「不要为了吞吐过早水平切分 Router」；我们是为上下文隔离而分实例，依据是 8.3，不是 7.2。跨实例 A2A 仍是官方开放问题，所以第一阶段不造「超级 Hub Router」，让**人**做跨项目的最终决策点，Hub 只做注意力汇总。

## 1. 现象：今天为什么是「一锅炖」

今天一个部署 = 一个 `Runtime` 服务 + 一份 state + 一组全局配置：

| 维度 | 今天 | 代码位置 |
| --- | --- | --- |
| 实例 | 一个 DSH profile 里一个 `orchestrator` 服务 | `src/app/runtime.ts`（`super(ctx, 'orchestrator')`） |
| 状态 | 一个 `orchestrator.sqlite`（thread/ticket/trigger/effect/kv/settings） | `src/app/store.ts` |
| Router | 一个 master session，id 由 stateDir 派生 | `src/app/runtime.ts`（`masterId`） |
| 看板 | 一个面板、一个 `PANEL_ID`、一个 HTTP 前缀 `/orchestrator` | `src/client/index.tsx`、`src/app/http.ts` |
| 人/准入 | 一份 `policy.sources[*]` + 各 Source 的 allowed/chats | `src/policy.ts`、`src/sources/*` |
| 并发 | 一份 `executor.maxWorkers`（默认 3，当前部署 5），workspaces 是同一池 | `src/executor/dsh.ts`、`src/executor/workspace.ts` |
| 事件源 | GitHub 一个 repo + TAPD 一个 owner + Feishu 多 chat 共用一个 Router | `src/policy.ts`（`SettingsSchema.sources`）、`src/app/http.ts` |
| 执行目录 | `executor.directory` + `workspaces[]` 全局 | `src/executor/dsh.ts` |
| 交付目标 | 才区分 GitHub repo / p4 depot（PR #19 已做） | `src/app/delivery-targets.ts` |

于是用户感知到的就是：dsh 自迭代（GitHub）与游戏项目（TAPD→p4）**共用一个 Router 上下文、一个看板、一个 5 并发池、一套规则/提示词、一份人名单**；target 只影响「最后交付到哪」，不影响「谁在什么上下文里干活」。

当前库里的实际混合情况（只读统计）：

- 60 个 Ticket、174 个 Thread、354 个 Trigger（Feishu 318、TAPD 33、GitHub 3）。
- Feishu 同时接了两个群（一个全部消息、一个仅 @）和私聊；TAPD 是某个 workspace/owner 名下的缺陷；GitHub 是本仓库。
- 执行侧：16 个 Ticket 记了 `git`、6 个记了 `p4`、38 个没有记录（历史/未启动），说明「项目」在数据里没有一等公民标识，只有执行后的 target 残留。按 repo/workspace 的即时并发修复另有在途改动（PR #27），本文不重复实现，只把并发上限放到实例级。

## 2. 官方模型对齐

文章的双层架构：**Router（对外交互、分派、不干具体活）+ Worker（隔离上下文、有完整工具、回报 Router）**。文章给的三条直接约束：

1. **8.1/8.3 按上下文边界分实例**：需要共享上下文才放一个实例；需要隔离就各自独立实例。worktree/项目就是这里说的隔离边界。
2. **7.2 不是本方案的依据**：它讲的是不要为了吞吐过早水平切分 Router；我们是为上下文隔离分实例，两者不要混用。
3. **A2A 仍是开放问题**：跨实例协作没有现成答案，所以第一阶段不要造「超级 Hub Router」，让**人**做跨项目的最终决策点，Hub 只做注意力汇总。

DSH 侧已具备、且不需要动内核的能力：

- **Profile/Bundle**：同一个 `dsh-superagent` bundle 可以被多个 profile 复用（`dsh --profile <name>`，profile 是插件树 + 配置）。仓库自带的 `scripts/dsh-superagent` 已经按 `--profile` 管理控制目录、日志、PID 和 URL，`docs/006-deployment.md` 也把「一个专用 profile」作为部署单位——这是现成的多实例机制。
- **Workspace**：`ctx.workspaceRegistry.create(cwd)` 以目录为实体；worker 的目录天然是项目/worktree。
- **Session**：每个会话带 cwd 与 agent preset；Router 也可用独立 cwd。
- **Cordis 服务隔离**：`ctx.isolate(name)` 可为子 scope 遮蔽服务——这是「单进程多实例」的技术前提（但见 §4 的成本）。
- **进程级隔离**：每进程一个 Web server/端口/同源校验；不需要改 DSH 内核。

## 3. 目标概念

| 概念 | 定义 | 谁拥有 |
| --- | --- | --- |
| **Project（项目/worktree）** | 一个执行 home（worktree 或 p4 workspace）+ 它的事件源 + 人 + 规则 + Router + worker 池 + 看板 + 状态库。实例边界。 | 一个 Super-agent 实例 |
| **Target** | 交付落到哪（GitHub repo / p4 depot+stream / 未来其他后端）。一个 Project 有一个主 target，可有镜像 target（issue #6 的 C6）。 | Project 内配置 |
| **Source** | 事件入口（GitHub repo、TAPD workspace/owner、Feishu chats/DM）。 | Project 内配置 |
| **People** | 每个 Source 的准入名单 + 通知位置 + 值班/负责人（若要）。 | Project 内配置；可共享默认值 |
| **Router Session** | 该项目唯一的对外会话，只做判断/分派/汇报。 | Project 内 |
| **Executor** | Session 创建、效果队列、租约、交付、pipeline、卡片——**一套实现**。 | 代码共享，参数按 Project |
| **Hub** | 跨项目的注意力汇总：待决定/待验证/进行中/错误计数、健康、链接。**无 LLM、无执行、第一版只读**。 | 全局 |

关键取舍：**Project 是部署/运行概念，不是领域聚合**。领域模型（Thread/Trigger/Ticket/Assignment/Decision）不需要新增 `project` 字段；项目通过「哪个实例的库」天然区分。这样领域模型保持小，查询不用带 project 维度，迁移也只是「按项目拆库」。

## 4. 方案对比

| | A. 一项目一 profile/进程 | B. A + 只读 Hub | C. 单进程多实例（Cordis isolate） | D. 单实例多租户（store 加 project） |
| --- | --- | --- | --- | --- |
| 看板/人/Router 隔离 | 天然完全隔离 | 同 A | 逻辑隔离，共用进程 | 逻辑隔离，共用库 |
| 每项目并发 | 每实例独立 `maxWorkers`（5），互不阻塞 | 同 A | 每实例独立，但共享事件循环/CPU | 需每项目调度器，最复杂 |
| 统一入口 | 多 URL；Hub 可汇总 | Hub 一个入口 | 天然一个面板 | 天然一个面板 |
| 核心代码改动 | 几乎为零（配置/启动器/迁移脚本） | + Hub（新小服务） | 中到大：Runtime/HTTP/客户端/settings/事件钩子去单例化 | 大：领域/store/查询/策略/面板全部项目化 |
| 故障/升级隔离 | 进程级 | 进程级 | 进程内，一崩全崩 | 同 C |
| 运维成本 | N 个进程/端口/日志/安装 | 同 A + 1 个 Hub | 1 个进程，最低 | 1 个进程 |
| Feishu 同一 bot 多实例 | 需独立 bot app 或单点 intake | 同 A | 同样需解决 | 同样需解决 |
| 迁移风险 | 低（新库+归档） | 低 | 中高（重构已工作的单例） | 高 |
| 适合阶段 | **先做** | **目标形态** | 以后若必须单面板再评估 | 不建议 |

### 4.1 为什么先 A 而不是 C

C 的吸引力是一个面板/URL，但它要求把今天的单例假设逐个改掉：命名服务（要 `isolate` 或参数化 `orchestrator`）、`/orchestrator` 路由与客户端 `PANEL_ID`、全局 `agent/created`/`session/event` 监听（要按 session 归属过滤，否则会把别人的 router 当 worker 限制工具）、插件入口上的设置表单，以及共享事件循环（一个项目的 worker 卡住主线程，另一个也卡）。

A 用部署手段先拿到 board/people/router/并发/故障隔离，几乎不改运行时核心（新增启动器和迁移脚本；只有 Stage 0 暴露归属问题才改事件过滤），并把 C 留成 Stage 3 的条件项：只有单面板成为硬需求、且项目边界/Hub 数据契约已验证时才做。

注意：**同 home 多进程也会看到彼此的 session/agent 事件**，这不是 C 独有；所以无论 A 还是 C，都要先验证归属过滤（见 Stage 0）。

### 4.2 为什么不是 D

D 的 UI 改动最小，但领域模型、SQL、策略、Source 路由、面板、迁移全部要带 `project` 维度；它把需要隔离的上下文重新放进同一个 store/进程，最贵也最不隔离。

## 5. 推荐路线

### Stage 0：先验证四个假设（约 1 天，含浸泡，go/no-go）

在写启动器和迁移之前，用两个临时 profile 做四个冒烟实验。任一失败就改方案，不带着未验证假设进入 Stage 1：

| # | 假设 | 做法 | 判定 |
| --- | --- | --- | --- |
| 1 | 同 home、多 profile 可并发 | 两个 profile 各起一个进程（不同端口/stateDir），各跑一个 turn，再做 10 分钟并发负载；期间重启其中一个 | 不互相覆盖、不报锁错；重启一个时另一个照常运行；两个面板都能开 |
| 2 | 全局 agent/session 事件能按实例过滤 | 在 B 的 `agent/created`/`session/event` 监听里加计数，A 建 session/worker，检查 A 的 worker 是否被 B 套上工具限制；再让 B 重启，A 保持一个运行中的 worker | B 的计数能明确显示是否触达；A 的 worker 不被 B 限制；B 的启动恢复/孤儿清理不杀、不接管 A 的 session |
| 3 | 多端口 panel 的 token/cookie 不互相覆盖 | 依次打开两个端口并登录，记录 Set-Cookie 名称与作用域，再回到第一个；用 `127.0.0.1` 与 `localhost` 各试一次 | token 是 home 级还是 profile 级有结论；不需要反复登录；冲突时由 Hub 同源代理解 |
| 4 | Feishu 同一 bot app 的重复消费者行为 | 分两种情形各发 ≥10 条消息并点一次卡片按钮：(a) 同一 `lark-cli` 配置目录（共用本机 event bus）；(b) 配置目录不同但 app 相同（两条飞书长连接） | 明确每种情形是竞争、广播还是单消费者；据此决定独立 bot app 或单点 intake |

**兜底**：1-3 任一失败 → 每项目独立 `DSH_HOME`（多一份 `pnpm install`，成本待实测）。4 若是竞争/广播 → 每项目独立 bot app（推荐），或先只让一个项目接 Feishu。

**拓扑只实现胜出的那种**：Stage 1 的启动器按 Stage 0 结论实现「同 home 多 profile」或「独立 home」，不维护两套并行支持；另一种只保留升级路径，不写进默认流程。

### Stage 1：一项目一实例（先落地）

范围：

1. **项目清单**（机器级，不进仓库）：`id/name/root/execution home(s)/backend/target/sources/people/env/port/maxWorkers/prompts`。建议 `%USERPROFILE%\.dsh\superagent\projects.json`，含绝对路径与端口。
2. **启动器**：`superagent projects start|stop|status|logs <id>`。今天 `bin/dsh-superagent-start.ps1` 把 profile/port/stateDir 写死；改成读项目清单，逐项目：
   - 复用仓库已有的 `scripts/dsh-superagent --profile <name>` 语义（控制目录/日志/PID/URL 已按 profile 分开）；Windows 包装脚本补上 `--profile` 透传。
   - 首次为项目创建 profile（`dsh --profile <name> --from-default-profile web` + `dsh plugin --profile <name> add link:<repo>`），之后只维护该 profile 的 `cordis.patch.yml`：`webserver.port`、`dsh-superagent.config.stateDir`、启用哪些 Source。
   - 端口分配、日志、token URL、陈旧锁清理、健康检查；拓扑按 Stage 0 胜出的那种实现。
3. **拆当前实例**：把现有实例拆成两个新 profile（`dsh` 自迭代、`game` 游戏项目），**新库起步**（M2，见 §6），旧库只读归档；每个实例独立 `maxWorkers`（默认 5；一个项目一个主执行 home 时就是每 workspace 5；项目内多 workspace 的槽位仍由 `workspaces[].slots` 管）。
4. **人/准入/规则/提示词**：随新实例配置，按项目编辑；不再有全局人名单。默认口径：每项目「准入名单 + 通知位置」，负责人/值班是可选项。
5. **不做的**：Hub、跨项目动作、A2A、统一 URL、单进程多实例。
6. **回滚**：旧实例停掉全部 Source、只读运行（不再接单）；新 profile 出问题时停新实例、重新启用旧实例的 Source。游标处理：旧库保留切换时的游标，TAPD/GitHub 会从旧游标补齐（可能重复，按 Trigger id 去重）；Feishu 长连接不重放，切换窗口内的消息会丢，需要时用历史回补；新实例消费过的事件不保证能在旧实例重放，回滚前要接受这段缺口。

**Stage 1 的三个 PR 切片**（供后续实现 ticket 拆分）：

- PR1：`--profile` 透传 + 启动器/清单 + Stage 0 冒烟脚本（不改运行时）。
- PR2：`dsh` 自迭代 profile + 新库；与旧实例并存，跑一轮真实工单验证互不影响。
- PR3：`game` profile + Feishu/TAPD 归属配置；切换通知与看板入口。

验收（可执行）：

- 两个项目同时运行：A 项目把 5 个 worker 跑满时，B 项目仍能立即接单并起 worker。
- A 项目的 Router 看不到 B 的 Trigger/Thread/Ticket；A 的看板不出现 B 的工单。
- A 的人名单不能触发 B：A 的 bot 在 B 的群里不响应；若 Stage 0 证明可共享 bot，则同一条消息只产生 A 的一张工单，不重复。
- A 暂停/崩溃不影响 B；A 的 worker 报错不影响 B 的调度。
- 重启后各项目的进行中工单能恢复（session/dir 归属正确）。
- M2 切换核对：两个新库从 0 开始；旧库只读且不再接单；Feishu/TAPD 游标和准入名单按项目复制正确；旧实例可回滚接管。

### Stage 2：只读 Hub

- 一个小的独立服务（Node，无 LLM、无 DSH）：从各项目 `GET 127.0.0.1:<port>/orchestrator/api/state` 读汇总，请求带 `x-orchestrator-request: 1`（现有 API 的防护头）；Hub 只监听回环，无跨项目写能力，渲染一页「全项目需要人处理的事」：待决定、待验证、阻塞、失败、进行中、最近活动、健康、链接到项目面板。
- 动作先不做；点击进入项目面板处理（deep link）。
- 可选：每天一条 Feishu 汇总，或「有新的待决定」通知；仍由各项目自己的 Feishu Source 发，Hub 不持 bot 身份。

### Stage 3（按需，不承诺）

- Hub 动作代理（在 Hub 里直接回答计划卡/问题）——需要跨进程写 API 和权限模型。
- 跨项目 A2A / 跨项目 Router——官方仍是开放问题，只有出现真实的跨项目协作需求再做。
- 若单面板成为硬需求，再评估 C，并复用 Stage 1/2 已验证的项目边界与 Hub 数据契约。

## 6. 数据迁移

现状一个库混了多项目，且「项目」在数据里没有一等标识：60 个 Ticket 里 38 个没有 target 记录，只能靠 Trigger 反推；354 个 Trigger 里 318 个是 Feishu。按 `source + chat/repo/owner` 归属能覆盖大部分，但跨项目 Thread、无地址的历史记录会留下 `unassigned` 桶。

- **M2（默认）新库起步**：每个新项目用空库；旧库只读归档，旧实例只读运行（不再接单）。切换前暂停调度、排空进行中的 Assignment；正在跑的工单等收口后再切。
  - 只复制「确实属于新项目且还需要」的少量 KV：Feishu/TAPD 游标、Source 的准入/同步配置、必要的人名单；不复制 Thread/Ticket 历史。
  - 历史查询留给旧面板；双轨期结束后旧实例下线。
- **M1（可选，后补）拆分历史**：如果以后需要在新看板里查历史，再做一次性导入：
  - Trigger 按 source+地址归属；Thread 由 Trigger 投票；Ticket 由 Trigger/target 投票；Decision 跟 Thread；Outbox/Effect 跟 Ticket。
  - 无法归属的进 `unassigned` 清单，交人工确认，不硬投票；跨项目 Thread 在非主项目只留一条带链接的只读引用。
  - 不迁移进行中的 Assignment；`runtime.masterId` 不复制（新实例建新 Router session）。
  - 脚本只读旧库、只写新库，带 `--dry-run` 和前后计数校验。

推荐 **M2 起步**：Router 本来就要换新 session，历史连续性保不住；174 个 Thread/354 个 Trigger 里大部分是非需求消息（需抽样确认，不是逐条判定），M1 的归属成本高于收益。M1 留在「以后需要历史查询」时再做。

## 7. 关键实现点与风险

1. **Feishu 同一 bot 多进程消费**（先做 Stage 0 实验，不先假定）。`lark-cli event consume` 通过本机 event bus 共享一个 app 连接；同一 EventKey 的两个消费者是竞争还是广播，实验前不知道；卡片按钮回调也走长连接。实验后二选一：
   - **每项目独立 bot app**（最干净；`lark-cli` 配置目录不同，`dsh-superagent-feishu` 的 `cli` 指向各自 wrapper）；
   - 或先只让一个项目接 Feishu，另一个项目只接 TAPD/GitHub；
   - 真要共享一个 bot，再做「单点 intake → 按 chat 分发到项目实例」的新组件（Stage 3）。
2. **同一个 DSH home 下多 profile 并发**（Stage 0 实验 1-3 验证）。DSH 的会话账本、部分设置是 home 级共享的；不同 profile 各有 `stateDir`、插件配置和端口，但面板 token/cookie 和全局 agent 事件可能互相影响。默认先按「同一 home、多 profile」推进；实验失败就切「每项目独立 `DSH_HOME`」，启动器同时支持两种拓扑。
3. **远程入口**：现有 `remote-gateway` 是单上游（Caddy 9443 → 3090 → 3082）。多项目需要每项目端口 + Caddy site/路由，或由 Hub 统一反代。Stage 1 先本机端口 + 项目 URL；远程访问在 Stage 2 和 Hub 一起收口。
4. **配置/人名单重复**：N 个项目 = N 份 people/policy/prompts。这是有意的隔离；可用「项目清单里的共享 defaults + 每项目覆盖」生成初值，但不做全局人管理服务（避免又造一个中心）。
5. **升级**：一个 bundle 版本对所有项目生效（同一份代码）；启动器负责逐个重启/回滚。不要出现项目间版本分叉（除非明确需要）。
6. **项目归属判定**：同一 Feishu bot 在不同群、TAPD 不同 owner、GitHub 不同 repo 都可映射；一个项目可以有多个 chat。清单里显式写 `sources` 映射，不靠猜。注意「项目」在现有数据里没有一等标识（38/60 Ticket 无 target），所以迁移按 M2 新库起步，不硬拆历史。
7. **「人管理」口径**：默认按「每项目准入名单 + 通知位置」设计，负责人/值班是可选项；等用户确认后再加字段，不先造新概念。
8. **回滚与双轨**：旧实例保留、只读运行；新 profile 出问题时停新实例、放开旧实例（旧库未被写入），新实例的库留作排查。明确旧实例何时下线、下线前谁确认新看板已经覆盖全部日常入口。

## 8. 与 Claude Code 的讨论记录

2026-11-03，Claude Code（sonnet，只读评审；仅基于本文与官方文章 §7-8，未读仓库其余设计文档）对 v0 的结论：**修改后采纳**（方向正确，一项目一进程是低风险做法；但 Feishu 同 bot、session/panel 隔离三个假设未验证，应先做实验；迁移改为 M2 起步）。原始输出留在 ticket 记录，不入库。

采纳的修正：

1. **依据改为 8.3**：7.2 是「不要为吞吐过早切分 Router」，与本次「为上下文隔离分实例」不是一回事，v0 的引用已改。
2. **补 Stage 0 四个实验**：同 home 多 profile 并发、全局 agent/session 事件归属、多端口 panel token/cookie、Feishu 同 bot 重复消费者；失败即切独立 `DSH_HOME` / 独立 bot app。
3. **迁移改为 M2 起步**：新库 + 旧库只读归档；M1 拆历史降为可选后补，并增加 `unassigned` 桶、排空进行中 Assignment、跨项目 Thread 只读引用。
4. **决策问题收敛为 3 个**：人管理口径默认「准入 + 通知位置」，不再单独问。
5. **补最小 PR 切片、回滚/双轨、项目身份缺失**；删掉 Worktree 服务条目，压缩 C/D 的论证。

保留未采纳的意见：

- **同 home 多 profile 仍作为默认起点**（Claude 倾向直接每项目独立 home）：先用 Stage 0 实验判断，实验失败再切；这样 Stage 1 的改动和安装成本最低，启动器同时支持两种拓扑。
- **Stage 2 只读 Hub 保留**：没有它，人还是要在多个面板之间找「哪里需要我」；Hub 不做动作、不做 A2A，符合 8.3 的隔离边界。
- **「一项目一实例」不变**：Claude 也认可这是低风险方向。

第二轮复核（同一评审，只读修订版）：结论「仍需小修改」。指出的 8 处——Stage 0 判定太弱（负向观测、无浸泡、未分共享 bus/双长连接、未测重启）、`pnpm store` 成本未验证、双拓扑支持是范围膨胀、双轨期 Source 与游标未说清、Hub 无鉴权、§6「噪声」无数据、§9 问题 2 偏向结论、「不改核心代码」口径不一致。均已按上文修正，评审意见是「补完即可提交评审」。

## 9. 请人决定

1. **Feishu**：按「每项目独立 bot app」准备（推荐，隔离最干净、需多配一个应用），还是先只让 dsh 项目接 Feishu、游戏项目只用 TAPD？Stage 0 实验若证明可共享同一 bot，再回来简化。
2. **迁移**：默认 M2 新库起步（推荐，快、干净、旧库归档）；是否改为 M1 拆历史（可查历史，但归属成本高、跨项目记录要人工确认）？
3. **项目粒度**：以 worktree/执行 home 为准（推荐），还是以「产品/团队」为准（可能一个产品多个 worktree）？两者可兼容：Project 拥有多个 execution home，但 Router/看板只有一个。

---

附：代码证据、只读统计与 Claude Code 评审原文留在 ticket 记录，不入库；本文对应 `docs/016-worktree-partitioning.md`。
