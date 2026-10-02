# Pi Tools

A single [Pi](https://github.com/earendil-works/pi-mono) package containing six local-development extensions: `claude-skill`, `loop`, `messaging`, `task`, `work`, and `worktree-manager`. (`theme-sync` was removed in v0.5.0: Pi 1.0's built-in `system` theme follows the terminal's light and dark appearance.)

## Security

Pi extensions execute with full system access. Review this repository and its pinned release before installation.

Messaging is local-first. It accepts only a token-authenticated loopback NATS endpoint and stores broker authority and JetStream data in owner-only paths. Top-level terminal sessions join one host-wide group automatically (set `"messaging": { "autoJoin": false }` to turn this off); child agents never join. Agents cannot read stored bodies through tools. Every message, with its full body, is kept in an owner-only audit log that only the user reads.

The worktree, task, and Claude bridge commands can create processes, tmux sessions, branches, and worktrees. They are interactive commands and do not run merely because the package is loaded.

## Extensions

### claude-skill

`/claude-skill [skill-name] [arguments]` discovers Claude Code skills in project and user skill directories, presents a fuzzy picker when needed, and launches the selected skill in tmux. It requires `claude` and `tmux` in `PATH`.

### loop

`/loop start <prompt> [--max N]` starts an explicitly requested bounded prompt loop. `/loop status` reports state and `/loop stop` stops it. The model records exactly one final `loop_control` decision per iteration. The default is 12 total runs, the accepted range is 1–100, and known context use at or above 85% stops continuation. The extension provides cache-stable definitions without promising a provider cache-hit percentage.

### messaging

Every top-level terminal Pi session joins one host-wide `host` group when it starts, named after its tmux window or repository (the same name the work dashboard shows), so agents in different sessions can message each other without setup. Child agents never join; they talk to their lead over RPC. Presence comes from heartbeats and from the work session registry: a peer whose session is no longer running is `offline`, and is removed once it also stops heartbeating. A session leaves the group when it quits or switches to another session, and resumes the same identity after `/reload` or tree navigation.

The model-facing `peer_message` tool can discover peers with their presence and directional route modes, inspect bounded metadata-only status and its own send budget, or queue an explicitly typed message. It cannot reopen routes, raise its budget, take over identities, or read stored bodies.

Every new message is a `notice`, `request`, or `reply`. A notice atomically closes the recipient-to-sender route, so its recipient cannot answer with a disguised fresh message. A request grants its exact recipient one reply capability; the reply consumes that capability and closes both directions. In the host group, a route closed this way reopens after `messaging.routeCooldownMinutes` (default 10); a route a human closes with `/messages routes` stays closed, even across later requests and replies. Messages use stable member IDs rather than display names or transient session attribution.

Loop protections: each session may have only one unresolved outbound message, a recipient holds at most eight queued messages, and messages are delivered as one ordered batch only at an idle boundary, never between the steps of a run. Each session has a send budget of `messaging.sendsPerHour` (default 10) that refills continuously and holds at most one hour's worth; notices and requests cost one send, replies are free. Queued delivery expires after one hour, attempted-unconfirmed delivery becomes terminal-unresolved after ten minutes, and a delivered request's reply capability expires after one hour. Uncertain work is never automatically replayed.

`"messaging": { "paused": true }` pauses messaging on the whole host; a list of session names or session-id prefixes pauses only those sessions. `/messages pause` and `/messages resume` pause the current session until it restarts. A paused session neither sends nor receives automatically; messages to it wait in its queue.

**Audit log.** Every accepted message is recorded with its time, sender, recipient, kind, the request it answers, its delivery state, and its full body in the work database (`work.db`, mode 0600), and kept for `messaging.retentionDays` (default 30). Only the user reads it: the dashboard's Messages section, and `work messages [--peer <name>] [--since 2h]` in a shell. `work messages` refuses to run inside a Pi agent's shell commands.

`/messages` keeps the human-controlled operations: status, send, routes, inbox, prune, revoke, and pause. It can also join, arm, and leave manual groups with a finite shared allowance, as before.

Messaging requires NATS Server 2.14.6 in `PATH` (or `NATS_SERVER`) and uses a same-user loopback trust boundary.

### task

`/task [--split] <request>` infers a target repository and task, shows a review UI, creates or reuses a Pi-managed worktree, and launches a fresh Pi tmux session. Repository discovery is configured in `~/.pi/agent/worktree-manager.json`, for example:

```json
{
  "repoSearchRoots": ["~/src/github.com/owner"]
}
```

Automatic cleanup removes only clean Pi-managed worktrees and preserves their branches. Dirty worktrees are retained.

### work

A local work tracker for one person: one list of projects and items, a triage inbox, and a daily planner.

- `/todo <text> [#project] [due:<date>]` captures an item instantly. The project comes from `#project` or from rules for the current repository.
- `work_propose` lets agents propose follow-ups. Proposals only enter the triage inbox, with at most five pending per session.
- `/triage` reviews candidates from Jira (tickets assigned to you), GitHub (direct review requests and your own PRs; team review requests are excluded), and agents: accept, merge, dismiss, snooze, bulk accept, or accept and promote to Jira.
- `/today` syncs, triages, and opens a `today` tmux window running a fresh `plan-YYYY-MM-DD` Pi session with read-only snapshot tools and local-only update tools.

`work_propose`, `job_register`, and the lead tools below have `deferred` exposure: the model loads them with Pi's `tool_search` tool when it needs them, and a top-level terminal session activates `tool_search` for that. `session_status` stays declared directly, and `ask_user` is `model-only`. `children` is marked read-only, and `stop_child` and `merge_child` destructive.

The same features are available from the shell through `bin/work.ts` (`add`, `list`, `show`, `set`, `project`, `sync`, `triage`, `today`, `promote`, `undismiss`, `recap`, `restore`, `dash`, `job`, `messages`, `usage`, `export`, `import`). For example, use `alias work='node <package>/bin/work.ts'` and `alias todo='work add'`. Aliases do not reach tmux popups or hooks, so bindings should call a small `work` wrapper script on `PATH` instead.

**Sessions.** Pi sessions register themselves in the work database automatically: their pane, window, file, and status. A run marks it `working`. When the full run settles, after any retries or compaction, it becomes `needs-me` with the last line of the reply as its note, unless the agent called the static `session_status` tool to declare `needs-me`, `waiting-external`, or `done` with a note. A top-level TUI session that settles as `needs-me` also sends an OSC 777 desktop notification, except when its pane is active in an attached tmux client; set `"notifications": false` to disable these. Sessions link to items automatically from `PI_WORK_ITEM` (set by `/task` when the request names an item), from PR head branches and Jira keys in the branch name, or from another session in the same worktree. Terminal sessions always register as top-level sessions, with no pane when they run outside tmux. `rpc` sessions register as headless. `print` and `json` runs register only as child agents, when `PI_WORK_PARENT_SESSION` names their parent. Children appear only under their parent.

**Questions.** `ask_user` lets an agent ask one question (up to 300 characters, with optional `context` above it) with 2 to 6 options in a dialog. `j`/`k` and the arrow keys move, Enter chooses, and Esc dismisses. The `recommended` option is marked and pre-selected. Unless `allow_other` is false, a last row opens inline free-text entry. The answer, or a note that the user dismissed the question, comes back as the tool result, and the run continues. While the dialog is open, the session is `needs-me` with the question and its options as its note: it appears under Decisions on the dashboard, and the desktop notification fires as it does at settle. The tool is not registered in child runs, and it is deactivated outside terminal sessions. If it is called anyway, it tells the agent to ask in plain text.

**Dashboard.** `/dash` (or `work dash` in a terminal) opens a full-screen dashboard that leads with Decisions: sessions waiting on you, oldest first. A session that has never had a turn is `idle`, not waiting on you, and is listed under Other sessions. Pending triage joins Decisions only with `"dashboard": { "showTriage": true }` in the config. Waiting, Working, Jobs, Messages, and Other sessions follow. Messages lists the last 24 hours of lateral messages between sessions (time, sender → recipient, kind, and first line, at most 20); `Enter` shows the full message with its request or replies. Other sessions lists the last 24 hours and folds older ones into one `+N older` row; a `/` filter searches those too. A row is named after its tmux window, or after its repository (then its directory) when the window has a default name (`pi`, `zsh`, `bash`). Notes are shown without Markdown. From 140 columns a host panel shows CPU (per core, a second sample one second after opening), memory, disks (yellow from 85%, red from 95%), top processes, Pi processes with how many are not reporting to the registry, and orphaned processes. Keys are vim-style (`j`/`k`, `gg`/`G`, `Ctrl-d`/`Ctrl-u`, `Tab`, `/` to filter, `?` for help). `Enter` jumps to a session's pane and closes the popup, reopens a crashed or closed session, opens triage, or shows a child's read-only transcript. `L` links a session to an item, `x` then `y` stops a child agent, and `D` then `y` deletes a closed record. A tmux binding such as `bind g display-popup -E -w 90% -h 90% 'work dash'` needs the wrapper script mentioned above.

**Restore.** After a reboot, `work restore --auto` (for example from `@resurrect-hook-post-restore-all`) reopens crashed terminal sessions that ran in tmux, from the last 7 days, and are not `done`. It types `pi --session <file>` into a matching restored shell pane, splits the window, or opens a new window. It runs at most once per boot, and the dashboard runs the same logic when it opens. `work restore --dry-run` prints the plan.

**Jobs.** Agents register background jobs they start with the `job_register` tool (a cron entry or a process, with an optional `check_command`, `stop_command`, and log path). Users register them with `work job add --name <n> --kind cron|process [--check <cmd>] [--stop <cmd>] …`. There is no approval step. Instead, every job records the session that registered it, and the dashboard's details view shows the exact commands. Checks run only when you look: when the dashboard opens (for checks older than 60 seconds), on `c`, or with `work job check [J-n]`. Each check runs `/bin/sh -c` in the job's directory with a 15-second timeout, at most 4 at a time. Exit 0 is healthy. Unhealthy jobs appear in Decisions. `x` then `y` stops a job, and `D` then `y` deletes a stopped one.

**Child agents.** A top-level terminal session is a project lead: it gets the `delegate`, `children`, `steer_child`, `stop_child`, and `merge_child` tools, and the user talks only to it. `delegate` takes a brief (a one-sentence `goal`; `kind` `implement` or `read-only`; `scope` globs and targeted `acceptance` commands for `implement`; optional `non_goals`, `context`, `budget`, `model` with `model_reason`, `repo` as an absolute git repository path, and `from: C-<n>` to continue an earlier run) and returns at once. Without `repo`, an `implement` child runs `pi --mode rpc` in its own worktree at `<repo>/.pi/worktrees/child-C-<n>`, on `child/<lead-branch>/C-<n>`, from the lead's clean `HEAD`; a read-only child runs in the lead directory. With `repo`, the lead may be outside git: the child starts from that repository's clean `HEAD` (including its default branch), using `child/lead/<session-short-id>/C-<n>` for implementation or the repository top level for read-only work. `merge_child` merges these implementation runs into a `lead/<session-short-id>` branch, created on first use in an integration worktree at `<repo>/.pi/worktrees/lead-<session-short-id>`, and pushes that branch; the user's checkout and the default branch never change. The short id is the last 8 hex digits of the lead's session id. When a child finishes, the lead gets one message with the outcome, the child's summary, the diff against its budget, acceptance results (the lead runs them in the child's worktree), spend, and the branch. Guards inside children block repository-wide test runs, pushes, PRs, history rewrites, branch switches, dependency additions, and edits outside the scope. They warn at 80% of the diff budget and of the spending cap. Going past the diff budget stops edits (reaching it exactly is fine), and reaching the spending cap stops the run. Zero-cost gateway usage is calculated from `children.pricing`; without a matching price, spend is unknown and the cap is not enforced. `merge_child` merges a done child whose acceptance passed with `--no-ff`, removes its worktree and branch, pushes the lead branch without force, and creates a draft PR with the account the config maps to the repository's org. It never marks a PR ready, merges a PR, or touches the default branch. Children exit when their lead dies, and the lead's next start reports interrupted runs. The dashboard shows each live child's run, model, spend, and diff against budget, folds ended children into a count, and `x` then `y` stops a live child.

