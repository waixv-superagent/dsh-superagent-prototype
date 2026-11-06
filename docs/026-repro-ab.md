# 026 · 复现用例的 A/B 跑测（轻量差分验证）

> 2026-11-06 · 由自动化代理（大肥鱼）实现，依据 11-05 复盘第 08 节「复现与验证」的方向。
> 方向、五段流水线与方法论综述见 [025 可复现验证](025-reproducible-verification.md)；本文只写 A/B 一段的
> 具体形态与判据。脚本是 `scripts/repro-ab.mjs`，可直接跑的合成示例在 `examples/repro-ab/`。
> 它是 [024 复现用例](024-repro-tests.md) 的上层：024 让一个 case 能被人反复重跑，本文让同一个 case
> 能在 baseline 与 fix 两臂上对照。

## 0. 一句话

同一个探针、同一组输入，在 A（baseline，改动前）与 B（改动后）各跑 N 次；断言写成两臂的关系
（变了 / 没变 / 增 / 减 / 在边界内），而不是写死一个精确期望值；缺一臂、缺观测或重复不一致都判
「信息不足」，绝不判通过。报告是自包含 HTML，面板的复现用例卡可以直接打开它。

## 1. 为什么是 A/B，而不是再加一套单测

方法论综述见 [025](025-reproducible-verification.md) 第 3 节；这里只记与 A/B 实现直接相关的取舍。

- **没有 oracle 的时候，关系比精确值可靠。** 动画、位移、镜头这类现象很难写出「第 3 帧必须是 12.7 厘米」；
  metamorphic testing 的做法是用「输入变换后关系不变」做断言（例如转镜头后角色位移不应随镜头速度放大），
  这正好是 A/B 能表达的：A 臂给出改动前的观测，B 臂检查关系有没有变。
- **差分验证把「修好了」变成可观察的差异。** 同一个 case 在 baseline CL 与 fix CL 上各跑一次，
  `滑动从 7.8 降到 0.42`、`状态从 turning 回到 idle` 都是证据；人不需要相信 agent 的形容词。
- **证据要独立于改动。** 只在本单代码里写断言，容易出现「同时改代码和测试期望」；A 臂是改动前录下的
  对照，B 臂只负责变或不变，方向和阈值由人先写下来。
- **人的注意力是瓶颈。** 报告只给结论、差异和能点开的产物，不把整份日志灌给人；同类归并、闲时池、
  注意力队列是别的工作流，不在本文假装实现。

这些是方向性依据，不是本文做过的实验复现；最后一节列了出处。

## 2. 与现有积木的关系

| 积木 | 在 A/B 里的角色 |
| --- | --- |
| [025 可复现验证](025-reproducible-verification.md) | 方向、五段流水线与判据；本文是其中 A/B 一段的最小实现 |
| [024 复现用例](024-repro-tests.md) | 一个 case 一个目录；`case.json` 仍是面板入口，`command` 指向本 harness，`report` 指向生成的报告 |
| [022 验证夹具](022-verification-fixtures.md) | 探针里用来制造缺失的边界（斜顶、多高度、时间窗），A/B 复用同一 fixture，避免两臂环境不同 |
| 现场捕获（envreporter） | 现象的第一手来源，可作为 A 臂的旁证；自动用现场上报生成 manifest 尚未接入（见第 8 节） |
| `scripts/ue-verify.mjs` | 把编译 + UE 自动化跑测作为探针的一部分；A/B 不重复实现编译和日志解析 |
| 面板「复现用例」卡 | 人点“运行”触发 B 臂 + 对照，跑完点“报告”打开同一份 HTML；不新增面板 |

## 3. case 目录

```text
<case>/
  case.json          # 024：面板入口；command 指向 .repro/harness.mjs replay，report 指向 .repro/report.html
  ab.json            # 本文：探针、观测、断言、容差（放在 .repro/ 或 case 根目录都可以）
  probe.py|mjs|...   # 探针：驱动编辑器/游戏，按固定输入重放，写观测与产物
  .repro/            # 本地产物：harness.mjs 快照、runs/、report.html、result.json（不进仓库）
```

