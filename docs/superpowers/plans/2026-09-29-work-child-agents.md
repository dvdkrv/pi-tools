# Child Agents and Project Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a top-level Pi session (the project lead) hand work to headless child agents without blocking. The children are held small and cheap by guards they cannot talk their way around. The lead merges acceptable work and keeps a draft PR current.

**Architecture:** Pure, Pi-free modules under `src/work/children/` hold the guards, git and diff helpers, briefs, a minimal client for Pi's RPC protocol, the lead-side supervisor, and merging. The existing `work` extension wires them in two ways. In a child (`PI_WORK_CHILD_RUN` set), it enforces the guards through `tool_call`, `tool_result`, and `message_end`, and runs a parent watchdog. In a top-level TUI session, it registers five static lead tools. A `child_run` table (schema 3) records runs, and the dashboard shows them on child rows.

**Tech Stack:** TypeScript (erasable syntax only), Node ≥ 22.19 (`node:sqlite`, `node:child_process`), `git` and `gh` on `PATH`, Pi's documented RPC protocol (`pi --mode rpc`, JSONL on stdin and stdout), `typebox` and `@earendil-works/pi-ai` `StringEnum` for tool schemas (extension only), `node --test` with `jiti`.

**Spec:** `docs/superpowers/specs/2026-09-29-work-child-agents-design.md`. Its principles, which every task follows: enforcement over instructions, less is more, and every threshold is config.

**Style reference:** `docs/superpowers/plans/2026-09-25-work-sessions-jobs.md`.

**Size:** about 1,790 lines of source (1,310 in ten new modules under `src/work/children/`, and 480 added to existing files) and 1,410 lines of tests, in 15 tasks and 4 parts. The largest module is `supervisor.ts` (about 340 lines). Nothing outside the spec is built: no grandchildren, no remote hosts, no PR-ready or PR-merge, no CLI commands, and no live smoke script.

**Pre-checked:** before review, every task's code was applied as written to a scratch copy of this branch. The result was 603 passing tests (526 existing and 77 new, stable over repeated runs), a clean `npm run typecheck`, and a clean `npm run check`.

## Global Constraints

- Principles, verbatim from the spec: "Automatic by default. The user makes design and implementation decisions, not bookkeeping ones." "Less is more. Changes should be as small as the task allows." "Every threshold is a config parameter and can be changed without a release."
- The hierarchy is exactly one level deep. Children never get delegation tools.
- Never mark PRs ready, never merge PRs, never push or commit to the default branch, and never force-push.
- No new runtime dependencies. Use `node:*` modules, `git`, and `gh`.
- `package.json` `engines` stays `{"node": ">=22.19.0"}`. Do not bump `version`, tag, or push.
- TypeScript must be erasable, because Node runs `bin/work.ts` directly: no parameter properties, `enum`, or `namespace`. Import types with `import type`.
- Only `src/work/children/lead-tools.ts` and `extensions/work.ts` may import Pi packages (`@earendil-works/*`) or `typebox`. The dashboard imports `src/work/children/format.ts`, so every module under `src/work/children/` except `lead-tools.ts` stays Pi-free. `tests/work/pi-free.test.mjs` enforces this for the dashboard's import graph.
- Tests are `.mjs` files under `tests/work/`, loading TypeScript through `jiti` via `tests/work/helpers.mjs`. **Tests never start a real Pi process and never call a model.** Children are played by `tests/work/fixtures/fake-rpc-child.mjs`. `gh` is always a fake function. Real `git` runs only in temporary repositories and a local bare remote.
- `npm run check` must pass. Never write the employer's name or shorthand, or real home-directory paths, into any file. Use placeholders such as `/src/api`, `example-org`, `example-repo`, `C-4`, and `W-7`.
- Every domain mutation writes exactly one `event` in the same transaction, and a no-op writes none. Creating, ending, merging, and discarding child runs are domain mutations. Pid, session, flag, spend, and diff updates are operational.
- Tool definitions are static: fixed names, descriptions, and schemas.
- Release gates: `npm test`, `npm run -s typecheck`, `npm run -s check`.
- Commit after every task, using Conventional Commit messages.
- Execution: each part is implemented by a fresh session with superpowers:executing-plans, one task at a time. **Each part ends with a STOP for review.** Record every change to this plan's code in `docs/superpowers/plans/2026-09-29-work-child-agents-deviations.md`, with the task, the change, and why.

## Spec Decisions Made in This Plan

These resolve gaps or conflicts in the spec. Each is small and reversible. Please accept or reject them during review.

1. **A small RPC client instead of `RpcClient`.** The spec says the lead drives children "through `RpcClient`". Reading the exported class (0.82.0 in `node_modules`, 0.87.1 installed) shows four conflicts. It spawns `node <cliPath>`, not `pi`. It copies every byte of child stderr to the host's `process.stderr`, which would draw over the lead's TUI. `stop()` sends `SIGTERM` and then `SIGKILL` after 1 second, without closing stdin, while the spec asks for stdin close, `SIGTERM`, and `SIGKILL` after 10 seconds. And it hides the child's PID, which `child_run.pid` and recovery need. `src/work/children/rpc.ts` (about 140 lines) implements the documented protocol from `docs/rpc.md` and `docs/rpc-commands.md` instead: strict LF framing, `id`-correlated `response` records, and events. It uses only `get_state`, `prompt`, `steer`, `follow_up`, and `abort`, and the `agent_settled` event.
2. **Who decides the outcome.** The lead learns the child's session ID from `get_state`. When the child settles, the lead reads that session's row: the child declared `done` if its status is `done` with source `agent`, and its note is the summary. `done` for `implement` also needs at least one commit since `base_commit`.
3. **The lead runs the acceptance commands.** After an otherwise-done `implement` child settles, the lead runs each acceptance command in the child's worktree through the existing `runShell`, with `commandTimeoutMinutes`. It records the exit code and the last output line. A child's own claim is never trusted.
4. **The first `agent_settled` is final.** The lead then records the result, ends the child process, and sends the one message. Steering a finished child is refused. To continue, the lead delegates again with `from` (decision 5).
5. **`from: C-<n>` in the brief.** The spec says the kept worktree lets "the lead start a new child from that branch state", but the brief has no field for it. `from` starts the new worktree at that run's branch tip and keeps its `base_commit`, so the budget covers the cumulative change. Uncommitted leftovers are committed first as `WIP: uncommitted work from C-<n>`. The old run is then `discarded`, and its worktree and branch are removed.
6. **A `flags` column.** Children record `over-budget`, `over-spend`, `no-git`, and `modified-files` as JSON flags. The outcome stays `running` while a child wraps up, so recovery still finds it. At settle the lead maps flags to the outcome, in this order: `over-spend`, `over-budget`, then `no-git` as `failed`. `modified-files` stays a flag and is shown in the message.
7. **Two writers.** The child writes flags, spend, and diff (operational). The lead writes creation, PID, child session, end, merge, and discard, and it re-measures the diff at the end.
8. **Prompt delivery.** The brief and the child rules go into `--append-system-prompt` at spawn, which is static for the session and cache-friendly. The first prompt is one line pointing to it, so the brief is not sent twice. Read-only children also get `--exclude-tools edit,write`, and the guard blocks those tools regardless.
9. **Guards fail closed.** A child reads its run from the registry at `session_start`. Until then, or if the read fails, `edit`, `write`, and `bash` are blocked. Registry *write* failures keep guard state in memory, as the spec asks.
10. **Watchdog parent.** The lead passes its PID as `PI_WORK_PARENT_PID`, one more environment variable than the spec lists. Without it, a lead that died during child startup would leave the child watching init. The child checks that the PID is alive and that its `/proc` start time is unchanged. Without the variable, it watches `process.ppid` and also treats a changed `ppid` as gone.
11. **Registering lead tools.** Pi loads extensions before the mode is known. The five lead tools are registered unless `PI_WORK_CHILD_RUN` is set. Non-TUI top-level sessions deactivate them with `pi.setActiveTools` at `session_start`, so the definitions stay static.
12. **Default-branch safety.** `delegate` (for `implement`) and `merge_child` refuse when the lead is on the default branch. The default branch is `origin/HEAD`, and `main` and `master` always count.
13. **Keeping the lead's tree clean.** Child worktrees live inside the repository, so `delegate` adds `/.pi/worktrees/` to the repository's local `info/exclude`. Otherwise the lead would look dirty after the first `delegate`.
14. **Shutdown and recovery.** A clean lead shutdown ends the child processes but writes no outcomes. When the lead starts again, every run of that lead still marked `running` becomes `interrupted`, and the lead gets one message. A PID is sent `SIGTERM` first, but only when its environment names that run. The spec says "whose PID is gone". This version also covers the up-to-5-second window before the watchdog fires.
15. **Stopping from the dashboard.** The dashboard cannot reach the lead's RPC pipe, so `x` then `y` records the run as `stopped` and then sends `SIGTERM`, which Pi handles as a graceful shutdown. The lead then reports the stop in its one message. Child columns go into the note column, so the existing column widths stay as they are.
16. **`stop_child` details.** `discard: true` also works on runs that already ended, which the recovery flow needs. A stop by the lead produces no result message, because the tool result already reports it.
17. **Merge details.** A merge conflict is aborted with `git merge --abort` and refused, and the run stays `done`. `merge_child` on a `merged` run retries only the push and the PR. An existing open PR is found with `gh pr list --head <branch>`. New draft PRs use the goal as the title and the run summary as the body. The GitHub repository comes from the raw `remote.origin.url`.
18. **Thresholds.** One threshold is added to the config: `children.warnPercent` (default 80), for both the budget and spend warnings. Mechanism timings stay constants: the watchdog interval (5 s), the kill grace (10 s), and the abort wait (5 s). The brief's schema limits also stay constants: goal 200 characters and context 4,000. They live in static tool definitions.
19. **Matching commands.** Commands are split into segments on `&&`, `||`, `;`, `|`, `&`, newlines, and parentheses, after redirections and leading `VAR=value` assignments are removed. Each segment is matched. This catches accidents, not a hostile model: `sh -c "npm test"` is not inspected. `git checkout` is allowed only in its `-- <paths>` form, and `git switch` is always blocked. The over-budget allowlist accepts `&&` and `;` chains of allowlisted git commands.
20. **Globs.** `**`, `*`, and `?`. Ignore patterns without a `/` match the basename, as in `.gitignore`. Scope patterns match the full repository-relative path, and a plain directory (`src/work`) matches everything under it.
21. **Budget and spend details.** Diffs use `git diff --numstat --no-renames <base>`, plus untracked files counted by their line count. The budget is reached at 100% of either lines or files. The warning repeats on every tool result at or above `warnPercent`. The spend warning is appended once, to the next tool result. Spend sums `usage.cost.total` from assistant `message_end` events. The extension's own WIP commits use `--no-verify`.
22. **Starting and failing.** `delegate` returns right after spawning. A start error arrives later as the one result message. The last 2 KB of child stderr are kept for failure summaries and never reach the lead's terminal.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/work/config.ts` | The `children` section: types, defaults, validation, and per-repository merging. |
| `src/work/migrations.ts`, `src/work/types.ts`, `src/work/store.ts` | Schema 3: the `child_run` table, its types, and store methods. |
| `src/work/children/guards.ts` | Pure command and path checks: segments, restricted actions, expensive tests, the over-budget allowlist, globs, and scope. |
| `src/work/children/git.ts` | A git runner that keeps git's error text, repository helpers, worktrees, and diff measurement. |
| `src/work/children/child-guard.ts` | Guard state inside a child: blocks, warnings, budget, spend, read-only detection, and WIP commits. |
| `src/work/children/watchdog.ts` | The child's parent watchdog. |
| `src/work/children/rpc.ts` | A minimal client for Pi's RPC protocol, with the shutdown sequence. |
| `src/work/children/brief.ts` | Brief validation and the child's system prompt. |
| `src/work/children/format.ts` | Model short names, run lines, the result message, and the interrupted-runs message. Pi-free, used by the dashboard. |
| `src/work/children/supervisor.ts` | The lead side: delegate, finish, list, steer, stop, discard, recover, and shutdown. |
| `src/work/children/merge.ts` | `merge_child`: refusals, `--no-ff` merge, cleanup, push, and the draft PR. |
| `src/work/children/lead-tools.ts` | The five static lead tools (the only new module importing Pi packages). |
| `extensions/work.ts` | Child guard hooks and watchdog, lead tools, recovery at start, and shutdown. |
| `src/work/dash/model.ts`, `src/work/dash/view.ts`, `src/work/dash/app.ts` | Child rows show their run, and `x` records the stop. |
| `tests/work/fixtures/fake-rpc-child.mjs` | A scripted stand-in for `pi --mode rpc`. |
| `tests/work/fixtures/watchdog-pair.mjs` | A parent that exits while its watched child runs. |

---

# Part 1: Configuration, Registry, and Pure Checks

### Task 1: The `children` configuration section

**Files:**
- Modify: `src/work/config.ts`
- Test: `tests/work/children-config.test.mjs`

**Interfaces:**
- Consumes: `repoMatches(ruleRepo, repo)` from `src/work/rules.ts`.
- Produces:
  - Types `RepoChildrenConfig = { ignore: string[]; expensiveCommands: string[] }`, `DiffBudgetConfig = { defaultLines; defaultFiles; maxLines; prLines }` (numbers), and `ChildrenConfig = { defaultModel: string; diffBudget: DiffBudgetConfig; spendCapUsd: number; commandTimeoutMinutes: number; warnPercent: number; repos: Record<string, RepoChildrenConfig> }`
  - `WorkConfig` gains `children?: ChildrenConfig`
  - `DEFAULT_CHILDREN: ChildrenConfig`
  - `childrenConfig(config: WorkConfig): ChildrenConfig`, which returns the defaults when the section is absent
  - `repoChildrenConfig(children: ChildrenConfig, repo: string | null): RepoChildrenConfig`, which merges every `repos` entry whose key names the repository
  - `parseChildren(value: unknown, warnings: string[]): ChildrenConfig`
  - Warnings for this section start with `children`. Task 13 shows exactly those at lead start.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/children-config.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { parseWorkConfig, childrenConfig, repoChildrenConfig, DEFAULT_CHILDREN, emptyConfig } = await load('src/work/config.ts');

const parse = (children) => parseWorkConfig(JSON.stringify({ children }));

test('without a children section, the defaults apply and nothing warns', () => {
  const { config, warnings } = parseWorkConfig('{}');
  assert.deepEqual(warnings, []);
  assert.equal(config.children, undefined);
  assert.deepEqual(childrenConfig(config), {
    defaultModel: 'anthropic/claude-sonnet-5',
    diffBudget: { defaultLines: 300, defaultFiles: 8, maxLines: 800, prLines: 2000 },
    spendCapUsd: 5,
    commandTimeoutMinutes: 10,
    warnPercent: 80,
    repos: {},
  });
  assert.equal(childrenConfig(emptyConfig()), DEFAULT_CHILDREN);
});

test('valid children settings override the defaults', () => {
  const { config, warnings } = parse({
    defaultModel: 'openai/gpt-5.6',
    diffBudget: { defaultLines: 200, defaultFiles: 5, maxLines: 600, prLines: 1500 },
    spendCapUsd: 2.5,
    commandTimeoutMinutes: 3,
    warnPercent: 75,
    repos: { 'example-repo': { ignore: ['**/generated/**', '*.lock'], expensiveCommands: ['make test$', 'tox$'] } },
  });
  assert.deepEqual(warnings, []);
  const c = childrenConfig(config);
  assert.equal(c.defaultModel, 'openai/gpt-5.6');
  assert.deepEqual(c.diffBudget, { defaultLines: 200, defaultFiles: 5, maxLines: 600, prLines: 1500 });
  assert.deepEqual([c.spendCapUsd, c.commandTimeoutMinutes, c.warnPercent], [2.5, 3, 75]);
  assert.deepEqual(c.repos['example-repo'], { ignore: ['**/generated/**', '*.lock'], expensiveCommands: ['make test$', 'tox$'] });
});

test('invalid values fall back to the defaults field by field, each with a warning', () => {
  const { config, warnings } = parse({
    defaultModel: '',
    diffBudget: { defaultLines: -1, defaultFiles: 2.5, maxLines: 'x' },
    spendCapUsd: 0,
    commandTimeoutMinutes: 5,
    warnPercent: 150,
    repos: { api: { ignore: ['ok/**', 7], expensiveCommands: ['(unclosed', 'make check$'] }, web: 'nope' },
  });
  const c = childrenConfig(config);
  assert.equal(c.defaultModel, 'anthropic/claude-sonnet-5');
  assert.deepEqual(c.diffBudget, { defaultLines: 300, defaultFiles: 8, maxLines: 800, prLines: 2000 });
  assert.deepEqual([c.spendCapUsd, c.commandTimeoutMinutes, c.warnPercent], [5, 5, 80]);
  assert.deepEqual(c.repos.api, { ignore: ['ok/**'], expensiveCommands: ['make check$'] });
  assert.deepEqual(c.repos.web, { ignore: [], expensiveCommands: [] });
  for (const field of ['defaultModel', 'defaultLines', 'defaultFiles', 'maxLines', 'spendCapUsd', 'warnPercent', 'repos.api.ignore', 'repos.api.expensiveCommands', 'repos.web']) {
    assert.ok(warnings.some((warning) => warning.startsWith('children') && warning.includes(field)), field);
  }
  assert.equal(warnings.length, 9);
});

test('a default budget above the maximum is clamped to the maximum', () => {
  const { config, warnings } = parse({ diffBudget: { defaultLines: 900 } });
  assert.equal(childrenConfig(config).diffBudget.defaultLines, 800);
  assert.deepEqual(warnings, ['children.diffBudget.defaultLines is above maxLines; using 800']);
});

test('a children section that is not an object warns once and uses the defaults', () => {
  const { config, warnings } = parse([]);
  assert.deepEqual(childrenConfig(config), DEFAULT_CHILDREN);
  assert.deepEqual(warnings, ['children must be an object; using the defaults']);
});

