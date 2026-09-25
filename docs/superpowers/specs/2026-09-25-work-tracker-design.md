# Work Tracker Design

**Date:** 2026-09-25  
**Repository:** `dvdkrv/pi-tools`  
**Status:** Approved design, pending implementation plan

## Purpose

Give one person a single, trustworthy list of their work, and a daily planning flow in Pi that turns that list into a short, reasoned plan.

Work currently arrives from many places: tracker tickets (Jira), code review and CI (GitHub), alerts, chat, meetings, the user's own ideas, and follow-ups discovered by agent sessions. Deciding what to work on requires checking all of them by hand. The tracker brings every candidate into one place, keeps a light link to Jira for significant work, and lets the planner explain its suggestions using recorded evidence.

This is the first of four projects in a workflow program:

1. **Work tracker** (this document): the single list, capture, triage, sync, and daily planning.
2. **Session lifecycle and attention view**: sessions belong to items and have statuses such as `needs-me`, `working`, `parked`, and `done`; parking and wrap-up write handoffs; crash restore reads the tracker.
3. **Hygiene**: retire worktrees and sessions whose items are done.
4. **Orchestration**: a coordinator dispatches bounded, short-lived task sessions from tracker items, and subagent use is redesigned.

Later projects build on this data model. This document covers only project 1.

## Decisions

| Topic | Decision |
| --- | --- |
| Planning surface | Pi and terminal on the development host. The personal notes app stays personal; it receives only a pasted recap. |
| Planning style | The planner proposes a short plan with reasons. The user accepts, reorders, or drops items. Launching sessions from the plan is deferred to project 2. |
| Organization | Two levels: projects, then items. A catch-all `misc` project always exists. |
| Capture | Manual capture creates items directly. Connector observations and agent proposals enter a triage inbox. |
| Jira relationship | The local list is the superset; significant items also live in Jira. Read tickets assigned to the user, promote local items to tickets, and propose status updates that the user confirms. |
| Jira scope | `assignee = currentUser() AND statusCategory != Done`, plus the current state of already-linked tickets. |
| Storage | A local SQLite database, with a `work` CLI and a Pi extension. |
| Project and duplicate hints in triage | Fixed rules, not the model. |

## Non-goals

- A session or worktree connector, or launching and resuming sessions from a plan (project 2).
- Cleanup of worktrees or sessions (project 3).
- Multi-agent orchestration (project 4).
- Chat ingestion. Chat items are captured by pasting a link or text.
- A background sync daemon.
- Two-way Jira sync, comments, reassignment, or field edits beyond promotion and status transitions.
- Priority numbers, estimates, or nested subtasks.
- Syncing with the personal notes app.

## Architecture

```
               ┌──────────────┐
  todo / /todo │   capture    │──────────────┐
               └──────────────┘              ▼
┌───────────┐  observations  ┌──────────────────┐     ┌─────────────┐
│ connectors│───────────────▶│  reconciliation  │────▶│   store     │
│ jira, gh  │                └──────────────────┘     │ (SQLite)    │
└───────────┘                        ▲                └─────────────┘
       work_propose (agents) ────────┘                  ▲    ▲    ▲
                                          triage UI ────┘    │    │
                                 planner tools (/today) ─────┘    │
                                     recap / export / import ─────┘
```

All logic lives in `src/work/`, as pure or narrowly effectful modules. Two thin entry points use it:

- `extensions/work.ts`: Pi commands (`/todo`, `/triage`, `/today`) and tools (`work_propose`, plus the planner tools).
- `bin/work.ts`: the `work` CLI (`add`, `sync`, `triage`, `today`, `promote`, `recap`, `export`, `import`, `list`, `show`, `set`). Putting it on `PATH`, for example with a `todo` alias for `work add`, belongs to the user's dotfiles.

Proposed module layout:

| Module | Responsibility |
| --- | --- |
| `src/work/store.ts` | Opens the database (WAL mode, busy timeout), runs migrations, and provides typed queries and mutations. Every mutation writes an `event`. |
| `src/work/migrations.ts` | Ordered, numbered schema migrations. |
| `src/work/config.ts` | Loads and validates the configuration file. |
| `src/work/capture.ts` | Parses the `todo` syntax (`#project`, `due:`, URLs) and detects link kinds. |
| `src/work/rules.ts` | Project mapping rules and duplicate detection. |
| `src/work/reconcile.ts` | Turns observations into link updates, signals, and candidates. |
| `src/work/connectors/jira.ts` | Jira REST reads, promotion, and transitions. |
| `src/work/connectors/github.ts` | GitHub reads through `gh`, with a token chosen per organization. |
| `src/work/triage.ts` | Triage actions: accept, merge, dismiss, snooze, and bulk accept. |
| `src/work/triage-ui.ts` | The terminal triage view. |
| `src/work/snapshot.ts` | Builds the compact planner snapshot. |
| `src/work/recap.ts` | Renders a Markdown recap from events. |
| `src/work/backup.ts` | JSON Lines export and import, with rotation. |

