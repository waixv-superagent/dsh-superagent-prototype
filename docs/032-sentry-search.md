# 032 — Sentry search

An Executor Session can read the deployment's Sentry: the `sentry` tool searches crash issues by text, stack or
event GUID, and reads one issue or one event with its stack, crash GUID and tags. It is read-only — it never
comments, changes status or resolves an issue — and the credential stays in the host process.

## 1. Configuration

The tool is registered on every Executor Session by `executorTools` (`src/app/tools/sentry.ts`); no setting turns it
on. It reads these variables from the host's process environment, and needs all three:

| Variable | Meaning |
| --- | --- |
| `SENTRY_AUTH_TOKEN` | Required. A Sentry user token, sent as `Authorization: Bearer …`. A read-only token needs `org:read`, `project:read` and `event:read`; the one this deployment used also carried `member:read`, `team:read` and `alerts:read` |
| `SENTRY_URL` | Required. The instance root, such as `https://sentry.example` |
| `SENTRY_ORG` | Required. The organization slug the instance serves |

The token belongs to the deployment, not to a Ticket: put these variables in the host's environment — the home
`.env` (`~/.dsh/.env`) or the launcher — never in this repository and never in a settings field. DSH removes
environment variables whose names contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN` from worker shells (docs/006), so
the token never reaches a Session; the tool runs in the host process and only its JSON result reaches the worker.

While one of the three is unset, every call refuses with a message naming the three variables. The token is
not verified at startup, so a wrong or expired token shows up as the instance's own `401`/`403` answer on the first
call.

## 2. Using it

`op=search` takes a Sentry issue query, a stack, or a GUID:

| Field | What it does |
| --- | --- |
| `query` | Sentry's own issue query: `is:unresolved`, `level:error`, `"free text"`, `user.username:<name>`, `BuildVersion:<value>`, `BranchName:<branch>` |
| `stack` + `stack_kind` | A function (`function`, the default) or file (`filename`) name; the tool quotes it and searches `stack.<kind>:"*<name>*"` |
| `guid` | A Sentry event id (32 hex characters, optionally the `worker-` prefix dsh-superagent puts on Session ids); it resolves through Sentry's event-id index to the issue that contains that event |
| `project` | Restricts the search to one project slug; the error of an unknown slug lists the project slugs the instance has |
| `stats_period` | The window: `24h`, `7d`, `14d`, `30d` or `90d` (default `90d`) |
| `limit` | At most 20 issues, 10 by default |

`op=issue` reads one issue by short id, numeric id or issue link, together with its latest event: the message, the
Unreal crash context (`crash_guid`, `crash_type`, `build_version`), the user, the tags and the top twelve stack
frames with the top of the stack first.

`op=event` reads one event by its event id and names its issue.

Typical calls:

| Call | Answer |
| --- | --- |
| `search` with `stack: "SomeNamespace::SomeFunction"` | the issues whose stack holds that frame, newest activity first |
| `search` with `stack: "SomeFile.cpp"`, `stack_kind: "filename"` | the issues with a frame from that file |
| `search` with `guid: "<32-hex event id>"` | the issue that contains that event, with its latest crash facts |
| `issue` with `issue: "<SHORT-ID>"` | the issue plus its latest event's crash GUID, build and stack |
| `event` with `event: "<32-hex event id>"` | the event and its issue |

## 3. What a Sentry instance indexes, and what it does not

An Unreal crash-report event carries the Unreal crash context, among it `contexts.unreal.crash_guid`
(`UECC-Windows-<hex>_<n>`), `crash_type`, `build_version`, `crash_reporter_message`, and tags such as `BranchName`,
`BuildVersion`, `P4ClientName`, `PlatformName`, `machine_id` and the reporting user.

The instance the tool was built against answered these searches as listed; another instance may index differently,
which the tool turns into its own `400` answer instead of a guess:

| Search | Works? |
| --- | --- |
| free text over the issue (a function, a build version, a user name, a branch) | yes |
| `stack.function:"*<name>*"`, `stack.filename:"*<name>*"` | yes; a bare value without wildcards must match the whole field |
| a 32-hex event id as the issue query, or through the event-id endpoint | yes |
| a short id through the short-id endpoint | yes (`op=issue` reads it) |
| `crash_guid:<value>`, `contexts[unreal][crash_guid]:<value>`, `contexts.unreal.crash_guid:<value>`, the bare crash GUID | no — the Unreal context is stored on the event, not indexed for search, and the project's tag list held no `crash_guid` |

So a report that comes with a Unreal crash GUID (`UECC-Windows-…`) is found by its stack or title, not by the
GUID itself; the GUID is then read from the issue's latest event. A Sentry event id, an issue short id and a
`worker-<32 hex>` Session id do resolve, which is why the tool normalizes the last one.

## 4. Running it in a deployment

1. Put `SENTRY_AUTH_TOKEN`, `SENTRY_URL` and `SENTRY_ORG` in the host's environment (`~/.dsh/.env`).
2. Restart the host: the tool is part of the installed package, so a running host picks it up on its next start.
   Nothing in the panel changes.
3. Start a Ticket and call `sentry` — `op=search` with `query: "is:unresolved"` is the shortest check that the
   token, the URL and the organization are right.

## 5. What exists today

| Part | Status |
| --- | --- |
| The tool, its schema and its configuration | Implemented and unit-tested (`tests/sentry.spec.ts`) |
| Search by text, stack and event GUID; issue and event reads against a real instance | Verified with the deployment's token against the instance it was built for |
| The tool inside a restarted host | Not yet: the change ships in the package and takes effect on the host's next start |