`node <checkout>/scripts/repro-ab.mjs init <caseDir> --probe "<命令>"` 会生成 `.repro/harness.mjs`
（脚本快照，case 目录独立于 checkouts）、`.repro/ab.json` 模板；`case.json` 不存在时一并生成。
用例目录通常在 `<工程目录>/Saved/ReproTests/` 或 `<stateDir>/repro-tests/`，由 [024](024-repro-tests.md) 决定。
升级 harness 后在 case 目录重跑 `init --force` 即可更新快照；旧运行记录和报告不受影响。

[025](025-reproducible-verification.md) 建议 case 不新增身份格式，这里遵守：`case.json` 仍是 024 的入口，
A/B 的探针与断言放在 `ab.json`。没有把 `expect` 塞进 `case.json`，是因为宿主的 `ReproCaseSchema` 是 strict 的；
为一个工具的断言去扩宿主 schema，会把 harness 的细节绑进运行时。宿主只认 `case.json`，harness 只认 `ab.json`，
边界清楚。

### 3.1 ab.json

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 否 | 目前只支持 `1` |
| `probe` | 是 | 在 case 目录里运行探针的命令，平台 shell 执行 |
| `arms` | 否 | `{ "A": "...", "B": "..." }` 覆盖某一臂的命令；两臂用不同构建/入口时用 |
| `observation` | 否 | 探针写的观测文件，相对 `REPRO_RUN_DIR`，默认 `observation.json` |
| `timeoutSeconds` | 否 | 单次尝试的超时，10–7200，默认 900；超时会被杀掉并判信息不足 |
| `repeat` | 否 | 每臂默认跑几次，1–5，默认 1；建议时序类 case 用 2 |
| `tolerance` | 否 | 数值比较的绝对容差，默认 0 |
| `relativeTolerance` | 否 | 数值比较的相对容差（0–1），与绝对容差取较大值 |
| `expect` | 否 | 断言数组，见 3.3；为空时只留证据、不做判定 |
| `notes` | 否 | 报告顶部展示的一句话 |

未知字段会被拒绝，避免把 `expects` 这类拼写错误静默当成「没有断言」。

### 3.2 观测契约

探针把一次运行的可比结果写进 JSON 对象，路径由 `REPRO_RUN_DIR` 给出（每次尝试一个目录）：

```json
{
  "scene": "demo-flat",
  "input": { "sequence": "stand-still -> camera-turn-90", "seed": 7 },
  "metrics": { "slideMax": 0.42, "slideMean": 0.25, "fps": 59.2 },
  "state": "idle"
}
```

- **只写判定要用的量**：数组先归约成 `max / mean / 分位数`；报告和断言都按点号路径取值（`metrics.slideMax`）。
- 不要放大段原始日志、私有内容或凭据；日志写到 `stdout.log`，产物文件放在同一次尝试目录里，
  harness 会把它们挂到报告上（图片直接预览，其它给链接与摘要）。
- 建议把版本、场景、输入序列、seed 写进观测或产物的元数据：它们是「同一实验」的一部分。
- 缺失观测、非 JSON、非对象、读到不存在路径，都算信息不足，不算通过。

### 3.3 expect

| 字段 | 说明 |
| --- | --- |
| `path` | 观测里的点号路径；不支持带点号的键 |
| `op` | `changed` / `unchanged` / `increase` / `decrease` / `equals` / `within` |
| `value` | `equals` 的期望值；`within` 的绝对边界（非负数字） |
| `min` | `increase` / `decrease` 的最小变化量，默认 0（严格大于） |
| `tolerance` / `relativeTolerance` | 覆盖本次 `ab.json` 的容差 |
| `note` | 报告里显示的一句话，写清「为什么这条关系应该成立」 |

语义：