Node's built-in `node:sqlite` is used, so no new dependency is needed.

## Data Model

All timestamps are UTC ISO-8601 strings. IDs are stable and never recycled.

### `project`

| Field | Notes |
| --- | --- |
| `slug` | Primary key, lowercase kebab-case, for example `payments`. `misc` always exists. |
| `title` | Display name. |
| `status` | `active`, `parked`, or `archived`. |
| `jira_epic` | Optional epic key, used for promotion and mapping. |
| `notes_path` | Optional path to the project's knowledge-base hub. |

### `item`

| Field | Notes |
| --- | --- |
| `id` | `W-<n>`, assigned sequentially. |
| `project` | Foreign key to `project.slug`. |
| `title`, `notes` | Free text. |
| `status` | `todo`, `doing`, `waiting`, `parked`, `done`, or `dropped`. |
| `waiting_on` | Required when `status = waiting`: `review`, `ci`, `person`, or `external`. |
| `waiting_reason`, `waiting_since` | Short text and a timestamp, set when an item enters `waiting`. |
| `due` | Optional date. |
| `pinned` | Boolean. A pinned item is included in today's focus regardless of the planner's suggestion. |
| `origin` | `manual`, `jira`, `github`, or `agent`. |
| `created_at`, `updated_at` | Timestamps. |

When an item leaves `waiting`, the `waiting_*` fields are cleared. The history is kept in `event`.

### `link`

| Field | Notes |
| --- | --- |
| `id` | Integer primary key. |
| `item_id` | Foreign key to `item`. |
| `kind` | `jira`, `github-pr`, `github-issue`, `chat`, `note`, or `url`. Project 2 adds `session` and `worktree`. |
| `key` | Normalized dedupe key, for example `jira:ABC-123` or `github:pr:owner/repo#42`. Unique across all links. |
| `url` | Canonical URL. |
| `state` | Cached JSON, for example PR `open`/`merged`/`closed`, check status, review state, or Jira status and category. |
| `state_at` | Timestamp of the last observation. |

### `signal`

A meaningful change observed on a linked key: `pr-merged`, `pr-closed`, `review-received`, `comments-new`, `checks-failing`, `checks-passing`, `jira-status-changed`, or `jira-unassigned`. Fields: `item_id`, `link_id`, `kind`, `detail`, `observed_at`, and `seen_in_plan`, which is set when a saved plan includes the signal. Signals are the evidence the planner cites.

### `candidate`

| Field | Notes |
| --- | --- |
| `id` | Integer primary key. |
| `kind` | `new-item`, `attach-link`, or `jira-update`. |
| `source` | `jira`, `github`, or `agent`. |
| `dedupe_key` | Unique among pending candidates. |
| `title`, `reason`, `evidence` | Text, stored and displayed as data. |
| `proposed_project` | From the rules, or from the proposing agent. |
| `relates_to` | Optional item ID. |
| `payload` | JSON: link data for `attach-link`, the target ticket and status category for `jira-update`. |
| `proposer` | For agent candidates: the session ID and repository. |
| `state` | `pending`, `accepted`, `merged`, `dismissed`, `snoozed`, or `withdrawn`. |
| `snooze_until` | Timestamp, set when snoozed. |
| `created_at`, `resolved_at` | Timestamps. |

### `dismissal`

A durable set of dismissed dedupe keys (`key`, `dismissed_at`). Reconciliation never recreates a candidate for a dismissed key. A dismissal can be removed with `work undismiss <key>`.

### `plan`

`date` (primary key), `item_ids` (an ordered JSON array for focus), `quick_actions` (a JSON array of text or item IDs), `notes`, and `saved_at`.

### `event`

Append-only: `id`, `at`, `actor` (`user`, `agent:<session-id>`, `sync:<connector>`, or `planner`), `entity` (`item:W-42`, `candidate:17`, and so on), `action`, and `data` (JSON before and after, or detail). Events are never updated or deleted. Every mutation in `store.ts` writes its event in the same transaction.

