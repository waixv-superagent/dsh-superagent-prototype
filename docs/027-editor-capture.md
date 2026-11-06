# 027 编辑器内截图：把编辑器自己的渲染作为工单证据

> 2026-11-06。触发场景：Windows 会话锁屏（或远程桌面断开）时桌面截图是黑的，而同一时刻 DSH 看板能用
> headless Chrome 截到——因为那是浏览器自己渲染的，不是抓屏幕。Unreal Editor 同样在渲染自己的窗口，
> 于是把「编辑器内的截图」接进工单的验证包，作为 UI/编辑器类改动的证据。

## 0. 一句话

worker 在持有共享编辑器租约时调用 `orchestrator_editor op=capture`，宿主通过引擎自带的
`ModelContextProtocol` 服务让编辑器把自己的 Slate 窗口渲染成 PNG，写到工单的证据目录并返回路径与
尺寸/sha256；验证包引用这个路径，PR 的 before/after 用这些图。整条路不经过桌面，所以锁屏时也能截。

## 1. 为什么不是桌面截图

- 桌面截图依赖可见的窗口合成结果；锁屏、RDP 断开、窗口被遮挡/minimized 时拿不到可信像素，常见结果是黑图。
- 编辑器在独立于桌面可见性的渲染路径上：Slate 把窗口画进自己的 render target，`FSlateApplication::TakeScreenshot`
  从这条路径读回像素（`SlateInspectorToolset.Screenshot` 即此实现）。它不需要窗口在最前面，也不经过屏幕。
- 因此「编辑器在渲染」就是可靠的证据来源；桌面截图只应作为编辑器不可用时的退路，而不是默认。

## 2. 形态

```
worker ──orchestrator_editor op=capture window="SunGame"──▶ 宿主
                                                         ├─ 校验租约（必须持有）
                                                         ├─ 引擎 MCP 127.0.0.1:8000/mcp（Streamable HTTP）
                                                         │   ├─ initialize / notifications/initialized
                                                         │   ├─ tools/list（要求 call_tool：tool-search 模式）
                                                         │   ├─ call_tool SlateInspectorToolset.Windows(action=list)
                                                         │   ├─ call_tool SlateInspectorToolset.Windows(action=select, index)
                                                         │   └─ call_tool SlateInspectorToolset.Screenshot(ref="")
                                                         └─ 校验 PNG → <stateDir>/evidence/<ticketId>/
                                                                    <UTC 时间>-<窗口 slug>.png
                                                                    <同名>.json（sidecar）
```

- `window=` 是窗口标题的子串，大小写不敏感；省略时截当前活动窗口，不做窗口切换。
- 给出 `window=` 时先 `Windows(action=list)`，标题必须唯一匹配才 `Windows(action=select)`；`select` 会把目标
  窗口前置（焦点变化，不改数据），这是为了 `Screenshot(ref="")` 取到确定的那个窗口。
- 返回值包含：`path`、`metadata_path`、`target`（`active`/`window`）、`window`（index/title）、`width`、`height`、
  `bytes`、`sha256`、`captured_at`、`editor`（endpoint 与 toolset）。worker 直接把 `path` 写进「预期与证据」。

## 3. 存储与证据流

- 默认目录 `<stateDir>/evidence/<ticketId>/`；同名冲突加数字后缀，不覆盖上一张。PNG 落盘前校验文件头
  （magic + IHDR）并拒绝零尺寸；不是合法 PNG 就只报错、不写文件。
- 同名 JSON sidecar 记录 ticket、采集时间、目标窗口、尺寸、字节数、sha256、引擎端点与 toolset；sha256 让
  同一张图在验证包、PR 与工单记录之间可对得上。
- worker 报告里的用法：
  - 「预期与证据」写 `截图：<path>（<width>x<height>，sha256 前 12 位，窗口 <title>）`；
  - UI 改动按交付要求把 before/after 图放进 PR（可以把文件复制到仓库 `evidence/<ticket>/` 后引用，或附在
    Swarm review 评论/飞书里，取决于交付通道）；
  - 证据是宿主本机文件，工单页只显示文本路径，不内嵌图片；要变成面板内嵌图是后续 UI 工作。

