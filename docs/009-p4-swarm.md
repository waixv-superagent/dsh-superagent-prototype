# 009 — p4 and Swarm delivery

This document covers the `p4` delivery backend: a Ticket's directory becomes a Perforce workspace of a depot, and delivering means shelving a changelist for a Swarm review instead of opening a GitHub pull request. Which backend a Ticket uses follows its delivery target (section 1); `settings.executor.backend` only decides for a Ticket that has none.

## 1. Choosing the backend

A Ticket's backend comes from where its work belongs, not from a per-ticket question. The installation configures its delivery targets once: the GitHub repository its GitHub Source watches (`git`), and `executor.p4.depot` with the task center's `executor.workspaces` (`p4`). An accept names `target` — the repository slug or URL, the depot, or one of its workspace ids or directories — and `src/app/delivery-targets.ts` resolves it to the canonical target and its backend (`resolveDelivery`). A Ticket whose accept names no target follows its Source: a GitHub Trigger belongs to the watched repository and a TAPD Trigger to the depot; anything else keeps `settings.executor.backend`. An accept whose target the installation does not configure is refused with the configured ones, so a person never has to choose or confirm a channel. The target is fixed before the worker starts, so a worker never re-checks the channel at P1: a Ticket whose target turns out wrong is moved with `tickets/:id/redispatch`, which keeps a plan that still waits for a person.

`settings.executor.backend` remains the fallback for a Ticket with no target: the panel shows it at the top of the Environment block of Execution settings, with the p4 fields below it. Changing it affects Tickets accepted afterwards — a running Ticket keeps the flow it started with. A ticket moved by hand with `tickets/:id/redispatch` takes the new environment's canonical target.

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
| `p4.postApprovalJob` | Jenkins job Swarm triggers when a review is approved; its build is the pre-submit smoke the host reads for the smoke stage. Empty disables that stage. Default `PostApproval-Entry` |
| `p4.reviewers` | Reviewer choices on the review-waiting card: `{ label, user }` with the p4 account a pick adds to the review as a required reviewer. Empty shows no picker |
| `p4.autobuildJob` | Jenkins job that builds the editor after a submit. Set, a submitted change stays open at step `autobuild` until its build passed and a person sent the package or closed the Ticket. Empty completes the Ticket at the submit, as before |
| `p4.autobuildArtifact` | The package link of a passed autobuild, with `<build>`, `<cl>` and `<url>` filled in; empty uses the build page |
| `p4.autobuildTargets` | People (`ou_…`) and chats (`oc_…`) the package card may send to, as `{ label, id }` |
| `p4.autobuildMinutes` | Minutes after the submit with no autobuild including it before the card says so. Default 120 |
| `p4.followupSeconds` | Seconds between the host's polls of an open review; `0` disables automatic follow-up. Default 60 |
| `p4.fixAttempts` | How many times a failing pipeline wakes its worker to fix it before a person is asked. Default 3 |
| `p4.stuckMinutes` | Minutes without a new review version or check result before the pipeline counts as stuck. Default 45 |

The last three keep their defaults until a deployment sets them in the executor settings; the Execution settings panel exposes no field for them yet.

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
- **Follow up by reshelving changed content**: after review comments or a red pipeline, edit, run `p4 shelve -c "<CL>" -f`, and reply on the review. A reshelve whose diff did not change opens no review version and triggers no rerun, so never reshelve only to rerun; report blocked and name who must rerun instead.
- **After the changelist is submitted**, when a follow-up continues on those files: `p4 sync <files>` to the submitted revision, `p4 change -i`, then `p4 edit -c <new CL> <files>` (or `p4 reopen -c <new CL> <files>` if they are still open). Never reuse the submitted changelist.
- **Never sync the whole workspace**: only the files of a submitted changelist, after its submit, so a peer's open files are not disturbed.
- **Record the identifiers**: the changelist number and the review id go back into the Ticket, so later turns and the panel can link to them.

