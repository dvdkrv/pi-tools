# Pi Tools

A single [Pi](https://github.com/earendil-works/pi-mono) package containing seven local-development extensions: `claude-skill`, `loop`, `messaging`, `task`, `theme-sync`, `work`, and `worktree-manager`.

## Security

Pi extensions execute with full system access. Review this repository and its pinned release before installation.

Messaging is local-first. It accepts only a token-authenticated loopback NATS endpoint and stores broker authority and JetStream data in owner-only paths. Loading the package may ensure that local infrastructure is ready, but it never joins a group, grants allowance, reads pending bodies, sends work, or invokes a model automatically.

The worktree, task, and Claude bridge commands can create processes, tmux sessions, branches, and worktrees. They are interactive commands and do not run merely because the package is loaded.

## Extensions

### claude-skill

`/claude-skill [skill-name] [arguments]` discovers Claude Code skills in project and user skill directories, presents a fuzzy picker when needed, and launches the selected skill in tmux. It requires `claude` and `tmux` in `PATH`.

### loop

`/loop start <prompt> [--max N]` starts an explicitly requested bounded prompt loop. `/loop status` reports state and `/loop stop` stops it. The model records exactly one final `loop_control` decision per iteration. The default is 12 total runs, the accepted range is 1–100, and known context use at or above 85% stops continuation. The extension provides cache-stable definitions without promising a provider cache-hit percentage.

### messaging

`/messages` provides human-controlled setup, joining, takeover, status, routes, allowance, inbox, recovery, and final leave/revoke operations. The model-facing `peer_message` tool can discover metadata and directional route modes, rename only itself, inspect bounded status, or queue an explicitly typed message inside a joined group. It cannot join, reopen routes, arm allowance, take over identities, or read stored bodies.

Every new message is a `notice`, `request`, or `reply`. A notice atomically closes the recipient-to-sender route, so its recipient cannot answer with a disguised fresh message. A request reserves two credits and grants its exact recipient one reply capability; the reply consumes that capability and closes both directions. Humans alone can reopen a route. Messages use stable member IDs rather than display names or transient session attribution.

Each admitted message consumes one finite shared credit. Queued delivery expires after one hour, attempted-unconfirmed delivery becomes terminal-unresolved after ten minutes without a refund, and a delivered request's reply capability expires after one hour. Terminal metadata and bodies are retained for seven days before maintenance pruning. Eligible messages are delivered as one ordered batch at an idle boundary; uncertain work is never automatically replayed.

Messaging requires NATS Server 2.14.6 in `PATH` (or `NATS_SERVER`) and uses a same-user loopback trust boundary. Participation, allowance, route recovery, identity takeover, and active-session reload remain explicit human decisions.

### task

`/task [--split] <request>` infers a target repository and task, shows a review UI, creates or reuses a Pi-managed worktree, and launches a fresh Pi tmux session. Repository discovery is configured in `~/.pi/agent/worktree-manager.json`, for example:

```json
{
  "repoSearchRoots": ["~/src/github.com/owner"]
}
```

Automatic cleanup removes only clean Pi-managed worktrees and preserves their branches. Dirty worktrees are retained.

### theme-sync

`theme-sync` follows `light` or `dark` appearance stored in `${XDG_STATE_HOME:-~/.local/state}/theme`, falling back to `LC_TERMINAL_THEME` and then dark. It switches only Pi's built-in `light` and `dark` themes, fences watcher startup, and removes watchers on reload or shutdown.

### work

A local work tracker for one person: one list of projects and items, a triage inbox, and a daily planner.

- `/todo <text> [#project] [due:<date>]` captures an item instantly. The project comes from `#project` or from rules for the current repository.
- `work_propose` lets agents propose follow-ups. Proposals only enter the triage inbox, with at most five pending per session.
- `/triage` reviews candidates from Jira (tickets assigned to you), GitHub (direct review requests and your own PRs; team review requests are excluded), and agents: accept, merge, dismiss, snooze, bulk accept, or accept and promote to Jira.
- `/today` syncs, triages, and opens a `today` tmux window running a fresh `plan-YYYY-MM-DD` Pi session with read-only snapshot tools and local-only update tools.

`work_propose`, `job_register`, and the lead tools below have `deferred` exposure: the model loads them with Pi's `tool_search` tool when it needs them, and a top-level terminal session activates `tool_search` for that. `session_status` stays declared directly. `children` is marked read-only, and `stop_child` and `merge_child` destructive.

The same features are available from the shell through `bin/work.ts` (`add`, `list`, `show`, `set`, `project`, `sync`, `triage`, `today`, `promote`, `undismiss`, `recap`, `restore`, `dash`, `job`, `usage`, `export`, `import`). For example, use `alias work='node <package>/bin/work.ts'` and `alias todo='work add'`. Aliases do not reach tmux popups or hooks, so bindings should call a small `work` wrapper script on `PATH` instead.

**Sessions.** Pi sessions register themselves in the work database automatically: their pane, window, file, and status. A run marks it `working`. When the full run settles, after any retries or compaction, it becomes `needs-me` with the last line of the reply as its note, unless the agent called the static `session_status` tool to declare `needs-me`, `waiting-external`, or `done` with a note. A top-level TUI session that settles as `needs-me` also sends an OSC 777 desktop notification, except when its pane is active in an attached tmux client; set `"notifications": false` to disable these. Sessions link to items automatically from `PI_WORK_ITEM` (set by `/task` when the request names an item), from PR head branches and Jira keys in the branch name, or from another session in the same worktree. Terminal sessions always register as top-level sessions, with no pane when they run outside tmux. `rpc` sessions register as headless. `print` and `json` runs register only as child agents, when `PI_WORK_PARENT_SESSION` names their parent. Children appear only under their parent.

**Dashboard.** `/dash` (or `work dash` in a terminal) opens a full-screen dashboard that leads with Decisions: sessions waiting on you, oldest first. A session that has never had a turn is `idle`, not waiting on you, and is listed under Other sessions. Pending triage joins Decisions only with `"dashboard": { "showTriage": true }` in the config. Waiting, Working, and Other sessions follow. Other sessions lists the last 24 hours and folds older ones into one `+N older` row; a `/` filter searches those too. A row is named after its tmux window, or after its repository (then its directory) when the window has a default name (`pi`, `zsh`, `bash`). Notes are shown without Markdown. Keys are vim-style (`j`/`k`, `gg`/`G`, `Ctrl-d`/`Ctrl-u`, `Tab`, `/` to filter, `?` for help). `Enter` jumps to a session's pane and closes the popup, reopens a crashed or closed session, opens triage, or shows a child's read-only transcript. `L` links a session to an item, `x` then `y` stops a child agent, and `D` then `y` deletes a closed record. A tmux binding such as `bind g display-popup -E -w 90% -h 90% 'work dash'` needs the wrapper script mentioned above.

**Restore.** After a reboot, `work restore --auto` (for example from `@resurrect-hook-post-restore-all`) reopens crashed terminal sessions that ran in tmux, from the last 7 days, and are not `done`. It types `pi --session <file>` into a matching restored shell pane, splits the window, or opens a new window. It runs at most once per boot, and the dashboard runs the same logic when it opens. `work restore --dry-run` prints the plan.

**Jobs.** Agents register background jobs they start with the `job_register` tool (a cron entry or a process, with an optional `check_command`, `stop_command`, and log path). Users register them with `work job add --name <n> --kind cron|process [--check <cmd>] [--stop <cmd>] …`. There is no approval step. Instead, every job records the session that registered it, and the dashboard's details view shows the exact commands. Checks run only when you look: when the dashboard opens (for checks older than 60 seconds), on `c`, or with `work job check [J-n]`. Each check runs `/bin/sh -c` in the job's directory with a 15-second timeout, at most 4 at a time. Exit 0 is healthy. Unhealthy jobs appear in Decisions. `x` then `y` stops a job, and `D` then `y` deletes a stopped one.

**Child agents.** A top-level terminal session is a project lead: it gets the `delegate`, `children`, `steer_child`, `stop_child`, and `merge_child` tools, and the user talks only to it. `delegate` takes a brief (a one-sentence `goal`; `kind` `implement` or `read-only`; `scope` globs and targeted `acceptance` commands for `implement`; optional `non_goals`, `context`, `budget`, `model` with `model_reason`, and `from: C-<n>` to continue an earlier run) and returns at once. An `implement` child runs `pi --mode rpc` in its own worktree at `<repo>/.pi/worktrees/child-C-<n>`, on `child/<lead-branch>/C-<n>`, from the lead's clean `HEAD`. A `read-only` child runs in the lead's directory without `edit` and `write`. When a child finishes, the lead gets one message with the outcome, the child's summary, the diff against its budget, acceptance results (the lead runs them in the child's worktree), spend, and the branch. Guards inside children block repository-wide test runs, pushes, PRs, history rewrites, branch switches, dependency additions, and edits outside the scope. They warn at 80% of the diff budget and of the spending cap. Going past the diff budget stops edits (reaching it exactly is fine), and reaching the spending cap stops the run. Zero-cost gateway usage is calculated from `children.pricing`; without a matching price, spend is unknown and the cap is not enforced. `merge_child` merges a done child whose acceptance passed with `--no-ff`, removes its worktree and branch, pushes the lead branch without force, and creates a draft PR with the account the config maps to the repository's org. It never marks a PR ready, merges a PR, or touches the default branch. Children exit when their lead dies, and the lead's next start reports interrupted runs. The dashboard shows each live child's run, model, spend, and diff against budget, folds ended children into a count, and `x` then `y` stops a live child.

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