**Usage.** The tracker records local, content-free usage rows (actions, counts, and durations, never titles, notes, or commands), and keeps them for 180 days. `work usage [--days 30]` prints a Markdown summary: time in `needs-me`, triage outcomes, planner follow-through, and dashboard use. Set `"usage": false` in the config to turn recording off.

Data lives in `${XDG_DATA_HOME:-~/.local/share}/work/work.db` (SQLite, mode 0600) with rotating JSON Lines backups. Configuration lives in `${XDG_CONFIG_HOME:-~/.config}/work/config.json`:

```json
{
  "jira": { "site": "https://example.atlassian.net", "email": "user@example.com", "secret": { "command": ["pass", "show", "jira_api_key"] }, "defaultProject": "ABC" },
  "github": { "accounts": [{ "user": "work-account", "orgs": ["example-org"] }] },
  "projects": [{ "slug": "payments", "title": "Payments", "jiraEpic": "ABC-100" }],
  "rules": [{ "repo": "payments-api", "project": "payments" }],
  "planner": { "cwd": "~" },
  "usage": true,
  "notifications": true,
  "bashTimeoutMinutes": 30,
  "messaging": { "autoJoin": true, "sendsPerHour": 10, "paused": false, "retentionDays": 30, "routeCooldownMinutes": 10 },
  "children": {
    "defaultModel": "ai-gw-openai/openai/gpt-5.6-sol",
    "diffBudget": { "defaultLines": 300, "defaultFiles": 8, "maxLines": 800, "prLines": 2000 },
    "spendCapUsd": 5,
    "commandTimeoutMinutes": 10,
    "warnPercent": 80,
    "pricing": { "ai-gw-openai/openai/gpt-5.6-sol": { "input": 4, "output": 20 } },
    "repos": { "payments-api": { "ignore": ["**/generated/**"], "expensiveCommands": ["make e2e$"] } }
  }
}
```

