# 009 — p4 and Swarm delivery

This document covers the `p4` delivery backend: a Ticket's directory becomes a Perforce workspace of a depot, and delivering means shelving a changelist for a Swarm review instead of opening a GitHub pull request. The `git` backend stays the default and is unaffected.

## 1. Choosing the backend

`settings.executor.backend` is `git` or `p4`; the panel shows it at the top of the Environment block of Execution settings, with the p4 fields below it. Switching affects Tickets accepted afterwards — a running Ticket keeps the flow it started with.

| Setting | Meaning |
| --- | --- |
| `p4.port` | `P4PORT`, such as `p4.example.com:1666`; empty keeps the installation's own setting |
| `p4.user` | The account that creates changelists and shelves them; empty keeps the installation's own setting |
| `p4.clientTemplate` | Workspace name per Ticket, with `<name>` replaced by the Ticket's short name |
| `p4.depot` | Depot directory the workspace maps, such as `//depot/mainline`; a stream path works here for the sync too |
| `p4.stream` | Stream the workspace is a client of, such as `//sun/mainline`; a stream depot refuses a hand-written view, so this replaces step 2 below |
| `p4.syncSpec` | Revision a new workspace syncs to, such as `@12345`; `@head` means head and is left off, because it is not a valid sync path spec |
| `p4.swarmUrl` | Swarm base URL, used to open and follow reviews; empty disables review actions |
| `p4.reviewApi` | Swarm API version prefix, such as `/api/v11` |
| `p4.jenkinsUrl` | Jenkins base URL used to read a failed build's consoleText; empty uses the testrun URL's origin |
| `p4.jenkinsUser` | Jenkins account for that read; empty uses `p4.user` or `P4USER` |
| `p4.jenkinsToken` | Jenkins API token for that read. It is stored only in this installation's settings, used by the host-side check, redacted from its result, and never written to a prompt, a log or the repository |

## 2. Preparing a workspace

With the `p4` backend and an empty `executor.prepare`, the Executor runs a generated command instead of leaving the directory empty. It:

1. creates the workspace directory;
2. writes a workspace specification rooted there: with `p4.stream` set, it takes the server's own template for that stream (`p4 client -S <stream> -o`) and replaces only `Root`, because a stream depot validates `Host`, `Options` and `Stream` together; without one, it writes a single `View` mapping `p4.depot/...` to `//<client>/...`;
3. submits the specification with `p4 client -i`, never `-f`: a non-admin account may save its own client but forcing one is refused with "You don't have permission for this operation";
4. syncs `p4.depot/...` at `<syncSpec>`.

The client is named after the workspace under the task center (see 011 Task center), so one workspace has one client and its Tickets keep their own changelists inside it.

A task center workspace shares one client across the Tickets placed in it. Each Ticket delivers in a changelist of its own — `p4 change -i`, `p4 reopen -c <CL> <files>`, `p4 shelve -c <CL>` — and keeps its files and edits in the workspace afterwards: a person may test the change locally and the next round continues from the same edits, while the lease, not a clean tree, keeps peers off those paths. It does not revert them after shelving.

Everything is read from the execution environment, so no depot path is baked into the code: `DSH_SUPERAGENT_P4_CLIENT`, `DSH_SUPERAGENT_P4_DEPOT` and `DSH_SUPERAGENT_P4_SYNC`. A custom `executor.prepare` command still wins over the generated one, so an installation that needs a different layout keeps full control.

A failed prepare fails the Ticket with the command's output and is not retried, because an existing directory counts as prepared (see 007 Architecture).

## 3. Execution variables