Jira and GitHub are read on demand only, and cached for 10 minutes. Jira writes happen only after an explicit confirmation: promoting an item or applying a suggested status transition. GitHub is read-only, except that `merge_child` pushes the lead's branch and creates draft PRs. Secrets are read at call time and never stored. Every `gh` call runs with `DBUS_SESSION_BUS_ADDRESS=disabled:`, so `gh auth token` cannot start a D-Bus daemon that never exits. The work extension also sets it, when it is unset, for every command a session runs. A `bash` call that sets no timeout gets `bashTimeoutMinutes` (default 30) in every session. Children keep their stricter `children.commandTimeoutMinutes`. `npm run work:smoke` runs read-only live connector checks.

### worktree-manager

`/worktree` opens a fuzzy picker for configured repositories and worktrees. `N` creates a Pi-managed worktree, `D` removes an eligible worktree after safety checks, Enter opens it in tmux, and Escape cancels. Managed worktrees live under `<repo>/.pi/worktrees/<name>` on `worktree-<name>` branches.

## Installation

Install the immutable signed release over SSH:

```bash
pi install git:git@github.com:dvdkrv/pi-tools.git@v0.1.1
```

Try it for one process without changing persistent package settings:

```bash
pi -e git:git@github.com:dvdkrv/pi-tools.git@v0.1.1
```

