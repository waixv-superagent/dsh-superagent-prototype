# 复盘「采访人的感受」— 前后对比证据

同一个渲染脚本、同一份夹具、同一个视口，唯一差别是 `scripts/daily-retro.mjs`：

- **Before**：`origin/main` 的 `f4262b9`（`TEMPLATE_VERSION = 3`，固定 8 节）。
- **After**：本分支（`TEMPLATE_VERSION = 4`，固定 9 节，第 02 节是「采访人的感受」）。

两边都用 `fixture/` 里同一份 `metrics-2026-11-05.json`、`metrics-2026-11-04.json`、`ledger.json` 和
`narrative.md` 渲染：

```text
node <revision>/scripts/daily-retro.mjs render \
  --metrics fixture/metrics-2026-11-05.json --previous fixture/metrics-2026-11-04.json \
  --ledger fixture/ledger.json --narrative fixture/narrative.md --out <before|after>.html
```

## 文件

| 文件 | 内容 |
| --- | --- |
| `before-top.png` | 基线前 1500 px：第 01 节之后直接是「02 一天怎么过的」，副标题写「口径见第 8 节」 |
| `after-top.png` | 本分支前 1500 px：第 02 节是「采访人的感受」（原话、标为推断的解读、填写规则），副标题写「口径见第 9 节」 |
| `before-full.png` | 基线整页：8 节；narrative 里未知的 `## interview` 被当成附录里的额外段落在最后原样渲染 |
| `after-full.png` | 本分支整页：9 节；附录里可以看到 `模板 v4` |
| `before.html` / `after.html` | 两份真实渲染产物（自包含，可直接打开） |
| `fixture/` | 夹具 metrics、台账与 narrative |
| `capture.mjs` | 截图脚本：headless Chrome，1280 CSS px 宽、DPR 1、浅色，`--window-size=1280×1500` |

## 复现

```powershell
# 基线（不改工作区）
git worktree add ..\baseline origin/main
node ..\baseline\scripts\daily-retro.mjs render --metrics fixture\metrics-2026-11-05.json `
  --previous fixture\metrics-2026-11-04.json --ledger fixture\ledger.json `
  --narrative fixture\narrative.md --out before.html
node scripts\daily-retro.mjs render --metrics fixture\metrics-2026-11-05.json `
  --previous fixture\metrics-2026-11-04.json --ledger fixture\ledger.json `
  --narrative fixture\narrative.md --out after.html
node evidence\retro-interview-d3be2c93c354\capture.mjs "file:///<绝对路径>/after.html" after-top.png 1280 1500
```

整页截图在 1280 宽、9000 高的一次性视口里截取，再按最后一行非白像素裁掉下方空白；`before-top.png` / `after-top.png`
是同一份页面的前 1500 px，用来在 PR 里直接对比。

## 局限

- 夹具里的数字与引文都是**示意**，不是 2026-11-05 的真实取数或真实原话；只用来证明版式与位置。
- 截图只有报告页面本身，不含飞书客户端里的展示效果。
- 第 02 节的内容长度取决于 `narrative.md`；这里用 3 条原话 + 3 条推断 + 3 个下次问题作为示例。