test('per-repository settings match the basename or owner/name, and merge', () => {
  const { config } = parse({ repos: { api: { ignore: ['a/**'] }, 'example-org/api': { expensiveCommands: ['make e2e'] }, web: { ignore: ['w/**'] } } });
  const c = childrenConfig(config);
  assert.deepEqual(repoChildrenConfig(c, 'api'), { ignore: ['a/**'], expensiveCommands: ['make e2e'] });
  assert.deepEqual(repoChildrenConfig(c, 'example-org/api'), { ignore: ['a/**'], expensiveCommands: ['make e2e'] });
  assert.deepEqual(repoChildrenConfig(c, 'payments-api'), { ignore: [], expensiveCommands: [] });
  assert.deepEqual(repoChildrenConfig(c, null), { ignore: [], expensiveCommands: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/children-config.test.mjs`
Expected: FAIL, because `childrenConfig` is not a function.

- [ ] **Step 3: Implement the section**

In `src/work/config.ts`, add this import directly above `import { SLUG_PATTERN } from "./store.ts";`:

```ts
import { repoMatches } from "./rules.ts";
```

`rules.ts` imports only types from `config.ts`, so this adds no import cycle at runtime.

Replace the `WorkConfig` line with:

```ts
export type WorkConfig = { jira?: JiraConfig; github: { accounts: GithubAccount[] }; projects: ProjectConfig[]; rules: Rule[]; plannerCwd?: string; usage?: boolean; children?: ChildrenConfig };
```

After the `LoadedConfig` line, add:

```ts
export type RepoChildrenConfig = { ignore: string[]; expensiveCommands: string[] };
export type DiffBudgetConfig = { defaultLines: number; defaultFiles: number; maxLines: number; prLines: number };
export type ChildrenConfig = {
	defaultModel: string;
	diffBudget: DiffBudgetConfig;
	spendCapUsd: number;
	commandTimeoutMinutes: number;
	warnPercent: number;
	repos: Record<string, RepoChildrenConfig>;
};

export const DEFAULT_CHILDREN: ChildrenConfig = {
	defaultModel: "anthropic/claude-sonnet-5",
	diffBudget: { defaultLines: 300, defaultFiles: 8, maxLines: 800, prLines: 2000 },
	spendCapUsd: 5,
	commandTimeoutMinutes: 10,
	warnPercent: 80,
	repos: {},
};

export function childrenConfig(config: WorkConfig): ChildrenConfig {
	return config.children ?? DEFAULT_CHILDREN;
}

// Merges every repos entry whose key names this repository, by basename or owner/name.
export function repoChildrenConfig(children: ChildrenConfig, repo: string | null): RepoChildrenConfig {
	const merged: RepoChildrenConfig = { ignore: [], expensiveCommands: [] };
	if (!repo) return merged;
	for (const [key, entry] of Object.entries(children.repos)) {
		if (!repoMatches(key, repo)) continue;
		merged.ignore.push(...entry.ignore);
		merged.expensiveCommands.push(...entry.expensiveCommands);
	}
	return merged;
}
```

After the `parseJira` function, add:

```ts
function positiveNumber(record: Record<string, unknown>, key: string, fallback: number, path: string, warnings: string[], integer: boolean): number {
	const value = record[key];
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value))) return value;
	warnings.push(`${path}.${key} must be a positive ${integer ? "integer" : "number"}; using ${fallback}`);
	return fallback;
}

function patternList(value: unknown, path: string, warnings: string[], regex: boolean): string[] {
	if (value === undefined) return [];
	const list: unknown[] = Array.isArray(value) ? value : [];
	const valid = list.filter((entry): entry is string => {
		if (typeof entry !== "string" || !entry.trim()) return false;
		if (!regex) return true;
		try {
			new RegExp(entry);
			return true;
		} catch {
			return false;
		}
	});
	if (!Array.isArray(value) || valid.length !== list.length) warnings.push(`${path} must be a list of ${regex ? "regular expressions" : "glob patterns"}; invalid entries skipped`);
	return valid;
}

export function parseChildren(value: unknown, warnings: string[]): ChildrenConfig {
	const d = DEFAULT_CHILDREN;
	if (!isRecord(value)) {
		warnings.push("children must be an object; using the defaults");
		return d;
	}
	if (value.diffBudget !== undefined && !isRecord(value.diffBudget)) warnings.push("children.diffBudget must be an object; using the defaults");
	const budget = isRecord(value.diffBudget) ? value.diffBudget : {};
	const diffBudget: DiffBudgetConfig = {
		defaultLines: positiveNumber(budget, "defaultLines", d.diffBudget.defaultLines, "children.diffBudget", warnings, true),
		defaultFiles: positiveNumber(budget, "defaultFiles", d.diffBudget.defaultFiles, "children.diffBudget", warnings, true),
		maxLines: positiveNumber(budget, "maxLines", d.diffBudget.maxLines, "children.diffBudget", warnings, true),
		prLines: positiveNumber(budget, "prLines", d.diffBudget.prLines, "children.diffBudget", warnings, true),
	};
	if (diffBudget.defaultLines > diffBudget.maxLines) {
		warnings.push(`children.diffBudget.defaultLines is above maxLines; using ${diffBudget.maxLines}`);
		diffBudget.defaultLines = diffBudget.maxLines;
	}
	let defaultModel = d.defaultModel;
	if (value.defaultModel !== undefined) {
		const model = str(value.defaultModel);
		if (model) defaultModel = model;
		else warnings.push(`children.defaultModel must be a model name; using ${d.defaultModel}`);
	}
	let warnPercent = positiveNumber(value, "warnPercent", d.warnPercent, "children", warnings, true);
	if (warnPercent > 100) {
		warnings.push(`children.warnPercent must be at most 100; using ${d.warnPercent}`);
		warnPercent = d.warnPercent;
	}
	if (value.repos !== undefined && !isRecord(value.repos)) warnings.push("children.repos must be an object keyed by repository; ignored");
	const repos: Record<string, RepoChildrenConfig> = {};
	for (const [name, entry] of Object.entries(isRecord(value.repos) ? value.repos : {})) {
		if (!isRecord(entry)) warnings.push(`children.repos.${name} must be an object; ignored`);
		const record = isRecord(entry) ? entry : {};
		repos[name] = {
			ignore: patternList(record.ignore, `children.repos.${name}.ignore`, warnings, false),
			expensiveCommands: patternList(record.expensiveCommands, `children.repos.${name}.expensiveCommands`, warnings, true),
		};
	}
	return {
		defaultModel,
		diffBudget,
		spendCapUsd: positiveNumber(value, "spendCapUsd", d.spendCapUsd, "children", warnings, false),
		commandTimeoutMinutes: positiveNumber(value, "commandTimeoutMinutes", d.commandTimeoutMinutes, "children", warnings, false),
		warnPercent,
		repos,
	};
}
```

In `parseWorkConfig`, directly before its final `return { config, warnings };`, add:

```ts
	if (data.children !== undefined) config.children = parseChildren(data.children, warnings);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/children-config.test.mjs tests/work/config.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/config.ts tests/work/children-config.test.mjs
git commit -m "feat: add the children section to the work config"
```

---

### Task 2: Schema version 3 and the child run store

**Files:**
- Modify: `src/work/migrations.ts`: append migration 3
- Modify: `src/work/types.ts`: child run types
- Modify: `src/work/store.ts`: child run methods, backups, and `isEmpty`
- Modify: `tests/work/store.test.mjs:17`, `tests/work/backup.test.mjs:26`, `tests/work/session-store.test.mjs:107`: expect schema 3
- Test: `tests/work/child-store.test.mjs`

**Interfaces:**
- Consumes: `WorkStore` internals (`run`, `one`, `all`, `event`, `transaction`), `text`, `int`, `json`, and `NOTE_MAX`.
- Produces:
  - Types: `ChildKind = "implement" | "read-only"`, `ChildOutcome` (the ten outcomes), `ChildEndOutcome = "done" | "failed" | "over-budget" | "over-spend" | "incomplete" | "stopped" | "interrupted"`, `ChildFlag = "over-budget" | "over-spend" | "no-git" | "modified-files"`, `CHILD_KINDS`
  - `Brief = { goal; kind: ChildKind; scope: string[]; nonGoals: string[]; acceptance: string[]; context: string; model: string | null; modelReason: string | null; from: string | null }`
  - `AcceptanceResult = { command: string; exitCode: number | null; summary: string }`
  - `ChildRun = { id; leadSession; childSession: string | null; kind; brief: Brief; model; repo: string | null; worktree: string | null; branch: string | null; baseCommit: string | null; pid: number | null; outcome: ChildOutcome; flags: ChildFlag[]; spendUsd; diffLines; diffFiles; budgetLines: number | null; budgetFiles: number | null; acceptance: AcceptanceResult[]; summary; createdAt; endedAt: string | null; mergedAt: string | null }`
  - `ChildRunInput = { leadSession; brief: Brief; model; repo: string | null; budgetLines: number | null; budgetFiles: number | null }`, `ChildWorktree = { worktree; branch; baseCommit }`
  - `ChildRunPatch = { childSession?; pid?: number | null; flags?: ChildFlag[]; spendUsd?; diffLines?; diffFiles? }` and `ChildRunEnd = { outcome: ChildEndOutcome; summary?; acceptance?; diffLines?; diffFiles? }` (from `store.ts`)
  - `childRunId(num): string` (`C-<n>`), `childRunNum(id): number`
  - `store.createChildRun(input, actor, prepare?: (id: string) => ChildWorktree): ChildRun`. If `prepare` throws, no run and no event remain.
  - `store.getChildRun(id)`, `store.listChildRuns({ leadSession?, outcome? })` (by number), `store.childRunForSession(sessionId)`
  - `store.updateChildRun(id, patch): ChildRun` (operational)
  - `store.endChildRun(id, end, actor): ChildRun`. It ends a `running` run once, and later calls return the run unchanged, with no event.
  - `store.markChildRunMerged(id, actor)` (only from `done`), `store.markChildRunDiscarded(id, actor)` (not from `running`, `merged`, or `discarded`)

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { WorkStore } = await load('src/work/store.ts');
const { MIGRATIONS } = await load('src/work/migrations.ts');

const brief = (overrides = {}) => ({ goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null, ...overrides });
const input = (overrides = {}) => ({ leadSession: 'lead-1', brief: brief(), model: 'anthropic/claude-sonnet-5', repo: 'api', budgetLines: 300, budgetFiles: 8, ...overrides });
const tree = (id) => ({ worktree: `/src/api/.pi/worktrees/child-${id}`, branch: `child/feat/${id}`, baseCommit: 'abc123' });

test('createChildRun records a running run with its worktree and one create event', async () => {
  const store = await memoryStore();
  const run = store.createChildRun(input(), 'session:lead-1', tree);
  assert.equal(run.id, 'C-1');
  assert.equal(run.outcome, 'running');
  assert.equal(run.kind, 'implement');
  assert.deepEqual([run.worktree, run.branch, run.baseCommit], ['/src/api/.pi/worktrees/child-C-1', 'child/feat/C-1', 'abc123']);
  assert.deepEqual(run.brief, brief());
  assert.deepEqual([run.flags, run.spendUsd, run.acceptance, run.summary], [[], 0, [], '']);
  assert.equal(run.createdAt, '2026-09-25T09:00:00.000Z');
  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].entity, events[0].action, events[0].actor], ['child:C-1', 'create', 'session:lead-1']);
  assert.equal(events[0].data.after.worktree, '/src/api/.pi/worktrees/child-C-1');
});

test('a failing prepare records no run and no event, and read-only runs need no worktree', async () => {
  const store = await memoryStore();
  assert.throws(() => store.createChildRun(input(), 'session:lead-1', () => { throw new Error('worktree add failed'); }), /worktree add failed/);
  assert.deepEqual(store.listChildRuns(), []);
  assert.deepEqual(store.listEvents(), []);
  const readOnly = store.createChildRun(input({ brief: brief({ kind: 'read-only', scope: [], acceptance: [] }), budgetLines: null, budgetFiles: null }), 'session:lead-1');
  assert.equal(readOnly.kind, 'read-only');
  assert.deepEqual([readOnly.worktree, readOnly.budgetLines], [null, null]);
});

test('progress updates are operational and write no events', async () => {
  const store = await memoryStore();
  store.createChildRun(input(), 'session:lead-1', tree);
  const before = store.listEvents().length;
  const run = store.updateChildRun('C-1', { childSession: 'child-s', pid: 4321, flags: ['over-budget'], spendUsd: 1.25, diffLines: 212, diffFiles: 3 });
  assert.deepEqual([run.childSession, run.pid, run.flags, run.spendUsd, run.diffLines, run.diffFiles], ['child-s', 4321, ['over-budget'], 1.25, 212, 3]);
  assert.equal(store.childRunForSession('child-s').id, 'C-1');
  assert.equal(store.childRunForSession('nope'), undefined);
  assert.equal(store.listEvents().length, before);
  assert.throws(() => store.updateChildRun('C-9', { pid: 1 }), /Unknown child run: C-9/);
  assert.throws(() => store.getChildRun('W-1'), /Invalid child run ID/);
});

test('endChildRun ends a running run once, and later calls change nothing', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.createChildRun(input(), 'session:lead-1', tree);
  now.advance(60_000);
  const acceptance = [{ command: 'node --test tests/a.test.mjs', exitCode: 0, summary: 'pass 3' }];
  const ended = store.endChildRun('C-1', { outcome: 'done', summary: 'Added retry', acceptance, diffLines: 40, diffFiles: 2 }, 'session:lead-1');
  assert.deepEqual([ended.outcome, ended.summary, ended.diffLines, ended.diffFiles], ['done', 'Added retry', 40, 2]);
  assert.deepEqual(ended.acceptance, acceptance);
  assert.equal(ended.endedAt, '2026-09-25T09:01:00.000Z');
  const count = store.listEvents().length;
  assert.equal(store.endChildRun('C-1', { outcome: 'stopped' }, 'user').outcome, 'done');
  assert.equal(store.listEvents().length, count);
  assert.equal(store.listEvents().at(-1).action, 'end');
});

test('only done runs merge, ended runs can be discarded, and lists filter by lead and outcome', async () => {
  const store = await memoryStore();
  store.createChildRun(input(), 'session:lead-1', tree);
  store.createChildRun(input(), 'session:lead-1', tree);
  store.createChildRun(input({ leadSession: 'lead-2' }), 'session:lead-2', tree);
  assert.throws(() => store.markChildRunMerged('C-1', 'session:lead-1'), /C-1 is running, not done/);
  assert.throws(() => store.markChildRunDiscarded('C-1', 'session:lead-1'), /C-1 is running and cannot be discarded/);
  store.endChildRun('C-1', { outcome: 'done' }, 'session:lead-1');
  const merged = store.markChildRunMerged('C-1', 'session:lead-1');
  assert.deepEqual([merged.outcome, merged.mergedAt], ['merged', '2026-09-25T09:00:00.000Z']);
  assert.throws(() => store.markChildRunDiscarded('C-1', 'session:lead-1'), /C-1 is merged and cannot be discarded/);
  store.endChildRun('C-2', { outcome: 'interrupted' }, 'session:lead-1');
  assert.equal(store.markChildRunDiscarded('C-2', 'session:lead-1').outcome, 'discarded');
  assert.deepEqual(store.listEvents().map((event) => `${event.entity} ${event.action}`), [
    'child:C-1 create', 'child:C-2 create', 'child:C-3 create', 'child:C-1 end', 'child:C-1 merge', 'child:C-2 end', 'child:C-2 discard',
  ]);
  assert.deepEqual(store.listChildRuns({ leadSession: 'lead-1' }).map((run) => run.id), ['C-1', 'C-2']);
  assert.deepEqual(store.listChildRuns({ outcome: 'running' }).map((run) => run.id), ['C-3']);
});

test('a version 2 database migrates to version 3, and backups carry child runs', () => {
  const path = join(tempDir(), 'work.db');
  const raw = new DatabaseSync(path);
  raw.exec(MIGRATIONS[0]);
  raw.exec(MIGRATIONS[1]);
  raw.exec('PRAGMA user_version = 2');
  raw.close();
  const store = WorkStore.open(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.isEmpty(), true);
  store.createChildRun(input(), 'session:lead-1', tree);
  assert.equal(store.dumpTables().child_run.length, 1);
  assert.equal(store.isEmpty(), false);
  store.close();
});
```

In `tests/work/store.test.mjs`, change line 17 to:

```js
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
```

In `tests/work/backup.test.mjs`, change line 26 to:

```js
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]), { format: 'work-backup', schema: 3 });
```

In `tests/work/session-store.test.mjs`, change line 107 to:

```js
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-store.test.mjs tests/work/store.test.mjs tests/work/backup.test.mjs tests/work/session-store.test.mjs`
Expected: FAIL. `store.createChildRun is not a function`, and the schema is `2`, not `3`.

- [ ] **Step 3: Add the migration**

In `src/work/migrations.ts`, replace the end of the array:

```ts
CREATE INDEX usage_at ON usage(at);
`,
];
```

with:

```ts
CREATE INDEX usage_at ON usage(at);
`,
	`
CREATE TABLE child_run (
	num INTEGER PRIMARY KEY AUTOINCREMENT,
	lead_session TEXT NOT NULL,
	child_session TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('implement', 'read-only')),
	brief TEXT NOT NULL,
	model TEXT NOT NULL,
	repo TEXT,
	worktree TEXT,
	branch TEXT,
	base_commit TEXT,
	pid INTEGER,
	outcome TEXT NOT NULL CHECK (outcome IN ('running', 'done', 'failed', 'over-budget', 'over-spend', 'incomplete', 'stopped', 'merged', 'discarded', 'interrupted')),
	flags TEXT NOT NULL DEFAULT '[]',
	spend_usd REAL NOT NULL DEFAULT 0,
	diff_lines INTEGER NOT NULL DEFAULT 0,
	diff_files INTEGER NOT NULL DEFAULT 0,
	budget_lines INTEGER,
	budget_files INTEGER,
	acceptance TEXT NOT NULL DEFAULT '[]',
	summary TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	ended_at TEXT,
	merged_at TEXT
);
CREATE INDEX child_run_lead ON child_run(lead_session);
CREATE INDEX child_run_child ON child_run(child_session);
`,
];
```

- [ ] **Step 4: Add the types**

Append to `src/work/types.ts`:

```ts
export type ChildKind = "implement" | "read-only";
export type ChildOutcome = "running" | "done" | "failed" | "over-budget" | "over-spend" | "incomplete" | "stopped" | "merged" | "discarded" | "interrupted";
export type ChildEndOutcome = "done" | "failed" | "over-budget" | "over-spend" | "incomplete" | "stopped" | "interrupted";
export type ChildFlag = "over-budget" | "over-spend" | "no-git" | "modified-files";
export const CHILD_KINDS: readonly ChildKind[] = ["implement", "read-only"];

export type Brief = {
	goal: string;
	kind: ChildKind;
	scope: string[];
	nonGoals: string[];
	acceptance: string[];
	context: string;
	model: string | null;
	modelReason: string | null;
	from: string | null;
};

export type AcceptanceResult = { command: string; exitCode: number | null; summary: string };

export type ChildRun = {
	id: string;
	leadSession: string;
	childSession: string | null;
	kind: ChildKind;
	brief: Brief;
	model: string;
	repo: string | null;
	worktree: string | null;
	branch: string | null;
	baseCommit: string | null;
	pid: number | null;
	outcome: ChildOutcome;
	flags: ChildFlag[];
	spendUsd: number;
	diffLines: number;
	diffFiles: number;
	budgetLines: number | null;
	budgetFiles: number | null;
	acceptance: AcceptanceResult[];
	summary: string;
	createdAt: string;
	endedAt: string | null;
	mergedAt: string | null;
};

export type ChildRunInput = { leadSession: string; brief: Brief; model: string; repo: string | null; budgetLines: number | null; budgetFiles: number | null };
export type ChildWorktree = { worktree: string; branch: string; baseCommit: string };
```

- [ ] **Step 5: Implement the store methods**

In `src/work/store.ts`, add these names to the `import type { … } from "./types.ts"` list, keeping it alphabetical: `AcceptanceResult`, `Brief`, `ChildEndOutcome`, `ChildFlag`, `ChildKind`, `ChildOutcome`, `ChildRun`, `ChildRunInput`, `ChildWorktree`.

After the `SESSION_COLUMNS` constant, add:

```ts
export type ChildRunPatch = { childSession?: string; pid?: number | null; flags?: ChildFlag[]; spendUsd?: number; diffLines?: number; diffFiles?: number };
export type ChildRunEnd = { outcome: ChildEndOutcome; summary?: string; acceptance?: AcceptanceResult[]; diffLines?: number; diffFiles?: number };

const CHILD_RUN_COLUMNS: Record<keyof ChildRunPatch, string> = {
	childSession: "child_session",
	pid: "pid",
	flags: "flags",
	spendUsd: "spend_usd",
	diffLines: "diff_lines",
	diffFiles: "diff_files",
};
const UNDISCARDABLE: readonly ChildOutcome[] = ["running", "merged", "discarded"];
```

Replace the `TABLES` line with:

```ts
const TABLES = ["project", "item", "link", "signal", "candidate", "dismissal", "plan", "event", "connector_run", "meta", "job", "child_run"] as const;
```

After `jobNum`, add:

```ts
export function childRunId(num: number): string {
	return `C-${num}`;
}

export function childRunNum(id: string): number {
	const match = /^C-(\d+)$/.exec(id.trim());
	if (!match) throw new WorkStoreError(`Invalid child run ID: ${id}`);
	return Number(match[1]);
}
```

After `toJob`, add:

```ts
function toChildRun(r: Row): ChildRun {
	return {
		id: childRunId(Number(r.num)),
		leadSession: String(r.lead_session),
		childSession: text(r.child_session),
		kind: r.kind as ChildKind,
		brief: json<Brief>(r.brief, {} as Brief),
		model: String(r.model),
		repo: text(r.repo),
		worktree: text(r.worktree),
		branch: text(r.branch),
		baseCommit: text(r.base_commit),
		pid: int(r.pid),
		outcome: r.outcome as ChildOutcome,
		flags: json<ChildFlag[]>(r.flags, []),
		spendUsd: Number(r.spend_usd),
		diffLines: Number(r.diff_lines),
		diffFiles: Number(r.diff_files),
		budgetLines: int(r.budget_lines),
		budgetFiles: int(r.budget_files),
		acceptance: json<AcceptanceResult[]>(r.acceptance, []),
		summary: String(r.summary),
		createdAt: String(r.created_at),
		endedAt: text(r.ended_at),
		mergedAt: text(r.merged_at),
	};
}
```

Inside the class, directly before `// Usage (operational: no events)`, add:

```ts
	// Child runs. Creating, ending, merging, and discarding are domain mutations; progress updates are operational.

	// The row is inserted first so prepare can name the worktree after the run ID, but the create event is
	// written only once prepare succeeds. A failed prepare removes the row, so no run is recorded.
	createChildRun(input: ChildRunInput, actor: Actor, prepare?: (id: string) => ChildWorktree): ChildRun {
		const num = this.run(
			"INSERT INTO child_run (lead_session, kind, brief, model, repo, outcome, budget_lines, budget_files, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)",
			input.leadSession, input.brief.kind, JSON.stringify(input.brief), input.model, input.repo, input.budgetLines, input.budgetFiles, this.now(),
		).lastInsertRowid;
		const id = childRunId(num);
		let tree: ChildWorktree | undefined;
		try {
			tree = prepare?.(id);
		} catch (error) {
			this.run("DELETE FROM child_run WHERE num = ?", num);
			throw error;
		}
		return this.transaction(() => {
			if (tree) this.run("UPDATE child_run SET worktree = ?, branch = ?, base_commit = ? WHERE num = ?", tree.worktree, tree.branch, tree.baseCommit, num);
			const run = this.getChildRun(id) as ChildRun;
			this.event(actor, `child:${id}`, "create", { after: run });
			return run;
		});
	}

	getChildRun(id: string): ChildRun | undefined {
		const row = this.one("SELECT * FROM child_run WHERE num = ?", childRunNum(id));
		return row ? toChildRun(row) : undefined;
	}

	listChildRuns(filter: { leadSession?: string; outcome?: ChildOutcome } = {}): ChildRun[] {
		const where: string[] = [];
		const params: Param[] = [];
		if (filter.leadSession) {
			where.push("lead_session = ?");
			params.push(filter.leadSession);
		}
		if (filter.outcome) {
			where.push("outcome = ?");
			params.push(filter.outcome);
		}
		return this.all(`SELECT * FROM child_run${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY num`, ...params).map(toChildRun);
	}

	childRunForSession(sessionId: string): ChildRun | undefined {
		const row = this.one("SELECT * FROM child_run WHERE child_session = ? ORDER BY num DESC LIMIT 1", sessionId);
		return row ? toChildRun(row) : undefined;
	}

	updateChildRun(id: string, patch: ChildRunPatch): ChildRun {
		if (!this.getChildRun(id)) throw new WorkStoreError(`Unknown child run: ${id}`);
		const keys = (Object.keys(patch) as (keyof ChildRunPatch)[]).filter((key) => patch[key] !== undefined);
		if (keys.length > 0) {
			const value = (key: keyof ChildRunPatch): Param => (key === "flags" ? JSON.stringify(patch.flags) : (patch[key] as Param));
			this.run(`UPDATE child_run SET ${keys.map((key) => `${CHILD_RUN_COLUMNS[key]} = ?`).join(", ")} WHERE num = ?`, ...keys.map(value), childRunNum(id));
		}
		return this.getChildRun(id) as ChildRun;
	}

	// Ends a running run once. Later calls (for example the lead, after the dashboard stopped the child) change nothing.
	endChildRun(id: string, end: ChildRunEnd, actor: Actor): ChildRun {
		return this.transaction(() => {
			const before = this.getChildRun(id);
			if (!before) throw new WorkStoreError(`Unknown child run: ${id}`);
			if (before.outcome !== "running") return before;
			this.run(
				"UPDATE child_run SET outcome = ?, summary = ?, acceptance = ?, diff_lines = ?, diff_files = ?, ended_at = ? WHERE num = ?",
				end.outcome,
				(end.summary ?? before.summary).trim().slice(0, NOTE_MAX),
				JSON.stringify(end.acceptance ?? before.acceptance),
				end.diffLines ?? before.diffLines,
				end.diffFiles ?? before.diffFiles,
				this.now(),
				childRunNum(id),
			);
			const after = this.getChildRun(id) as ChildRun;
			this.event(actor, `child:${id}`, "end", { before, after });
			return after;
		});
	}

	markChildRunMerged(id: string, actor: Actor): ChildRun {
		return this.transaction(() => {
			const before = this.getChildRun(id);
			if (!before) throw new WorkStoreError(`Unknown child run: ${id}`);
			if (before.outcome !== "done") throw new WorkStoreError(`${id} is ${before.outcome}, not done`);
			this.run("UPDATE child_run SET outcome = 'merged', merged_at = ? WHERE num = ?", this.now(), childRunNum(id));
			const after = this.getChildRun(id) as ChildRun;
			this.event(actor, `child:${id}`, "merge", { before, after });
			return after;
		});
	}

	markChildRunDiscarded(id: string, actor: Actor): ChildRun {
		return this.transaction(() => {
			const before = this.getChildRun(id);
			if (!before) throw new WorkStoreError(`Unknown child run: ${id}`);
			if (UNDISCARDABLE.includes(before.outcome)) throw new WorkStoreError(`${id} is ${before.outcome} and cannot be discarded`);
			this.run("UPDATE child_run SET outcome = 'discarded', ended_at = COALESCE(ended_at, ?) WHERE num = ?", this.now(), childRunNum(id));
			const after = this.getChildRun(id) as ChildRun;
			this.event(actor, `child:${id}`, "discard", { before, after });
			return after;
		});
	}

```

In `isEmpty`, replace the table list with:

```ts
		for (const table of ["item", "link", "candidate", "plan", "dismissal", "job", "child_run"]) {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/work/child-store.test.mjs tests/work/store.test.mjs tests/work/backup.test.mjs tests/work/session-store.test.mjs`
Expected: PASS.

Run: `npm test && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/work/migrations.ts src/work/types.ts src/work/store.ts tests/work/child-store.test.mjs tests/work/store.test.mjs tests/work/backup.test.mjs tests/work/session-store.test.mjs
git commit -m "feat: record child runs in schema version 3"
```

---

### Task 3: Command and path guards

**Files:**
- Create: `src/work/children/guards.ts`
- Test: `tests/work/child-guards.test.mjs`

**Interfaces:**
- Consumes: nothing. The module is pure.
- Produces:
  - `EXPENSIVE_MESSAGE` (the spec's text, verbatim), `BUILT_IN_IGNORE: readonly string[]`
  - `commandSegments(command: string): string[]`
  - `restrictedVerdict(command: string): string | undefined` (a `Blocked: …` reason, or nothing)
  - `expensiveVerdict(command: string, extra?: readonly string[]): string | undefined` (`extra` holds regular expressions from the config)
  - `overBudgetAllowed(command: string, acceptance: readonly string[]): boolean`
  - `globRegExp(pattern: string): RegExp`, `inScope(path: string, scope: readonly string[]): boolean`, `isIgnored(path: string, patterns: readonly string[]): boolean`. Paths are repository-relative and use `/`.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-guards.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const guards = await load('src/work/children/guards.ts');

const EXPENSIVE = {
  'npm test': true, 'npm run test': true, 'pnpm test': true, 'yarn test': true, 'npm test -- tests/a.test.mjs': false,
  'cd pkg && npm test 2>&1 | tail -5': true, 'CI=1 npm test': true, 'npm test > out.txt': true,
  pytest: true, 'pytest -x -q': true, 'pytest tests/test_a.py': false, 'pytest tests/test_a.py::test_b -x': false, 'python -m pytest': true, 'uv run pytest -q': true,
  'go test ./...': true, 'go test -race ./...': true, 'go test ./pkg/...': false,
  'cargo test': true, 'cargo test --release': true, 'cargo test -p core': false, 'cargo test --package core': false, 'cargo test parse_': false,
  'bazel test //...': true, 'bazel test //pkg/...': false,
  'make test': true, 'make test FILE=a': false,
  tox: true, 'tox -p': true, 'tox -e py311': false,
  'ddev test': true, 'ddev test -c': true, 'ddev test mycheck': false,
  'node --test tests/work/a.test.mjs': false, 'echo npm test': false,
};

const RESTRICTED = {
  'git push': /git push/, 'git push origin HEAD': /git push/, 'git -C /src/api push': /git push/, 'git status && git push': /git push/,
  'git remote add up x': /remotes/, 'git remote set-url origin y': /remotes/,
  'gh pr create --draft': /gh pr/, 'gh pr view 1': /gh pr/, 'gh api -X POST repos/x': /gh api/, 'gh api --method=PATCH x': /gh api/, 'gh api repos/x -f a=b': /gh api/,
  'git reset --hard HEAD~1': /history/, 'git rebase -i HEAD~2': /history/, 'git commit --amend': /history/, 'git commit -m x --amend --no-edit': /history/,
  'git switch main': /branches/, 'git checkout main': /branches/, 'git checkout -b other': /branches/,
  'npm install left-pad': /dependency/, 'npm i -D left-pad': /dependency/, 'yarn add x': /dependency/, 'pnpm add x': /dependency/, 'pip install x': /dependency/,
  'python -m pip install x': /dependency/, 'uv add x': /dependency/, 'uv pip install x': /dependency/, 'poetry add x': /dependency/, 'go get x': /dependency/, 'cargo add x': /dependency/,
};
const ALLOWED = ['git remote -v', 'gh api repos/x/y', 'gh api -X GET x', 'git reset HEAD src/a.ts', 'git commit -m x', 'git checkout -- src/a.ts', 'npm install', 'npm ci', 'uv sync', 'git diff'];

test('expensive-command patterns block repository-wide test runs only', () => {
  for (const [command, blocked] of Object.entries(EXPENSIVE)) {
    assert.equal(guards.expensiveVerdict(command) === guards.EXPENSIVE_MESSAGE, blocked, command);
  }
  assert.equal(guards.EXPENSIVE_MESSAGE, 'Blocked: repository-wide test run. Run only the tests covering the files you changed. Full-suite verification runs in CI on the draft PR.');
});

test('per-repository expensive commands are regular expressions matched per segment', () => {
  assert.equal(guards.expensiveVerdict('make e2e', ['^make e2e$']), guards.EXPENSIVE_MESSAGE);
  assert.equal(guards.expensiveVerdict('cd x && make e2e', ['^make e2e$']), guards.EXPENSIVE_MESSAGE);
  assert.equal(guards.expensiveVerdict('make e2e-one', ['^make e2e$']), undefined);
  assert.equal(guards.expensiveVerdict('make e2e', ['(broken']), undefined);
});

test('restricted actions are always blocked, with a reason', () => {
  for (const [command, reason] of Object.entries(RESTRICTED)) {
    const verdict = guards.restrictedVerdict(command);
    assert.match(verdict ?? '', /^Blocked: /, command);
    assert.match(verdict, reason, command);
  }
  for (const command of ALLOWED) assert.equal(guards.restrictedVerdict(command), undefined, command);
});

test('commandSegments splits chains and drops redirections and leading assignments', () => {
  assert.deepEqual(guards.commandSegments('cd pkg && FOO=1 BAR=2 npm test 2>&1 | tail -5; (git status)'), ['cd pkg', 'npm test', 'tail -5', 'git status']);
});

test('over budget, only git bookkeeping and the acceptance commands may run', () => {
  const acceptance = ['node --test tests/a.test.mjs'];
  for (const command of ['git status', 'git diff --stat', 'git log -3', 'git add -A && git commit -m "wip; partial"', 'git add src/a.ts; git commit -m wip', 'node --test tests/a.test.mjs']) {
    assert.equal(guards.overBudgetAllowed(command, acceptance), true, command);
  }
  for (const command of ['ls', 'git status; rm -rf src', 'git commit -m "$(rm -rf x)"', 'git diff > out.txt', 'git status | sh', 'node --test tests/b.test.mjs']) {
    assert.equal(guards.overBudgetAllowed(command, acceptance), false, command);
  }
});

test('globs support **, *, and ?, and a plain directory scope covers its contents', () => {
  const cases = [
    ['**/generated/**', 'src/generated/a.ts', true], ['**/generated/**', 'generated/a.ts', true], ['**/generated/**', 'src/gen/a.ts', false],
    ['src/**', 'src/a/b.ts', true], ['src/**', 'tests/a.ts', false], ['src/*.ts', 'src/a.ts', true], ['src/*.ts', 'src/a/b.ts', false],
    ['src/**/*.ts', 'src/a.ts', true], ['src/**/*.ts', 'src/x/y/a.ts', true], ['a?.ts', 'ab.ts', true], ['a.ts', 'abts', false],
  ];
  for (const [pattern, path, expected] of cases) assert.equal(guards.globRegExp(pattern).test(path), expected, `${pattern} ${path}`);
  assert.equal(guards.inScope('src/work/a.ts', ['src/work']), true);
  assert.equal(guards.inScope('src/workers/a.ts', ['src/work']), false);
  assert.equal(guards.inScope('src/a.ts', ['./src/**']), true);
  assert.equal(guards.inScope('docs/README.md', ['README.md']), false);
});

test('ignore patterns without a slash match the basename', () => {
  assert.equal(guards.isIgnored('packages/web/package-lock.json', guards.BUILT_IN_IGNORE), true);
  assert.equal(guards.isIgnored('src/__snapshots__/a.snap', guards.BUILT_IN_IGNORE), true);
  assert.equal(guards.isIgnored('src/a.ts', guards.BUILT_IN_IGNORE), false);
  assert.equal(guards.isIgnored('deps/x.lock', ['*.lock']), true);
  assert.equal(guards.isIgnored('src/fixtures/a.json', ['src/fixtures/**']), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-guards.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/guards.ts`.

- [ ] **Step 3: Implement the guards**

Create `src/work/children/guards.ts`:

```ts
// Pure command and path checks for child agents. They catch accidents, not a hostile model:
// a command hidden inside `sh -c "…"` is not inspected.

export const EXPENSIVE_MESSAGE = "Blocked: repository-wide test run. Run only the tests covering the files you changed. Full-suite verification runs in CI on the draft PR.";

export const BUILT_IN_IGNORE: readonly string[] = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"uv.lock",
	"poetry.lock",
	"Cargo.lock",
	"go.sum",
	"**/__snapshots__/**",
	"**/vendor/**",
	"**/generated/**",
];

// Each pattern matches one normalized segment (single spaces, no redirections, no leading assignments).
const BUILT_IN_EXPENSIVE: readonly RegExp[] = [
	/^(?:npm|pnpm|yarn)(?: run)? test$/,
	/^(?:(?:uv|poetry) run |python3? -m )?pytest(?: -\S+)*$/,
	/^go test(?: \S+)* \.\/\.\.\.(?: \S+)*$/,
	/^cargo test(?: -(?!p$|p |-package\b)\S*)*$/,
	/^bazel test(?: \S+)* \/\/\.\.\.(?: \S+)*$/,
	/^make test$/,
	/^tox(?: (?!-e)\S+)*$/,
	/^ddev test(?: -\S+)*$/,
];

const GIT = String.raw`git(?: -[Cc] \S+)* `;
const HISTORY = "Blocked: rewriting history. Make a new commit instead.";
const BRANCHES = "Blocked: switching branches. Stay on your branch; restore files with git restore or git checkout -- <paths>.";
const DEPENDENCY = "Blocked: adding a dependency. Needing a dependency is a question for the lead: end with session_status needs-me, naming the package and why.";

const RESTRICTED: readonly { pattern: RegExp; message: string }[] = [
	{ pattern: new RegExp(`^${GIT}push\\b`), message: "Blocked: git push. The lead merges and pushes your branch; commit and end with session_status." },
	{ pattern: new RegExp(`^${GIT}remote (?:add|set-url|remove|rm|rename|set-head|set-branches|prune|update)\\b`), message: "Blocked: changing git remotes." },
	{ pattern: /^gh pr\b/, message: "Blocked: gh pr. The lead owns the pull request." },
	{ pattern: /^gh api\b(?=.*(?: (?:-X|--method)(?: |=)(?!GET\b)[A-Za-z]+| (?:-f|-F|--field|--raw-field|--input)(?: |=)))/, message: "Blocked: gh api writes." },
	{ pattern: new RegExp(`^${GIT}reset\\b.* --hard\\b`), message: HISTORY },
	{ pattern: new RegExp(`^${GIT}rebase\\b`), message: HISTORY },
	{ pattern: new RegExp(`^${GIT}commit\\b.* --amend\\b`), message: HISTORY },
	{ pattern: new RegExp(`^${GIT}switch\\b`), message: BRANCHES },
	{ pattern: new RegExp(`^${GIT}checkout\\b(?!.* --(?: |$))`), message: BRANCHES },
	{ pattern: /^(?:npm|pnpm|yarn) (?:install|i|add)(?: -\S+)* [^\s-]/, message: DEPENDENCY },
	{ pattern: /^(?:pip3?|python3? -m pip) install\b/, message: DEPENDENCY },
	{ pattern: /^uv (?:add|pip install)\b/, message: DEPENDENCY },
	{ pattern: /^(?:poetry add|go get|cargo add)\b/, message: DEPENDENCY },
];

const OVER_BUDGET_COMMANDS = /^git (?:status|diff|log|add|commit)(?: |$)/;

export function commandSegments(command: string): string[] {
	return command
		.replace(/\d*>&\d*/g, " ")
		.replace(/\d*>>?\s*\S+/g, " ")
		.replace(/<\s*\S+/g, " ")
		.split(/&&|\|\||[;|&\n()]/)
		.map((part) => part.trim().replace(/\s+/g, " ").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )+/, ""))
		.filter(Boolean);
}

function compile(patterns: readonly string[]): RegExp[] {
	return patterns.flatMap((pattern) => {
		try {
			return [new RegExp(pattern)];
		} catch {
			return [];
		}
	});
}

export function expensiveVerdict(command: string, extra: readonly string[] = []): string | undefined {
	const patterns = [...BUILT_IN_EXPENSIVE, ...compile(extra)];
	return commandSegments(command).some((segment) => patterns.some((pattern) => pattern.test(segment))) ? EXPENSIVE_MESSAGE : undefined;
}

export function restrictedVerdict(command: string): string | undefined {
	for (const segment of commandSegments(command)) {
		const rule = RESTRICTED.find((candidate) => candidate.pattern.test(segment));
		if (rule) return rule.message;
	}
	return undefined;
}

// Over budget, a child may still commit: git status, diff, log, add, and commit (alone or chained with && and ;),
// and the brief's acceptance commands exactly. Quoted text is ignored, unless double quotes hold $ or backticks.
export function overBudgetAllowed(command: string, acceptance: readonly string[]): boolean {
	const trimmed = command.trim();
	if (acceptance.some((allowed) => allowed.trim() === trimmed)) return true;
	const unquoted = trimmed.replace(/'[^']*'/g, "''").replace(/"[^"$`\\]*"/g, '""');
	if (/[|<>$`()]|(?<!&)&(?!&)/.test(unquoted)) return false;
	return unquoted.split(/&&|;|\n/).every((part) => OVER_BUDGET_COMMANDS.test(part.trim().replace(/\s+/g, " ")));
}

export function globRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			const slash = pattern[i + 2] === "/";
			source += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

export function inScope(path: string, scope: readonly string[]): boolean {
	return scope.some((raw) => {
		const pattern = raw.replace(/^\.\//, "").replace(/\/$/, "");
		if (/[*?]/.test(pattern)) return globRegExp(pattern).test(path);
		return path === pattern || path.startsWith(`${pattern}/`);
	});
}

export function isIgnored(path: string, patterns: readonly string[]): boolean {
	const base = path.slice(path.lastIndexOf("/") + 1);
	return patterns.some((pattern) => globRegExp(pattern).test(pattern.includes("/") ? path : base));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-guards.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/children/guards.ts tests/work/child-guards.test.mjs
git commit -m "feat: add command and path guards for child agents"
```

---

### Task 4: Git helpers and diff measurement

**Files:**
- Create: `src/work/children/git.ts`
- Modify: `tests/work/helpers.mjs`: git repository, file, JSON Lines, and polling helpers
- Test: `tests/work/child-git.test.mjs`

**Interfaces:**
- Consumes: `GitRunner` from `src/work/rules.ts`, `isIgnored` (Task 3), `errorMessage` from `src/work/secrets.ts`.
- Produces:
  - `runGit: GitRunner`, which runs with `core.quotePath=false`, trims stdout, and throws git's stderr as the error message
  - `gitText(git, cwd, args): string | undefined` (undefined on failure or empty output)
  - `DiffStats = { lines: number; files: number }`, `parseNumstat(output): { added: number; deleted: number; path: string }[]`
  - `measureDiff(git, cwd, { from: string; to?: string; ignore: readonly string[] }): DiffStats`. Without `to`, it measures the working tree and counts untracked files by line.
  - `isClean(git, cwd): boolean`, `commitsSince(git, cwd, base, ref?): number`
  - `defaultBranchRef(git, cwd): string | undefined` (for example `origin/main`, or a local `main` or `master`), `isDefaultBranch(branch, defaultRef): boolean`
  - `excludeChildWorktrees(git, root): void`, `addWorktree(git, root, path, branch, start): void`, `removeWorktree(git, root, path: string | null, branch: string | null): void` (best effort)
  - `parseGithubRepo(url): string | undefined` (`owner/name`)
  - Test helpers: `git(cwd, ...args)`, `writeFiles(dir, files)`, `gitRepo(files?)` (a committed repository on `main` with a local identity, no signing, and no hooks), `readJsonl(path)`, and `until(check, timeoutMs?)`

- [ ] **Step 1: Add the test helpers**

In `tests/work/helpers.mjs`, replace the first five lines (the imports) with:

```js
import { createJiti } from 'jiti';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Append to `tests/work/helpers.mjs`:

```js
export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// A committed repository on main with a local identity, no commit signing, and no hooks.
export function gitRepo(files = { 'README.md': 'hello\n' }) {
  const dir = realpathSync(tempDir());
  git(dir, 'init', '-q', '-b', 'main');
  configureGit(dir);
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export function configureGit(dir) {
  for (const [key, value] of [['user.email', 'pi@example.com'], ['user.name', 'Pi Test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) {
    git(dir, 'config', key, value);
  }
}

export function readJsonl(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

export async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/work/child-git.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitRepo, load, tempDir, writeFiles } from './helpers.mjs';

const g = await load('src/work/children/git.ts');
const { BUILT_IN_IGNORE } = await load('src/work/children/guards.ts');

test('measureDiff counts tracked changes and untracked files, skipping ignored paths', () => {
  const dir = gitRepo({ 'src/a.ts': 'one\ntwo\n', 'package-lock.json': '{}\n' });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFiles(dir, { 'src/a.ts': 'one\nTWO\nthree\n', 'src/new.ts': 'x\ny\nz', 'package-lock.json': '{"a":1}\n', 'src/generated/g.ts': 'g\n' });
  assert.deepEqual(g.measureDiff(g.runGit, dir, { from: base, ignore: BUILT_IN_IGNORE }), { lines: 6, files: 2 });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'work');
  assert.deepEqual(g.measureDiff(g.runGit, dir, { from: base, to: 'HEAD', ignore: [] }), { lines: 9, files: 4 });
  assert.deepEqual(g.measureDiff(g.runGit, dir, { from: base, to: 'HEAD', ignore: ['src/new.ts'] }), { lines: 6, files: 3 });
});

test('parseNumstat reads binary files as zero lines', () => {
  assert.deepEqual(g.parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n'), [{ added: 3, deleted: 1, path: 'src/a.ts' }, { added: 0, deleted: 0, path: 'img.png' }]);
});

test('child worktrees are excluded locally, so the lead stays clean', () => {
  const dir = gitRepo();
  g.excludeChildWorktrees(g.runGit, dir);
  g.excludeChildWorktrees(g.runGit, dir);
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.pi/worktrees/').length, 1);
  const path = join(dir, '.pi', 'worktrees', 'child-C-1');
  g.addWorktree(g.runGit, dir, path, 'child/feat/C-1', 'HEAD');
  assert.equal(g.isClean(g.runGit, dir), true);
  writeFiles(path, { 'b.ts': 'b\n' });
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'child');
  assert.equal(g.commitsSince(g.runGit, dir, 'main', 'child/feat/C-1'), 1);
  g.removeWorktree(g.runGit, dir, path, 'child/feat/C-1');
  g.removeWorktree(g.runGit, dir, path, 'child/feat/C-1');
  assert.equal(existsSync(path), false);
  assert.equal(git(dir, 'branch', '--list', 'child/feat/C-1'), '');
  writeFiles(dir, { 'README.md': 'changed\n' });
  assert.equal(g.isClean(g.runGit, dir), false);
});

test('the default branch comes from origin/HEAD, with main and master as fallbacks', () => {
  const seed = gitRepo();
  const root = realpathSync(tempDir());
  git(root, 'clone', '-q', seed, 'clone');
  assert.equal(g.defaultBranchRef(g.runGit, join(root, 'clone')), 'origin/main');
  assert.equal(g.defaultBranchRef(g.runGit, seed), 'main');
  assert.equal(g.isDefaultBranch('main', undefined), true);
  assert.equal(g.isDefaultBranch('master', 'origin/main'), true);
  assert.equal(g.isDefaultBranch('trunk', 'origin/trunk'), true);
  assert.equal(g.isDefaultBranch('feat/x', 'origin/main'), false);
});

test('runGit reports git errors, and gitText turns failures into undefined', () => {
  const dir = tempDir();
  assert.throws(() => g.runGit(dir, ['rev-parse', 'HEAD']), /not a git repository/);
  assert.equal(g.gitText(g.runGit, dir, ['rev-parse', 'HEAD']), undefined);
  const repo = gitRepo();
  assert.equal(g.gitText(g.runGit, repo, ['branch', '--show-current']), 'main');
});

test('parseGithubRepo reads SSH and HTTPS remotes', () => {
  assert.equal(g.parseGithubRepo('git@github.com:example-org/api.git'), 'example-org/api');
  assert.equal(g.parseGithubRepo('https://github.com/example-org/api.git'), 'example-org/api');
  assert.equal(g.parseGithubRepo('https://github.com/example-org/api'), 'example-org/api');
  assert.equal(g.parseGithubRepo('/srv/git/api.git'), undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/work/child-git.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/git.ts`.

- [ ] **Step 4: Implement the helpers**

Create `src/work/children/git.ts`:

```ts
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRunner } from "../rules.ts";
import { errorMessage } from "../secrets.ts";
import { isIgnored } from "./guards.ts";

export type DiffStats = { lines: number; files: number };
export type NumstatEntry = { added: number; deleted: number; path: string };

const EXCLUDE_LINE = "/.pi/worktrees/";

// Like the tracker's git runner, but keeps git's own error text, which callers report to the lead.
export const runGit: GitRunner = (cwd, args) => {
	try {
		return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
			maxBuffer: 64 * 1024 * 1024,
		}).trim();
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		throw new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim() : errorMessage(error));
	}
};

export function gitText(git: GitRunner, cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args) || undefined;
	} catch {
		return undefined;
	}
}

export function parseNumstat(output: string): NumstatEntry[] {
	return output
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [added = "0", deleted = "0", ...path] = line.split("\t");
			return { added: Number(added) || 0, deleted: Number(deleted) || 0, path: path.join("\t") };
		});
}

function fileLines(path: string): number {
	try {
		const data = readFileSync(path);
		if (data.length === 0 || data.includes(0)) return 0;
		const text = data.toString("utf8");
		return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	} catch {
		return 0;
	}
}

// Lines added plus deleted, and files touched, from `from` to `to`, or to the working tree plus untracked files.
export function measureDiff(git: GitRunner, cwd: string, options: { from: string; to?: string; ignore: readonly string[] }): DiffStats {
	const range = options.to ? [options.from, options.to] : [options.from];
	const entries = parseNumstat(git(cwd, ["diff", "--numstat", "--no-renames", ...range]));
	if (!options.to) {
		for (const path of git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
			entries.push({ added: fileLines(join(cwd, path)), deleted: 0, path });
		}
	}
	const counted = entries.filter((entry) => !isIgnored(entry.path, options.ignore));
	return {
		lines: counted.reduce((sum, entry) => sum + entry.added + entry.deleted, 0),
		files: new Set(counted.map((entry) => entry.path)).size,
	};
}

export function isClean(git: GitRunner, cwd: string): boolean {
	return git(cwd, ["status", "--porcelain"]) === "";
}

export function commitsSince(git: GitRunner, cwd: string, base: string, ref = "HEAD"): number {
	return Number(git(cwd, ["rev-list", "--count", `${base}..${ref}`])) || 0;
}

// The remote default branch (for example origin/main), or a local main or master when origin/HEAD is unset.
export function defaultBranchRef(git: GitRunner, cwd: string): string | undefined {
	const remote = gitText(git, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remote) return remote;
	return ["main", "master"].find((name) => gitText(git, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]));
}

export function isDefaultBranch(branch: string, defaultRef: string | undefined): boolean {
	return branch === "main" || branch === "master" || (defaultRef !== undefined && defaultRef.replace(/^origin\//, "") === branch);
}

// Child worktrees live inside the repository, so they are excluded locally to keep the lead's tree clean.
export function excludeChildWorktrees(git: GitRunner, root: string): void {
	const file = join(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "info", "exclude");
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (current.split("\n").includes(EXCLUDE_LINE)) return;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
}

export function addWorktree(git: GitRunner, root: string, path: string, branch: string, start: string): void {
	git(root, ["worktree", "add", "-q", "-b", branch, path, start]);
}

export function removeWorktree(git: GitRunner, root: string, path: string | null, branch: string | null): void {
	if (path) {
		try {
			git(root, ["worktree", "remove", "--force", path]);
		} catch {
			// Already gone.
		}
	}
	if (branch) {
		try {
			git(root, ["branch", "-D", branch]);
		} catch {
			// Already gone.
		}
	}
}

export function parseGithubRepo(url: string): string | undefined {
	return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/child-git.test.mjs && npm test && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/children/git.ts tests/work/helpers.mjs tests/work/child-git.test.mjs
git commit -m "feat: add git helpers and diff measurement for child worktrees"
```

- [ ] **Step 7: Run the part 1 gates**

Run: `npm test && npm run -s typecheck && npm run -s check`
Expected: PASS. `check` prints `repository-boundary-ok`.

- [ ] **Step 8: STOP for review (end of part 1)**

Report the commits of this part and any deviations. Do not start part 2.

---

# Part 2: Guards Inside Children

### Task 5: Child guard state

**Files:**
- Create: `src/work/children/child-guard.ts`
- Test: `tests/work/child-guard-state.test.mjs`

**Interfaces:**
- Consumes: `ChildrenConfig` and `repoChildrenConfig` (Task 1), `ChildRun` and `ChildFlag` (Task 2), the guards (Task 3), `measureDiff` and `DiffStats` (Task 4).
- Produces:
  - `CHILD_RUN_ENV = "PI_WORK_CHILD_RUN"`, `PARENT_PID_ENV = "PI_WORK_PARENT_PID"`
  - `GuardBlock = { block: true; reason: string }`, `GuardRecord = { flags?; spendUsd?; diffLines?; diffFiles? }`
  - `ChildGuardDeps = { run: ChildRun; config: ChildrenConfig; cwd: string; git: GitRunner; record(patch: GuardRecord): void; abort(): void }`
  - `ChildGuard = { readonly flags: readonly ChildFlag[]; toolCall(toolName, input): GuardBlock | undefined; toolResult(toolName): string | undefined; assistantCost(cost: number): void; agentEnd(): void }`. `toolCall` may set `input.timeout` on `bash` calls. `toolResult` returns warning text to append.
  - `createChildGuard(deps): ChildGuard`, `failClosedGuard(reason): ChildGuard`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-guard-state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { git, gitRepo, load, tempDir, writeFiles } from './helpers.mjs';

const { createChildGuard, failClosedGuard } = await load('src/work/children/child-guard.ts');
const { runGit } = await load('src/work/children/git.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

function makeRun(overrides = {}) {
  return {
    id: 'C-1', leadSession: 'lead-1', childSession: null, kind: 'implement',
    brief: { goal: 'Add retry', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null },
    model: 'anthropic/claude-sonnet-5', repo: 'api', worktree: null, branch: null, baseCommit: null, pid: null, outcome: 'running', flags: [], spendUsd: 0,
    diffLines: 0, diffFiles: 0, budgetLines: 300, budgetFiles: 8, acceptance: [], summary: '', createdAt: 't', endedAt: null, mergedAt: null, ...overrides,
  };
}

function guarded({ run = {}, config = DEFAULT_CHILDREN, cwd } = {}) {
  const dir = cwd ?? gitRepo({ 'src/a.ts': 'one\n' });
  const records = [];
  const aborts = [];
  const baseCommit = cwd ? null : git(dir, 'rev-parse', 'HEAD');
  const guard = createChildGuard({ run: makeRun({ worktree: dir, baseCommit, ...run }), config, cwd: dir, git: runGit, record: (patch) => records.push(patch), abort: () => aborts.push(true) });
  return { guard, dir, records, aborts };
}
const merged = (records) => Object.assign({}, ...records);

test('edits are allowed only inside the worktree and the scope', () => {
  const { guard, dir } = guarded();
  assert.equal(guard.toolCall('edit', { path: 'src/a.ts' }), undefined);
  assert.equal(guard.toolCall('write', { path: `${dir}/src/new/b.ts` }), undefined);
  assert.match(guard.toolCall('write', { path: 'docs/x.md' }).reason, /^Blocked: docs\/x\.md is outside your scope \(src\/\*\*\)/);
  assert.match(guard.toolCall('edit', { path: '../other/src/a.ts' }).reason, /outside your worktree/);
  assert.match(guard.toolCall('write', { path: '.git/config' }).reason, /outside your worktree/);
  assert.equal(guard.toolCall('read', { path: '/etc/hosts' }), undefined);
});

test('shell commands are checked for restricted actions and full test runs, and get the timeout', () => {
  const config = { ...DEFAULT_CHILDREN, commandTimeoutMinutes: 2, repos: { api: { ignore: [], expensiveCommands: ['^make e2e$'] } } };
  const { guard } = guarded({ config });
  assert.match(guard.toolCall('bash', { command: 'git push origin HEAD' }).reason, /^Blocked: git push/);
  assert.match(guard.toolCall('bash', { command: 'npm test' }).reason, /repository-wide test run/);
  assert.match(guard.toolCall('bash', { command: 'make e2e' }).reason, /repository-wide test run/);
  const long = { command: 'node --test tests/a.test.mjs', timeout: 9999 };
  assert.equal(guard.toolCall('bash', long), undefined);
  assert.equal(long.timeout, 120);
  const short = { command: 'ls', timeout: 5 };
  guard.toolCall('bash', short);
  assert.equal(short.timeout, 5);
  const none = { command: 'ls' };
  guard.toolCall('bash', none);
  assert.equal(none.timeout, 120);
});

test('the diff budget warns at the threshold, then blocks edits and limits the shell', () => {
  const { guard, dir, records } = guarded({ run: { budgetLines: 10, budgetFiles: 8 } });
  writeFiles(dir, { 'src/b.ts': '1\n2\n3\n4\n5\n6\n7\n' });
  assert.equal(guard.toolResult('write'), undefined);
  writeFiles(dir, { 'src/c.ts': '1\n' });
  assert.equal(guard.toolResult('write'), 'Budget 8/10 lines: finish the smallest working change.');
  writeFiles(dir, { 'src/d.ts': '1\n2\n' });
  assert.match(guard.toolResult('bash'), /^Budget reached \(10\/10 lines, 3\/8 files\)\. Edits are blocked\. Commit what you have/);
  assert.deepEqual(merged(records), { diffLines: 10, diffFiles: 3, flags: ['over-budget'] });
  assert.deepEqual(guard.flags, ['over-budget']);
  assert.match(guard.toolCall('edit', { path: 'src/a.ts' }).reason, /diff budget is used up/);
  assert.match(guard.toolCall('bash', { command: 'ls' }).reason, /Allowed now: git status/);
  for (const command of ['git status', 'git diff --stat', 'git add -A && git commit -m "wip; partial"', 'node --test tests/a.test.mjs']) {
    assert.equal(guard.toolCall('bash', { command }), undefined, command);
  }
  assert.ok(guard.toolCall('bash', { command: 'git status; rm -rf src' }));
});

test('the file count has its own warning and limit, and ignored paths do not count', () => {
  const config = { ...DEFAULT_CHILDREN, repos: { api: { ignore: ['src/fixtures/**'], expensiveCommands: [] } } };
  const { guard, dir, records } = guarded({ config, run: { budgetFiles: 5 } });
  writeFiles(dir, { 'package-lock.json': '{}\n'.repeat(50), 'src/fixtures/big.json': 'x\n'.repeat(50) });
  writeFiles(dir, { 'src/1.ts': 'a\n', 'src/2.ts': 'a\n', 'src/3.ts': 'a\n', 'src/4.ts': 'a\n' });
  assert.equal(guard.toolResult('edit'), 'Budget 4/5 files: finish the smallest working change.');
  assert.deepEqual(records.at(-1), { diffLines: 4, diffFiles: 4 });
  writeFiles(dir, { 'src/5.ts': 'a\n' });
  assert.match(guard.toolResult('edit'), /^Budget reached \(5\/300 lines, 5\/5 files\)/);
});

test('spend warns once at the threshold, and at the cap aborts, blocks, and commits the work', () => {
  const { guard, dir, records, aborts } = guarded();
  guard.assistantCost(3);
  assert.equal(guard.toolResult('read'), undefined);
  guard.assistantCost(1.5);
  assert.equal(guard.toolResult('read'), 'Spend $4.50 of $5.00: finish the smallest working change.');
  assert.equal(guard.toolResult('read'), undefined);
  writeFiles(dir, { 'src/b.ts': 'partial\n' });
  guard.assistantCost(1);
  guard.assistantCost(1);
  assert.equal(aborts.length, 1);
  assert.deepEqual(guard.flags, ['over-spend']);
  assert.deepEqual(records.filter((r) => 'spendUsd' in r).map((r) => r.spendUsd), [3, 4.5, 5.5, 6.5]);
  assert.match(guard.toolCall('bash', { command: 'ls' }).reason, /spending cap/);
  guard.agentEnd();
  guard.agentEnd();
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'WIP: C-1 stopped at the spend cap');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a read-only run blocks edits and flags shell commands that change the lead directory', () => {
  const { guard, dir, records } = guarded({ run: { kind: 'read-only', budgetLines: null, budgetFiles: null, baseCommit: null } });
  assert.match(guard.toolCall('write', { path: 'src/a.ts' }).reason, /read-only run/);
  assert.equal(guard.toolResult('bash'), undefined);
  writeFiles(dir, { 'notes.txt': 'x\n' });
  assert.match(guard.toolResult('bash'), /changed files in the lead's working directory/);
  assert.equal(guard.toolResult('bash'), undefined);
  assert.deepEqual(merged(records), { flags: ['modified-files'] });
  assert.equal(git(dir, 'status', '--porcelain'), '?? notes.txt');
});

test('without git the budget cannot be measured, so edits are blocked', () => {
  const { guard, records } = guarded({ cwd: tempDir(), run: { baseCommit: 'abc123' } });
  assert.deepEqual(merged(records), { flags: ['no-git'] });
  assert.match(guard.toolCall('edit', { path: 'src/a.ts' }).reason, /git is unavailable/);
});

test('failClosedGuard blocks edits and the shell but allows reading', () => {
  const guard = failClosedGuard('Blocked: registry down.');
  assert.deepEqual(guard.toolCall('bash', { command: 'ls' }), { block: true, reason: 'Blocked: registry down.' });
  assert.deepEqual(guard.toolCall('edit', { path: 'a' }), { block: true, reason: 'Blocked: registry down.' });
  assert.equal(guard.toolCall('read', { path: 'a' }), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-guard-state.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/child-guard.ts`.

- [ ] **Step 3: Implement the guard state**

Create `src/work/children/child-guard.ts`:

```ts
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { GitRunner } from "../rules.ts";
import type { ChildFlag, ChildRun } from "../types.ts";
import type { DiffStats } from "./git.ts";
import { measureDiff } from "./git.ts";
import { BUILT_IN_IGNORE, expensiveVerdict, inScope, overBudgetAllowed, restrictedVerdict } from "./guards.ts";

export const CHILD_RUN_ENV = "PI_WORK_CHILD_RUN";
export const PARENT_PID_ENV = "PI_WORK_PARENT_PID";

export type GuardBlock = { block: true; reason: string };
export type GuardRecord = { flags?: ChildFlag[]; spendUsd?: number; diffLines?: number; diffFiles?: number };
export type ChildGuardDeps = {
	run: ChildRun;
	config: ChildrenConfig;
	cwd: string;
	git: GitRunner;
	record: (patch: GuardRecord) => void;
	abort: () => void;
};
export type ChildGuard = {
	readonly flags: readonly ChildFlag[];
	toolCall(toolName: string, input: Record<string, unknown>): GuardBlock | undefined;
	toolResult(toolName: string): string | undefined;
	assistantCost(cost: number): void;
	agentEnd(): void;
};

const EDIT_TOOLS: readonly string[] = ["edit", "write"];
const OVER_BUDGET = "Blocked: the diff budget is used up. Commit what you have with git add and git commit, then end with session_status.";
const OVER_SPEND = "Blocked: the spending cap is reached, and this run is stopping.";
const NO_GIT = "Blocked: git is unavailable here, so the diff budget cannot be measured and edits are off. End with session_status.";
const READ_ONLY = "Blocked: this is a read-only run. Report what you found in your final message instead.";

function gitStatus(git: GitRunner, cwd: string): string | undefined {
	try {
		return git(cwd, ["status", "--porcelain"]);
	} catch {
		return undefined;
	}
}

// Used before the run is loaded, or when it cannot be: reading stays possible, changing things does not.
export function failClosedGuard(reason: string): ChildGuard {
	return {
		flags: [],
		toolCall: (toolName) => (toolName === "bash" || EDIT_TOOLS.includes(toolName) ? { block: true, reason } : undefined),
		toolResult: () => undefined,
		assistantCost: () => {},
		agentEnd: () => {},
	};
}

export function createChildGuard(deps: ChildGuardDeps): ChildGuard {
	const { run, config, cwd, git } = deps;
	const implement = run.kind === "implement";
	const repo = repoChildrenConfig(config, run.repo);
	const ignore = [...BUILT_IN_IGNORE, ...repo.ignore];
	const timeoutSeconds = Math.max(1, Math.round(config.commandTimeoutMinutes * 60));
	const flags = new Set<ChildFlag>(run.flags);
	let spend = run.spendUsd;
	let spendWarned = false;
	let pending: string | undefined;
	let wipCommitted = false;
	const leadStatus = implement ? undefined : gitStatus(git, cwd);

	const flag = (name: ChildFlag): void => {
		if (flags.has(name)) return;
		flags.add(name);
		deps.record({ flags: [...flags] });
	};

	const measure = (): DiffStats | undefined => {
		if (!run.baseCommit) return undefined;
		try {
			const stats = measureDiff(git, cwd, { from: run.baseCommit, ignore });
			deps.record({ diffLines: stats.lines, diffFiles: stats.files });
			return stats;
		} catch {
			flag("no-git");
			return undefined;
		}
	};
	if (implement) measure();

	const editBlock = (input: Record<string, unknown>): string | undefined => {
		if (!implement) return READ_ONLY;
		if (flags.has("no-git")) return NO_GIT;
		if (flags.has("over-budget")) return OVER_BUDGET;
		const target = resolve(cwd, String(input.path ?? "").replace(/^@/, ""));
		const rel = relative(cwd, target);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep)[0] === ".git") return `Blocked: ${target} is outside your worktree.`;
		const path = rel.split(sep).join("/");
		if (!inScope(path, run.brief.scope)) return `Blocked: ${path} is outside your scope (${run.brief.scope.join(", ")}). Needing it is a question for the lead.`;
		return undefined;
	};

	const budgetNote = (): string | undefined => {
		if (flags.has("no-git")) return undefined;
		const stats = measure();
		if (!stats) {
			if (!flags.has("no-git")) return undefined;
			deps.abort();
			return "Stopped: git failed, so the diff budget cannot be measured. Edits are blocked, and this run ends as failed.";
		}
		const lines = run.budgetLines ?? Number.POSITIVE_INFINITY;
		const files = run.budgetFiles ?? Number.POSITIVE_INFINITY;
		if (stats.lines >= lines || stats.files >= files) {
			flag("over-budget");
			return `Budget reached (${stats.lines}/${lines} lines, ${stats.files}/${files} files). Edits are blocked. Commit what you have with git add and git commit, then end with session_status.`;
		}
		const warnAt = config.warnPercent / 100;
		if (stats.lines >= lines * warnAt) return `Budget ${stats.lines}/${lines} lines: finish the smallest working change.`;
		if (stats.files >= files * warnAt) return `Budget ${stats.files}/${files} files: finish the smallest working change.`;
		return undefined;
	};

	return {
		get flags() {
			return [...flags];
		},
		toolCall(toolName, input) {
			const changing = toolName === "bash" || EDIT_TOOLS.includes(toolName);
			if (changing && flags.has("over-spend")) return { block: true, reason: OVER_SPEND };
			if (EDIT_TOOLS.includes(toolName)) {
				const reason = editBlock(input);
				return reason ? { block: true, reason } : undefined;
			}
			if (toolName !== "bash") return undefined;
			const command = String(input.command ?? "");
			const overBudget = flags.has("over-budget") && !overBudgetAllowed(command, run.brief.acceptance)
				? `${OVER_BUDGET} Allowed now: git status, diff, log, add, commit, and your acceptance commands.`
				: undefined;
			const reason = restrictedVerdict(command) ?? expensiveVerdict(command, repo.expensiveCommands) ?? overBudget;
			if (reason) return { block: true, reason };
			const requested = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : timeoutSeconds;
			input.timeout = Math.min(requested, timeoutSeconds);
			return undefined;
		},
		toolResult(toolName) {
			const notes: string[] = [];
			if (pending) {
				notes.push(pending);
				pending = undefined;
			}
			if (implement && (toolName === "bash" || EDIT_TOOLS.includes(toolName))) {
				const note = budgetNote();
				if (note) notes.push(note);
			}
			if (!implement && toolName === "bash" && leadStatus !== undefined && !flags.has("modified-files") && gitStatus(git, cwd) !== leadStatus) {
				flag("modified-files");
				notes.push("Warning: that command changed files in the lead's working directory. They were left in place, and the lead will be told. This run is read-only.");
			}
			return notes.length > 0 ? notes.join("\n") : undefined;
		},
		assistantCost(cost) {
			if (!(cost > 0)) return;
			spend += cost;
			deps.record({ spendUsd: spend });
			const cap = config.spendCapUsd;
			if (spend >= cap) {
				if (flags.has("over-spend")) return;
				flag("over-spend");
				deps.abort();
			} else if (!spendWarned && spend >= (cap * config.warnPercent) / 100) {
				spendWarned = true;
				pending = `Spend $${spend.toFixed(2)} of $${cap.toFixed(2)}: finish the smallest working change.`;
			}
		},
		// After a spend-cap abort, the work so far is committed so the lead can continue from it.
		agentEnd() {
			if (!implement || wipCommitted || !flags.has("over-spend")) return;
			wipCommitted = true;
			try {
				if (git(cwd, ["status", "--porcelain"]) === "") return;
				git(cwd, ["add", "-A"]);
				git(cwd, ["commit", "--no-verify", "-q", "-m", `WIP: ${run.id} stopped at the spend cap`]);
			} catch {
				// The lead still finds the uncommitted work in the worktree.
			}
		},
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-guard-state.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/children/child-guard.ts tests/work/child-guard-state.test.mjs
git commit -m "feat: enforce scope, budget, command, and spend guards inside children"
```

---

### Task 6: The parent watchdog

**Files:**
- Create: `src/work/children/watchdog.ts`
- Create: `tests/work/fixtures/watchdog-pair.mjs`
- Test: `tests/work/child-watchdog.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WATCHDOG_INTERVAL_MS = 5000`
  - `WatchdogReaders = { ppid(): number; alive(pid): boolean; startTime(pid): string | undefined }`, `systemWatchdogReaders`
  - `startWatchdog(onGone: () => void, options?: { parentPid?: number; intervalMs?: number; readers?: WatchdogReaders }): () => void`. It calls `onGone` at most once, and returns a stop function. Its timer is `unref`'d.

- [ ] **Step 1: Write the fixture and the failing tests**

Create `tests/work/fixtures/watchdog-pair.mjs`:

```js
// Parent mode: start a child that watches this process, print the child's PID, and exit without cleaning up.
// Child mode: run the watchdog with a short interval and exit when the parent is gone (or after 10 seconds).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'parent') {
  const child = spawn(process.execPath, [self, 'child'], { stdio: 'ignore', env: { ...process.env, WATCHDOG_PARENT: String(process.pid) } });
  process.stdout.write(`${child.pid}\n`);
  setTimeout(() => process.exit(0), 100);
} else {
  const { startWatchdog } = await createJiti(import.meta.url).import('../../../src/work/children/watchdog.ts');
  startWatchdog(() => process.exit(0), { parentPid: Number(process.env.WATCHDOG_PARENT), intervalMs: 50 });
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), 10_000);
}
```

Create `tests/work/child-watchdog.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load, until } from './helpers.mjs';

const { startWatchdog } = await load('src/work/children/watchdog.ts');
const PAIR = fileURLToPath(new URL('./fixtures/watchdog-pair.mjs', import.meta.url));

const readers = (state) => ({ ppid: () => state.ppid, alive: (pid) => state.alive.includes(pid), startTime: (pid) => state.start[pid] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gone means no such process, or a zombie that nobody has reaped yet.
function gone(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z');
  } catch {
    return true;
  }
}

test('the watchdog fires once when the parent changes, dies, or its PID is reused', async () => {
  for (const change of [(s) => { s.ppid = 1; }, (s) => { s.alive = []; }, (s) => { s.start[100] = '999'; }]) {
    const state = { ppid: 100, alive: [100], start: { 100: '555' } };
    let fired = 0;
    const stop = startWatchdog(() => { fired++; }, { intervalMs: 10, readers: readers(state) });
    await sleep(40);
    assert.equal(fired, 0);
    change(state);
    await until(() => fired === 1);
    await sleep(40);
    assert.equal(fired, 1);
    stop();
  }
});

test('with an explicit parent PID, only that process matters', async () => {
  const state = { ppid: 1, alive: [100], start: { 100: '555' } };
  let fired = 0;
  const stop = startWatchdog(() => { fired++; }, { parentPid: 100, intervalMs: 10, readers: readers(state) });
  await sleep(40);
  assert.equal(fired, 0);
  state.alive = [];
  await until(() => fired === 1);
  stop();
});

test('a real child exits when its parent process disappears', async () => {
  const pid = Number(execFileSync(process.execPath, [PAIR, 'parent'], { encoding: 'utf8' }).trim());
  assert.ok(pid > 0);
  await until(() => gone(pid), 5000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-watchdog.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/watchdog.ts`.

- [ ] **Step 3: Implement the watchdog**

Create `src/work/children/watchdog.ts`:

```ts
import { readFileSync } from "node:fs";

export const WATCHDOG_INTERVAL_MS = 5000;

export type WatchdogReaders = { ppid: () => number; alive: (pid: number) => boolean; startTime: (pid: number) => string | undefined };

export const systemWatchdogReaders: WatchdogReaders = {
	ppid: () => process.ppid,
	alive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	// Field 22 of /proc/<pid>/stat; the fields after the command name start at field 3.
	startTime: (pid) => {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		} catch {
			return undefined;
		}
	},
};

// Ends a child whose lead is gone: the lead died, or its PID now belongs to another process. Without an
// explicit parent PID it watches the current parent, and a changed parent (the child was reparented) also counts.
export function startWatchdog(onGone: () => void, options: { parentPid?: number; intervalMs?: number; readers?: WatchdogReaders } = {}): () => void {
	const readers = options.readers ?? systemWatchdogReaders;
	const parent = options.parentPid ?? readers.ppid();
	const started = readers.startTime(parent);
	let fired = false;
	const timer = setInterval(() => {
		if (fired) return;
		const reparented = options.parentPid === undefined && readers.ppid() !== parent;
		const reused = started !== undefined && readers.startTime(parent) !== started;
		if (!reparented && readers.alive(parent) && !reused) return;
		fired = true;
		clearInterval(timer);
		onGone();
	}, options.intervalMs ?? WATCHDOG_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-watchdog.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/children/watchdog.ts tests/work/fixtures/watchdog-pair.mjs tests/work/child-watchdog.test.mjs
git commit -m "feat: end children whose lead process is gone"
```

---

### Task 7: Child mode in the `work` extension

**Files:**
- Modify: `extensions/work.ts`
- Test: `tests/work/child-extension.test.mjs`

**Interfaces:**
- Consumes: `createChildGuard`, `failClosedGuard`, `CHILD_RUN_ENV`, `PARENT_PID_ENV` (Task 5), `startWatchdog` (Task 6), `runGit` (Task 4), `childrenConfig` (Task 1), `store.getChildRun` and `store.updateChildRun` (Task 2).
- Produces:
  - `WorkExtensionOptions` gains `childGit?: GitRunner` and `watchdog?: typeof startWatchdog`.
  - When `PI_WORK_CHILD_RUN` is set, the extension registers `tool_call`, `tool_result`, and `message_end` handlers. It loads the guard at `session_start`, starts the watchdog there, runs `guard.agentEnd()` on `agent_end`, and stops the watchdog on `session_shutdown`. Other sessions register none of these handlers.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-extension.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { git, gitRepo, load, memoryRuntime, writeFiles } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');

const BRIEF = { goal: 'Add retry', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null };

function setup({ runtime, env, cwd }) {
  const events = new Map();
  const tools = new Map();
  const watchdogs = [];
  const calls = [];
  createWorkExtension({
    runtime: () => runtime,
    repoFromCwd: () => undefined,
    env,
    pid: 777,
    tmux: () => '',
    git: () => { throw new Error('not a git repository'); },
    signals: new EventEmitter(),
    watchdog: (onGone, options) => {
      watchdogs.push({ onGone, options });
      return () => calls.push('watchdog stopped');
    },
  })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
  });
  const ctx = {
    cwd,
    mode: 'rpc',
    hasUI: true,
    sessionManager: { getSessionId: () => 'child-s1', getSessionFile: () => undefined, getSessionName: () => undefined },
    ui: { notify() {}, setStatus() {} },
    abort: () => calls.push('abort'),
    shutdown: () => calls.push('shutdown'),
  };
  return { events, tools, watchdogs, calls, ctx, emit: (name, event = {}) => events.get(name)(event, ctx) };
}

async function child({ budgetLines = 300 } = {}) {
  const rt = await memoryRuntime();
  const repo = gitRepo({ 'src/a.ts': 'one\n' });
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  rt.store.createChildRun({ leadSession: 'lead-1', brief: BRIEF, model: 'anthropic/claude-sonnet-5', repo: 'api', budgetLines, budgetFiles: 8 }, 'session:lead-1', () => ({ worktree: repo, branch: 'main', baseCommit }));
  const env = { PI_WORK_CHILD_RUN: 'C-1', PI_WORK_PARENT_SESSION: 'lead-1', PI_WORK_PARENT_PID: '999' };
  return { rt, repo, s: setup({ runtime: rt, env, cwd: repo }) };
}

test('a child blocks changes until its guards start, then enforces scope, commands, and timeouts', async () => {
  const { s } = await child();
  assert.match((await s.emit('tool_call', { toolName: 'edit', input: { path: 'src/a.ts' } })).reason, /not started/);
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(await s.emit('tool_call', { toolName: 'edit', input: { path: 'src/a.ts' } }), undefined);
  assert.match((await s.emit('tool_call', { toolName: 'write', input: { path: 'docs/x.md' } })).reason, /outside your scope/);
  assert.match((await s.emit('tool_call', { toolName: 'bash', input: { command: 'npm test' } })).reason, /repository-wide test run/);
  const input = { command: 'ls', timeout: 9999 };
  assert.equal(await s.emit('tool_call', { toolName: 'bash', input }), undefined);
  assert.equal(input.timeout, 600);
  assert.deepEqual(s.watchdogs.map((w) => w.options), [{ parentPid: 999 }]);
  s.watchdogs[0].onGone();
  assert.deepEqual(s.calls, ['abort', 'shutdown']);
  await s.emit('session_shutdown', { reason: 'quit' });
  assert.equal(s.calls.at(-1), 'watchdog stopped');
});

test('tool results carry budget warnings, and diff and spend are recorded in the registry', async () => {
  const { s, rt, repo } = await child({ budgetLines: 5 });
  await s.emit('session_start', { reason: 'startup' });
  writeFiles(repo, { 'src/b.ts': '1\n2\n3\n4\n' });
  const result = await s.emit('tool_result', { toolName: 'write', content: [{ type: 'text', text: 'wrote' }] });
  assert.deepEqual(result.content, [{ type: 'text', text: 'wrote' }, { type: 'text', text: 'Budget 4/5 lines: finish the smallest working change.' }]);
  assert.equal(rt.store.getChildRun('C-1').diffLines, 4);
  await s.emit('message_end', { message: { role: 'assistant', content: [], usage: { cost: { total: 0.4 } } } });
  await s.emit('message_end', { message: { role: 'user', content: 'x' } });
  assert.equal(rt.store.getChildRun('C-1').spendUsd, 0.4);
  assert.equal(await s.emit('tool_result', { toolName: 'read', content: [] }), undefined);
});

test('an unknown child run fails closed and still starts the watchdog', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: { PI_WORK_CHILD_RUN: 'C-9', PI_WORK_PARENT_SESSION: 'lead-1' }, cwd: '/src/api' });
  await s.emit('session_start', { reason: 'startup' });
  assert.match((await s.emit('tool_call', { toolName: 'bash', input: { command: 'ls' } })).reason, /work registry is unavailable/);
  assert.equal(await s.emit('tool_call', { toolName: 'read', input: { path: 'a' } }), undefined);
  assert.deepEqual(s.watchdogs.map((w) => w.options), [{ parentPid: undefined }]);
});

