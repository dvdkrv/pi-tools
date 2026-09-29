# Child Agents and Project Leads Design

**Date:** 2026-09-29  
**Repository:** `dvdkrv/pi-tools`  
**Status:** Approved design, pending implementation plan  
**Builds on:** `2026-09-25-work-tracker-design.md` (v0.2.x) and `2026-09-25-work-sessions-jobs-design.md` (v0.3.0)

## Purpose

Let a top-level Pi session, the *project lead*, hand implementation work to headless *child agents* without blocking. The lead keeps talking to the user and receives results at quiet moments. It merges acceptable work into its branch and keeps a draft PR current. The user talks only to the lead and reviews the finished PR.

This is project 3a. Project 3b, the *chief of staff* that takes over task management, is separate and builds on this mechanism.

### Problems this solves

The user reported these problems with subagents:

- They work invisibly.
- They are hard to steer.
- They block the agent that invokes them.
- They are costly.
- They over-test, running a full 30-minute suite after a two-line change.
- They over-engineer, producing 100k+ line PRs where about 2,000 lines would do.

The design answers each problem with enforcement rather than instructions.

### Guiding principles

- Automatic by default. The user makes design and implementation decisions, not bookkeeping ones.
- Less is more. Changes should be as small as the task allows.
- Every threshold is a config parameter and can be changed without a release.

## Scope

In scope:

- Delegation tools for leads.
- Child process supervision.
- Guards inside children: tests, diff budget, scope, restricted actions, and spending.
- Merging child work and maintaining a draft PR.
- Recording child runs, and showing them in the dashboard.
- Recovery after a crash.

Out of scope:

- The chief of staff (project 3b).
- Grandchildren. The hierarchy is exactly one level deep.
- Running children on other hosts.
- Marking PRs ready, merging PRs, and anything touching the default branch.

## Roles

- **Lead:** any top-level interactive (TUI) session. No mode needs to be enabled. The lead gets the delegation tools.
- **Child:** a `pi --mode rpc` subprocess started by a lead through `delegate`. It is registered with `parent_session` and `headless`, per project 2. It never gets delegation tools.

## Configuration

A new `children` section in `~/.config/work/config.json`, validated like the rest of the file. Invalid values fall back to the defaults with a warning.

