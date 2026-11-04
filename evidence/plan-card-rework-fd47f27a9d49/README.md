# 方案卡 / 改一下表单 / 已换方向卡：改版前后的卡片 JSON

`cards.json` 用同一份合成内容（假工单 `ffffffff`，按钮不映射任何工单）分别跑 `origin/main`（`3fc3750`）与本分支的
`planCard` / `reviseCard` / `resolvedCard` 生成：键名 `before-*` 是基线，`after-*` 是本分支。

2026-11-05 03:32 +08:00 这六张卡已用 bot 发进来源飞书话题（飞书全部接受，`ok: true`），可以在手机上直接对照。
本机 worker 进程拿不到桌面截图（`CopyFromScreen` 报 *The handle is invalid*，飞书窗口无句柄），所以这里没有渲染截图；
真机截图需要人在手机上截那六张卡后补进来。