The p4 backend adds these to the execution environment, visible in Execution settings beside the prepare command whether or not a Source is enabled:

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_BACKEND` | `git` or `p4` |
| `DSH_SUPERAGENT_P4_CLIENT` | The Ticket's workspace name, from the template and its short name |
| `DSH_SUPERAGENT_P4_PORT`, `DSH_SUPERAGENT_P4_DEPOT`, `DSH_SUPERAGENT_P4_SYNC`, `DSH_SUPERAGENT_SWARM_URL` | The configured values |
| `DSH_SUPERAGENT_P4_CL`, `DSH_SUPERAGENT_SWARM_REVIEW` | Empty at launch; the worker records them when it delivers |

No variable holds a credential.

## 4. Delivering

A worker delivers one Ticket as one changelist, one review:

```sh
p4 changes -m1 -s submitted "$DSH_SUPERAGENT_P4_DEPOT"   # what the change was based on
p4 change -o                                            # fill Description, then:
p4 change -i                                            # -> <CL>
p4 reopen -c "<CL>" ...                                  # put the edits in that changelist
p4 shelve -c "<CL>"                                      # never submit
p4 describe -S "<CL>"                                    # self-check the shelf; *pending* means not submitted
p4 review -c "<CL>"                                      # or POST to the Swarm API
```

Rules for this flow:

- **Never `p4 submit`.** The mainline is read-only for the agent: changes are delivered as shelved changelists and land only after a person submits them.
- **A changelist per Ticket**, named after the Ticket's short name in its description.
- **Keep the edits after shelving.** Do not `p4 revert` the delivered files: the person may test the change locally and a follow-up round edits the same files, while the lease keeps peers out of those paths.
- **Follow up by reshelving**: after review comments or a red pipeline, edit, run `p4 shelve -c "<CL>" -f`, and reply on the review.
- **After the changelist is submitted**, when a follow-up continues on those files: `p4 sync <files>` to the submitted revision, `p4 change -i`, then `p4 edit -c <new CL> <files>` (or `p4 reopen -c <new CL> <files>` if they are still open). Never reuse the submitted changelist.
- **Never sync the whole workspace**: only the files of a submitted changelist, after its submit, so a peer's open files are not disturbed.
- **Record the identifiers**: the changelist number and the review id go back into the Ticket, so later turns and the panel can link to them.

## 5. Following a review

Reviews are followed the way pull requests are: a new comment, a status change, and a pipeline result each arrive as a Trigger for the Ticket's Thread, and a reply goes back to the review. This is not implemented yet; the table in section 6 says what exists.

Until it is, a worker follows its own review in the Session that opened it, by polling Swarm, and reports the outcome in the Ticket. `scripts/swarm-followup.mjs <reviewId>` does the polling half already: it reads `P4USER` and `P4TICKET` from the environment, prints each failing check with its Jenkins URL, and exits with a code a worker can branch on. A p4 Ticket can point at a project-specific pipeline skill instead of the GitHub pull-request skill.
The worker also has `orchestrator_pipeline_check`: given a review it returns the testruns and the AI verdict, and given a failed Jenkins URL it returns that build's error lines and tail. The check runs on the host, so the Jenkins token never enters the Session, a command line or a report; the tool redacts it from the log it returns. Only a Ticket whose executor backend is p4 enters this follow-up: a git backend has no Swarm review or Jenkins build, so its Ticket completes at the person's local check.

### What implementing it needs

The pipeline-failure half can be written from a project-specific skill:

- Base `https://swarm.example.com` (a review is `https://review.example.com/reviews/<id>`), API version `v10`.
- Authentication is HTTP Basic with `{p4user}:{p4ticket}` — the ticket comes from `p4tickets.txt`, so no password is stored in the configuration.
- `GET /api/v10/reviews/<id>/testruns` returns `{"data":{"testruns":[{"id","test","status","url","title"}]}}`, where `status` is `pass`, `fail` or `running` and `url` points at the Jenkins build. A red pipeline is therefore `status === "fail"`, and `title` names the check (`PreApproval-ClangTidy` and so on).
- Reshelving with `p4 shelve -r -c <CL>` re-triggers the pipeline only when the shelved diff actually changed, which is what a follow-up loop must respect.

Still missing, and therefore still not written:

1. The shape of `GET /api/v10/reviews/<id>` — which field carries the review state (`needsReview`, `approved`, `rejected`, …) and the participants.
2. The comments endpoint and its payload — without it a Source cannot raise a Trigger for "someone commented", which is the most useful half of the follow-up.

Two samples answer both: one review JSON, one comment JSON. With them the Source is a `swarm` kind with:
- schema: `swarmUrl`, `reviewApi`, `project`, `pollSeconds`, `listen`;
- `health`: one entry, `error` on an authentication or connection failure;
- Trigger: one per new comment, one per review state change, one per newly red pipeline, with a stable id from the review id plus the comment id or the testrun id;
- `threadContext`: the review description, its comment thread and the latest failing testrun with its Jenkins URL;
- `channel`: replies post a comment on the review;
- `scope`/`policy`: reviews authored by the deployment's account are subscribed automatically, like pull requests.

Swarm credentials stay out of the configuration: the Swarm API is called with the p4 ticket taken from the environment, and the p4 account needs only read access plus changelist and shelve rights. The Jenkins API token is the one delivery credential that may be configured, because it is not derivable from the p4 session; it lives in `p4.jenkinsToken`, is used only by the host-side check, and is redacted from what that check returns.

## 6. What exists today

| Part | Status |
| --- | --- |
| Backend switch, p4 settings, p4 execution variables | Implemented and tested (`tests/p4.spec.ts`) |
| Generated workspace prepare and sync | Implemented and tested; not yet run against a real server |
| Delivery instructions (changelist, shelve, review, keeping the edits, the new changelist after submit) | Implemented as one paragraph appended to a p4 Ticket's assignment; the GitHub skill is still registered for every Session, so its pull-request wording stays available |
| Tool-level refusal of `p4 submit` | Implemented as a worker `p4` wrapper that passes every other subcommand through; like the other wrappers it fails only when `p4` is invoked by name, so an absolute path still runs |
| Swarm Source (review comments and pipeline results as Triggers) | Not implemented |
| Pipeline follow-up as a command | Implemented as `scripts/swarm-followup.mjs`: polls a review's testruns with the credentials in `P4USER` and `P4TICKET`, prints the failing checks with their Jenkins URLs, and exits `0` pass, `1` fail, `2` still running, `3` configuration or network error. `--self-test` checks the parsing and the authentication header against a synthetic payload |
| Pipeline check tool | Implemented as `orchestrator_pipeline_check`: testruns, AI verdict, and a failed Jenkins build's error lines and tail; the token stays in the host and is redacted from the result |
| Operating account, depot, Swarm instance | Not verified in this installation; see 006 Deployment |

## 7. Acceptance

1. Accept a Ticket with `backend = p4` and check that its directory is a workspace: `p4 -c "$DSH_SUPERAGENT_P4_CLIENT" opened` runs, and the synced files are the configured revision.
2. Make a trivial change and deliver it: a changelist exists, `p4 describe -S <CL>` shows it still `*pending*` with its shelved files, `p4 opened -c <CL>` still lists the files (nothing was reverted), the review exists in Swarm, and `p4 changes -s submitted` shows nothing new.
3. Comment on the review: the Ticket receives it, the worker reshelves with `-f`, and the reply arrives on the review.
4. Have a person submit the changelist and ask the Ticket to continue on the same files: the worker syncs them to the submitted revision and starts a new changelist instead of reusing the submitted one.

