# 020 Ticket kinds

Every ticket has a **kind**: what sort of work it is, so a day's work can be counted and filtered by it. The daily
retrospective of 2026-11-04 found the `category` of all 27 tickets that day empty: only a chat escalation ever set it, so
nobody could say how much of the day was bugs, features or the agent's own work.

| Kind | Meaning |
| --- | --- |
| `feature` | Something new is wanted. |
| `bug` | Existing behavior is wrong. |
| `self` | The agent's own iteration: work in this deployment's own git repository. |
| `inquiry` | An answer, analysis, assessment or review rather than a change. |

A kind is a label for reading the work. It grants nothing, changes no gate, and it is separate from **priority**
(docs/019), which decides when the work runs.

## How a ticket gets its kind

`Tickets.create` classifies every new ticket once the executor has chosen its delivery environment
(`core/kind.ts`, `classifyTicket`). The first rule that matches wins:

1. **router**: the accept named `ticket_kind` (`orchestrator_route`).
2. **source**: a TAPD ticket is a `bug`; a chat escalation keeps its `category` (`bug` or `feature`); work delivered to
   this deployment's git repository is `self`.
3. **rule**: the title has a bug word (修复, 报错, 崩溃, 不生效, fix, bug, crash…), else an inquiry word (分析, 评估, 审查,
   排查, 调研, 确认, 为什么, review, investigate…). Bug words are checked first, so "排查并修复…" stays a bug.
4. Otherwise it is a `feature`, so no ticket is left without a kind.

The ticket stores `kind` and `kindSource` (`router`, `source` or `rule`). The split parts of one accept are classified
one by one; the router's `ticket_kind` applies only to the primary ticket.

A ticket stored before kinds existed has no `kind`. `ticketKind(ticket)` derives one from the same rules and what the
ticket recorded (its category, Source, backend and title), so old tickets count and filter like new ones without a
migration.

## Where it shows

- The ticket list API (`GET tickets`) returns `kind` and `kindSource` on each row, accepts `kind=<kind>` to narrow the
  list, and returns `kinds`: how many tickets of that stage are of each kind, counted before the kind filter.
- The execution page has a row of kind pills with those counts, beside the stage filters. Ticket rows and the board's
  decision cards carry a kind tag, and its tooltip says who decided it.
- Ticket cards for the main Session carry `kind`.

## Limits

The title rule is a heuristic: a title that names neither a defect nor a question reads as a `feature`. When the router
knows better, it should name `ticket_kind`. `category` keeps its narrower meaning (an escalation's bug or feature) for
existing readers.
