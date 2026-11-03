# Header search: find a Ticket by its worker Session id

Captured from the live Superagent panel on 2026-11-03, viewport **1344 × 914 CSS px at DPR 1** (both images are the
same `505,0 – 1344,220` crop), dark theme, query `d45f8eb325f342afd3c1a968c`: the tail of the worker Session id
`worker-f4bf326d45f8eb325f342afd3c1a968c` that a truncated session label shows.

- `before.png` — the deployed `dsh-superagent` built from `main` (`e2e4de2`, installed 2026-11-03 11:40). Typing the
  Session id reports 没有找到 and lists what search accepts; a Session id is not among them, and
  `GET /orchestrator/api/search?q=…` returns `{"tickets":[],"items":[],"threads":[]}`.
- `after.png` — the same page, query and data, with the panel's `/orchestrator/api/search` response produced by this
  branch's `search()` (`src/app/views/threads.ts`) over a SQLite backup snapshot of the live `orchestrator.sqlite`.
  It reports 找到 1 个工单 and lists that Ticket, labelled `工单 · 飞书` and `已结束`.

Both captures come from one page instance; only that one search response differs between them. The branch changes no
client code, so the live client is the code under test. The live deployment was not restarted or modified. The found
Ticket's title is private Feishu work content, so its line is redacted; the row's kind, Source and stage stay readable.

## Behaviour

| | Before | After |
| --- | --- | --- |
| a worker Session id in the header search | 没有找到 | the Ticket row |
| the id alone, or the tail a session label shows | no match | the Ticket row |
| a word such as `worker`, or a Ticket whose work never started | no match | no match |

## Checks

`pnpm check` (typecheck, the full test suite, build) passes. `tests/views.spec.ts` covers the whole
`worker-<ticketId>`, the id alone, the truncated tail, and the non-matches above.
