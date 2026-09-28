# Work Sessions, Jobs, and Dashboard Design

**Date:** 2026-09-25  
**Repository:** `dvdkrv/pi-tools`  
**Status:** Approved design, pending implementation plan  
**Builds on:** `2026-09-25-work-tracker-design.md` (project 1, shipped in v0.2.1)

## Purpose

Let the user see, from anywhere, what needs a decision, what is waiting on someone else, what is running, and which background jobs are healthy, without keeping any of that in their head. Crash recovery and session bookkeeping happen without commands.

### Guiding principle

The user wants to spend their attention on design and implementation decisions, not on task management. Every mechanism here defaults to automatic behavior, and manual actions exist only as overrides. A feature that needs the user to remember a command, link a record, or confirm routine bookkeeping is a design defect. The only confirmations are keystroke guards on destructive actions: stopping a job or removing a record.

### Program update

The workflow program is reordered:

1. Work tracker. Shipped.
2. **Sessions, jobs, and dashboard.** This document.
3. **Coordinator**, previously project 4. An agent owns task management: triage, linking, filing, Jira updates with undo, and preparing the daily plan. It brings the user only decisions. It is also where subagent use is redesigned.
4. Hygiene, previously project 3.

Until the coordinator exists, project 1's triage and Jira confirmations remain as the safety net.

## Scope

In scope:

- An automatic session registry, and agent-declared session status.
- Automatic session-to-item linking.
- Automatic restore of crashed sessions.
- A job registry with health checks.
- A dashboard that opens in a tmux popup, leads with decisions, and uses vim keys.
- A shared vim keymap, also adopted by `/triage`.
- Local usage tracking to guide later changes.

Not in scope:

- Park, wrap-up, or handoff workflows. Closing a session means closing its pane.
- Launching or resuming sessions from the planner.
- Automating triage and Jira updates. That is the coordinator.
- Discovering unregistered cron entries or processes.

## Data Model

A new migration adds three tables to `work.db`, plus a `session` link kind.

### `session`

| Field | Notes |
| --- | --- |
| `id` | The Pi session ID. Primary key. |
| `file` | The session file path, used for reopening. |
| `cwd`, `name` | Working directory and display name. |
| `pid` | Process ID of the running Pi process. |
| `tmux_pane`, `tmux_window` | Pane ID (`%12`) and window name, refreshed at each turn end. Null outside tmux. |
| `started_at`, `last_turn_at`, `ended_at` | `ended_at` is set only by a clean shutdown. |
| `status` | `working`, `needs-me`, `waiting-external`, or `done`. |
| `note` | Up to 200 characters: the question, the reason, or the summary. |
| `status_source` | `agent` when set through `session_status`, `auto` otherwise. |
| `status_at` | When the status last changed. Used for "time in needs-me". |
| `restored_from` | For a session reopened by restore: the previous PID. Informational. |

The session-to-item link reuses `link` with kind `session` and key `session:<id>`.

Session rows are operational: status changes write no `event` rows. Linking a session to an item is a domain mutation and writes an event, as all links do.

### `job`

| Field | Notes |
| --- | --- |
| `id` | `J-<n>`. |
| `name` | Unique among jobs that aren't stopped. |
| `kind` | `cron` or `process`. |
| `owner_session`, `item_id` | Optional. Filled in from the registering session and its linked item. |
| `schedule` | A cron expression, for display only. |
| `pid` | For `process` jobs. |
| `cwd` | Where commands run. |
| `check_command`, `stop_command` | Shell commands. Either may be null. |
| `log_path` | Optional. |
| `last_check_at`, `last_check_status`, `last_check_output` | `healthy`, `unhealthy`, or `unknown`, plus the first line of output, at most 200 characters. |
| `created_at`, `updated_at`, `stopped_at` | Timestamps. |

Registering, updating, stopping, and deleting jobs are domain mutations and write events. Check results are operational.

### `usage`