## Configuration

`~/.config/work/config.json`. It is private, managed outside this repository, and validated on load. Illustrative shape:

```json
{
  "jira": {
    "site": "https://example.atlassian.net",
    "email": "user@example.com",
    "secret": { "command": ["pass", "show", "jira_api_key"] },
    "defaultProject": "ABC",
    "defaultIssueType": "Task"
  },
  "github": {
    "accounts": [
      { "user": "work-account", "orgs": ["example-org"] },
      { "user": "other-account", "orgs": ["other-org"] }
    ]
  },
  "projects": [
    { "slug": "payments", "title": "Payments", "jiraEpic": "ABC-100", "notesPath": "~/notes/projects/payments" }
  ],
  "rules": [
    { "repo": "payments-api", "project": "payments" },
    { "jiraEpic": "ABC-100", "project": "payments" },
    { "jiraProject": "OPS", "project": "misc" }
  ]
}
```

Projects listed in the configuration are created or updated on load. Projects can also be created from triage or the CLI. When the configuration is missing or invalid, capture and planning still work, a warning explains which connectors are disabled, and nothing is guessed.

## Connectors and Sync

A connector returns observations `{ key, kind, url, title, state, observedAt, meta }` and never writes to the store.

**Jira** runs two queries:

- assigned-open: `assignee = currentUser() AND statusCategory != Done`
- linked-state: the current status of every ticket linked to an item that isn't `done` or `dropped`, in batches

The API secret is obtained by running the configured command at call time. It is passed only in the request headers of that process, never written to disk, the store, events, backups, or logs, and redacted from error messages.

**GitHub** uses `gh`, with the configured account's token obtained per call (`gh auth token --user <user>`) and passed as `GH_TOKEN` to that one invocation. The global `gh` login is never switched. It collects:

- open PRs where the user's review is requested
- the user's own open PRs: reviews and comments since the previous observation, check conclusion, and merged or closed state
- the state of every PR linked to an active item

**Reconciliation** takes a connector's complete result set and applies these rules:

1. **Known key** (it matches `link.key`): update `state` and `state_at`. Compare with the previous state and record a `signal` for each meaningful change. If a linked PR merged while its item's linked Jira ticket is not in the Done category, create a `jira-update` candidate unless one is already pending for that ticket.
2. **Unknown key** that isn't dismissed and has no pending candidate: create a `new-item` candidate (review requests, newly assigned tickets). If the rules find an item sharing a related URL or ticket, create an `attach-link` candidate with `relates_to` instead.
3. **Disappeared key**, meaning a pending candidate whose key is absent from a complete result set from the same connector and query: mark it `withdrawn`. Links and items are never changed because something disappeared.
4. Only a result set the connector reports as complete can withdraw candidates. A partial or failed run changes nothing except recording the failure.

**Sync timing:** `work sync` or the first step of `/today`. Results are cached per connector for 10 minutes. `--force` bypasses the cache. There is no background process.

**Failure:** connectors run independently. Each run records `ok`, `auth-failed`, `unreachable`, or `error`, with a timestamp. `/today` and `work sync` report `⚠️ <connector>: <status>; data as of <last-ok>`. A failed connector never mutates items, links, or candidates.

## Capture

`/todo <text>` in Pi and `work add <text>` in the shell use one parser:

- `#<slug>` sets the project. An unknown slug is refused, with a suggestion.
- `due:<value>` accepts `YYYY-MM-DD`, `today`, `tomorrow`, or a weekday name, meaning its next occurrence.
- Each URL becomes a link, with its kind detected: tracker, PR, issue, chat, note, or URL. The URL is removed from the title only when the remaining text is non-empty.
- Without `#`, the project comes from the rules using the current repository, falling back to `misc`.

Manual capture creates an `item` directly (`origin: manual`, `status: todo`). It is local only, prints `W-57 added to payments`, and finishes without network access.

## Agent Proposals

The `work_propose` tool is registered in every Pi session:

| Parameter | Required | Notes |
| --- | --- | --- |
| `title` | yes | 3–120 characters. |
| `reason` | yes | Why it matters. Up to 500 characters. |
| `evidence` | no | A URL, path, or short excerpt. Up to 1000 characters. |
| `project` | no | The agent's guess. Validated against known slugs; unknown values fall back to the rules. |
| `relates_to` | no | An existing item ID. |