Jira and GitHub are read on demand only, and cached for 10 minutes. Jira writes happen only after an explicit confirmation: promoting an item or applying a suggested status transition. GitHub is read-only, except that `merge_child` pushes the lead's branch and creates draft PRs. Secrets are read at call time and never stored. Every `gh` call runs with `DBUS_SESSION_BUS_ADDRESS=disabled:`, so `gh auth token` cannot start a D-Bus daemon that never exits. The work extension also sets it, when it is unset, for every command a session runs. The `messaging` keys are described under the messaging extension: `autoJoin` (default `true`), `sendsPerHour` (default 10), `paused` (`false`, `true`, or a list of session names or session-id prefixes), `retentionDays` (default 30), and `routeCooldownMinutes` (default 10). A `bash` call that sets no timeout gets `bashTimeoutMinutes` (default 30) in every session. Children keep their stricter `children.commandTimeoutMinutes`. `npm run work:smoke` runs read-only live connector checks.

### worktree-manager

`/worktree` opens a fuzzy picker for configured repositories and worktrees. `N` creates a Pi-managed worktree, `D` removes an eligible worktree after safety checks, Enter opens it in tmux, and Escape cancels. Managed worktrees live under `<repo>/.pi/worktrees/<name>` on `worktree-<name>` branches.