`id`, `at`, `surface` (`dash`, `cli`, `pi`, `triage`, or `planner`), `action`, and `context`, which is a small JSON object of numbers and enums only. It never contains titles, notes, commands, or other content.

## Session Registry

The existing `work` extension adds these hooks:

| Pi event | Effect |
| --- | --- |
| `session_start` | Create or update the row: `pid = process.pid`, `tmux_pane = $TMUX_PANE`, the window name from `tmux display -p -t $TMUX_PANE '#W'`, the file, cwd, name, `started_at`, and cleared `ended_at`. A new row starts as `needs-me` (`auto`) with the note "new session". An existing row (a resumed, reopened, or restored session) keeps its status and note, so a reboot does not flood Decisions. Then run linking. |
| A user message is submitted, or a turn starts | Status `working` (`auto`). |
| `session_status` called during the turn | Record the declared status and note. The turn-end fallback does not override it. |
| Turn ends | If no declaration was made in this turn, status `needs-me` (`auto`). Set `last_turn_at`, refresh the window name, and run linking. |
| `session_shutdown` | Set `ended_at`. |

### `session_status` tool

The tool is static and registered in every session:

- **Parameters:** `status`, one of `needs-me`, `waiting-external`, or `done`; and `note`, a required string of 1 to 200 characters.
- **Description:** "Declare this session's state as your final action in a turn: `needs-me` when you are asking the user a question or need a decision (note: the question), `waiting-external` when blocked on CI, review, a deploy, or another person (note: what and why), `done` when the task is complete (note: one-line outcome). Call at most once per turn."
- **Limits:** if the tool is called more than once in a turn, the last call wins.

### Liveness

Liveness is computed when read and never stored:

| Condition | State |
| --- | --- |
| `pid` alive, and the pane exists or there is no tmux | **live** |
| `ended_at` set | **closed** |
| `pid` not alive and `ended_at` null | **crashed** |

"`pid` alive" means `process.kill(pid, 0)` succeeds and `/proc/<pid>/environ` contains the session's `TMUX_PANE`, when known. That guards against PID reuse after a reboot.

### Automatic linking

Linking runs at session start and at each turn end, until the session is linked. The first match wins:

1. **Started for an item.** The session was launched with `PI_WORK_ITEM=W-n` in its environment. Launchers that start sessions for an item set this.
2. **Branch evidence.** The session's git branch is `git branch --show-current` in its cwd. If it is the head branch of a PR linked to an item, or contains a Jira key linked to an item, link to that item.
3. **Worktree evidence.** Another session in the same worktree path is already linked, so link to the same item.

A match links automatically, with no suggestion step. Nothing is linked when evidence is ambiguous, meaning it points at more than one item. The dashboard's `L` key overrides a link or sets one manually. A manual link is never replaced by inference.

`/task` from `pi-tools` sets `PI_WORK_ITEM` when its request text mentions an item ID. Having `/task` create items belongs to the coordinator project.

## Automatic Restore

After a reboot, tmux-resurrect restores windows (names and working directories) with shells, but not Pi processes. Restore finishes the job.

- **Trigger:** the dotfiles set `@resurrect-hook-post-restore-all` to `work restore --auto`. The dashboard also runs the same logic when it opens and finds crashed sessions that no restore attempt has handled since the last boot.
- **Selection:** sessions that are crashed, whose status is not `done`, and whose `last_turn_at` (or `started_at`) is within the last 7 days.
- **Placement:** for each selected session:
  1. If a pane exists whose window name and current path match the session's `tmux_window` and `cwd`, and it is running only a shell, send `pi --session <file>` to that pane.
  2. Otherwise, if a window with that name exists, split it and run the command there.
  3. Otherwise, create a window with that name in `cwd`.

  Sessions that shared a window before the crash therefore return as panes of one window.
- **Idempotency:** each attempt is recorded in `meta` as `restore:boot:<boot-id>`, using `/proc/sys/kernel/random/boot_id`. `--auto` does nothing if that boot was already handled. The reopened session's `session_start` hook overwrites `pid` and `tmux_pane`, which makes it live again.
- **Manual commands:** `work restore --dry-run` prints the plan. `work restore` without `--auto` ignores the boot marker. These exist for debugging, and routine use needs neither.