Behavior:

- The tool creates only a `candidate` (`source: agent`). It cannot create items, change status, or reach Jira.
- The proposer's session ID and repository are recorded automatically from the extension context, not taken from parameters.
- The dedupe key is `agent:<repo>:<normalized-title>`. A repeat updates the pending candidate's reason and evidence instead of creating a new one.
- There are at most 5 pending agent candidates per session. Beyond that, the tool returns a bounded refusal telling the agent to include the follow-up in its final summary instead.
- The tool description says to propose only follow-ups outside the current task's scope, or work that would otherwise be left as "not done yet" at the end of the session. Normal progress on the session's own task does not qualify.
- Text fields are stored and displayed as data and are never interpreted as instructions.

The tool definition is static and registered once per session, so it doesn't disturb provider prompt caching.

## Triage

`/triage` and `work triage` open the same terminal view. `/today` opens it first whenever pending or due snoozed candidates exist.

Each row shows source, kind, title, proposed project, and evidence. Keys:

| Key | Action |
| --- | --- |
| `a` | Accept as a new item. The title and project can be edited first. |
| `m` | Merge into an existing item, chosen with a fuzzy picker. The candidate's link is attached. |
| `d` | Dismiss. The dedupe key is recorded in `dismissal`. |
| `z` | Snooze for N days (default 3). |
| `A` | Accept all pending candidates from the selected row's source. |
| `p` | On a new item: accept and promote it to Jira (see below). |
| `Enter` | Show the details. |

