# 方案卡 / grill 卡 / pipeline 里程碑卡 @ 提醒 — 前后证据

## 版本

- **改前**：线上构建 `a839871`（2026-11-18 21:28 本地部署）。方案卡没有提及；#139 的 grill 卡同样没有 at；
  pipeline 里程碑卡也没有 at。
- **改后**：分支 `agent/card-at-mention-899fac25b3f0`，基线 `origin/main 0dd8ff1`（含 #138/#139/#140）。

## 证据

| 文件 | 说明 |
| --- | --- |
| `before-plan-card.json` | 改前方案卡：正文第一段是问题，没有 `<at>`。 |
| `after-plan-card.json` | 改后方案卡：正文第一段是 `<at id=ou_70cf…></at> 请确认这张方案`。 |
| `before-plan-text.json` | 改前文本兜底：post 内容只有 `md`。 |
| `after-plan-text.json` | 改后文本兜底：post 内容首段是 `{tag:'at', user_id:'ou_70cf…'}`，后面才是 `md`。 |
| `before-grill-card.json` | 改前 grill 卡（#139）：没有 `<at>`。 |
| `after-grill-card.json` | 改后 grill 卡：顶部 `<at id=ou_70cf…></at> 请回答这几个问题`。 |
| `after-pipeline-card.json` | 改后 pipeline 里程碑卡：顶部 `<at id=ou_70cf…></at>`。 |

`ou_70cfed1e3a0e4543b97503e4b3cf8363` 是这张单的飞书提出人；卡片里的 at 由 `mentionLine` 作为卡片结构插入，
不经过 `textSafe` 的 `<>` 全角化；文本兜底由 `feishuPostContent` 生成 post 的 `at` 元素。飞书文档：
[富文本（Markdown）组件](https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text?lang=zh-CN)
（`<at id=open_id></at>`）与[发送消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)
（post 的 `<at user_id="ou_…">`）。

## 重新生成

```powershell
node --experimental-transform-types evidence/card-at-mention-899fac25b3f0/generate-evidence.mjs
```

脚本用同一个 sample 工单分别调用不带 mention 和带 mention 的卡片构建器，输出上表的 JSON。`case.json` 记录同一条命令。

## 验证与限制

- 单元测试覆盖：卡片首段 at、文本兜底的 post at、预算/间隔、非飞书单回落到 Policy 名单第一人。
- **没有截图**：本会话无法截取飞书客户端；卡片 payload 是应用实际输出，文本兜底是实际 post 结构。卡片的 at 是否
  到达真人，要在部署后用下一张真实方案/grill 卡确认。这个限制在 PR 里同样写明。
