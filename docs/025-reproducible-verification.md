# 025 — 可复现验证：从一次性复现到可重跑的 A/B 证据

> 2026-11-06 · 由自动化代理（大肥鱼）编写。11-05 的讨论提出：把 agent 介入的需求 / bug 复现流程打通，写一个可复用、
> 但不到单元 / 集成测试那么严谨的自动跑测脚本，给修复和实现做 A/B，人要能观察；同时调研方法论，为长期建设找方向。
> 本文给方向、依据与判据；具体入口见 [024 复现用例](024-repro-tests.md)，夹具模型见 [022](022-verification-fixtures.md)。

## 0. 一句话

复现的价值不在「跑通一次」，而在「换一版代码再跑一次还能比」。所以把一次复现拆成**场景 + 输入 + 观测 + 对照 + 证据**
五件事，用最便宜的脚本一次跑完，人只看一屏能判的差异：它比单元 / 集成测试松，但比读代码猜硬。

## 1. 为什么现有测试不够用

- **行为依赖场景**：转角滑动、跳跃撞顶、动画过渡这类问题，取决于地图、几何、时序和资产版本；单元测试碰不到组合，
  集成测试重、慢、维护贵，而且大多数边界在现有场景里根本不出现（[022](022-verification-fixtures.md) 的起点）。
- **复现脚本散在会话里**：只有写它的 agent 知道怎么跑；人想再看一遍就得重新开会话、重写命令，验证变成一次性表演。
- **A/B 常被做成「看一眼感觉好了」**：没有同一输入、同一场景、同一观测口径的对照，改前改后不可比，结论只是印象。
- **人的注意力**：证据必须一屏能判。让人读日志、翻会话、比对两张长图的验证，等于没有验证（[000](000-philosophy.md)）。

## 2. 结论：五段流水线，一条命令，一屏证据

| 段 | 做什么 | 产物 | 已有积木 |
| --- | --- | --- | --- |
| 1 capture | 把现场变成可重放的东西：场景 / 夹具、输入、观测点、复位 | `case.json` + 脚本 | 022 的四要素、024 的用例目录 |
| 2 replay | 一条命令重放；固定种子 / 时间 / 输入；不打断正在用的编辑器 | 退出码 + 日志 + 采样 | 024 的 `ReproRunner`（一次一个、超时、日志） |
| 3 A/B | 同一 case 跑 baseline（改前）与 change（改后），换参数也走同一入口 | 两份产物 + diff | 021 的编辑器租约与调度、p4 / git 的改前版本 |
| 4 cluster | 把失败按签名归并（首个错误行、指标 delta、栈顶帧），同类只给人一行 | 去重后的失败清单 | 本文件 3.5 |
| 5 idle | 重活进闲时池，人坐下时只收到「跑完、可判」的结论 | 一屏证据 + 待判断 | 019 的五信号闲时门 |

最小 case 的形态与 [024](024-repro-tests.md) 的 `case.json` 对齐，不新增格式；补上 022 的四要素说明：

```
name / scenario（地图、夹具标签、变换、碰撞、涉及哪些 world）
input（真实输入路径、时机、次数；不要用假动画驱动）
measure（判定量：轨迹采样、状态、日志行、帧时间；密度要能看到边界）
reset（夹具按前缀清理、不复存地图）
command（一条命令）
report（跑完打开的文件，相对用例目录）
```

三条门槛：**一条命令**（人不用读代码就能跑）；**≤ 10 分钟**（闲时池排得下）；**报告自包含**（截图、表格、日志片段都在里面，
外链会失效的不算）。这就是「不到单元 / 集成测试那么严谨」的具体含义：不追覆盖率、不建第二套 CI、不把每个分支都断死；
一个 case 只证明一个已知边界的一次对照。

## 3. 理论支持

### 3.1 实验观：可复现 = 变量受控 + 观测可比

把复现当实验，而不是「再跑一次游戏」。022 的四要素（场景、输入、测量、复位）缺一条，两次运行就不可比；不可比就没有 A/B，
只有「看起来好了」。

- **测试判定问题（oracle problem）**：很多「对不对」没有廉价 oracle——手感、审美、表现是否自然。这类判断必须留给人
  （[012](012-gates-and-cards.md) 的 P4.5「待你判断」），机器只证「可观测的东西变了 / 没变」。
