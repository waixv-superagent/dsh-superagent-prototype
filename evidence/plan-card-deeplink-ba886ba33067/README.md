# 方案卡跳转：按当前使用端打开工单页

## 现象

飞书里的方案卡只带摘要；方案附带的完整代码 diff 只在工单页。卡片到工单页的链接由飞书 Source 的「面板地址」生成，
即使配置了也只会打开浏览器：正在用桌面 App 的人被送到一个浏览器标签，还要自己切回 App 找到同一张单。
本工单的部署里「面板地址」还是空，所以方案卡上连这条链接都没有。

## 改动

- 方案卡整卡可点（`card_link`），footer 的 `工单 xxxxxxxx ↗` 和「在面板看完整 diff」都走
  `/orchestrator/ticket/<id>`（`ticketOpenLink`，带 `lk_jump_to_browser`，让飞书交给系统浏览器，面板登录与
  `dsh://` 才能在真实浏览器里工作）。
- 链接前缀优先用飞书 Source 的「面板地址」；没配时用面板最近一次在浏览器里被打开时上报的 origin，所以不用猜
  公网/LAN 地址——部署里浏览器用的那条就是链路。两者都没有才不加链接。
- 面板页面在聚焦/可见变化时向宿主报告自己所在端（`POST /orchestrator/api/surface`）和地址，宿主记最近一次**被聚焦**
  的端；切到飞书时页面失焦，不会把端抢回去。
- `/orchestrator/ticket/<id>`：浏览器端 302 到 `/?ticket=<id>`；App 端把工单入队、拉起 `dsh://open` 把 App 切到
  前台，App 面板轮询 `GET /orchestrator/api/app-open?surface=app` 取到工单后，用已挂载面板的 navigate 打开工单页；
  交接页只在浏览器拒绝切窗时留一个手动按钮。
- 没有报告（刚重启、新装）时按浏览器处理，网页永远能开；活跃端 10 分钟、待打开工单 5 分钟后过期。

## 验证

- `pnpm typecheck`、`pnpm test`、`pnpm build` 的结果见 PR。
- 本机实测 `dsh://open`（`HKCU\Software\Classes\dsh` 已指向 `DeepSeek Harness.exe "%1"`）：执行前后前台窗口
  从「飞书」变为 DeepSeek Harness 的窗口，App 进程数不变（5 → 5，没有第二个 App 实例）。
- 交接页：用真实 `registerHttp` handler 起一个临时 HTTP 服务，headless Chrome 截图 `handoff-app.png`；
  同一服务在浏览器端返回 `302 /?ticket=…`（`web-redirect.txt`）。
- 卡片：分支代码生成两张合成方案卡（假工单 `ffffffff`）：`card-before.json`（无链接）与 `card-after.json`
  （footer 链接 + 整卡 `card_link`），两张都发到了本工单的飞书话题（`om_x100b60ee153624a8b4958f95faddd2d` /
  `om_x100b60ee12b37cb4cfc92ce75633804`）。工单主人明确说不用贴截图，所以这里只保留卡片 JSON，不附飞书渲染截图。

## 复现

- 卡片 JSON 由本分支的 `src/sources/feishu-card.ts` `planCard` 生成；`card-before.json` 不传 ticketLink，
  `card-after.json` 传 `ticketOpenLink('https://10.104.0.40:9443', 'ffffffff…')`。
- 交接页：`handoff.html` 是本分支 handler 的真实响应；用 `chrome --headless=new --screenshot=handoff-app.png
  --window-size=760,620 <url>` 渲染（临时服务只挂 `registerHttp` 的真实 prefix handler）。
- 桌面 App 的端到端一跳需要把新客户端部署到宿主后点一次卡片链接；本工单不重启宿主（会中断正在跑的会话）。

## 限制

- 没有配置「面板地址」、面板也还没在新客户端里上报过地址时，卡片没有链接；一旦在浏览器里打开过一次面板就会带上
  当时实际使用的地址（本机探测：`10.104.0.40:9443` 可用，公网 IP 的 9443 连不上）。
- 浏览器拒绝外部协议时，交接页提供「切到 App」和「在网页打开」两个按钮。
- App 端到端依赖 App 已注册 `dsh` 协议（本机已验证）；未刷新到新客户端的面板不会上报端，按浏览器处理。