- `changed` / `unchanged`：B 相对 A 变/不变，按容差比较；比较两边都存在的字段。
- `increase` / `decrease`：B − A 或 A − B 严格大于 `min`；两边必须是数字，否则信息不足。
- `equals`：B 等于 `value`；数字按容差，字符串/布尔/结构按精确值。
- `within`：|B − A| ≤ `value`，用于「允许波动但不该大幅变化」的指标。

## 4. 命令与退出码

```sh
# 准备一个 case 的本地快照与清单
node scripts/repro-ab.mjs init <caseDir> --probe "py -3 probe.py" [--name "急转：镜头转动时的滑动"]

# 改动前：记录 baseline
node scripts/repro-ab.mjs run <caseDir> --arm A --label "baseline CL 589000"

# 改动后：跑 B 臂 + 与最近的 A 比 + 写报告（面板的“运行”就是这一步）
node scripts/repro-ab.mjs replay <caseDir> --label "fix CL 589120"

# 只比最近两臂，不跑；或指定某两次运行
node scripts/repro-ab.mjs compare <caseDir> [--baseline <runId>] [--candidate <runId>]

# 看这个 case 跑过什么
node scripts/repro-ab.mjs status <caseDir> [--json]
```

| 退出码 | 含义 |
| --- | --- |
| `0` | `replay`/`compare` 判定通过；或 `run` 这一臂成功产出了观测 |
| `1` | 用法/配置错误（清单写坏、命令不认识、目录不存在） |
| `2` | 有断言不通过 |
| `3` | 信息不足：缺 baseline / 缺观测 / 超时 / 重复不一致 / 没有声明 expect |

`replay` 即使没有 baseline 也会生成报告，但退出码是 `3`，报告里写明缺什么；这样面板里点“运行”不会把一次
没有对照的跑动伪装成通过。

## 5. 判定规则

- 断言在 B 臂的**每一次尝试**上都要通过：任一次 fail → `不通过`；任一次缺数据、超时，或两臂重复运行互相
  不一致 → `信息不足`；`expect` 为空 → `信息不足`（只留证据）。
- 未声明的字段变化会列在报告的「观测差异」里，但不参与判定；评审看整张差异表，而不是只看三行断言。
- **先验证 A 臂真的复现了现象**。A 臂与 B 臂都一样、断言又写成了 `unchanged`，会得到“通过”但什么也没证明；
  报告把两臂观测并排列出，就是为了让人先看 A 是不是那个现象。harness 不会替人判断这一点。
- 重复不一致按失败处理，不挑一次好看的结果。
- 退出码即结论：面板的“复现用例”卡把非 0 显示成失败/信息不足，同时仍可点开报告。

## 6. 报告

`replay`/`compare` 写 `.repro/report.html` 与 `.repro/result.json`：

- 顶部是判定与原因；两臂各一张卡，含命令、退出码、耗时、每次尝试的观测、图片产物和日志末尾；
- 「声明的断言」「逐次尝试」「观测差异」「重复运行」四张表；差异表覆盖全部观测字段，不只断言字段；
- 图片按相对路径挂在同一次运行的尝试目录下，面板的报告路由可以直接加载；HTML 是自包含的，不引用外部资源；
- 报告是只读产物，不替代人的验收：观感、手感、镜头与动画质量仍需人看（[022](022-verification-fixtures.md) 同理）。

面板侧不需要新 UI：`case.json` 的 `command` 是 `node .repro/harness.mjs replay`，`report` 是
`.repro/report.html`，点“运行”就跑 B 臂并刷新报告（[024](024-repro-tests.md) 的运行与报告规则）。

## 7. 一个真实 case 的走法

以今天的「急转时镜头转动导致滑动」为例：

1. **写探针**：在已经开着的编辑器里，按固定输入（站定 → 转镜头 90°、seed 固定）重放，采样角色朝向/位移，
   写 `observation.json` 和一张轨迹图到 `REPRO_RUN_DIR`；需要缺失边界时按 [022](022-verification-fixtures.md)
   加临时夹具，两臂用同一套夹具。
