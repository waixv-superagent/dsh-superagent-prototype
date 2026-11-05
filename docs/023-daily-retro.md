# 023 · 每日复盘：固定触发、固定取数、固定结构

> 2026-11-05 · 由自动化代理（大肥鱼）编写。前三天的复盘都是人喊一句、代理现写一遍取数脚本；本文把它固定成每天都能跑、
> 能逐日 diff、能迭代模板的日常环节。

## 0. 一句话

数字由 `scripts/daily-metrics.mjs` 在本地一次算完，写成固定 schema 的 `metrics.json`；承诺记在台账
`retro-ledger.json`，第二天自动对账；`scripts/daily-retro.mjs render` 把两者渲染成固定 8 节的 HTML。模型只写叙述段，
不再自己数数，也不逐条读原始数据。

## 1. 为什么是 PTC 式取数

复盘的数据量很大：一天约 350 条人类消息、100 多条报告、上万次工具调用（11-04 是 9,948 次，分布在 44 个会话里）。
以前的做法是模型逐条 SQL 查、逐个文件解压，再把原始行读进上下文，一份报告要几十轮往返、几千次工具调用，
口径还每天漂移。

Programmatic Tool Calling 的做法（[Anthropic 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)、
[Cookbook](https://platform.claude.com/cookbook/tool-use-programmatic-tool-calling-ptc)）是：让代码去调数据源、做过滤和聚合，
模型只看最后的结果。这里没有托管的代码执行环境，所以等价做法是一条本地命令：

| 阶段 | 以前 | 现在 |
| --- | --- | --- |
| 取数 | 模型现写 4–6 个脚本，逐条查库 | `daily-metrics.mjs` 一条命令，口径写死在脚本里 |
| 读数据 | 原始行进上下文 | 只读 `metrics.json`（约 30 KB） |
| 成文 | 数字和叙述混写在 HTML 补丁里 | 数字由 `render` 填，模型只写 `narrative.md` |

脚本只读：数据库以 `readOnly` 打开，会话归档只解压读取，`gh` / `p4` 只调 list 类命令。写操作（发消息、改工单）不进脚本。

## 2. 触发

每天 23:30（Asia/Shanghai）由 DSH 的 Schedule 自动发一条固定指令，不需要人发消息。worker 预设里没有 schedule 工具，
所以这条定时任务要在你平时用的 DSH profile 里建（和 [006 部署](006-deployment.md) 的每小时巡检同一个做法）：让那里的
agent 用下面的指令建一个每天 23:30 的任务，投递到同一个会话（`new_once`）。

```text
每日复盘（固定流程见 <checkout>/docs/023-daily-retro.md）。在 superagent 的飞书私聊里发「启动今天的每日复盘，按 023 流程」给大肥鱼。
如果 superagent 不在线（scripts/dsh-superagent status 不是 0），就只在本会话里告诉我“今天的复盘没跑：服务不在线”，不要自己复盘。
```

复盘本身仍然是 superagent 里的一张工单，走正常的方案门与交付。定时任务只负责“到点喊一声”，不绕过任何权限。

## 3. 固定八步

| 步 | 做什么 | 命令 / 产出 |
| --- | --- | --- |
| 1 取数 | 导出窗口内的工单、assignment、报告、触发、决策、工具调用、PR、CL | `node scripts/daily-metrics.mjs --date <D> --p4-user <u> --p4-path "//sun/mainline/...@<D-1>,@<D+1>" --out metrics-<D>.json` |
| 2 对比 | 和前一天比数字 | `node scripts/daily-metrics.mjs --diff metrics-<D-1>.json metrics-<D>.json` |
| 3 对账 | 按工单状态更新昨天的承诺 | `node scripts/daily-retro.mjs ledger reconcile --date <D> --apply` |
| 4 归因 | 读 `reports.failures` 与 `reports.causes`；`other` 多了就是 `CAUSES` 表要加一类 | `narrative.md` 的 `## bottlenecks` |
| 5 四类复盘 | 需求 / bug / 闲聊 / 问询各挑 3–5 条；只引用 metrics 里的数 | `## review` |
| 6 明日方案 | 事故类 + 工作流类两层；每条要兑现的用 `ledger add` 记下来并指向工单 | `## plan` + 台账 |
| 7 渲染 | 生成 HTML；缺的叙述段会在 stderr 列出，并在报告里标“待填写” | `node scripts/daily-retro.mjs render --metrics metrics-<D>.json --previous metrics-<D-1>.json --narrative narrative.md --out daily-retro-<D>.html` |
| 8 自检与发送 | headless Chrome 截全页检查，再以文件消息发到当天话题 | HTML + 一条消息 |

`narrative.md` 用 `## <key>` 切段，key 固定为：`summary`（三行结论）、`review`、`bottlenecks`、`plan`、`research`、
`template`（模板本身要改的）。支持段落、列表、表格、粗体、行内代码和 https 链接；输入一律转义，不放行原始 HTML。

## 4. 产物

1. **metrics.json**，`schemaVersion: 1`。主要字段：`tickets`（含按类计数 `kinds` 与逐单 `list`）、`assignments.endedReasons`、
   `reports.states` / `causes` / `failures`、`restarts`、`intake`（消息 → 决策漏斗、交回、回执）、`delivery`（ready + 合并 PR + 入库 CL）、
   `tools`（按名字、按工单）、`hourly`（24 小时 × 人类消息 / 工具调用 / 推进 / 交付 / 失败）、`limits`（这次取数没覆盖到的地方）。
   改口径（例如 `CAUSES` 表）必须升 `schemaVersion`；版本不同的两天，`--diff` 会拒绝比较，`render` 也不画对比。
2. **承诺台账** `~/.dsh/state/superagent/retro-ledger.json`：每条承诺 = 一句话 + 工单号 + 截止日 + 状态
   （open / done / partial / missed / dropped）+ 变更历史。`reconcile` 的规则：工单完成或合并 → done；被停止 → dropped；
   到期仍未结 → missed；没有工单号的一律标“未开单”，过期即 missed。工单以其他方式结束时只提示，不替人判。
3. **HTML**，固定 8 节：① 结论与第一屏（三行结论、与昨天对比的数字、**未兑现的承诺**）；② 一天怎么过的（小时图、工单表、
   漏斗、交付）；③ 承诺对账；④ 哪里卡住（失败构成、结束原因、瓶颈）；⑤ 四类复盘；⑥ 明日方案；⑦ 外部对照；⑧ 口径、限制与模板。
   文件自包含，不引用外部字体、脚本或图片，飞书里直接能打开。

### 小时图

每小时一行，是一根横条上首尾相接的两段：左段蓝色是人类消息，紧接着是 agent 段，agent 段里灰色是工具调用、
橙色是流程推进（非 ready 报告）、绿色是交付（ready + 合并 PR + 入库 CL）。每个系列按全天自己的峰值缩放到固定份额
（人类 38%，工具 34%，推进 12%，交付 16%），所以一眼能看出“人说得多的时候 agent 在干什么、有没有交付”；
右侧是四个原始数字，失败报告另用红字标出。

## 5. 验收

- 取数 ≤ 10 分钟（11-04 实测：全库 + 58 个会话归档 + gh + p4 不到 1 分钟）。
- 一次复盘的工具调用 ≤ 200 次、读数据的往返 ≤ 2 次（读 metrics.json、读 diff）。
- 数字与前一天可以直接 diff；昨天未兑现的承诺一定出现在第一屏。
- 摩擦清单只允许结项，不允许悄悄消失：每条都要进台账，第二天对账。

## 6. 已知限制

- `outbox` 记录没有时间戳，回执与回复条数取自 `disposition.acked`。
- 人工提交 CL 时可能换号，入库 CL 不一定都能按 `oldChange` 关联回工单；关联不上的写进 `limits`。
- 工单分类优先读 `ticket.kind`（接单自动分类上线后写入）；旧单按来源和标题推算，和看板上的分类可能不同。
- 工具调用来自会话归档的 `tool/call` 事件；归档里损坏的 zstd 帧会跳过，并在 `limits` 里写明数量。