test('sessions that are not children register no guard hooks', async () => {
  const s = setup({ runtime: await memoryRuntime(), env: {}, cwd: '/src/api' });
  for (const name of ['tool_call', 'tool_result', 'message_end']) assert.equal(s.events.has(name), false, name);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-extension.test.mjs`
Expected: FAIL. `s.events.get(...)` is undefined for `tool_call`, so calling it throws a `TypeError`.

- [ ] **Step 3: Wire child mode into the extension**

In `extensions/work.ts`, replace the Pi import line with:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
```

Directly below `import { captureItem } from "../src/work/capture.ts";`, add:

```ts
import type { ChildGuard } from "../src/work/children/child-guard.ts";
import { CHILD_RUN_ENV, createChildGuard, failClosedGuard, PARENT_PID_ENV } from "../src/work/children/child-guard.ts";
import { runGit } from "../src/work/children/git.ts";
import { startWatchdog } from "../src/work/children/watchdog.ts";
```

Replace `import { expandHome } from "../src/work/config.ts";` with:

```ts
import { childrenConfig, expandHome } from "../src/work/config.ts";
```

In `WorkExtensionOptions`, after `popup?: (args: string[]) => void;`, add:

```ts
	childGit?: GitRunner;
	watchdog?: typeof startWatchdog;
```

Directly after `let unwatch: (() => void) | undefined;`, add:

```ts
		// Child mode: guards and a parent watchdog, active only when a lead started this session.
		const childRunId = env[CHILD_RUN_ENV]?.trim() || undefined;
		let guard: ChildGuard | undefined = childRunId ? failClosedGuard("Blocked: child guards have not started yet.") : undefined;
		let stopWatchdog: (() => void) | undefined;
		const startChild = (ctx: ExtensionContext): void => {
			if (!childRunId) return;
			try {
				const r = rt();
				const run = r.store.getChildRun(childRunId);
				if (!run) throw new Error(`unknown child run ${childRunId}`);
				guard = createChildGuard({
					run,
					config: childrenConfig(r.config),
					cwd: ctx.cwd,
					git: options.childGit ?? runGit,
					record: (patch) => {
						try {
							rt().store.updateChildRun(run.id, patch);
						} catch {
							// Guards keep their state in memory; the next update records it again.
						}
					},
					abort: () => ctx.abort(),
				});
			} catch (error) {
				guard = failClosedGuard(`Blocked: the work registry is unavailable (${errorMessage(error)}), so child guards cannot run. End with session_status.`);
			}
			stopWatchdog ??= (options.watchdog ?? startWatchdog)(
				() => {
					ctx.abort();
					ctx.shutdown();
				},
				{ parentPid: Number(env[PARENT_PID_ENV]) || undefined },
			);
		};
		if (childRunId) {
			pi.on("tool_call", async (event) => guard?.toolCall(event.toolName, event.input as Record<string, unknown>));
			pi.on("tool_result", async (event) => {
				const warning = guard?.toolResult(event.toolName);
				return warning ? { content: [...event.content, { type: "text" as const, text: warning }] } : undefined;
			});
			pi.on("message_end", async (event) => {
				const message = event.message as unknown as { role?: string; usage?: { cost?: { total?: number } } };
				if (message.role === "assistant") guard?.assistantCost(message.usage?.cost?.total ?? 0);
			});
		}
```

In the `session_start` handler, directly after the `tracker.start({ … });` call, add:

```ts
			startChild(ctx);
```

Replace the `agent_end` line with:

```ts
		pi.on("agent_end", async (event) => {
			tracker.agentEnd(event.messages);
			guard?.agentEnd();
		});
```

In the `session_shutdown` handler, directly after `unwatch = undefined;`, add:

```ts
			stopWatchdog?.();
			stopWatchdog = undefined;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-extension.test.mjs tests/work/session-hooks.test.mjs tests/work/extension.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Run the part 2 gates**

Run: `npm test && npm run -s typecheck && npm run -s check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/work.ts tests/work/child-extension.test.mjs
git commit -m "feat: run child guards and the parent watchdog in child sessions"
```

- [ ] **Step 7: STOP for review (end of part 2)**

Report the commits of this part and any deviations. Do not start part 3.

---

# Part 3: Lead Supervision

### Task 8: A minimal RPC client and the fake child

**Files:**
- Create: `src/work/children/rpc.ts`
- Create: `tests/work/fixtures/fake-rpc-child.mjs`
- Test: `tests/work/child-rpc.test.mjs`

**Interfaces:**
- Consumes: Pi's RPC protocol, as documented in `docs/rpc.md` and `docs/rpc-commands.md` of the installed Pi. Commands are `{ id, type, … }` lines on stdin. Answers are `{ id, type: "response", command, success, data?, error? }` lines on stdout, and every other stdout line is an event.
- Produces:
  - `RpcEvent = { type: string } & Record<string, unknown>`, `RpcExit = { code: number | null; signal: NodeJS.Signals | null }`
  - `RpcChild = { readonly pid: number | undefined; readonly exited: boolean; request(command, timeoutMs?): Promise<unknown>; onEvent(listener): void; onExit(listener): void; stderrTail(): string; shutdown(graceMs): Promise<RpcExit> }`. `request` resolves with the response's `data`. It rejects on `success: false`, on a timeout, or when the child exits. `onExit` listeners added after the exit are called at once. `shutdown` closes stdin, sends `SIGTERM`, and sends `SIGKILL` after `graceMs`. Repeated calls return the same promise.
  - `spawnRpcChild(command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): RpcChild`
  - `STDERR_TAIL = 2000`, `REQUEST_TIMEOUT_MS = 30_000`
  - Fixture: `fake-rpc-child.mjs`, driven by the `FAKE_CHILD` JSON behavior and logging to `FAKE_CHILD_LOG` (documented in its header)

- [ ] **Step 1: Write the fake child**

Create `tests/work/fixtures/fake-rpc-child.mjs`:

```js
// Stand-in for `pi --mode rpc` in the children tests. It speaks the RPC protocol on stdin and stdout, never calls
// a model, and appends its argv, cwd, PI_WORK_* environment, commands, stdin close, and signals to FAKE_CHILD_LOG.
// FAKE_CHILD holds a JSON behavior:
//   sessionId         returned by get_state (default "fake-<pid>")
//   onPrompt          "settle" (default): emit agent_start, one assistant message_end, agent_end, and agent_settled
//                     "hang": accept the prompt and do nothing; "exit": exit with exitCode shortly after accepting
//   exitCode          exit code for onPrompt "exit" (default 1)
//   commit            { file, text }: write the file in the cwd and commit it when the prompt arrives
//   settleOnFollowUp  emit agent_settled after a follow_up
//   ignoreStdinClose  keep running after stdin closes; ignoreTerm: keep running after SIGTERM
//   stderr            text written to stderr at startup
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const behavior = JSON.parse(process.env.FAKE_CHILD ?? '{}');
const log = (entry) => {
  if (process.env.FAKE_CHILD_LOG) appendFileSync(process.env.FAKE_CHILD_LOG, `${JSON.stringify(entry)}\n`);
};
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const workEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PI_WORK_')));
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: workEnv, pid: process.pid });
if (behavior.stderr) process.stderr.write(behavior.stderr);