## 5. Following a review automatically

The host follows the review itself; no follow-up worker polls Swarm. A ready report whose work was delivered to p4 starts
`PipelineWatch` (`src/app/pipeline-watch.ts`) on the ticket right there, before any person verifies anything. The watcher
checks every open p4 ticket with a changelist or review every `p4.followupSeconds` (60 by default, `0` disables it), reading
Swarm with the same credentials the check tool uses. It records one `PipelineObservation` per state change, and the ticket
stage becomes `pipeline` from the delivery on: the local P4.5 check is recorded in parallel and no longer starts anything.

The panel draws them as one four-step track — pre-approval checks, the person's review, the pre-submit smoke, the
submit — from the observation's `step`; `progress` (such as `8/11 passed`) fills the first node, and the smoke build's URL
is the link for the third. Both fields are optional: a pipeline recorded before them is read from its state and last
check, so old tickets render too.

The states it derives, in order:

| Swarm/Jenkins fact | Observation | What happens |
| --- | --- | --- |
| A check `fail`, or an AI verdict that is not 通过 | `failure` | A new signature wakes the worker with the failing check titles, their Jenkins error lines and the AI verdict. The same signature is not handed over twice. |
| `testStatus = pass` and the AI verdict is 通过 (or absent) | `review` | The pipeline goes blocked+manual with `Swarm 已通过，待人工审核`, and one message reads `Swarm - <id> 已通过，待人工审核。` with the id linked to the review. The AI's remaining suggestions are mentioned, not treated as a failure. |
| `state = approved`, no commits yet, and a running build of `p4.postApprovalJob` | `approved` (step `smoke`) | `已审核通过 · Jenkins 冒烟中（#N）`, one card `已审核通过 · presubmit 冒烟中`; the build's URL is the stage link and polling continues. Swarm itself reports only the pre-approval checks, so this build is read from Jenkins by its `ReviewId` parameter. |
| `state = approved`, no commits yet, and that build passed | `approved` (step `ready`) | `Jenkins 冒烟已通过，等待提交`, one card `presubmit 通过 · 待提交` |
| `state = approved`, no commits yet, and that build failed | `blocked` (step `smoke`) | `提交前冒烟失败（#N）`; a person reads the build log and fixes or reruns it. |
| `state = approved`, no commits yet, and no readable smoke build | `approved` (step `ready`) | `Swarm 已审核通过，等待提交`, the old approval fact; one message `Swarm - <id> 已审核通过，等待提交。` with the id linked; polling continues. |
| `state = committed`/`archived`, or `approved` with commits | `merged` | The chat gets one 提交成功 card. Without `p4.autobuildJob` the ticket completes as `verification.by: pipeline`, and no check reopens it; with one, it stays open at step `autobuild` (`pipeline.submitted` records the submit) until the autobuild that includes the change passed and a person sent or closed it. |
| Review `404` and the changelist is gone (`p4 describe -S` says no such changelist) | `merged` | Submitting deletes the pending changelist, so a missing one after a known review is the submit's trail. |
| Review `404` but the changelist is still pending | `blocked` | The review disappeared without a submit; a person must check it. A grace period covers the first five minutes after delivery, when Swarm may not serve the new review yet. |
| A failure unchanged after the worker's last action for `p4.stuckMinutes` | `blocked` | A reshelve with no content change opens no review version, so the person decides instead of the worker looping; the worker can also ask Swarm to rerun the same version. |
| `p4.fixAttempts` failures already handed to the worker | `blocked` | The loop stops and a person decides. |
| No result at all for a version older than `p4.stuckMinutes` | `blocked` | Swarm never produced checks for that version; a person reruns or investigates. |

A failure is internal work, so it sends no chat message: the worker gets a text Input with the failing checks and Jenkins
errors and fixes them in its workspace. Messages are queued only for facts a person acts on (a green review, an approval, a
blocker, the submit), once per event, with a deterministic id so a repeated poll never repeats the message.