## Jobs

### Registration

- **Agents:** the static `job_register` tool takes `name`, `kind`, and `cwd`, plus the optional `schedule`, `pid`, `check_command`, `stop_command`, `log_path`, and `relates_to`. Owner and item are filled in from the calling session. Registering again with the same name updates the job in place.
- **Users:** `work job add --name … --kind … [--schedule …] [--check …] [--stop …] [--log …] [--item W-n]`.
- **No approval step.** An agent able to register a job can already run arbitrary commands and install cron entries as the same user, so an approval gate adds friction without a security boundary. Traceability replaces it: every job records its registering session, and the details view shows the exact commands.

### Health checks

- **Running a check:** `/bin/sh -c "<check_command>"` in `cwd`, with no stdin, a 15-second timeout, and a process-group kill on timeout. Output is capped at 64 KB and summarized to the first line of 200 characters or fewer.
- **Results:** exit 0 is `healthy`. Any other exit is `unhealthy`. A timeout or spawn failure is `unknown`, with the error as output.
- **When checks run:** when the dashboard opens, for jobs whose last check is older than 60 seconds; on `c` in the dashboard; and on `work job check [J-n]`. At most 4 run at once. There is no background process.
- **Jobs without a check:** a `process` job is `healthy` while its `pid` is alive and `unhealthy` otherwise. A `cron` job without a check stays `unknown`.
- **Planner:** the snapshot includes each job's last known status and when it was checked. Building the snapshot never runs checks.

### Stopping and deleting

- **`x` in the dashboard, then `y`:** runs `stop_command`, or sends `SIGTERM` to `pid` for a process job that has none, then records `stopped_at`.
- **`D`, then `y`:** deletes a stopped job, or a closed or crashed session row.
- **`y` guards:** these guards protect against accidental keystrokes. They are not an approval of the job.

## Dashboard

### Opening

- `work dash` runs full screen in the terminal.
- The dotfiles bind `prefix D` to `display-popup -E -w 90% -h 90% 'work dash'`.
- `/dash` in Pi opens the same popup.
- Outside tmux, `work dash` runs inline, and jump actions print the equivalent tmux command.

The dashboard is a standalone Node program with a small built-in renderer (alternate screen, raw input, ANSI styling). It has no dependency on Pi packages, so it opens quickly from the popup.

### Layout

Sections are stacked vertically, each with a count. Empty sections collapse to one line.

1. **Decisions:** live sessions in `needs-me`, sorted by longest waiting, each showing the window, item, how long it has waited, and the note. It also contains one line for pending triage candidates, and one line per `unhealthy` job.
2. **Waiting:** live sessions in `waiting-external`, with the note and duration.
3. **Working:** live sessions in `working`.
4. **Jobs:** every job that isn't stopped, showing health, name, schedule, last check age, and summary. Stopped jobs are dimmed at the end.
5. **Other sessions:** live `done` sessions, then closed and crashed sessions from the last 7 days.

Example row: `needs-me  sap-rfc  W-7  12m  "Trim the overview to 1.5k words?"`

### Keys

All navigation comes from the shared keymap:

| Key | Action |
| --- | --- |
| `j` / `k` | Down / up |
| `gg` / `G` | First / last row |
| `Ctrl-d` / `Ctrl-u` | Half page down / up |
| `Tab` / `Shift-Tab`, `]` / `[` | Next / previous section |
| `/`, then `n` / `N` | Filter as you type, then next / previous match. `Esc` clears the filter. |
| `Enter` | Session: jump to its pane (`switch-client` and `select-pane`) and close the popup. Crashed or closed session: reopen it using the restore placement rules, then jump. Triage line: open the dashboard's triage view. That view uses the same `triage.ts` actions and keymap as `/triage` in Pi, and is rendered by the dashboard's own renderer. Job: show details, including commands, owner, item, and last output. |
| `L` | Link the session to an item, using a fuzzy picker over open items |
| `c` | Check the job now |
| `x`, then `y` | Stop the job |
| `D`, then `y` | Delete a stopped job or a closed or crashed session |
| `R` | Refresh (re-read the registry and re-run stale checks) |
| `?` | Help overlay |
| `q` / `Esc` | Close |

