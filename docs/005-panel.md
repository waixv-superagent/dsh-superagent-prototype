# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Agent status**, **Source**, **Trigger**, **Eval**, **Execution**, and **Settings**. Overview is the editor board; Agent status is the duty desk. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

A `?view=board` query on the panel URL opens the duty-desk board directly, before the page this tab remembered; `?page=overview` is the legacy alias for the same board. The Feishu status card uses it as its tap target. `?ticket=<id>` opens that Ticket's page the same way; when the Feishu Source names a **Panel address**, every message the bot sends for a Ticket (replies, plan, priority and question cards) ends with a `工单 xxxxxxxx ↗` link to it. The link is added after the IM word limit is checked, so it never takes words from the message.

| Tab | Shows |
| --- | --- |
| Overview | The machine's editor board: who holds the Unreal Editor now (you, an agent, a local build that occupies the slot while it compiles, free, or unknown, treated as you), the last-hour timeline including the build window, every running or queued Ticket with its live tool, digest, elapsed time and latest progress, and what waits on a person. A running build also names the pending-verification Tickets delivered before it started, inferred from the build's start time against each delivery time. Read-only: it never starts, stops or hands over the editor |
| Agent status | The duty desk as a five-lane board: **Needs your decision · To verify · 流水线 · Running · Recently ended**. The pipeline lane shows blocked follow-ups first, then the oldest running check; a Ticket whose change was delivered as a pull request also waits there for its approval and merge. The header sums what waits on a person, each lane links to its filtered list, and ended cards name who verified the work (you, the pipeline, or nobody). Compact system problems and the day's counts sit above the board |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Agent status |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules, filtered by 接单与续做 / 闲聊 / 停止 / 忽略 / 未完成 / 全部. 一条带 escalation 的闲聊决策额外显示「升级为工单」和它的类别（缺陷 / 需求），并链到它建的工单 |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, To verify, Unverified, Working, Waiting for a Trigger or Ended. Ticket details show a local-verification gate for delivered work and a pipeline gate for a change followed into the mainline or delivered as a pull request awaiting approval — a merged pipeline is history, so a Ticket a person's later message resumed shows no pipeline gate again — plus actions, authorization, waiting Inputs, Subscriptions and Assignments. A running Ticket leads with a compact **Now** block: the current tool, its latest progress report and who acts next — never a reasoning stream or token speed. The p4 settings also hold the Jenkins URL, account and API token used by the read-only pipeline check; the token is redacted from tool results and never written to prompts, logs or commits |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the execution history built from its Assignments, Inputs and reports, the originating Trigger, Decision and reason, scope and Policy version, and the delivery its worker reported: the shelved changelist, the review and the verification. **Confirm delivery** records a person's decision that the change may be submitted and then shows the `p4 submit -c <changelist>` command for that person to run. The panel offers the gate and never submits, so a change reaches the mainline only by a person's hand. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command. The task center's workspace pool (`executor.workspaces`) is accepted by `PUT settings/executor` but not yet shown here.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. It searches once typing pauses (or on Enter), and its type filters narrow the results to Tickets, Threads or Triggers, with **All** (全部) as the default. Each row names its kind and Source together, such as 工单 · 飞书, so a Ticket and a Feishu message no longer read as the same thing. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

The ticket finder on Agent status searches titles, ticket ids, changelists, reviews, Thread ids, actors and summaries. It waits for two characters, queries numbers (ticket ids and CLs) immediately, and shows why each hit matched. Archived Tickets stay searchable and are marked **Archived**; the card shows the first eight characters of a ticket id.

Both searches also find the way back from Feishu. Paste the id of a bot message (`om_…`, recorded for each message the bot sends for a Ticket) or of a person's message, a topic link (`omt_…`), a direct-chat message link (`…/chat/open?openChatId=oc_…&position=…`) or a chat id (`oc_…`): the Tickets it leads to come first, most specific first — the message, then its topic, then the whole chat. A chat id, or a link to a message the host never saw, lists every Ticket of that chat, which in a direct chat is every Ticket started there.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title, a matching Thread, or their worker Session id (`worker-<ticketId>`, the id alone, or the tail a truncated session label shows). A Ticket without a started Assignment has no Session and stays reachable by its title or Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. The two overviews summarize these pages and link to them instead of becoming another detailed view: Overview is the editor board, Agent status the duty desk.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly; a reply whose CLI refused its arguments offers **Retry** and **Withdraw** instead of a growing retry count. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