process.on('SIGTERM', () => {
  log({ signal: 'SIGTERM' });
  if (!behavior.ignoreTerm) process.exit(143);
});

const settle = () => {
  send({ type: 'agent_start' });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { cost: { total: 0.25 } } } });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'agent_settled' });
};

function handle(command) {
  log({ command });
  const reply = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) });
  switch (command.type) {
    case 'get_state':
      reply({ sessionId: behavior.sessionId ?? `fake-${process.pid}`, isStreaming: false });
      return;
    case 'prompt':
      reply();
      if (behavior.commit) {
        writeFileSync(join(process.cwd(), behavior.commit.file), behavior.commit.text);
        execFileSync('git', ['add', '-A']);
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'child work']);
      }
      if ((behavior.onPrompt ?? 'settle') === 'settle') setTimeout(settle, 10);
      else if (behavior.onPrompt === 'exit') setTimeout(() => process.exit(behavior.exitCode ?? 1), 20);
      return;
    case 'follow_up':
      reply();
      if (behavior.settleOnFollowUp) setTimeout(settle, 10);
      return;
    case 'steer':
      reply();
      return;
    case 'abort':
      reply();
      setTimeout(() => {
        send({ type: 'agent_end', messages: [] });
        send({ type: 'agent_settled' });
      }, 10);
      return;
    default:
      send({ id: command.id, type: 'response', command: command.type, success: false, error: `unsupported ${command.type}` });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  log({ stdin: 'closed' });
  if (!behavior.ignoreStdinClose) process.exit(0);
});
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write the failing tests**

Create `tests/work/child-rpc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, readJsonl, tempDir, until } from './helpers.mjs';

const { spawnRpcChild } = await load('src/work/children/rpc.ts');
const FAKE = fileURLToPath(new URL('./fixtures/fake-rpc-child.mjs', import.meta.url));

function start(behavior = {}, command = [process.execPath, FAKE, '--mode', 'rpc']) {
  const log = join(tempDir(), 'child.jsonl');
  const child = spawnRpcChild(command, { cwd: tempDir(), env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify(behavior), FAKE_CHILD_LOG: log } });
  const events = [];
  const exits = [];
  child.onEvent((event) => events.push(event));
  child.onExit((exit) => exits.push(exit));
  return { child, log, events, exits };
}

test('requests are correlated with their responses, and failed commands reject', async () => {
  const c = start({ sessionId: 'child-s1', onPrompt: 'hang' });
  assert.deepEqual(await c.child.request({ type: 'get_state' }), { sessionId: 'child-s1', isStreaming: false });
  await assert.rejects(c.child.request({ type: 'compact' }), /unsupported compact/);
  assert.equal(typeof c.child.pid, 'number');
  await c.child.shutdown(1000);
});

test('events stream after a prompt until agent_settled', async () => {
  const c = start();
  await c.child.request({ type: 'prompt', message: 'go' });
  await until(() => c.events.some((event) => event.type === 'agent_settled'));
  assert.deepEqual(c.events.map((event) => event.type), ['agent_start', 'message_end', 'agent_end', 'agent_settled']);
  assert.equal(c.events[1].message.usage.cost.total, 0.25);
  await c.child.shutdown(1000);
});

test('shutdown closes stdin and signals, and a cooperative child exits without SIGKILL', async () => {
  const c = start({ onPrompt: 'hang' });
  await c.child.request({ type: 'get_state' });
  const exit = await c.child.shutdown(5000);
  assert.notEqual(exit.signal, 'SIGKILL');
  assert.ok(readJsonl(c.log).some((entry) => entry.stdin === 'closed' || entry.signal === 'SIGTERM'));
  assert.equal(c.child.exited, true);
  await assert.rejects(c.child.request({ type: 'get_state' }), /not running/);
  assert.deepEqual(await c.child.shutdown(5000), exit);
});

test('a child that ignores stdin close and SIGTERM gets SIGKILL after the grace period', async () => {
  const c = start({ onPrompt: 'hang', ignoreStdinClose: true, ignoreTerm: true });
  await c.child.request({ type: 'get_state' });
  const started = Date.now();
  const exit = await c.child.shutdown(300);
  assert.equal(exit.signal, 'SIGKILL');
  assert.ok(Date.now() - started >= 250);
  const log = readJsonl(c.log);
  assert.ok(log.some((entry) => entry.stdin === 'closed'));
  assert.ok(log.some((entry) => entry.signal === 'SIGTERM'));
  assert.deepEqual(c.exits, [exit]);
});

test('a crash reports its exit and keeps the end of stderr', async () => {
  const c = start({ onPrompt: 'exit', exitCode: 3, stderr: 'boom: provider unreachable\n' });
  await c.child.request({ type: 'prompt', message: 'go' });
  await until(() => c.exits.length === 1);
  assert.deepEqual(c.exits[0], { code: 3, signal: null });
  assert.match(c.child.stderrTail(), /boom: provider unreachable/);
  const late = [];
  c.child.onExit((exit) => late.push(exit));
  assert.deepEqual(late, [{ code: 3, signal: null }]);
});

test('a missing executable rejects requests and reports the spawn error', async () => {
  const c = start({}, ['/nonexistent/pi', '--mode', 'rpc']);
  await assert.rejects(c.child.request({ type: 'get_state' }), /exited|not running/);
  await until(() => c.exits.length === 1);
  assert.match(c.child.stderrTail(), /ENOENT/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/work/child-rpc.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/rpc.ts`.

- [ ] **Step 4: Implement the client**

Create `src/work/children/rpc.ts`:

```ts
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export type RpcEvent = { type: string } & Record<string, unknown>;
export type RpcExit = { code: number | null; signal: NodeJS.Signals | null };
export type RpcChild = {
	readonly pid: number | undefined;
	readonly exited: boolean;
	request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
	onEvent(listener: (event: RpcEvent) => void): void;
	onExit(listener: (exit: RpcExit) => void): void;
	stderrTail(): string;
	shutdown(graceMs: number): Promise<RpcExit>;
};

export const STDERR_TAIL = 2000;
export const REQUEST_TIMEOUT_MS = 30_000;

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

// A minimal client for Pi's documented RPC protocol: one JSON record per LF-terminated line, responses matched
// by id, and every other stdout record an event. Stderr is kept (the last STDERR_TAIL characters), never printed.
export function spawnRpcChild(command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): RpcChild {
	if (command.length === 0) throw new Error("empty child command");
	const proc: ChildProcess = spawn(command[0] as string, command.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	const eventListeners: ((event: RpcEvent) => void)[] = [];
	const exitListeners: ((exit: RpcExit) => void)[] = [];
	const pending = new Map<string, Pending>();
	let nextId = 0;
	let buffer = "";
	let stderr = "";
	let exit: RpcExit | undefined;
	let stopping: Promise<RpcExit> | undefined;

	const keepStderr = (text: string): void => {
		stderr = (stderr + text).slice(-STDERR_TAIL);
	};
	const handleLine = (line: string): void => {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (record.type === "response") {
			const request = typeof record.id === "string" ? pending.get(record.id) : undefined;
			if (!request) return;
			pending.delete(record.id as string);
			clearTimeout(request.timer);
			if (record.success === false) request.reject(new Error(String(record.error ?? `${String(record.command)} failed`)));
			else request.resolve(record.data);
			return;
		}
		if (typeof record.type === "string") for (const listener of eventListeners) listener(record as RpcEvent);
	};
	const finish = (result: RpcExit): void => {
		if (exit) return;
		exit = result;
		const error = new Error(`child exited (${result.signal ?? `code ${result.code}`})`);
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
		for (const listener of exitListeners) listener(result);
	};

	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line.trim()) handleLine(line);
		}
	});
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", keepStderr);
	// Writes after the child is gone fail with EPIPE; the close event reports the exit.
	proc.stdin?.on("error", () => {});
	proc.on("error", (error) => {
		keepStderr(`${error.message}\n`);
		finish({ code: null, signal: null });
	});
	proc.on("close", (code, signal) => finish({ code, signal }));

	const signal = (name: NodeJS.Signals): void => {
		try {
			proc.kill(name);
		} catch {
			// Already gone.
		}
	};

	return {
		get pid() {
			return proc.pid;
		},
		get exited() {
			return exit !== undefined;
		},
		request(commandRecord, timeoutMs = REQUEST_TIMEOUT_MS) {
			if (exit || !proc.stdin?.writable) return Promise.reject(new Error("child is not running"));
			const id = `w${++nextId}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`${String(commandRecord.type)} timed out after ${timeoutMs} ms`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				proc.stdin?.write(`${JSON.stringify({ ...commandRecord, id })}\n`);
			});
		},
		onEvent(listener) {
			eventListeners.push(listener);
		},
		onExit(listener) {
			if (exit) listener(exit);
			else exitListeners.push(listener);
		},
		stderrTail() {
			return stderr;
		},
		// Close stdin, send SIGTERM, and send SIGKILL if the child is still running after graceMs.
		shutdown(graceMs) {
			if (exit) return Promise.resolve(exit);
			stopping ??= new Promise((resolve) => {
				const timer = setTimeout(() => signal("SIGKILL"), graceMs);
				exitListeners.push((result) => {
					clearTimeout(timer);
					resolve(result);
				});
				proc.stdin?.end();
				signal("SIGTERM");
			});
			return stopping;
		},
	};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/child-rpc.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/children/rpc.ts tests/work/fixtures/fake-rpc-child.mjs tests/work/child-rpc.test.mjs
git commit -m "feat: add a minimal client for Pi's RPC mode"
```

---

### Task 9: Briefs and the child's system prompt

**Files:**
- Create: `src/work/children/brief.ts`
- Test: `tests/work/child-brief.test.mjs`

**Interfaces:**
- Consumes: `ChildrenConfig` and `repoChildrenConfig` (Task 1), `Brief` and `ChildKind` (Task 2), `restrictedVerdict` and `expensiveVerdict` (Task 3).
- Produces:
  - `GOAL_MAX = 200`, `CONTEXT_MAX = 4000`
  - `BriefParams = { goal: string; kind: ChildKind; scope?: string[]; non_goals?: string[]; acceptance?: string[]; context?: string; budget?: { lines?: number; files?: number }; model?: string; model_reason?: string; from?: string }` (the `delegate` tool's parameters)
  - `ResolvedBrief = { brief: Brief; model: string; budgetLines: number | null; budgetFiles: number | null; notes: string[] }`
  - `resolveBrief(params, config, repo: string | null): ResolvedBrief | { error: string }`
  - `renderChildPrompt(run: { id; brief; budgetLines; budgetFiles; branch }, config): string`, `renderFirstPrompt(brief): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-brief.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { resolveBrief, renderChildPrompt, renderFirstPrompt } = await load('src/work/children/brief.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

test('an implement brief takes the default model and budget, and caps requested lines', () => {
  const r = resolveBrief({ goal: ' Add retry to fetchJira ', kind: 'implement', scope: ['src/**', ' '], acceptance: ['node --test tests/a.test.mjs'] }, DEFAULT_CHILDREN, 'api');
  assert.deepEqual(r.brief, { goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['node --test tests/a.test.mjs'], context: '', model: null, modelReason: null, from: null });
  assert.deepEqual([r.model, r.budgetLines, r.budgetFiles, r.notes], ['anthropic/claude-sonnet-5', 300, 8, []]);
  const capped = resolveBrief({ goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['true'], budget: { lines: 5000, files: 3 }, model: 'openai/gpt-5.6', model_reason: 'needs a long context' }, DEFAULT_CHILDREN, 'api');
  assert.deepEqual([capped.budgetLines, capped.budgetFiles, capped.model, capped.notes], [800, 3, 'openai/gpt-5.6', ['Budget capped at 800 lines.']]);
  assert.equal(capped.brief.modelReason, 'needs a long context');
});

test('a read-only brief has no budget and needs no scope or acceptance', () => {
  const r = resolveBrief({ goal: 'Map the auth flow', kind: 'read-only' }, DEFAULT_CHILDREN, null);
  assert.deepEqual([r.budgetLines, r.budgetFiles, r.brief.scope, r.brief.acceptance], [null, null, [], []]);
});

test('invalid briefs are refused with a reason', () => {
  const base = { goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['true'] };
  const cases = [
    [{ ...base, goal: '' }, /goal must be one sentence/],
    [{ ...base, goal: 'a\nb' }, /goal must be one sentence/],
    [{ ...base, goal: 'x'.repeat(201) }, /goal must be one sentence/],
    [{ ...base, kind: 'refactor' }, /kind must be implement or read-only/],
    [{ ...base, scope: [] }, /implement needs scope/],
    [{ ...base, acceptance: [] }, /implement needs acceptance/],
    [{ ...base, acceptance: ['pytest -q'] }, /acceptance command `pytest -q` is not allowed\. Blocked: repository-wide test run/],
    [{ ...base, acceptance: ['git push'] }, /Blocked: git push/],
    [{ ...base, context: 'x'.repeat(4001) }, /context must be at most 4000 characters/],
    [{ ...base, model: 'openai/gpt-5.6' }, /model needs model_reason/],
    [{ ...base, budget: { lines: 0 } }, /budget lines and files must be positive integers/],
    [{ goal: 'x', kind: 'read-only', from: 'C-1' }, /from applies only to implement runs/],
  ];
  for (const [params, pattern] of cases) assert.match(resolveBrief(params, DEFAULT_CHILDREN, 'api').error, pattern);
});

test('per-repository expensive commands also apply to acceptance', () => {
  const config = { ...DEFAULT_CHILDREN, repos: { api: { ignore: [], expensiveCommands: ['^make e2e$'] } } };
  const params = { goal: 'x', kind: 'implement', scope: ['src/**'], acceptance: ['make e2e'] };
  assert.match(resolveBrief(params, config, 'api').error, /repository-wide/);
  assert.equal(resolveBrief(params, config, 'web').error, undefined);
});

test('the child prompt states the brief and the rules, and the first prompt points to it', () => {
  const { brief } = resolveBrief({ goal: 'Add retry', kind: 'implement', scope: ['src/**'], non_goals: ['No new config'], acceptance: ['node --test tests/a.test.mjs'], context: 'fetchJira is in src/jira.ts' }, DEFAULT_CHILDREN, 'api');
  const text = renderChildPrompt({ id: 'C-4', brief, budgetLines: 300, budgetFiles: 8, branch: 'child/feat/C-4' }, DEFAULT_CHILDREN);
  for (const part of ['# Child run C-4', 'Goal: Add retry', 'Scope (the only paths you may change): src/**', 'Non-goals: No new config', '- `node --test tests/a.test.mjs`', 'fetchJira is in src/jira.ts', 'Less is more', 'Diff budget: 300 lines and 8 files', 'child/feat/C-4', 'Spending cap: $5.00', 'End with session_status']) {
    assert.ok(text.includes(part), part);
  }
  const readOnly = renderChildPrompt({ id: 'C-5', brief: resolveBrief({ goal: 'Map it', kind: 'read-only' }, DEFAULT_CHILDREN, null).brief, budgetLines: null, budgetFiles: null, branch: null }, DEFAULT_CHILDREN);
  assert.match(readOnly, /read-only: edit and write are disabled/);
  assert.doesNotMatch(readOnly, /Diff budget/);
  assert.equal(renderFirstPrompt(brief), 'Start on your brief (in the system prompt): Add retry');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-brief.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/brief.ts`.

- [ ] **Step 3: Implement briefs**

Create `src/work/children/brief.ts`:

```ts
import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { Brief, ChildKind } from "../types.ts";
import { expensiveVerdict, restrictedVerdict } from "./guards.ts";

export const GOAL_MAX = 200;
export const CONTEXT_MAX = 4000;

export type BriefParams = {
	goal: string;
	kind: ChildKind;
	scope?: string[];
	non_goals?: string[];
	acceptance?: string[];
	context?: string;
	budget?: { lines?: number; files?: number };
	model?: string;
	model_reason?: string;
	from?: string;
};
export type ResolvedBrief = { brief: Brief; model: string; budgetLines: number | null; budgetFiles: number | null; notes: string[] };

const clean = (list: string[] | undefined): string[] => (list ?? []).map((entry) => entry.trim()).filter(Boolean);
const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

export function resolveBrief(params: BriefParams, config: ChildrenConfig, repo: string | null): ResolvedBrief | { error: string } {
	const goal = params.goal?.trim() ?? "";
	if (!goal || goal.includes("\n") || goal.length > GOAL_MAX) return { error: `goal must be one sentence of at most ${GOAL_MAX} characters` };
	if (params.kind !== "implement" && params.kind !== "read-only") return { error: "kind must be implement or read-only" };
	const implement = params.kind === "implement";
	const scope = clean(params.scope);
	const acceptance = clean(params.acceptance);
	if (implement && scope.length === 0) return { error: "implement needs scope: the glob paths the child may change" };
	if (implement && acceptance.length === 0) return { error: "implement needs acceptance: targeted test commands that must pass" };
	const extra = repoChildrenConfig(config, repo).expensiveCommands;
	for (const command of acceptance) {
		const reason = restrictedVerdict(command) ?? expensiveVerdict(command, extra);
		if (reason) return { error: `acceptance command \`${command}\` is not allowed. ${reason}` };
	}
	const context = params.context?.trim() ?? "";
	if (context.length > CONTEXT_MAX) return { error: `context must be at most ${CONTEXT_MAX} characters` };
	const model = params.model?.trim() || null;
	const modelReason = params.model_reason?.trim() || null;
	if (model && !modelReason) return { error: "model needs model_reason" };
	const from = params.from?.trim() || null;
	if (from && !implement) return { error: "from applies only to implement runs" };
	const notes: string[] = [];
	let budgetLines: number | null = null;
	let budgetFiles: number | null = null;
	if (implement) {
		budgetLines = params.budget?.lines ?? config.diffBudget.defaultLines;
		budgetFiles = params.budget?.files ?? config.diffBudget.defaultFiles;
		if (!positiveInteger(budgetLines) || !positiveInteger(budgetFiles)) return { error: "budget lines and files must be positive integers" };
		if (budgetLines > config.diffBudget.maxLines) {
			notes.push(`Budget capped at ${config.diffBudget.maxLines} lines.`);
			budgetLines = config.diffBudget.maxLines;
		}
	}
	return {
		brief: { goal, kind: params.kind, scope, nonGoals: clean(params.non_goals), acceptance, context, model, modelReason, from },
		model: model ?? config.defaultModel,
		budgetLines,
		budgetFiles,
		notes,
	};
}

// Appended to the child's system prompt once, at start, so it stays the same for the whole session.
export function renderChildPrompt(run: { id: string; brief: Brief; budgetLines: number | null; budgetFiles: number | null; branch: string | null }, config: ChildrenConfig): string {
	const b = run.brief;
	const lines = [
		`# Child run ${run.id}`,
		"",
		"You are a child agent working for a project lead. You cannot talk to the user; the lead reads your final session_status note.",
		"",
		"## Brief",
		`Goal: ${b.goal}`,
		`Kind: ${b.kind}`,
	];
	if (b.scope.length > 0) lines.push(`Scope (the only paths you may change): ${b.scope.join(", ")}`);
	if (b.nonGoals.length > 0) lines.push(`Non-goals: ${b.nonGoals.join("; ")}`);
	if (b.acceptance.length > 0) lines.push("Acceptance (must pass):", ...b.acceptance.map((command) => `- \`${command}\``));
	if (b.context) lines.push("", "## Context", b.context);
	lines.push("", "## Rules", "- Less is more: make the smallest change that meets the goal. No unrequested refactors, scaffolding, or extra tests.");
	if (b.kind === "implement") {
		lines.push(
			`- Diff budget: ${run.budgetLines} lines and ${run.budgetFiles} files against your starting commit. Edits stop at the budget.`,
			"- Run only the tests covering the files you change. Repository-wide test runs are blocked; CI runs the full suite on the draft PR.",
			`- Commit your work on your branch (${run.branch}) with git add and git commit. Never push, open PRs, rebase, amend, or switch branches.`,
			"- Needing a dependency, or a path outside your scope, is a question for the lead: stop and say so.",
		);
	} else {
		lines.push("- This run is read-only: edit and write are disabled. Do not change files with shell commands either.");
	}
	lines.push(
		`- Spending cap: $${config.spendCapUsd.toFixed(2)}. Shell commands time out after ${config.commandTimeoutMinutes} minutes.`,
		`- End with session_status: \`done\` with a one-line summary when the goal is met${b.kind === "implement" ? " and committed" : ""}, or \`needs-me\` with the question that blocks you.`,
	);
	return lines.join("\n");
}

export function renderFirstPrompt(brief: Brief): string {
	return `Start on your brief (in the system prompt): ${brief.goal}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-brief.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/children/brief.ts tests/work/child-brief.test.mjs
git commit -m "feat: validate child briefs and render the child's rules"
```

---

### Task 10: The supervisor: delegate and results

**Files:**
- Create: `src/work/children/format.ts`, `src/work/children/supervisor.ts`
- Test: `tests/work/child-supervisor.test.mjs`

**Interfaces:**
- Consumes: `resolveBrief`, `renderChildPrompt`, `renderFirstPrompt`, and `BriefParams` (Task 9), `spawnRpcChild` and `RpcChild` (Task 8), the git helpers (Task 4), `BUILT_IN_IGNORE` (Task 3), `CHILD_RUN_ENV` and `PARENT_PID_ENV` (Task 5), the store methods (Task 2), `runShell` and `ShellRunner` from `src/work/jobs.ts`, `PARENT_SESSION_ENV` from `src/work/session-tracker.ts`, and `WORK_ITEM_ENV` from `src/work/linking.ts`.
- Produces:
  - `format.ts`: `modelShortName(model)` (`anthropic/claude-sonnet-5` becomes `sonnet-5`), `lastLine(output)`, `formatChildRun(run, note)`, `renderResult(run, config)`, `renderInterrupted(runs)`
  - `KILL_GRACE_MS = 10_000`
  - `SupervisorDeps = { store(): WorkStore; config(): ChildrenConfig; notify(text: string): void; command?: readonly string[] (default ["pi"]); env?; git?; shell?; pid?; killGraceMs?; readers?: PidReaders }`
  - `DelegateResult = { ok: true; run; message } | { ok: false; message }`
  - `createSupervisor(deps): Supervisor` with `delegate(leadSession, cwd, params): DelegateResult` and `list(leadSession): string`. Task 11 adds `steer`, `stop`, `recover`, and `shutdownAll`.
  - Every finished child produces exactly one `notify` call, unless the lead stopped it (Task 11).

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-supervisor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, gitRepo, load, memoryRuntime, readJsonl, tempDir, until, writeFiles } from './helpers.mjs';

const { createSupervisor } = await load('src/work/children/supervisor.ts');
const { lastLine, modelShortName } = await load('src/work/children/format.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

const FAKE = fileURLToPath(new URL('./fixtures/fake-rpc-child.mjs', import.meta.url));
const COMMIT = { file: 'src/retry.ts', text: 'export const retry = 1;\n' };
const implement = (overrides = {}) => ({ goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], acceptance: ['test -f src/retry.ts'], ...overrides });
const commandsIn = (log) => readJsonl(log).filter((entry) => entry.command).map((entry) => entry.command.type);

// A lead repository on feat/x, the child's session row, and a supervisor whose children are the fake.
async function lead({ behavior = {}, declared = 'done', note = 'Added retry', command } = {}) {
  const rt = await memoryRuntime();
  const repo = gitRepo({ 'src/a.ts': 'one\n', 'README.md': 'hi\n' });
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  const log = join(tempDir(), 'child.jsonl');
  const messages = [];
  rt.store.startSession({ id: 'child-s1', file: null, cwd: repo, name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: 'lead-1', headless: true });
  if (declared) rt.store.setSessionStatus('child-s1', declared, note, 'agent');
  const supervisor = createSupervisor({
    store: () => rt.store,
    config: () => DEFAULT_CHILDREN,
    notify: (text) => messages.push(text),
    command: command ?? [process.execPath, FAKE],
    env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify({ sessionId: 'child-s1', ...behavior }), FAKE_CHILD_LOG: log },
    pid: 4242,
    killGraceMs: 200,
  });
  return { rt, store: rt.store, repo, log, messages, supervisor };
}

test('delegate starts an implement child in its own worktree and reports one done result', async () => {
  const l = await lead({ behavior: { commit: COMMIT } });
  const item = l.store.addItem({ project: 'misc', title: 'Retry', origin: 'manual' }, 'user');
  l.store.startSession({ id: 'lead-1', file: null, cwd: l.repo, name: null, pid: 2, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: false });
  l.store.linkSession('lead-1', item.id, 'manual', 'user');
  const head = git(l.repo, 'rev-parse', 'HEAD');
  const result = l.supervisor.delegate('lead-1', l.repo, implement());
  assert.equal(result.ok, true);
  assert.deepEqual([result.run.id, result.run.branch, result.run.baseCommit], ['C-1', 'child/feat/x/C-1', head]);
  assert.equal(result.run.worktree, join(l.repo, '.pi', 'worktrees', 'child-C-1'));
  assert.match(result.message, /^Started C-1 on child\/feat\/x\/C-1 with anthropic\/claude-sonnet-5\. Its result arrives as a message/);
  assert.equal(git(l.repo, 'status', '--porcelain'), '');

  await until(() => l.messages.length === 1);
  const run = l.store.getChildRun('C-1');
  assert.deepEqual([run.outcome, run.childSession, run.summary, run.diffLines, run.diffFiles], ['done', 'child-s1', 'Added retry', 1, 1]);
  assert.deepEqual(run.acceptance, [{ command: 'test -f src/retry.ts', exitCode: 0, summary: '' }]);
  assert.match(l.messages[0], /^Child C-1 finished: done\nGoal: Add retry to fetchJira\nSummary: Added retry\nDiff: 1\/300 lines, 1\/8 files\nAcceptance: pass `test -f src\/retry\.ts` \(exit 0\)\nSpend: \$0\.00 of \$5\.00\nBranch: child\/feat\/x\/C-1 \(base [0-9a-f]{12}\)\nNext: review the diff/);
  assert.match(l.messages[0], /call merge_child C-1/);
  assert.equal(l.supervisor.list('lead-1'), 'C-1  done  sonnet-5  $0.00  1/300 lines 1/8 files  acceptance 1/1  goal: Add retry to fetchJira  note: Added retry');

  const entries = await until(() => {
    const logged = readJsonl(l.log);
    return logged.some((entry) => entry.stdin === 'closed' || entry.signal === 'SIGTERM') && logged;
  });
  const [start] = entries;
  assert.deepEqual(start.argv.slice(0, 7), ['--mode', 'rpc', '--model', 'anthropic/claude-sonnet-5', '--name', 'child C-1: Add retry to fetchJira', '--append-system-prompt']);
  assert.match(start.argv[7], /Scope \(the only paths you may change\): src\/\*\*/);
  assert.equal(start.argv.length, 8);
  assert.equal(start.cwd, run.worktree);
  assert.deepEqual(start.env, { PI_WORK_CHILD_RUN: 'C-1', PI_WORK_ITEM: 'W-1', PI_WORK_PARENT_PID: '4242', PI_WORK_PARENT_SESSION: 'lead-1' });
  assert.deepEqual(commandsIn(l.log), ['get_state', 'prompt']);
});

test('delegate refuses a dirty tree, the default branch, and invalid briefs, and a failed worktree records no run', async () => {
  const l = await lead();
  writeFiles(l.repo, { 'src/a.ts': 'changed\n' });
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement()).message, /^Refused: your working tree has uncommitted changes/);
  git(l.repo, 'checkout', '-q', '--', 'src/a.ts');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ scope: [] })).message, /^Refused: implement needs scope/);
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ acceptance: ['npm test'] })).message, /repository-wide test run/);
  git(l.repo, 'branch', 'child/feat/x/C-1');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement()).message, /^Refused: could not create the child run: .*already exists/);
  assert.deepEqual(l.store.listChildRuns(), []);
  git(l.repo, 'checkout', '-q', 'main');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement()).message, /^Refused: main is the default branch/);
  assert.equal(existsSync(l.log), false);
});

