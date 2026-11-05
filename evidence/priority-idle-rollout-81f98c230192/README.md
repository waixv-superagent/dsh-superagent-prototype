# Priority ask and idle gate: live state on 2026-11-05, and the three TAPD tickets it arranged

Read-only verification against the live deployment on this host between 14:03 and 14:22 +08:00. Nothing was
restarted and no setting was changed.

## Version and premises

- Deployed commit `f6e9da4` (main as of 04:00:12 +08:00), which contains PR #51's merge `782a81d`;
  `git merge-base --is-ancestor 782a81d HEAD` passes.
- Installed `lib/index.js` SHA-256 `BD435CF8635CD0A2BFEA1246A817C898BAD52E2C6A0613F4A1EE8E2B717EAE52`, equal to
  the repo build; the host started 11:47:27 +08:00 and `GET /orchestrator/api/state` reports
  `health.runtime = ready` (tapd, feishu and cards ready).
- Settings: `executor.idle.enabled = true` with the defaults documented in `docs/019-priority-and-idle.md`;
  the Feishu Source's intervention chat (`notifyChat`) is empty.

## The idle gate is live

| Ticket | Priority ask | Level after the ask | Idle record |
| --- | --- | --- | --- |
| `8bf631e4` | 03:35:26Z, expired 04:05:27Z | `P2`, `note: ask-timeout` | entered 03:35:26Z, `launchedIn: L1`, launched 04:24:21Z |
| `ccd0fd95` | 04:32:50Z, expired 05:02:51Z | `P2`, `note: ask-timeout` | entered 04:32:50Z, `launchedIn: L1`, launched 05:37:41Z |
| `cf9a22031b89` | 06:12:59Z, deadline 06:42:59Z | pending when read | none; its assignment stayed `pending` |

The first two are TAPD tickets that went the whole way without an answer: question, 30-minute timeout, `P2`,
idle pool, `L1` launch. The third was created at 14:12 local and its pending question held the launch.

## The priority card is wired but not delivered

None of the TAPD tickets created since the deployment has a `priorityAsk.cardId`, and `KV.feishu.priorityCards`
holds no entry. `src/app/priority.ts` sends the card once, in the `ticket.created` event; a TAPD ticket has no
Feishu conversation of its own, so `src/app/plan.ts` resolves the destination to `notifyChat`, which is empty —
the send warns and is never retried, and the 30-minute default still applies. Filling the Feishu Source's
intervention chat with the operator's chat makes later TAPD tickets deliver a card (a settings save, no restart);
tickets created before it are not resent.

## The three TAPD tickets

The same Feishu request at 06:02:58Z created them in the requested order:

| Ticket | Bug | State when read |
| --- | --- | --- |
| `2552fb61e06e` | 1286550 | plan phase, worker running |
| `7e43d75b7382` | 1283720 | ended `dropped` at 06:19:05Z, its approved plan concluding no change |
| `82cf5b0f756e` | 1285414 | plan phase, worker running |

All three are `P1` from the human-mention default, so they run with the mainline and do not exercise the card or
the gate. The deployment already contained #51 when they were created, so this ticket did not restart the host.

## Limitations

- The card has not been delivered live; the evidence is its absence plus the code path. A capture of an actual
  card needs one new TAPD ticket after the intervention chat is set.
- The two completed idle launches were recorded before this ticket started; `cf9a22031b89` proves the
  pending-question hold only, not the full timeout-to-launch path again.
