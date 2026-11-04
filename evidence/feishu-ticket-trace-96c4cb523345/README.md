# Ticket finder: a pasted Feishu message link leads back to its tickets

Captured from the live Superagent panel on 2026-11-05, headless Chrome, viewport **1344 × 914 CSS px at DPR 1**, dark
theme, 概览 → 看板, ticket finder. Both images are the same crop around the finder. The query is the Feishu link of
the direct-chat sub-thread this request came from (`…/client/thread/open?open_chat_id=oc_…&open_thread_id=omt_…&thread_position=31`).

- `before-finder.png` — the deployed `dsh-superagent` (`main` at `782a81d`): **0 张工单**; the finder has no way from a
  Feishu link to a ticket.
- `after-finder.png` — the same page instance, data and query, with this branch's built client bundle substituted for the
  served one and the `/orchestrator/api/tickets/search` response produced by this branch's `ticketSearch()` over a
  read-only snapshot of the live `orchestrator.sqlite`: **7 张工单**, every ticket started in that DM topic, each
  labelled `飞书 · omt_…` (the topic it matched), this ticket (`#96c4cb52`) among them.

Ticket titles are private Feishu work, so every non-space character of each title is replaced with `●`; ids, stages and
the match stay readable. The live deployment was not restarted or modified.

The other half of the change — the `工单 xxxxxxxx ↗` link at the end of each bot message, which opens `?ticket=<id>` —
only appears once **Panel address** is set in the Feishu Source; it is covered by `tests/feishu-trace.spec.ts` and
`tests/navigation.spec.ts` rather than a capture, since sending a real message from the live bot would post into a
person's chat.