2. **改动前跑 A**：`run --arm A --label "baseline CL <旧 CL>"`；确认 A 的观测确实复现了报告里的现象。
3. **改动后跑 B**：`replay --label "fix CL <新 CL>"`；看报告结论与差异；把报告路径、两次运行 id 和
   `A→B` 的关键数字写进验证包的「预期与证据」。
4. **人来看**：在面板里点这个用例的“运行”复跑，或直接打开报告；需要旧构建时，用另一个 CL 的编辑器/构建
   分别跑两臂并给 `--label`，不要在一个已经开着的编辑器里换二进制。
5. **不稳定时**：先用 `repeat: 2` 确认现象可重复；不稳定先修夹具或增加等待，不要放宽断言把噪声盖过去。

## 8. 边界与后续

- **不做像素级 diff、视频判读或性能回归门禁。** 报告只回答「声明的指标变了没有、是否稳定」；视觉与手感仍由人判断。
- **不自动切 CL、不自动编译、不重启编辑器。** 这些由探针、[021 编辑器调度](021-editor-schedule.md) 或人安排；
  本 harness 只负责跑与留证，避免在共享编辑器上抢租约。
- **不做同类归并、闲时池、注意力队列。** 那些属于 [019 优先级与闲时](019-priority-and-idle.md) 和别的工单；
  本单不做自动修复优先级、不排队夜间任务。
- **环境现场捕获（envreporter）自动生成 A 臂清单尚未接入。** 目前 A 臂要显式跑一次；现场上报的字段如何
  映射到 observation 需要和那边的工具一起定。
- **不替 agent 写断言的方向。** `changed/unchanged/decrease/...` 是关系，不是模糊的「看起来好了」；
  agent 可以提出方向，但阈值与「A 臂是否真的复现」要写进证据，让人判断。

## 9. 方法论参考

本节不重复 [025](025-reproducible-verification.md) 第 3 节的综述（测试判定问题、属性/蜕变/差分测试、
SWE-bench 的 fail-to-pass、可观测性、注意力与队列）。与 A/B 实现直接相关的三条：

- [Metamorphic Testing: A Review of Challenges and Opportunities](https://doi.org/10.1145/3143561)（ACM CSUR 51(1)）：
  没有 oracle 时用输入变换后的关系做断言，是 `changed/unchanged/increase/decrease` 的思想来源。
- [SWT-Bench: Testing and Validating Real-World Bug-Fixes with Code Agents](https://arxiv.org/abs/2406.12952)：
  让 agent 把 issue 变成可复现测试，生成的测试还能当修复的过滤器。
- [Independent Verification as a Measurable Property of AI Coding Pipelines](https://zenodo.org/records/21759083)：
  独立验证层降低「静默发错修」；A 臂在改动前录下，B 臂不能改写它，正是这条的轻量做法。

以上是方向性引用，本单没有复做这些实验。

## 10. 验证

```sh
node scripts/repro-ab.mjs --self-test
pnpm exec vitest run tests/repro-ab.spec.ts
```

`--self-test` 不依赖编辑器，在临时目录里覆盖：两臂通过、断言失败、缺观测、重复不一致、缺 baseline、
报告转义与 `init` 产物。合成示例的完整走法见 `examples/repro-ab/README.md`。
实际结果以 PR 描述为准；本文件只记录规则与边界。

## 11. 文件

| 文件 | 作用 |
| --- | --- |
| `scripts/repro-ab.mjs` | 单文件、零依赖的 harness（init / run / replay / compare / status / --self-test） |
| `scripts/repro-ab.d.mts` | 测试导入用的类型声明 |
| `tests/repro-ab.spec.ts` | 清单校验、差分/断言语义、端到端 CLI 与报告 |
| `examples/repro-ab/` | 合成示例：两臂探针、清单、报告走法 |
| `prompts/work.md` | worker 在有可测的前后变化时使用本流程 |
