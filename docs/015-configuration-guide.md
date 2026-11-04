# 015 Configuration guide

This is the practical guide to changing a running deployment's configuration: where each setting lives, what the fields mean, and how to check that a change worked. It assumes setup has finished and `scripts/dsh-superagent status` exits 0. [006 Deployment](006-deployment.md) remains the reference for installation, accounts, machine configuration, the Management API, upgrades and troubleshooting; [002 Authorization](002-authorization.md) explains the Policy in full; [005 Panel](005-panel.md) explains the pages.

## 1. Where settings live

Open the panel and choose **Superagent** in the sidebar, then **Settings** (设置). Its groups are **Sources** (来源), **Eval** (评估), **Execution** (执行), **Prompts** (提示词) and **Deployment** (部署).

- Each group keeps one unsaved draft; **Save** (保存) applies it. Navigate away and the panel keeps the draft.
- A save that changes a field setup reads, namely the GitHub repository and agent CLI and the Feishu bot CLI, runs the account check and restarts dsh-superagent. Other fields apply without a restart.
- Setup must succeed before Sources poll or work starts. If something is missing, Overview lists it and links to the setting. After fixing something outside the application, such as a CLI login, choose **Check again** (重新检查).
- Every save is one revision. **Configuration history** (配置历史) on the same page shows what changed. Saves that change the Policy version (the rules, a Source's Policy, or the accept mode) notify open Tickets.
- The [Management API](006-deployment.md#management-api) makes the same saves for scripts; the panel is the normal way.

## 2. Decide the Sources first

A Source receives requests; a Channel answers them. A deployment needs at least one Source that can receive and answer work.

| Source | Receives | Answers through | Needed for |
| --- | --- | --- | --- |
| GitHub | Issue and pull-request comments that mention the agent, optional receive-all scopes, CI | the same comment or pull request | the base deployment: a repository and its agent account |
| Feishu | mentions in configured chats, direct messages, optionally one topic chat | the same chat or topic | chat requests and cards that need a person |
| TAPD | bugs assigned to one person, read-only | another Source, such as Feishu | [010 The TAPD Source](010-tapd-source.md) |

Turn cards on and off with the switch on each Source. A Source that is off still keeps its settings.

## 3. GitHub Source

**Settings → Sources → GitHub.**

1. **Repository** (监听的仓库): the one repository this deployment works on, written `owner/name`. A Ticket's pull request goes to this repository.
2. **Agent GitHub CLI** (智能体的 GitHub CLI): the command name or absolute path of the `gh` wrapper signed in as the agent account, for example `/home/me/.local/bin/gh-agent`. The account needs push access; the card shows the account it verified as `当前账号 @…`.
3. Save. dsh-superagent checks the repository and the account, then restarts.

The receive-all switches are off by default. Turning one on makes the Source receive messages that do not mention the agent; the Policy's admission table then decides whether each becomes an explicit request, an inferred candidate or nothing.

| Field | Default | Meaning |
| --- | --- | --- |
| **Receive new Issues in the repository** (接收仓库里的新 Issue) | off | New Issues without a mention; starts at the moment it is switched on |
| **Receive new pull requests in the repository** (接收仓库里的新 PR) | off | New pull requests without a mention |
| **Receive comments in the repository** (接收仓库里的评论) | off | Issue comments and review comments without a mention |
| **Receive the default branch's CI** (接收默认分支的 CI) | off | CI failures and recoveries on the default branch; a CI result has no sender, so only the table's *not on the list · no mention* cell applies |

Under **Advanced** (高级):

| Field | Default | Meaning |
| --- | --- | --- |
| **Polling interval / seconds** (轮询间隔 / 秒) | 60 | How often the account's notifications and the repository are read; GitHub can ask for a longer interval |
| **Failed polls before reporting an error** (连续失败几次后报告异常) | 3 | A single network interruption is retried quietly |

**Check:** the Source page shows `ready`, and the card shows the verified account. A new Issue comment that mentions the agent account reaches the next poll. Adding a mention by editing an existing Issue body does not deliver; post a comment instead.

## 4. Feishu Source

The Feishu Source needs a bot app whose version is published, and a `lark-cli` configuration restricted to the bot identity. [006 Deployment](006-deployment.md#feishu-bot-optional) creates and verifies both; this section only configures the running Source.

1. **Bot lark-cli** (机器人的 lark-cli): the wrapper that runs the bot-only configuration, for example `/home/me/.local/bin/lark-bot`. Saving reads the app and the bot, then restarts. The host refuses a configuration that can also act as a user.
2. **Chats** (接收的群): one row per group the bot should serve. Pick the group with the chooser or paste its `oc_…` id, and set **Receive** (接收):
   - **@ only** (仅 @) receives messages that mention the bot and Threads that already have Tickets.
   - **All** (全部消息) also receives the group's other messages, from which Eval may infer work under the admission rules; the bot needs permission to read all messages in that group.
3. **Other chats** (其他群): groups the bot has joined but that are not listed above. **@ only** receives mentions there; **Not received** ignores them.
4. **Direct messages** (接收私聊): whether people may message the bot directly.
5. **Intervention card chat** (介入卡片私聊): an optional private chat. Normally a plan card goes to the Ticket's own Feishu conversation, which is its topic after one opens, else the chat the request came from; this chat is only the fallback for a Ticket that has no Feishu conversation at all.
6. **Topic chat** (话题群): see below.

### Topic chat: one topic per accepted Ticket

A topic group is one group in which every message starts a topic. Each accepted Feishu Ticket gets its own topic there whose title is the Ticket brief; this gives a chat a Ticket-shaped list without creating a group per Ticket.

1. In Feishu, create a group and switch its mode to topics, then add the bot to it.
2. In **Chats**, add that group with **Receive** set to **All**. The bot reads every message of the group to follow the topics in it.
3. Paste the group's `oc_…` id into **Topic chat**. A save is refused when the id is not listed in Chats with **All**.
4. Save. Nothing changes for existing Tickets.

When a Feishu Ticket is accepted, the bot posts a root message named `「<Ticket brief>」· 工单 <short id>` with a link to the original request. The Ticket's later replies and cards go to that topic, and the bot posts the topic link back in the original thread. Empty **Topic chat** keeps replies in the chat where the request arrived.

### Advanced Feishu fields

| Field | Default | Meaning |
| --- | --- | --- |
| **Active topic lifetime / hours** (话题活跃时长 / 小时) | 24 | After a mention of the bot or a direct message, later messages in the same topic count as requests without another mention for this long; 0 turns it off. This is how follow-ups in a topic work |
| **Receipt reaction** (收到消息时的表情) | 在做了 | The reaction added to a message the bot takes; it is removed once the reply goes out or nothing will answer that message |
| **Messages per page** (每页消息数) | 20 | How many messages one read of a thread or chat history returns |
| **Original message link time limit / ms** (原消息链接的查询时限 / 毫秒) | 5000 | How long a lookup of the original message's link may take before the agent reads the message itself |

**Check:** in a configured chat, mention the bot with a request. The receipt reaction appears, a Ticket appears on Overview within about a minute, and with **Topic chat** set a topic appears in the topic group. If the bot is not a member of a chat, the Source reports `The Feishu bot is not a member of the chat.`

## 5. Policy: who may ask

**Settings → Eval → On each Source** (在各来源上) holds the allowed list for each Source. Without someone on that list, and without an admission cell that admits them, a request from that Source does not become a Ticket.

- **GitHub**: add each account that may originate work, and optionally list bot accounts such as `dependabot[bot]` whose comments may become inferred candidates.
- **Feishu**: add each person's `open_id` and name, and optionally choose **Sync chat** (同步来源群): at startup and on **Sync now**, the list becomes the members of that chat. List bots whose messages may become candidates separately.
- **TAPD**: add the TAPD nickname of each owner whose bugs may originate work; see [010](010-tapd-source.md).

**Admission** (准入) is the table under each Source. Its rows are receiving scopes, such as one Feishu chat or a GitHub receive-all switch, and its cells decide what a message in that scope becomes — **explicit request**, **inferred candidate** or **ignore** — depending on whether its sender is on the allowed list and whether it addresses the agent. The defaults are deliberately quiet: an unlisted sender who addresses the agent is ignored, and an unlisted sender who does not address the agent is ignored. [002 Authorization](002-authorization.md#admission) defines every cell.

**Check:** from an account that is not on the list, mention the agent. The Source page shows a filtered Trigger with a `not_a_member` reason and no Ticket. From an allowed account the same message becomes a Ticket.

## 6. Execution: where work happens

**Settings → Execution** (执行).

| Field | Meaning |
| --- | --- |
| **Executor model** (执行器模型) | The model of new Executor Sessions; empty inherits the DSH default. Existing Sessions keep their choice |
| **Concurrent Tickets** (并行工单数) | How many Tickets one repository or workspace may run at once; another one keeps its own slots, and the rest queue |
| **Ticket directory root** (执行目录的根目录) | Where each Ticket gets a directory named after the Ticket; the Executor Session works there. The default is `<stateDir>/work` |
| **Prepare command** (准备命令) | Runs once with `sh` in the root before a new Ticket's directory exists, with the execution environment's variables; for example to check a repository out with `git worktree`. Empty makes an empty directory |
| **Blocked commands** (禁止调用的命令) | Command names that fail when an Executor Session calls them, such as a CLI signed in to your own account. `gh`, `git`, `lark-cli` and `p4` cannot be blocked; the p4 wrapper refuses `submit` |
| **Delivery backend** (交付后端) | `git` delivers with GitHub pull requests; `p4` makes the Ticket directory a Perforce workspace and delivers a shelved changelist for a Swarm review. Changing it affects new Tickets only. The p4 fields appear under the backend and are covered by [009 p4 and Swarm delivery](009-p4-swarm.md) |

A checkout with `git worktree` keeps the clone and the Ticket directories apart:

```sh
git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

Click a variable in the panel to insert it. **Check:** accept a Ticket and open it in Execution; it shows the directory and the prepare output. A failed prepare fails the Ticket with the command's output.

## 7. Prompts: team agreements

**Settings → Prompts** (提示词) edits the three team sections and team skills, and overrides built-in parts. What a team normally changes:

- **Communication** (沟通方式): the GitHub disclosure line, review bots, and how messages read.
- **Ticket scope** (工单范围): when a Ticket continues by itself and when it stops with an unfinished draft.
- **Delivery requirements** (交付要求): pull-request evidence, the commit author and the auto-merge condition.
- A team skill such as `identities` that tells the agents which Feishu user is which GitHub account and which user-identity `lark-cli` creates that person's documents. The bot `lark-cli` stays restricted to the bot identity: user-identity document commands go through that per-person CLI, never through a strict-mode switch of the bot configuration ([006 Deployment](006-deployment.md#keeping-the-bot-identity-working)); the worker shim refuses such a switch.

**Check:** **Full prompt** (完整提示词) shows the assembled text, and **History** (历史) lists versions. A save applies to the next model request without restarting; a Session that is mid-turn reads it on its next step. [004 Prompts](004-prompts.md) covers overrides and upgrades.

## 8. What restarts and what does not

| Change | Takes effect | Restarts dsh-superagent |
| --- | --- | --- |
| GitHub repository or agent CLI, Feishu bot CLI | after the account check | yes |
| Other Source fields: chats, topic chat, switches, advanced values | new messages and new Tickets | no |
| Policy: rules, allowed lists, admission, accept mode | a new Policy version; open Tickets are notified | no |
| Execution: directory root, prepare command, backend | new Tickets | no |
| Execution: blocked commands, concurrency | worker command shims and the queue | no |
| Prompts | the next model request | no |
| Deployment limits: saved prompt size, assessment context | immediately | no |

`stateDir` is the exception: it lives only in the profile's `cordis.patch.yml`, and changing it needs the profile edit and a restart described in [006 Deployment](006-deployment.md#machine-configuration).

## 9. First request, and what to check when nothing happens

| Source | The first request | What you should see |
| --- | --- | --- |
| GitHub | A comment from an allowed account containing `@<agent login> <request>` | A Ticket on Overview within one polling interval; the agent replies in the same thread |
| Feishu | A mention of the bot with a request in a configured chat | The receipt reaction, then a Ticket; with **Topic chat**, a topic named after its brief |
| TAPD | A bug assigned to the Source's owner, who is on the Policy's TAPD list | A Ticket on the next poll; the Source page lists read bugs |

When nothing happens, check in this order:

1. **Source** tab: the Source state and its last error; a filtered Trigger names why a message was not admitted.
2. **Settings → Eval**: the sender is on the allowed list, the admission cell admits the message, and the accept mode is not `off` if the message is only an inferred candidate.
3. **Execution** tab: processing is not paused, and the Ticket is not queued behind the concurrency limit.
4. **The account**: the card's verified facts, and the CLI's own login (`<wrapper> api user --jq .login`).

The [Troubleshooting](006-deployment.md#troubleshooting) table in 006 maps setup problems and their fixes. A Source or Executor error that a restart does not clear appears in `scripts/dsh-superagent status` under `errors`.

## 10. Where to read more

Read the numbered documents in order from [000 Philosophy](000-philosophy.md); this guide is a task-oriented companion to [006 Deployment](006-deployment.md). For one topic directly: [001 Domain](001-domain.md) for Threads, Triggers and Tickets; [002 Authorization](002-authorization.md) for the Policy and admission; [003 Execution](003-execution.md) for Assignments, worktrees and delivery; [009 p4 and Swarm delivery](009-p4-swarm.md) for the p4 backend; [010 The TAPD Source](010-tapd-source.md) for TAPD.