```json
{
  "children": {
    "defaultModel": "anthropic/claude-sonnet-5",
    "diffBudget": { "defaultLines": 300, "defaultFiles": 8, "maxLines": 800, "prLines": 2000 },
    "spendCapUsd": 5,
    "commandTimeoutMinutes": 10,
    "repos": {
      "example-repo": {
        "ignore": ["**/generated/**", "*.lock"],
        "expensiveCommands": ["make test$", "tox$"]
      }
    }
  }
}
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `defaultModel` | `anthropic/claude-sonnet-5` | Model for children, unless the brief names another. |
| `diffBudget.defaultLines` / `defaultFiles` | 300 / 8 | Per-child budget when the brief omits one. |
| `diffBudget.maxLines` | 800 | The largest per-child budget a brief may request. |
| `diffBudget.prLines` | 2000 | Cap on the lead branch's total diff against its merge base with the default branch. |
| `spendCapUsd` | 5 | Per-child spending cap. |
| `commandTimeoutMinutes` | 10 | Wall-clock limit for any single shell command in a child. |
| `repos.<name>.ignore` | `[]` | Glob patterns excluded from diff counts, added to the built-in list. |
| `repos.<name>.expensiveCommands` | `[]` | Regular expressions added to the built-in expensive-command list. |

Repository names match the rules' `repo` field: the basename or `owner/name`. The built-in ignore list covers common lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `go.sum`), `**/__snapshots__/**`, `**/vendor/**`, and `**/generated/**`.

## Delegation

### Lead tools

These are static tools, registered only in top-level TUI sessions.

| Tool | Behavior |
| --- | --- |
| `delegate` | Validates the brief, prepares the worktree (for `implement`), starts the child, records a `child_run`, and returns immediately with the child ID and branch. |
| `children` | Returns this lead's child runs from the registry: ID, goal, state, declared note, model, spend, diff lines and files against the budget, and acceptance results. Nothing is streamed into the lead's context. |
| `steer_child` | Sends text to a running child. By default it is delivered as a follow-up at the child's next quiet moment. With `urgent: true`, it is delivered as an immediate steer. |
| `stop_child` | Aborts a running child and ends its process. With `discard: true`, it also removes the worktree and branch. Otherwise they are kept. |
| `merge_child` | Merges a finished child into the lead's branch, pushes, and updates the draft PR (see Merging). |

### Brief

`delegate` takes a structured brief:

| Field | Required | Notes |
| --- | --- | --- |
| `goal` | yes | One sentence. |
| `kind` | yes | `implement` or `read-only`. |
| `scope` | for `implement` | Glob paths the child may change. |
| `non_goals` | no | Explicitly excluded work. |
| `acceptance` | for `implement` | Targeted test commands that must pass. Each is checked against the expensive-command guard when delegated. |
| `context` | no | Up to 4,000 characters of background: decisions, file pointers, constraints. |
| `budget` | no | `{ lines, files }`. Lines are capped at `diffBudget.maxLines`. |
| `model` | no | Overrides `defaultModel`. Requires `model_reason`. |

### Child environment

- **`implement`:** a new worktree at `<repo>/.pi/worktrees/child-<run-id>` on branch `child/<lead-branch>/<run-id>`, created from the lead's current `HEAD`. The lead's working tree must be clean. Otherwise `delegate` refuses and asks the lead to commit first.
- **`read-only`:** runs in the lead's cwd with the `edit` and `write` tools disabled. Shell commands are still guarded.
- **Process:**
  - The child is started as `pi --mode rpc --model <model> --name "child <run-id>: <goal>"` with the environment `PI_WORK_PARENT_SESSION=<lead id>`, `PI_WORK_CHILD_RUN=<run id>`, and `PI_WORK_ITEM` inherited from the lead's link.
  - The lead drives it through `RpcClient` from `@earendil-works/pi-coding-agent`.
  - The child's first prompt is the rendered brief.

### Results

When a child reaches `agent_settled` for its final run, or crashes, or is stopped by a guard, the lead receives **one** custom message at its next quiet moment. The message contains:

- the outcome and the child's `session_status` note (its summary)
- diff statistics
- acceptance results
- spend
- the branch name

Messages that arrive while the user and lead are mid-conversation are queued, never interleaved. The lead then applies the merge rule.

### Lifecycle and supervision

- **Outcomes:** `running`, `done`, `failed`, `over-budget`, `over-spend`, `incomplete`, `stopped`, `merged`, `discarded`, or `interrupted`. A read-only run can additionally carry the `modified-files` flag.
- **Done:** the child committed on its branch and ended with `session_status done`.
- **Incomplete:** the child settled without doing both.
- **Clean lead shutdown:** closes each child's stdin, sends `SIGTERM`, and sends `SIGKILL` after 10 seconds.
- **Watchdog:** every 5 seconds the child checks that its parent process is alive (`process.kill(ppid, 0)`, plus a `/proc` start-time check against PID reuse). If not, it exits. This covers a lead that crashes without running its hook.

## Guards in Children

The `work` extension enforces these guards when `PI_WORK_CHILD_RUN` is set. They block actions through Pi's `tool_call` hook, and add warnings to tool results. They do not rely on instructions alone.

### Tests

- **Expensive-command guard:** every `bash` command is matched against the built-in patterns and the repository's `expensiveCommands`. The built-in patterns cover repo-wide runs:
  - bare `npm test`, `npm run test`, `pnpm test`, and `yarn test`
  - `pytest` with no path or node ID
  - `go test ./...`
  - `cargo test` without `-p` or a filter
  - `bazel test //...`
  - `make test`
  - `tox` without `-e`
  - `ddev test` without a target
- **When a command matches:** it is blocked with: "Blocked: repository-wide test run. Run only the tests covering the files you changed. Full-suite verification runs in CI on the draft PR."
- **No overrides:** children are never allowed full runs.
- **Timeout:** every shell command gets a wall-clock timeout of `commandTimeoutMinutes`.

### Diff budget

- **Measurement:** after each `edit`, `write`, or `bash` tool result, the child's diff against its starting commit is measured. That is `git diff --numstat <base>` plus untracked files, excluding ignore patterns.
- **At 80% of either lines or files:** the tool result gets a warning: "Budget 240/300 lines: finish the smallest working change."
- **At 100%:**
  - `edit` and `write` are blocked.
  - `bash` is limited to an allowlist: `git status`, `git diff`, `git log`, `git add`, `git commit`, and the brief's acceptance commands.
  - The child is told to commit what it has and end with `session_status`.
  - The run's outcome becomes `over-budget`.
- **Read-only children:** they have no budget. `edit` and `write` are disabled. If `git status --porcelain` in the lead's directory differs after a shell command, the change is left in place (the lead may have uncommitted work there), the run is flagged `modified-files`, and the lead is told.

### Scope and restricted actions

- **Scope:** `edit` and `write` outside `scope`, or outside the child's worktree, are blocked.
- **Always blocked:**
  - `git push`, and `git remote` changes
  - `gh pr …` and `gh api` writes
  - `git reset --hard`, `git rebase`, `git commit --amend`, and `git checkout` or `git switch` of other branches
  - dependency additions: `npm|pnpm|yarn install|add <pkg>`, `pip install`, `uv add`, `uv pip install`, `poetry add`, `go get`, and `cargo add`

  Needing a dependency is a question for the lead.

### Spending

- **Tracking:** the child's spend is summed from assistant message usage and cost, per Pi's model pricing.
- **At 80% of `spendCapUsd`:** a warning.
- **At 100%:** the current run is aborted, work so far is committed by the extension, and the outcome becomes `over-spend`.

### Prompt

The brief and the child rules (scope, budget, commit and `session_status` requirements, and "less is more: the smallest change that meets the goal, no unrequested refactors or scaffolding") are appended to the system prompt once, at start. The text is static for the session, which keeps it cache-friendly.

## Merging and the Draft PR

### `merge_child`

`merge_child` refuses unless all of these hold:

- the run is `done`
- every acceptance command passed
- the lead's working tree is clean
- the lead's diff against its merge base with the default branch, plus the child's diff, stays within `prLines`

The lead is expected to review the child's diff before calling it, using normal `git` commands on the child branch.

On success it:

1. Merges the child branch into the lead branch (`git merge --no-ff`, message `Merge child <run-id>: <goal>`).
2. Removes the child's worktree and branch.
3. Pushes the lead branch without force, setting the upstream on the first push.
4. Creates a draft PR (`gh pr create --draft`) if the branch has none, or else leaves the existing PR, which now carries the new commits. It uses the GitHub account the tracker config maps to the repository's org.

It never marks a PR ready, never merges a PR, and never pushes the default branch. A push or PR failure leaves the local merge in place and is reported. The next `merge_child` retries it.

### Finishing

When the lead considers the work complete, it ends with `session_status needs-me` and the note `ready for review: <PR URL>`.

## Data Model

A migration adds the `child_run` table:

| Field | Notes |
| --- | --- |
| `id` | `C-<n>`. |
| `lead_session`, `child_session` | Session IDs. `child_session` is set once the child starts. |
| `kind` | `implement` or `read-only`. |
| `brief` | JSON. |
| `model` | The resolved model. |
| `repo`, `worktree`, `branch`, `base_commit` | Worktree fields are null for `read-only`. |
| `pid` | Child process ID. |
| `outcome` | See Lifecycle. |
| `spend_usd`, `diff_lines`, `diff_files` | Updated as the child works. |
| `budget_lines`, `budget_files` | Resolved from the brief or the defaults. |
| `acceptance` | JSON: command, exit code, and summary per command. |
| `summary` | The child's final `session_status` note. |
| `created_at`, `ended_at`, `merged_at` | Timestamps. |

Creating, ending, merging, and discarding runs are domain mutations and write events. Spend and diff updates are operational.

## Dashboard

Child rows under their lead, from project 2, gain these columns: model short name, spend, and diff against budget. Example: `done  C-4  sonnet-5  $1.20  212/300  "Add retry to fetchJira"`.

`Enter` still opens the transcript. `x`, then `y`, calls the same stop logic as `stop_child` without discarding.

## Recovery

- **Child crash:** the outcome is `failed` and the lead is notified. The worktree is kept, so the lead can start a new child from that branch state.
- **Lead crash:** children exit through the watchdog. When the lead session starts again, whether restored or reopened, its extension finds runs still marked `running` whose PID is gone, and marks them `interrupted`. The lead receives one message listing them with their branches. The lead re-delegates or discards each. The user does nothing.
- **Missing `gh` account or authentication failure:** reported by `merge_child`, and the local merge stands.

## Failure Semantics

| Failure | Behavior |
| --- | --- |
| Lead working tree dirty at `delegate` | Refused, with a request to commit first. |
| Worktree creation fails | Refused, and no run is recorded. |
| Child fails to start | The run is `failed` with the start error, and the worktree is removed. |
| Registry write fails | The guard state is kept in memory, so guards still apply. Recording resumes when possible. |
| Config invalid | Defaults are used, with one warning per session. |
| `git` unavailable in the child worktree | The diff budget cannot be measured. Edits are blocked, and the run ends as `failed`. |

## Verification Strategy

The tests use `node --test` under `tests/work/`:

- **Supervision:** a fake RPC child script covers start, the results message, steering (follow-up and urgent), stop, discard, the shutdown sequence (stdin close, `SIGTERM`, `SIGKILL`), and the watchdog exiting when its parent disappears.
- **Guards:** pure functions over command strings (expensive patterns, restricted actions, dependency additions) and over diff numstat inputs (budget thresholds, ignore globs, untracked files). This includes the over-budget shell allowlist, and the read-only `modified-files` flag, run on a temporary git repository.
- **Spending:** accumulation from usage records, and the warning and abort thresholds.
- **Merging:** each refusal condition, the PR cap, `--no-ff` merge, cleanup, push without force, and draft PR creation, with a faked `gh` and a local bare remote.
- **Recovery:** interrupted runs found at lead start, the child-crash path, and the dashboard columns.
- **Config:** defaults, validation, and per-repo overrides.

The release gates are `npm test`, `npm run typecheck`, and `npm run check`.
