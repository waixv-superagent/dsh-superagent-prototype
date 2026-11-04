# 017 · 闭环交付 P0 实施与升级迁移指南

> 2026-11-04 · 由自动化代理（大肥鱼）编写，依据 [闭环实现方案] 的已批准 P0 工作包、当天线上基线与本单实现。
> 适用对象：维护 `dsh-superagent` 这套部署的工程师。读完后应能独立完成一次「合并 → 干净构建 → 冒烟 → 重启 → 回滚」。

## 0. 一句话

这次不是换功能，而是把**已经修好但没提交的兼容修复**收口成可复现的干净构建，并给闭环补上四条自检：**工具面、通道、状态、会话**。
升级本身只改 `dsh-superagent` 与 DSH profile，不碰 p4 工作区；superagent 源码走 GitHub PR，游戏代码走 p4（见 [009 P4 and Swarm](009-p4-swarm.md) 的边界）。

## 1. 范围：P0 的五个工作包

| 工作包 | 本单交付 | 行为变化 |
| --- | --- | --- |
| WP-0 兼容修复收口 | 工作树里 13 个改动收成两个提交并开 PR：`fix(app)` 是工具 scope / `sessionQuery` / 端口判空，`chore(deps)` 是 peer 对齐 0.2.2-alpha.3、lock 与测试 | 无新行为，只是把线上正在跑的东西变成可评审、可回滚的 |
| WP-1 能力自检 | `worker-tools` 健康项；worker 会话解析出的工具缺 `read`/`write`/一个 shell 时，启动即把 Assignment 报 `blocked` 并点名缺什么 | 不再静默收窄成空工具面；正常 profile 行为不变 |
| WP-2 通道硬门 | 复用 main 上已有的 target→backend 判定（#19/#27）：GitHub 目标在 p4 默认部署下走 git、不进 P1 计划门、不注入 p4 交付模板；准入拒绝未配置的 target 并点名；`POST /tickets/:id/redispatch` 为人工一键改派入口。本单补回归测试与说明 | 无新行为，补齐验收 |
| WP-3 状态不变量 I4 | 每次 pass 检查可证明不一致的状态：`running` 但无 live worker 且从未上报 → 恢复重启；`pending` 但 launch effect 消失 → 重新入队；有未送达输入但 delivery effect 消失 → 重新入队。每类最多自修 2 次，之后 `blocked`。痕迹记在 `ticket.repairs`，接口与看板行可见 | 状态自愈；不再需要人先发现「一直 running 但没在跑」 |
| WP-4 会话持久化加固 | 会话打不开时按 250ms、500ms 退避**有界重开** 2 次；仍失败则 Assignment `failed`（沿用 main 的坏会话策略：报告一次、附修复提示、不自动重试），点名错误并保留原会话历史；关停时 flush 失败只记日志、不阻塞停止与重启；`hostRestarted` 恢复路径复用同一套重建 | 单类会话故障不再无限重试，也不删历史 |

不在本单：P1 的分级字段/看板、规则分类器、闲时分析 + Stash、注意力三卡（WP-5–8）；本单不重启线上以外不做任何提交动作。

## 2. 数据与兼容面

| 项 | 结论 |
| --- | --- |
| SQLite schema | 不变，仍是 `SCHEMA_VERSION = 11`；`Ticket.repairs` 是 JSON 里的可选字段，旧记录没有它按空数组处理，无需迁移脚本 |
| 会话存储 | 不改变格式。DSH `0.2.2-alpha.3` 的 `dsh-session-persistence` 已用原子写（含 `dsh-atomic-write`），torn tail 在下次 open 时由写路径截断；本单**不删除**任何 session 文件 |
| Profile | 仍以 `file:` 链接本仓库；升级时从 `main` 的干净提交构建，不依赖工作树 |
| 交付通道 | superagent 走 GitHub PR；`//sun/mainline` 的 p4 工作区只读，不 `p4 submit`（[009 P4 and Swarm](009-p4-swarm.md)） |
| 飞书身份 | `lark-cli config strict-mode` 当前为 `user` 时 bot 身份不可用；这是安全策略，**必须由人确认后**切回 `bot`/`off`，agent 不得自行切换 |

**为什么坏会话不自动删**：会话是 worker 唯一的历史与证据。本单的恢复策略是「重开 → 仍失败就 blocked 并保留文件」，让人决定归档或重建；自动删除会让排障失去现场。

## 3. 升级前检查清单

