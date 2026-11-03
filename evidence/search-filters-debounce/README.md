# Header search: type filters, results as typing settles, and a kind · Source label

Captured from the live Superagent panel on 2026-11-03, `?view=board` → Superagent,
headless Chromium (`--headless=new`), viewport **1344 × 914 CSS px at DPR 2**, light
theme. The query is `编辑器` in both captures, and the host reported the same counts
both times: 4 Tickets, 0 Threads, 14 Triggers.

- `before-search.png` — the deployed `dsh-superagent` client bundle (installed
  2026-11-03 05:38), after pressing Enter. That build searches only on submit, so
  typing alone showed nothing.
- `after-search.png` — this branch's client bundle (`pnpm build`) in the same live
  page. The results appeared about one second after typing, with no Enter; the type
  filters default to **全部**, and every row names its kind and Source together.
- `after-search-tickets.png` — the same After state with **工单** selected: only the
  four Ticket rows remain, all labelled `工单 · 飞书`.

All result titles, actors, times and thread names are redacted (every non-space
character replaced with `●`). The query, the counts, the type pills and each row's
kind · Source stay readable; no Ticket, message or person from the live host is
identifiable.

## How the After capture ran

The live host still runs the previous **server** build, whose search response carries
no `source` on Ticket hits. For the After captures the branch's built client module
was substituted for the served one (CDP `Fetch` interception), and each Ticket's
`source` was added to that search response from the Ticket's own detail response
(`mandate.actor.source`) — exactly the field the server change in this branch adds.
Everything else, including the search results themselves, comes from the live host.
The deployment was not restarted and its files were not modified.

## Behaviour observed in the same page

| | Before | After |
| --- | --- | --- |
| results after typing, no Enter | no | yes |
| type filter row | absent | `全部*` `工单` `线程` `触发` |
| Ticket row label | `工单` | `工单 · 飞书` |
| Trigger row label | `飞书` | `触发 · 飞书` (or `触发 · TAPD`) |

The server-side change (`ticketSummary.source`) is covered by
`tests/views.spec.ts`; the debounce, filters, labels and empty-filter state by
`tests/panel-panel.spec.tsx`.