- **可复现性来自记录，不来自记忆**：版本（CL / 分支）、资产、地图、种子、输入时序都要进证据包；只写「我测过了」的结论不可复现。
- **record & replay**：确定性重放把一次现场变成可重复的输入序列；整机重放做不到时，用固定输入脚本 + 固定采样点近似——
  我们的 case 就是这种近似，所以要把近似边界写进报告。

### 3.2 轻量自动化的五个来源（都不要求建 CI）

- **快照 / 黄金文件（golden / approval testing）**：把「期望的样子」存成文件（轨迹采样、截图、JSON），每次重跑 diff。
  便宜、可读，适合表现类回归；代价是期望值要人确认一次，确认后才有意义。
- **属性测试（property-based）**：不枚举输入，声明性质（「急转后朝向单调收敛」「速度曲线积分等于位移」），让工具生成用例。
  适合能写成不变量的量。
- **蜕变测试（metamorphic testing）**：没有 oracle 时，用「输入变换后输出应怎么变」的必然关系判定（对称、缩放、单调）。
  例如把斜顶高度调低，接触高度必须下降；关系不成立就是 bug。
- **差分测试（differential testing）**：同一输入喂给 baseline 与 change（或 A 实现与 B 实现），比较输出差异。修 bug 的 A/B
  就是它的特例：不要求知道「正确值」，只要求「差异可解释」。
- **增量调试（delta debugging）**：复现太大时自动缩小——删输入、删实体、删步骤，直到最小仍复现。把「一整个关卡」缩成
  「一个斜顶 + 一次跳」，这是让 case 进入 ≤10 分钟门槛的关键。

### 3.3 agent 介入：让它写 case、跑 case、留证，不替人当裁判

- **fail-to-pass / pass-to-pass**：SWE-bench 的口径值得抄——一个修复要有「改前失败、改后通过」的对照，以及「原本通过的
  没被弄坏」的检查；没有对照的「通过」不算数。
- **ACI（agent-computer interface）**：SWE-agent 的观察是，agent 的工效取决于它能看见什么、能动什么。harness 要把
  输入、动作、观测（stdout、diff、截图）留成结构化日志，否则人无法复核，agent 也无法自我修正。
- **agent 生成测试的自利风险**：它会写出迎合当前实现、只测 happy path 的测试。对策是 022 的「先验证夹具」：夹具不改变
  观测，就是失败的实验，不是通过的结果；验收标准由人定，不由测试自己定。
- **可观测性**：logs / metrics / traces 的意义是「不用猜内部状态」。复现脚本应主动采样（位置、速度、动画状态、帧时间），
  而不是只截最后一张图；截图证明「看起来对」，采样证明「确实变了」。

### 3.4 人的注意力：把决策排成队列，而不是把人放进队列

- **注意力是稀缺资源**（Simon）：架构目标不是「多跑」，而是让人在最短时间内做最贵的判断。
- **中断有成本**（Mark 等）：被打断后回到原任务要重新进入状态；所以收集证据在人不在时做，判断在人坐下时一次给全。
- **证据优先**：一屏先给结论与对照，细节折叠；人不需要读日志才能说「过 / 不过」。
- **WIP 限制与队列**（Kanban、Little 定律、成本延迟）：闲时池不是「有空就跑」，要按「最晚开始时间」和「是否真的卡着人」
  排序；同时跑太多低价值 case 只会制造一整池待读报告，正是 [000](000-philosophy.md) 要避免的。
- **度量**：DORA 的变更失败率 / 恢复时间可以借来量 harness 本身——它是否减少了返工和「再问一遍」的次数。

### 3.5 失败聚类：同一原因只占人一行

- **签名优先于文本相似**：首个错误行、异常类型、失败的指标名 + 方向（偏高 / 偏低）、栈顶帧，比「描述像不像」稳定。
- **归并的收益是注意力**：10 个同因失败 = 1 条「某类断言整体回归」，人只需判一次；这也让同类 bug 自然合成一个 case。
- **可回查**：每个簇保留代表 case 与成员列表，避免「归并后看不见个体」。

## 4. 建议方向（按代价从低到高）

1. **今天**：统一 case 规范（复用 024 的 `case.json`，把 scenario / input / measure / reset 写进说明）；每个 case 一条命令；
   报告一屏：结论 / baseline vs change / 证据 / 待判断。