## 4. 配置与前置

| 项 | 值 |
| --- | --- |
| 引擎 MCP 端点 | 默认 `http://127.0.0.1:8000/mcp`；`DSH_SUPERAGENT_EDITOR_CAPTURE_URL` 可覆盖 |
| 谁启动服务 | SunGame 的 `EditorPerProjectUserSettings.ini` 已设 `bAutoStartServer=True`、`ServerPortNumber=8000`，编辑器启动即可用；其它工程需开启 `ModelContextProtocol` 的 Auto Start Server，或在控制台执行 `ModelContextProtocol.StartServer` |
| 工具集 | `SlateInspectorToolset`（SunGame.uproject 已启用）；端点必须是 tool-search 模式（有 `call_tool` 元工具） |
| 租约 | 必须持有共享编辑器租约（`orchestrator_editor op=acquire purpose=use`）；人占着编辑器时不抢 |
| 平台 | Windows 编辑器；与桌面是否锁屏无关 |

## 5. 边界

- 只截编辑器顶层窗口（主编辑器、资产编辑器、独立面板窗口）；不截 PIE/游戏 viewport。PIE 截图需要
  ue-mcp 桥的 `editor.capture_screenshot(target=pie)` 或 `HighResShot`，那是另一条通道，另行接入。
- 只读：不点按钮、不改资产/关卡/CVar、不启停 PIE。`Windows(action=select)` 只会前置窗口。
- 不做像素 diff、不做视觉判定；截图是采证，是否「看起来对」仍由人判断（docs/022/025）。
- 编辑器最小化时 Slate 的可见窗口列表为空；先把编辑器窗口恢复再截，本工具不会替你恢复窗口。
- 图片落宿主本机 `stateDir`，不自动进仓库、不自动发飞书；要进 PR/Swarm/飞书由 worker 在交付时复制/附加。

## 6. 失败处置

| 现象 | 处置 |
| --- | --- |
| 连不上端点 | 编辑器没开，或 `ModelContextProtocol` 服务没起；先开编辑器/确认端口，不要反复重试 |
| `tools/list` 没有 `call_tool` | 引擎 MCP 不是 tool-search 模式；按项目 skill 的说明启用后再试 |
| 窗口列表为空 | 编辑器最小化或还在加载；恢复窗口、等 AssetRegistry 加载完再截 |
| 标题没有唯一匹配 | 报错会列出当前窗口标题；换一个更具体的 `window=` |
| 返回内容不是 PNG | 不落盘并报错；这通常意味着截图失败（窗口已关闭/最小化），不是可接受的证据 |

## 7. 验证

```powershell
pnpm typecheck
pnpm test tests/editor-capture.spec.ts
pnpm build
```

单测用 fake 引擎 MCP 覆盖：initialize 的 session header、窗口列表/选择、图片解码、PNG 校验、同名文件、
不可达端点、缺少 `call_tool`、缺失/歧义窗口。真实编辑器的一次采集（开编辑器 → 持有租约 → `op=capture` →
`read_image` 核对）记录在 PR 的验证包里；锁屏本身无法在共享机器上复现，验证以「截图来自编辑器渲染路径」
这一机制为依据，并如实写明未在锁屏下实测。

## 8. 文件

| 文件 | 作用 |
| --- | --- |
| `src/app/editor-capture.ts` | 引擎 MCP 客户端、窗口选择、PNG 校验与落盘、sidecar |
| `src/app/tools/executor.ts` | `orchestrator_editor` 新增 `op=capture` 与 `window`，要求持有租约 |
| `src/app/runtime.ts` | 把证据目录（`<stateDir>/evidence/<ticketId>`）接进 capture |
| `prompts/work.md` | worker 的验证流程：编辑器证据用 capture，不用桌面截图 |
| `tests/editor-capture.spec.ts` | fake 引擎 MCP 的端到端单测 |