### Shared keymap and triage

`src/work/keymap.ts` turns raw key sequences into actions, including the pending `g` for `gg` and pending `y` confirmations. It is a pure function, used by the dashboard and by `/triage`. `/triage` changes from arrow keys to `j`, `k`, `gg`, `G`, `Ctrl-d`, and `Ctrl-u`, with `Enter` for details. Its action letters (`a`, `m`, `d`, `z`, `A`, `p`) are unchanged. Arrow keys stay as aliases.

## Usage Tracking

- **What is recorded:** every dashboard key action, CLI command, Pi command (`/todo`, `/triage`, `/today`, `/dash`), triage outcome, planner save, and restore run appends a `usage` row.
- **What is derived:**
  - Time in `needs-me`: `status_at` until the next user message in that session, recorded as a `session.responded` usage row with the duration.
  - Triage outcomes by source and action.
  - Planner follow-through: the share of yesterday's focus items with an event, or `done`, by the next plan.
  - Dashboard opens per day, jump rate, and features unused in the window.
- **Reporting:** `work usage [--days 30]` prints a Markdown summary of those measures. An agent revising the tool reads this summary, not the raw table.
- **Retention:** rows older than 180 days are deleted during sync. `"usage": false` in the config disables recording.
- **Privacy:** data stays local. No content is recorded.

## Failure Semantics

| Failure | Behavior |
| --- | --- |
| Registry write fails (locked, corrupt, newer schema) | The Pi session continues. The extension warns once per session and stops recording for that session. |
| tmux unavailable | Pane fields are null. The dashboard runs inline, and jumps print commands. |
| Branch lookup fails | Linking is skipped for that attempt. |
| Check spawn failure or timeout | `unknown`, with the error summary. Other checks are unaffected. |
| Stop command fails | The job is not marked stopped. The error is shown. |
| Restore finds no shell pane or window | A new window is created. |
| Restore target session file missing | The session is skipped and reported. The row is kept. |
| Boot ID unreadable | `--auto` falls back to "not restored in the last 10 minutes". |

## Verification Strategy

The tests use `node --test` under `tests/work/`:

- **Registry hooks:** a fake Pi event stream checks status transitions, declaration precedence over the turn-end fallback, window name refresh, and `ended_at` on clean shutdown.
- **Liveness:** injected PID and `/proc` readers cover live, closed, crashed, and PID reuse.
- **Linking:** environment, PR head branch, Jira key in branch, shared worktree, ambiguity (no link), and a manual link not being overwritten.
- **Restore planning:** a pure function from sessions plus a tmux window and pane listing to commands. It covers shell pane reuse, splitting, new windows, grouping, the 7-day and `done` exclusions, and boot idempotency.
- **Job checks:** exit codes, timeout with a process-group kill, the output cap and summary, concurrency limit 4, the 60-second staleness rule, and process jobs without checks.
- **Keymap:** a table of key sequences to actions, including `gg`, `y` confirmations, and filter mode. The same table is exercised by triage.
- **Renderer:** snapshot tests of dashboard frames at 80 and 160 columns.
- **Usage:** recording from each surface, the summary from fixture rows, retention, and disabling.
- **Real tmux:** an integration test on an isolated server (`tmux -L work-test`) covers jumping, restoring into a shell pane, and splitting.

The release gates are `npm test`, `npm run typecheck`, and `npm run check`.

## Dotfiles Changes

These belong to the user's dotfiles repository and are applied after release:

- `bind D display-popup -E -w 90% -h 90% 'work dash'`.
- `set -g @resurrect-hook-post-restore-all 'work restore --auto'`.
- Bump the `pi-tools` tag.
