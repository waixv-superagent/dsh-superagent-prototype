# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

3. To create a document owned by the person who requested it, give that person's Feishu user identity its own `lark-cli` configuration and wrapper, and record it in an `identities` team skill (**Prompts** in the panel):

   ```sh
   cat > ~/.local/bin/lark-user <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-user
   ```

   Use the configuration that holds that person's user login for the app; if the personal configuration is not for this app, create another configuration directory and log in as that person. The bot configuration above stays restricted to the bot identity. A worker creates and edits a document with the requester's identity, so the document is owned by that person, and uses the bot for everything else. The host does not check this second CLI; the `identities` skill is what tells the agents to use it and for what, and the built-in Feishu skill states the rule. In the skill, name the person's `open_id` and the command, for example: `Alice (ou_…): her documents use ~/.local/bin/lark-user, which logs in as her.`

   On Windows the wrappers are `.cmd` files with the same split; the personal configuration and the bot configuration are still separate directories:

   ```bat
   rem %USERPROFILE%\bin\lark-user.cmd: the requester's user identity for their own documents
   @echo off
   set "LARKSUITE_CLI_CONFIG_DIR=%USERPROFILE%\.lark-cli"
   set "LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1"
   "%APPDATA%\npm\node_modules\@larksuite\cli\bin\lark-cli.exe" %*
   ```

#### Keeping the bot identity working

The bot configuration is the deployment's only Feishu access: the Feishu Source polls and replies with it, and every worker runs `lark-cli` through it. Strict mode is a stored policy, not a per-command switch: with `strict-mode: user` every bot command is hidden, so the Source cannot read history or send replies, a worker cannot upload a file to a chat, and Source health says `strict mode is "user", only user-identity commands are available`. A worker that needed the user identity for one document once switched the bot configuration to `user` and did not switch it back; messages, reads and file uploads stayed broken for every ticket until a person switched it back.

An existing deployment that switched the bot configuration to `user` for a document should add the wrapper and the `identities` skill before upgrading: after the upgrade the worker shim refuses the switch.

Keep three rules:

- **The bot configuration stays `strict-mode: bot`.** A worker must not change it: worker `lark-cli` shims refuse `config strict-mode`, `config bind`, `config default-as`, `config init`, `config remove`, `profile` changes and `auth login`/`auth logout` with a message pointing here. Only the operator runs those, outside the worker `PATH`, for example `~/.local/bin/lark-bot config strict-mode bot`; the host also refuses to start on any other mode.
- **User-identity work uses the separate wrapper from step 3, one invocation at a time.** `lark-user docs +create …` acts as the requester while the bot keeps serving messages; nothing global changes and no restart is needed.
- **When the requester has no recorded user wrapper, ask them to set one up** (step 3 plus an `identities` team skill). Do not create or edit their document as the bot, and do not switch the bot configuration to borrow their login.

Use the user identity only where ownership or the API requires it:

| Operation | Identity |
| --- | --- |
| Reading chats, consuming events, sending messages, cards and files to a chat the bot belongs to | bot |
| Creating or editing a document owned by the requester, including one the Ticket created earlier | user, through that person's wrapper |
| Reading or changing the requester's personal drive, wiki, mail, calendar, tasks, OKR, attendance, minutes or message search | user, through that person's wrapper |
| A wiki node or document the bot cannot read because its owner did not grant the bot access | user, through that person's wrapper |

Check both wrappers once, and again after a repair:

```sh
lark-bot whoami    # "identity": "bot"
lark-user whoami   # "identity": "user", "onBehalfOf" the requester
```

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |
| `pipelineSkill` | no | Absolute path to a local pipeline-follow-up skill or its `SKILL.md`; empty uses the built-in follow-up instructions. The worker reads it when a failing check wakes it for a fix |
| `upgrade` | no | The one-click update from the fork (see [One-click update from the fork](#one-click-update-from-the-fork)): `checkout` (absolute path of a git checkout; empty turns it off), `remote` (`origin`), `branch` (`main`), `install` (the installed package directory; empty uses the one the plugin runs from), `startCommand` (empty restarts the same command line), `holdFile`, `pnpm` (`pnpm`), `intervalMin` (10) and `idleTimeoutMin` (30) |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

### Client plugins and open pages

The example profile disables `client-hmr`, the transport that live-swaps browser plugins inside an open page. Leave it off on an instance people use: a client plugin's bundle revision comes from its file metadata, so an install or a dependency change that re-resolves a client package changes the revision of every plugin that moves with it. The open page then tears down and re-imports those plugins in place; when they include the layout, sidebar, renderer or Session controller, the whole UI is rebuilt and the conversation and panel state are lost. The page did not navigate, so no document request reaches the server, but it looks and feels like a reload.

With the transport off, browser plugin updates apply when the page next loads or when the service restarts; the [Upgrade](#upgrade) steps restart it. Keep the entry disabled unless you develop client plugins and want them hot-swapped.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

### Feishu status card (optional)

The bot can keep one card in a chat that answers "what is the agent doing?" at a glance: how many Tickets are running, how many wait to be verified, how many wait for your decision, the last hour's model spend on one small line, counted as the board's billing strip counts it (the gateway's settled bill and the quota left when it can be read, otherwise the labelled 估算, or a token count when nothing is priced), a playful line when it is idle, and a red header when the service stops answering. It updates the card in place every minute, so it does not post a message each time. The glance layer is counts and fixed phrases; an expandable **工单明细** fold lists each running or waiting Ticket's title, its short state (阻塞, 待提交) and how long it has been idle, so send the card to a private chat. Tapping the card opens the panel's duty-desk board.

The card must turn red while the service is down, so `scripts/feishu-status.mjs` runs outside it, from a scheduler, like the hourly check. It reads `GET /orchestrator/api/overview` and `GET /orchestrator/api/state` on the panel's loopback address and sends, updates and pins the card through the bot's `lark-cli`. It needs only the permissions the bot already uses to reply (`im:message`).

The state card also carries the watchdog's outage recovery: while a model gateway or network failure is being retried, the header says `模型上游断连 · 自动恢复中` and the note names how many Tickets wait for their automatic retry and whether the main Session is being resumed too; a main Session that is being created again reads `主对话掉线 · 正在重建`, and a recovery chain that used its last try turns the card red with `自动恢复已停止` so a person knows to step in. The state API reports this as `watchdog` (`recovering`, `tickets`, `master`, `gaveUp`, `missing`), so a card from an older script simply keeps its previous shape when the field is absent.

The card turns orange with `N 张工单疑似卡住` while the host's stall alert counts open Tickets as stalled (docs/007, Stall alert): a working Ticket without progress for `executor.stall.minutes` (15) or one queued for `executor.stall.queuedMinutes` (30). A `P2`/`P3` Ticket the idle gate has not admitted yet is excluded: it waits for the system to become idle (docs/019), which may take hours while the mainline runs, so the idle pool is not what the card calls stuck. Each such Ticket's own conversation also hears of it once, in at most three lines; `executor.stall.notify: false` keeps it to the card and the overview. The state API reports it as `stall` (`tickets`, `items`); an outage the watchdog recovers stays first on the card, since it explains the stall.

On Windows, run it from Task Scheduler through a hidden wrapper, so no console window flashes every minute:

```text
' <bin>\feishu-status.vbs
Set shell = CreateObject("WScript.Shell")
shell.Run "node ""<checkout>\scripts\feishu-status.mjs"" --chat oc_… --panel-url http://127.0.0.1:3082 --lark-cli ""<bin>\lark-bot.cmd"" --link-url ""https://<host>/?view=board""", 0, False
```

```powershell
schtasks /create /tn dsh-feishu-status /sc minute /mo 1 /f /tr "wscript.exe //B //Nologo ""<bin>\feishu-status.vbs"""
```

On POSIX, one crontab line runs the same script: `* * * * * node <checkout>/scripts/feishu-status.mjs --chat oc_… --lark-cli <bin>/lark-bot --link-url https://<host>/?view=board`.

`--print-card` prints the card JSON without sending it. `--state-file` changes where the message id, the last successful read and the rotating log live; the default is `<stateDir>/feishu-status.json`. `--link-url` is the page a tap on the card opens: use the panel address the reader can reach, such as `https://<host>/?view=board` through Caddy or `http://127.0.0.1:3082/?view=board` on the machine. The panel opens that duty-desk board before the route it remembered; `?page=overview` is the legacy alias. A remote address asks for the panel's login once per browser, so never put a password or token in the URL or the card. Without `--link-url` the card is not tappable. The card's link carries Feishu's `lk_jump_to_browser=true` and `lk_mobile_jump_to_browser=true` (desktop 7.7+, mobile 7.11+), so a tap opens the system browser instead of Feishu's embedded web view, which cannot show the panel's Basic-auth prompt; older clients ignore them and open the embedded view as before.

Limits:

- Feishu updates a card only for 14 days after it is sent. The script therefore sends a fresh card every 13 days and marks the old one expired. The old card and its pin stay in the chat: recalling a message and removing a pin are both high-risk operations that need a person's confirmation, so the script never does either.
- The expandable detail carries Ticket titles, so keep the card in a private chat. The card's JSON also cannot carry literal `<` or `>` (the CLI runs through `cmd.exe`); the script escapes titles and uses no inline HTML.
- If the machine or its network is down, the script is down too, and the card keeps its last state. A red card means "the service stopped answering while the scheduler still runs"; a machine-level signal needs an observer outside the machine.

### Billing strip

The Overview board shows, directly above its lanes, which model route is charging now and what the rolling hour cost. The host reads every managed Session's `assistant/message` usage event, keeps one minute-granular hour of it, and prices each model from that route's own published `/v1/models` list. It finds the list through the route's configured `baseURL` and `apiKeyEnv` (the `llm-pi-ai` provider `ai-gateway` in this installation), caches it for ten minutes, and never makes a model request. Usage whose route publishes no price is shown as tokens and is never converted into money.

The strip leads with the actual token count of the rolling hour and breaks the usage down by provider and model, so an expensive model on the same gateway is not hidden behind a cheaper one. When the default route is a kurogames gateway with a configured `apiKeyEnv`, the money is what the gateway itself billed: the cost settled in the rolling hour and the share of the account's current period quota that is left. The host reads them from the gateway's own usage portal, `/my-usage/api/detail` and `/my-usage/api/timeline`, which back its "我的用量" page, with the route key from the credentials service (falling back to the environment). It reads at most once a minute, re-reads only the minutes still settling, and splits a range the portal truncates at 1000 requests. These figures belong to the whole key, so another tool on the same key counts too. The portal is undocumented: when it cannot be read the strip shows the published-price estimate, marked `≈`, and a partly read hour is shown as a lower bound with a trailing `+`. The estimate itself stays high for Claude models on this gateway, because their streamed cache hits arrive in fields the model adapter does not read. While the gateway cannot be read, the sparkline is token usage; once it can, the bars show the settled cost per minute.

The strip names the deployment default, the Eval role and the Executor role. A role whose **provider** differs from the default carries a warning tag, because a role left on a personal `deepseek-account` route is exactly how a personal balance gets spent without anyone noticing; a different model on the same provider is ordinary and shows in the per-route breakdown instead. The rolling window is persisted in the state database, so a host restart does not blank the hour; on startup the host also replays the durable usage of every Session it opens, and the persisted sequence watermarks keep that replay from counting the same calls twice.

The default comes from the DSH model catalog. Changing a role's model affects Sessions created afterwards: a Session keeps the durable `model/selection` it already recorded, so an in-flight worker may stay on the old route until its Ticket is retried or its Session is reselected. The strip shows the route that actually charged, not the route configuration promises.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A save that changes a field setup reads, namely the GitHub repository or agent CLI or the Feishu bot CLI, runs setup again and restarts dsh-superagent; other saves apply without a restart. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, whether to receive direct messages, and optionally a topic chat (listed with receive-all) where each accepted ticket gets its own topic.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work, and set each receiving scope's admission cells; until a list or a cell admits someone, a request does not become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |
| `POST outbox/<id>/retry`, `POST outbox/<id>/withdraw` | Sends a waiting Channel message again now, or withdraws it so it is never sent: `retried` or `withdrawn`. 404 when no such message waits |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, `otherChats` as `"none"` or `"mentions"`, `topicChat` (a topic chat listed in `chats` with `"listen": "all"`; after a ticket is accepted, the bot opens a topic named after its brief there, with the short id and the original message link, sends the ticket's later replies and cards to it, and posts the topic's link back in the original message's thread; empty keeps replies in the source chat), `notifyChat` (a private chat a plan card falls back to only when its ticket has no Feishu conversation; normally the card goes to the ticket's topic, else the chat it started in), `activeTopicHours` (after a message that mentions the bot or a direct message, later messages in the same topic count as requests without a mention for that long; default 24, `0` turns it off), and `ackEmoji`: the reaction added to a message the Policy admits and the bot takes, removed once its reply goes out, or once nothing will answer that message any more (default `OnIt`, Feishu's 「在做了」; `none` adds no reaction).
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers` (the concurrent Tickets one repository or workspace may run), `directory`, `prepare`, `blockedCommands`, `backend`, and `p4` (`port`, `user`, `clientTemplate`, `depot`, `stream`, `syncSpec`, `swarmUrl`, `reviewApi`, `jenkinsUrl`, `jenkinsUser`, `jenkinsToken`, `postApprovalJob`, `reviewers`, `autobuildJob`, `autobuildArtifact`, `autobuildTargets`, `autobuildMinutes`, `followupSeconds`, `fixAttempts`, `stuckMinutes`), and `stall` (`minutes`, `queuedMinutes`, `notify`) for the stall alert. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets. `jenkinsToken` is the only credential the settings hold: the host's pipeline check and automatic follow-up use it and redact it from their result; keep it out of commits and logs. `postApprovalJob` names the Jenkins job Swarm triggers after an approval, whose build is the pre-submit smoke the pipeline gate shows; empty hides that stage. `followupSeconds` controls the host's automatic Swarm/Jenkins poll (`0` disables it); `fixAttempts` bounds automatic failure fixes; `stuckMinutes` decides when an unchanged failure asks a person. Those three keep their defaults until a deployment sets them; the Execution settings panel exposes no field for them yet.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`. Before the install, delete any stale `node_modules/.pnpm/dsh-superagent@file+*` copy of this bundle: two installed copies resolve different client packages, and the next re-resolution can swap the browser plugin versions under an open page (see [Client plugins and open pages](#client-plugins-and-open-pages)).
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### One-click update from the fork

Set `upgrade.checkout` in the `dsh-superagent` entry to a git checkout of this repository. The plugin then fetches `upgrade.remote`/`upgrade.branch` (default `origin/main`) every `upgrade.intervalMin` minutes. It compares the branch head with the commit the installed package records in `build-info.json`. When they differ, a **有新版本** (Update available) badge appears at the sidebar foot beside Settings. Its dialog lists the new commits and offers **Update**.

An update runs these steps, which the dialog shows as they happen:

1. Fetch the commit and add a detached worktree of it under `<stateDir>/upgrade/build`. The checkout's own working tree and branch stay as they are.
2. Run `pnpm install --frozen-lockfile`, `typecheck`, `test` and `build` there. If any step fails, the update stops and the running service is untouched.
3. Pause dispatch, unless it was already paused. Wait until no worker is in a turn or has jobs running, for at most `upgrade.idleTimeoutMin` minutes. **Update now** skips the wait, and interrupted workers restart with a recovery note.
4. Hand off to the new build's `scripts/upgrade-switch.mjs`, then stop this process. On Windows the switch starts through WMI, so it outlives the process it replaces.
5. The switch backs up the installed package entries and `orchestrator.sqlite` to `<stateDir>/upgrade/backup`. It copies the new build over the installed package (`upgrade.install`, by default the directory the plugin runs from). It then starts the service with `upgrade.startCommand`, by default the same command line, and waits for `/orchestrator/api/state` to report a running runtime.
6. If the new version does not come up, the switch restores the package and the database and starts the previous version. Finally it resumes dispatch, unless dispatch was paused before the update.

`<stateDir>/upgrade/status.json` keeps the outcome, and `switch.log` keeps the output. The next host shows them in the dialog. If neither version comes up, the badge turns amber and the backup stays in place for a person.

The switch replaces only the plugin's own files and keeps the profile's `node_modules`. The dialog therefore refuses an update that changes dependencies (`pnpm-lock.yaml`, or the dependency fields of `package.json`): run the manual steps above for those.

If an external watchdog restarts the service while it is down, point `upgrade.holdFile` at the file that holds the watchdog off. The switch creates that file for the duration of the update and removes it afterwards, unless it already existed.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli is fixed to the bot identity` | A worker tried to change the bot configuration's identity policy. User-identity work goes through the requester's wrapper from Feishu bot step 3; only the operator changes the bot configuration, outside the worker `PATH` |
| Source health says `strict mode is "user", only user-identity commands are available` | The bot configuration was switched to the user identity. As the operator run `lark-bot config strict-mode bot` and check `lark-bot whoami` reports `bot`; the next polling round clears the history entry, and replies held in the overview can then be retried |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| Feishu refused the arguments of a reply; automatic retries stopped | The CLI rejected the message before calling Feishu, so retrying the same text cannot succeed. Fix the cause and restart, which sends it once more, or withdraw it from the overview |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| The browser page flashes white or rebuilds itself while in use, and the server logs no page request | A client plugin was hot-swapped under the open page. Keep `client-hmr` disabled as in [Client plugins and open pages](#client-plugins-and-open-pages), delete the stale `node_modules/.pnpm/dsh-superagent@file+*` copy before the next `pnpm install`, and restart the service; a page loaded before the change needs one reload |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
| Tickets stop with `LlmError: 503 …` and the main Session goes silent during a model-gateway outage | The host retries a Ticket that stopped on a passing failure on its own and tells the main Session to go on (docs/003); the `watchdog` entry on the overview names what waits. A short outage can also be ridden out inside one request by the provider's own retry policy: in the `llm-pi-ai:` settings section, `providers.<route>.retryPolicy` defaults to `normal` with five retries from 500 ms to 10 s, and a higher `maxRetries` with a `maxDelayMs` around a minute keeps a turn waiting instead of failing it; keep `mode: normal`, because `always` would retry a quota or credential failure that cannot heal |
| A Ticket fails with `SessionQueryError` / `SessionFormatError` (for example `tool call id requires a nonempty string`) | The stored Session log is corrupt, so resuming it fails the same way every time. The host and the watchdog never retry it; the failed report says so. A person removes that Session log under `<dshHome>/sessions/<workspace>/<session>/` (the path is in the report) and retries the Ticket, or continues it with a fresh Session id |
