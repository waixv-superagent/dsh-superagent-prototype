# The acceptance receipt and its ticket topic, as one message

## Before

Accepting one Feishu request produced two bot messages in the request's thread (observed 2026-11-17 04:06 UTC, read back
with `lark-cli im +threads-messages-list`):

1. The acceptance receipt: the assessor's 2–3 lines, then `工单 <short id>`.
2. A second message with the raw AppLink:

   `已开话题：https://applink.feishu.cn/client/thread/open?open_chat_id=oc_…&open_thread_id=omt_…&openchatid=oc_…&openthreadid=omt_…&thread_position=-1`

## After

One message: the receipt, its `工单` line, and the topic as a described link.

`after-receipt.json` is the exact CLI `--content` post JSON the changed `sendFeishu` produces for such a receipt; it was
captured by running the sender, not written by hand. `after-notice.json` is the fallback notice, posted only when a
receipt gave up waiting for the topic or no receipt was queued.

The `md` post element is the one `lark-cli` itself builds for Markdown links: a dry run of
`lark-cli im +messages-reply --message-id <any> --markdown '见 [例子](https://example.com/a) 结束' --dry-run` returns
`{"zh_cn":{"content":[[{"tag":"md","text":"见 [例子](https://example.com/a) 结束"}]]}}`, so the link shows its label and
not the URL.

## Reproduce

- `pnpm exec vitest run tests/feishu-topic.spec.ts tests/feishu-channel.spec.ts` — the topic link taken by a receipt, a
  receipt that gave up waiting, the described label, and the sender that folds the link in.
- `pnpm exec vitest run tests/runtime.spec.ts -t "hands the accept receipt"` — the engine hands the pending receipt to the
  Source that opens the conversation.

## Limit

There is no Feishu client screenshot: the request thread is a private chat and this host has no Feishu UI session. The
before and after above are the messages' own payloads, read from Feishu and produced by the sender.