- [ ] PR 已合并到 `main`（或至少已评审通过），本地 `git status` 干净
- [ ] `pnpm install` 能装齐 0.2.2-alpha.3（`pnpm-workspace.yaml` 的 release-age 例外已随 WP-0 提交）
- [ ] 备份：profile 目录、当前 `lib`、`package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`、`cordis.patch.yml`、`patches`、`.env`
- [ ] 备份 `orchestrator.sqlite` 及其 `-wal`/`-shm`
- [ ] 记录：`git rev-parse HEAD`、进程 PID 与启动参数、`/orchestrator/api/state` JSON、在跑工单列表
- [ ] 确认低峰窗口，提前告知「会重启、可能打断在跑的单」
- [ ] 确认没有其他进程/工单正在改这个 profile 或仓库
- [ ] 确认 `lark-cli config strict-mode` 的预期状态（需要飞书能力时由人切到 `bot` 或 `off`）

## 4. 升级 runbook

### Step 1 · 记录基线

```powershell
cd D:\Projects\Agent-PlayGround\dsh-superagent
git rev-parse HEAD
$state = Invoke-RestMethod http://127.0.0.1:3082/orchestrator/api/state -Headers @{ 'x-orchestrator-request' = '1' }
$state | ConvertTo-Json -Depth 6 | Set-Content .\state-before.json -Encoding utf8
Get-Process -Name node | Where-Object Id -ne $PID | Select-Object Id,StartTime
```

拿不到 `/orchestrator/api/state` 就先查 3082 健康，不继续。

### Step 2 · 干净构建（不碰工作树里的临时东西）

```powershell
git checkout main
git pull --ff-only
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

记录：提交号、用例数、耗时、`lib/index.js` 的 mtime。任一失败则**不切线上**，修完重来。

### Step 3 · S2 隔离实例冒烟（端口 3099，独立 state）

复制 profile 到 `superagent-smoke`（可只复制 `package.json`、两个 lock/workspace 文件、`cordis.yml`、`cordis.patch.yml`、`patches`，`node_modules` 用 junction 或重新安装），把 `dsh-superagent` 指到本仓库（或发布 worktree），在 `cordis.patch.yml` 里把 `stateDir` 指到独立目录、端口改成 3099，并**删掉 remote-gateway 的 `insert` 块**（否则第二个实例会抢 3090/9443）。然后：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\superagent-smoke"
pnpm install   # file: 依赖会复制进 .pnpm；不装会跑旧构建
node "$env:USERPROFILE\.dsh\profiles\superagent-smoke\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile superagent-smoke --no-open --host 127.0.0.1 --port 3099
```

独立的 state 目录建议从线上库做一次一致性快照（`VACUUM INTO`），但删掉业务表与 `runtime/masterId`，并把 settings 设为 `paused: true`、所有 Source `enabled: false`：这样第二实例只验证构建，不与线上抢 master Session、不消费也不回复任何真实消息。

通过标准：

```powershell
$smoke = Invoke-RestMethod http://127.0.0.1:3099/orchestrator/api/state -Headers @{ 'x-orchestrator-request' = '1' }
$smoke.health
```

- `runtime` / 各 Source health 为 `ready`；
- `health['worker-tools']` 存在；没有 worker 启动时是 `starting`，启动过 worker 后应为 `ready` 且 detail 列出 `read, write, ... pwsh`；
- 起一张只读合成工单（或复用仓库里的 S1 测试路径），确认新 worker 工具齐全、transcript 可读、首批 report 无「能力面」类 blocked；
- 关停后无残留进程、端口释放；全程不碰线上 state。

### Step 4 · 安装并切换 3082

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$env:USERPROFILE\.dsh\profiles\superagent" "$env:USERPROFILE\.dsh\profiles\superagent-backup-$ts" -Recurse -Force
```

**关键**：profile 的 `package.json` 虽然写的是 `file:D:/Projects/Agent-PlayGround/dsh-superagent`，但 pnpm 会把该目录**复制**进 profile 的 `node_modules\.pnpm\dsh-superagent@file+...\node_modules\dsh-superagent`。因此只在本仓库 `pnpm build` **不会**更新线上构建，必须在 profile 里重装：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\superagent"
pnpm install --force
# 核验装进去的是本次构建（mtime 应等于仓库 lib、且含 017 的新符号）
Get-Item "$env:USERPROFILE\.dsh\profiles\superagent\node_modules\.pnpm\dsh-superagent@file+*\node_modules\dsh-superagent\lib\index.js" |
  Select-Object FullName,Length,LastWriteTime
Select-String -Path "$env:USERPROFILE\.dsh\profiles\superagent\node_modules\dsh-superagent\lib\index.js" -Pattern 'worker-tools' -Quiet
```

