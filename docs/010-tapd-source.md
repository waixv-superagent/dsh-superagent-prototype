# 010 — The TAPD Source

This document covers the `tapd` Source kind: a read-only intake that polls the bugs assigned to one person in a TAPD workspace and turns each open bug into a Trigger, so a bug can become a Ticket without anyone restating it. `tapd` never writes to TAPD — no status change, no comment, no field edit — and needs nothing but an API credential in the environment.

The kind follows the model of [001 Domain](001-domain.md): it is a Source instance of kind `tapd`, each bug is a Thread, and every revision of a bug is one Trigger on that Thread.

## 1. Configuration

The kind is installed by the bundle's `dsh-superagent/tapd-watch` entry, which the bundle leaves disabled: a deployment that does not work in TAPD pays nothing for it.

| Setting | Meaning |
| --- | --- |
| `workspaceId` | The TAPD workspace the bugs live in; empty until you set it |
| `owner` | Whose bugs are read, matched exactly on TAPD's **current owner**. Write the TAPD nickname, not the login name |
| `pollSeconds` | How often every open bug is read again; 300 by default, at least 60 |
| `failuresBeforeError` | How many consecutive failed reads before the Source reports an error instead of retrying quietly |
| `limit` | How many open bugs one round reads at most, and the page size of one read |
| `openStatuses` | The statuses a read asks for, OR-ed with a pipe, `new\|in_progress` by default. TAPD honours only the pipe form: a repeated `status` keeps the last value and a comma list matches nothing. TAPD orders pages by recent modification, so without this filter a person who closes many bugs fills the pages with closed ones and the open bugs are never reached within `limit`. `resolved`（修复完成）is deliberately left out: a bug someone already fixed must not be re-implemented, and admitting it makes the worker chase a workflow status it may not change. A workflow with other pending statuses must list them here, or their bugs are never read |
| `apiBase` | The API host, `https://api.tapd.cn` by default |

Credentials never enter the settings:

| Variable | Meaning |
| --- | --- |
| `DSH_SUPERAGENT_TAPD_ACCESS_TOKEN`, or `TAPD_ACCESS_TOKEN` | Sent as `Authorization: Bearer …`. Preferred; TAPD refuses an `access_token` in the URL |
| `DSH_SUPERAGENT_TAPD_API_USER`, `DSH_SUPERAGENT_TAPD_API_PASSWORD` | The fallback pair, sent as HTTP Basic |

A missing credential is a health error naming the variable, not a silent empty result.

## 2. What a bug becomes

One bug, one Thread (`tapd:<bugId>`). A Trigger carries:

- `id`: `tapd:<bugId>:<modified>`, so an edited, reopened or commented bug is a new Trigger on the same Thread, and a bug nobody touched is a duplicate the Engine drops;
- `actor`: the bug's current owner; `human: true` and `addressed: 'direct'`, because a bug assigned to a person is that person's direct request;
- `text`: the title and the description as plain text, with markup and images dropped and a long description cut;
- `meta`: `bugId`, `workspaceId`, `status`, `priority`, `severity`, `owner`, `created`, `modified`;
- `url`: the bug's page in TAPD.

The Source has **no Channel**: TAPD is read-only, so a Ticket's replies and notices go out through another Source of the deployment, such as Feishu.

## 3. Gate and Policy

The kind ships a Policy part with one field, `allowed`: the owners whose bugs may originate work. A bug of someone else is still written to the Trigger log as filtered (`not_a_member`), never as a Ticket.

Put the configured `owner` on that list. Without it a deployment reads the bugs and accepts none of them, which is the correct default: reading is not authorization.

## 4. Execution variables

A Ticket that came from TAPD gives its Executor:

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_TAPD_BUG_ID` | The bug's long ID |
| `DSH_SUPERAGENT_TAPD_SHORT_ID` | The bug's short ID, the number a P4 description starts with |
| `DSH_SUPERAGENT_TAPD_BUG_URL` | The bug's page |
| `DSH_SUPERAGENT_TAPD_WORKSPACE` | The workspace the bug lives in |

They are empty for a Ticket that came from another Source.

## 5. Reading is not verification

TAPD answers a read of the workspace with the whole workspace when the `owner` filter is used: TAPD ignores that parameter silently, and a whole-workspace read is indistinguishable from a correct one in the response. The Source therefore filters on `current_owner`, and `scripts/tapd-bugs.mjs` — the same read from a shell, for a person — does too.

`resolved`（修复完成）是一个被刻意排除在读取之外的状态，而不是「未关闭」的一种。已经由别人修好的缺陷不该再被实现一遍：放进来会让 worker 去追一个它无权改写的工作流状态，也会把编译和测试预算烧在重复劳动上。默认只读 `new|in_progress`；真正需要验证的语义由人决定，不由这个 Source 猜。

对仍会被读到的状态，终端集合是 `closed`、`rejected`、`verified`：读到之后转为终态就不再重复产出 Trigger。

## 6. What exists today

| Part | Status |
| --- | --- |
| The kind, its settings, its Policy part and its execution variables | Implemented and tested (`tests/tapd.spec.ts`) |
| The poll of open bugs, with paging, deduplication and health | Implemented and tested against fixtures |
| A read against a real workspace, with `TAPD_ACCESS_TOKEN` | Verified against a live TAPD workspace |
| The Source inside a running deployment | Verified in an isolated profile: health `ready`, "27 new triggers", `27` decisions with reason `not_a_member` |
| A Ticket accepted from a TAPD bug | Verified: with the owner on `allowed`, a requeued Trigger became an explicit decision and a Ticket with a worker session |
| A Ticket executed end to end against a p4 workspace | Not yet run; see 009 for the p4 delivery this Ticket feeds |
| Comments and status changes as their own Triggers | Only as the bug's `modified` time changes, which covers them without extra reads |
| Writing back to TAPD | Never, by design |

## 7. Acceptance

1. Enable the entry and save a workspace and an owner; the Source's health turns `ready`, and the log shows the open bugs read.
2. Put the owner on the Policy's `allowed` list; the next read accepts a Ticket for each new bug.
3. Edit a bug's title or status in TAPD; within one poll interval a new Trigger arrives on the same Thread with a new revision, and the Ticket receives it as context.
4. Remove the credential and restart; the health reports the missing variable by name, and no read is attempted.

## 8. Running it in a deployment

Three things have to be true before the Source reads anything. Each of them fails visibly instead of silently.

| Thing | Where | What happens without it |
| --- | --- | --- |
| `TAPD_ACCESS_TOKEN` in the process environment | The launcher, never a settings field | Health is `error` naming the variable; no read is attempted |
| The `dsh-superagent-tapd` entry enabled | The profile's patch layer | The kind is listed in Sources, but nothing polls, because the polling entry is a separate plugin |
| The owner on the Policy's `allowed` list | Settings → Policy → TAPD | Bugs are read and written to the Trigger log as `not_a_member`; no Ticket is made |

The entry is a patch layer, so enabling it takes a restart of the process, not a settings save. Saving the workspace, the owner or the poll interval does not restart anything: the loop reads its config again every round.

`eval.mode` decides whether an accepted Trigger becomes a Ticket: `observe` records the decision only, `auto` lets the Eval start a worker. Point a fresh deployment at a workspace with 27 open bugs in `auto` and it starts 27 Tickets, limited only by `executor.maxWorkers`; `observe` is the setting that reads without starting work.


