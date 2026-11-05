# 工单问题块：改前 / 改后（合成数据）

同一张**合成**工单（`aaaaaaaa…`，标题「把设置页的主按钮文案改成「保存更改」」，假飞书会话 `oc_demo`）、同一处面板工单页、
同视口 1440×900、DPR 2、浅色、中文。工单、消息、会话、报告、线程全部是合成的；两个 lab 实例都关闭 Sources、暂停处理，
不读写任何外部会话。

- `before-ticket.png`：部署构建（`D:\Projects\Agent-PlayGround\dsh-superagent` 的 `lib`），隔离 DSH 实例 `127.0.0.1:3098`，
  用面板的工单搜索打开该工单。
- `after-ticket.png`：本分支构建（`origin/main` `e6cdff2` + 本单改动，`pnpm build`），同一隔离实例与同一份 state，
  同样方式打开。
- `before-facts.json` / `after-facts.json` 记录问题块的文本、`去飞书回答` 的 href，以及是否出现就地回答控件。

| | before | after |
| --- | --- | --- |
| 就地回答 | 无，只有 `去飞书回答` | 多行输入 + `提交答复`（问题有选项时还会有选项按钮） |
| 问题块高度 | 72px | 174px |
| `去飞书回答` | `feishu://applink/client/chat/open?openChatId=oc_demo`（只有会话） | `feishu://applink/client/thread/open?open_chat_id=oc_demo&open_thread_id=omt_demo`（工单话题） |
| `answer` 控件 | `false` | `true` |

这张工单的提问发生在改动之前，部署构建没有记录它的消息链接，所以改前只能打开整个会话；改后在没有记录时退到工单话题。
本单的发送端改动会把纯文本提问也记成 `message_id → { ticketId, attentionId, url }`，新提问的「去飞书回答」直接落到那条消息，
这部分由 `tests/feishu-channel.spec.ts`（发送端写入）和 `tests/views.spec.ts`（面板链接选择）覆盖。