test('a child that settles without declaring done is incomplete, and acceptance does not run', async () => {
  const l = await lead({ behavior: { commit: COMMIT }, declared: null });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const run = l.store.getChildRun('C-1');
  assert.equal(run.outcome, 'incomplete');
  assert.deepEqual(run.acceptance, []);
  assert.match(l.messages[0], /^Child C-1 finished: incomplete[\s\S]*delegate again with from: C-1/);
});

test('a crash after the prompt fails the run and keeps the worktree', async () => {
  const l = await lead({ behavior: { onPrompt: 'exit', exitCode: 3, stderr: 'boom: provider unreachable\n' } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const run = l.store.getChildRun('C-1');
  assert.equal(run.outcome, 'failed');
  assert.equal(run.summary, 'exited: code 3; boom: provider unreachable');
  assert.equal(existsSync(run.worktree), true);
  assert.match(l.messages[0], /^Child C-1 finished: failed/);
});

test('a child that cannot start fails the run and removes its worktree and branch', async () => {
  const l = await lead({ command: ['/nonexistent/pi'] });
  const { run } = l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const ended = l.store.getChildRun('C-1');
  assert.equal(ended.outcome, 'failed');
  assert.match(ended.summary, /^failed to start: .*ENOENT/);
  assert.equal(existsSync(run.worktree), false);
  assert.equal(git(l.repo, 'branch', '--list', 'child/feat/x/C-1'), '');
});

test('a read-only child runs in the lead directory without edit and write, and is done when it declares done', async () => {
  const l = await lead({ note: 'Auth goes through src/auth.ts' });
  const result = l.supervisor.delegate('lead-1', l.repo, { goal: 'Map the auth flow', kind: 'read-only' });
  assert.match(result.message, /^Started C-1 \(read-only, in your working directory\) with anthropic\/claude-sonnet-5\./);
  await until(() => l.messages.length === 1);
  assert.equal(l.store.getChildRun('C-1').outcome, 'done');
  assert.doesNotMatch(l.messages[0], /Diff:/);
  assert.match(l.messages[0], /Summary: Auth goes through src\/auth\.ts/);
  const [start] = readJsonl(l.log);
  assert.equal(start.cwd, l.repo);
  assert.deepEqual(start.argv.slice(-2), ['--exclude-tools', 'edit,write']);
});

test('format helpers shorten model names and keep the last output line', () => {
  assert.equal(modelShortName('anthropic/claude-sonnet-5'), 'sonnet-5');
  assert.equal(modelShortName('openai/gpt-5.6'), 'gpt-5.6');
  assert.equal(lastLine('running 3 tests\n\x1b[32mpass 3\x1b[0m\n\n'), '[32mpass 3 [0m');
  assert.equal(lastLine(''), '');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-supervisor.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/supervisor.ts`.

- [ ] **Step 3: Implement the formatting helpers**

Create `src/work/children/format.ts`:

```ts
import type { ChildrenConfig } from "../config.ts";
import type { ChildRun } from "../types.ts";
import { NOTE_MAX } from "../types.ts";

const money = (value: number): string => `$${value.toFixed(2)}`;
const short = (commit: string | null): string => (commit ?? "").slice(0, 12);

export function modelShortName(model: string): string {
	return (model.split("/").pop() ?? model).replace(/^claude-/, "");
}

// The last non-empty output line, with control characters turned into spaces, for acceptance and crash summaries.
export function lastLine(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim())
		.filter(Boolean);
	return (lines.at(-1) ?? "").slice(0, NOTE_MAX);
}

export function formatChildRun(run: ChildRun, note: string): string {
	const parts = [run.id, run.outcome, modelShortName(run.model), money(run.spendUsd)];
	parts.push(run.kind === "implement" ? `${run.diffLines}/${run.budgetLines} lines ${run.diffFiles}/${run.budgetFiles} files` : "read-only");
	if (run.acceptance.length > 0) parts.push(`acceptance ${run.acceptance.filter((result) => result.exitCode === 0).length}/${run.acceptance.length}`);
	if (run.flags.length > 0) parts.push(`flags ${run.flags.join(",")}`);
	parts.push(`goal: ${run.brief.goal}`);
	if (note) parts.push(`note: ${note}`);
	return parts.join("  ");
}

function nextStep(run: ChildRun): string {
	if (run.kind === "read-only") return "Next: use the findings, or delegate follow-up work.";
	const passed = run.acceptance.length > 0 && run.acceptance.every((result) => result.exitCode === 0);
	if (run.outcome === "done" && passed) {
		return `Next: review the diff with \`git diff ${short(run.baseCommit)}...${run.branch}\`. If it is acceptable, call merge_child ${run.id}. Otherwise delegate again with from: ${run.id}, or call stop_child ${run.id} with discard: true.`;
	}
	return `Next: delegate again with from: ${run.id} to continue from its branch, or call stop_child ${run.id} with discard: true.`;
}

// The one message the lead receives when a child finishes.
export function renderResult(run: ChildRun, config: ChildrenConfig): string {
	const modified = run.flags.includes("modified-files") ? " (modified-files: it changed files in your working directory; check git status)" : "";
	const lines = [`Child ${run.id} finished: ${run.outcome}${modified}`, `Goal: ${run.brief.goal}`];
	if (run.summary) lines.push(`Summary: ${run.summary}`);
	if (run.kind === "implement") lines.push(`Diff: ${run.diffLines}/${run.budgetLines} lines, ${run.diffFiles}/${run.budgetFiles} files`);
	for (const result of run.acceptance) {
		const verdict = result.exitCode === 0 ? "pass" : "FAIL";
		const code = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
		lines.push(`Acceptance: ${verdict} \`${result.command}\` (${code}) ${result.summary}`.trimEnd());
	}
	lines.push(`Spend: ${money(run.spendUsd)} of ${money(config.spendCapUsd)}`);
	if (run.branch) lines.push(`Branch: ${run.branch} (base ${short(run.baseCommit)})`);
	lines.push(nextStep(run));
	return lines.join("\n");
}

export function renderInterrupted(runs: readonly ChildRun[]): string {
	return [
		"These child runs were interrupted when this session last ended:",
		...runs.map((run) => `- ${run.id} (${run.branch ?? "read-only"}): ${run.brief.goal}`),
		"For each, delegate again (implement runs can continue with from: C-<n>) or call stop_child with discard: true.",
	].join("\n");
}
```

- [ ] **Step 4: Implement delegate and results**

Create `src/work/children/supervisor.ts`:

```ts
import { dirname, join } from "node:path";
import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { ShellRunner } from "../jobs.ts";
import { runShell } from "../jobs.ts";
import { WORK_ITEM_ENV } from "../linking.ts";
import type { PidReaders } from "../liveness.ts";
import type { GitRunner } from "../rules.ts";
import { repoFromCwd } from "../rules.ts";
import { errorMessage } from "../secrets.ts";
import { PARENT_SESSION_ENV } from "../session-tracker.ts";
import type { ChildRunEnd, WorkStore } from "../store.ts";
import type { AcceptanceResult, ChildRun, ChildWorktree } from "../types.ts";
import type { BriefParams } from "./brief.ts";
import { renderChildPrompt, renderFirstPrompt, resolveBrief } from "./brief.ts";
import { CHILD_RUN_ENV, PARENT_PID_ENV } from "./child-guard.ts";
import { formatChildRun, lastLine, renderResult } from "./format.ts";
import { addWorktree, commitsSince, defaultBranchRef, excludeChildWorktrees, gitText, isClean, isDefaultBranch, measureDiff, removeWorktree, runGit } from "./git.ts";
import { BUILT_IN_IGNORE } from "./guards.ts";
import type { RpcChild } from "./rpc.ts";
import { spawnRpcChild } from "./rpc.ts";

export const KILL_GRACE_MS = 10_000;

export type SupervisorDeps = {
	store: () => WorkStore;
	config: () => ChildrenConfig;
	notify: (text: string) => void;
	command?: readonly string[];
	env?: NodeJS.ProcessEnv;
	git?: GitRunner;
	shell?: ShellRunner;
	pid?: number;
	killGraceMs?: number;
	readers?: PidReaders;
};
export type DelegateResult = { ok: true; run: ChildRun; message: string } | { ok: false; message: string };
export type Supervisor = {
	delegate(leadSession: string, cwd: string, params: BriefParams): DelegateResult;
	list(leadSession: string): string;
};

type Handle = { child: RpcChild; started: boolean; stopping: boolean; finished: boolean };
type Ending = { kind: "settled" } | { kind: "exited"; detail: string } | { kind: "start-failed"; detail: string };

// Child worktrees live at <root>/.pi/worktrees/child-<id>, so the repository root is three levels up.
function rootOf(run: ChildRun): string | undefined {
	return run.worktree ? dirname(dirname(dirname(run.worktree))) : undefined;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
	const git = deps.git ?? runGit;
	const grace = deps.killGraceMs ?? KILL_GRACE_MS;
	const handles = new Map<string, Handle>();
	const actorOf = (run: ChildRun): `session:${string}` => `session:${run.leadSession}`;

	function delegate(leadSession: string, cwd: string, params: BriefParams): DelegateResult {
		const config = deps.config();
		const store = deps.store();
		const repo = repoFromCwd(cwd, git) ?? null;
		const resolved = resolveBrief(params, config, repo);
		if ("error" in resolved) return { ok: false, message: `Refused: ${resolved.error.replace(/\.?$/, ".")}` };
		let prepare: ((id: string) => ChildWorktree) | undefined;
		let root: string | undefined;
		if (resolved.brief.kind === "implement") {
			root = gitText(git, cwd, ["rev-parse", "--show-toplevel"]);
			if (!root) return { ok: false, message: "Refused: implement runs need a git repository." };
			const leadBranch = gitText(git, cwd, ["branch", "--show-current"]);
			if (!leadBranch) return { ok: false, message: "Refused: check out a branch first (HEAD is detached)." };
			if (isDefaultBranch(leadBranch, defaultBranchRef(git, cwd))) {
				return { ok: false, message: `Refused: ${leadBranch} is the default branch. Create a feature branch for this work first.` };
			}
			excludeChildWorktrees(git, root);
			if (!isClean(git, cwd)) {
				return { ok: false, message: "Refused: your working tree has uncommitted changes. Commit them first, so the child starts from your current HEAD." };
			}
			const start = git(cwd, ["rev-parse", "HEAD"]);
			const baseCommit = start;
			const repoRoot = root;
			prepare = (id) => {
				const worktree = join(repoRoot, ".pi", "worktrees", `child-${id}`);
				const branch = `child/${leadBranch}/${id}`;
				addWorktree(git, repoRoot, worktree, branch, start);
				return { worktree, branch, baseCommit };
			};
		}
		let run: ChildRun;
		try {
			const input = { leadSession, brief: resolved.brief, model: resolved.model, repo, budgetLines: resolved.budgetLines, budgetFiles: resolved.budgetFiles };
			run = store.createChildRun(input, `session:${leadSession}`, prepare);
		} catch (error) {
			return { ok: false, message: `Refused: could not create the child run: ${errorMessage(error)}` };
		}
		launch(run, cwd, config);
		const where = run.branch ? `on ${run.branch}` : "(read-only, in your working directory)";
		return { ok: true, run, message: [`Started ${run.id} ${where} with ${run.model}.`, ...resolved.notes, "Its result arrives as a message when it finishes; keep working meanwhile."].join(" ") };
	}

	function launch(run: ChildRun, leadCwd: string, config: ChildrenConfig): void {
		const store = deps.store();
		const env: NodeJS.ProcessEnv = {
			...(deps.env ?? process.env),
			[PARENT_SESSION_ENV]: run.leadSession,
			[CHILD_RUN_ENV]: run.id,
			[PARENT_PID_ENV]: String(deps.pid ?? process.pid),
		};
		const link = store.sessionLink(run.leadSession);
		if (link) env[WORK_ITEM_ENV] = link.itemId;
		else delete env[WORK_ITEM_ENV];
		const args = ["--mode", "rpc", "--model", run.model, "--name", `child ${run.id}: ${run.brief.goal}`, "--append-system-prompt", renderChildPrompt(run, config)];
		if (run.kind === "read-only") args.push("--exclude-tools", "edit,write");
		const child = spawnRpcChild([...(deps.command ?? ["pi"]), ...args], { cwd: run.worktree ?? leadCwd, env });
		const handle: Handle = { child, started: false, stopping: false, finished: false };
		handles.set(run.id, handle);
		store.updateChildRun(run.id, { pid: child.pid ?? null });
		child.onEvent((event) => {
			if (event.type === "agent_settled") void finish(run.id, { kind: "settled" });
		});
		child.onExit((exit) => {
			void finish(run.id, { kind: "exited", detail: exit.signal ?? `code ${exit.code}` });
		});
		void (async () => {
			try {
				const state = (await child.request({ type: "get_state" })) as { sessionId?: unknown } | undefined;
				if (typeof state?.sessionId === "string") store.updateChildRun(run.id, { childSession: state.sessionId });
				await child.request({ type: "prompt", message: renderFirstPrompt(run.brief) });
				handle.started = true;
			} catch (error) {
				await finish(run.id, { kind: "start-failed", detail: errorMessage(error) });
			}
		})();
	}

	// Records the outcome once, ends the child process, and sends the lead its one message.
	async function finish(id: string, ending: Ending): Promise<void> {
		const handle = handles.get(id);
		if (!handle || handle.finished) return;
		handle.finished = true;
		handles.delete(id);
		try {
			const store = deps.store();
			let run = store.getChildRun(id) as ChildRun;
			if (run.outcome === "running") {
				let end: ChildRunEnd;
				if (handle.stopping) {
					end = { outcome: "stopped", summary: "stopped by the lead", ...diffOf(run) };
				} else if (ending.kind === "settled") {
					end = await settledEnd(run);
				} else {
					const failedStart = ending.kind === "start-failed" || !handle.started;
					const stderr = lastLine(handle.child.stderrTail());
					end = { outcome: "failed", summary: `${failedStart ? "failed to start" : "exited"}: ${ending.detail}${stderr ? `; ${stderr}` : ""}`, ...diffOf(run) };
					const root = rootOf(run);
					if (failedStart && root) removeWorktree(git, root, run.worktree, run.branch);
				}
				run = store.endChildRun(id, end, actorOf(run));
			}
			if (!handle.stopping) deps.notify(renderResult(run, deps.config()));
		} catch (error) {
			if (!handle.stopping) deps.notify(`Child ${id} ended, but recording its result failed: ${errorMessage(error)}`);
		} finally {
			void handle.child.shutdown(grace);
		}
	}

	async function settledEnd(run: ChildRun): Promise<ChildRunEnd> {
		const session = run.childSession ? deps.store().getSession(run.childSession) : undefined;
		const declared = session?.statusSource === "agent" ? session.status : undefined;
		const summary = session?.note ?? "";
		const diff = diffOf(run);
		if (run.flags.includes("over-spend")) return { outcome: "over-spend", summary, ...diff };
		if (run.flags.includes("over-budget")) return { outcome: "over-budget", summary, ...diff };
		if (run.flags.includes("no-git")) return { outcome: "failed", summary: summary || "git was unavailable, so the diff budget could not be measured", ...diff };
		if (run.kind === "read-only") return { outcome: declared === "done" ? "done" : "incomplete", summary };
		let committed = false;
		try {
			committed = run.worktree !== null && run.baseCommit !== null && commitsSince(git, run.worktree, run.baseCommit) > 0;
		} catch {
			committed = false;
		}
		if (declared !== "done" || !committed) return { outcome: "incomplete", summary, ...diff };
		return { outcome: "done", summary, acceptance: await runAcceptance(run), ...diff };
	}

	// The lead runs the acceptance commands itself, in the child's worktree, rather than trusting the child.
	async function runAcceptance(run: ChildRun): Promise<AcceptanceResult[]> {
		const minutes = deps.config().commandTimeoutMinutes;
		const results: AcceptanceResult[] = [];
		for (const command of run.brief.acceptance) {
			const result = await (deps.shell ?? runShell)(command, run.worktree as string, { timeoutMs: minutes * 60_000 });
			const failedToRun = result.timedOut || result.error !== undefined;
			const summary = result.timedOut ? `timed out after ${minutes} minutes` : lastLine(result.error ?? result.output);
			results.push({ command, exitCode: failedToRun ? null : result.code, summary });
		}
		return results;
	}

	function diffOf(run: ChildRun): { diffLines?: number; diffFiles?: number } {
		if (!run.worktree || !run.baseCommit) return {};
		try {
			const ignore = [...BUILT_IN_IGNORE, ...repoChildrenConfig(deps.config(), run.repo).ignore];
			const stats = measureDiff(git, run.worktree, { from: run.baseCommit, ignore });
			return { diffLines: stats.lines, diffFiles: stats.files };
		} catch {
			return {};
		}
	}

	function list(leadSession: string): string {
		const store = deps.store();
		const runs = store.listChildRuns({ leadSession });
		if (runs.length === 0) return "No child runs yet. Use delegate to start one.";
		return runs
			.map((run) => {
				const session = run.childSession ? store.getSession(run.childSession) : undefined;
				return formatChildRun(run, run.summary || (session?.statusSource === "agent" ? session.note : ""));
			})
			.join("\n");
	}

	return { delegate, list };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/child-supervisor.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/children/format.ts src/work/children/supervisor.ts tests/work/child-supervisor.test.mjs
git commit -m "feat: delegate to child agents and report one result per child"
```

---

### Task 11: The supervisor: steer, stop, recover, and continue

**Files:**
- Modify: `src/work/children/supervisor.ts`
- Modify: `tests/work/child-supervisor.test.mjs`: append tests

**Interfaces:**
- Consumes: everything from Task 10, `systemPidReaders` from `src/work/liveness.ts`, and `store.markChildRunDiscarded` (Task 2).
- Produces:
  - `ABORT_TIMEOUT_MS = 5_000`
  - `Supervisor` gains:
    - `steer(leadSession, id, text, urgent): Promise<string>` sends `steer` when urgent, and `follow_up` otherwise.
    - `stop(leadSession, id, discard): Promise<string>` sends `abort`, runs the shutdown sequence, and records `stopped`, with no result message. With `discard`, it also removes the worktree and branch and records `discarded`. That works on finished runs too.
    - `recover(leadSession): ChildRun[]` marks this lead's `running` runs that it no longer supervises as `interrupted`. It sends `SIGTERM` to a PID only when its environment names the run.
    - `shutdownAll(): Promise<void>` runs the shutdown sequence for every child and writes no outcomes.
  - `delegate` accepts `from: C-<n>` (decision 5).

- [ ] **Step 1: Write the failing tests**

Append to `tests/work/child-supervisor.test.mjs`:

```js
const promptSent = (l) => until(() => commandsIn(l.log).includes('prompt'));

test('steer_child sends an urgent steer or a follow-up, and a settled over-budget child reports over-budget', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang', settleOnFollowUp: true } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  assert.match(await l.supervisor.steer('lead-1', 'C-1', 'Use exponential backoff', true), /^Steered C-1/);
  l.store.updateChildRun('C-1', { flags: ['over-budget'] });
  assert.match(await l.supervisor.steer('lead-1', 'C-1', 'Wrap up', false), /^Queued for C-1/);
  await until(() => l.messages.length === 1);
  assert.equal(l.store.getChildRun('C-1').outcome, 'over-budget');
  const sent = readJsonl(l.log).filter((entry) => ['steer', 'follow_up'].includes(entry.command?.type)).map((entry) => [entry.command.type, entry.command.message]);
  assert.deepEqual(sent, [['steer', 'Use exponential backoff'], ['follow_up', 'Wrap up']]);
  assert.match(await l.supervisor.steer('lead-1', 'C-1', 'more', false), /^C-1 is over-budget and can no longer be steered\. Delegate again with from: C-1/);
  assert.match(await l.supervisor.steer('lead-2', 'C-1', 'x', false), /^C-1 is not one of your child runs/);
});

test('stop_child aborts and ends the child without a message, and discard removes its worktree and branch', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang' } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  assert.match(await l.supervisor.stop('lead-1', 'C-1', false), /^Stopped C-1\. Its worktree and branch are kept \(child\/feat\/x\/C-1\)\./);
  const run = l.store.getChildRun('C-1');
  assert.equal(run.outcome, 'stopped');
  assert.equal(existsSync(run.worktree), true);
  assert.ok(commandsIn(l.log).includes('abort'));
  assert.throws(() => process.kill(run.pid, 0), /ESRCH/);
  assert.match(await l.supervisor.stop('lead-1', 'C-1', false), /^C-1 already ended as stopped/);
  assert.equal(await l.supervisor.stop('lead-1', 'C-1', true), 'Discarded C-1: removed its worktree and branch.');
  assert.equal(l.store.getChildRun('C-1').outcome, 'discarded');
  assert.equal(existsSync(run.worktree), false);
  assert.equal(git(l.repo, 'branch', '--list', 'child/feat/x/C-1'), '');
  assert.equal(await l.supervisor.stop('lead-1', 'C-1', true), 'C-1 is already discarded.');
  assert.deepEqual(l.messages, []);
});

test('a child stopped from the dashboard is reported to the lead once', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang' } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  l.store.endChildRun('C-1', { outcome: 'stopped', summary: 'stopped from the dashboard' }, 'user');
  process.kill(l.store.getChildRun('C-1').pid, 'SIGTERM');
  await until(() => l.messages.length === 1);
  assert.match(l.messages[0], /^Child C-1 finished: stopped\nGoal: Add retry to fetchJira\nSummary: stopped from the dashboard/);
});

test('shutdownAll ends even a stubborn child and leaves its run for recovery', async () => {
  const l = await lead({ behavior: { onPrompt: 'hang', ignoreStdinClose: true, ignoreTerm: true } });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await promptSent(l);
  await l.supervisor.shutdownAll();
  const log = readJsonl(l.log);
  assert.ok(log.some((entry) => entry.stdin === 'closed'));
  assert.ok(log.some((entry) => entry.signal === 'SIGTERM'));
  assert.throws(() => process.kill(l.store.getChildRun('C-1').pid, 0), /ESRCH/);
  assert.equal(l.store.getChildRun('C-1').outcome, 'running');
  assert.deepEqual(l.messages, []);
  const restarted = createSupervisor({ store: () => l.store, config: () => DEFAULT_CHILDREN, notify: () => {} });
  assert.deepEqual(restarted.recover('lead-1').map((run) => [run.id, run.outcome]), [['C-1', 'interrupted']]);
  assert.deepEqual(restarted.recover('lead-1'), []);
});

test('recover signals only a PID whose environment names the run', async () => {
  const rt = await memoryRuntime();
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const brief = { goal: 'Map the auth flow', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };
  for (const pid of [sleeper.pid, 999_999]) {
    const run = rt.store.createChildRun({ leadSession: 'lead-1', brief, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:lead-1');
    rt.store.updateChildRun(run.id, { pid });
  }
  const readers = { kill: () => {}, environ: (pid) => (pid === sleeper.pid ? 'HOME=/h\0PI_WORK_CHILD_RUN=C-1\0' : undefined) };
  const supervisor = createSupervisor({ store: () => rt.store, config: () => DEFAULT_CHILDREN, notify: () => {}, readers });
  assert.deepEqual(supervisor.recover('lead-1').map((run) => run.id), ['C-1', 'C-2']);
  await until(() => sleeper.signalCode === 'SIGTERM');
});

test('from continues an earlier run: the new worktree starts at its branch, and the old run is discarded', async () => {
  const l = await lead({ behavior: { commit: COMMIT }, declared: null });
  l.supervisor.delegate('lead-1', l.repo, implement());
  await until(() => l.messages.length === 1);
  const first = l.store.getChildRun('C-1');
  assert.equal(first.outcome, 'incomplete');
  writeFiles(first.worktree, { 'src/extra.ts': 'x\n' });
  const tip = git(first.worktree, 'rev-parse', 'HEAD');
  const second = l.supervisor.delegate('lead-1', l.repo, implement({ from: 'C-1' }));
  assert.equal(second.ok, true);
  assert.equal(second.run.baseCommit, first.baseCommit);
  assert.equal(git(second.run.worktree, 'rev-parse', 'HEAD~1'), tip);
  assert.equal(git(second.run.worktree, 'log', '-1', '--format=%s'), 'WIP: uncommitted work from C-1');
  assert.equal(l.store.getChildRun('C-1').outcome, 'discarded');
  assert.equal(existsSync(first.worktree), false);
  assert.equal(git(l.repo, 'branch', '--list', 'child/feat/x/C-1'), '');
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ from: 'C-1' })).message, /^Refused: C-1 is discarded\./);
  assert.match(l.supervisor.delegate('lead-1', l.repo, implement({ from: 'C-7' })).message, /^Refused: C-7 is not one of your implement runs\./);
  await until(() => l.messages.length === 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-supervisor.test.mjs`
Expected: FAIL. `l.supervisor.steer is not a function`, and the `from` test fails because the new worktree starts at the lead's `HEAD`.

- [ ] **Step 3: Implement steering, stopping, recovery, and `from`**

In `src/work/children/supervisor.ts`, directly below `import type { PidReaders } from "../liveness.ts";`, add:

```ts
import { systemPidReaders } from "../liveness.ts";
```

Replace `export const KILL_GRACE_MS = 10_000;` with:

```ts
export const KILL_GRACE_MS = 10_000;
export const ABORT_TIMEOUT_MS = 5_000;
```

Replace the `Supervisor` type with:

```ts
export type Supervisor = {
	delegate(leadSession: string, cwd: string, params: BriefParams): DelegateResult;
	list(leadSession: string): string;
	steer(leadSession: string, id: string, text: string, urgent: boolean): Promise<string>;
	stop(leadSession: string, id: string, discard: boolean): Promise<string>;
	recover(leadSession: string): ChildRun[];
	shutdownAll(): Promise<void>;
};
```

In `delegate`, replace:

```ts
		let prepare: ((id: string) => ChildWorktree) | undefined;
```

with:

```ts
		let prepare: ((id: string) => ChildWorktree) | undefined;
		let previous: ChildRun | undefined;
```

Replace:

```ts
			const start = git(cwd, ["rev-parse", "HEAD"]);
			const baseCommit = start;
			const repoRoot = root;
```

with:

```ts
			let start = git(cwd, ["rev-parse", "HEAD"]);
			let baseCommit = start;
			if (resolved.brief.from) {
				previous = find(leadSession, resolved.brief.from);
				if (!previous?.branch || !previous.baseCommit) return { ok: false, message: `Refused: ${resolved.brief.from} is not one of your implement runs.` };
				if (["running", "merged", "discarded"].includes(previous.outcome)) return { ok: false, message: `Refused: ${previous.id} is ${previous.outcome}.` };
				commitLeftovers(previous);
				start = previous.branch;
				baseCommit = previous.baseCommit;
			}
			const repoRoot = root;
```

Replace:

```ts
		launch(run, cwd, config);
```

with:

```ts
		// The new branch holds the earlier run's commits, so the earlier worktree and branch can go.
		if (previous && root) {
			removeWorktree(git, root, previous.worktree, previous.branch);
			store.markChildRunDiscarded(previous.id, actorOf(previous));
		}
		launch(run, cwd, config);
```

Replace the final `return { delegate, list };` with:

```ts
	function find(leadSession: string, id: string): ChildRun | undefined {
		try {
			const run = deps.store().getChildRun(id);
			return run?.leadSession === leadSession ? run : undefined;
		} catch {
			return undefined;
		}
	}

	function commitLeftovers(run: ChildRun): void {
		if (!run.worktree) return;
		try {
			if (git(run.worktree, ["status", "--porcelain"]) === "") return;
			git(run.worktree, ["add", "-A"]);
			git(run.worktree, ["commit", "--no-verify", "-q", "-m", `WIP: uncommitted work from ${run.id}`]);
		} catch {
			// The worktree may be gone already; its branch still holds the committed work.
		}
	}

	async function steer(leadSession: string, id: string, text: string, urgent: boolean): Promise<string> {
		const run = find(leadSession, id);
		if (!run) return `${id} is not one of your child runs.`;
		const handle = handles.get(id);
		if (!handle || handle.stopping) {
			const state = run.outcome === "running" ? "finishing" : run.outcome;
			return `${id} is ${state} and can no longer be steered. Delegate again${run.kind === "implement" ? ` with from: ${id}` : ""} to continue.`;
		}
		try {
			await handle.child.request({ type: urgent ? "steer" : "follow_up", message: text });
		} catch (error) {
			return `Could not reach ${id}: ${errorMessage(error)}`;
		}
		return urgent ? `Steered ${id}: it reads your message after its current tool calls.` : `Queued for ${id}: it reads your message at its next quiet moment.`;
	}

	async function stop(leadSession: string, id: string, discardToo: boolean): Promise<string> {
		const run = find(leadSession, id);
		if (!run) return `${id} is not one of your child runs.`;
		const handle = handles.get(id);
		const wasRunning = handle !== undefined || run.outcome === "running";
		if (handle) {
			handle.stopping = true;
			try {
				await handle.child.request({ type: "abort" }, ABORT_TIMEOUT_MS);
			} catch {
				// The shutdown below ends it anyway.
			}
			await finish(id, { kind: "settled" });
			await handle.child.shutdown(grace);
		} else if (run.outcome === "running") {
			killOrphan(run);
			deps.store().endChildRun(id, { outcome: "stopped", summary: "stopped by the lead" }, actorOf(run));
		}
		if (discardToo) return discard(id);
		if (!wasRunning) return `${id} already ended as ${run.outcome}. Pass discard: true to remove its worktree and branch.`;
		return `Stopped ${id}. Its worktree and branch are kept${run.branch ? ` (${run.branch})` : ""}.`;
	}

	function discard(id: string): string {
		const store = deps.store();
		const run = store.getChildRun(id) as ChildRun;
		if (run.outcome === "merged" || run.outcome === "discarded") return `${id} is already ${run.outcome}.`;
		const root = rootOf(run);
		if (root) removeWorktree(git, root, run.worktree, run.branch);
		store.markChildRunDiscarded(id, actorOf(run));
		return `Discarded ${id}${root ? ": removed its worktree and branch" : ""}.`;
	}

	// Only a PID whose environment names this run is signalled, so a reused PID is never hit.
	function killOrphan(run: ChildRun): void {
		const environ = run.pid ? (deps.readers ?? systemPidReaders).environ(run.pid) : undefined;
		if (!run.pid || !environ?.split("\0").includes(`${CHILD_RUN_ENV}=${run.id}`)) return;
		try {
			process.kill(run.pid, "SIGTERM");
		} catch {
			// It exited meanwhile.
		}
	}

	function recover(leadSession: string): ChildRun[] {
		const store = deps.store();
		return store
			.listChildRuns({ leadSession, outcome: "running" })
			.filter((run) => !handles.has(run.id))
			.map((run) => {
				killOrphan(run);
				return store.endChildRun(run.id, { outcome: "interrupted", summary: "the lead session ended while this child was running" }, actorOf(run));
			});
	}

	// A clean lead shutdown ends the processes but records nothing, so the next lead start reports the runs.
	async function shutdownAll(): Promise<void> {
		const all = [...handles.values()];
		handles.clear();
		for (const handle of all) handle.finished = true;
		await Promise.all(all.map((handle) => handle.child.shutdown(grace)));
	}

	return { delegate, list, steer, stop, recover, shutdownAll };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-supervisor.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Run the part 3 gates**

Run: `npm test && npm run -s typecheck && npm run -s check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/work/children/supervisor.ts tests/work/child-supervisor.test.mjs
git commit -m "feat: steer, stop, discard, recover, and continue child runs"
```

- [ ] **Step 7: STOP for review (end of part 3)**

Report the commits of this part and any deviations. Do not start part 4.

---

# Part 4: Merging, Lead Tools, Dashboard, and Docs

### Task 12: `merge_child`

**Files:**
- Create: `src/work/children/merge.ts`
- Test: `tests/work/child-merge.test.mjs`

**Interfaces:**
- Consumes: the git helpers (Task 4), `BUILT_IN_IGNORE` (Task 3), `repoChildrenConfig` and `GithubAccount` from `src/work/config.ts`, `GhRunner` and `defaultGhRunner` from `src/work/connectors/github.ts`, `errorMessage` and `redact` from `src/work/secrets.ts`, and `store.markChildRunMerged` (Task 2).
- Produces:
  - `MergeDeps = { store: WorkStore; config: ChildrenConfig; accounts: readonly GithubAccount[]; git?: GitRunner; gh?: GhRunner }`
  - `mergeChild(deps, leadSession, cwd, id): Promise<string>`. It returns the tool text, and it never throws for expected failures. Refusals start with `Refused: `. Successes start with `Merged C-<n> into <branch>.` and describe the push and the PR.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/child-merge.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { configureGit, git, gitRepo, load, memoryStore, tempDir, writeFiles } from './helpers.mjs';

const { mergeChild } = await load('src/work/children/merge.ts');
const { addWorktree, excludeChildWorktrees, runGit } = await load('src/work/children/git.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');

const REMOTE = 'https://github.com/example-org/api.git';
const PR = 'https://github.com/example-org/api/pull/7';
const BRIEF = { goal: 'Add retry to fetchJira', kind: 'implement', scope: ['src/**'], nonGoals: [], acceptance: ['true'], context: '', model: null, modelReason: null, from: null };

// A lead clone on feat/x whose origin URL names GitHub but pushes to a local bare repository, plus a fake gh.
async function project({ accounts = [{ user: 'work-account', orgs: ['example-org'] }] } = {}) {
  const seed = gitRepo({ 'src/a.ts': 'one\n' });
  const root = realpathSync(tempDir());
  const bare = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', seed, bare);
  git(root, 'clone', '-q', bare, 'lead');
  const lead = join(root, 'lead');
  configureGit(lead);
  git(lead, 'config', 'remote.origin.url', REMOTE);
  git(lead, 'config', `url.${bare}.insteadOf`, REMOTE);
  git(lead, 'checkout', '-q', '-b', 'feat/x');
  excludeChildWorktrees(runGit, lead);
  const prs = [];
  const calls = [];
  const gh = async (args, env) => {
    calls.push({ args, env });
    if (args[0] === 'auth') return 'tok-123\n';
    if (args[1] === 'list') return JSON.stringify(prs);
    if (args[1] === 'create') {
      prs.push({ url: PR });
      return `${PR}\n`;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const store = await memoryStore();
  return { lead, bare, store, calls, deps: { store, config: DEFAULT_CHILDREN, accounts, gh } };
}

// Records a finished child the way the supervisor would: a worktree on its own branch with one commit.
function finishedChild(p, { files, lines = 1, outcome = 'done', exitCode = 0 } = {}) {
  const base = git(p.lead, 'rev-parse', 'HEAD');
  const run = p.store.createChildRun({ leadSession: 'lead-1', brief: BRIEF, model: 'anthropic/claude-sonnet-5', repo: 'api', budgetLines: 300, budgetFiles: 8 }, 'session:lead-1', (id) => {
    const worktree = join(p.lead, '.pi', 'worktrees', `child-${id}`);
    const branch = `child/feat/x/${id}`;
    addWorktree(runGit, p.lead, worktree, branch, base);
    return { worktree, branch, baseCommit: base };
  });
  writeFiles(run.worktree, files ?? { [`src/${run.id}.ts`]: 'x\n'.repeat(lines) });
  git(run.worktree, 'add', '-A');
  git(run.worktree, 'commit', '-q', '-m', `child ${run.id}`);
  p.store.endChildRun(run.id, { outcome, summary: 'Added retry', acceptance: [{ command: 'true', exitCode, summary: '' }] }, 'session:lead-1');
  return p.store.getChildRun(run.id);
}

test('merge_child refuses other leads, unfinished runs, failed acceptance, a dirty tree, the PR cap, and the default branch', async () => {
  const p = await project();
  const failing = finishedChild(p, { exitCode: 1 });
  assert.equal(await mergeChild(p.deps, 'lead-2', p.lead, failing.id), 'Refused: C-1 is not one of your implement runs.');
  assert.equal(await mergeChild(p.deps, 'lead-1', p.lead, failing.id), 'Refused: acceptance did not pass (true).');
  const incomplete = finishedChild(p, { outcome: 'incomplete' });
  assert.equal(await mergeChild(p.deps, 'lead-1', p.lead, incomplete.id), 'Refused: C-2 is incomplete; only done runs merge.');
  const big = finishedChild(p, { lines: 50 });
  const capped = { ...p.deps, config: { ...DEFAULT_CHILDREN, diffBudget: { ...DEFAULT_CHILDREN.diffBudget, prLines: 40 } } };
  assert.match(await mergeChild(capped, 'lead-1', p.lead, big.id), /^Refused: the PR would reach 50 lines \(0 on feat\/x \+ 50 from C-3\), over the 40-line cap\./);
  writeFiles(p.lead, { 'src/a.ts': 'dirty\n' });
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, big.id), /^Refused: your working tree has uncommitted changes/);
  git(p.lead, 'checkout', '-q', '--', 'src/a.ts');
  git(p.lead, 'checkout', '-q', 'main');
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, big.id), /^Refused: main is the default branch/);
  assert.deepEqual(p.calls, []);
  assert.equal(p.store.getChildRun('C-3').outcome, 'done');
});