2. **本周**：A/B 跑两次——baseline 用改前的 git worktree 或 CL，change 用当前改动；同一 metrics 口径；自动 diff 产物
   （轨迹采样、日志关键字、截图）。
3. **下一步**：参数扫描（022 的「斜坡」思路：一个 case 扫多个高度 / 角度）与失败聚类；把同类问题并成一个 case。
4. **闲时化**：重活进 [019](019-priority-and-idle.md) 的闲时池（L2 / L3），白天只接受「已跑完、等人判」的 case；早间摘要按
   「最晚开始时间」排序。
5. **不做**：不建第二套 CI；不自动判定审美 / 手感；不在人醒着的高价值时段抢编辑器或抢注意力；不为「全自动」牺牲可复核性。

验收 harness 自身的指标：人判一单 ≤ 2 分钟；同一 case 重跑成功率；误报率（改前改后都过却报差异）；平均重跑时长；
闲时池消化量；返工率是否下降。

## 5. 与现有文档的关系

- [022](022-verification-fixtures.md) 给夹具与边界扫描的模型；[024](024-repro-tests.md) 给「人也能点一下重跑」的入口；
  [021](021-editor-schedule.md) 给编辑器租约与调度；[019](019-priority-and-idle.md) 给闲时池与优先级；
  [012](012-gates-and-cards.md) 给「机器关卡」与「人来判」的分界。
- 本文只定方向与判据；具体命令、目录和面板入口由实现工单决定，不在这里写死。

## 6. 参考

- 测试判定问题：E. J. Weyuker, *On Testing Non-Testable Programs* (The Computer Journal, 1982) —
  <https://doi.org/10.1093/comjnl/25.4.465>
- 测试金字塔：M. Cohn, *Succeeding with Agile* (2009)。
- 属性测试：K. Claessen, J. Hughes, *QuickCheck: A Lightweight Tool for Random Testing of Haskell Programs* (ICFP 2000) —
  <https://doi.org/10.1145/351240.351266>
- 蜕变测试：T. Y. Chen, S. C. Cheung, S. M. Yiu, *Metamorphic Testing: A New Approach for Generating Next Test Cases*
  (HKUST-CS98-01, 1998)。
- 差分测试：W. M. McKeeman, *Differential Testing for Software* (Digital Technical Journal, 1998)。
- 增量调试：A. Zeller, R. Hildebrandt, *Simplifying and Isolating Failure-Inducing Input* (IEEE TSE, 2002) —
  <https://doi.org/10.1109/32.988498>；C-Reduce：J. Regehr et al., *Test-Case Reduction for C Compiler Bugs* (PLDI 2012) —
  <https://doi.org/10.1145/2254064.2254104>
- 记录与重放：R. O'Callahan et al., *Engineering Record and Replay for Deployability* (USENIX ATC 2017) —
  <https://www.usenix.org/conference/atc17/technical-sessions/presentation/ocallahan>
- 抖动测试：Q. Luo et al., *An Empirical Analysis of Flaky Tests* (FSE 2014) —
  <https://doi.org/10.1145/2635868.2635920>
- SWE-bench：C. E. Jimenez et al., *SWE-bench: Can Language Models Resolve Real-World GitHub Issues?* (ICLR 2024) —
  <https://arxiv.org/abs/2310.06770>
- SWE-agent：J. Yang et al., *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering* (2024) —
  <https://arxiv.org/abs/2405.15793>
- 可观测性：OpenTelemetry 文档 — <https://opentelemetry.io/docs/>
- DORA：N. Forsgren, J. Humble, G. Kim, *Accelerate* (2018)。
- 注意力：H. A. Simon, *Designing Organizations for an Information-Rich World* (1971)；
  G. Mark, D. Gudith, U. Klocke, *The Cost of Interrupted Work: More Speed and Stress* (CHI 2008) —
  <https://doi.org/10.1145/1357054.1357072>
- 在线对照实验：R. Kohavi, D. Tang, Y. Xu, *Trustworthy Online Controlled Experiments* (2020)。
- 队列与 WIP：D. J. Anderson, *Kanban* (2010)；D. G. Reinertsen, *Principles of Product Development Flow* (2009)。