### Stage cards in chat

Each of those messages is a card on Feishu (`src/core/pipeline-notice.ts` builds it, `pipelineStageCard` in
`src/sources/feishu-card.ts` draws it), with the one-line text as the fallback when Feishu refuses a card. The headline
names the stage and its colour its state: blue running, green passed, orange waiting for a person, red failed. Its links
(review, Jenkins build, package) open in the system browser, where Swarm and Jenkins can ask for a login.

| Stage | Card | Action |
| --- | --- | --- |
| Green review | 检查已通过 · 待人工审核, with the check counts | With `p4.reviewers`, pick reviewers and 发到 Swarm: `POST <reviewApi>/reviews/<id>/participants` adds them as required reviewers |
| Rerun requested | 检查重跑中, once per request | — |
| Stuck failure / no result | 检查卡住 · 需要重跑 / 检查没有结果 | 重跑检查 asks Swarm to rerun the failing checks, as `orchestrator_pipeline_rerun` does, and resumes following |
| Smoke running / passed / failed | 已审核通过 · presubmit 冒烟中 / presubmit 通过 · 待提交 / presubmit 失败, each with its build | — |
| Submit | 提交成功, with the submitted CL | — |
| Autobuild running / passed / failed / no build | autobuild 构建中 / 出包成功 / 失败 / 没有结果 | Passed: pick people or chats and 发送编辑器包 (one message each, with the package link); 关单 completes the Ticket |

Only the Ticket's own requester, or a person the Policy allows on Feishu, can use these actions; a reviewer or recipient
not in the configured list is ignored. The card is replaced with what happened, or with Swarm's reason when it refused.
Each stage of each review version is announced once, so the passed smoke and the plain approval are separate events.

A worker that finds the code unchanged and the failure flaky can ask Swarm to rerun the current version instead of reshelving
an unchanged changelist: `orchestrator_pipeline_rerun` calls `POST <reviewApi>/reviews/<id>/testruns/<testrun>/run` for every
failing check. Swarm moves those testruns to `running`, no review version is added, and the host treats the old failure as
stale for five minutes; a rerun that still fails wakes the worker once more with the new result. The tool never calls Jenkins
directly; Swarm owns the testrun.

The review payload this relies on:

- `GET <reviewApi>/reviews/<id>` returns `data.reviews[0]` with `state` (seen: `needsReview`, `approved`; Swarm also uses
  `needsRevision`, `rejected`, `committed`, `archived`), `stateLabel`, `testStatus` (`pass`/`fail`/`running`/empty),
  `versions[]` (each with `change`, `time`, `testRuns`, so a reshelve with changed content adds one) and `commits[]`.
- `GET <reviewApi>/reviews/<id>/testruns` returns `data.testruns[]` with `title`, `status`, `url`, `version`; the check tool
  and the watcher read it for detail.
- `POST <reviewApi>/reviews/<id>/testruns/<testrun>/run` reruns one check; the response's `data.testruns[0].status` is
  `running`, and no review version is added.
- `GET <reviewApi>/reviews/<id>/comments` returns `data.comments[]` whose AI entries carry `context.version`; the watcher reads
  the verdict (`**结果**: 审核通过✅` / `审核不通过❌`) and advice (`**建议**:`) of the current version only, so an older
  round's verdict never decides a newer one.
- `p4 describe -S <CL>` says `*pending*` while the shelf waits, and reports no such changelist once the pending changelist is
  submitted (a submit creates a new number).

`orchestrator_pipeline_check` stays available for a manual look, `orchestrator_pipeline_rerun` reruns the current version's
failing checks, and `orchestrator_pipeline` lets a worker record an outcome by hand. `scripts/swarm-followup.mjs` remains the
command-line equivalent for a person or another script. A Swarm Source that turns
review comments into Triggers is still not implemented; the watcher covers the state changes a p4 Ticket needs, not a general
review conversation.