test('merge_child merges with --no-ff, cleans up, pushes with an upstream, and opens a draft PR', async () => {
  const p = await project();
  const run = finishedChild(p);
  const text = await mergeChild(p.deps, 'lead-1', p.lead, run.id);
  assert.match(text, /^Merged C-1 into feat\/x\. Pushed and opened a draft PR: https:\/\/github\.com\/example-org\/api\/pull\/7\./);
  assert.match(text, /end with session_status needs-me and the note `ready for review: <PR URL>`/);
  assert.equal(git(p.lead, 'log', '-1', '--format=%s'), 'Merge child C-1: Add retry to fetchJira');
  assert.equal(git(p.lead, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  assert.equal(existsSync(run.worktree), false);
  assert.equal(git(p.lead, 'branch', '--list', run.branch), '');
  assert.equal(p.store.getChildRun('C-1').outcome, 'merged');
  assert.equal(p.store.listEvents().at(-1).action, 'merge');
  assert.equal(git(p.bare, 'rev-parse', 'refs/heads/feat/x'), git(p.lead, 'rev-parse', 'HEAD'));
  assert.equal(git(p.lead, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feat/x');
  assert.deepEqual(p.calls.map((call) => call.args.slice(0, 2)), [['auth', 'token'], ['pr', 'list'], ['pr', 'create']]);
  assert.deepEqual(p.calls[2].env, { GH_TOKEN: 'tok-123' });
  assert.deepEqual(p.calls[2].args, ['pr', 'create', '--draft', '--repo', 'example-org/api', '--base', 'main', '--head', 'feat/x', '--title', 'Add retry to fetchJira', '--body', 'Merged child runs:\n- C-1: Add retry to fetchJira (Added retry)']);
});

test('a second merge pushes to the existing upstream and leaves the existing draft PR', async () => {
  const p = await project();
  await mergeChild(p.deps, 'lead-1', p.lead, finishedChild(p).id);
  p.calls.length = 0;
  const text = await mergeChild(p.deps, 'lead-1', p.lead, finishedChild(p).id);
  assert.match(text, /^Merged C-2 into feat\/x\. Pushed; the draft PR now carries the new commits: https:\/\/github\.com\/example-org\/api\/pull\/7\./);
  assert.deepEqual(p.calls.map((call) => call.args[1]), ['token', 'list']);
  assert.equal(git(p.bare, 'rev-parse', 'refs/heads/feat/x'), git(p.lead, 'rev-parse', 'HEAD'));
});

test('without a GitHub account the local merge and push stand, and a retry creates the PR', async () => {
  const p = await project({ accounts: [] });
  const run = finishedChild(p);
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /^Merged C-1 into feat\/x\. Pushed\. No GitHub account in the work config covers example-org/);
  assert.equal(p.store.getChildRun('C-1').outcome, 'merged');
  const retry = await mergeChild({ ...p.deps, accounts: [{ user: 'work-account', orgs: ['Example-Org'] }] }, 'lead-1', p.lead, run.id);
  assert.match(retry, /^Merged C-1 into feat\/x\. Pushed and opened a draft PR/);
});

test('a failed push leaves the local merge, and the next merge_child retries it', async () => {
  const p = await project();
  const run = finishedChild(p);
  renameSync(p.bare, `${p.bare}.off`);
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /^Merged C-1 into feat\/x\. The push failed, and the local merge stands: [\s\S]+ Call merge_child C-1 again to retry\.$/);
  assert.equal(p.store.getChildRun('C-1').outcome, 'merged');
  assert.deepEqual(p.calls, []);
  renameSync(`${p.bare}.off`, p.bare);
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /Pushed and opened a draft PR/);
});

test('a merge conflict is aborted and refused, and the run stays done', async () => {
  const p = await project();
  const run = finishedChild(p, { files: { 'src/a.ts': 'child\n' } });
  writeFiles(p.lead, { 'src/a.ts': 'lead\n' });
  git(p.lead, 'commit', '-q', '-am', 'lead change');
  assert.match(await mergeChild(p.deps, 'lead-1', p.lead, run.id), /^Refused: merging child\/feat\/x\/C-1 failed and was aborted: /);
  assert.equal(git(p.lead, 'status', '--porcelain'), '');
  assert.equal(p.store.getChildRun('C-1').outcome, 'done');
  assert.equal(existsSync(run.worktree), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/child-merge.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/children/merge.ts`.

- [ ] **Step 3: Implement merging**

Create `src/work/children/merge.ts`:

```ts
import type { ChildrenConfig, GithubAccount } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { GhRunner } from "../connectors/github.ts";
import { defaultGhRunner } from "../connectors/github.ts";
import type { GitRunner } from "../rules.ts";
import { errorMessage, redact } from "../secrets.ts";
import type { WorkStore } from "../store.ts";
import type { ChildRun } from "../types.ts";
import { defaultBranchRef, gitText, isClean, isDefaultBranch, measureDiff, parseGithubRepo, removeWorktree, runGit } from "./git.ts";
import { BUILT_IN_IGNORE } from "./guards.ts";

export type MergeDeps = { store: WorkStore; config: ChildrenConfig; accounts: readonly GithubAccount[]; git?: GitRunner; gh?: GhRunner };

type Merging = { run: ChildRun; branch: string; childBranch: string; baseCommit: string; defaultRef: string | undefined };

const FINISH = "When the whole task is complete, end with session_status needs-me and the note `ready for review: <PR URL>`.";

export async function mergeChild(deps: MergeDeps, leadSession: string, cwd: string, id: string): Promise<string> {
	const git = deps.git ?? runGit;
	let run: ChildRun | undefined;
	try {
		run = deps.store.getChildRun(id);
	} catch {
		run = undefined;
	}
	if (!run || run.leadSession !== leadSession || run.kind !== "implement" || !run.branch || !run.baseCommit) return `Refused: ${id} is not one of your implement runs.`;
	const branch = gitText(git, cwd, ["branch", "--show-current"]);
	if (!branch) return "Refused: check out your branch first (HEAD is detached).";
	const defaultRef = defaultBranchRef(git, cwd);
	if (isDefaultBranch(branch, defaultRef)) return `Refused: ${branch} is the default branch. Child work merges into a feature branch.`;
	const merging: Merging = { run, branch, childBranch: run.branch, baseCommit: run.baseCommit, defaultRef };
	// A merged run skips straight to the push and the PR, which retries a step that failed last time.
	if (run.outcome !== "merged") {
		const refusal = refusalFor(deps, git, cwd, merging);
		if (refusal) return `Refused: ${refusal}`;
		try {
			git(cwd, ["merge", "--no-ff", "-m", `Merge child ${run.id}: ${run.brief.goal}`, run.branch]);
		} catch (error) {
			try {
				git(cwd, ["merge", "--abort"]);
			} catch {
				// Nothing to abort.
			}
			return `Refused: merging ${run.branch} failed and was aborted: ${errorMessage(error)}`;
		}
		removeWorktree(git, cwd, run.worktree, run.branch);
		deps.store.markChildRunMerged(run.id, `session:${leadSession}`);
	}
	return `Merged ${run.id} into ${branch}. ${await publish(deps, git, cwd, merging)}`;
}

function refusalFor(deps: MergeDeps, git: GitRunner, cwd: string, m: Merging): string | undefined {
	const { run } = m;
	if (run.outcome !== "done") return `${run.id} is ${run.outcome}; only done runs merge.`;
	const failed = run.acceptance.filter((result) => result.exitCode !== 0);
	if (run.acceptance.length === 0 || failed.length > 0) return `acceptance did not pass (${failed.map((result) => result.command).join(", ") || "no results"}).`;
	if (!isClean(git, cwd)) return "your working tree has uncommitted changes. Commit or stash them first.";
	const ignore = [...BUILT_IN_IGNORE, ...repoChildrenConfig(deps.config, run.repo).ignore];
	const mergeBase = m.defaultRef ? gitText(git, cwd, ["merge-base", "HEAD", m.defaultRef]) : undefined;
	const lead = mergeBase ? measureDiff(git, cwd, { from: mergeBase, to: "HEAD", ignore }).lines : 0;
	const child = measureDiff(git, cwd, { from: m.baseCommit, to: m.childBranch, ignore }).lines;
	const cap = deps.config.diffBudget.prLines;
	if (lead + child > cap) return `the PR would reach ${lead + child} lines (${lead} on ${m.branch} + ${child} from ${run.id}), over the ${cap}-line cap. Split the rest into another branch and PR.`;
	return undefined;
}

// Pushes without force, then finds or creates the draft PR with the account the config maps to the repository's org.
async function publish(deps: MergeDeps, git: GitRunner, cwd: string, m: Merging): Promise<string> {
	const retry = `merge_child ${m.run.id} again to retry.`;
	try {
		const upstream = gitText(git, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		git(cwd, upstream ? ["push"] : ["push", "-u", "origin", m.branch]);
	} catch (error) {
		return `The push failed, and the local merge stands: ${errorMessage(error)}. Call ${retry}`;
	}
	const repo = parseGithubRepo(gitText(git, cwd, ["config", "--get", "remote.origin.url"]) ?? "");
	if (!repo) return `Pushed. origin is not a GitHub repository, so no draft PR was created. ${FINISH}`;
	const owner = (repo.split("/")[0] ?? "").toLowerCase();
	const account = deps.accounts.find((candidate) => candidate.orgs.some((org) => org.toLowerCase() === owner));
	if (!account) return `Pushed. No GitHub account in the work config covers ${owner}, so no draft PR was created. Add one, then call ${retry}`;
	const gh = deps.gh ?? defaultGhRunner;
	let token = "";
	try {
		token = (await gh(["auth", "token", "--user", account.user])).trim();
		const env = { GH_TOKEN: token };
		const open = JSON.parse((await gh(["pr", "list", "--repo", repo, "--head", m.branch, "--state", "open", "--json", "url", "--limit", "1"], env)) || "[]") as { url?: string }[];
		if (open[0]?.url) return `Pushed; the draft PR now carries the new commits: ${open[0].url}. ${FINISH}`;
		const base = m.defaultRef?.replace(/^origin\//, "") ?? "main";
		const body = `Merged child runs:\n- ${m.run.id}: ${m.run.brief.goal}${m.run.summary ? ` (${m.run.summary})` : ""}`;
		const url = (await gh(["pr", "create", "--draft", "--repo", repo, "--base", base, "--head", m.branch, "--title", m.run.brief.goal, "--body", body], env)).trim();
		return `Pushed and opened a draft PR: ${url}. ${FINISH}`;
	} catch (error) {
		return `Pushed, but the draft PR step failed: ${redact(errorMessage(error), token ? [token] : [])}. The local merge stands; call ${retry}`;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/child-merge.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/children/merge.ts tests/work/child-merge.test.mjs
git commit -m "feat: merge done children, push, and keep a draft PR"
```

---

### Task 13: Lead tools and lead mode in the extension

**Files:**
- Create: `src/work/children/lead-tools.ts`
- Modify: `extensions/work.ts`
- Modify: `tests/work/session-hooks.test.mjs`: the fake Pi gains `getActiveTools` and `setActiveTools`
- Test: `tests/work/lead-tools.test.mjs`

**Interfaces:**
- Consumes: `createSupervisor`, `Supervisor`, and `SupervisorDeps` (Tasks 10 and 11), `mergeChild` (Task 12), `renderInterrupted` (Task 10), `GOAL_MAX` and `CONTEXT_MAX` (Task 9), `CHILD_KINDS` (Task 2).
- Produces:
  - `LEAD_TOOLS = ["delegate", "children", "steer_child", "stop_child", "merge_child"]`, `CHILD_MESSAGE = "work-child"`, and a description constant per tool
  - `registerLeadTools(pi, { supervisor, merge(leadSession, cwd, id): Promise<string> }): void`
  - `WorkExtensionOptions` gains `supervisor?: Partial<Omit<SupervisorDeps, "store" | "config" | "notify">>` and `gh?: GhRunner`.
  - In a non-child session, the extension registers the five tools. At `session_start`, a TUI session shows `children…` config warnings, recovers interrupted runs, and sends one `work-child` message listing them. Other modes deactivate the five tools. `session_shutdown` calls `supervisor.shutdownAll()`. Result messages use `deliverAs: "followUp"` and `triggerTurn: true`.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/lead-tools.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, memoryRuntime, tempDir, until } from './helpers.mjs';

const { createWorkExtension } = await load('extensions/work.ts');
const FAKE = fileURLToPath(new URL('./fixtures/fake-rpc-child.mjs', import.meta.url));
const READ_ONLY = { goal: 'Map the auth flow', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };

function setup({ runtime, env = {}, mode = 'tui', supervisor = {} }) {
  const tools = new Map();
  const events = new Map();
  const sent = [];
  let active;
  createWorkExtension({
    runtime: () => runtime, repoFromCwd: () => undefined, env, pid: 4242, tmux: () => '',
    git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter(), supervisor,
  })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
    sendMessage(message, options) { sent.push({ message, options }); },
    getActiveTools: () => [...tools.keys()],
    setActiveTools(names) { active = names; },
  });
  const notes = [];
  const ctx = {
    cwd: tempDir(), mode, hasUI: true,
    sessionManager: { getSessionId: () => 'lead-1', getSessionFile: () => undefined, getSessionName: () => undefined },
    ui: { notify: (message, level) => notes.push({ message, level }), setStatus() {} },
    abort() {}, shutdown() {},
  };
  const run = (name, params) => tools.get(name).execute('call-1', params, undefined, undefined, ctx);
  return { tools, sent, notes, ctx, run, active: () => active, emit: (name, event = {}) => events.get(name)(event, ctx) };
}

test('a lead gets five static delegation tools, and a child gets none', async () => {
  const lead = setup({ runtime: await memoryRuntime() });
  for (const name of ['delegate', 'children', 'steer_child', 'stop_child', 'merge_child']) assert.ok(lead.tools.has(name), name);
  assert.deepEqual(Object.keys(lead.tools.get('delegate').parameters.properties).sort(), ['acceptance', 'budget', 'context', 'from', 'goal', 'kind', 'model', 'model_reason', 'non_goals', 'scope']);
  const child = setup({ runtime: await memoryRuntime(), env: { PI_WORK_CHILD_RUN: 'C-1' }, mode: 'rpc' });
  assert.equal([...child.tools.keys()].some((name) => ['delegate', 'children', 'steer_child', 'stop_child', 'merge_child'].includes(name)), false);
});

test('a non-TUI top-level session deactivates the delegation tools', async () => {
  const s = setup({ runtime: await memoryRuntime(), mode: 'rpc' });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(s.active().includes('delegate'), false);
  assert.equal(s.active().includes('merge_child'), false);
  assert.ok(s.active().includes('session_status'));
});

test('a TUI lead start shows children config warnings and reports interrupted runs once', async () => {
  const rt = await memoryRuntime();
  rt.warnings.push('children.spendCapUsd must be a positive number; using 5', 'jira config needs an https site, email, secret.command, and defaultProject; Jira is disabled');
  rt.store.createChildRun({ leadSession: 'lead-1', brief: READ_ONLY, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:lead-1');
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(rt.store.getChildRun('C-1').outcome, 'interrupted');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].message.customType, 'work-child');
  assert.match(s.sent[0].message.content, /^These child runs were interrupted[\s\S]*- C-1 \(read-only\): Map the auth flow/);
  assert.deepEqual(s.sent[0].options, { deliverAs: 'followUp', triggerTurn: true });
  assert.deepEqual(s.notes.filter((note) => note.level === 'warning').map((note) => note.message), ['children.spendCapUsd must be a positive number; using 5']);
});

test('delegate, children, stop_child, and merge_child work end to end with a fake child', async () => {
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 'child-s1', file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: 'lead-1', headless: true });
  rt.store.setSessionStatus('child-s1', 'done', 'Found it', 'agent');
  const log = join(tempDir(), 'child.jsonl');
  const s = setup({
    runtime: rt,
    supervisor: { command: [process.execPath, FAKE], env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify({ sessionId: 'child-s1' }), FAKE_CHILD_LOG: log }, killGraceMs: 200 },
  });
  const started = await s.run('delegate', { goal: 'Map the auth flow', kind: 'read-only' });
  assert.match(started.content[0].text, /^Started C-1 \(read-only, in your working directory\)/);
  assert.equal(started.details.runId, 'C-1');
  await until(() => s.sent.length === 1);
  assert.match(s.sent[0].message.content, /^Child C-1 finished: done/);
  assert.deepEqual(s.sent[0].options, { deliverAs: 'followUp', triggerTurn: true });
  assert.match((await s.run('children', {})).content[0].text, /^C-1  done  sonnet-5  \$0\.00  read-only  goal: Map the auth flow  note: Found it$/);
  assert.equal((await s.run('merge_child', { id: 'C-1' })).content[0].text, 'Refused: C-1 is not one of your implement runs.');
  assert.equal((await s.run('stop_child', { id: 'C-1', discard: true })).content[0].text, 'Discarded C-1.');
  assert.match((await s.run('steer_child', { id: 'C-1', text: 'hi' })).content[0].text, /can no longer be steered/);
});
```

In `tests/work/session-hooks.test.mjs`, in `setup`, replace:

```js
    on(name, handler) { events.set(name, handler); },
  });
```

with:

```js
    on(name, handler) { events.set(name, handler); },
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/lead-tools.test.mjs`
Expected: FAIL, because the lead tools are not registered (`lead.tools.has('delegate')` is false).

- [ ] **Step 3: Implement the lead tools**

Create `src/work/children/lead-tools.ts`:

```ts
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHILD_KINDS } from "../types.ts";
import { CONTEXT_MAX, GOAL_MAX } from "./brief.ts";
import type { Supervisor } from "./supervisor.ts";

export const LEAD_TOOLS: readonly string[] = ["delegate", "children", "steer_child", "stop_child", "merge_child"];
export const CHILD_MESSAGE = "work-child";

export const DELEGATE_DESCRIPTION = "Hand a task to a headless child agent and keep working; its result arrives later as one message. kind implement: the child works in its own worktree and branch from your current HEAD (commit first), may change only `scope`, and must pass `acceptance`, which are targeted test commands, never full suites. kind read-only: it investigates in your directory without editing. Keep briefs small: a one-sentence goal, a tight scope, and a budget only as large as needed. `from: C-<n>` continues an earlier run's branch.";
export const CHILDREN_DESCRIPTION = "List your child runs: state, model, spend, diff against budget, acceptance results, and each child's note.";
export const STEER_DESCRIPTION = "Send guidance to a running child. By default it arrives at the child's next quiet moment; urgent: true delivers it right after the child's current tool calls.";
export const STOP_DESCRIPTION = "Stop a running child and end its process. Its worktree and branch are kept unless discard: true, which also removes them. Discard also works on finished runs.";
export const MERGE_DESCRIPTION = "Merge a done child whose acceptance passed into your branch (review its diff with git first), push without force, and create or update the draft PR. It never marks the PR ready or merges it.";

export type LeadToolDeps = { supervisor: Supervisor; merge: (leadSession: string, cwd: string, id: string) => Promise<string> };

const RUN_ID = Type.String({ pattern: "^C-\\d+$" });

function reply(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export function registerLeadTools(pi: ExtensionAPI, deps: LeadToolDeps): void {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: DELEGATE_DESCRIPTION,
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: GOAL_MAX }),
			kind: StringEnum([...CHILD_KINDS] as const),
			scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			non_goals: Type.Optional(Type.Array(Type.String())),
			acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			context: Type.Optional(Type.String({ maxLength: CONTEXT_MAX })),
			budget: Type.Optional(Type.Object({ lines: Type.Optional(Type.Integer({ minimum: 1 })), files: Type.Optional(Type.Integer({ minimum: 1 })) })),
			model: Type.Optional(Type.String({ minLength: 1 })),
			model_reason: Type.Optional(Type.String({ maxLength: 200 })),
			from: Type.Optional(RUN_ID),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = deps.supervisor.delegate(ctx.sessionManager.getSessionId(), ctx.cwd, params);
			return reply(result.message, { runId: result.ok ? result.run.id : null });
		},
	});

	pi.registerTool({
		name: "children",
		label: "Children",
		description: CHILDREN_DESCRIPTION,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return reply(deps.supervisor.list(ctx.sessionManager.getSessionId()));
		},
	});

	pi.registerTool({
		name: "steer_child",
		label: "Steer Child",
		description: STEER_DESCRIPTION,
		parameters: Type.Object({ id: RUN_ID, text: Type.String({ minLength: 1, maxLength: CONTEXT_MAX }), urgent: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return reply(await deps.supervisor.steer(ctx.sessionManager.getSessionId(), params.id, params.text, params.urgent === true));
		},
	});

	pi.registerTool({
		name: "stop_child",
		label: "Stop Child",
		description: STOP_DESCRIPTION,
		parameters: Type.Object({ id: RUN_ID, discard: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return reply(await deps.supervisor.stop(ctx.sessionManager.getSessionId(), params.id, params.discard === true));
		},
	});

	pi.registerTool({
		name: "merge_child",
		label: "Merge Child",
		description: MERGE_DESCRIPTION,
		parameters: Type.Object({ id: RUN_ID }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return reply(await deps.merge(ctx.sessionManager.getSessionId(), ctx.cwd, params.id));
		},
	});
}
```

- [ ] **Step 4: Wire lead mode into the extension**

In `extensions/work.ts`, replace the four child-module imports added in Task 7:

```ts
import type { ChildGuard } from "../src/work/children/child-guard.ts";
import { CHILD_RUN_ENV, createChildGuard, failClosedGuard, PARENT_PID_ENV } from "../src/work/children/child-guard.ts";
import { runGit } from "../src/work/children/git.ts";
import { startWatchdog } from "../src/work/children/watchdog.ts";
```

with:

```ts
import type { ChildGuard } from "../src/work/children/child-guard.ts";
import { CHILD_RUN_ENV, createChildGuard, failClosedGuard, PARENT_PID_ENV } from "../src/work/children/child-guard.ts";
import { renderInterrupted } from "../src/work/children/format.ts";
import { runGit } from "../src/work/children/git.ts";
import { CHILD_MESSAGE, LEAD_TOOLS, registerLeadTools } from "../src/work/children/lead-tools.ts";
import { mergeChild } from "../src/work/children/merge.ts";
import type { SupervisorDeps } from "../src/work/children/supervisor.ts";
import { createSupervisor } from "../src/work/children/supervisor.ts";
import { startWatchdog } from "../src/work/children/watchdog.ts";
```

Directly below `import { childrenConfig, expandHome } from "../src/work/config.ts";`, add:

```ts
import type { GhRunner } from "../src/work/connectors/github.ts";
```

In `WorkExtensionOptions`, after `watchdog?: typeof startWatchdog;`, add:

```ts
	supervisor?: Partial<Omit<SupervisorDeps, "store" | "config" | "notify">>;
	gh?: GhRunner;
```

Directly after the `if (childRunId) { … }` block from Task 7, add:

```ts
		// Lead mode: delegation tools in every session that is not itself a child (only TUI sessions keep them active).
		const notifyLead = (text: string): void => {
			pi.sendMessage({ customType: CHILD_MESSAGE, content: text, display: true }, { deliverAs: "followUp", triggerTurn: true });
		};
		const supervisor = childRunId
			? undefined
			: createSupervisor({ store: () => rt().store, config: () => childrenConfig(rt().config), notify: notifyLead, pid: options.pid, ...options.supervisor });
		if (supervisor) {
			registerLeadTools(pi, {
				supervisor,
				merge: (leadSession, cwd, id) => {
					const r = rt();
					return mergeChild({ store: r.store, config: childrenConfig(r.config), accounts: r.config.github.accounts, gh: options.gh }, leadSession, cwd, id);
				},
			});
		}
		const startLead = (ctx: ExtensionContext): void => {
			if (!supervisor) return;
			if (ctx.mode !== "tui") {
				pi.setActiveTools(pi.getActiveTools().filter((name) => !LEAD_TOOLS.includes(name)));
				return;
			}
			try {
				const r = rt();
				for (const warning of r.warnings) if (warning.startsWith("children")) ctx.ui.notify(warning, "warning");
				const interrupted = supervisor.recover(ctx.sessionManager.getSessionId());
				if (interrupted.length > 0) notifyLead(renderInterrupted(interrupted));
			} catch {
				// The session tracker already warns once when the registry fails.
			}
		};
```

In the `session_start` handler, replace `			startChild(ctx);` with:

```ts
			startChild(ctx);
			startLead(ctx);
```

In the `session_shutdown` handler, directly after `stopWatchdog = undefined;`, add:

```ts
			await supervisor?.shutdownAll();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/lead-tools.test.mjs tests/work/session-hooks.test.mjs tests/work/extension.test.mjs tests/work/child-extension.test.mjs tests/work/usage.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/children/lead-tools.ts extensions/work.ts tests/work/lead-tools.test.mjs tests/work/session-hooks.test.mjs
git commit -m "feat: give project leads delegate, children, steer, stop, and merge tools"
```

---

### Task 14: Child runs in the dashboard

**Files:**
- Modify: `src/work/dash/model.ts`, `src/work/dash/view.ts`, `src/work/dash/app.ts`
- Modify: `tests/work/dash-view.test.mjs`, `tests/work/dash-app.test.mjs`: append tests

**Interfaces:**
- Consumes: `store.childRunForSession` and `store.endChildRun` (Task 2), `modelShortName` (Task 10).
- Produces:
  - `SessionEntry` gains `run?: ChildRun | null`, and `loadSessions` sets it for child sessions.
  - A child row with a run shows the run ID in the window column. Its note reads `[outcome ]model $spend lines/budget "goal"` (single spaces, because `oneLine` collapses runs of spaces), with the outcome omitted while running and `read-only` in place of the diff.
  - `x` then `y` on a child with a running run records `stopped` (actor `user`, summary `stopped from the dashboard`) before sending `SIGTERM`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/work/dash-view.test.mjs`:

```js
test('a child row with a run shows its ID, model, spend, and diff against budget', () => {
  const run = { id: 'C-4', model: 'anthropic/claude-sonnet-5', spendUsd: 1.2, diffLines: 212, budgetLines: 300, outcome: 'running', brief: { goal: 'Add retry to fetchJira' } };
  const sessions = [
    entry({ id: 'p', tmuxWindow: 'api', status: 'working' }),
    entry({ id: 'c', parentSession: 'p', headless: true, tmuxPane: null, status: 'done', run }),
    entry({ id: 'd', parentSession: 'p', headless: true, tmuxPane: null, status: 'done', run: { ...run, id: 'C-5', outcome: 'merged', budgetLines: null } }),
  ];
  const lines = plain(renderDash(buildDashModel({ sessions, triageCount: 0, now: NOW }), state({ selected: null }), 100, 20, plainStyle));
  assert.ok(lines.some((line) => /^ {4}done\s+C-4\s+-\s+\S+\s+sonnet-5 \$1\.20 212\/300 "Add retry to fetchJira"$/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^ {4}done\s+C-5\s+-\s+\S+\s+merged sonnet-5 \$1\.20 read-only "Add retry to fetchJira"$/.test(line)), lines.join('\n'));
});

test('loadSessions attaches each child session its run', async () => {
  const store = await memoryStore();
  const start = (id, parentSession) => store.startSession({ id, file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession, headless: parentSession !== null });
  start('p', null);
  start('c', 'p');
  const brief = { goal: 'Map it', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };
  store.createChildRun({ leadSession: 'p', brief, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:p');
  store.updateChildRun('C-1', { childSession: 'c' });
  const entries = loadSessions(store, [], { kill: () => {}, environ: () => undefined });
  assert.equal(entries.find((e) => e.id === 'c').run.id, 'C-1');
  assert.equal(entries.find((e) => e.id === 'p').run, null);
});
```

Append to `tests/work/dash-app.test.mjs`:

```js
test('x then y on a child with a running run records the stop before sending SIGTERM', async () => {
  const { rt, store } = await fixture();
  const brief = { goal: 'Implement the parser', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };
  store.createChildRun({ leadSession: 'live-1', brief, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:live-1');
  store.updateChildRun('C-1', { childSession: 'child-1', pid: 13 });
  const d = open(rt);
  d.terminal.send('j', 'x', 'y');
  await tick();
  assert.deepEqual(d.kills, [[13, 'SIGTERM']]);
  const run = store.getChildRun('C-1');
  assert.deepEqual([run.outcome, run.summary], ['stopped', 'stopped from the dashboard']);
  assert.equal(store.listEvents().at(-1).actor, 'user');
  d.terminal.send('q');
  await d.result;
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/dash-view.test.mjs tests/work/dash-app.test.mjs`
Expected: FAIL. Child rows show no run ID, `loadSessions` sets no `run`, and the run stays `running` after `x` then `y`.

- [ ] **Step 3: Implement the dashboard changes**

In `src/work/dash/model.ts`, replace `import type { Job, Session } from "../types.ts";` with:

```ts
import type { ChildRun, Job, Session } from "../types.ts";
```

Replace the `SessionEntry` type with:

```ts
export type SessionEntry = ProbedSession & { itemId: string | null; itemTitle: string | null; run?: ChildRun | null };
```

In `loadSessions`, replace `return { ...session, itemId: item?.id ?? null, itemTitle: item?.title ?? null };` with:

```ts
		const run = session.parentSession ? (store.childRunForSession(session.id) ?? null) : null;
		return { ...session, itemId: item?.id ?? null, itemTitle: item?.title ?? null, run };
```

In `src/work/dash/view.ts`, below the existing imports, add:

```ts
import { modelShortName } from "../children/format.ts";
import type { ChildRun } from "../types.ts";
```

Directly before `export function rowCells`, add:

```ts
function childRunNote(run: ChildRun): string {
	const outcome = run.outcome === "running" ? "" : `${run.outcome} `;
	const diff = run.budgetLines === null ? "read-only" : `${run.diffLines}/${run.budgetLines}`;
	return `${outcome}${modelShortName(run.model)} $${run.spendUsd.toFixed(2)} ${diff} "${run.brief.goal}"`;
}
```

In `rowCells`, replace the `window` and `note` lines with:

```ts
	const window = s.run ? s.run.id : child ? (s.name ?? `child ${s.id.slice(0, 8)}`) : (s.tmuxWindow ?? basename(s.cwd));
```

```ts
	const note = s.run ? childRunNote(s.run) : s.note ? `"${s.note}"` : child ? "" : (s.name ?? "");
```

In `src/work/dash/app.ts`, in `runConfirmed`, replace:

```ts
		if (key === "x" && session.pid) {
			try {
```

with:

```ts
		if (key === "x" && session.pid) {
			// The dashboard cannot reach the lead's RPC pipe: it records the stop, and the lead reports it.
			const run = store.childRunForSession(session.id);
			if (run?.outcome === "running") store.endChildRun(run.id, { outcome: "stopped", summary: "stopped from the dashboard" }, "user");
			try {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/dash-view.test.mjs tests/work/dash-app.test.mjs tests/work/pi-free.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors. `pi-free` still passes, because `format.ts` imports no Pi packages.

- [ ] **Step 5: Commit**

```bash
git add src/work/dash/model.ts src/work/dash/view.ts src/work/dash/app.ts tests/work/dash-view.test.mjs tests/work/dash-app.test.mjs
git commit -m "feat: show child runs in the dashboard and record dashboard stops"
```

---

### Task 15: Documentation and final gates

**Files:**
- Modify: `README.md` (the `work` section)

- [ ] **Step 1: Document child agents**

In `README.md`, directly after the paragraph that starts with `**Jobs.**`, add:

```markdown
**Child agents.** A top-level terminal session is a project lead: it gets the static `delegate`, `children`, `steer_child`, `stop_child`, and `merge_child` tools, and the user talks only to it. `delegate` takes a brief (a one-sentence `goal`; `kind` `implement` or `read-only`; `scope` globs and targeted `acceptance` commands for `implement`; optional `non_goals`, `context`, `budget`, `model` with `model_reason`, and `from: C-<n>` to continue an earlier run) and returns at once. An `implement` child runs `pi --mode rpc` in its own worktree at `<repo>/.pi/worktrees/child-C-<n>`, on `child/<lead-branch>/C-<n>`, from the lead's clean `HEAD`. A `read-only` child runs in the lead's directory without `edit` and `write`. When a child finishes, the lead gets one message with the outcome, the child's summary, the diff against its budget, acceptance results (the lead runs them in the child's worktree), spend, and the branch. Guards inside children block repository-wide test runs, pushes, PRs, history rewrites, branch switches, dependency additions, and edits outside the scope. They warn at 80% of the diff budget and of the spending cap, and at 100% they stop edits or the run. `merge_child` merges a done child whose acceptance passed with `--no-ff`, removes its worktree and branch, pushes the lead branch without force, and creates a draft PR with the account the config maps to the repository's org. It never marks a PR ready, merges a PR, or touches the default branch. Children exit when their lead dies, and the lead's next start reports interrupted runs. The dashboard shows each child's run, model, spend, and diff against budget, and `x` then `y` stops it.
```

In the configuration example, replace `  "usage": true` with:

```json
  "usage": true,
  "children": {
    "defaultModel": "anthropic/claude-sonnet-5",
    "diffBudget": { "defaultLines": 300, "defaultFiles": 8, "maxLines": 800, "prLines": 2000 },
    "spendCapUsd": 5,
    "commandTimeoutMinutes": 10,
    "warnPercent": 80,
    "repos": { "payments-api": { "ignore": ["**/generated/**"], "expensiveCommands": ["make e2e$"] } }
  }
```

Replace `GitHub is read-only.` with:

```markdown
GitHub is read-only, except that `merge_child` pushes the lead's branch and creates draft PRs.
```

- [ ] **Step 2: Run the final gates**

Run: `npm test && npm run -s typecheck && npm run -s check`
Expected: PASS. `check` prints `repository-boundary-ok`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document child agents and project leads"
```

- [ ] **Step 4: STOP for final review**

Report the commits of this part, any deviations, and the final test count. Do not push, tag, or bump the version. Suggest one manual check for the user, outside the test suite: delegate a `read-only` child in a scratch repository, then run one small `implement` child through `merge_child` against a scratch GitHub repository.
