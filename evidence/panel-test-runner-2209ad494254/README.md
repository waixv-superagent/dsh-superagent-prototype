# 复现用例入口 — 前后对比证据

两次截图来自两个一次性的 DeepSeek Harness 实例，除加载的 `dsh-superagent` 构建外完全相同：

- **Before**：`e3e771d`（本分支的基线），`pnpm build` 后装进 `lab/home-before`，服务在 `127.0.0.1:3097`。
- **After**：本分支的改动构建，装进 `lab/home-after`，服务在 `127.0.0.1:3098`。

两边都是 1440 × 1800 CSS px 视口、DPR 2、浅色主题；GitHub、飞书、TAPD 三个 Source 关闭，没有模型调用，工单为空。两边的 `<stateDir>/repro-tests` 放同样的两个用例：`pivot`（`node run.js`，跑完写 `reports/out.html`）和 `draft`（`case.json` 缺 `command`，显示“配置有误”）。Before 的旧构建没有这张卡，所以只截编辑器页。

| 文件 | 内容 |
| --- | --- |
| `before-editor.png` | 基线：概览 › 编辑器，只有编辑器调度与最近 60 分钟，没有复现用例卡片 |
| `after-editor.png` | 本分支：同一页，调度卡下面是“复现用例”卡片，列出 `pivot` 与 `draft`，`pivot` 的上一次运行显示成功、退出码 0 和报告 |
| `after-running.png` | 点 `pivot` 的“运行”后：运行中、停止按钮、实时输出（三次高度采样） |
| `after-succeeded.png` | 同一用例跑完：成功、退出码 0、最后的输出行，出现“报告”入口和更早运行的折叠 |
| `after-report.png` | 点“报告”打开的文件：用例目录里的 `reports/out.html`，由 sandbox 源提供 |

`capture/shoot.mjs` 是截图脚本：它打开实例，进入概览 › 编辑器，必要时关掉 Harness 的登录提示，点一次“运行”，截运行中与结束后的卡片，最后打开报告页截图。

## 局限

- 用例是替代脚本（等待几秒、打印采样行、写固定报告），只验证面板链路——列出、一键运行、实时输出、退出码、报告和重复运行——不验证任何游戏行为。
- 报告是静态 HTML；`file:///` 绝对路径的资源不会加载，产物要写在用例目录里。
- 两次截图时间不同，所以时间轴刻度和相对时间（“现在”“3 分钟前”）不同；两边的实验室状态相同（无工单、无编辑器进程）。
