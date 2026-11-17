# 「已开话题」链接：打不开新话题的原因与修复

## Before

部署中的代码把飞书自带话题链接里的 `thread_position` 去掉了，写进消息的链接是：

`https://applink.feishu.cn/client/thread/open?open_chat_id=oc_…&open_thread_id=omt_…&openchatid=oc_…&openthreadid=omt_…`

飞书客户端解析 `thread/open` 时用话题根消息的位置（根消息的 `thread_position` 是 `-1`）；链接没带位置时按 `0`
解析。刚建好的话题只有根消息、没有位置 0，解析失败会被客户端静默吞掉——点了完全没有反应；等话题有了第一条回复
（位置 0，通常是方案卡）之后，同一条链接才点得动。「已开话题」恰好是在话题刚建好时发出来的。

真实客户端对照（本机 Feishu，同一话题 `omt_…`，只有根消息，工单 c825e122；话题内消息数用
`lark-cli im +threads-messages-list --thread omt_…` 读得 `count=1`）：

| 链接 | 结果 |
| --- | --- |
| 不带 `thread_position` | 窗口停在原聊天，没有跳转（复现用户点击无反应） |
| 带 `thread_position=-1` | 落到目标话题（只有根消息的那条） |

截图含飞书私有内容，按仓库惯例不入库；上表是用本机真实客户端截图核对的。

## After

`feishuTopicLink` 现在输出与飞书自己 `message_app_link` 逐字一致的话题链接（两种拼写 + 根消息位置）：

`https://applink.feishu.cn/client/thread/open?open_chat_id=oc_…&open_thread_id=omt_…&openchatid=oc_…&openthreadid=omt_…&thread_position=-1`

同一话题上，本分支 `feishuTopicLink({ chatId, threadId })` 的输出与 `im +messages-mget` 读到的、飞书自己给出的
话题根 `message_app_link` 完全相同。

- 消息里的「已开话题」（`feishu-topic-link.ts` 的 `topicLinkLine`）指向这条。
- 面板「打开飞书原文」、话题 chip 用同一条（转成 `feishu://applink/…`）；只有会话链接仍去掉 `position`、打开到最新处。
- 只解析到 thread id、不知道 chat id 的话题链接保留原位置，不再剥夺唯一入口。

## Reproduce

- `pnpm exec vitest run tests/feishu-links.spec.ts tests/feishu-topic.spec.ts tests/views.spec.ts`
- 手工核对：`lark-cli im +messages-mget --message-ids <话题根消息>` 读 `message_app_link`，与本分支
  `feishuTopicLink({ chatId, threadId })` 的输出逐字比较。