## 6. What exists today

| Part | Status |
| --- | --- |
| Backend switch, p4 settings, p4 execution variables | Implemented and tested (`tests/p4.spec.ts`) |
| Generated workspace prepare and sync | Implemented and tested; not yet run against a real server |
| Delivery instructions (changelist, shelve, review, keeping the edits, the new changelist after submit) | Implemented as one paragraph appended to a p4 Ticket's assignment; the GitHub skill is still registered for every Session, so its pull-request wording stays available |
| Tool-level refusal of `p4 submit` | Implemented as a worker `p4` wrapper that passes every other subcommand through; like the other wrappers it fails only when `p4` is invoked by name, so an absolute path still runs |
| Swarm Source (review comments and pipeline results as Triggers) | Not implemented; comments still reach no Ticket |
| Automatic pipeline follow-up | Implemented as `PipelineWatch` (`src/app/pipeline-watch.ts`): polls every open delivered p4 ticket, wakes the worker on a new failure, queues one message for a green review, an approval, a blocker or the submit, and completes the ticket when the changelist is submitted. Tested with fakes and against real reviews |
| Pipeline follow-up as a command | Implemented as `scripts/swarm-followup.mjs`: polls a review's testruns with the credentials in `P4USER` and `P4TICKET`, prints the failing checks with their Jenkins URLs, and exits `0` pass, `1` fail, `2` still running, `3` configuration or network error. `--self-test` checks the parsing and the authentication header against a synthetic payload |
| Pipeline check tool | Implemented as `orchestrator_pipeline_check`: testruns, AI verdict, and a failed Jenkins build's error lines and tail; the token stays in the host and is redacted from the result |
| Rerun tool | Implemented as `orchestrator_pipeline_rerun`: `POST <reviewApi>/reviews/<id>/testruns/<testrun>/run` for the failing checks; no new version, and a still-failing rerun wakes the worker once more |
| Operating account, depot, Swarm instance | Not verified in this installation; see 006 Deployment |

## 7. Acceptance

1. Accept a Ticket with `backend = p4` and check that its directory is a workspace: `p4 -c "$DSH_SUPERAGENT_P4_CLIENT" opened` runs, and the synced files are the configured revision.
2. Make a trivial change and deliver it: a changelist exists, `p4 describe -S <CL>` shows it still `*pending*` with its shelved files, `p4 opened -c <CL>` still lists the files (nothing was reverted), the review exists in Swarm, and `p4 changes -s submitted` shows nothing new. The Ticket's stage is now `pipeline / running` and its local check is pending in parallel.
3. Let a check fail: the host wakes the worker once with the failing check and its Jenkins error lines; the chat receives no failure message. Fixing the content and reshelving opens the next review version; a reshelve with no content change does not, so a flaky failure is rerun with `orchestrator_pipeline_rerun` (no new version), and after `p4.stuckMinutes` the Ticket asks a person instead.
4. Green checks: the chat receives one "Swarm 已通过，待人工审核" message and the Ticket waits as `pipeline / blocked`; no repeat message on later polls. A person's approval moves it to "Swarm 已审核通过，等待提交", or, with `p4.postApprovalJob` readable, to the pre-submit smoke stage (`已审核通过 · Jenkins 冒烟中`); the submit posts one 提交成功 card and ends the Ticket, or, with `p4.autobuildJob`, waits for the autobuild card.
5. Have a person submit the changelist: `p4 describe -S <CL>` reports no such changelist, the review closes, and the Ticket completes with `verification.by: pipeline` (or keeps a person's earlier local check as `by: person`).
6. Have a person return the local check on a delivered Ticket: it goes back to `implement` with their note, and a later delivery starts a new pipeline round. Comments on the review still reach no Ticket, so item 3 of section 6 remains unimplemented.