若 `--force` 仍没刷新（lockfile 认为 file: 依赖未变），就删掉 `node_modules\.pnpm\dsh-superagent@file+*` 后再 `pnpm install`，或直接把仓库 `lib\` 复制到该安装目录，然后重新核验。

```powershell
# 停旧进程（记录 PID）后按当前线上同款命令启动：显式 DSH_HOME=.dsh、--profile superagent、--no-open
Stop-Process -Id <旧 PID>
node "$env:USERPROFILE\.dsh\profiles\superagent\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile superagent --no-open
```

注意：`start-superagent.ps1` 是 0.2.1-rc.5 时代脚本，默认 home 是 `.dsh-rc5`，不要用它切当前实例。强杀后若 `superagent.lock` 残留，启动前清理。

### Step 5 · 恢复与观测（15 分钟）

- 被中断的工单由宿主自动恢复（带最近 report 的恢复说明）；必要时 `POST /tickets/:id/retry` 或 `POST /tickets/:id/redispatch`；
- 看第一张新 worker：`orchestrator_read ticket/<id>/transcript`，工具清单完整、transcript 可读；
- `health['worker-tools']` 为 `ready`，`health.worker` 无 error；
- 首批 report 不出现「能力面」「通道」类 blocked；出现则暂停派单并回滚。

### Step 6 · 回滚（目标 <10 分钟）

1. 停 3082；
2. 恢复备份 profile 与旧 `lib`；
3. 用同款命令启动，等 `/orchestrator/api/state` ready；
4. 改派/重试被中断的工单；
5. 记录失败原因与时间；回滚前不要删除新 profile 与日志。

## 5. 冒烟分层（本单实际执行与后续要求）

| 层 | 何时 | 本单状态 | 通过标准 |
| --- | --- | --- | --- |
| S1 单元/集成 | 每个 PR | `pnpm typecheck` 0 错；`pnpm test` 全绿（新增 `tests/smoke.spec.ts` 等） | 全绿；空工具面在启动即 blocked 并点名 |
| S2 隔离实例 | 切换前 | 按 Step 3 在 3099 独立 state 冒烟 | health ready；worker-tools ready；无 crash |
| S3 线上金丝雀 | 重启后 10 分钟 | 宿主恢复本单后按 Step 5 看 | 新 worker 工具齐全；无能力/通道类 blocked；状态卡绿 |

S1 的关键断言：accept 一张假单 → worker 启动 → 工具含 `read/write/pwsh|bash` → transcript 可读 → `orchestrator_report ready` → 单结束；另注入「preset 工具缺失」的假 profile → 首条消息即 `blocked`、`worker-tools` 变红且 detail 点名缺的工具。

## 6. 风险与限制（诚实说明）

- **TTL 与次数是经验值**：`running` 无 worker 的判据是「5 分钟未变且从未上报」，自修上限每类 2 次；P1 接入分级与真实心跳后再收紧。
- **坏会话不自动重建**：只在有界重开后仍失败时按 main 的坏会话策略报 `failed`（附修复提示、不自动重试）并保留历史；真正需要归档/重建时由人执行。
- **`repairs` 的可视化**：本次只把痕迹写进 ticket 行（API/看板数据），「系统已处理」条带与注意力三卡属于 P1（WP-8），本单不做无视觉证据的 UI 改动。
- **WP-2 是验收不是新实现**：target→backend 的判定在 main 上已由 #19/#27 完成；本单只补回归测试与文档，避免重复造门。
- **重启会打断在跑的单**：这是 runbook 接受的中断；恢复由宿主与 retry/redispatch 兜底，不能保证每个 Assignment 无损继续。
- **外部依赖**：`gh`、`p4`、`lark-cli` 的可用性与身份策略不在本单范围内，但升级前必须确认（尤其飞书 strict-mode）。

## 7. 验收清单

- [ ] PR 合并；`pnpm typecheck`、`pnpm test`、`pnpm build` 全绿
- [ ] `health['worker-tools']` 在 3082 为 `ready`，detail 列出工具
- [ ] 新 worker 的 transcript 可读，工具面完整
- [ ] 重启后 10 分钟内无「能力面/通道」类 blocked
- [ ] 至少一张单出现 `repairs` 痕迹（或确认无需要修复的状态）
- [ ] 升级记录：提交号、测试计数、切换时间、异常与处理、回滚是否发生

## 8. 分工

- **人**：定窗口、确认 P0、合并与提交、最终验收；确认飞书 CLI 身份策略。
- **系统/worker**：构建、备份、S1/S2/S3 冒烟、切换、观测、回滚、恢复工单。
- **禁止**：agent 自行切换 lark-cli strict mode；未评审直接覆盖线上 profile；在迁移中改动 p4 工作区；提交 `//sun/mainline`。