A `jira-update` candidate shows the ticket, current status, proposed status category, and evidence. Accepting it performs the transition described in [Jira writes](#jira-writes).

Hints come from `rules.ts`, not a model: the project is chosen by repository, Jira epic, or Jira project, then falls back to `misc`. A duplicate is suggested when any of a candidate's URLs or keys match an existing link.

Nothing expires automatically, except candidates withdrawn by reconciliation. Pi's status area shows the number of pending candidates.

## Daily Planning

### Session

`/today` and `work today` open, or focus, a tmux window named `today`, running a Pi session with the fixed ID `plan-YYYY-MM-DD` and the display name `Plan YYYY-MM-DD`. Running it again the same day refocuses the existing window, or resumes the session if the window is gone. Each day starts a new session, so planning context never accumulates across days. Outside tmux, the command prints the `pi` invocation to run.

The planner session receives a fixed kickoff prompt and these tools:

| Tool | Effect |
| --- | --- |
| `work_snapshot` | Read-only. Returns the compact snapshot below. |
| `work_item` | Read-only. Returns one item's full notes, links, and recent events. |
| `work_update` | Local writes to one item: `status` (including `waiting` details), `pinned`, `due`, `notes`, `project`. Each call writes an `event` with actor `planner`. |
| `work_plan_save` | Saves or replaces today's `plan`, and marks the included signals as seen. |

The planner has no Jira or GitHub write tools.

### Flow

1. Run sync (cached), and report connector warnings.
2. Run triage if candidates are pending.
3. The model calls `work_snapshot` and proposes:
   - **Focus:** 3 to 5 items, including every pinned item, each with a one-line reason that cites signals, waiting age, due dates, or yesterday's outcome.
   - **Quick actions:** reviews, replies, and pending Jira updates.
   - **Nudges:** items that have waited more than 7 days, `todo` items untouched for 14 days, and `doing` items with no event for 3 days. Each nudge offers decide, park, or drop.
4. The user adjusts the plan in conversation. The model applies agreed changes with `work_update`, then calls `work_plan_save`.

### Snapshot contents

The snapshot is deterministic, compact, and bounded to 200 items, with active projects first. For each item it includes the ID, project, title, status, waiting details, age in days, days since the last event, due date, pinned flag, link kinds and cached states, and unseen signals. It also includes yesterday's plan with each focus item's current status, the number of pending candidates by source, and connector health.

Notes aren't included; `work_item` returns them on request. External text such as ticket titles, PR titles, and agent reasons is placed in a clearly delimited field for external data.

## Recap

`work recap [today|yesterday|week]` renders Markdown from events only, with these sections:

- **Done:** items moved to `done`.
- **Progressed:** items with events but not done.
- **New:** items created.
- **Waiting on others:** current `waiting` items and how long each has waited.

It uses no model, makes no network calls, and invents nothing. It is intended to be pasted into the personal notes app.

## Jira Writes

These are the only two paths that write to Jira. Both show a preview and require explicit confirmation.

**Promote** (`work promote W-42`, `p` in triage, or a planner request that the user confirms in the UI):

- The issue is created in `jira.defaultProject` with type `jira.defaultIssueType`.
- The summary is the item title. The description is the notes plus a list of links.
- The ticket is linked to the project's `jira_epic` when one is configured.
- The new key is attached to the item as a `jira` link.
- Promotion is idempotent: if the item already has a `jira` link, it is refused.

**Status transition** (when a `jira-update` candidate is accepted):

- The ticket's available transitions are fetched. A transition is applied only if exactly one leads to the proposed status category.
- Otherwise the user picks from the available transitions, or cancels.
- The resulting status is written to the link state and to the event log.

Failures are shown verbatim, with secrets redacted, and leave local state unchanged. A promotion that succeeded remotely but failed to record locally is detected on the next sync, because the ticket then appears as assigned-open with a matching summary. The detection produces an `attach-link` candidate.

## Storage and Backup

- The database is at `~/.local/share/work/work.db` (or `$XDG_DATA_HOME/work/work.db`), with file permissions `0600` and directory permissions `0700`.
- It uses WAL journaling and a busy timeout of at least 5 seconds. Each mutation runs in one transaction together with its event.
- Migrations are numbered and applied in order at open, inside a transaction. A database newer than the code is refused and left unmodified.
- Before each sync, and at most once per hour, the store is exported to `~/.local/share/work/backups/work-<timestamp>.jsonl`, keeping the newest 14.
- `work export [path]` writes an export on demand. `work import <path>` restores into an empty database only, and refuses to touch a non-empty one.

## Trust and Security

- Secrets are obtained at call time from the configured command or `gh`. They are never persisted, logged, recorded in events, backed up, or included in model context. Error text is redacted before display or storage.
- All external and agent-supplied text is data. Triage renders it as plain text. The planner snapshot delimits it as external content. No stored text is ever executed or treated as an instruction.
- The model-facing tools are `work_propose` in every session, and `work_snapshot`, `work_item`, `work_update`, and `work_plan_save` in the planner session. None of them can reach Jira or GitHub.
- Jira writes happen only through the two confirmed paths. GitHub is read-only.
- The configuration and database stay outside this repository. The repository boundary check must continue to pass.

## Failure Semantics

| Failure | Behavior |
| --- | --- |
| Configuration missing or invalid | Capture, triage, planning, and recap work. The affected connectors are disabled, with a warning. |
| Connector auth or network failure | The status is recorded and reported with last-success time. No store changes. |
| Partial connector results | Link updates are applied only for observed keys. Nothing is withdrawn. |
| Database locked beyond the timeout | The operation fails with a clear message, and nothing is half-written. |
| Database schema newer than code | Refused. The database is unmodified. |
| Jira write fails | Local state is unchanged and the error is shown with secrets redacted. |
| Agent proposal limit reached | A bounded refusal is returned to the agent. No candidate is created. |

## Verification Strategy

The tests use `node --test`, following the existing repository layout under `tests/work/`:

- **Store and migrations:** apply migrations from empty, refuse a database with a newer schema, check that every mutation writes exactly one event in the same transaction, and run several processes writing at once under WAL without lost writes.
- **Capture parser:** projects, due dates (including weekday rollover), URL kinds, and title handling.
- **Rules:** repository, epic, and project mapping, the fallback to `misc`, and duplicate detection.
- **Reconciliation:** recorded observation fixtures covering new, known and changed, disappeared, dismissed, and partial or failed results, and the rule that creates a `jira-update` candidate.
- **Connectors:** recorded HTTP responses and `gh` output. No live network in unit tests. Tests check that secrets are redacted from every error path and that the token is chosen per organization.
- **Triage actions:** accept, merge, dismiss, snooze, bulk accept, and promote-on-accept.
- **Jira writes:** preview and confirmation gating, the rules for choosing a transition, and idempotent promotion.
- **Snapshot:** determinism, the 200-item bound, delimiting of external text, and the nudge thresholds.
- **Recap:** golden Markdown output from fixture events.
- **Backup:** export and import round-trip, import refusing a non-empty database, and rotation.
- **Extension:** command and tool registration, a static tool schema, and enforcement of the proposal limit.

A separate `scripts/work-live-smoke.mjs` runs read-only connector queries against the real endpoints using the user's configuration.

The release gates are `npm test`, `npm run typecheck`, and `npm run check`.