The separate Superpowers package is intentionally not bundled. Install its independently pinned release if desired.

## Messaging broker

Install NATS Server 2.14.6 using the platform package manager or upstream release. The first Pi session can ensure an authenticated detached broker on loopback. Infrastructure startup does not opt the session into messaging.

A safe first-time or upgrade flow is:

1. settle active work and close older messaging-enabled Pi processes;
2. install the package at a human-controlled idle boundary;
3. start a fresh Pi process;
4. explicitly run `/messages join <group>`;
5. confirm or select the intended saved identity;
6. inspect status and routes; finalized historical identities are hidden from normal member lists.

Never copy broker credentials or data between users or machines.

## Messaging lifecycle

Reload, shutdown, session replacement, fork, and tree navigation suspend participation by default. Suspended or crashed members remain resumable for 24 hours and then finalize automatically on the next maintenance opportunity. Explicit `/messages leave` and human revoke are immediately final. A human-confirmed new-session takeover keeps the stable member ID, role, durable inbox, routes, history, and allowance while rotating the private lease to fence the old process.

Ledger v3 migration is forward-only and runs when a human next opens messaging, not merely when the broker starts. Apply a compatible signed release and reload Pi only at a human-controlled idle boundary.

The model sees identity and route metadata only through the static `peer_message` API. Its tool schema and prompt guidance do not change during a process; heartbeats and maintenance append no prompt traffic. Private leases, broker tokens, stored bodies, and hidden dynamic identity context are not exposed.

## Configuration

- `~/.pi/agent/worktree-manager.json`: `repoSearchRoots` used by task and worktree-manager.
- `~/.pi/agent/task.json`: optional `model` override for `/task` inference.
- `~/.pi/agent/messaging/`: private local broker configuration and retained data.
- `${XDG_STATE_HOME:-~/.local/state}/theme`: terminal appearance state for theme-sync.

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