## Installation

Install the immutable signed release over SSH:

```bash
pi install git:git@github.com:dvdkrv/pi-tools.git@v0.5.0
```

Try it for one process without changing persistent package settings:

```bash
pi -e git:git@github.com:dvdkrv/pi-tools.git@v0.5.0
```

The separate Superpowers package is intentionally not bundled. Install its independently pinned release if desired.

## Messaging broker

Install NATS Server 2.14.6 using the platform package manager or upstream release. The first Pi session ensures an authenticated detached broker on loopback, and each top-level terminal session then joins the host group by itself.

To upgrade, settle active work, install the package, and start fresh Pi processes. Sessions still running an older release keep working in their own manual groups but do not join the host group.

Never copy broker credentials or data between users or machines.

## Messaging lifecycle

`/reload` and tree navigation suspend participation, and the same session resumes its member identity afterward. Quitting, `/new`, `/resume`, and fork leave the host group; the next session joins under its own identity. Crashed members are removed as soon as the session registry shows their process is gone, and in any case finalize 24 hours after their last heartbeat. Human revoke is immediately final. In manual groups, every departure suspends, and a human-confirmed takeover keeps the stable member ID, durable inbox, routes, history, and allowance while rotating the private lease to fence the old process.

The model sees identity and route metadata only through the static `peer_message` API. Its tool schema and prompt guidance do not change during a process; heartbeats and maintenance append no prompt traffic. Private leases, broker tokens, stored bodies, and hidden dynamic identity context are not exposed.

## Configuration

- `~/.pi/agent/worktree-manager.json`: `repoSearchRoots` used by task and worktree-manager.
- `~/.pi/agent/task.json`: optional `model` override for `/task` inference.
- `~/.pi/agent/messaging/`: private local broker configuration and retained data.

## Development

Requirements: Node.js 22.19 or newer, npm, and NATS Server 2.14.6 for mandatory messaging coverage.

```bash
npm ci --ignore-scripts
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER=/path/to/nats-server npm test
npm run typecheck
npm run check
```

Tests use disposable brokers and scripted providers. They must not access live messaging configuration, live groups, message bodies, allowance, sessions, or broker state. The suite performs no paid inference.

## Release policy

Releases use SSH-signed commits and signed annotated immutable tags. A broken release receives a new version; published tags are never moved or replaced.
