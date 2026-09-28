# Work Sessions, Jobs, and Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Pi session, child agent, and registered background job visible from one tmux-popup dashboard that leads with decisions. Sessions register, link to items, and recover from crashes without commands.

**Architecture:** The `work` extension records each Pi session in new `work.db` tables, using lifecycle hooks and a static `session_status` tool. Pure modules handle liveness, linking, restore planning, the shared vim keymap, and dashboard layout. A standalone, Pi-free dashboard (`work dash`) renders with its own small ANSI renderer. Jobs are registered by agents (`job_register`) or users (`work job add`), and checked only when someone looks. Local usage rows record how the tool is used, and `work usage` summarizes them.

**Tech Stack:** TypeScript (erasable syntax only), Node ≥ 22.19 with `node:sqlite` and `node:child_process`, `typebox` and `@earendil-works/pi-ai` `StringEnum` for tool schemas (extension only), `@earendil-works/pi-tui` `parseKey` for `/triage` (extension only), `node --test` with `jiti`, and tmux ≥ 3.2 (`display-popup`).

**Spec:** `docs/superpowers/specs/2026-09-25-work-sessions-jobs-design.md` (including the "Child Agents (visibility only)" section from commit `e1d291a`).

**Style reference:** `docs/superpowers/plans/2026-09-25-work-tracker.md` (project 1).

## Global Constraints

- Guiding principle, verbatim from the spec: "Every mechanism here defaults to automatic behavior, and manual actions exist only as overrides." The only confirmations are the `y` keystroke guards on stopping (`x`) and deleting (`D`).
- No new runtime dependencies. Use `node:sqlite`, `node:child_process`, `node:fs`, and the global `fetch`.
- `package.json` `engines` stays `{"node": ">=22.19.0"}`. Do not bump `version`, tag, or push.
- TypeScript must be erasable, because Node runs `bin/work.ts` directly: no parameter properties, `enum`, or `namespace`. Import types with `import type`.
- The dashboard, and every module `bin/work.ts` imports, must not import Pi packages (`@earendil-works/*`) or `typebox`, because `bin/work.ts` runs from an install without dev or peer dependencies. `tests/work/pi-free.test.mjs` (Task 10) enforces this over the whole import graph.
- Tests are `.mjs` files under `tests/work/` (plus `tests/task/` and `tests/worktree/` where existing code changes). They load TypeScript through `jiti` via `tests/work/helpers.mjs`. Unit tests make no network calls and never run `pi`.
- Real tmux is used only in `tests/work/tmux-integration.test.mjs`, only on an isolated server (`tmux -L work-test -f /dev/null`), with `TMUX` and `TMUX_PANE` removed from the child environment. The test kills that server when it finishes. Nothing ever targets the user's running tmux server.
- `npm run check` must pass. Never write the employer's name or shorthand, or real home-directory paths, into any file. Use placeholders such as `/src/api`, `/s/<id>.jsonl`, `example-org`, and `W-7`.
- External text is data. Notes, item titles, session names, transcript text, job names, commands, and check output are passed through `sanitize` or `oneLine` (Task 8) before rendering, so control characters and escape sequences never reach the terminal.
- Tool definitions are static: `session_status` and `job_register` are registered in every session, with fixed descriptions and schemas.
- Every domain mutation writes exactly one `event` in the same transaction, and a no-op writes none. Session rows, check results, and usage rows are operational and write no events. Session links and job registration, stop, and delete are domain mutations.
- Release gates: `npm test`, `npm run -s typecheck`, `npm run -s check`.
- Commit after every task, using Conventional Commit messages.
- Execution for this plan: superpowers:executing-plans, inline, one task at a time, with no subagents. Stop for review after Task 12 (end of part 1) and after Task 19. Out of scope: pushing, tagging, bumping the version, and dotfiles changes.
- During execution, record every change to this plan's code in `docs/superpowers/plans/2026-09-25-work-sessions-jobs-deviations.md`, with the task, the change, and why.

## Spec Decisions Made in This Plan

These resolve gaps or conflicts in the spec. Each is small and reversible. Please accept or reject them during review.

1. **A "turn" is a Pi agent run.** Pi's `turn_end` fires after every model request inside a run, so using it would flip a working session to `needs-me` between tool calls. This plan therefore sets `working` on `agent_start` and applies the turn-end fallback on `agent_end`. `last_turn_at`, window refresh, and linking also run on `agent_end`.
2. **Automatic fallback note.** When the agent does not call `session_status`, the fallback `needs-me` note is the last non-empty line of the final assistant text, clipped to 200 characters. Decisions then shows the question without extra effort from the agent.
3. **Clean shutdown versus reboot.** Pi emits `session_shutdown` even on `SIGHUP` and `SIGTERM`, so a graceful reboot would mark every session closed, and restore would never run. The rule used here: a shutdown is clean unless Pi received `SIGHUP` or `SIGTERM` *and* the session's pane still exists, or the tmux server is unreachable. Closing a pane (`kill-pane`) therefore stays clean. Reboots and `tmux kill-server` leave sessions crashed, so they are restored.
4. **Which sessions register.** `headless` means `ctx.mode` is not `tui`. Registration depends on the mode:
   - **TUI** sessions always register as top-level interactive sessions (`headless: false`, with no parent even if `PI_WORK_PARENT_SESSION` is inherited). Inside tmux they record their pane and window. Outside tmux they have no pane or window, and `Enter` opens their transcript (decision 11).
   - **`rpc`** sessions always register, as headless.
   - **`print` and `json`** runs register only when `PI_WORK_PARENT_SESSION` is set, as headless children. Other one-shot runs, such as a plain `pi -p`, are not recorded at all.

   Headless sessions never record a pane or window, even when `TMUX_PANE` is inherited. Automatic restore still reopens only sessions that had a tmux pane, so a crashed TUI session from outside tmux is reopened only by `Enter` in the dashboard.
5. **Liveness gap.** A process that is alive but whose pane is gone is not live. The spec's table does not cover this case, so it shows as crashed, but restore and reopen never start a second Pi on a session whose PID is still alive.
6. **Linking details.** A PR head branch counts only when the PR's repository matches the session's repository. Jira keys are matched case-insensitively in branch names. An ambiguous branch rule stops linking for that attempt instead of falling through to the worktree rule. The GitHub connector adds `head` (the PR head branch) to detailed PR link state. Automatic links use the actor `session:<id>`, and link state records `{ "via": "env" | "branch" | "worktree" | "manual" }`.
7. **Filter semantics.** `/` hides non-matching rows as you type, and `n`/`N` cycle through the remaining rows with wrap-around. Filtering matches item titles even at 80 columns.
8. **Auto-refresh.** The open dashboard re-reads the registry every 5 seconds. It never runs checks on that timer.
9. **Popup command.** `/dash` runs `display-popup` with an absolute `node` and `bin/work.ts` path, because shell aliases do not reach popups. The dotfiles binding (out of scope) needs a `work` executable on `PATH`.
10. **"Inline" outside tmux** means the dashboard runs in the current terminal instead of a popup, still using the alternate screen. Jumps exit and print a `tmux attach-session …` command.
11. **Children.** Section counts include only top-level rows. A child whose parent row is not shown (deleted, or older than 7 days) appears as a top-level row under Other sessions. `x` stops only child rows in part 1, plus jobs in part 2. A live session with no pane (headless top-level, or TUI outside tmux) opens the transcript view on `Enter`, since there is no pane to jump to.
12. **Backups** include the `job` table, but not `session` or `usage`, which are operational.
13. **Re-registering a job** keeps omitted optional fields, and explicit `null` (CLI: not applicable) clears them.
14. **Usage rows for navigation.** Discrete dashboard actions each write a row. Navigation keys are counted into one `close` row per dashboard session (`moves`, `seconds`), so `j` spam does not flood the table.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/work/migrations.ts` | Adds migration 2: `session`, `job`, and `usage` tables. |
| `src/work/types.ts` | Session, liveness, job, and usage types. |
| `src/work/store.ts` | Session registry, session links, jobs, and usage methods. |
| `src/work/tmux.ts` | Quiet and isolated tmux runners, pane listing, window names, jumping, popup arguments. |
| `src/work/liveness.ts` | PID checks with PID-reuse guard, and live/closed/crashed classification. |
| `src/work/linking.ts` | Automatic session-to-item inference and linking. |
| `src/work/transcript.ts` | Message text extraction and the read-only session-file transcript tail. |
| `src/work/session-tracker.ts` | Hook logic: registration, status transitions, declarations, shutdown classification, signals. |
| `src/work/restore.ts` | Restore selection, placement planning, execution, boot marker, reopen, and report formatting. |
| `src/work/keymap.ts` | Shared vim keymap: key decoding, `gg`, filter mode, `y` confirmations, and list moves. |
| `src/work/triage-actions.ts` | Pi-free triage actions (moved out of `triage-ui.ts`), shared by `/triage` and the dashboard. |
| `src/work/triage-ui.ts` | Pi `/triage` view, now driven by the keymap. |
| `src/worktree/fuzzy-filter.ts` | Pi-free fuzzy matching (moved out of `fuzzy-select.ts`). |
| `src/work/dash/text.ts` | Styles, width, truncation, sanitizing, and age formatting. |
| `src/work/dash/terminal.ts` | Terminal abstraction (raw mode and alternate screen) and frame output. |
| `src/work/dash/widgets.ts` | Modal prompt, select, confirm, message, and fuzzy picker. |
| `src/work/dash/model.ts` | Loads sessions (and later jobs) into dashboard sections, with children nested under parents. |
| `src/work/dash/view.ts` | Renders a frame: columns, filter, selection, scrolling. |
| `src/work/dash/app.ts` | Dashboard controller: keys, actions, triage view, modals, refresh, and auto-restore. |
| `src/work/jobs.ts` | Shell runner, health checks, concurrency, stopping, agent registration, and job details (part 2). |
| `src/work/usage.ts` | Usage recording, sanitizing, retention, follow-through, and the Markdown report (part 2). |
| `src/work/cli.ts` | Adds `restore`, `dash`, `job`, and `usage`, and records CLI usage. |
| `extensions/work.ts` | Session hooks, `session_status`, `/dash`, `job_register`, and Pi usage. |
| `extensions/task.ts`, `src/worktree/index.ts` | `/task` sets `PI_WORK_ITEM` when its request names an item. |
| `tests/work/fixtures/keymap-table.mjs` | Key table shared by the keymap and `/triage` tests. |
| `tests/work/fixtures/fake-pi.sh` | Stand-in for `pi` in the real-tmux test. |

---

# Part 1: Sessions, Restore, and Dashboard

### Task 1: Schema version 2 and the session store

**Files:**
- Modify: `src/work/migrations.ts`: append migration 2
- Modify: `src/work/types.ts`: the `session` link kind, the `session:` actor, and session types
- Modify: `src/work/store.ts`: session methods and `linkSession`
- Modify: `tests/work/store.test.mjs:17` and `tests/work/backup.test.mjs:26`: expect schema 2
- Test: `tests/work/session-store.test.mjs`

**Interfaces:**
- Consumes: `WorkStore` internals (`run`, `one`, `all`, `event`, `transaction`, `addLink`, `findLinkByKey`).
- Produces:
  - Types: `SessionStatus = "working" | "needs-me" | "waiting-external" | "done"`, `DeclaredStatus`, `StatusSource = "agent" | "auto"`, `Liveness = "live" | "closed" | "crashed"`, `LinkVia = "env" | "branch" | "worktree" | "manual"`, `Session`, `SessionStart`, `DECLARED_STATUSES`, and `NOTE_MAX = 200`. The `job` and `usage` tables are created by this migration, and their types and methods arrive in part 2.
  - `LinkKind` gains `"session"`, and `Actor` gains `` `session:${string}` ``
  - `sessionLinkKey(sessionId: string): string`, which returns `session:<id>`
  - `SessionPatch = { lastTurnAt?: string; tmuxWindow?: string | null; name?: string | null; endedAt?: string | null; restoredFrom?: number | null }`
  - `store.startSession(input: SessionStart): Session`
  - `store.getSession(id: string): Session | undefined`, `store.listSessions(): Session[]` (ordered by `started_at`, then `id`)
  - `store.setSessionStatus(id, status: SessionStatus, note: string, source: StatusSource): Session`
  - `store.updateSession(id, patch: SessionPatch): Session`, `store.deleteSession(id): boolean`
  - `store.sessionLink(sessionId): Link | undefined`
  - `store.linkSession(sessionId, itemId, via: LinkVia, actor: Actor): Link`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/session-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { WorkStore } = await load('src/work/store.ts');
const { MIGRATIONS } = await load('src/work/migrations.ts');

const start = (overrides = {}) => ({
  id: 's1', file: '/s/s1.jsonl', cwd: '/src/api', name: null, pid: 101, tmuxPane: '%3', tmuxWindow: 'api', parentSession: null, headless: false, ...overrides,
});

test('a new session starts as needs-me with an automatic note and writes no events', async () => {
  const store = await memoryStore();
  const session = store.startSession(start());
  assert.equal(session.status, 'needs-me');
  assert.equal(session.statusSource, 'auto');
  assert.equal(session.note, 'new session');
  assert.equal(session.statusAt, '2026-09-25T09:00:00.000Z');
  assert.equal(session.endedAt, null);
  assert.equal(session.parentSession, null);
  assert.equal(session.headless, false);
  assert.deepEqual(store.listEvents(), []);
});

test('restarting a session refreshes process fields but keeps its status and note', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.startSession(start());
  store.setSessionStatus('s1', 'waiting-external', 'CI run', 'agent');
  store.updateSession('s1', { endedAt: store.now() });
  now.advance(60_000);
  const again = store.startSession(start({ pid: 202, tmuxPane: null, tmuxWindow: null, parentSession: 'p1', headless: true }));
  assert.equal(again.pid, 202);
  assert.equal(again.tmuxPane, null);
  assert.equal(again.parentSession, 'p1');
  assert.equal(again.headless, true);
  assert.equal(again.endedAt, null);
  assert.equal(again.status, 'waiting-external');
  assert.equal(again.note, 'CI run');
  assert.equal(again.startedAt, '2026-09-25T09:01:00.000Z');
});

test('status_at changes only with the status, and notes are clipped to 200 characters', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.startSession(start());
  now.advance(1000);
  assert.equal(store.setSessionStatus('s1', 'working', '', 'auto').statusAt, '2026-09-25T09:00:01.000Z');
  now.advance(1000);
  const again = store.setSessionStatus('s1', 'working', 'still', 'auto');
  assert.equal(again.statusAt, '2026-09-25T09:00:01.000Z');
  assert.equal(again.note, 'still');
  const long = store.setSessionStatus('s1', 'needs-me', 'x'.repeat(300), 'agent');
  assert.equal(long.note.length, 200);
  assert.equal(long.statusSource, 'agent');
  assert.throws(() => store.setSessionStatus('nope', 'done', '', 'auto'), /Unknown session/);
  assert.deepEqual(store.listEvents(), []);
});

test('updateSession patches operational fields and deleteSession removes the row', async () => {
  const store = await memoryStore();
  store.startSession(start());
  store.startSession(start({ id: 's2' }));
  const updated = store.updateSession('s1', { lastTurnAt: '2026-09-25T10:00:00.000Z', tmuxWindow: 'renamed', name: 'Fix tests', restoredFrom: 101 });
  assert.equal(updated.lastTurnAt, '2026-09-25T10:00:00.000Z');
  assert.equal(updated.tmuxWindow, 'renamed');
  assert.equal(updated.name, 'Fix tests');
  assert.equal(updated.restoredFrom, 101);
  assert.deepEqual(store.listSessions().map((session) => session.id), ['s1', 's2']);
  assert.equal(store.deleteSession('s1'), true);
  assert.equal(store.deleteSession('s1'), false);
  assert.deepEqual(store.listSessions().map((session) => session.id), ['s2']);
  assert.throws(() => store.updateSession('nope', { name: 'x' }), /Unknown session/);
});

test('linkSession adds a session link, updates it with one event, and ignores repeats', async () => {
  const store = await memoryStore();
  const a = store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const b = store.addItem({ project: 'misc', title: 'B', origin: 'manual' }, 'user');
  store.startSession(start());
  const before = store.listEvents().length;
  const link = store.linkSession('s1', a.id, 'branch', 'session:s1');
  assert.equal(link.kind, 'session');
  assert.equal(link.key, 'session:s1');
  assert.deepEqual(link.state, { via: 'branch' });
  assert.equal(store.sessionLink('s1').itemId, 'W-1');
  assert.equal(store.listEvents().at(-1).actor, 'session:s1');
  store.linkSession('s1', a.id, 'branch', 'session:s1');
  assert.equal(store.listEvents().length, before + 1);
  const moved = store.linkSession('s1', b.id, 'manual', 'user');
  assert.equal(moved.itemId, 'W-2');
  assert.deepEqual(moved.state, { via: 'manual' });
  assert.equal(store.listEvents().at(-1).action, 'update');
  assert.equal(store.listEvents().length, before + 2);
  assert.throws(() => store.linkSession('s1', 'W-9', 'manual', 'user'), /Unknown item/);
});

test('a version 1 database migrates to version 2 with the new tables', () => {
  const path = join(tempDir(), 'work.db');
  const raw = new DatabaseSync(path);
  raw.exec(MIGRATIONS[0]);
  raw.exec('PRAGMA user_version = 1');
  raw.close();
  const store = WorkStore.open(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(store.listSessions(), []);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'job', 'usage') ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ['job', 'session', 'usage']);
  store.close();
});
```

In `tests/work/store.test.mjs`, change line 17 to:

```js
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
```

In `tests/work/backup.test.mjs`, change line 26 to:

```js
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]), { format: 'work-backup', schema: 2 });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/session-store.test.mjs tests/work/store.test.mjs tests/work/backup.test.mjs`
Expected: FAIL. `store.startSession is not a function`, and `user_version` / `schema` is `1`, not `2`.

- [ ] **Step 3: Add the migration**

In `src/work/migrations.ts`, add a second element to `MIGRATIONS`, directly after the first template string and its comma:

```ts
	`
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	file TEXT,
	cwd TEXT NOT NULL,
	name TEXT,
	pid INTEGER,
	tmux_pane TEXT,
	tmux_window TEXT,
	started_at TEXT NOT NULL,
	last_turn_at TEXT,
	ended_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('working', 'needs-me', 'waiting-external', 'done')),
	note TEXT NOT NULL DEFAULT '',
	status_source TEXT NOT NULL CHECK (status_source IN ('agent', 'auto')),
	status_at TEXT NOT NULL,
	restored_from INTEGER,
	parent_session TEXT,
	headless INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX session_parent ON session(parent_session);
CREATE TABLE job (
	num INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('cron', 'process')),
	owner_session TEXT,
	item_num INTEGER REFERENCES item(num),
	schedule TEXT,
	pid INTEGER,
	cwd TEXT NOT NULL,
	check_command TEXT,
	stop_command TEXT,
	log_path TEXT,
	last_check_at TEXT,
	last_check_status TEXT CHECK (last_check_status IS NULL OR last_check_status IN ('healthy', 'unhealthy', 'unknown')),
	last_check_output TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	stopped_at TEXT
);
CREATE UNIQUE INDEX job_active_name ON job(name) WHERE stopped_at IS NULL;
CREATE TABLE usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	surface TEXT NOT NULL CHECK (surface IN ('dash', 'cli', 'pi', 'triage', 'planner')),
	action TEXT NOT NULL,
	context TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX usage_at ON usage(at);
`,
```

`SCHEMA_VERSION = MIGRATIONS.length` becomes 2 automatically.

- [ ] **Step 4: Add the types**

In `src/work/types.ts`, replace the `LinkKind` and `Actor` lines with:

```ts
export type LinkKind = "jira" | "github-pr" | "github-issue" | "chat" | "note" | "url" | "session";
```

```ts
export type Actor = "user" | "planner" | `agent:${string}` | `sync:${string}` | `session:${string}`;
```

Append to the end of `src/work/types.ts`:

```ts
export type SessionStatus = "working" | "needs-me" | "waiting-external" | "done";
export type DeclaredStatus = "needs-me" | "waiting-external" | "done";
export type StatusSource = "agent" | "auto";
export type Liveness = "live" | "closed" | "crashed";
export type LinkVia = "env" | "branch" | "worktree" | "manual";

export const DECLARED_STATUSES: readonly DeclaredStatus[] = ["needs-me", "waiting-external", "done"];
export const NOTE_MAX = 200;

export type Session = {
	id: string;
	file: string | null;
	cwd: string;
	name: string | null;
	pid: number | null;
	tmuxPane: string | null;
	tmuxWindow: string | null;
	startedAt: string;
	lastTurnAt: string | null;
	endedAt: string | null;
	status: SessionStatus;
	note: string;
	statusSource: StatusSource;
	statusAt: string;
	restoredFrom: number | null;
	parentSession: string | null;
	headless: boolean;
};

export type SessionStart = {
	id: string;
	file: string | null;
	cwd: string;
	name: string | null;
	pid: number;
	tmuxPane: string | null;
	tmuxWindow: string | null;
	parentSession: string | null;
	headless: boolean;
};
```

- [ ] **Step 5: Implement the store methods**

In `src/work/store.ts`, add these names to the `import type { … } from "./types.ts"` list, keeping it alphabetical: `LinkVia`, `Session`, `SessionStart`, `SessionStatus`, `StatusSource`. Below that import, add:

```ts
import { NOTE_MAX } from "./types.ts";
```

After the `CandidatePatch` type, add:

```ts
export type SessionPatch = { lastTurnAt?: string; tmuxWindow?: string | null; name?: string | null; endedAt?: string | null; restoredFrom?: number | null };

const SESSION_COLUMNS: Record<keyof SessionPatch, string> = {
	lastTurnAt: "last_turn_at",
	tmuxWindow: "tmux_window",
	name: "name",
	endedAt: "ended_at",
	restoredFrom: "restored_from",
};
```

After `itemNum`, add:

```ts
export function sessionLinkKey(sessionId: string): string {
	return `session:${sessionId}`;
}
```

After the `json` helper, add:

```ts
function int(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}
```

After `toRun`, add:

```ts
function toSession(r: Row): Session {
	return {
		id: String(r.id),
		file: text(r.file),
		cwd: String(r.cwd),
		name: text(r.name),
		pid: int(r.pid),
		tmuxPane: text(r.tmux_pane),
		tmuxWindow: text(r.tmux_window),
		startedAt: String(r.started_at),
		lastTurnAt: text(r.last_turn_at),
		endedAt: text(r.ended_at),
		status: r.status as SessionStatus,
		note: String(r.note),
		statusSource: r.status_source as StatusSource,
		statusAt: String(r.status_at),
		restoredFrom: int(r.restored_from),
		parentSession: text(r.parent_session),
		headless: Number(r.headless) === 1,
	};
}
```

Inside the class, directly before `// Connector runs and meta (operational: no events)`, add:

```ts
	// Sessions (operational: no events). Session links are domain links and write events.

	startSession(input: SessionStart): Session {
		return this.transaction(() => {
			const now = this.now();
			if (this.getSession(input.id)) {
				this.run(
					"UPDATE session SET file = ?, cwd = ?, name = ?, pid = ?, tmux_pane = ?, tmux_window = ?, parent_session = ?, headless = ?, started_at = ?, ended_at = NULL WHERE id = ?",
					input.file, input.cwd, input.name, input.pid, input.tmuxPane, input.tmuxWindow, input.parentSession, input.headless ? 1 : 0, now, input.id,
				);
			} else {
				this.run(
					`INSERT INTO session (id, file, cwd, name, pid, tmux_pane, tmux_window, parent_session, headless, started_at, status, note, status_source, status_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs-me', 'new session', 'auto', ?)`,
					input.id, input.file, input.cwd, input.name, input.pid, input.tmuxPane, input.tmuxWindow, input.parentSession, input.headless ? 1 : 0, now, now,
				);
			}
			return this.getSession(input.id) as Session;
		});
	}

	getSession(id: string): Session | undefined {
		const row = this.one("SELECT * FROM session WHERE id = ?", id);
		return row ? toSession(row) : undefined;
	}

	listSessions(): Session[] {
		return this.all("SELECT * FROM session ORDER BY started_at, id").map(toSession);
	}

	setSessionStatus(id: string, status: SessionStatus, note: string, source: StatusSource): Session {
		const before = this.getSession(id);
		if (!before) throw new WorkStoreError(`Unknown session: ${id}`);
		const statusAt = before.status === status ? before.statusAt : this.now();
		this.run("UPDATE session SET status = ?, note = ?, status_source = ?, status_at = ? WHERE id = ?", status, note.trim().slice(0, NOTE_MAX), source, statusAt, id);
		return this.getSession(id) as Session;
	}

	updateSession(id: string, patch: SessionPatch): Session {
		if (!this.getSession(id)) throw new WorkStoreError(`Unknown session: ${id}`);
		const keys = (Object.keys(patch) as (keyof SessionPatch)[]).filter((key) => patch[key] !== undefined);
		if (keys.length > 0) {
			this.run(`UPDATE session SET ${keys.map((key) => `${SESSION_COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`, ...keys.map((key) => patch[key] as Param), id);
		}
		return this.getSession(id) as Session;
	}

	deleteSession(id: string): boolean {
		return this.run("DELETE FROM session WHERE id = ?", id).changes > 0;
	}

	sessionLink(sessionId: string): Link | undefined {
		return this.findLinkByKey(sessionLinkKey(sessionId));
	}

	linkSession(sessionId: string, targetItemId: string, via: LinkVia, actor: Actor): Link {
		return this.transaction(() => {
			const target = this.getItem(targetItemId);
			if (!target) throw new WorkStoreError(`Unknown item: ${targetItemId}`);
			const key = sessionLinkKey(sessionId);
			const existing = this.findLinkByKey(key);
			if (!existing) return this.addLink(target.id, { kind: "session", key, state: { via } }, actor);
			if (existing.itemId === target.id && existing.state?.via === via) return existing;
			this.run("UPDATE link SET item_num = ?, state = ?, state_at = ? WHERE id = ?", itemNum(target.id), JSON.stringify({ via }), this.now(), existing.id);
			const after = this.getLink(existing.id) as Link;
			this.event(actor, `link:${existing.id}`, "update", { before: existing, after });
			return after;
		});
	}

```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/work/session-store.test.mjs tests/work/store.test.mjs tests/work/backup.test.mjs`
Expected: PASS.

Run: `npm test && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/work/migrations.ts src/work/types.ts src/work/store.ts tests/work/session-store.test.mjs tests/work/store.test.mjs tests/work/backup.test.mjs
git commit -m "feat: add the session registry schema and store"
```

---

### Task 2: tmux helpers and liveness

**Files:**
- Create: `src/work/tmux.ts`, `src/work/liveness.ts`
- Test: `tests/work/tmux.test.mjs`, `tests/work/liveness.test.mjs`

**Interfaces:**
- Consumes: `TmuxRunner` and `shellQuote` from `src/work/planner.ts` (existing; Pi-free). `Session` and `Liveness` (Task 1).
- Produces:
  - `TmuxPane = { paneId; windowId; windowName; sessionName; path; command }` (all strings)
  - `tmuxRunner(socket?: string): TmuxRunner`. It is quiet (stderr captured) with a 5-second timeout. With a socket, it adds `-L <socket>` and removes `TMUX` and `TMUX_PANE` from the child environment.
  - `parsePanes(output: string): TmuxPane[]`, `listPanes(tmux): TmuxPane[] | undefined` (undefined when tmux fails)
  - `isShell(command: string): boolean`, `windowNameOf(tmux, pane): string | null`
  - `JumpResult = { kind: "jumped" } | { kind: "print"; command: string }`, and `jumpToPane(tmux, pane, insideTmux): JumpResult`
  - `popupArgs(command: string): string[]`
  - `PidReaders = { kill(pid): void; environ(pid): string | undefined }`, `systemPidReaders`
  - `pidAlive(pid: number | null, pane: string | null, readers?): boolean`
  - `livenessOf(session, alive, panes): Liveness`
  - `ProbedSession = Session & { liveness: Liveness; alive: boolean }`, `probeSessions(sessions, panes, readers?): ProbedSession[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/tmux.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const tmux = await load('src/work/tmux.ts');

function fake(responses = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const response = responses[args[0]];
    if (response instanceof Error) throw response;
    return response ?? '';
  };
  return { run, calls };
}

test('parsePanes reads the tab-separated pane listing', () => {
  assert.deepEqual(tmux.parsePanes('%1\t@1\tapi\tmain\t/src/api\tzsh\n\n%2\t@2\tweb\tmain\t/src/web\tnode\n'), [
    { paneId: '%1', windowId: '@1', windowName: 'api', sessionName: 'main', path: '/src/api', command: 'zsh' },
    { paneId: '%2', windowId: '@2', windowName: 'web', sessionName: 'main', path: '/src/web', command: 'node' },
  ]);
});

test('listPanes and windowNameOf return nothing when tmux fails', () => {
  const broken = fake({ 'list-panes': new Error('no server running'), 'display-message': new Error('no server running') });
  assert.equal(tmux.listPanes(broken.run), undefined);
  assert.equal(tmux.windowNameOf(broken.run, '%1'), null);
  const working = fake({ 'display-message': 'editor\n' });
  assert.equal(tmux.windowNameOf(working.run, '%1'), 'editor');
  assert.deepEqual(working.calls[0], ['display-message', '-p', '-t', '%1', '#{window_name}']);
});

test('isShell accepts common and login shells only', () => {
  for (const shell of ['zsh', '-zsh', 'bash', 'fish', 'sh']) assert.equal(tmux.isShell(shell), true, shell);
  for (const other of ['node', 'vim', 'pi', '']) assert.equal(tmux.isShell(other), false, other);
});

test('jumpToPane selects the window and pane and tolerates a missing client', () => {
  const noClient = fake({ 'switch-client': new Error('no current client') });
  assert.deepEqual(tmux.jumpToPane(noClient.run, '%4', true), { kind: 'jumped' });
  assert.deepEqual(noClient.calls, [['switch-client', '-t', '%4'], ['select-window', '-t', '%4'], ['select-pane', '-t', '%4']]);
});

test('jumpToPane prints an attach command outside tmux', () => {
  const none = fake();
  assert.deepEqual(tmux.jumpToPane(none.run, '%4', false), { kind: 'print', command: "tmux attach-session -t '%4' \\; select-window -t '%4' \\; select-pane -t '%4'" });
  assert.deepEqual(none.calls, []);
});

test('popupArgs opens a 90% popup that closes with the command', () => {
  assert.deepEqual(tmux.popupArgs("'node' 'work.ts' dash"), ['display-popup', '-E', '-w', '90%', '-h', '90%', "'node' 'work.ts' dash"]);
});
```

Create `tests/work/liveness.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { pidAlive, livenessOf, probeSessions } = await load('src/work/liveness.ts');

const readers = ({ alive = [], environ = {} } = {}) => ({
  kill: (pid) => {
    if (!alive.includes(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  },
  environ: (pid) => environ[pid],
});
const session = (overrides = {}) => ({
  id: 's1', file: '/s/s1.jsonl', cwd: '/src/api', name: null, pid: 10, tmuxPane: '%1', tmuxWindow: 'api',
  startedAt: '2026-09-25T08:00:00.000Z', lastTurnAt: null, endedAt: null, status: 'working', note: '', statusSource: 'auto',
  statusAt: '2026-09-25T08:00:00.000Z', restoredFrom: null, parentSession: null, headless: false, ...overrides,
});
const pane = (paneId) => ({ paneId, windowId: '@1', windowName: 'api', sessionName: 'main', path: '/src/api', command: 'node' });

test('a running process whose environment names its pane is live', () => {
  const r = readers({ alive: [10], environ: { 10: 'HOME=/h\0TMUX_PANE=%1\0' } });
  assert.equal(pidAlive(10, '%1', r), true);
  const [probed] = probeSessions([session()], [pane('%1')], r);
  assert.equal(probed.alive, true);
  assert.equal(probed.liveness, 'live');
});

test('a reused PID whose environment names another pane is not alive', () => {
  const r = readers({ alive: [10], environ: { 10: 'TMUX_PANE=%7\0' } });
  assert.equal(pidAlive(10, '%1', r), false);
  assert.equal(probeSessions([session()], [pane('%1')], r)[0].liveness, 'crashed');
});

test('without /proc, the kill check alone decides', () => {
  assert.equal(pidAlive(10, '%1', readers({ alive: [10] })), true);
});

test('a clean shutdown is closed and a dead process without one is crashed', () => {
  const r = readers();
  assert.equal(livenessOf(session({ endedAt: '2026-09-25T08:30:00.000Z' }), false, []), 'closed');
  assert.equal(livenessOf(session(), false, []), 'crashed');
  assert.equal(probeSessions([session()], [], r)[0].liveness, 'crashed');
});

test('a live process whose pane is gone is not live, and an unknown pane listing skips the pane check', () => {
  assert.equal(livenessOf(session(), true, [pane('%2')]), 'crashed');
  assert.equal(livenessOf(session(), true, undefined), 'live');
});

test('headless sessions without a pane need only a live PID', () => {
  const r = readers({ alive: [10], environ: { 10: 'TMUX_PANE=%9\0' } });
  const [probed] = probeSessions([session({ tmuxPane: null, tmuxWindow: null, headless: true })], [], r);
  assert.equal(probed.liveness, 'live');
});

test('missing and invalid PIDs are not alive', () => {
  assert.equal(pidAlive(null, null, readers({ alive: [0] })), false);
  assert.equal(pidAlive(0, null, readers({ alive: [0] })), false);
  assert.equal(pidAlive(-1, null, readers({ alive: [-1] })), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/tmux.test.mjs tests/work/liveness.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/tmux.ts` and `src/work/liveness.ts`.

- [ ] **Step 3: Implement the tmux helpers**

Create `src/work/tmux.ts`:

```ts
import { execFileSync } from "node:child_process";
import type { TmuxRunner } from "./planner.ts";
import { shellQuote } from "./planner.ts";

export type TmuxPane = { paneId: string; windowId: string; windowName: string; sessionName: string; path: string; command: string };
export type JumpResult = { kind: "jumped" } | { kind: "print"; command: string };

export const PANE_FORMAT = ["#{pane_id}", "#{window_id}", "#{window_name}", "#{session_name}", "#{pane_current_path}", "#{pane_current_command}"].join("\t");
const SHELLS: readonly string[] = ["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu"];

// Quiet runner: tmux errors are captured instead of printed over the dashboard.
// With a socket name, it targets an isolated server and hides the caller's own tmux client.
export function tmuxRunner(socket?: string): TmuxRunner {
	const env = { ...process.env };
	if (socket) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const prefix = socket ? ["-L", socket] : [];
	return (args) => execFileSync("tmux", [...prefix, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
}

export function parsePanes(output: string): TmuxPane[] {
	return output.split("\n").filter((line) => line.trim()).map((line) => {
		const [paneId = "", windowId = "", windowName = "", sessionName = "", path = "", command = ""] = line.split("\t");
		return { paneId, windowId, windowName, sessionName, path, command };
	});
}

export function listPanes(tmux: TmuxRunner): TmuxPane[] | undefined {
	try {
		return parsePanes(tmux(["list-panes", "-a", "-F", PANE_FORMAT]));
	} catch {
		return undefined;
	}
}

export function isShell(command: string): boolean {
	return SHELLS.includes(command.replace(/^-/, ""));
}

export function windowNameOf(tmux: TmuxRunner, pane: string): string | null {
	try {
		return tmux(["display-message", "-p", "-t", pane, "#{window_name}"]).trim() || null;
	} catch {
		return null;
	}
}

export function jumpToPane(tmux: TmuxRunner, pane: string, insideTmux: boolean): JumpResult {
	const target = shellQuote(pane);
	if (!insideTmux) return { kind: "print", command: `tmux attach-session -t ${target} \\; select-window -t ${target} \\; select-pane -t ${target}` };
	try {
		tmux(["switch-client", "-t", pane]);
	} catch {
		// No attached client (for example an isolated test server); selecting still moves the session's focus.
	}
	tmux(["select-window", "-t", pane]);
	tmux(["select-pane", "-t", pane]);
	return { kind: "jumped" };
}

export function popupArgs(command: string): string[] {
	return ["display-popup", "-E", "-w", "90%", "-h", "90%", command];
}
```

- [ ] **Step 4: Implement liveness**

Create `src/work/liveness.ts`:

```ts
import { readFileSync } from "node:fs";
import type { TmuxPane } from "./tmux.ts";
import type { Liveness, Session } from "./types.ts";

export type PidReaders = { kill: (pid: number) => void; environ: (pid: number) => string | undefined };
export type ProbedSession = Session & { liveness: Liveness; alive: boolean };

export const systemPidReaders: PidReaders = {
	kill: (pid) => {
		process.kill(pid, 0);
	},
	environ: (pid) => {
		try {
			return readFileSync(`/proc/${pid}/environ`, "latin1");
		} catch {
			return undefined;
		}
	},
};

// A PID counts as the session's process only if it exists and, when the pane is known and /proc is
// readable, its environment names that pane. This guards against PID reuse after a reboot.
export function pidAlive(pid: number | null, pane: string | null, readers: PidReaders = systemPidReaders): boolean {
	if (!pid || pid <= 0) return false;
	try {
		readers.kill(pid);
	} catch {
		return false;
	}
	if (!pane) return true;
	const environ = readers.environ(pid);
	if (environ === undefined) return true;
	return environ.split("\0").includes(`TMUX_PANE=${pane}`);
}

export function livenessOf(session: Session, alive: boolean, panes: readonly TmuxPane[] | undefined): Liveness {
	const paneOk = !session.tmuxPane || panes === undefined || panes.some((pane) => pane.paneId === session.tmuxPane);
	if (alive && paneOk) return "live";
	return session.endedAt ? "closed" : "crashed";
}

export function probeSessions(sessions: readonly Session[], panes: readonly TmuxPane[] | undefined, readers: PidReaders = systemPidReaders): ProbedSession[] {
	return sessions.map((session) => {
		const alive = pidAlive(session.pid, session.tmuxPane, readers);
		return { ...session, alive, liveness: livenessOf(session, alive, panes) };
	});
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/tmux.test.mjs tests/work/liveness.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/tmux.ts src/work/liveness.ts tests/work/tmux.test.mjs tests/work/liveness.test.mjs
git commit -m "feat: add tmux helpers and session liveness"
```

---

### Task 3: Automatic session linking

**Files:**
- Create: `src/work/linking.ts`
- Modify: `src/work/rules.ts:10`: export `defaultGit`
- Modify: `src/work/connectors/github.ts` (`detailedObservation`): add `head` to the PR link state
- Modify: `tests/work/github.test.mjs:47`: expect `head`
- Test: `tests/work/linking.test.mjs`

**Interfaces:**
- Consumes: `store.sessionLink`, `store.linkSession`, `store.listSessions`, and `store.getSession` (Task 1). `GitRunner`, `jiraKeysIn`, `repoFromCwd`, and `repoMatches` from `rules.ts`. `parsePrKey` from `connectors/github.ts`.
- Produces:
  - `WORK_ITEM_ENV = "PI_WORK_ITEM"`
  - `LinkDeps = { env: NodeJS.ProcessEnv; git: GitRunner }`
  - `inferSessionLink(store, session: Session, deps: LinkDeps): { itemId: string; via: LinkVia } | undefined`
  - `autoLinkSession(store, sessionId: string, deps: LinkDeps): Link | undefined`, which returns the new link, or `undefined` when the session is already linked or nothing matched
  - `defaultGit: GitRunner` (now exported from `rules.ts`)
  - Detailed GitHub PR link state gains `head: string | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/linking.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { inferSessionLink, autoLinkSession } = await load('src/work/linking.ts');

// A fake git: answers only the exact "cwd: args" pairs given, and fails like git outside a repository otherwise.
function gitTable(table) {
  return (cwd, args) => {
    const key = `${cwd}: ${args.join(' ')}`;
    if (!(key in table)) throw new Error(`fatal: not a git repository (${key})`);
    return table[key];
  };
}
const repo = (cwd, branch, root = cwd) => ({
  [`${cwd}: branch --show-current`]: branch,
  [`${cwd}: rev-parse --show-toplevel`]: root,
  [`${cwd}: rev-parse --path-format=absolute --git-common-dir`]: `${root}/.git`,
});

async function setup() {
  const store = await memoryStore();
  const a = store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const b = store.addItem({ project: 'misc', title: 'B', origin: 'manual' }, 'user');
  return { store, a, b };
}
const startAt = (store, id, cwd) => store.startSession({ id, file: null, cwd, name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: true });
const prLink = (store, itemId, head, repoName = 'example-org/api', number = 7) =>
  store.addLink(itemId, { kind: 'github-pr', key: `github:pr:${repoName}#${number}`, state: { detailed: true, state: 'OPEN', head } }, 'sync:github');

test('PI_WORK_ITEM wins, and an unknown item falls through to branch evidence', async () => {
  const { store, a } = await setup();
  prLink(store, a.id, 'fix-flake');
  const session = startAt(store, 's1', '/src/api');
  const git = gitTable(repo('/src/api', 'fix-flake'));
  assert.deepEqual(inferSessionLink(store, session, { env: { PI_WORK_ITEM: 'W-2' }, git }), { itemId: 'W-2', via: 'env' });
  assert.deepEqual(inferSessionLink(store, session, { env: { PI_WORK_ITEM: 'W-99' }, git }), { itemId: 'W-1', via: 'branch' });
  assert.deepEqual(inferSessionLink(store, session, { env: { PI_WORK_ITEM: 'nonsense' }, git }), { itemId: 'W-1', via: 'branch' });
});

test('a PR head branch links only within the same repository', async () => {
  const { store, a } = await setup();
  prLink(store, a.id, 'fix-flake');
  const web = startAt(store, 's2', '/src/web');
  assert.equal(inferSessionLink(store, web, { env: {}, git: gitTable(repo('/src/web', 'fix-flake')) }), undefined);
});

test('a Jira key in the branch name links, ignoring case', async () => {
  const { store, b } = await setup();
  store.addLink(b.id, { kind: 'jira', key: 'jira:ABC-12' }, 'user');
  const session = startAt(store, 's1', '/src/api');
  assert.deepEqual(inferSessionLink(store, session, { env: {}, git: gitTable(repo('/src/api', 'abc-12-retry')) }), { itemId: 'W-2', via: 'branch' });
});

test('branch evidence ignores done items', async () => {
  const { store, a } = await setup();
  prLink(store, a.id, 'fix-flake');
  store.updateItem(a.id, { status: 'done' }, 'user');
  const session = startAt(store, 's1', '/src/api');
  assert.equal(inferSessionLink(store, session, { env: {}, git: gitTable(repo('/src/api', 'fix-flake')) }), undefined);
});

test('ambiguous branch evidence links nothing, even when the worktree rule would match', async () => {
  const { store, a, b } = await setup();
  prLink(store, a.id, 'abc-12-retry');
  store.addLink(b.id, { kind: 'jira', key: 'jira:ABC-12' }, 'user');
  startAt(store, 'other', '/src/api');
  store.linkSession('other', a.id, 'manual', 'user');
  const session = startAt(store, 's1', '/src/api');
  assert.equal(inferSessionLink(store, session, { env: {}, git: gitTable(repo('/src/api', 'abc-12-retry')) }), undefined);
});

test('another linked session in the same worktree links, but a nested worktree does not count', async () => {
  const { store, a, b } = await setup();
  startAt(store, 'sub', '/src/api/pkg');
  store.linkSession('sub', a.id, 'manual', 'user');
  startAt(store, 'nested', '/src/api/.worktrees/x');
  store.linkSession('nested', b.id, 'manual', 'user');
  const session = startAt(store, 's1', '/src/api');
  const git = gitTable({
    ...repo('/src/api', 'main'),
    '/src/api/pkg: rev-parse --show-toplevel': '/src/api',
    '/src/api/.worktrees/x: rev-parse --show-toplevel': '/src/api/.worktrees/x',
  });
  assert.deepEqual(inferSessionLink(store, session, { env: {}, git }), { itemId: 'W-1', via: 'worktree' });
});

test('failing git lookups skip linking without throwing', async () => {
  const { store } = await setup();
  const session = startAt(store, 's1', '/nowhere');
  assert.equal(inferSessionLink(store, session, { env: {}, git: gitTable({}) }), undefined);
});

test('autoLinkSession links once with the session actor and never replaces an existing link', async () => {
  const { store, b } = await setup();
  startAt(store, 's1', '/src/api');
  const link = autoLinkSession(store, 's1', { env: { PI_WORK_ITEM: 'W-1' }, git: gitTable({}) });
  assert.equal(link.itemId, 'W-1');
  assert.deepEqual(link.state, { via: 'env' });
  assert.equal(store.listEvents().at(-1).actor, 'session:s1');
  store.linkSession('s1', b.id, 'manual', 'user');
  assert.equal(autoLinkSession(store, 's1', { env: { PI_WORK_ITEM: 'W-1' }, git: gitTable({}) }), undefined);
  assert.equal(store.sessionLink('s1').itemId, 'W-2');
  assert.equal(autoLinkSession(store, 'missing', { env: {}, git: gitTable({}) }), undefined);
});
```

In `tests/work/github.test.mjs`, change line 47 to:

```js
  assert.deepEqual(authored.observations[0].state, { detailed: true, state: 'OPEN', checks: 'passing', reviews: 1, comments: 0, reviewDecision: null, head: 'feature' });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/linking.test.mjs tests/work/github.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/linking.ts`, and a `head` mismatch in the GitHub test.

- [ ] **Step 3: Record the PR head branch and export the git runner**

In `src/work/connectors/github.ts`, inside `detailedObservation`, add `head` as the last property of `state`:

```ts
			reviewDecision: view.reviewDecision || null,
			head: view.headRefName ?? null,
		},
```

In `src/work/rules.ts`, change `const defaultGit: GitRunner =` to:

```ts
export const defaultGit: GitRunner = (cwd, args) =>
```

The body is unchanged.

- [ ] **Step 4: Implement linking**

Create `src/work/linking.ts`:

```ts
import { parsePrKey } from "./connectors/github.ts";
import type { GitRunner } from "./rules.ts";
import { jiraKeysIn, repoFromCwd, repoMatches } from "./rules.ts";
import type { WorkStore } from "./store.ts";
import type { Item, Link, LinkVia, Session } from "./types.ts";
import { OPEN_ITEM_STATUSES } from "./types.ts";

export const WORK_ITEM_ENV = "PI_WORK_ITEM";

export type LinkDeps = { env: NodeJS.ProcessEnv; git: GitRunner };
export type LinkMatch = { itemId: string; via: LinkVia };

function gitText(git: GitRunner, cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args).trim() || undefined;
	} catch {
		return undefined;
	}
}

function safeItem(store: WorkStore, id: string): Item | undefined {
	try {
		return store.getItem(id);
	} catch {
		return undefined;
	}
}

function only(ids: Set<string>): string | undefined {
	return ids.size === 1 ? [...ids][0] : undefined;
}

function branchEvidence(store: WorkStore, session: Session, branch: string, git: GitRunner): Set<string> {
	const open = new Set(store.listItems({ statuses: OPEN_ITEM_STATUSES }).map((item) => item.id));
	const repo = repoFromCwd(session.cwd, git);
	const ids = new Set<string>();
	for (const link of store.listAllLinks()) {
		if (link.kind !== "github-pr" || link.state?.head !== branch || !open.has(link.itemId)) continue;
		const pr = parsePrKey(link.key);
		if (!repo || (pr && repoMatches(pr.repo, repo))) ids.add(link.itemId);
	}
	for (const key of jiraKeysIn(branch.toUpperCase())) {
		const link = store.findLinkByKey(`jira:${key}`);
		if (link && open.has(link.itemId)) ids.add(link.itemId);
	}
	return ids;
}

function worktreeEvidence(store: WorkStore, session: Session, root: string, git: GitRunner): Set<string> {
	const ids = new Set<string>();
	for (const other of store.listSessions()) {
		if (other.id === session.id) continue;
		if (other.cwd !== root && !other.cwd.startsWith(`${root}/`)) continue;
		// A path under the root can still belong to a nested worktree with its own top level.
		if (other.cwd !== session.cwd && other.cwd !== root && gitText(git, other.cwd, ["rev-parse", "--show-toplevel"]) !== root) continue;
		const link = store.sessionLink(other.id);
		if (link) ids.add(link.itemId);
	}
	return ids;
}

// First match wins: launch environment, then branch evidence, then the shared worktree. Ambiguity links nothing.
export function inferSessionLink(store: WorkStore, session: Session, deps: LinkDeps): LinkMatch | undefined {
	const fromEnv = deps.env[WORK_ITEM_ENV]?.trim();
	const envItem = fromEnv ? safeItem(store, fromEnv) : undefined;
	if (envItem) return { itemId: envItem.id, via: "env" };

	const branch = gitText(deps.git, session.cwd, ["branch", "--show-current"]);
	if (branch) {
		const ids = branchEvidence(store, session, branch, deps.git);
		if (ids.size > 1) return undefined;
		const itemId = only(ids);
		if (itemId) return { itemId, via: "branch" };
	}

	const root = gitText(deps.git, session.cwd, ["rev-parse", "--show-toplevel"]);
	if (root) {
		const itemId = only(worktreeEvidence(store, session, root, deps.git));
		if (itemId) return { itemId, via: "worktree" };
	}
	return undefined;
}

export function autoLinkSession(store: WorkStore, sessionId: string, deps: LinkDeps): Link | undefined {
	if (store.sessionLink(sessionId)) return undefined;
	const session = store.getSession(sessionId);
	if (!session) return undefined;
	const match = inferSessionLink(store, session, deps);
	return match ? store.linkSession(sessionId, match.itemId, match.via, `session:${sessionId}`) : undefined;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/linking.test.mjs tests/work/github.test.mjs tests/work/reconcile.test.mjs tests/work/sync.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/linking.ts src/work/rules.ts src/work/connectors/github.ts tests/work/linking.test.mjs tests/work/github.test.mjs
git commit -m "feat: link sessions to items from launch, branch, and worktree evidence"
```

---

### Task 4: Session hooks, `session_status`, and transcript helpers

**Files:**
- Create: `src/work/transcript.ts`, `src/work/session-tracker.ts`
- Modify: `extensions/work.ts`: full rewrite below (existing commands unchanged, plus session hooks and the tool)
- Modify: `tests/work/extension.test.mjs`: inject `git` and `signals`, and extend the fake session manager
- Test: `tests/work/transcript.test.mjs`, `tests/work/session-hooks.test.mjs`

**Interfaces:**
- Consumes: `store.startSession`, `setSessionStatus`, `updateSession` (Task 1). `windowNameOf`, `listPanes`, `tmuxRunner` (Task 2). `autoLinkSession`, `LinkDeps` (Task 3). `defaultGit` (Task 3).
- Produces:
  - `transcript.ts`: `TRANSCRIPT_LIMIT = 30`, `TranscriptMessage = { role: "user" | "assistant"; text: string }`, `messageText(message: unknown): string`, `lastAssistantLine(messages: readonly unknown[]): string`, `parseTranscript(jsonl: string, limit?): TranscriptMessage[]`, `readTranscript(path: string, limit?): TranscriptMessage[]`, `formatTranscript(messages): string`
  - Registration rule (decision 4): `tui` always registers as top-level (`headless: false`, `parentSession: null`), with a pane only inside tmux. `rpc` always registers as headless. `print`, `json`, and any other mode register only when `PI_WORK_PARENT_SESSION` is set, as headless children. Unregistered sessions make every tracker method a no-op, so `session_status` reports `recorded: false`.
  - `session-tracker.ts`: `PARENT_SESSION_ENV = "PI_WORK_PARENT_SESSION"`, `SessionInfo = { id; file: string | null; cwd; name: string | null; mode: string }`, `TrackerDeps`, `SessionTracker` (`pane`, `start`, `agentStart`, `declare`, `agentEnd`, `rename`, `shutdown`), `createSessionTracker(deps)`, `shutdownIsClean({ reason, signalled, pane, tmux }): boolean`, `SignalSource`, and `watchSignals(source, onSignal): () => void`
  - `extensions/work.ts`: `WorkExtensionOptions` gains `git?: GitRunner`, `pid?: number`, and `signals?: SignalSource`. `SESSION_STATUS_DESCRIPTION` is the verbatim spec text. The static tool is `session_status`.

- [ ] **Step 1: Write the failing transcript tests**

Create `tests/work/transcript.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, tempDir } from './helpers.mjs';

const t = await load('src/work/transcript.ts');

const entry = (id, parentId, message) => JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-09-25T09:00:00.000Z', message });
const user = (text) => ({ role: 'user', content: text, timestamp: 1 });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }, { type: 'toolCall', id: 'c', name: 'bash', arguments: {} }] });

test('messageText joins text parts and ignores other parts', () => {
  assert.equal(t.messageText(user('hello')), 'hello');
  assert.equal(t.messageText(assistant('answer')), 'answer');
  assert.equal(t.messageText({ role: 'assistant', content: [{ type: 'image', data: 'x' }] }), '');
  assert.equal(t.messageText(null), '');
});

test('lastAssistantLine takes the last non-empty line of the latest assistant text', () => {
  assert.equal(t.lastAssistantLine([user('go'), assistant('Done with step one.\n\nShould I also update the docs?  \n')]), 'Should I also update the docs?');
  assert.equal(t.lastAssistantLine([assistant('Earlier question?'), { role: 'assistant', content: [{ type: 'toolCall' }] }]), 'Earlier question?');
  assert.equal(t.lastAssistantLine([user('only the user')]), '');
  assert.equal(t.lastAssistantLine([assistant('y'.repeat(300))]).length, 200);
});

test('parseTranscript follows the active branch and keeps user and assistant text only', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'uuid', timestamp: 'x', cwd: '/src/api' }),
    entry('a1', null, { role: 'system', content: '', sections: {} }),
    entry('a2', 'a1', user('first question')),
    entry('a3', 'a2', assistant('abandoned answer')),
    entry('a4', 'a2', assistant('kept answer')),
    entry('a5', 'a4', { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'tool output' }] }),
    'not json',
    entry('a6', 'a5', user('follow-up')),
  ];
  assert.deepEqual(t.parseTranscript(lines.join('\n')), [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'kept answer' },
    { role: 'user', text: 'follow-up' },
  ]);
  assert.deepEqual(t.parseTranscript(lines.join('\n'), 1), [{ role: 'user', text: 'follow-up' }]);
});

test('readTranscript reads the last 30 messages from a session file, and formatTranscript labels them', () => {
  const path = join(tempDir(), 'child.jsonl');
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(entry(`m${i}`, i === 0 ? null : `m${i - 1}`, i % 2 ? assistant(`reply ${i}`) : user(`ask ${i}`)));
  writeFileSync(path, `${lines.join('\n')}\n`);
  const messages = t.readTranscript(path);
  assert.equal(messages.length, 30);
  assert.deepEqual(messages[0], { role: 'user', text: 'ask 10' });
  assert.equal(t.formatTranscript(messages.slice(-2)), 'user:\n  ask 38\n\nassistant:\n  reply 39');
  assert.equal(t.formatTranscript([]), '(no messages yet)');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/transcript.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/transcript.ts`.

- [ ] **Step 3: Implement the transcript helpers**

Create `src/work/transcript.ts`:

```ts
import { readFileSync } from "node:fs";
import { NOTE_MAX } from "./types.ts";

export const TRANSCRIPT_LIMIT = 30;

export type TranscriptMessage = { role: "user" | "assistant"; text: string };

type Entry = { type?: unknown; id?: unknown; parentId?: unknown; message?: unknown };

function roleOf(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

export function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const { type, text } = part as { type?: unknown; text?: unknown };
		if (type === "text" && typeof text === "string") texts.push(text);
	}
	return texts.join("\n");
}

export function lastAssistantLine(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (roleOf(messages[i]) !== "assistant") continue;
		const lines = messageText(messages[i]).split("\n").map((line) => line.trim()).filter(Boolean);
		const last = lines.at(-1);
		if (last) return last.slice(0, NOTE_MAX);
	}
	return "";
}

// Follows parentId links back from the last entry, so abandoned branches are skipped.
export function parseTranscript(jsonl: string, limit: number = TRANSCRIPT_LIMIT): TranscriptMessage[] {
	const byId = new Map<string, Entry>();
	let leaf: Entry | undefined;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			continue;
		}
		if (typeof entry.id !== "string" || entry.type === "session") continue;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const path: Entry[] = [];
	const seen = new Set<string>();
	let current = leaf;
	while (current && !seen.has(String(current.id))) {
		seen.add(String(current.id));
		path.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	const messages: TranscriptMessage[] = [];
	for (const entry of path.reverse()) {
		if (entry.type !== "message") continue;
		const role = roleOf(entry.message);
		const text = messageText(entry.message).trim();
		if ((role === "user" || role === "assistant") && text) messages.push({ role, text });
	}
	return messages.slice(-limit);
}

export function readTranscript(path: string, limit: number = TRANSCRIPT_LIMIT): TranscriptMessage[] {
	return parseTranscript(readFileSync(path, "utf8"), limit);
}

export function formatTranscript(messages: readonly TranscriptMessage[]): string {
	if (messages.length === 0) return "(no messages yet)";
	return messages.map((message) => `${message.role}:\n${message.text.split("\n").map((line) => `  ${line}`).join("\n")}`).join("\n\n");
}
```

Run: `node --test tests/work/transcript.test.mjs`
Expected: PASS.

- [ ] **Step 4: Write the failing hook tests**

Create `tests/work/session-hooks.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { clock, load, memoryRuntime } from './helpers.mjs';

const { createWorkExtension, SESSION_STATUS_DESCRIPTION } = await load('extensions/work.ts');
const { shutdownIsClean } = await load('src/work/session-tracker.ts');

const IN_TMUX = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%3' };

function fakeTmux(state) {
  return (args) => {
    if (args[0] === 'display-message') return `${state.window}\n`;
    if (args[0] === 'list-panes') {
      if (state.serverGone) throw new Error('no server running');
      return state.panes.map((pane) => `${pane}\t@1\tapi\tmain\t/src/api\tzsh`).join('\n');
    }
    return '';
  };
}

function setup({ runtime, env = IN_TMUX, mode = 'tui' } = {}) {
  const tools = new Map();
  const events = new Map();
  const signals = new EventEmitter();
  // Stand-ins for Pi's own signal handlers; the extension only listens when Pi does.
  signals.on('SIGHUP', () => {});
  signals.on('SIGTERM', () => {});
  const tmuxState = { window: 'api', panes: ['%3'], serverGone: false };
  createWorkExtension({
    runtime: () => runtime,
    repoFromCwd: () => undefined,
    env,
    pid: 4242,
    tmux: fakeTmux(tmuxState),
    git: () => { throw new Error('not a git repository'); },
    signals,
  })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on(name, handler) { events.set(name, handler); },
  });
  const notes = [];
  const ctx = {
    cwd: '/src/api',
    mode,
    hasUI: mode === 'tui',
    sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/s/sess-1.jsonl', getSessionName: () => undefined },
    ui: { notify: (message, level) => notes.push({ message, level }), setStatus() {} },
  };
  const emit = (name, event = {}) => events.get(name)(event, ctx);
  return { tools, emit, ctx, notes, signals, tmuxState };
}

const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('session_start registers a tmux session with its pane, window, and file', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.pid, 4242);
  assert.equal(row.tmuxPane, '%3');
  assert.equal(row.tmuxWindow, 'api');
  assert.equal(row.file, '/s/sess-1.jsonl');
  assert.equal(row.cwd, '/src/api');
  assert.equal(row.headless, false);
  assert.equal(row.parentSession, null);
  assert.equal(row.status, 'needs-me');
  assert.equal(row.note, 'new session');
});

test('a child in rpc mode registers as headless, with its parent and no pane', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, mode: 'rpc', env: { ...IN_TMUX, PI_WORK_PARENT_SESSION: 'parent-1' } });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.headless, true);
  assert.equal(row.parentSession, 'parent-1');
  assert.equal(row.tmuxPane, null);
  assert.equal(row.tmuxWindow, null);
  const result = await s.tools.get('session_status').execute('c1', { status: 'needs-me', note: 'Which runner?' }, undefined, undefined, s.ctx);
  assert.equal(result.details.recorded, true);
});

test('a terminal session outside tmux registers as top-level and interactive, without a pane', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: {} });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.deepEqual([row.headless, row.parentSession, row.tmuxPane, row.tmuxWindow], [false, null, null, null]);
});

test('a terminal session is never a child, even with an inherited PI_WORK_PARENT_SESSION', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt, env: { ...IN_TMUX, PI_WORK_PARENT_SESSION: 'parent-1' } });
  await s.emit('session_start', { reason: 'startup' });
  const row = rt.store.getSession('sess-1');
  assert.deepEqual([row.headless, row.parentSession, row.tmuxPane], [false, null, '%3']);
});

test('rpc always registers, and print and json runs register only as children', async () => {
  for (const [mode, env, registered] of [
    ['rpc', IN_TMUX, true],
    ['rpc', {}, true],
    ['print', IN_TMUX, false],
    ['json', {}, false],
    ['print', { ...IN_TMUX, PI_WORK_PARENT_SESSION: 'parent-1' }, true],
    ['json', { PI_WORK_PARENT_SESSION: 'parent-1' }, true],
  ]) {
    const label = `${mode} ${JSON.stringify(env)}`;
    const rt = await memoryRuntime();
    const s = setup({ runtime: rt, mode, env });
    await s.emit('session_start', { reason: 'startup' });
    const row = rt.store.getSession('sess-1');
    assert.equal(Boolean(row), registered, label);
    if (row) assert.deepEqual([row.headless, row.tmuxPane, row.tmuxWindow], [true, null, null], label);
    const result = await s.tools.get('session_status').execute('c1', { status: 'done', note: 'Finished' }, undefined, undefined, s.ctx);
    assert.equal(result.details.recorded, registered, label);
  }
});

test('a run is working, and without a declaration it ends as needs-me with the last line as its note', async () => {
  const now = clock();
  const rt = await memoryRuntime({ now });
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  now.advance(1000);
  await s.emit('agent_start');
  assert.equal(rt.store.getSession('sess-1').status, 'working');
  s.tmuxState.window = 'api-renamed';
  now.advance(1000);
  await s.emit('agent_end', { messages: [assistant('Done with step one.\n\nShould I also update the docs?')] });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.status, 'needs-me');
  assert.equal(row.statusSource, 'auto');
  assert.equal(row.note, 'Should I also update the docs?');
  assert.equal(row.tmuxWindow, 'api-renamed');
  assert.equal(row.lastTurnAt, '2026-09-25T09:00:02.000Z');
});

test('a declared status wins over the fallback, the last declaration wins, and the next run resets it', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  const tool = s.tools.get('session_status');
  await tool.execute('c1', { status: 'needs-me', note: 'Which option?' }, undefined, undefined, s.ctx);
  await tool.execute('c2', { status: 'waiting-external', note: 'CI run 123 is pending' }, undefined, undefined, s.ctx);
  await s.emit('agent_end', { messages: [assistant('Waiting for CI.')] });
  let row = rt.store.getSession('sess-1');
  assert.equal(row.status, 'waiting-external');
  assert.equal(row.statusSource, 'agent');
  assert.equal(row.note, 'CI run 123 is pending');
  await s.emit('agent_start');
  await s.emit('agent_end', { messages: [] });
  row = rt.store.getSession('sess-1');
  assert.equal(row.status, 'needs-me');
  assert.equal(row.statusSource, 'auto');
});

test('session_status has a static schema and the spec description', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  const tool = s.tools.get('session_status');
  assert.equal(tool.description, SESSION_STATUS_DESCRIPTION);
  assert.match(tool.description, /^Declare this session's state as your final action in a turn/);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['note', 'status']);
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  const early = await tool.execute('c0', { status: 'done', note: 'Shipped' }, undefined, undefined, s.ctx);
  assert.equal(early.details.recorded, false);
});

test('a resumed session keeps its status, and renames are recorded', async () => {
  const rt = await memoryRuntime();
  const first = setup({ runtime: rt });
  await first.emit('session_start', { reason: 'startup' });
  rt.store.setSessionStatus('sess-1', 'waiting-external', 'Review from a teammate', 'agent');
  await first.emit('session_shutdown', { reason: 'quit' });
  assert.ok(rt.store.getSession('sess-1').endedAt);
  const second = setup({ runtime: rt });
  await second.emit('session_start', { reason: 'resume' });
  const row = rt.store.getSession('sess-1');
  assert.equal(row.endedAt, null);
  assert.equal(row.status, 'waiting-external');
  await second.emit('session_info_changed', { name: 'Fix flaky test' });
  assert.equal(rt.store.getSession('sess-1').name, 'Fix flaky test');
});

test('a signal leaves the session crashed while its pane exists or tmux is gone; closing the pane is clean', async () => {
  for (const [label, change, ended] of [
    ['pane still open', () => {}, false],
    ['server gone', (state) => { state.serverGone = true; }, false],
    ['pane closed', (state) => { state.panes = []; }, true],
  ]) {
    const rt = await memoryRuntime();
    const s = setup({ runtime: rt });
    await s.emit('session_start', { reason: 'startup' });
    change(s.tmuxState);
    s.signals.emit('SIGHUP');
    await s.emit('session_shutdown', { reason: 'quit' });
    assert.equal(Boolean(rt.store.getSession('sess-1').endedAt), ended, label);
  }
});

test("the shutdown hook sees the signal even though Pi's handler starts shutdown first", async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  await s.emit('session_start', { reason: 'startup' });
  let shutdown;
  s.signals.prependListener('SIGTERM', () => { shutdown = s.emit('session_shutdown', { reason: 'quit' }); });
  s.signals.emit('SIGTERM');
  await shutdown;
  assert.equal(rt.store.getSession('sess-1').endedAt, null);
});

test('a registry failure warns once and stops recording for the session', async () => {
  const rt = await memoryRuntime();
  const s = setup({ runtime: rt });
  rt.store.close();
  await s.emit('session_start', { reason: 'startup' });
  await s.emit('agent_start');
  await s.emit('agent_end', { messages: [] });
  const warnings = s.notes.filter((note) => note.level === 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /registry is off/);
});

test('PI_WORK_ITEM links the session to its item at start', async () => {
  const rt = await memoryRuntime();
  rt.store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const s = setup({ runtime: rt, env: { ...IN_TMUX, PI_WORK_ITEM: 'W-1' } });
  await s.emit('session_start', { reason: 'startup' });
  assert.equal(rt.store.sessionLink('sess-1').itemId, 'W-1');
});

test('shutdownIsClean covers every combination', () => {
  const panes = (list) => () => {
    if (list === null) throw new Error('no server running');
    return list.map((pane) => `${pane}\t@1\tw\ts\t/p\tzsh`).join('\n');
  };
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: false, pane: '%1', tmux: panes(['%1']) }), true);
  assert.equal(shutdownIsClean({ reason: 'reload', signalled: true, pane: '%1', tmux: panes(['%1']) }), true);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: null, tmux: panes(null) }), true);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: '%1', tmux: panes(['%1']) }), false);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: '%1', tmux: panes(null) }), false);
  assert.equal(shutdownIsClean({ reason: 'quit', signalled: true, pane: '%1', tmux: panes(['%2']) }), true);
});
```

In `tests/work/extension.test.mjs`, add `import { EventEmitter } from 'node:events';` after the `assert` import. In `setup`, change the `createWorkExtension(...)` options to:

```js
  createWorkExtension({ runtime: () => runtime, repoFromCwd: () => 'payments-api', env, git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter() })({
```

In `context()`, change the `sessionManager` line to:

```js
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => undefined, getSessionName: () => undefined },
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node --test tests/work/session-hooks.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/session-tracker.ts`.

- [ ] **Step 6: Implement the tracker**

Create `src/work/session-tracker.ts`:

```ts
import type { LinkDeps } from "./linking.ts";
import { autoLinkSession } from "./linking.ts";
import type { TmuxRunner } from "./planner.ts";
import type { GitRunner } from "./rules.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import { listPanes, windowNameOf } from "./tmux.ts";
import { lastAssistantLine } from "./transcript.ts";
import type { DeclaredStatus } from "./types.ts";

export const PARENT_SESSION_ENV = "PI_WORK_PARENT_SESSION";

export type SessionInfo = { id: string; file: string | null; cwd: string; name: string | null; mode: string };
export type TrackerDeps = {
	store: () => WorkStore;
	pid: number;
	env: NodeJS.ProcessEnv;
	tmux: TmuxRunner;
	git: GitRunner;
	warn: (message: string) => void;
};
export type SessionTracker = {
	readonly pane: string | null;
	start(info: SessionInfo): void;
	agentStart(): void;
	declare(status: DeclaredStatus, note: string): boolean;
	agentEnd(messages: readonly unknown[]): void;
	rename(name: string | null): void;
	shutdown(clean: boolean): void;
};
export type SignalName = "SIGHUP" | "SIGTERM";
export type SignalSource = {
	on(event: SignalName, listener: () => void): unknown;
	off(event: SignalName, listener: () => void): unknown;
	listenerCount(event: string): number;
};

export function createSessionTracker(deps: TrackerDeps): SessionTracker {
	let id: string | undefined;
	let pane: string | null = null;
	let disabled = false;
	let declared = false;
	const linkDeps: LinkDeps = { env: deps.env, git: deps.git };

	// Registry failures never break the Pi session: warn once, then stop recording for this session.
	const guard = (fn: (store: WorkStore, sessionId: string) => void): boolean => {
		if (disabled || !id) return false;
		try {
			fn(deps.store(), id);
			return true;
		} catch (error) {
			disabled = true;
			deps.warn(`Work session registry is off for this session: ${errorMessage(error)}`);
			return false;
		}
	};

	return {
		get pane() {
			return pane;
		},
		start(info) {
			const headless = info.mode !== "tui";
			// Terminal sessions are always top-level; only headless sessions can be children.
			const parentSession = headless ? deps.env[PARENT_SESSION_ENV]?.trim() || null : null;
			// print and json runs are one-shot scripts: record them only as child agents. rpc always registers.
			if (headless && info.mode !== "rpc" && !parentSession) return;
			id = info.id;
			pane = !headless && deps.env.TMUX && deps.env.TMUX_PANE ? deps.env.TMUX_PANE : null;
			guard((store, sessionId) => {
				store.startSession({
					id: sessionId,
					file: info.file,
					cwd: info.cwd,
					name: info.name,
					pid: deps.pid,
					tmuxPane: pane,
					tmuxWindow: pane ? windowNameOf(deps.tmux, pane) : null,
					parentSession,
					headless,
				});
				autoLinkSession(store, sessionId, linkDeps);
			});
		},
		agentStart() {
			declared = false;
			guard((store, sessionId) => {
				store.setSessionStatus(sessionId, "working", "", "auto");
			});
		},
		declare(status, note) {
			const recorded = guard((store, sessionId) => {
				store.setSessionStatus(sessionId, status, note, "agent");
			});
			if (recorded) declared = true;
			return recorded;
		},
		agentEnd(messages) {
			guard((store, sessionId) => {
				if (!declared) store.setSessionStatus(sessionId, "needs-me", lastAssistantLine(messages), "auto");
				const window = pane ? windowNameOf(deps.tmux, pane) : null;
				store.updateSession(sessionId, window ? { lastTurnAt: store.now(), tmuxWindow: window } : { lastTurnAt: store.now() });
				autoLinkSession(store, sessionId, linkDeps);
			});
			declared = false;
		},
		rename(name) {
			guard((store, sessionId) => {
				store.updateSession(sessionId, { name });
			});
		},
		shutdown(clean) {
			if (!clean) return;
			guard((store, sessionId) => {
				store.updateSession(sessionId, { endedAt: store.now() });
			});
		},
	};
}

// Pi emits session_shutdown even for SIGHUP and SIGTERM. Closing a pane is a clean close, but a signal
// while the pane still exists, or with the tmux server gone (reboot, kill-server), is a crash to restore.
export function shutdownIsClean(input: { reason: string; signalled: boolean; pane: string | null; tmux: TmuxRunner }): boolean {
	if (input.reason !== "quit" || !input.signalled || !input.pane) return true;
	const panes = listPanes(input.tmux);
	if (!panes) return false;
	return !panes.some((pane) => pane.paneId === input.pane);
}

// Listens only for signals Pi already handles, so adding a listener never disables Node's default exit.
export function watchSignals(source: SignalSource, onSignal: () => void): () => void {
	const events = (["SIGHUP", "SIGTERM"] as const).filter((event) => source.listenerCount(event) > 0);
	for (const event of events) source.on(event, onSignal);
	return () => {
		for (const event of events) source.off(event, onSignal);
	};
}
```

- [ ] **Step 7: Rewrite the extension**

Replace `extensions/work.ts` with:

```ts
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureItem } from "../src/work/capture.ts";
import { expandHome } from "../src/work/config.ts";
import type { TmuxRunner } from "../src/work/planner.ts";
import { defaultTmux, launchPlanner, PLANNER_ENV } from "../src/work/planner.ts";
import { registerPlannerTools } from "../src/work/planner-tools.ts";
import { proposeCandidate } from "../src/work/proposals.ts";
import type { GitRunner } from "../src/work/rules.ts";
import { defaultGit, repoFromCwd } from "../src/work/rules.ts";
import type { Runtime } from "../src/work/runtime.ts";
import { openRuntime } from "../src/work/runtime.ts";
import { errorMessage } from "../src/work/secrets.ts";
import type { SignalSource } from "../src/work/session-tracker.ts";
import { createSessionTracker, shutdownIsClean, watchSignals } from "../src/work/session-tracker.ts";
import { syncAll } from "../src/work/sync.ts";
import { tmuxRunner } from "../src/work/tmux.ts";
import { openCandidates } from "../src/work/triage.ts";
import type { TriageUiContext } from "../src/work/triage-ui.ts";
import { runTriageUi } from "../src/work/triage-ui.ts";
import { DECLARED_STATUSES } from "../src/work/types.ts";

export type WorkExtensionOptions = {
	runtime?: () => Runtime;
	repoFromCwd?: (cwd: string) => string | undefined;
	env?: NodeJS.ProcessEnv;
	tmux?: TmuxRunner;
	git?: GitRunner;
	pid?: number;
	signals?: SignalSource;
};

export const PROPOSE_DESCRIPTION = "Propose a follow-up for the user's work triage inbox. Use only for work outside your current task's scope, or for work you would otherwise leave as \"not done yet\" at the end of the session. Do not propose normal progress on your own task. The user reviews every proposal; this tool cannot create items, change status, or contact Jira.";

export const SESSION_STATUS_DESCRIPTION = "Declare this session's state as your final action in a turn: `needs-me` when you are asking the user a question or need a decision (note: the question), `waiting-external` when blocked on CI, review, a deploy, or another person (note: what and why), `done` when the task is complete (note: one-line outcome). Call at most once per turn.";

type StatusContext = { ui: { setStatus: (key: string, text: string | undefined) => void } };

export function createWorkExtension(options: WorkExtensionOptions = {}) {
	return function workExtension(pi: ExtensionAPI): void {
		let runtime: Runtime | undefined;
		const rt = (): Runtime => (runtime ??= (options.runtime ?? (() => openRuntime()))());
		const repoOf = options.repoFromCwd ?? ((cwd: string) => repoFromCwd(cwd));
		const env = options.env ?? process.env;
		const sessionTmux = options.tmux ?? tmuxRunner();
		let warn: (message: string) => void = () => {};
		const tracker = createSessionTracker({
			store: () => rt().store,
			pid: options.pid ?? process.pid,
			env,
			tmux: sessionTmux,
			git: options.git ?? defaultGit,
			warn: (message) => warn(message),
		});
		let signalled = false;
		let unwatch: (() => void) | undefined;

		const refreshBadge = (ctx: StatusContext): void => {
			try {
				const count = openCandidates(rt().store).length;
				ctx.ui.setStatus("work", count > 0 ? `inbox ${count}` : undefined);
			} catch {
				ctx.ui.setStatus("work", undefined);
			}
		};

		pi.registerCommand("todo", {
			description: "Capture a work item: /todo <text> [#project] [due:<date>]",
			handler: async (args, ctx) => {
				const text = (args ?? "").trim();
				if (!text) {
					ctx.ui.notify("Usage: /todo <text> [#project] [due:<date>]", "warning");
					return;
				}
				try {
					const r = rt();
					const item = captureItem(r.store, text, { repo: repoOf(ctx.cwd), now: r.store.clock(), knownProjects: r.knownProjects(), rules: r.config.rules }, "user");
					ctx.ui.notify(`${item.id} added to ${item.project}`, "info");
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});

		pi.registerTool({
			name: "work_propose",
			label: "Work Propose",
			description: PROPOSE_DESCRIPTION,
			parameters: Type.Object({
				title: Type.String({ minLength: 3, maxLength: 120 }),
				reason: Type.String({ minLength: 1, maxLength: 500 }),
				evidence: Type.Optional(Type.String({ maxLength: 1000 })),
				project: Type.Optional(Type.String()),
				relates_to: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const r = rt();
				const result = proposeCandidate(
					r.store,
					{ title: params.title, reason: params.reason, evidence: params.evidence, project: params.project, relatesTo: params.relates_to },
					{ sessionId: ctx.sessionManager.getSessionId(), repo: repoOf(ctx.cwd) ?? null },
					r.config,
				);
				refreshBadge(ctx);
				return { content: [{ type: "text", text: result.message }], details: { status: result.status, candidateId: result.candidate?.id ?? null } };
			},
		});

		pi.registerTool({
			name: "session_status",
			label: "Session Status",
			description: SESSION_STATUS_DESCRIPTION,
			parameters: Type.Object({
				status: StringEnum([...DECLARED_STATUSES] as const),
				note: Type.String({ minLength: 1, maxLength: 200 }),
			}),
			async execute(_toolCallId, params) {
				const recorded = tracker.declare(params.status, params.note);
				const text = recorded ? `Recorded ${params.status}.` : "Session status is not being recorded for this session.";
				return { content: [{ type: "text", text }], details: { recorded } };
			},
		});

		pi.registerCommand("triage", {
			description: "Review the work triage inbox",
			handler: async (_args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Triage needs the interactive terminal; run `work triage` in a shell", "warning");
					return;
				}
				await runTriageUi(ctx as unknown as TriageUiContext, rt());
				refreshBadge(ctx);
			},
		});

		if (env[PLANNER_ENV] === "1") registerPlannerTools(pi, rt);

		pi.registerCommand("today", {
			description: "Sync, triage, then open today's planner session",
			handler: async (_args, ctx) => {
				try {
					const r = rt();
					const report = await syncAll(r.store, r.config, { jira: r.jira, gh: r.gh, backupDir: r.backupDir });
					for (const warning of report.warnings) ctx.ui.notify(warning, "warning");
					if (ctx.mode === "tui" && openCandidates(r.store).length > 0) await runTriageUi(ctx as unknown as TriageUiContext, r);
					const result = launchPlanner({ store: r.store, cwd: expandHome(r.config.plannerCwd ?? "~"), env, tmux: options.tmux ?? defaultTmux, now: r.store.clock() });
					ctx.ui.notify(result.message, "info");
					refreshBadge(ctx);
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			refreshBadge(ctx);
			warn = (message) => ctx.ui.notify(message, "warning");
			unwatch ??= watchSignals(options.signals ?? (process as unknown as SignalSource), () => {
				signalled = true;
			});
			tracker.start({
				id: ctx.sessionManager.getSessionId(),
				file: ctx.sessionManager.getSessionFile() ?? null,
				cwd: ctx.cwd,
				name: ctx.sessionManager.getSessionName() ?? null,
				mode: ctx.mode,
			});
		});
		pi.on("agent_start", async () => tracker.agentStart());
		pi.on("agent_end", async (event) => tracker.agentEnd(event.messages));
		pi.on("session_info_changed", async (event) => tracker.rename(event.name ?? null));
		pi.on("session_shutdown", async (event) => {
			// Pi's own signal handler starts shutdown before this extension's listener runs; yield once so it can.
			await Promise.resolve();
			tracker.shutdown(shutdownIsClean({ reason: event.reason, signalled, pane: tracker.pane, tmux: sessionTmux }));
			unwatch?.();
			unwatch = undefined;
		});
	};
}

export default createWorkExtension();
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/work/session-hooks.test.mjs tests/work/extension.test.mjs tests/work/transcript.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors. If `ctx.mode` has a narrower declared type than `string`, `SessionInfo.mode: string` still accepts it.

Run: `npm test`
Expected: PASS. `tests/install.test.mjs` still loads `extensions/work.ts` with host-provided peers.

- [ ] **Step 9: Commit**

```bash
git add src/work/transcript.ts src/work/session-tracker.ts extensions/work.ts tests/work/transcript.test.mjs tests/work/session-hooks.test.mjs tests/work/extension.test.mjs
git commit -m "feat: register Pi sessions and child agents with automatic status"
```

---

### Task 5: `/task` launches sessions with `PI_WORK_ITEM`

**Files:**
- Modify: `src/worktree/index.ts` (`tmuxPiLaunchCommand`): optional environment prefix
- Modify: `extensions/task.ts` (`buildTaskLaunchCommand`, `runTaskCommand`): `workItemIn`, and pass the item
- Test: `tests/worktree/core.test.mjs`, `tests/task/task.test.mjs`

**Interfaces:**
- Consumes: `WORK_ITEM_ENV` naming from Task 3. The string `PI_WORK_ITEM` is used literally here so that `extensions/task.ts` does not import the work modules.
- Produces:
  - `tmuxPiLaunchCommand(info)` accepts `env?: Record<string, string>`. Variables are prefixed as `KEY='value'` after `PI_WORKTREE_AUTO_CLEANUP=1`.
  - `workItemIn(request: string): string | undefined`, the first `W-<n>` in the request
  - `buildTaskLaunchCommand(worktree, prompt, options: { split: boolean; insideTmux: boolean; workItem?: string })`

- [ ] **Step 1: Write the failing tests**

Append to `tests/worktree/core.test.mjs`:

```js
test('tmuxPiLaunchCommand prefixes shell-quoted environment variables', () => {
  assert.equal(core.tmuxPiLaunchCommand({
    name: 'fix-flaky',
    path: '/repos/agent/.pi/worktrees/fix-flaky',
    prompt: 'Fix W-7',
    insideTmux: true,
    autoCleanup: true,
    env: { PI_WORK_ITEM: 'W-7' },
  }).args.at(-1), "PI_WORKTREE_AUTO_CLEANUP=1 PI_WORK_ITEM='W-7' pi 'Fix W-7'");
});
```

Append to `tests/task/task.test.mjs`:

```js
test('a request that names a work item launches the session with PI_WORK_ITEM', () => {
  assert.equal(task.workItemIn('continue W-12, then W-3'), 'W-12');
  assert.equal(task.workItemIn('no item here'), undefined);
  const launch = task.buildTaskLaunchCommand({ name: 'fix-flaky', path: '/repo/.pi/worktrees/fix-flaky' }, 'Fix flaky test', { split: false, insideTmux: true, workItem: 'W-12' });
  assert.equal(launch.args.at(-1), "PI_WORKTREE_AUTO_CLEANUP=1 PI_WORK_ITEM='W-12' pi 'Fix flaky test'");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/worktree/core.test.mjs tests/task/task.test.mjs`
Expected: FAIL. `task.workItemIn is not a function`, and the environment prefix is missing.

- [ ] **Step 3: Implement the environment prefix**

In `src/worktree/index.ts`, change the `tmuxPiLaunchCommand` signature and its `command` line to:

```ts
export function tmuxPiLaunchCommand(info: { name: string; path: string; prompt: string; insideTmux?: boolean; split?: boolean; autoCleanup?: boolean; env?: Record<string, string> }): {
```

```ts
	const envPrefix = Object.entries(info.env ?? {}).map(([key, value]) => `${key}=${shellQuote(value)} `).join("");
	const command = `${info.autoCleanup ? "PI_WORKTREE_AUTO_CLEANUP=1 " : ""}${envPrefix}pi ${shellQuote(info.prompt)}`;
```

In `extensions/task.ts`, replace `buildTaskLaunchCommand` with:

```ts
export function workItemIn(request: string): string | undefined {
	return /\bW-\d+\b/.exec(request)?.[0];
}

export function buildTaskLaunchCommand(
	worktree: { name: string; path: string },
	prompt: string,
	options: { split: boolean; insideTmux: boolean; workItem?: string },
): ReturnType<typeof tmuxPiLaunchCommand> {
	return tmuxPiLaunchCommand({
		name: worktree.name,
		path: worktree.path,
		prompt,
		insideTmux: options.insideTmux,
		split: options.split,
		autoCleanup: true,
		env: options.workItem ? { PI_WORK_ITEM: options.workItem } : undefined,
	});
}
```

In `runTaskCommand`, change the `buildTaskLaunchCommand(...)` call to:

```ts
		const launch = buildTaskLaunchCommand(worktree, kickoffPrompt, { split: parsedArgs.split, insideTmux: Boolean(process.env.TMUX), workItem: workItemIn(request) });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/worktree/core.test.mjs tests/task/task.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/index.ts extensions/task.ts tests/worktree/core.test.mjs tests/task/task.test.mjs
git commit -m "feat: start /task sessions with PI_WORK_ITEM when the request names an item"
```

---

### Task 6: Automatic restore and `work restore`

**Files:**
- Create: `src/work/restore.ts`
- Modify: `src/work/cli.ts`: the `restore` command, and `CliDeps` gains `readers` and `bootId`
- Test: `tests/work/restore.test.mjs`

**Interfaces:**
- Consumes: `probeSessions`, `ProbedSession`, `PidReaders` (Task 2). `listPanes`, `isShell`, `TmuxPane` (Task 2). `store.listSessions`, `updateSession`, `getMeta`, and `setMeta`. `shellQuote` and `TmuxRunner` from `planner.ts`.
- Produces:
  - `RESTORE_WINDOW_MS` (7 days), `RESTORE_FALLBACK_MS` (10 minutes), `RestoreError`
  - `RestoreStep`: `{ kind: "send"; sessionId; pane; command }`, `{ kind: "split"; sessionId; window; cwd; command }` (`window` is a tmux window ID, or `new:<name>` for a window created earlier in the same plan), or `{ kind: "window"; sessionId; name; cwd; command }`
  - `restoreCommand(file, pi = "pi"): string`, `windowNameFor(session): string`
  - `selectForRestore(sessions: ProbedSession[], now, fileExists?): { selected; skipped: RestoreSkip[] }`
  - `planRestore(sessions, panes, pi?): RestoreStep[]`
  - `executeRestore(steps, tmux): { placed: Placed[]; failed: { sessionId; error }[] }`, where `Placed = { sessionId; pane }`
  - `readBootId(path?)`, `claimRestore(store, bootId, now): boolean`
  - `RestoreMode = "auto" | "manual" | "dry-run"`, `RestoreDeps = { store; tmux; readers?; bootId?; fileExists?; pi? }`, `RestoreReport`
  - `runRestore(mode, deps): RestoreReport`
  - `reopenSession(store, session: ProbedSession, tmux, panes, options?: { fileExists?; pi? }): string`, which returns the new pane
  - `formatRestoreReport(report): string`, `describeStep(step): string`
  - `CliDeps.readers?: PidReaders` and `CliDeps.bootId?: () => string | undefined`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/restore.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIo, clock, load, memoryRuntime, memoryStore, tempDir } from './helpers.mjs';

const restore = await load('src/work/restore.ts');
const { runCli } = await load('src/work/cli.ts');

const NOW = new Date('2026-09-25T09:00:00.000Z');
const session = (overrides = {}) => {
  const id = overrides.id ?? 's1';
  return {
    id, file: `/s/${id}.jsonl`, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api',
    startedAt: '2026-09-24T09:00:00.000Z', lastTurnAt: null, endedAt: null, status: 'working', note: '', statusSource: 'auto',
    statusAt: '2026-09-24T09:00:00.000Z', restoredFrom: null, parentSession: null, headless: false, liveness: 'crashed', alive: false,
    ...overrides,
  };
};
const pane = (paneId, windowId, windowName, path, command = 'zsh') => ({ paneId, windowId, windowName, sessionName: 'main', path, command });
const dead = { kill: () => { throw new Error('kill ESRCH'); }, environ: () => undefined };

function tmuxFake(calls = [], panes = '%2\t@1\tshell\tmain\t/home\tzsh') {
  return (args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return panes;
    if (args[0] === 'new-window') return '@9\t%20\n';
    if (args[0] === 'split-window') return '%21\n';
    return '';
  };
}

async function restoreStore(now = clock()) {
  const store = await memoryStore(now);
  store.startSession({ id: 's1', file: '/s/s1.jsonl', cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  return store;
}

test('placement reuses a matching shell pane, then splits the window, then creates a window and reuses it', () => {
  const steps = restore.planRestore([
    session({ id: 'a' }),
    session({ id: 'b', cwd: '/src/api/docs' }),
    session({ id: 'c', tmuxWindow: 'web', cwd: '/src/web' }),
    session({ id: 'd', tmuxWindow: 'web', cwd: '/src/web' }),
  ], [pane('%5', '@2', 'api', '/src/api'), pane('%6', '@3', 'notes', '/src/api', 'vim')]);
  assert.deepEqual(steps, [
    { kind: 'send', sessionId: 'a', pane: '%5', command: "pi --session '/s/a.jsonl'" },
    { kind: 'split', sessionId: 'b', window: '@2', cwd: '/src/api/docs', command: "pi --session '/s/b.jsonl'" },
    { kind: 'window', sessionId: 'c', name: 'web', cwd: '/src/web', command: "pi --session '/s/c.jsonl'" },
    { kind: 'split', sessionId: 'd', window: 'new:web', cwd: '/src/web', command: "pi --session '/s/d.jsonl'" },
  ]);
});

test('sessions that shared a window return as panes of it, and busy panes are not reused', () => {
  const steps = restore.planRestore([session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })], [
    pane('%5', '@2', 'api', '/src/api'),
    pane('%6', '@2', 'api', '/src/api', 'node'),
    pane('%7', '@2', 'api', '/src/api', 'bash'),
  ]);
  assert.deepEqual(steps.map((step) => [step.kind, step.pane ?? step.window]), [['send', '%5'], ['send', '%7'], ['split', '@2']]);
});

test('a session without a window name uses its directory name, and a custom pi command is used as given', () => {
  const [step] = restore.planRestore([session({ tmuxWindow: null })], [], "sh '/x/fake-pi.sh'");
  assert.deepEqual(step, { kind: 'window', sessionId: 's1', name: 'api', cwd: '/src/api', command: "sh '/x/fake-pi.sh' --session '/s/s1.jsonl'" });
});

test('selection takes crashed, unfinished, top-level sessions from the last 7 days and reports missing files', () => {
  const exists = (path) => path !== '/s/gone.jsonl';
  const { selected, skipped } = restore.selectForRestore([
    session({ id: 'ok' }),
    session({ id: 'old', startedAt: '2026-09-17T08:00:00.000Z' }),
    session({ id: 'recent-turn', startedAt: '2026-09-10T08:00:00.000Z', lastTurnAt: '2026-09-24T08:00:00.000Z' }),
    session({ id: 'done', status: 'done' }),
    session({ id: 'closed', liveness: 'closed', endedAt: '2026-09-24T10:00:00.000Z' }),
    session({ id: 'live', liveness: 'live', alive: true }),
    session({ id: 'orphan', alive: true }),
    session({ id: 'headless', headless: true, tmuxPane: null, tmuxWindow: null }),
    session({ id: 'outside-tmux', tmuxPane: null, tmuxWindow: null }),
    session({ id: 'child', headless: true, tmuxPane: null, parentSession: 'ok' }),
    session({ id: 'no-file', file: null }),
    session({ id: 'gone' }),
  ].map((s) => (s.id === 'gone' ? { ...s, file: '/s/gone.jsonl' } : s)), NOW, exists);
  assert.deepEqual(selected.map((s) => s.id), ['recent-turn', 'ok']);
  assert.deepEqual(skipped, [{ sessionId: 'no-file', reason: 'session file missing' }, { sessionId: 'gone', reason: 'session file missing' }]);
});

test('executeRestore types into shells, splits, reuses windows it created, and reports failures', () => {
  const calls = [];
  const tmux = (args) => {
    calls.push(args);
    if (args[0] === 'new-window') return '@9\t%20\n';
    if (args[0] === 'split-window' && args.includes('/broken')) throw new Error('create pane failed: pane too small');
    if (args[0] === 'split-window') return '%21\n';
    return '';
  };
  const result = restore.executeRestore([
    { kind: 'send', sessionId: 'a', pane: '%5', command: 'pi --session a' },
    { kind: 'window', sessionId: 'c', name: 'web', cwd: '/src/web', command: 'pi --session c' },
    { kind: 'split', sessionId: 'd', window: 'new:web', cwd: '/src/web', command: 'pi --session d' },
    { kind: 'split', sessionId: 'e', window: '@9', cwd: '/broken', command: 'pi --session e' },
  ], tmux);
  assert.deepEqual(result.placed, [{ sessionId: 'a', pane: '%5' }, { sessionId: 'c', pane: '%20' }, { sessionId: 'd', pane: '%21' }]);
  assert.deepEqual(result.failed, [{ sessionId: 'e', error: 'create pane failed: pane too small' }]);
  assert.deepEqual(calls.slice(0, 4), [
    ['send-keys', '-t', '%5', '-l', 'pi --session a'],
    ['send-keys', '-t', '%5', 'Enter'],
    ['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-n', 'web', '-c', '/src/web', 'pi --session c'],
    ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', '@9', '-c', '/src/web', 'pi --session d'],
  ]);
});

test('auto restore runs once per boot, manual restore ignores the marker, and dry runs change nothing', async () => {
  const store = await restoreStore();
  const calls = [];
  const deps = { store, tmux: tmuxFake(calls), readers: dead, bootId: () => 'boot-1', fileExists: () => true };
  const dry = restore.runRestore('dry-run', deps);
  assert.equal(dry.ran, false);
  assert.equal(dry.steps.length, 1);
  assert.equal(store.getMeta('restore:boot:boot-1'), undefined);
  assert.deepEqual(calls.filter((call) => call[0] !== 'list-panes'), []);
  const first = restore.runRestore('auto', deps);
  assert.equal(first.ran, true);
  assert.deepEqual(first.placed, [{ sessionId: 's1', pane: '%20' }]);
  assert.equal(store.getSession('s1').restoredFrom, 11);
  assert.ok(store.getMeta('restore:boot:boot-1'));
  const second = restore.runRestore('auto', deps);
  assert.equal(second.ran, false);
  assert.match(second.reason, /already restored/);
  assert.equal(restore.runRestore('manual', deps).ran, true);
  assert.equal(restore.runRestore('auto', { ...deps, bootId: () => 'boot-2' }).ran, true);
});

test('without a boot ID, auto restore waits 10 minutes between runs', async () => {
  const now = clock();
  const store = await restoreStore(now);
  const deps = { store, tmux: tmuxFake(), readers: dead, bootId: () => undefined, fileExists: () => true };
  assert.equal(restore.runRestore('auto', deps).ran, true);
  now.advance(9 * 60_000);
  assert.equal(restore.runRestore('auto', deps).ran, false);
  now.advance(2 * 60_000);
  assert.equal(restore.runRestore('auto', deps).ran, true);
});

test('restore does nothing and claims nothing when tmux is not running', async () => {
  const store = await restoreStore();
  const report = restore.runRestore('auto', { store, tmux: () => { throw new Error('no server running'); }, readers: dead, bootId: () => 'b', fileExists: () => true });
  assert.equal(report.ran, false);
  assert.match(report.reason, /tmux is not running/);
  assert.equal(store.getMeta('restore:boot:b'), undefined);
});

test('reopenSession places one session and refuses running or missing sessions', async () => {
  const store = await restoreStore();
  assert.equal(restore.reopenSession(store, session({ liveness: 'closed', endedAt: 'x' }), tmuxFake(), [], { fileExists: () => true }), '%20');
  assert.equal(store.getSession('s1').restoredFrom, 11);
  assert.throws(() => restore.reopenSession(store, session({ alive: true }), tmuxFake(), [], { fileExists: () => true }), /still running/);
  assert.throws(() => restore.reopenSession(store, session(), tmuxFake(), [], { fileExists: () => false }), /file is missing/);
});

test('formatRestoreReport describes plans, results, skips, and failures', () => {
  const step = { kind: 'window', sessionId: 's1', name: 'api', cwd: '/src/api', command: 'pi --session x' };
  assert.equal(restore.formatRestoreReport({ mode: 'dry-run', ran: false, steps: [step], placed: [], failed: [], skipped: [] }), 'Would restore 1 session:\n  s1: new window api in /src/api: pi --session x');
  assert.equal(restore.formatRestoreReport({ mode: 'auto', ran: false, reason: 'already restored since this boot', steps: [], placed: [], failed: [], skipped: [] }), 'Restore skipped: already restored since this boot');
  assert.equal(
    restore.formatRestoreReport({ mode: 'manual', ran: true, steps: [step], placed: [{ sessionId: 's1', pane: '%20' }], failed: [{ sessionId: 's2', error: 'boom' }], skipped: [{ sessionId: 's3', reason: 'session file missing' }] }),
    'Restored 1 session\n  s1 in pane %20\nSkipped s3: session file missing\nFailed s2: boom',
  );
  assert.equal(restore.formatRestoreReport({ mode: 'manual', ran: true, steps: [], placed: [], failed: [], skipped: [] }), 'Nothing to restore');
});

test('work restore --dry-run prints the plan', async () => {
  const dir = tempDir();
  const file = join(dir, 's1.jsonl');
  writeFileSync(file, '');
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 's1', file, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  const io = captureIo();
  const code = await runCli(['restore', '--dry-run'], { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, tmux: tmuxFake(), readers: dead, bootId: () => 'b' });
  assert.equal(code, 0);
  assert.equal(io.out.join('\n'), `Would restore 1 session:\n  s1: new window api in /src/api: pi --session '${file}'`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/restore.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/restore.ts`.

- [ ] **Step 3: Implement restore**

Create `src/work/restore.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { PidReaders, ProbedSession } from "./liveness.ts";
import { probeSessions } from "./liveness.ts";
import type { TmuxRunner } from "./planner.ts";
import { shellQuote } from "./planner.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import type { TmuxPane } from "./tmux.ts";
import { isShell, listPanes } from "./tmux.ts";
import type { Session } from "./types.ts";

export const RESTORE_WINDOW_MS = 7 * 86_400_000;
export const RESTORE_FALLBACK_MS = 10 * 60_000;
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export class RestoreError extends Error {}

export type RestoreStep =
	| { kind: "send"; sessionId: string; pane: string; command: string }
	| { kind: "split"; sessionId: string; window: string; cwd: string; command: string }
	| { kind: "window"; sessionId: string; name: string; cwd: string; command: string };
export type RestoreSkip = { sessionId: string; reason: string };
export type Placed = { sessionId: string; pane: string };
export type RestoreFailure = { sessionId: string; error: string };
export type RestoreMode = "auto" | "manual" | "dry-run";
export type RestoreDeps = {
	store: WorkStore;
	tmux: TmuxRunner;
	readers?: PidReaders;
	bootId?: () => string | undefined;
	fileExists?: (path: string) => boolean;
	pi?: string;
};
export type RestoreReport = {
	mode: RestoreMode;
	ran: boolean;
	reason?: string;
	steps: RestoreStep[];
	placed: Placed[];
	failed: RestoreFailure[];
	skipped: RestoreSkip[];
};

export function restoreCommand(file: string, pi = "pi"): string {
	return `${pi} --session ${shellQuote(file)}`;
}

export function windowNameFor(session: Session): string {
	return session.tmuxWindow || basename(session.cwd) || "pi";
}

export function selectForRestore(
	sessions: readonly ProbedSession[],
	now: Date,
	fileExists: (path: string) => boolean = existsSync,
): { selected: ProbedSession[]; skipped: RestoreSkip[] } {
	const selected: ProbedSession[] = [];
	const skipped: RestoreSkip[] = [];
	for (const session of sessions) {
		// Headless sessions (child agents, non-terminal modes) are never reopened: their parent decides.
		// Terminal sessions that ran outside tmux have no pane to return to, so only Enter in the dashboard reopens them.
		if (session.liveness !== "crashed" || session.alive || session.status === "done" || session.headless || !session.tmuxPane) continue;
		if (now.getTime() - Date.parse(session.lastTurnAt ?? session.startedAt) > RESTORE_WINDOW_MS) continue;
		if (!session.file || !fileExists(session.file)) {
			skipped.push({ sessionId: session.id, reason: "session file missing" });
			continue;
		}
		selected.push(session);
	}
	selected.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
	return { selected, skipped };
}

export function planRestore(sessions: readonly Session[], panes: readonly TmuxPane[], pi = "pi"): RestoreStep[] {
	const used = new Set<string>();
	const created = new Set<string>();
	const steps: RestoreStep[] = [];
	for (const session of sessions) {
		if (!session.file) continue;
		const command = restoreCommand(session.file, pi);
		const name = windowNameFor(session);
		const shell = panes.find((pane) => !used.has(pane.paneId) && pane.windowName === name && pane.path === session.cwd && isShell(pane.command));
		if (shell) {
			used.add(shell.paneId);
			steps.push({ kind: "send", sessionId: session.id, pane: shell.paneId, command });
			continue;
		}
		const window = panes.find((pane) => pane.windowName === name);
		if (window) {
			steps.push({ kind: "split", sessionId: session.id, window: window.windowId, cwd: session.cwd, command });
			continue;
		}
		if (created.has(name)) {
			steps.push({ kind: "split", sessionId: session.id, window: `new:${name}`, cwd: session.cwd, command });
			continue;
		}
		created.add(name);
		steps.push({ kind: "window", sessionId: session.id, name, cwd: session.cwd, command });
	}
	return steps;
}

export function executeRestore(steps: readonly RestoreStep[], tmux: TmuxRunner): { placed: Placed[]; failed: RestoreFailure[] } {
	const created = new Map<string, string>();
	const placed: Placed[] = [];
	const failed: RestoreFailure[] = [];
	for (const step of steps) {
		try {
			if (step.kind === "send") {
				tmux(["send-keys", "-t", step.pane, "-l", step.command]);
				tmux(["send-keys", "-t", step.pane, "Enter"]);
				placed.push({ sessionId: step.sessionId, pane: step.pane });
			} else if (step.kind === "split") {
				const target = step.window.startsWith("new:") ? created.get(step.window.slice(4)) : step.window;
				if (!target) throw new RestoreError(`window ${step.window.slice(4)} was not created`);
				const pane = tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", target, "-c", step.cwd, step.command]).trim();
				placed.push({ sessionId: step.sessionId, pane });
			} else {
				const [windowId = "", pane = ""] = tmux(["new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}", "-n", step.name, "-c", step.cwd, step.command]).trim().split("\t");
				created.set(step.name, windowId);
				placed.push({ sessionId: step.sessionId, pane });
			}
		} catch (error) {
			failed.push({ sessionId: step.sessionId, error: errorMessage(error).split("\n")[0] ?? "" });
		}
	}
	return { placed, failed };
}

export function readBootId(path: string = BOOT_ID_PATH): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function markRestore(store: WorkStore, bootId: string | undefined, now: Date): void {
	if (bootId) store.setMeta(`restore:boot:${bootId}`, now.toISOString());
	store.setMeta("restore:last", now.toISOString());
}

// Atomically claims this boot for automatic restore. Without a boot ID, allows one run per 10 minutes.
export function claimRestore(store: WorkStore, bootId: string | undefined, now: Date): boolean {
	return store.transaction(() => {
		if (bootId) {
			if (store.getMeta(`restore:boot:${bootId}`)) return false;
		} else {
			const last = store.getMeta("restore:last");
			if (last && now.getTime() - Date.parse(last) < RESTORE_FALLBACK_MS) return false;
		}
		markRestore(store, bootId, now);
		return true;
	});
}

export function runRestore(mode: RestoreMode, deps: RestoreDeps): RestoreReport {
	const { store } = deps;
	const now = store.clock();
	const panes = listPanes(deps.tmux);
	const { selected, skipped } = selectForRestore(probeSessions(store.listSessions(), panes, deps.readers), now, deps.fileExists);
	const steps = planRestore(selected, panes ?? [], deps.pi);
	const report: RestoreReport = { mode, ran: false, steps, placed: [], failed: [], skipped };
	if (mode === "dry-run") return report;
	if (!panes) return { ...report, reason: "tmux is not running" };
	const bootId = (deps.bootId ?? readBootId)();
	if (mode === "auto") {
		if (!claimRestore(store, bootId, now)) return { ...report, reason: "already restored since this boot" };
	} else {
		markRestore(store, bootId, now);
	}
	for (const session of selected) store.updateSession(session.id, { restoredFrom: session.pid });
	const result = executeRestore(steps, deps.tmux);
	return { ...report, ran: true, placed: result.placed, failed: result.failed };
}

export function reopenSession(
	store: WorkStore,
	session: ProbedSession,
	tmux: TmuxRunner,
	panes: readonly TmuxPane[],
	options: { fileExists?: (path: string) => boolean; pi?: string } = {},
): string {
	if (session.alive) throw new RestoreError(`Session is still running as pid ${session.pid}`);
	if (!session.file || !(options.fileExists ?? existsSync)(session.file)) throw new RestoreError("Session file is missing");
	const steps = planRestore([session], panes, options.pi);
	store.updateSession(session.id, { restoredFrom: session.pid });
	const result = executeRestore(steps, tmux);
	if (result.failed.length > 0) throw new RestoreError(result.failed[0].error);
	return result.placed[0].pane;
}

const sessionCount = (count: number): string => `${count} session${count === 1 ? "" : "s"}`;

export function describeStep(step: RestoreStep): string {
	switch (step.kind) {
		case "send":
			return `${step.sessionId}: type into shell pane ${step.pane}: ${step.command}`;
		case "split":
			return `${step.sessionId}: split window ${step.window.startsWith("new:") ? step.window.slice(4) : step.window}: ${step.command}`;
		case "window":
			return `${step.sessionId}: new window ${step.name} in ${step.cwd}: ${step.command}`;
	}
}

export function formatRestoreReport(report: RestoreReport): string {
	const lines: string[] = [];
	if (report.mode === "dry-run") {
		lines.push(report.steps.length ? `Would restore ${sessionCount(report.steps.length)}:` : "Nothing to restore");
		for (const step of report.steps) lines.push(`  ${describeStep(step)}`);
	} else if (!report.ran) {
		lines.push(`Restore skipped: ${report.reason ?? "unknown reason"}`);
	} else {
		lines.push(report.placed.length ? `Restored ${sessionCount(report.placed.length)}` : "Nothing to restore");
		for (const placed of report.placed) lines.push(`  ${placed.sessionId} in pane ${placed.pane}`);
	}
	for (const skip of report.skipped) lines.push(`Skipped ${skip.sessionId}: ${skip.reason}`);
	for (const failure of report.failed) lines.push(`Failed ${failure.sessionId}: ${failure.error}`);
	return lines.join("\n");
}
```

- [ ] **Step 4: Add the CLI command**

In `src/work/cli.ts`, add these imports:

```ts
import type { PidReaders } from "./liveness.ts";
import { formatRestoreReport, runRestore } from "./restore.ts";
import type { RestoreMode } from "./restore.ts";
import { tmuxRunner } from "./tmux.ts";
```

Extend `CliDeps` with:

```ts
	readers?: PidReaders;
	bootId?: () => string | undefined;
```

Add this command after `recap`:

```ts
const restoreCommand: CliCommand = {
	usage: "restore [--auto | --dry-run]         Reopen crashed Pi sessions in tmux",
	async run(args, deps) {
		const mode: RestoreMode = args.includes("--dry-run") ? "dry-run" : args.includes("--auto") ? "auto" : "manual";
		const rt = deps.runtime();
		const report = runRestore(mode, { store: rt.store, tmux: deps.tmux ?? tmuxRunner(), readers: deps.readers, bootId: deps.bootId });
		deps.io.out(formatRestoreReport(report));
		return 0;
	},
};
```

In `COMMANDS`, add `restore: restoreCommand,` after `recap,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/restore.test.mjs tests/work/cli.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/restore.ts src/work/cli.ts tests/work/restore.test.mjs
git commit -m "feat: restore crashed Pi sessions into tmux once per boot"
```

---

### Task 7: Shared keymap, Pi-free triage actions, and `/triage` on vim keys

**Files:**
- Create: `src/work/keymap.ts`, `src/work/triage-actions.ts`, `tests/work/fixtures/keymap-table.mjs`
- Modify: `src/work/triage.ts`: add `candidateSummary`
- Modify: `src/work/triage-ui.ts`: full rewrite below
- Modify: `tests/work/triage-ui.test.mjs`: replace the `triageKeyFor` test with the shared table
- Test: `tests/work/keymap.test.mjs`, `tests/work/triage-ui.test.mjs`

**Interfaces:**
- Consumes: existing triage actions in `triage.ts`, and the Jira helpers in `connectors/jira.ts`. `fuzzySelect` from `src/worktree/fuzzy-select.ts` (Pi side only). `parseKey` from `@earendil-works/pi-tui` (Pi side only).
- Produces:
  - `keymap.ts`: `Move`, `KeyAction`, `KeyState`, `KeymapOptions = { actions: readonly string[]; confirm?: readonly string[]; filter?: boolean }`, `INITIAL_KEY_STATE`, `normalizeKey(name)`, `decodeKey(data): string | undefined`, `splitKeys(data): string[]`, `keyStep(state, key, options): { state; action }`, `moveIndex(index, count, move, page): number`
  - `KeyAction` variants: `none`, `pending`, `move {move}`, `enter`, `close`, `action {key}`, `confirming {key}`, `confirmed {key}`, `cancelled {key}`, `filter {text, editing}`, and `match {direction: 1 | -1}`
  - `triage-actions.ts`: `TriageKey`, `TRIAGE_ACTIONS`, `TriageActionUi = { input; select; confirm; notify; pickItem(title, items): Promise<Item | undefined> }`, `runTriageAction(ui, runtime, key, candidate)`, `confirmAndPromote(ui, runtime, itemId)`
  - `triage.ts`: `candidateSummary(candidate): string`
  - `triage-ui.ts` keeps `TriageUiContext`, `triageList`, `handleTriageAction(ctx, …)`, `promoteWithConfirm(ctx, …)`, and `runTriageUi`, and adds `piTriageUi(ctx): TriageActionUi`. `triageKeyFor` is removed, since the keymap replaces it.

- [ ] **Step 1: Write the shared key table**

Create `tests/work/fixtures/keymap-table.mjs`:

```js
// Shared key table. tests/work/keymap.test.mjs runs every entry through the keymap with the dashboard options;
// tests/work/triage-ui.test.mjs runs NAVIGATION through the /triage list.
// `list` is the selected row after the keys, on a 20-row list with a 10-row page, starting at row 5.
export const NAVIGATION = [
  { name: 'j moves down', keys: ['j'], action: { type: 'move', move: 'down' }, list: 6 },
  { name: 'the down arrow is an alias for j', keys: ['\x1b[B'], action: { type: 'move', move: 'down' }, list: 6 },
  { name: 'k moves up', keys: ['k'], action: { type: 'move', move: 'up' }, list: 4 },
  { name: 'the up arrow is an alias for k', keys: ['\x1b[A'], action: { type: 'move', move: 'up' }, list: 4 },
  { name: 'gg goes to the first row', keys: ['g', 'g'], action: { type: 'move', move: 'top' }, list: 0 },
  { name: 'G goes to the last row', keys: ['G'], action: { type: 'move', move: 'bottom' }, list: 19 },
  { name: 'Ctrl-d moves half a page down', keys: ['\x04'], action: { type: 'move', move: 'half-down' }, list: 10 },
  { name: 'Ctrl-u moves half a page up', keys: ['\x15'], action: { type: 'move', move: 'half-up' }, list: 0 },
  { name: 'g then j drops the pending g and moves down', keys: ['g', 'j'], action: { type: 'move', move: 'down' }, list: 6 },
];

export const DASHBOARD = [
  { name: 'Tab goes to the next section', keys: ['\t'], action: { type: 'move', move: 'next-section' } },
  { name: '] goes to the next section', keys: [']'], action: { type: 'move', move: 'next-section' } },
  { name: 'Shift-Tab goes to the previous section', keys: ['\x1b[Z'], action: { type: 'move', move: 'prev-section' } },
  { name: '[ goes to the previous section', keys: ['['], action: { type: 'move', move: 'prev-section' } },
  { name: 'Enter activates the row', keys: ['\r'], action: { type: 'enter' } },
  { name: 'a first g is pending', keys: ['g'], action: { type: 'pending' } },
  { name: '/ starts a filter and typing extends it', keys: ['/', 'a', 'p'], action: { type: 'filter', text: 'ap', editing: true } },
  { name: 'Backspace edits the filter', keys: ['/', 'a', 'p', '\x7f'], action: { type: 'filter', text: 'a', editing: true } },
  { name: 'filter typing takes j and k as text', keys: ['/', 'j', 'k'], action: { type: 'filter', text: 'jk', editing: true } },
  { name: 'Enter keeps the filter and stops typing', keys: ['/', 'a', '\r'], action: { type: 'filter', text: 'a', editing: false } },
  { name: 'n goes to the next match', keys: ['/', 'a', '\r', 'n'], action: { type: 'match', direction: 1 } },
  { name: 'N goes to the previous match', keys: ['/', 'a', '\r', 'N'], action: { type: 'match', direction: -1 } },
  { name: 'Esc while typing clears the filter', keys: ['/', 'a', '\x1b'], action: { type: 'filter', text: '', editing: false } },
  { name: 'Esc clears a kept filter before it closes anything', keys: ['/', 'a', '\r', '\x1b'], action: { type: 'filter', text: '', editing: false } },
  { name: 'Esc closes', keys: ['\x1b'], action: { type: 'close' } },
  { name: 'q closes', keys: ['q'], action: { type: 'close' } },
  { name: 'n without a filter does nothing', keys: ['n'], action: { type: 'none' } },
  { name: 'L is an action', keys: ['L'], action: { type: 'action', key: 'L' } },
  { name: '? is an action', keys: ['?'], action: { type: 'action', key: '?' } },
  { name: 'D asks for confirmation', keys: ['D'], action: { type: 'confirming', key: 'D' } },
  { name: 'D then y is confirmed', keys: ['D', 'y'], action: { type: 'confirmed', key: 'D' } },
  { name: 'D then any other key is cancelled', keys: ['D', 'n'], action: { type: 'cancelled', key: 'D' } },
  { name: 'x then y is confirmed', keys: ['x', 'y'], action: { type: 'confirmed', key: 'x' } },
];

export const DASHBOARD_OPTIONS = { actions: ['L', 'c', 'x', 'D', 'R', '?'], confirm: ['x', 'D'], filter: true };
```

- [ ] **Step 2: Write the failing keymap tests**

Create `tests/work/keymap.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { DASHBOARD, DASHBOARD_OPTIONS, NAVIGATION } from './fixtures/keymap-table.mjs';

const keymap = await load('src/work/keymap.ts');

function run(keys, options) {
  let state = keymap.INITIAL_KEY_STATE;
  let action;
  for (const data of keys) ({ state, action } = keymap.keyStep(state, keymap.decodeKey(data), options));
  return action;
}

for (const entry of [...NAVIGATION, ...DASHBOARD]) {
  test(`keymap: ${entry.name}`, () => {
    assert.deepEqual(run(entry.keys, DASHBOARD_OPTIONS), entry.action);
  });
}

test('decodeKey names legacy sequences and splitKeys separates a burst of input', () => {
  assert.equal(keymap.decodeKey('\x1b[Z'), 'shift+tab');
  assert.equal(keymap.decodeKey('\x04'), 'ctrl+d');
  assert.equal(keymap.decodeKey('\x7f'), 'backspace');
  assert.equal(keymap.decodeKey('\r'), 'enter');
  assert.equal(keymap.decodeKey('é'), 'é');
  assert.equal(keymap.decodeKey('\x1b[99~'), undefined);
  assert.deepEqual(keymap.splitKeys('jj\x1b[Bk\x1bOA\x1b'), ['j', 'j', '\x1b[B', 'k', '\x1bOA', '\x1b']);
  assert.deepEqual(keymap.splitKeys('\x1b[1;5A'), ['\x1b[1;5A']);
});

test('normalizeKey maps Kitty-style names to keymap names', () => {
  assert.equal(keymap.normalizeKey('shift+g'), 'G');
  assert.equal(keymap.normalizeKey('space'), ' ');
  assert.equal(keymap.normalizeKey('j'), 'j');
});

test('action letters are not actions unless listed, and confirmation applies only to listed keys', () => {
  assert.deepEqual(run(['a'], { actions: ['a'] }), { type: 'action', key: 'a' });
  assert.deepEqual(run(['a'], { actions: [] }), { type: 'none' });
  assert.deepEqual(run(['/'], { actions: [] }), { type: 'none' });
  assert.deepEqual(run(['x'], { actions: ['x'] }), { type: 'action', key: 'x' });
});

test('moveIndex clamps to the list', () => {
  assert.equal(keymap.moveIndex(0, 3, 'up', 10), 0);
  assert.equal(keymap.moveIndex(2, 3, 'down', 10), 2);
  assert.equal(keymap.moveIndex(1, 30, 'half-down', 10), 6);
  assert.equal(keymap.moveIndex(0, 0, 'bottom', 10), 0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/work/keymap.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/keymap.ts`.

- [ ] **Step 4: Implement the keymap**

Create `src/work/keymap.ts`:

```ts
export type Move = "down" | "up" | "top" | "bottom" | "half-down" | "half-up" | "next-section" | "prev-section";
export type KeyAction =
	| { type: "none" }
	| { type: "pending" }
	| { type: "move"; move: Move }
	| { type: "enter" }
	| { type: "close" }
	| { type: "action"; key: string }
	| { type: "confirming"; key: string }
	| { type: "confirmed"; key: string }
	| { type: "cancelled"; key: string }
	| { type: "filter"; text: string; editing: boolean }
	| { type: "match"; direction: 1 | -1 };
export type KeyState = { pendingG: boolean; confirming: string | null; filter: string; editing: boolean };
export type KeymapOptions = { actions: readonly string[]; confirm?: readonly string[]; filter?: boolean };
type Step = { state: KeyState; action: KeyAction };

export const INITIAL_KEY_STATE: KeyState = { pendingG: false, confirming: null, filter: "", editing: false };

const MOVES: Record<string, Move> = {
	j: "down",
	down: "down",
	k: "up",
	up: "up",
	G: "bottom",
	home: "top",
	end: "bottom",
	"ctrl+d": "half-down",
	"ctrl+u": "half-up",
	pagedown: "half-down",
	pageup: "half-up",
	tab: "next-section",
	"]": "next-section",
	"shift+tab": "prev-section",
	"[": "prev-section",
};

const SEQUENCES: Record<string, string> = {
	"\r": "enter",
	"\n": "enter",
	"\t": "tab",
	"\x1b": "escape",
	"\x7f": "backspace",
	"\b": "backspace",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1b[Z": "shift+tab",
	"\x1b[H": "home",
	"\x1b[F": "end",
	"\x1b[1~": "home",
	"\x1b[4~": "end",
	"\x1b[5~": "pageup",
	"\x1b[6~": "pagedown",
	"\x1b[3~": "delete",
};

export function normalizeKey(name: string): string {
	const shifted = /^shift\+([a-z])$/.exec(name);
	if (shifted) return shifted[1].toUpperCase();
	if (name === "space") return " ";
	if (name === "return") return "enter";
	return name;
}

// Decodes one legacy terminal key sequence into the key names pi-tui's parseKey uses.
export function decodeKey(data: string): string | undefined {
	const known = SEQUENCES[data];
	if (known) return known;
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
	}
	if ([...data].length === 1 && data >= " ") return data;
	return undefined;
}

// Splits a chunk of raw input into single key sequences (CSI and SS3 escapes, or one code point).
export function splitKeys(data: string): string[] {
	const keys: string[] = [];
	let i = 0;
	while (i < data.length) {
		if (data[i] === "\x1b" && data[i + 1] === "[") {
			let j = i + 2;
			while (j < data.length && !/[@-~]/.test(data[j])) j++;
			keys.push(data.slice(i, j + 1));
			i = j + 1;
			continue;
		}
		if (data[i] === "\x1b" && data[i + 1] === "O" && i + 2 < data.length) {
			keys.push(data.slice(i, i + 3));
			i += 3;
			continue;
		}
		const char = String.fromCodePoint(data.codePointAt(i) as number);
		keys.push(char);
		i += char.length;
	}
	return keys;
}

function isText(key: string): boolean {
	return [...key].length === 1 && key >= " ";
}

function editFilter(state: KeyState, key: string): Step {
	if (key === "escape") return { state: { ...state, editing: false, filter: "" }, action: { type: "filter", text: "", editing: false } };
	if (key === "enter") return { state: { ...state, editing: false }, action: { type: "filter", text: state.filter, editing: false } };
	if (key === "backspace" || isText(key)) {
		const filter = key === "backspace" ? [...state.filter].slice(0, -1).join("") : state.filter + key;
		return { state: { ...state, filter }, action: { type: "filter", text: filter, editing: true } };
	}
	return { state, action: { type: "none" } };
}

export function keyStep(state: KeyState, rawKey: string, options: KeymapOptions): Step {
	const key = normalizeKey(rawKey);
	if (state.confirming) {
		const confirming = state.confirming;
		const next = { ...state, confirming: null };
		return { state: next, action: key === "y" ? { type: "confirmed", key: confirming } : { type: "cancelled", key: confirming } };
	}
	if (state.editing) return editFilter(state, key);
	if (state.pendingG) {
		const next = { ...state, pendingG: false };
		if (key === "g") return { state: next, action: { type: "move", move: "top" } };
		return keyStep(next, key, options);
	}
	if (key === "g") return { state: { ...state, pendingG: true }, action: { type: "pending" } };
	const move = MOVES[key];
	if (move) return { state, action: { type: "move", move } };
	if (key === "enter") return { state, action: { type: "enter" } };
	if (options.filter && key === "/") return { state: { ...state, editing: true, filter: "" }, action: { type: "filter", text: "", editing: true } };
	if (options.filter && state.filter && (key === "n" || key === "N")) return { state, action: { type: "match", direction: key === "n" ? 1 : -1 } };
	if (key === "escape") {
		if (state.filter) return { state: { ...state, filter: "" }, action: { type: "filter", text: "", editing: false } };
		return { state, action: { type: "close" } };
	}
	if (options.actions.includes(key)) {
		if (options.confirm?.includes(key)) return { state: { ...state, confirming: key }, action: { type: "confirming", key } };
		return { state, action: { type: "action", key } };
	}
	if (key === "q") return { state, action: { type: "close" } };
	return { state, action: { type: "none" } };
}

export function moveIndex(index: number, count: number, move: Move, page: number): number {
	if (count <= 0) return 0;
	const half = Math.max(1, Math.floor(page / 2));
	const targets: Record<Move, number> = {
		down: index + 1,
		up: index - 1,
		top: 0,
		bottom: count - 1,
		"half-down": index + half,
		"half-up": index - half,
		"next-section": index,
		"prev-section": index,
	};
	return Math.max(0, Math.min(count - 1, targets[move]));
}
```

Run: `node --test tests/work/keymap.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing `/triage` key tests**

In `tests/work/triage-ui.test.mjs`, add `import { NAVIGATION } from './fixtures/keymap-table.mjs';` after the helpers import. Delete the test named `'keys map to triage actions'`, and append:

```js
function listHarness(count) {
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: i + 1, kind: 'new-item', source: 'github', title: `Candidate ${i}`, reason: 'r', evidence: null, relatesTo: null, proposedProject: 'misc', payload: {},
  }));
  let component;
  const ctx = {
    ui: {
      custom: (factory) => new Promise((resolve) => {
        component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, null, resolve);
      }),
    },
  };
  const result = ui.triageList(ctx, candidates);
  return { press: (...keys) => { for (const key of keys) component.handleInput(key); }, result };
}

for (const entry of NAVIGATION) {
  test(`/triage keys: ${entry.name}`, async () => {
    const h = listHarness(20);
    h.press('j', 'j', 'j', 'j', 'j', ...entry.keys, '\r');
    const result = await h.result;
    assert.equal(result.key, 'enter');
    assert.equal(result.candidate.id, entry.list + 1);
  });
}

test('/triage keeps its action letters and closes with Esc or q', async () => {
  const accept = listHarness(3);
  accept.press('j', 'A');
  assert.deepEqual(await accept.result.then((r) => [r.key, r.candidate.id]), ['A', 2]);
  const esc = listHarness(3);
  esc.press('\x1b');
  assert.deepEqual(await esc.result, { type: 'cancel' });
  const q = listHarness(3);
  q.press('q');
  assert.deepEqual(await q.result, { type: 'cancel' });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test tests/work/triage-ui.test.mjs`
Expected: FAIL. `j` does not move the selection (arrows only), so the `list` rows do not match.

- [ ] **Step 7: Move triage actions into a Pi-free module**

In `src/work/triage.ts`, add after `candidateLabel`:

```ts
export function candidateSummary(candidate: Candidate): string {
	const target = candidate.relatesTo ? `→ ${candidate.relatesTo}` : candidate.kind === "new-item" ? `#${candidate.proposedProject ?? "misc"}` : "";
	return [target, candidate.reason, candidate.evidence ?? ""].filter(Boolean).join(" · ");
}
```

Create `src/work/triage-actions.ts`:

```ts
import { applyJiraUpdate, formatPreview, promoteItem, promotionPreview } from "./connectors/jira.ts";
import type { Runtime } from "./runtime.ts";
import {
	acceptAllFromSource,
	acceptCandidate,
	candidateDetails,
	dismissCandidate,
	mergeCandidate,
	snoozeCandidate,
	TriageError,
} from "./triage.ts";
import type { Candidate, Item } from "./types.ts";
import { OPEN_ITEM_STATUSES } from "./types.ts";

export type TriageKey = "a" | "m" | "d" | "z" | "A" | "p" | "enter";
export const TRIAGE_ACTIONS: readonly string[] = ["a", "m", "d", "z", "A", "p"];

// The UI surface triage actions need. Pi's /triage and the dashboard's triage view each implement it.
export type TriageActionUi = {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	pickItem(title: string, items: Item[]): Promise<Item | undefined>;
};

export async function confirmAndPromote(ui: TriageActionUi, runtime: Runtime, itemId: string): Promise<void> {
	if (!runtime.jira) throw new TriageError("Jira is not configured");
	const preview = promotionPreview(runtime.store, itemId, runtime.jira.config);
	if (!(await ui.confirm(`Create Jira ${preview.issueType} for ${itemId}?`, formatPreview(preview)))) return;
	const link = await promoteItem(runtime.store, itemId, runtime.jira);
	ui.notify(`Created ${link.key.slice("jira:".length)} for ${itemId}`, "info");
}

async function applyUpdate(ui: TriageActionUi, runtime: Runtime, candidate: Candidate): Promise<void> {
	if (!runtime.jira) throw new TriageError("Jira is not configured");
	if (!(await ui.confirm("Apply Jira update?", candidateDetails(candidate)))) return;
	const result = await applyJiraUpdate(runtime.store, candidate.id, runtime.jira, async (options) => {
		const labels = options.map((option) => `${option.name} (${option.category})`);
		const choice = await ui.select(`Transition for ${String(candidate.payload.ticket)}`, labels);
		return options[labels.indexOf(choice ?? "")];
	});
	ui.notify(result === "applied" ? `Updated ${String(candidate.payload.ticket)}` : "Cancelled", "info");
}

export async function runTriageAction(ui: TriageActionUi, runtime: Runtime, key: TriageKey, candidate: Candidate): Promise<void> {
	const { store } = runtime;
	const isJira = candidate.kind === "jira-update";
	switch (key) {
		case "enter":
			ui.notify(candidateDetails(candidate), "info");
			return;
		case "d":
			dismissCandidate(store, candidate.id);
			return;
		case "z": {
			const days = await ui.input("Snooze for how many days?", "3");
			if (days === undefined) return;
			snoozeCandidate(store, candidate.id, days.trim() ? Number(days) : 3);
			return;
		}
		case "A": {
			if (isJira) throw new TriageError("Jira updates can't be bulk accepted");
			ui.notify(`Accepted ${acceptAllFromSource(store, candidate.source).length} from ${candidate.source}`, "info");
			return;
		}
		case "m": {
			if (isJira) throw new TriageError("Jira updates can't be merged");
			const target = await ui.pickItem("Merge into item", store.listItems({ statuses: OPEN_ITEM_STATUSES }));
			if (target) mergeCandidate(store, candidate.id, target.id);
			return;
		}
		case "a":
		case "p": {
			if (isJira) {
				if (key === "p") throw new TriageError("Use a to apply a Jira update");
				await applyUpdate(ui, runtime, candidate);
				return;
			}
			let edits: { title?: string; project?: string } = {};
			if (candidate.kind === "new-item") {
				const title = await ui.input("Title (empty keeps it)", candidate.title);
				if (title === undefined) return;
				const proposed = candidate.proposedProject ?? "misc";
				const project = await ui.select("Project", [proposed, ...[...runtime.knownProjects()].filter((slug) => slug !== proposed).sort()]);
				if (!project) return;
				edits = { title: title.trim() || undefined, project };
			}
			const item = acceptCandidate(store, candidate.id, edits);
			if (key === "p") await confirmAndPromote(ui, runtime, item.id);
			return;
		}
	}
}
```

- [ ] **Step 8: Rewrite the Pi triage view on the keymap**

Replace `src/work/triage-ui.ts` with:

```ts
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { fuzzySelect } from "../worktree/fuzzy-select.ts";
import type { KeyState } from "./keymap.ts";
import { INITIAL_KEY_STATE, keyStep, moveIndex } from "./keymap.ts";
import type { Runtime } from "./runtime.ts";
import { errorMessage } from "./secrets.ts";
import type { TriageActionUi, TriageKey } from "./triage-actions.ts";
import { confirmAndPromote, runTriageAction, TRIAGE_ACTIONS } from "./triage-actions.ts";
import { candidateLabel, candidateSummary, openCandidates } from "./triage.ts";
import type { Candidate } from "./types.ts";

export type { TriageKey } from "./triage-actions.ts";
export type TriageUiContext = {
	ui: {
		custom: <T>(factory: (tui: { requestRender: () => void }, theme: any, keybindings: unknown, done: (value: T) => void) => any) => Promise<T>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
	};
};
type ListResult = { type: "action"; key: TriageKey; candidate: Candidate } | { type: "cancel" };

const WINDOW = 10;
const HINTS = "j/k move • gg/G first/last • ^d/^u half page • a accept/apply • m merge • d dismiss • z snooze • A all from source • p accept+promote • enter details • esc close";

export function triageList(ctx: TriageUiContext, candidates: Candidate[]): Promise<ListResult> {
	return ctx.ui.custom<ListResult>((tui, theme, _keybindings, done) => {
		let selected = 0;
		let keys: KeyState = INITIAL_KEY_STATE;
		return {
			invalidate() {},
			render(width: number): string[] {
				const border = new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "";
				const lines = [border, truncateToWidth(theme.fg("accent", theme.bold(`Work triage (${candidates.length} open)`)), width), ""];
				const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), candidates.length - WINDOW));
				for (let i = start; i < Math.min(candidates.length, start + WINDOW); i++) {
					const label = candidateLabel(candidates[i]);
					const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
					lines.push(truncateToWidth(prefix + (i === selected ? theme.fg("accent", label) : label), width));
					lines.push(truncateToWidth(`    ${theme.fg("muted", candidateSummary(candidates[i]))}`, width));
				}
				lines.push("", truncateToWidth(theme.fg("dim", HINTS), width), border);
				return lines;
			},
			handleInput(data: string): void {
				const name = parseKey(data);
				if (!name) return;
				const step = keyStep(keys, name, { actions: TRIAGE_ACTIONS });
				keys = step.state;
				const { action } = step;
				if (action.type === "close") {
					done({ type: "cancel" });
					return;
				}
				if (action.type === "enter" || action.type === "action") {
					done({ type: "action", key: action.type === "enter" ? "enter" : (action.key as TriageKey), candidate: candidates[selected] });
					return;
				}
				if (action.type === "move") selected = moveIndex(selected, candidates.length, action.move, WINDOW);
				tui.requestRender();
			},
		};
	});
}

export function piTriageUi(ctx: TriageUiContext): TriageActionUi {
	return {
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		notify: (message, level) => ctx.ui.notify(message, level),
		pickItem: (title, items) => fuzzySelect(ctx, {
			title,
			items,
			getLabel: (item) => `${item.id} ${item.title}`,
			getDescription: (item) => `#${item.project} · ${item.status}`,
			getSearchText: (item) => `${item.id} ${item.title} ${item.project}`,
		}),
	};
}

export async function promoteWithConfirm(ctx: TriageUiContext, runtime: Runtime, itemId: string): Promise<void> {
	await confirmAndPromote(piTriageUi(ctx), runtime, itemId);
}

export async function handleTriageAction(ctx: TriageUiContext, runtime: Runtime, key: TriageKey, candidate: Candidate): Promise<void> {
	await runTriageAction(piTriageUi(ctx), runtime, key, candidate);
}

export async function runTriageUi(ctx: TriageUiContext, runtime: Runtime): Promise<void> {
	for (;;) {
		const open = openCandidates(runtime.store);
		if (open.length === 0) {
			ctx.ui.notify("Triage inbox is empty", "info");
			return;
		}
		const result = await triageList(ctx, open);
		if (result.type === "cancel") return;
		try {
			await handleTriageAction(ctx, runtime, result.key, result.candidate);
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
		}
	}
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test tests/work/keymap.test.mjs tests/work/triage-ui.test.mjs tests/work/triage.test.mjs tests/work/extension.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

Run: `npm test`
Expected: PASS. The production install test still loads `extensions/work.ts`.

- [ ] **Step 10: Commit**

```bash
git add src/work/keymap.ts src/work/triage-actions.ts src/work/triage.ts src/work/triage-ui.ts tests/work/fixtures/keymap-table.mjs tests/work/keymap.test.mjs tests/work/triage-ui.test.mjs
git commit -m "feat: add the shared vim keymap and move /triage onto it"
```

---

### Task 8: Dashboard text, terminal, and widgets

**Files:**
- Create: `src/worktree/fuzzy-filter.ts`, `src/work/dash/text.ts`, `src/work/dash/terminal.ts`, `src/work/dash/widgets.ts`
- Modify: `src/worktree/fuzzy-select.ts`: import and re-export the moved fuzzy filter
- Test: `tests/work/dash-widgets.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `fuzzy-filter.ts`: `FuzzyFilterOptions<T>` and `fuzzyFilter(items, query, options)`. These move unchanged from `fuzzy-select.ts`, which re-exports both, so existing callers and tests keep working.
  - `text.ts`: `Style = { bold; dim; inverse; color(name, s) }`, `plainStyle`, `ansiStyle`, `stripAnsi`, `visibleWidth`, `truncate(value, width)` (adds `…`), `fit(value, width)` (truncate and pad), `sanitize(value)` (control characters become spaces), `oneLine(value)` (sanitize, collapse whitespace, trim), `formatAge(ms)` (`45s`, `12m`, `3h`, `2d`; hours up to 47)
  - `terminal.ts`: `Terminal = { columns(); rows(); write(data); onInput(handler); onResize(handler); start(); stop() }`, `processTerminal(input?, output?)`, `frame(lines): string`
  - `widgets.ts`: `Modal = { handle(key: string): void; lines(width, height, style): string[] }`, `textPrompt(title, placeholder, resolve)`, `selectList(title, options, resolve)`, `confirmBox(title, message, resolve)`, `messageBox(title, text, resolve, options?: { atEnd?: boolean })`, `fuzzyPicker(title, items, label, resolve)`. Keys are keymap names (`decodeKey` output).

- [ ] **Step 1: Write the failing tests**

Create `tests/work/dash-widgets.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const text = await load('src/work/dash/text.ts');
const w = await load('src/work/dash/widgets.ts');
const { frame } = await load('src/work/dash/terminal.ts');
const { plainStyle } = text;

function drive(make, keys) {
  let result = 'pending';
  const modal = make((value) => { result = value; });
  for (const key of keys) modal.handle(key);
  return { get result() { return result; }, modal };
}

test('widths ignore ANSI codes and count wide characters twice', () => {
  assert.equal(text.visibleWidth('\x1b[1mab\x1b[22m'), 2);
  assert.equal(text.visibleWidth('日本'), 4);
  assert.equal(text.stripAnsi(text.ansiStyle.inverse('x')), 'x');
});

test('truncate adds an ellipsis and fit pads to the width', () => {
  assert.equal(text.truncate('abcdef', 4), 'abc…');
  assert.equal(text.truncate('abc', 4), 'abc');
  assert.equal(text.truncate('abc', 0), '');
  assert.equal(text.truncate('日本語', 5), '日本…');
  assert.equal(text.fit('ab', 4), 'ab  ');
  assert.equal(text.fit('abcdef', 4), 'abc…');
});

test('sanitize and oneLine remove control characters, including escape sequences from external text', () => {
  assert.equal(text.sanitize('  a\x1b[2Jb'), '  a [2Jb');
  assert.equal(text.oneLine(' a\nb\tc\x1b[2Jd '), 'a b c [2Jd');
});

test('formatAge picks the largest sensible unit', () => {
  assert.equal(text.formatAge(45_000), '45s');
  assert.equal(text.formatAge(12 * 60_000), '12m');
  assert.equal(text.formatAge(3 * 3_600_000), '3h');
  assert.equal(text.formatAge(47 * 3_600_000), '47h');
  assert.equal(text.formatAge(5 * 86_400_000), '5d');
  assert.equal(text.formatAge(-5), '0s');
});

test('frame homes the cursor, clears each line end, and clears below', () => {
  assert.equal(frame(['a', 'b']), '\x1b[Ha\x1b[K\r\nb\x1b[K\x1b[J');
});

test('textPrompt edits, accepts, and cancels', () => {
  assert.equal(drive((r) => w.textPrompt('Title', 'keep', r), ['a', 'b', 'backspace', 'c', 'enter']).result, 'ac');
  assert.equal(drive((r) => w.textPrompt('Title', 'keep', r), ['enter']).result, '');
  assert.equal(drive((r) => w.textPrompt('Title', 'keep', r), ['a', 'escape']).result, undefined);
  const { modal } = drive((r) => w.textPrompt('Snooze days?', '3', r), []);
  assert.deepEqual(modal.lines(40, 10, plainStyle), ['Snooze days?', '> 3', 'enter accept · esc cancel']);
});

test('selectList moves with j and k and selects with Enter', () => {
  assert.equal(drive((r) => w.selectList('Project', ['misc', 'payments', 'web'], r), ['j', 'j', 'j', 'k', 'enter']).result, 'payments');
  assert.equal(drive((r) => w.selectList('Project', ['misc'], r), ['escape']).result, undefined);
  const { modal } = drive((r) => w.selectList('Project', ['misc', 'payments'], r), ['j']);
  assert.deepEqual(modal.lines(12, 10, plainStyle), ['Project', '  misc', '> payments  ']);
});

test('confirmBox accepts only y', () => {
  assert.equal(drive((r) => w.confirmBox('Delete?', 'x', r), ['y']).result, true);
  assert.equal(drive((r) => w.confirmBox('Delete?', 'x', r), ['n']).result, false);
  assert.equal(drive((r) => w.confirmBox('Delete?', 'x', r), ['j']).result, 'pending');
});

test('fuzzyPicker filters as you type and picks the highlighted item', () => {
  const items = [{ id: 'W-1', title: 'Fix flaky test' }, { id: 'W-2', title: 'Write docs' }, { id: 'W-3', title: 'Fix login' }];
  const label = (item) => `${item.id} ${item.title}`;
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['f', 'i', 'x', 'enter']).result.id, 'W-3');
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['f', 'i', 'x', 'down', 'enter']).result.id, 'W-1');
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['z', 'z', 'enter']).result, undefined);
  assert.equal(drive((r) => w.fuzzyPicker('Link', items, label, r), ['escape']).result, undefined);
  const { modal } = drive((r) => w.fuzzyPicker('Link', items, label, r), ['d', 'o', 'c']);
  assert.deepEqual(modal.lines(30, 10, plainStyle).map((line) => line.trimEnd()), ['Link', '/ doc', '> W-2 Write docs', 'type to filter · ↑/↓ move · e…']);
});

test('messageBox scrolls with j and k, keeps indentation, and closes on any other key', () => {
  const body = Array.from({ length: 10 }, (_, i) => `  line ${i}`).join('\n');
  const box = drive((r) => w.messageBox('Details', body, r), ['j', 'j']);
  assert.equal(box.result, 'pending');
  assert.deepEqual(box.modal.lines(20, 5, plainStyle).slice(0, 3), ['Details', '  line 2', '  line 3']);
  box.modal.handle('x');
  assert.equal(box.result, undefined);
  const tail = drive((r) => w.messageBox('Transcript', body, r, { atEnd: true }), []);
  assert.deepEqual(tail.modal.lines(20, 5, plainStyle).slice(1, 4), ['  line 7', '  line 8', '  line 9']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/dash-widgets.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/dash/text.ts`.

- [ ] **Step 3: Move the fuzzy filter into a Pi-free module**

Create `src/worktree/fuzzy-filter.ts`. It contains the `FuzzyFilterOptions` type, `fuzzyScore`, and `fuzzyFilter`, moved verbatim from `src/worktree/fuzzy-select.ts`:

```ts
export type FuzzyFilterOptions<T> = {
	getSearchText: (item: T) => string;
	limit?: number;
};

function fuzzyScore(text: string, query: string): number | undefined {
	const normalizedText = text.toLowerCase();
	const normalizedQuery = query.toLowerCase().trim();
	if (!normalizedQuery) return 0;

	let lastIndex = -1;
	let firstIndex = -1;
	let score = 0;
	for (const char of normalizedQuery) {
		const index = normalizedText.indexOf(char, lastIndex + 1);
		if (index === -1) return undefined;
		if (firstIndex === -1) firstIndex = index;
		const gap = index - lastIndex - 1;
		score += gap;
		lastIndex = index;
	}

	return score + firstIndex * 0.1 + normalizedText.length * 0.001;
}

export function fuzzyFilter<T>(items: T[], query: string, options: FuzzyFilterOptions<T>): T[] {
	const limit = options.limit ?? 10;
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return items.slice(0, limit);

	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(options.getSearchText(item), normalizedQuery) }))
		.filter((entry): entry is { item: T; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.item);
}
```

In `src/worktree/fuzzy-select.ts`, delete the `FuzzyFilterOptions` type and the `fuzzyScore` and `fuzzyFilter` functions. Directly after the `@earendil-works/pi-tui` import, add:

```ts
import type { FuzzyFilterOptions } from "./fuzzy-filter.ts";
import { fuzzyFilter } from "./fuzzy-filter.ts";

export type { FuzzyFilterOptions } from "./fuzzy-filter.ts";
export { fuzzyFilter } from "./fuzzy-filter.ts";
```

Run: `node --test tests/worktree/*.test.mjs tests/claude-bridge/*.test.mjs`
Expected: PASS, unchanged.

- [ ] **Step 4: Implement the text helpers**

Create `src/work/dash/text.ts`:

```ts
export type Color = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";
export type Style = {
	bold(value: string): string;
	dim(value: string): string;
	inverse(value: string): string;
	color(name: Color, value: string): string;
};

export const plainStyle: Style = { bold: (v) => v, dim: (v) => v, inverse: (v) => v, color: (_name, v) => v };

const CODES: Record<Color, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 };

export const ansiStyle: Style = {
	bold: (v) => `\x1b[1m${v}\x1b[22m`,
	dim: (v) => `\x1b[2m${v}\x1b[22m`,
	inverse: (v) => `\x1b[7m${v}\x1b[27m`,
	color: (name, v) => `\x1b[${CODES[name]}m${v}\x1b[39m`,
};

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}]/u;
const COMBINING = /\p{Mn}/u;

export function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code < 32 || (code >= 0x7f && code < 0xa0) || COMBINING.test(char)) return 0;
	return WIDE.test(char) ? 2 : 1;
}

export function visibleWidth(value: string): number {
	let width = 0;
	for (const char of stripAnsi(value)) width += charWidth(char);
	return width;
}

// Plain text only: styles are applied after truncation.
export function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	let out = "";
	let used = 0;
	for (const char of value) {
		const w = charWidth(char);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

export function fit(value: string, width: number): string {
	const cut = truncate(value, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

// External text (notes, titles, transcripts, command output) must never reach the terminal raw.
export function sanitize(value: string): string {
	return value.replace(CONTROL, " ");
}

export function oneLine(value: string): string {
	return sanitize(value).replace(/\s+/g, " ").trim();
}

export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
```

- [ ] **Step 5: Implement the terminal wrapper**

Create `src/work/dash/terminal.ts`:

```ts
export type Terminal = {
	columns(): number;
	rows(): number;
	write(data: string): void;
	onInput(handler: (data: string) => void): void;
	onResize(handler: () => void): void;
	start(): void;
	stop(): void;
};

export function frame(lines: readonly string[]): string {
	return `\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
}

export function processTerminal(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Terminal {
	let inputHandler: (data: string) => void = () => {};
	let resizeHandler: () => void = () => {};
	const onData = (chunk: Buffer | string): void => inputHandler(chunk.toString());
	const onResize = (): void => resizeHandler();
	return {
		columns: () => output.columns || 80,
		rows: () => output.rows || 24,
		write: (data) => {
			output.write(data);
		},
		onInput: (handler) => {
			inputHandler = handler;
		},
		onResize: (handler) => {
			resizeHandler = handler;
		},
		start() {
			if (!input.isTTY || !output.isTTY) throw new Error("work dash needs an interactive terminal");
			input.setRawMode(true);
			input.resume();
			input.on("data", onData);
			output.on("resize", onResize);
			output.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
		},
		stop() {
			input.off("data", onData);
			output.off("resize", onResize);
			output.write("\x1b[?25h\x1b[?1049l");
			if (input.isTTY) input.setRawMode(false);
			input.pause();
		},
	};
}
```

- [ ] **Step 6: Implement the widgets**

Create `src/work/dash/widgets.ts`:

```ts
import { fuzzyFilter } from "../../worktree/fuzzy-filter.ts";
import type { Style } from "./text.ts";
import { fit, oneLine, sanitize, truncate } from "./text.ts";

// A modal owns all keys until it calls its resolve function. Keys are keymap names (decodeKey output).
export type Modal = { handle(key: string): void; lines(width: number, height: number, style: Style): string[] };

const isText = (key: string): boolean => [...key].length === 1 && key >= " ";
const dropLast = (value: string): string => [...value].slice(0, -1).join("");

function row(label: string, selected: boolean, width: number, style: Style): string {
	return selected ? style.inverse(fit(`> ${oneLine(label)}`, width)) : truncate(`  ${oneLine(label)}`, width);
}

export function textPrompt(title: string, placeholder: string, resolve: (value: string | undefined) => void): Modal {
	let value = "";
	return {
		handle(key) {
			if (key === "enter") resolve(value);
			else if (key === "escape") resolve(undefined);
			else if (key === "backspace") value = dropLast(value);
			else if (isText(key)) value += key;
		},
		lines(width, _height, style) {
			const input = value ? truncate(`> ${sanitize(value)}`, width) : `> ${style.dim(truncate(oneLine(placeholder), Math.max(0, width - 2)))}`;
			return [style.bold(truncate(oneLine(title), width)), input, style.dim(truncate("enter accept · esc cancel", width))];
		},
	};
}

export function selectList(title: string, options: readonly string[], resolve: (value: string | undefined) => void): Modal {
	let index = 0;
	return {
		handle(key) {
			if (key === "enter") resolve(options[index]);
			else if (key === "escape" || key === "q") resolve(undefined);
			else if (key === "j" || key === "down") index = Math.min(options.length - 1, index + 1);
			else if (key === "k" || key === "up") index = Math.max(0, index - 1);
		},
		lines(width, height, style) {
			const visible = Math.max(1, height - 1);
			const start = Math.max(0, index - visible + 1);
			const rows = options.slice(start, start + visible).map((option, i) => row(option, start + i === index, width, style));
			return [style.bold(truncate(oneLine(title), width)), ...rows];
		},
	};
}

export function confirmBox(title: string, message: string, resolve: (value: boolean) => void): Modal {
	return {
		handle(key) {
			if (key === "y") resolve(true);
			else if (key === "n" || key === "escape" || key === "q") resolve(false);
		},
		lines(width, height, style) {
			const body = message.split("\n").slice(0, Math.max(0, height - 2)).map((line) => truncate(sanitize(line), width));
			return [style.bold(truncate(oneLine(title), width)), ...body, style.dim(truncate("y confirm · n cancel", width))];
		},
	};
}

export function messageBox(title: string, text: string, resolve: () => void, options: { atEnd?: boolean } = {}): Modal {
	const all = text.split("\n");
	let offset = options.atEnd ? Number.MAX_SAFE_INTEGER : 0;
	return {
		handle(key) {
			if (key === "j" || key === "down") offset += 1;
			else if (key === "k" || key === "up") offset = Math.max(0, offset - 1);
			else resolve();
		},
		lines(width, height, style) {
			const visible = Math.max(1, height - 2);
			offset = Math.max(0, Math.min(offset, all.length - visible));
			const body = all.slice(offset, offset + visible).map((line) => truncate(sanitize(line), width));
			return [style.bold(truncate(oneLine(title), width)), ...body, style.dim(truncate("j/k scroll · any other key closes", width))];
		},
	};
}

export function fuzzyPicker<T>(title: string, items: readonly T[], label: (item: T) => string, resolve: (value: T | undefined) => void): Modal {
	let query = "";
	let index = 0;
	const matches = (): T[] => fuzzyFilter([...items], query, { getSearchText: label, limit: items.length });
	return {
		handle(key) {
			if (key === "enter") {
				resolve(matches()[index]);
				return;
			}
			if (key === "escape") {
				resolve(undefined);
				return;
			}
			if (key === "down" || key === "ctrl+n") index += 1;
			else if (key === "up" || key === "ctrl+p") index = Math.max(0, index - 1);
			else if (key === "backspace") {
				query = dropLast(query);
				index = 0;
			} else if (isText(key)) {
				query += key;
				index = 0;
			}
			index = Math.min(index, Math.max(0, matches().length - 1));
		},
		lines(width, height, style) {
			const visible = Math.max(1, height - 3);
			const list = matches();
			const start = Math.max(0, index - visible + 1);
			const rows = list.slice(start, start + visible).map((item, i) => row(label(item), start + i === index, width, style));
			return [
				style.bold(truncate(oneLine(title), width)),
				truncate(`/ ${sanitize(query)}`, width),
				...(rows.length ? rows : [style.dim("  no matches")]),
				style.dim(truncate("type to filter · ↑/↓ move · enter select · esc cancel", width)),
			];
		},
	};
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test tests/work/dash-widgets.test.mjs tests/worktree/*.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/worktree/fuzzy-filter.ts src/worktree/fuzzy-select.ts src/work/dash tests/work/dash-widgets.test.mjs
git commit -m "feat: add the dashboard renderer primitives and widgets"
```

---

### Task 9: Dashboard model and view

**Files:**
- Create: `src/work/dash/model.ts`, `src/work/dash/view.ts`
- Test: `tests/work/dash-view.test.mjs`

**Interfaces:**
- Consumes: `probeSessions`, `ProbedSession`, `PidReaders` (Task 2). `store.listSessions`, `sessionLink`, `getItem`. The text helpers (Task 8).
- Produces:
  - `model.ts`: `SectionId`, `SessionEntry = ProbedSession & { itemId: string | null; itemTitle: string | null }`, `DashRow = { kind: "session"; key: "session:<id>"; session; depth: 0 | 1 } | { kind: "triage"; key: "triage"; count }`, `DashSection = { id; title; rows }`, `DashModel = { sections; now }`, `RECENT_MS`, `lastActivity(session)`, `loadSessions(store, panes, readers?): SessionEntry[]`, `buildDashModel({ sessions, triageCount, now }): DashModel`, `allRows(model): DashRow[]`
  - `view.ts`: `ViewState = { selected: string | null; filter: string; editing: boolean; message: string }`, `HINTS`, `sessionLabel(session)`, `rowCells(row, now, wide)`, `rowMatches(row, filter, now)`, `filterModel(model, filter)`, `renderDash(model, state, width, height, style): string[]`

Layout rules, from the spec and decision 11:
- Decisions: live top-level `needs-me` sessions, oldest `status_at` first, then the triage line when candidates are pending.
- Waiting: live top-level `waiting-external` sessions. Working: live top-level `working` sessions.
- Other sessions: live top-level `done` sessions (newest first), then closed and crashed top-level sessions from the last 7 days (most recent activity first), then orphaned children.
- Each top-level row is followed by its children (sessions whose `parentSession` is that row's ID) that are live or active in the last 7 days, oldest first, at depth 1. Children never appear on their own in Decisions, Waiting, or Working.
- Section counts include only depth-0 rows. Empty sections are a single header line.
- The label column is 9 characters wide, and columns are separated by 2 spaces. Window, item, and age widths are the widest session cell, capped at 16, 6, and 4 characters (28, 40, and 4 at 120 columns and wider). At 120 columns and wider, the item cell includes the item title. Children show their session name (or `child <id>`) in the window column and the time since their last turn. Top-level live rows show the time since `status_at`, and ended rows the time since their last activity.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/dash-view.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { buildDashModel, loadSessions } = await load('src/work/dash/model.ts');
const { renderDash, HINTS } = await load('src/work/dash/view.ts');
const { plainStyle, ansiStyle } = await load('src/work/dash/text.ts');

const NOW = new Date('2026-09-25T09:00:00.000Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const entry = (overrides) => ({
  id: 'x', file: null, cwd: '/src/x', name: null, pid: 1, tmuxPane: '%1', tmuxWindow: null, startedAt: ago(600), lastTurnAt: null, endedAt: null,
  status: 'working', note: '', statusSource: 'auto', statusAt: ago(0), restoredFrom: null, parentSession: null, headless: false,
  liveness: 'live', alive: true, itemId: null, itemTitle: null, ...overrides,
});
const SESSIONS = [
  entry({ id: 'd1', tmuxWindow: 'sap-rfc', status: 'needs-me', statusAt: ago(12), note: 'Trim the overview to 1.5k words?', itemId: 'W-7', itemTitle: 'SAP RFC connector overview' }),
  entry({ id: 'c1', parentSession: 'd1', headless: true, tmuxPane: null, name: 'impl-auth', status: 'needs-me', statusAt: ago(3), lastTurnAt: ago(3), note: 'Which test runner?' }),
  entry({ id: 'd2', tmuxWindow: 'payments-api', status: 'needs-me', statusAt: ago(2), name: 'Fix flaky test' }),
  entry({ id: 'w1', tmuxWindow: 'web', status: 'waiting-external', statusAt: ago(180), note: 'CI run for PR 42', itemId: 'W-3', itemTitle: 'Launch checklist' }),
  entry({ id: 'o1', tmuxWindow: 'docs', status: 'done', statusAt: ago(120), note: 'Published the guide', itemId: 'W-2', itemTitle: 'Docs refresh' }),
  entry({ id: 'o2', tmuxWindow: 'infra', status: 'needs-me', liveness: 'crashed', alive: false, lastTurnAt: ago(1440), note: 'Which region first?' }),
  entry({ id: 'o3', cwd: '/src/old-tool', liveness: 'closed', alive: false, endedAt: ago(7200), lastTurnAt: ago(7200) }),
  entry({ id: 'o4', tmuxWindow: 'ancient', liveness: 'closed', alive: false, endedAt: ago(11520), lastTurnAt: ago(11520) }),
];
const model = () => buildDashModel({ sessions: SESSIONS, triageCount: 3, now: NOW });
const state = (overrides = {}) => ({ selected: 'session:d1', filter: '', editing: false, message: '', ...overrides });
const plain = (lines) => lines.map((line) => line.trimEnd());

test('sections order sessions, nest children under their parent, and drop old ended sessions', () => {
  const m = model();
  assert.deepEqual(m.sections.map((s) => s.id), ['decisions', 'waiting', 'working', 'other']);
  assert.deepEqual(m.sections[0].rows.map((r) => r.key), ['session:d1', 'session:c1', 'session:d2', 'triage']);
  assert.equal(m.sections[0].rows[1].depth, 1);
  assert.deepEqual(m.sections[1].rows.map((r) => r.key), ['session:w1']);
  assert.deepEqual(m.sections[2].rows, []);
  assert.deepEqual(m.sections[3].rows.map((r) => r.key), ['session:o1', 'session:o2', 'session:o3']);
  assert.equal(buildDashModel({ sessions: SESSIONS, triageCount: 0, now: NOW }).sections[0].rows.some((r) => r.kind === 'triage'), false);
});

test('a child follows its parent into any section, and an orphaned child is listed under Other sessions', () => {
  const m = buildDashModel({
    now: NOW,
    triageCount: 0,
    sessions: [
      entry({ id: 'p', tmuxWindow: 'api', status: 'waiting-external' }),
      entry({ id: 'k', parentSession: 'p', headless: true, tmuxPane: null, status: 'needs-me' }),
      entry({ id: 'lost', parentSession: 'gone', headless: true, tmuxPane: null, status: 'needs-me' }),
    ],
  });
  assert.deepEqual(m.sections[0].rows, []);
  assert.deepEqual(m.sections[1].rows.map((r) => [r.key, r.depth]), [['session:p', 0], ['session:k', 1]]);
  assert.deepEqual(m.sections[3].rows.map((r) => [r.key, r.depth]), [['session:lost', 0]]);
});

test('an 80-column frame', () => {
  assert.deepEqual(plain(renderDash(model(), state(), 80, 24, plainStyle)), [
    'Work dashboard',
    'Decisions (3)',
    '> needs-me   sap-rfc       W-7  12m  "Trim the overview to 1.5k words?"',
    '    needs-me   impl-auth     -     3m  "Which test runner?"',
    '  needs-me   payments-api  -     2m  Fix flaky test',
    '  triage     3 pending candidates',
    'Waiting (1)',
    '  waiting    web           W-3   3h  "CI run for PR 42"',
    'Working (0)',
    'Other sessions (3)',
    '  done       docs          W-2   2h  "Published the guide"',
    '  crashed    infra         -    24h  "Which region first?"',
    '  closed     old-tool      -     5d',
    HINTS,
    '',
  ]);
  assert.equal(HINTS, 'j/k move · enter open · L link · D delete · / filter · ? help · q quit');
});

test('a 160-column frame shows item titles', () => {
  assert.deepEqual(plain(renderDash(model(), state(), 160, 24, plainStyle)), [
    'Work dashboard',
    'Decisions (3)',
    '> needs-me   sap-rfc       W-7 SAP RFC connector overview  12m  "Trim the overview to 1.5k words?"',
    '    needs-me   impl-auth     -                                3m  "Which test runner?"',
    '  needs-me   payments-api  -                                2m  Fix flaky test',
    '  triage     3 pending candidates',
    'Waiting (1)',
    '  waiting    web           W-3 Launch checklist             3h  "CI run for PR 42"',
    'Working (0)',
    'Other sessions (3)',
    '  done       docs          W-2 Docs refresh                 2h  "Published the guide"',
    '  crashed    infra         -                               24h  "Which region first?"',
    '  closed     old-tool      -                                5d',
    HINTS,
    '',
  ]);
});

test('ANSI styling highlights the selection and colors crashed rows', () => {
  const lines = renderDash(model(), state(), 80, 24, ansiStyle);
  assert.ok(lines[2].startsWith('\x1b[7m> needs-me'));
  assert.ok(lines[11].startsWith('\x1b[31m  crashed'));
  assert.ok(lines.every((line) => !line.includes('\n')));
});

test('the filter hides non-matching rows, matches item titles at any width, and shows in the title', () => {
  assert.deepEqual(plain(renderDash(model(), state({ selected: 'session:o2', filter: 'infra' }), 80, 24, plainStyle)), [
    'Work dashboard  /infra',
    'Decisions (0)',
    'Waiting (0)',
    'Working (0)',
    'Other sessions (1)',
    '> crashed    infra         -    24h  "Which region first?"',
    HINTS,
    '',
  ]);
  const byTitle = plain(renderDash(model(), state({ selected: null, filter: 'launch', editing: true }), 80, 24, plainStyle));
  assert.equal(byTitle[0], 'Work dashboard  /launch_');
  assert.ok(byTitle.includes('  waiting    web           W-3   3h  "CI run for PR 42"'));
  assert.equal(byTitle.length, 8);
});

test('scrolling keeps the selected row visible, and the message line is last', () => {
  assert.deepEqual(plain(renderDash(model(), state({ selected: 'session:o3', message: 'Refreshed' }), 80, 6, plainStyle)), [
    'Work dashboard',
    '  done       docs          W-2   2h  "Published the guide"',
    '  crashed    infra         -    24h  "Which region first?"',
    '> closed     old-tool      -     5d',
    HINTS,
    'Refreshed',
  ]);
});

test('hostile notes cannot inject terminal escapes', () => {
  const m = buildDashModel({ now: NOW, triageCount: 0, sessions: [entry({ id: 'h', tmuxWindow: 'x\x1b]0;evil\x07', status: 'needs-me', note: 'bad\x1b[2Jnote\nsecond' })] });
  const lines = renderDash(m, state({ selected: null }), 80, 24, plainStyle);
  assert.ok(lines.every((line) => !/[\x00-\x1f]/.test(line)));
  assert.match(lines[2], /"bad \[2Jnote second"/);
});

test('loadSessions adds liveness and the linked item', async () => {
  const store = await memoryStore();
  const item = store.addItem({ project: 'misc', title: 'Linked work', origin: 'manual' }, 'user');
  store.startSession({ id: 's1', file: null, cwd: '/src/api', name: null, pid: 10, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  store.startSession({ id: 's2', file: null, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%2', tmuxWindow: 'api', parentSession: null, headless: false });
  store.linkSession('s1', item.id, 'manual', 'user');
  const readers = { kill: (pid) => { if (pid !== 10) throw new Error('kill ESRCH'); }, environ: () => undefined };
  const [s1, s2] = loadSessions(store, [{ paneId: '%1', windowId: '@1', windowName: 'api', sessionName: 'main', path: '/src/api', command: 'node' }], readers);
  assert.deepEqual([s1.liveness, s1.itemId, s1.itemTitle], ['live', 'W-1', 'Linked work']);
  assert.deepEqual([s2.liveness, s2.itemId], ['crashed', null]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/dash-view.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/dash/model.ts`.

- [ ] **Step 3: Implement the model**

Create `src/work/dash/model.ts`:

```ts
import type { PidReaders, ProbedSession } from "../liveness.ts";
import { probeSessions } from "../liveness.ts";
import type { WorkStore } from "../store.ts";
import type { TmuxPane } from "../tmux.ts";
import type { Session } from "../types.ts";

export type SectionId = "decisions" | "waiting" | "working" | "jobs" | "other";
export type SessionEntry = ProbedSession & { itemId: string | null; itemTitle: string | null };
export type DashRow =
	| { kind: "session"; key: string; session: SessionEntry; depth: 0 | 1 }
	| { kind: "triage"; key: string; count: number };
export type DashSection = { id: SectionId; title: string; rows: DashRow[] };
export type DashModel = { sections: DashSection[]; now: Date };
export type DashInput = { sessions: readonly SessionEntry[]; triageCount: number; now: Date };

export const RECENT_MS = 7 * 86_400_000;

export function lastActivity(session: Session): string {
	return session.lastTurnAt ?? session.startedAt;
}

export function loadSessions(store: WorkStore, panes: readonly TmuxPane[] | undefined, readers?: PidReaders): SessionEntry[] {
	return probeSessions(store.listSessions(), panes, readers).map((session) => {
		const link = store.sessionLink(session.id);
		const item = link ? store.getItem(link.itemId) : undefined;
		return { ...session, itemId: item?.id ?? null, itemTitle: item?.title ?? null };
	});
}

const byStatusAt = (a: Session, b: Session): number => a.statusAt.localeCompare(b.statusAt) || a.id.localeCompare(b.id);
const byStart = (a: Session, b: Session): number => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
const byRecentActivity = (a: Session, b: Session): number => lastActivity(b).localeCompare(lastActivity(a)) || a.id.localeCompare(b.id);

export function buildDashModel(input: DashInput): DashModel {
	const cutoff = input.now.getTime() - RECENT_MS;
	const sessions = input.sessions.filter((s) => s.liveness === "live" || Date.parse(lastActivity(s)) >= cutoff);
	const children = new Map<string, SessionEntry[]>();
	for (const session of sessions) {
		if (session.parentSession) children.set(session.parentSession, [...(children.get(session.parentSession) ?? []), session]);
	}
	const placed = new Set<string>();
	const rows = (list: readonly SessionEntry[]): DashRow[] => list.flatMap((session) => {
		placed.add(session.id);
		const kids = [...(children.get(session.id) ?? [])].sort(byStart);
		for (const kid of kids) placed.add(kid.id);
		return [
			{ kind: "session" as const, key: `session:${session.id}`, session, depth: 0 as const },
			...kids.map((kid) => ({ kind: "session" as const, key: `session:${kid.id}`, session: kid, depth: 1 as const })),
		];
	});

	const top = sessions.filter((s) => !s.parentSession);
	const live = top.filter((s) => s.liveness === "live");
	const decisions = rows(live.filter((s) => s.status === "needs-me").sort(byStatusAt));
	if (input.triageCount > 0) decisions.push({ kind: "triage", key: "triage", count: input.triageCount });
	const waiting = rows(live.filter((s) => s.status === "waiting-external").sort(byStatusAt));
	const working = rows(live.filter((s) => s.status === "working").sort(byStatusAt));
	const done = live.filter((s) => s.status === "done").sort((a, b) => byStatusAt(b, a));
	const ended = top.filter((s) => s.liveness !== "live").sort(byRecentActivity);
	const other = rows([...done, ...ended]);
	const orphans = sessions.filter((s) => s.parentSession && !placed.has(s.id)).sort(byRecentActivity);
	other.push(...orphans.map((session) => ({ kind: "session" as const, key: `session:${session.id}`, session, depth: 0 as const })));

	return {
		now: input.now,
		sections: [
			{ id: "decisions", title: "Decisions", rows: decisions },
			{ id: "waiting", title: "Waiting", rows: waiting },
			{ id: "working", title: "Working", rows: working },
			{ id: "other", title: "Other sessions", rows: other },
		],
	};
}

export function allRows(model: DashModel): DashRow[] {
	return model.sections.flatMap((section) => section.rows);
}
```

- [ ] **Step 4: Implement the view**

Create `src/work/dash/view.ts`:

```ts
import { basename } from "node:path";
import type { DashModel, DashRow, SessionEntry } from "./model.ts";
import { allRows, lastActivity } from "./model.ts";
import type { Style } from "./text.ts";
import { fit, formatAge, oneLine, sanitize, truncate, visibleWidth } from "./text.ts";

export type ViewState = { selected: string | null; filter: string; editing: boolean; message: string };
export type Cells = { label: string; window: string; item: string; age: string; note: string };
type Widths = { window: number; item: number; age: number };

export const HINTS = "j/k move · enter open · L link · D delete · / filter · ? help · q quit";
const LABEL_WIDTH = 9;
const GAP = "  ";

export function sessionLabel(session: SessionEntry): string {
	if (session.liveness !== "live") return session.liveness;
	return session.status === "waiting-external" ? "waiting" : session.status;
}

export function rowCells(row: DashRow, now: Date, wide: boolean): Cells {
	if (row.kind === "triage") return { label: "triage", window: "", item: "", age: "", note: `${row.count} pending candidate${row.count === 1 ? "" : "s"}` };
	const s = row.session;
	const child = s.parentSession !== null;
	const since = child || s.liveness !== "live" ? lastActivity(s) : s.statusAt;
	const window = child ? (s.name ?? `child ${s.id.slice(0, 8)}`) : (s.tmuxWindow ?? basename(s.cwd));
	const item = s.itemId ? (wide && s.itemTitle ? `${s.itemId} ${s.itemTitle}` : s.itemId) : "-";
	const note = s.note ? `"${s.note}"` : child ? "" : (s.name ?? "");
	return { label: sessionLabel(s), window: oneLine(window), item: oneLine(item), age: formatAge(now.getTime() - Date.parse(since)), note: oneLine(note) };
}

export function rowMatches(row: DashRow, filter: string, now: Date): boolean {
	if (!filter) return true;
	const cells = rowCells(row, now, true);
	return [cells.label, cells.window, cells.item, cells.note].join(" ").toLowerCase().includes(filter.toLowerCase());
}

export function filterModel(model: DashModel, filter: string): DashModel {
	if (!filter) return model;
	return { ...model, sections: model.sections.map((section) => ({ ...section, rows: section.rows.filter((row) => rowMatches(row, filter, model.now)) })) };
}

function widths(rows: readonly DashRow[], now: Date, wide: boolean): Widths {
	const cells = rows.filter((row) => row.kind === "session").map((row) => rowCells(row, now, wide));
	const max = (pick: (cell: Cells) => string, cap: number): number => Math.min(cap, Math.max(1, ...cells.map((cell) => visibleWidth(pick(cell)))));
	return { window: max((c) => c.window, wide ? 28 : 16), item: max((c) => c.item, wide ? 40 : 6), age: max((c) => c.age, 4) };
}

function rowText(row: DashRow, now: Date, wide: boolean, w: Widths, width: number): string {
	const cells = rowCells(row, now, wide);
	if (row.kind === "triage") return truncate(`${fit(cells.label, LABEL_WIDTH)}${GAP}${cells.note}`, width);
	const indent = row.depth === 1 ? "  " : "";
	const head = [fit(cells.label, LABEL_WIDTH), fit(cells.window, w.window), fit(cells.item, w.item), cells.age.padStart(w.age)].join(GAP);
	return truncate(`${indent}${head}${GAP}${cells.note}`, width);
}

function styleRow(row: DashRow, line: string, style: Style): string {
	if (row.kind !== "session") return line;
	if (row.session.liveness === "crashed") return style.color("red", line);
	if (row.session.liveness === "closed" || row.session.status === "done") return style.dim(line);
	if (row.session.status === "needs-me" && row.depth === 0) return style.color("yellow", line);
	return line;
}

export function renderDash(model: DashModel, state: ViewState, width: number, height: number, style: Style): string[] {
	const wide = width >= 120;
	const w = widths(allRows(model), model.now, wide);
	const shown = filterModel(model, state.filter);
	const body: string[] = [];
	let selectedLine = -1;
	for (const section of shown.sections) {
		const count = section.rows.filter((row) => row.kind !== "session" || row.depth === 0).length;
		body.push(style.bold(truncate(`${section.title} (${count})`, width)));
		for (const row of section.rows) {
			const text = rowText(row, model.now, wide, w, width - 2);
			if (row.key === state.selected) {
				selectedLine = body.length;
				body.push(style.inverse(fit(`> ${text}`, width)));
			} else {
				body.push(styleRow(row, `  ${text}`, style));
			}
		}
	}
	const bodyHeight = Math.max(1, height - 3);
	const offset = selectedLine >= bodyHeight ? selectedLine - bodyHeight + 1 : 0;
	const title = state.filter || state.editing ? `Work dashboard  /${state.filter}${state.editing ? "_" : ""}` : "Work dashboard";
	return [
		style.bold(truncate(sanitize(title), width)),
		...body.slice(offset, offset + bodyHeight),
		style.dim(truncate(HINTS, width)),
		truncate(oneLine(state.message), width),
	];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/dash-view.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors. If a golden line differs only in spacing, recompute it by hand from the layout rules above. If it differs in content, fix the code, not the golden line. Record either change in the deviations file.

- [ ] **Step 6: Commit**

```bash
git add src/work/dash/model.ts src/work/dash/view.ts tests/work/dash-view.test.mjs
git commit -m "feat: lay out the dashboard sections with nested child agents"
```

---

### Task 10: The dashboard app, `work dash`, `/dash`, and the Pi-free guard

**Files:**
- Create: `src/work/dash/app.ts`
- Modify: `src/work/cli.ts`: the `dash` command, and `CliDeps.terminal`
- Modify: `extensions/work.ts`: the `/dash` command and `dashCommand`
- Test: `tests/work/dash-app.test.mjs`, `tests/work/pi-free.test.mjs`, `tests/work/extension.test.mjs`

**Interfaces:**
- Consumes: the keymap (Task 7), widgets, text, and terminal (Task 8), model and view (Task 9), `runRestore`, `selectForRestore`, `reopenSession` (Task 6), `jumpToPane`, `listPanes`, `popupArgs` (Task 2), `readTranscript`, `formatTranscript` (Task 4), `runTriageAction`, `TRIAGE_ACTIONS` (Task 7), and `store.linkSession` and `deleteSession` (Task 1).
- Produces:
  - `DashDeps = { runtime; terminal; tmux; insideTmux; readers?; style?; refreshMs?; bootId?; fileExists?; pi?; kill? }`, `DashResult = { print?: string }`
  - `MAIN_ACTIONS = ["L", "x", "D", "R", "?"]`, `CONFIRM_ACTIONS = ["x", "D"]`, `HELP_TEXT`
  - `runDash(deps): Promise<DashResult>`. It resolves when the dashboard closes. `print` is a command to show after leaving the alternate screen.
  - `CliDeps.terminal?: Terminal`
  - `extensions/work.ts`: `dashCommand(execPath?): string`, and `WorkExtensionOptions.popup?: (args: string[]) => void`

Key behavior (the spec's key table, with decision 11):
- `Enter`: a live pane session jumps and closes. A crashed or closed session is reopened with the restore rules, then jumps. A child, or a live session with no pane, opens its read-only transcript (last 30 messages). The triage line opens the triage view.
- `L`: fuzzy-pick an open item and link it (`via: "manual"`, actor `user`).
- `x`, then `y`: send `SIGTERM` to a running child. `D`, then `y`: delete a closed or crashed session row. The target row is captured when the confirmation is requested.
- `R` refreshes, `?` shows help, and `q`/`Esc` closes. When the dashboard opens and finds restorable sessions, it runs `runRestore("auto")`, which claims the boot marker.

- [ ] **Step 1: Write the failing tests**

Create `tests/work/dash-app.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIo, clock, load, memoryRuntime, tempDir } from './helpers.mjs';

const { runDash } = await load('src/work/dash/app.ts');
const { plainStyle } = await load('src/work/dash/text.ts');
const { runCli } = await load('src/work/cli.ts');

function fakeTerminal(columns = 100, rows = 30) {
  let input = () => {};
  const t = {
    writes: [],
    stopped: false,
    columns: () => columns,
    rows: () => rows,
    write(data) { t.writes.push(data); },
    onInput(handler) { input = handler; },
    onResize() {},
    start() {},
    stop() { t.stopped = true; },
    send(...keys) { for (const key of keys) input(key); },
    screen() {
      return t.writes.at(-1).replace(/^\x1b\[H/, '').replace(/\x1b\[J$/, '').split('\x1b[K\r\n').map((line) => line.replace(/\x1b\[K$/, '').trimEnd());
    },
  };
  return t;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const PANES = ['%1\t@1\tsap-rfc\tmain\t/src/sap\tnode', '%5\t@5\tshell\tmain\t/home\tzsh'].join('\n');

function tmuxFake(calls) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return PANES;
    if (args[0] === 'new-window') return '@9\t%20\n';
    if (args[0] === 'split-window') return '%21\n';
    return '';
  };
}
const alive = (...pids) => ({ kill: (pid) => { if (!pids.includes(pid)) throw new Error('kill ESRCH'); }, environ: () => undefined });

async function fixture({ restored = true } = {}) {
  const rt = await memoryRuntime({ now: clock() });
  const { store } = rt;
  store.addItem({ project: 'misc', title: 'SAP RFC overview', origin: 'manual' }, 'user');
  store.addItem({ project: 'misc', title: 'Fix login', origin: 'manual' }, 'user');
  const childFile = join(tempDir(), 'child-1.jsonl');
  writeFileSync(childFile, [
    JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: 't', message: { role: 'user', content: 'Implement the parser' } }),
    JSON.stringify({ type: 'message', id: 'b', parentId: 'a', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'Which test runner should I use?' }] } }),
  ].join('\n'));
  const start = (id, fields) => store.startSession({ id, file: `/s/${id}.jsonl`, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: false, ...fields });
  start('live-1', { cwd: '/src/sap', pid: 11, tmuxPane: '%1', tmuxWindow: 'sap-rfc' });
  store.setSessionStatus('live-1', 'needs-me', 'Trim the overview?', 'agent');
  start('child-1', { file: childFile, pid: 13, parentSession: 'live-1', headless: true, name: 'impl-parser' });
  start('dead-1', { cwd: '/src/infra', pid: 12, tmuxPane: '%2', tmuxWindow: 'infra' });
  store.setSessionStatus('dead-1', 'working', '', 'auto');
  if (restored) store.setMeta('restore:boot:boot-1', 'handled');
  return { rt, store };
}

function open(rt, { insideTmux = true, kills = [] } = {}) {
  const terminal = fakeTerminal();
  const calls = [];
  const result = runDash({
    runtime: rt, terminal, tmux: tmuxFake(calls), insideTmux, readers: alive(11, 13), style: plainStyle, refreshMs: 0,
    bootId: () => 'boot-1', fileExists: () => true, kill: (pid, signal) => kills.push([pid, signal]),
  });
  return { terminal, calls, result, kills };
}
const actions = (calls) => calls.filter((call) => call[0] !== 'list-panes');

test('the dashboard shows parents with their children and jumps to a live session with Enter', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  const screen = d.terminal.screen();
  assert.equal(screen[0], 'Work dashboard');
  assert.equal(screen[1], 'Decisions (1)');
  assert.match(screen[2], /^> needs-me\s+sap-rfc\s+-\s+0s\s+"Trim the overview\?"$/);
  assert.match(screen[3], /^ {4}needs-me\s+impl-parser\s+-\s+0s\s+"new session"$/);
  assert.ok(screen.includes('Other sessions (1)'));
  assert.match(screen.find((line) => line.includes('crashed')), /infra/);
  d.terminal.send('\r');
  assert.deepEqual(await d.result, {});
  assert.deepEqual(actions(d.calls), [['switch-client', '-t', '%1'], ['select-window', '-t', '%1'], ['select-pane', '-t', '%1']]);
  assert.equal(d.terminal.stopped, true);
});

test('outside tmux, Enter prints the tmux command instead', async () => {
  const { rt } = await fixture();
  const d = open(rt, { insideTmux: false });
  d.terminal.send('\r');
  assert.deepEqual(await d.result, { print: "tmux attach-session -t '%1' \\; select-window -t '%1' \\; select-pane -t '%1'" });
});

test('Enter on a crashed session reopens it with the restore rules, then jumps', async () => {
  const { rt, store } = await fixture();
  const d = open(rt);
  d.terminal.send('G', '\r');
  assert.deepEqual(await d.result, {});
  assert.deepEqual(actions(d.calls), [
    ['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-n', 'infra', '-c', '/src/infra', "pi --session '/s/dead-1.jsonl'"],
    ['switch-client', '-t', '%20'], ['select-window', '-t', '%20'], ['select-pane', '-t', '%20'],
  ]);
  assert.equal(store.getSession('dead-1').restoredFrom, 12);
});

test('Enter on a child opens its read-only transcript, and any key returns', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('j', '\r');
  await tick();
  const screen = d.terminal.screen();
  assert.equal(screen[0], 'Transcript: impl-parser (read-only)');
  assert.ok(screen.includes('  Implement the parser'));
  assert.ok(screen.includes('  Which test runner should I use?'));
  d.terminal.send('q');
  assert.equal(d.terminal.screen()[0], 'Work dashboard');
  await tick();
  d.terminal.send('q');
  await d.result;
});

test('x then y stops a running child with SIGTERM; x on a top-level session is refused', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('x');
  assert.equal(d.terminal.screen().at(-1), 'x stops only running child agents');
  d.terminal.send('j', 'x');
  assert.match(d.terminal.screen().at(-1), /^Stop this child agent with SIGTERM\? y to confirm/);
  d.terminal.send('y');
  await tick();
  assert.deepEqual(d.kills, [[13, 'SIGTERM']]);
  assert.equal(d.terminal.screen().at(-1), 'Sent SIGTERM to impl-parser');
  d.terminal.send('x', 'n');
  assert.equal(d.terminal.screen().at(-1), 'Cancelled');
  assert.equal(d.kills.length, 1);
  d.terminal.send('q');
  await d.result;
});

test('L links the selected session through the fuzzy picker', async () => {
  const { rt, store } = await fixture();
  const d = open(rt);
  d.terminal.send('L');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Link session to item');
  d.terminal.send('f', 'i', 'x', '\r');
  await tick();
  assert.equal(store.sessionLink('live-1').itemId, 'W-2');
  assert.deepEqual(store.sessionLink('live-1').state, { via: 'manual' });
  assert.equal(store.listEvents().at(-1).actor, 'user');
  assert.match(d.terminal.screen()[2], /sap-rfc\s+W-2/);
  assert.equal(d.terminal.screen().at(-1), 'Linked to W-2');
  d.terminal.send('q');
  await d.result;
});

test('D then y deletes a crashed session record; D on a live session is refused', async () => {
  const { rt, store } = await fixture();
  const d = open(rt);
  d.terminal.send('D');
  assert.equal(d.terminal.screen().at(-1), 'D deletes only closed or crashed sessions');
  d.terminal.send('G', 'D', 'y');
  await tick();
  assert.equal(store.getSession('dead-1'), undefined);
  assert.equal(d.terminal.screen().at(-1), 'Session record deleted');
  d.terminal.send('q');
  await d.result;
});

test('the filter hides rows as you type and Esc clears it', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('/', 'i', 'n', 'f', 'r', 'a');
  let screen = d.terminal.screen();
  assert.equal(screen[0], 'Work dashboard  /infra_');
  assert.equal(screen.some((line) => line.includes('sap-rfc')), false);
  assert.match(screen.find((line) => line.startsWith('> ')), /crashed\s+infra/);
  d.terminal.send('\x1b');
  screen = d.terminal.screen();
  assert.equal(screen[0], 'Work dashboard');
  assert.ok(screen.some((line) => line.includes('sap-rfc')));
  d.terminal.send('q');
  await d.result;
});

test('? shows the help and any key returns', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('?');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Keys');
  assert.ok(d.terminal.screen().some((line) => line.includes('x then y')));
  d.terminal.send('z');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Work dashboard');
  d.terminal.send('q');
  await d.result;
});

test('the triage line opens triage, and dismissing the last candidate returns to the dashboard', async () => {
  const { rt, store } = await fixture();
  store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k1', title: 'Review example-org/api#9', reason: 'Review requested' }, 'sync:github');
  const d = open(rt);
  assert.ok(d.terminal.screen().includes('  triage     1 pending candidate'));
  d.terminal.send('j', 'j', '\r');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Triage (1 open)');
  d.terminal.send('d');
  await tick();
  assert.equal(store.isDismissed('k1'), true);
  assert.equal(d.terminal.screen()[0], 'Work dashboard');
  assert.equal(d.terminal.screen().at(-1), 'Triage inbox is empty');
  d.terminal.send('q');
  await d.result;
});

test('opening the dashboard restores crashed sessions once per boot', async () => {
  const { rt } = await fixture({ restored: false });
  const first = open(rt);
  assert.equal(first.terminal.screen().at(-1), 'Restored 1 crashed session');
  assert.ok(actions(first.calls).some((call) => call[0] === 'new-window'));
  first.terminal.send('q');
  await first.result;
  const second = open(rt);
  assert.equal(actions(second.calls).length, 0);
  second.terminal.send('q');
  await second.result;
});

test('work dash runs through the CLI and prints jump commands outside tmux', async () => {
  const { rt } = await fixture();
  const io = captureIo();
  const terminal = fakeTerminal();
  const code = runCli(['dash'], { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, tmux: tmuxFake([]), readers: alive(11, 13), bootId: () => 'boot-1', terminal });
  await tick();
  terminal.send('\r');
  assert.equal(await code, 0);
  assert.deepEqual(io.out, ["tmux attach-session -t '%1' \\; select-window -t '%1' \\; select-pane -t '%1'"]);
});
```

Create `tests/work/pi-free.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SPECIFIERS = [
  /^\s*(?:import|export)\s[^'"]*?\sfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiers(file) {
  const source = readFileSync(file, 'utf8');
  return SPECIFIERS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

test('bin/work.ts and everything it imports use only Node built-ins, so the dashboard runs without Pi packages', () => {
  const seen = new Set();
  const bare = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith('.')) walk(resolve(dirname(file), specifier));
      else if (!specifier.startsWith('node:')) bare.set(specifier, file.slice(root.length));
    }
  };
  walk(resolve(root, 'bin/work.ts'));
  assert.ok(seen.has(resolve(root, 'src/work/dash/app.ts')), 'the dashboard is reachable from bin/work.ts');
  assert.deepEqual(Object.fromEntries(bare), {});
});
```

Append to `tests/work/extension.test.mjs`:

```js
test('/dash opens the dashboard in a tmux popup, and warns outside tmux', async () => {
  const { dashCommand } = await load('extensions/work.ts');
  const rt = await memoryRuntime();
  const popups = [];
  const commands = new Map();
  const make = (env) => createWorkExtension({ runtime: () => rt, env, git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter(), popup: (args) => popups.push(args) })({
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool() {},
    on() {},
  });
  const c = context();
  make({});
  await commands.get('dash')('', c.ctx);
  assert.match(c.notes.at(-1).message, /work dash/);
  assert.equal(popups.length, 0);
  make({ TMUX: '/tmp/tmux-1000/default,1,0' });
  await commands.get('dash')('', c.ctx);
  assert.deepEqual(popups[0].slice(0, 6), ['display-popup', '-E', '-w', '90%', '-h', '90%']);
  assert.match(popups[0][6], /bin\/work\.ts' dash$/);
  assert.match(dashCommand('/opt/pi/bin/pi'), /^'node' '.*bin\/work\.ts' dash$/);
  assert.match(dashCommand('/usr/local/bin/node'), /^'\/usr\/local\/bin\/node' /);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/dash-app.test.mjs tests/work/pi-free.test.mjs tests/work/extension.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/dash/app.ts`. The Pi-free test fails with `the dashboard is reachable from bin/work.ts`, and `/dash` is not registered.

- [ ] **Step 3: Implement the dashboard app**

Create `src/work/dash/app.ts`:

```ts
import type { KeyState, Move } from "../keymap.ts";
import { decodeKey, INITIAL_KEY_STATE, keyStep, moveIndex, splitKeys } from "../keymap.ts";
import type { PidReaders } from "../liveness.ts";
import type { TmuxRunner } from "../planner.ts";
import { shellQuote } from "../planner.ts";
import { reopenSession, runRestore, selectForRestore } from "../restore.ts";
import type { Runtime } from "../runtime.ts";
import { errorMessage } from "../secrets.ts";
import type { TmuxPane } from "../tmux.ts";
import { jumpToPane, listPanes } from "../tmux.ts";
import { formatTranscript, readTranscript } from "../transcript.ts";
import type { TriageActionUi, TriageKey } from "../triage-actions.ts";
import { runTriageAction, TRIAGE_ACTIONS } from "../triage-actions.ts";
import { candidateLabel, candidateSummary, openCandidates } from "../triage.ts";
import type { Candidate, Item } from "../types.ts";
import { OPEN_ITEM_STATUSES } from "../types.ts";
import type { DashModel, DashRow, SessionEntry } from "./model.ts";
import { allRows, buildDashModel, loadSessions } from "./model.ts";
import type { Terminal } from "./terminal.ts";
import { frame } from "./terminal.ts";
import type { Style } from "./text.ts";
import { ansiStyle, fit, oneLine, truncate } from "./text.ts";
import { filterModel, renderDash } from "./view.ts";
import type { Modal } from "./widgets.ts";
import { confirmBox, fuzzyPicker, messageBox, selectList, textPrompt } from "./widgets.ts";

export type DashDeps = {
	runtime: Runtime;
	terminal: Terminal;
	tmux: TmuxRunner;
	insideTmux: boolean;
	readers?: PidReaders;
	style?: Style;
	refreshMs?: number;
	bootId?: () => string | undefined;
	fileExists?: (path: string) => boolean;
	pi?: string;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
};
export type DashResult = { print?: string };
type TriageState = { candidates: Candidate[]; index: number; keys: KeyState };

export const MAIN_ACTIONS: readonly string[] = ["L", "x", "D", "R", "?"];
export const CONFIRM_ACTIONS: readonly string[] = ["x", "D"];
export const HELP_TEXT = [
	"j / k            down / up",
	"gg / G           first / last row",
	"Ctrl-d / Ctrl-u  half page down / up",
	"Tab / Shift-Tab  next / previous section (also ] and [)",
	"/ then n / N     filter as you type, then next / previous match; Esc clears",
	"Enter            jump to a session, reopen a closed or crashed one, open triage,",
	"                 or show a child agent's transcript",
	"L                link the session to an item",
	"x then y         stop a running child agent (SIGTERM)",
	"D then y         delete a closed or crashed session record",
	"R                refresh",
	"?                this help",
	"q / Esc          close",
].join("\n");

const DEFAULT_REFRESH_MS = 5000;
const TRIAGE_PAGE = 10;
const TRIAGE_HINTS = "j/k move · a accept · m merge · d dismiss · z snooze · A all from source · p promote · enter details · esc back";
const CONFIRM_TEXT: Record<string, string> = {
	D: "Delete this session record? y to confirm, any other key cancels",
	x: "Stop this child agent with SIGTERM? y to confirm, any other key cancels",
};
const itemLabel = (item: Item): string => `${item.id} ${item.title}  #${item.project}`;

export function runDash(deps: DashDeps): Promise<DashResult> {
	const { store } = deps.runtime;
	const term = deps.terminal;
	const style = deps.style ?? ansiStyle;
	const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => {
		process.kill(pid, signal);
	});
	let sessions: SessionEntry[] = [];
	let model: DashModel = buildDashModel({ sessions, triageCount: 0, now: store.clock() });
	let panes: TmuxPane[] | undefined;
	let keys: KeyState = INITIAL_KEY_STATE;
	let selected: string | null = null;
	let confirmTarget: string | null = null;
	let message = "";
	let busy = false;
	let closed = false;
	let triage: TriageState | undefined;
	const modals: Modal[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;
	let resolveRun: (result: DashResult) => void = () => {};
	const finished = new Promise<DashResult>((resolve) => {
		resolveRun = resolve;
	});

	const visibleRows = (): DashRow[] => allRows(filterModel(model, keys.filter));
	const selectedRow = (): DashRow | undefined => visibleRows().find((row) => row.key === selected);
	const sessionOf = (row: DashRow | undefined): SessionEntry | undefined => (row?.kind === "session" ? row.session : undefined);

	function reload(): void {
		panes = listPanes(deps.tmux);
		sessions = loadSessions(store, panes, deps.readers);
		model = buildDashModel({ sessions, triageCount: openCandidates(store).length, now: store.clock() });
		const rows = visibleRows();
		if (!rows.some((row) => row.key === selected)) selected = rows[0]?.key ?? null;
	}

	function safeReload(): void {
		try {
			reload();
		} catch (error) {
			message = errorMessage(error);
		}
	}

	function triageLines(state: TriageState, width: number, height: number): string[] {
		const visible = Math.max(1, Math.floor((height - 3) / 2));
		const start = Math.max(0, Math.min(state.index - Math.floor(visible / 2), state.candidates.length - visible));
		const lines = [style.bold(truncate(`Triage (${state.candidates.length} open)`, width))];
		for (let i = start; i < Math.min(state.candidates.length, start + visible); i++) {
			const candidate = state.candidates[i];
			const label = oneLine(candidateLabel(candidate));
			lines.push(i === state.index ? style.inverse(fit(`> ${label}`, width)) : truncate(`  ${label}`, width));
			lines.push(style.dim(truncate(`    ${oneLine(candidateSummary(candidate))}`, width)));
		}
		lines.push(style.dim(truncate(TRIAGE_HINTS, width)), truncate(oneLine(message), width));
		return lines;
	}

	function render(): void {
		if (closed) return;
		const width = term.columns();
		const height = term.rows();
		const top = modals.at(-1);
		const lines = top
			? top.lines(width, height, style)
			: triage
				? triageLines(triage, width, height)
				: renderDash(model, { selected, filter: keys.filter, editing: keys.editing, message }, width, height, style);
		term.write(frame(lines));
	}

	function finish(result: DashResult): void {
		if (closed) return;
		closed = true;
		if (timer) clearInterval(timer);
		term.stop();
		resolveRun(result);
	}

	function ask<T>(make: (resolve: (value: T) => void) => Modal): Promise<T> {
		return new Promise<T>((resolve) => {
			const modal = make((value) => {
				const index = modals.indexOf(modal);
				if (index >= 0) modals.splice(index, 1);
				resolve(value);
				render();
			});
			modals.push(modal);
			render();
		});
	}

	function perform(task: () => Promise<void> | void): void {
		busy = true;
		Promise.resolve()
			.then(task)
			.catch((error: unknown) => {
				message = errorMessage(error);
			})
			.finally(() => {
				busy = false;
				if (closed) return;
				safeReload();
				render();
			});
	}

	const triageUi: TriageActionUi = {
		input: (title, placeholder) => ask<string | undefined>((resolve) => textPrompt(title, placeholder ?? "", resolve)),
		select: (title, options) => ask<string | undefined>((resolve) => selectList(title, options, resolve)),
		confirm: (title, text) => ask<boolean>((resolve) => confirmBox(title, text, resolve)),
		notify: (text) => {
			if (text.includes("\n")) void ask<void>((resolve) => messageBox("Details", text, resolve));
			else message = text;
		},
		pickItem: (title, items) => ask<Item | undefined>((resolve) => fuzzyPicker(title, items, itemLabel, resolve)),
	};

	function move(to: Move): void {
		const rows = visibleRows();
		if (rows.length === 0) return;
		if (to === "next-section" || to === "prev-section") {
			const sections = filterModel(model, keys.filter).sections.filter((section) => section.rows.length > 0);
			const current = Math.max(0, sections.findIndex((section) => section.rows.some((row) => row.key === selected)));
			const target = sections[to === "next-section" ? Math.min(sections.length - 1, current + 1) : Math.max(0, current - 1)];
			selected = target?.rows[0]?.key ?? selected;
			return;
		}
		const index = Math.max(0, rows.findIndex((row) => row.key === selected));
		selected = rows[moveIndex(index, rows.length, to, Math.max(2, term.rows() - 3))].key;
	}

	function match(direction: 1 | -1): void {
		const rows = visibleRows();
		if (rows.length === 0) return;
		const index = rows.findIndex((row) => row.key === selected);
		selected = rows[(index + direction + rows.length) % rows.length].key;
	}

	function jump(pane: string): void {
		const result = jumpToPane(deps.tmux, pane, deps.insideTmux);
		finish(result.kind === "print" ? { print: result.command } : {});
	}

	async function showTranscript(session: SessionEntry): Promise<void> {
		if (!session.file) {
			message = "This session has no session file";
			return;
		}
		const text = formatTranscript(readTranscript(session.file));
		await ask<void>((resolve) => messageBox(`Transcript: ${session.name ?? session.id} (read-only)`, text, resolve, { atEnd: true }));
	}

	function openTriage(): void {
		const candidates = openCandidates(store);
		if (candidates.length === 0) {
			message = "Triage inbox is empty";
			return;
		}
		triage = { candidates, index: 0, keys: INITIAL_KEY_STATE };
	}

	function refreshTriage(): void {
		if (!triage) return;
		const candidates = openCandidates(store);
		if (candidates.length === 0) {
			triage = undefined;
			message = "Triage inbox is empty";
			return;
		}
		triage = { ...triage, candidates, index: Math.min(triage.index, candidates.length - 1) };
	}

	async function activate(): Promise<void> {
		const row = selectedRow();
		if (!row) return;
		if (row.kind === "triage") {
			openTriage();
			return;
		}
		const session = row.session;
		if (session.parentSession || (session.liveness === "live" && !session.tmuxPane)) {
			await showTranscript(session);
			return;
		}
		if (session.liveness === "live" && session.tmuxPane) {
			jump(session.tmuxPane);
			return;
		}
		if (!panes) {
			if (!session.file) throw new Error("This session has no session file to reopen");
			finish({ print: `cd ${shellQuote(session.cwd)} && ${deps.pi ?? "pi"} --session ${shellQuote(session.file)}` });
			return;
		}
		jump(reopenSession(store, session, deps.tmux, panes, { fileExists: deps.fileExists, pi: deps.pi }));
	}

	async function runAction(key: string): Promise<void> {
		if (key === "R") {
			message = "Refreshed";
			return;
		}
		if (key === "?") {
			await ask<void>((resolve) => messageBox("Keys", HELP_TEXT, resolve));
			return;
		}
		if (key === "L") {
			const session = sessionOf(selectedRow());
			if (!session) {
				message = "L links a session to an item";
				return;
			}
			const item = await ask<Item | undefined>((resolve) => fuzzyPicker("Link session to item", store.listItems({ statuses: OPEN_ITEM_STATUSES }), itemLabel, resolve));
			if (!item) return;
			store.linkSession(session.id, item.id, "manual", "user");
			message = `Linked to ${item.id}`;
		}
	}

	function canConfirm(key: string): boolean {
		const session = sessionOf(selectedRow());
		if (key === "D" && session && session.liveness !== "live") return true;
		if (key === "x" && session?.parentSession && session.alive) return true;
		message = key === "D" ? "D deletes only closed or crashed sessions" : "x stops only running child agents";
		return false;
	}

	async function runConfirmed(key: string): Promise<void> {
		const row = allRows(model).find((candidate) => candidate.key === confirmTarget);
		confirmTarget = null;
		const session = sessionOf(row);
		if (!session) {
			message = "That row is gone; nothing was changed";
			return;
		}
		if (key === "D") {
			store.deleteSession(session.id);
			message = "Session record deleted";
			return;
		}
		if (key === "x" && session.pid) {
			try {
				kill(session.pid, "SIGTERM");
				message = `Sent SIGTERM to ${session.name ?? session.id}`;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				message = "The child had already exited";
			}
		}
	}

	function mainKey(key: string): void {
		const step = keyStep(keys, key, { actions: MAIN_ACTIONS, confirm: CONFIRM_ACTIONS, filter: true });
		keys = step.state;
		const { action } = step;
		switch (action.type) {
			case "move":
				move(action.move);
				message = "";
				break;
			case "filter": {
				const rows = visibleRows();
				if (!rows.some((row) => row.key === selected)) selected = rows[0]?.key ?? null;
				break;
			}
			case "match":
				match(action.direction);
				break;
			case "enter":
				perform(activate);
				break;
			case "close":
				finish({});
				return;
			case "action": {
				const actionKey = action.key;
				perform(() => runAction(actionKey));
				break;
			}
			case "confirming":
				if (canConfirm(action.key)) {
					confirmTarget = selected;
					message = CONFIRM_TEXT[action.key] ?? "y to confirm";
				} else {
					keys = { ...keys, confirming: null };
				}
				break;
			case "confirmed": {
				const confirmedKey = action.key;
				perform(() => runConfirmed(confirmedKey));
				break;
			}
			case "cancelled":
				confirmTarget = null;
				message = "Cancelled";
				break;
			default:
				break;
		}
		render();
	}

	function triageKey(state: TriageState, key: string): void {
		const step = keyStep(state.keys, key, { actions: TRIAGE_ACTIONS });
		state.keys = step.state;
		const { action } = step;
		if (action.type === "close") {
			triage = undefined;
			message = "";
		} else if (action.type === "move") {
			state.index = moveIndex(state.index, state.candidates.length, action.move, TRIAGE_PAGE);
		} else if (action.type === "enter" || action.type === "action") {
			const triageAction: TriageKey = action.type === "enter" ? "enter" : (action.key as TriageKey);
			const candidate = state.candidates[state.index];
			perform(async () => {
				await runTriageAction(triageUi, deps.runtime, triageAction, candidate);
				refreshTriage();
			});
		}
		render();
	}

	function onKey(key: string): void {
		const top = modals.at(-1);
		if (top) {
			top.handle(key);
			render();
			return;
		}
		if (busy) return;
		if (triage) triageKey(triage, key);
		else mainKey(key);
	}

	function autoRestore(): void {
		if (selectForRestore(sessions, store.clock(), deps.fileExists).selected.length === 0) return;
		const report = runRestore("auto", { store, tmux: deps.tmux, readers: deps.readers, bootId: deps.bootId, fileExists: deps.fileExists, pi: deps.pi });
		if (!report.ran) return;
		const count = report.placed.length;
		message = `Restored ${count} crashed session${count === 1 ? "" : "s"}${report.failed.length ? `; ${report.failed.length} failed` : ""}`;
		reload();
	}

	term.onInput((data) => {
		for (const chunk of splitKeys(data)) {
			if (closed) return;
			const key = decodeKey(chunk);
			if (key) onKey(key);
		}
	});
	term.onResize(render);
	term.start();
	try {
		reload();
		autoRestore();
	} catch (error) {
		message = errorMessage(error);
	}
	render();
	const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
	if (refreshMs > 0) {
		timer = setInterval(() => {
			if (busy || closed || modals.length > 0 || keys.confirming || triage) return;
			safeReload();
			render();
		}, refreshMs);
	}
	return finished;
}
```

- [ ] **Step 4: Add `work dash`**

In `src/work/cli.ts`, add these imports:

```ts
import { runDash } from "./dash/app.ts";
import type { Terminal } from "./dash/terminal.ts";
import { processTerminal } from "./dash/terminal.ts";
```

Extend `CliDeps` with:

```ts
	terminal?: Terminal;
```

Add this command after `restoreCommand`:

```ts
const dash: CliCommand = {
	usage: "dash                                 Sessions and jobs dashboard (full screen; tmux popup via /dash)",
	async run(_args, deps) {
		const result = await runDash({
			runtime: deps.runtime(),
			terminal: deps.terminal ?? processTerminal(),
			tmux: deps.tmux ?? tmuxRunner(),
			insideTmux: Boolean(deps.env.TMUX),
			readers: deps.readers,
			bootId: deps.bootId,
		});
		if (result.print) deps.io.out(result.print);
		return 0;
	},
};
```

In `COMMANDS`, add `dash,` after `restore: restoreCommand,`.

- [ ] **Step 5: Add `/dash`**

In `extensions/work.ts`, add these imports:

```ts
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../src/work/planner.ts";
import { popupArgs } from "../src/work/tmux.ts";
```

Merge `popupArgs` into the existing `tmuxRunner` import from `../src/work/tmux.ts`, and `shellQuote` into the existing `planner.ts` value import, instead of adding duplicate import lines. Add `popup?: (args: string[]) => void;` to `WorkExtensionOptions`. After `SESSION_STATUS_DESCRIPTION`, add:

```ts
const WORK_BIN = fileURLToPath(new URL("../bin/work.ts", import.meta.url));

// Aliases do not reach tmux popups, so the popup runs Node and bin/work.ts by absolute path.
export function dashCommand(execPath: string = process.execPath): string {
	const node = /^node(\.exe)?$/.test(basename(execPath)) ? execPath : "node";
	return `${shellQuote(node)} ${shellQuote(WORK_BIN)} dash`;
}

function openPopup(args: string[]): void {
	spawn("tmux", args, { stdio: "ignore", detached: true }).unref();
}
```

Register the command after `today`:

```ts
		pi.registerCommand("dash", {
			description: "Open the work dashboard in a tmux popup",
			handler: async (_args, ctx) => {
				if (!env.TMUX) {
					ctx.ui.notify("/dash needs tmux; run `work dash` in a terminal instead", "warning");
					return;
				}
				try {
					(options.popup ?? openPopup)(popupArgs(dashCommand()));
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/work/dash-app.test.mjs tests/work/pi-free.test.mjs tests/work/extension.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

Run: `npm test`
Expected: PASS. In particular, `bin/work.ts runs under Node type stripping` still passes, now with the dashboard modules in its import graph.

- [ ] **Step 7: Try the dashboard by hand (optional, isolated data)**

```bash
XDG_DATA_HOME="$(mktemp -d)" XDG_CONFIG_HOME="$(mktemp -d)" TMUX_TMPDIR="$(mktemp -d)" env -u TMUX -u TMUX_PANE node bin/work.ts dash
```

Expected: an empty dashboard (`Decisions (0)` … `Other sessions (0)`). `?` shows help, and `q` restores the terminal. The database is a throwaway, and `TMUX_TMPDIR` points tmux at an empty socket directory, so the user's tmux server is never contacted.

- [ ] **Step 8: Commit**

```bash
git add src/work/dash/app.ts src/work/cli.ts extensions/work.ts tests/work/dash-app.test.mjs tests/work/pi-free.test.mjs tests/work/extension.test.mjs
git commit -m "feat: add the work dashboard with jump, reopen, link, transcript, and child stop"
```

---

### Task 11: Real tmux integration test on an isolated server

**Files:**
- Create: `tests/work/fixtures/fake-pi.sh`, `tests/work/tmux-integration.test.mjs`

**Interfaces:**
- Consumes: `tmuxRunner(socket)`, `listPanes`, `jumpToPane` (Task 2). `runRestore` (Task 6). `shellQuote`.
- Produces: an integration test that is skipped when tmux is not installed.

Safety rules for this task, from the global constraints: every tmux command goes through `tmuxRunner('work-test')`, which adds `-L work-test` and removes `TMUX` and `TMUX_PANE`. The server starts with `-f /dev/null`, so no user configuration or plugins (resurrect, continuum) load. The test kills only the `work-test` server, in `finally`. `pi` is never run: a fake script stands in for it.

- [ ] **Step 1: Write the fake `pi`**

Create `tests/work/fixtures/fake-pi.sh`:

```sh
#!/bin/sh
# Stand-in for pi in tests/work/tmux-integration.test.mjs: records which session file it was asked to open, then idles.
if [ "$1" = "--session" ]; then : > "$2.opened"; fi
exec sleep 30
```

- [ ] **Step 2: Write the integration test**

Create `tests/work/tmux-integration.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, memoryStore, tempDir } from './helpers.mjs';

const { tmuxRunner, listPanes, jumpToPane } = await load('src/work/tmux.ts');
const { runRestore } = await load('src/work/restore.ts');
const { shellQuote } = await load('src/work/planner.ts');

// Isolated server only: never the user's running tmux server.
const SOCKET = 'work-test';
const available = spawnSync('tmux', ['-V']).status === 0;
const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.sh', import.meta.url));
const dead = { kill: () => { throw new Error('kill ESRCH'); }, environ: () => undefined };

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

test('real tmux on an isolated server: restore into a shell pane, split, new window, and jump', { skip: available ? false : 'tmux is not installed' }, async () => {
  const tmux = tmuxRunner(SOCKET);
  try { tmux(['kill-server']); } catch { /* no stale isolated server */ }
  const dir = realpathSync(tempDir());
  const api = join(dir, 'api');
  const docs = join(dir, 'api', 'docs');
  const web = join(dir, 'web');
  for (const path of [api, docs, web]) mkdirSync(path, { recursive: true });
  try {
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'work', '-n', 'api', '-c', api, '-x', '160', '-y', '48', 'sh']);
    const store = await memoryStore();
    for (const [id, cwd, window] of [['a', api, 'api'], ['b', docs, 'api'], ['c', web, 'web']]) {
      const file = join(dir, `${id}.jsonl`);
      writeFileSync(file, '');
      store.startSession({ id, file, cwd, name: null, pid: 999_999, tmuxPane: `%9${id}`, tmuxWindow: window, parentSession: null, headless: false });
    }
    assert.equal(await waitFor(() => (listPanes(tmux) ?? []).some((pane) => pane.windowName === 'api' && pane.command === 'sh' && pane.path === api)), true, 'shell pane ready');

    const report = runRestore('manual', { store, tmux, readers: dead, bootId: () => 'test-boot', pi: `sh ${shellQuote(fakePi)}` });
    assert.equal(report.ran, true);
    assert.deepEqual(report.steps.map((step) => step.kind), ['send', 'split', 'window']);
    assert.deepEqual(report.failed, []);
    for (const id of ['a', 'b', 'c']) assert.equal(await waitFor(() => existsSync(join(dir, `${id}.jsonl.opened`))), true, `${id} opened`);

    const panes = listPanes(tmux);
    assert.equal(panes.filter((pane) => pane.windowName === 'api').length, 2);
    assert.equal(panes.filter((pane) => pane.windowName === 'web').length, 1);

    const target = report.placed.find((placed) => placed.sessionId === 'c').pane;
    assert.deepEqual(jumpToPane(tmux, target, true), { kind: 'jumped' });
    assert.equal(tmux(['display-message', '-p', '-t', 'work:', '#{pane_id}']).trim(), target);
  } finally {
    try { tmux(['kill-server']); } catch { /* already gone */ }
  }
});
```

- [ ] **Step 3: Run the test**

Run: `node --test tests/work/tmux-integration.test.mjs`
Expected: PASS, or SKIP with `tmux is not installed`.

Then confirm that nothing is left behind. Check your own server's sessions before and after, and confirm the isolated socket is gone:

Run: `tmux -L work-test ls`
Expected: an error such as `no server running on /tmp/tmux-<uid>/work-test`.

- [ ] **Step 4: Commit**

```bash
git add tests/work/fixtures/fake-pi.sh tests/work/tmux-integration.test.mjs
git commit -m "test: exercise restore and jump on an isolated tmux server"
```

---

### Task 12: Part 1 documentation and release gates

**Files:**
- Modify: `README.md`: the `work` section

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces: documentation for sessions, child agents, restore, and the dashboard.

- [ ] **Step 1: Document sessions and the dashboard**

In `README.md`, in the `### work` section, replace the sentence that begins ``The same features are available from the shell through `bin/work.ts` `` with:

```markdown
The same features are available from the shell through `bin/work.ts` (`add`, `list`, `show`, `set`, `project`, `sync`, `triage`, `today`, `promote`, `undismiss`, `recap`, `restore`, `dash`, `export`, `import`). For example, use `alias work='node <package>/bin/work.ts'` and `alias todo='work add'`. Aliases do not reach tmux popups or hooks, so bindings should call a small `work` wrapper script on `PATH` instead.
```

Directly before the paragraph that begins ``Data lives in``, add:

````markdown
**Sessions.** Pi sessions register themselves in the work database automatically: their pane, window, file, and status. A run marks it `working`. When the run ends, it becomes `needs-me` with the last line of the reply as its note, unless the agent called the static `session_status` tool to declare `needs-me`, `waiting-external`, or `done` with a note. Sessions link to items automatically from `PI_WORK_ITEM` (set by `/task` when the request names an item), from PR head branches and Jira keys in the branch name, or from another session in the same worktree. Terminal sessions always register as top-level sessions, with no pane when they run outside tmux. `rpc` sessions register as headless. `print` and `json` runs register only as child agents, when `PI_WORK_PARENT_SESSION` names their parent. Children appear only under their parent.

**Dashboard.** `/dash` (or `work dash` in a terminal) opens a full-screen dashboard that leads with Decisions: sessions waiting on you, oldest first, plus pending triage. Waiting, Working, and Other sessions follow. Keys are vim-style (`j`/`k`, `gg`/`G`, `Ctrl-d`/`Ctrl-u`, `Tab`, `/` to filter, `?` for help). `Enter` jumps to a session's pane and closes the popup, reopens a crashed or closed session, opens triage, or shows a child's read-only transcript. `L` links a session to an item, `x` then `y` stops a child agent, and `D` then `y` deletes a closed record. A tmux binding such as `bind D display-popup -E -w 90% -h 90% 'work dash'` needs the wrapper script mentioned above.

**Restore.** After a reboot, `work restore --auto` (for example from `@resurrect-hook-post-restore-all`) reopens crashed terminal sessions that ran in tmux, from the last 7 days, and are not `done`. It types `pi --session <file>` into a matching restored shell pane, splits the window, or opens a new window. It runs at most once per boot, and the dashboard runs the same logic when it opens. `work restore --dry-run` prints the plan.
````

- [ ] **Step 2: Run the release gates**

Run: `npm test`
Expected: PASS, with 0 failures. The count is the baseline 356 plus the new tests.

Run: `npm run -s typecheck`
Expected: exit 0, no output.

Run: `npm run -s check`
Expected: `repository-boundary-ok files=<n>`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document work sessions, restore, and the dashboard"
```

- [ ] **Step 4: STOP for review (end of part 1)**

Report the gate results, the commits for Tasks 1–12, and every entry in `docs/superpowers/plans/2026-09-25-work-sessions-jobs-deviations.md`. Then wait for the user's review before starting part 2.

---

# Part 2: Jobs and Usage

### Task 13: Job types and store

**Files:**
- Modify: `src/work/types.ts`: job types
- Modify: `src/work/store.ts`: job methods, and the `job` table in backups
- Test: `tests/work/job-store.test.mjs`

**Interfaces:**
- Consumes: the `job` table from migration 2 (Task 1).
- Produces:
  - `JobKind = "cron" | "process"`, `JobHealth = "healthy" | "unhealthy" | "unknown"`, `JOB_KINDS`, `Job`, `JobInput`
  - `jobId(num): string` (`J-<n>`), `jobNum(id): number`
  - `store.registerJob(input: JobInput, actor): { job: Job; created: boolean }`. The same active name updates in place: omitted optional fields are kept, and `null` clears them. It writes one event per change.
  - `store.getJob(id)`, `store.listJobs({ activeOnly?: boolean })` (active by name first, then stopped, newest first)
  - `store.recordJobCheck(id, status, output): Job` (operational; output clipped to 200 characters)
  - `store.markJobStopped(id, actor): Job`, `store.deleteJob(id, actor): void` (stopped jobs only)

- [ ] **Step 1: Write the failing tests**

Create `tests/work/job-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const { exportJsonl, importJsonl } = await load('src/work/backup.ts');

const job = (overrides = {}) => ({ name: 'nightly-export', kind: 'cron', cwd: '/srv/export', ...overrides });

test('registering creates a job with one event, and the same name updates it in place', async () => {
  const now = clock();
  const store = await memoryStore(now);
  const item = store.addItem({ project: 'misc', title: 'Exports', origin: 'manual' }, 'user');
  const first = store.registerJob(job({ schedule: '0 3 * * *', checkCommand: 'test -f out.csv', ownerSession: 's1', itemId: item.id }), 'agent:s1');
  assert.equal(first.created, true);
  assert.equal(first.job.id, 'J-1');
  assert.deepEqual([first.job.schedule, first.job.checkCommand, first.job.ownerSession, first.job.itemId, first.job.stopCommand], ['0 3 * * *', 'test -f out.csv', 's1', 'W-1', null]);
  assert.deepEqual([store.listEvents().at(-1).entity, store.listEvents().at(-1).action, store.listEvents().at(-1).actor], ['job:J-1', 'create', 'agent:s1']);
  now.advance(1000);
  const events = store.listEvents().length;
  const again = store.registerJob(job({ stopCommand: 'crontab -l | grep -v export | crontab -' }), 'agent:s1');
  assert.equal(again.created, false);
  assert.equal(again.job.id, 'J-1');
  assert.equal(again.job.checkCommand, 'test -f out.csv');
  assert.equal(again.job.itemId, 'W-1');
  assert.equal(again.job.stopCommand, 'crontab -l | grep -v export | crontab -');
  assert.equal(store.listEvents().at(-1).action, 'update');
  assert.equal(store.listEvents().length, events + 1);
  store.registerJob(job(), 'agent:s1');
  assert.equal(store.listEvents().length, events + 1);
  assert.equal(store.registerJob(job({ checkCommand: null }), 'user').job.checkCommand, null);
});

test('a stopped job frees its name, and only stopped jobs can be deleted', async () => {
  const store = await memoryStore();
  store.registerJob(job(), 'user');
  assert.throws(() => store.deleteJob('J-1', 'user'), /Only stopped jobs/);
  const stopped = store.markJobStopped('J-1', 'user');
  assert.ok(stopped.stoppedAt);
  assert.equal(store.listEvents().at(-1).action, 'stop');
  assert.throws(() => store.markJobStopped('J-1', 'user'), /already stopped/);
  assert.equal(store.registerJob(job(), 'user').job.id, 'J-2');
  assert.deepEqual(store.listJobs().map((j) => j.id), ['J-2', 'J-1']);
  assert.deepEqual(store.listJobs({ activeOnly: true }).map((j) => j.id), ['J-2']);
  store.deleteJob('J-1', 'user');
  assert.equal(store.getJob('J-1'), undefined);
  assert.equal(store.listEvents().at(-1).action, 'delete');
});

test('registration is validated', async () => {
  const store = await memoryStore();
  assert.throws(() => store.registerJob(job({ kind: 'daemon' }), 'user'), /kind must be one of cron, process/);
  assert.throws(() => store.registerJob(job({ name: '  ' }), 'user'), /name must not be empty/);
  assert.throws(() => store.registerJob(job({ name: 'x'.repeat(81) }), 'user'), /at most 80/);
  assert.throws(() => store.registerJob(job({ pid: 0 }), 'user'), /positive integer/);
  assert.throws(() => store.registerJob(job({ pid: Number.NaN }), 'user'), /positive integer/);
  assert.throws(() => store.registerJob(job({ itemId: 'W-9' }), 'user'), /Unknown item/);
  assert.throws(() => store.getJob('W-1'), /Invalid job ID/);
});

test('check results are operational and clipped to 200 characters', async () => {
  const store = await memoryStore();
  store.registerJob(job(), 'user');
  const events = store.listEvents().length;
  const checked = store.recordJobCheck('J-1', 'unhealthy', 'e'.repeat(300));
  assert.equal(checked.lastCheckStatus, 'unhealthy');
  assert.equal(checked.lastCheckOutput.length, 200);
  assert.equal(checked.lastCheckAt, '2026-09-25T09:00:00.000Z');
  assert.equal(store.listEvents().length, events);
  assert.throws(() => store.recordJobCheck('J-9', 'healthy', ''), /Unknown job/);
});

test('jobs are included in backups', async () => {
  const source = await memoryStore();
  source.registerJob(job({ checkCommand: 'true' }), 'user');
  const path = join(tempDir(), 'backup.jsonl');
  exportJsonl(source, path);
  const target = await memoryStore();
  importJsonl(target, path);
  assert.deepEqual(target.listJobs(), source.listJobs());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/job-store.test.mjs`
Expected: FAIL with `store.registerJob is not a function`.

- [ ] **Step 3: Add the job types**

Append to `src/work/types.ts`:

```ts
export type JobKind = "cron" | "process";
export type JobHealth = "healthy" | "unhealthy" | "unknown";
export const JOB_KINDS: readonly JobKind[] = ["cron", "process"];

export type Job = {
	id: string;
	name: string;
	kind: JobKind;
	ownerSession: string | null;
	itemId: string | null;
	schedule: string | null;
	pid: number | null;
	cwd: string;
	checkCommand: string | null;
	stopCommand: string | null;
	logPath: string | null;
	lastCheckAt: string | null;
	lastCheckStatus: JobHealth | null;
	lastCheckOutput: string | null;
	createdAt: string;
	updatedAt: string;
	stoppedAt: string | null;
};

export type JobInput = {
	name: string;
	kind: JobKind;
	cwd: string;
	schedule?: string | null;
	pid?: number | null;
	checkCommand?: string | null;
	stopCommand?: string | null;
	logPath?: string | null;
	ownerSession?: string | null;
	itemId?: string | null;
};
```

- [ ] **Step 4: Implement the job store**

In `src/work/store.ts`, add `Job`, `JobHealth`, `JobInput`, and `JobKind` to the type import from `./types.ts`, and change the value import to `import { JOB_KINDS, NOTE_MAX } from "./types.ts";`.

Change `TABLES` to include `job` last, so restored jobs follow their items:

```ts
const TABLES = ["project", "item", "link", "signal", "candidate", "dismissal", "plan", "event", "connector_run", "meta", "job"] as const;
```

In `isEmpty`, change the table list to `["item", "link", "candidate", "plan", "dismissal", "job"]`.

After `sessionLinkKey`, add:

```ts
export function jobId(num: number): string {
	return `J-${num}`;
}

export function jobNum(id: string): number {
	const match = /^J-(\d+)$/.exec(id.trim());
	if (!match) throw new WorkStoreError(`Invalid job ID: ${id}`);
	return Number(match[1]);
}
```

After `toSession`, add:

```ts
function toJob(r: Row): Job {
	return {
		id: jobId(Number(r.num)),
		name: String(r.name),
		kind: r.kind as JobKind,
		ownerSession: text(r.owner_session),
		itemId: r.item_num === null || r.item_num === undefined ? null : itemId(Number(r.item_num)),
		schedule: text(r.schedule),
		pid: int(r.pid),
		cwd: String(r.cwd),
		checkCommand: text(r.check_command),
		stopCommand: text(r.stop_command),
		logPath: text(r.log_path),
		lastCheckAt: text(r.last_check_at),
		lastCheckStatus: text(r.last_check_status) as JobHealth | null,
		lastCheckOutput: text(r.last_check_output),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
		stoppedAt: text(r.stopped_at),
	};
}
```

Inside the class, directly before `// Connector runs and meta (operational: no events)`, add:

```ts
	// Jobs. Registering, stopping, and deleting are domain mutations; check results are operational.

	registerJob(input: JobInput, actor: Actor): { job: Job; created: boolean } {
		const name = requireText(input.name, "name");
		if (name.length > 80) throw new WorkStoreError("name must be at most 80 characters");
		if (!JOB_KINDS.includes(input.kind)) throw new WorkStoreError(`kind must be one of ${JOB_KINDS.join(", ")}`);
		const cwd = requireText(input.cwd, "cwd");
		if (input.pid !== undefined && input.pid !== null && (!Number.isInteger(input.pid) || input.pid < 1)) throw new WorkStoreError("pid must be a positive integer");
		return this.transaction(() => {
			if (input.itemId && !this.getItem(input.itemId)) throw new WorkStoreError(`Unknown item: ${input.itemId}`);
			const row = this.one("SELECT * FROM job WHERE name = ? AND stopped_at IS NULL", name);
			const before = row ? toJob(row) : undefined;
			const keep = <T>(value: T | null | undefined, previous: T | null | undefined): T | null => (value !== undefined ? value : (previous ?? null));
			const next = {
				kind: input.kind,
				ownerSession: keep(input.ownerSession, before?.ownerSession),
				itemId: keep(input.itemId, before?.itemId),
				schedule: keep(input.schedule, before?.schedule),
				pid: keep(input.pid, before?.pid),
				cwd,
				checkCommand: keep(input.checkCommand, before?.checkCommand),
				stopCommand: keep(input.stopCommand, before?.stopCommand),
				logPath: keep(input.logPath, before?.logPath),
			};
			const values: Param[] = [next.kind, next.ownerSession, next.itemId ? itemNum(next.itemId) : null, next.schedule, next.pid, next.cwd, next.checkCommand, next.stopCommand, next.logPath];
			const now = this.now();
			if (!before) {
				const result = this.run(
					"INSERT INTO job (name, kind, owner_session, item_num, schedule, pid, cwd, check_command, stop_command, log_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					name, ...values, now, now,
				);
				const job = this.getJob(jobId(result.lastInsertRowid)) as Job;
				this.event(actor, `job:${job.id}`, "create", { after: job });
				return { job, created: true };
			}
			if (JSON.stringify({ ...before, ...next }) === JSON.stringify(before)) return { job: before, created: false };
			this.run(
				"UPDATE job SET kind = ?, owner_session = ?, item_num = ?, schedule = ?, pid = ?, cwd = ?, check_command = ?, stop_command = ?, log_path = ?, updated_at = ? WHERE num = ?",
				...values, now, jobNum(before.id),
			);
			const job = this.getJob(before.id) as Job;
			this.event(actor, `job:${job.id}`, "update", { before, after: job });
			return { job, created: false };
		});
	}

	getJob(id: string): Job | undefined {
		const row = this.one("SELECT * FROM job WHERE num = ?", jobNum(id));
		return row ? toJob(row) : undefined;
	}

	listJobs(filter: { activeOnly?: boolean } = {}): Job[] {
		const where = filter.activeOnly ? " WHERE stopped_at IS NULL" : "";
		return this.all(`SELECT * FROM job${where} ORDER BY stopped_at IS NOT NULL, stopped_at DESC, name, num`).map(toJob);
	}

	recordJobCheck(id: string, status: JobHealth, output: string): Job {
		const changed = this.run("UPDATE job SET last_check_at = ?, last_check_status = ?, last_check_output = ? WHERE num = ?", this.now(), status, output.slice(0, NOTE_MAX), jobNum(id)).changes;
		if (changed === 0) throw new WorkStoreError(`Unknown job: ${id}`);
		return this.getJob(id) as Job;
	}

	markJobStopped(id: string, actor: Actor): Job {
		return this.transaction(() => {
			const before = this.getJob(id);
			if (!before) throw new WorkStoreError(`Unknown job: ${id}`);
			if (before.stoppedAt) throw new WorkStoreError(`${id} is already stopped`);
			const now = this.now();
			this.run("UPDATE job SET stopped_at = ?, updated_at = ? WHERE num = ?", now, now, jobNum(id));
			const after = this.getJob(id) as Job;
			this.event(actor, `job:${id}`, "stop", { before, after });
			return after;
		});
	}

	deleteJob(id: string, actor: Actor): void {
		this.transaction(() => {
			const before = this.getJob(id);
			if (!before) throw new WorkStoreError(`Unknown job: ${id}`);
			if (!before.stoppedAt) throw new WorkStoreError("Only stopped jobs can be deleted");
			this.run("DELETE FROM job WHERE num = ?", jobNum(id));
			this.event(actor, `job:${id}`, "delete", { before });
		});
	}

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/work/job-store.test.mjs tests/work/backup.test.mjs tests/work/store.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/work/types.ts src/work/store.ts tests/work/job-store.test.mjs
git commit -m "feat: add the job registry to the work store"
```

---

### Task 14: Health checks and stopping

**Files:**
- Create: `src/work/jobs.ts`
- Test: `tests/work/job-checks.test.mjs`

**Interfaces:**
- Consumes: `store.listJobs`, `recordJobCheck`, `markJobStopped` (Task 13). `pidAlive` (Task 2).
- Produces:
  - `CHECK_TIMEOUT_MS = 15000`, `OUTPUT_CAP = 65536`, `CHECK_STALE_MS = 60000`, `CHECK_CONCURRENCY = 4`
  - `ShellResult = { code: number | null; output: string; timedOut: boolean; error?: string }`
  - `ShellRunner = (command, cwd, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ShellResult>`, `runShell`. It runs `/bin/sh -c` with no stdin in its own process group, kills the group on timeout or abort, and caps output at 64 KB.
  - `summarize(output): string`, the first non-empty line, sanitized, at most 200 characters
  - `JobDeps = { run?: ShellRunner; pidAlive?: (pid) => boolean; kill?: (pid, signal) => void; concurrency?: number; signal?: AbortSignal }`
  - `checkJob(job, deps?): Promise<{ status: JobHealth; output: string }>`
  - `checkJobs(store, jobs, deps?): Promise<Job[]>` (input order; nothing is recorded after an abort)
  - `isStale(job, now, staleMs?)`, `checkStaleJobs(store, deps?)`
  - `stopJob(store, job, actor, deps?): Promise<{ job: Job; note: string }>`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/job-checks.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clock, load, memoryStore, tempDir } from './helpers.mjs';

const jobs = await load('src/work/jobs.ts');

const base = { id: 'J-1', name: 'n', kind: 'cron', ownerSession: null, itemId: null, schedule: null, pid: null, cwd: '/tmp', checkCommand: null, stopCommand: null, logPath: null, lastCheckAt: null, lastCheckStatus: null, lastCheckOutput: null, createdAt: 'x', updatedAt: 'x', stoppedAt: null };
const job = (overrides = {}) => ({ ...base, ...overrides });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('exit 0 is healthy, any other exit is unhealthy, and output is summarized to its first line', async () => {
  const cwd = tempDir();
  assert.deepEqual(await jobs.checkJob(job({ cwd, checkCommand: "printf '\\n  first line  \\nsecond\\n'" })), { status: 'healthy', output: 'first line' });
  assert.deepEqual(await jobs.checkJob(job({ cwd, checkCommand: 'echo boom >&2; exit 3' })), { status: 'unhealthy', output: 'boom' });
  assert.deepEqual(await jobs.checkJob(job({ cwd, checkCommand: 'exit 3' })), { status: 'unhealthy', output: 'exit 3' });
  assert.equal(jobs.summarize(`x\x1b[31m${'y'.repeat(300)}`).length, 200);
  assert.doesNotMatch(jobs.summarize('a\x1b[2Jb'), /\x1b/);
});

test('output is capped at 64 KB and there is no stdin', async () => {
  const cwd = tempDir();
  const big = await jobs.runShell("head -c 200000 /dev/zero | tr '\\0' a", cwd);
  assert.equal(big.output.length, jobs.OUTPUT_CAP);
  const stdin = await jobs.runShell('cat; echo done', cwd);
  assert.equal(stdin.output.trim(), 'done');
});

test('a timeout kills the whole process group and reports unknown', async () => {
  const cwd = tempDir();
  const pidFile = join(cwd, 'child.pid');
  const result = await jobs.runShell(`sleep 30 & echo $! > '${pidFile}'; wait`, cwd, { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false);
  const mapped = await jobs.checkJob(job({ checkCommand: 'x' }), { run: async () => ({ code: null, output: '', timedOut: true }) });
  assert.deepEqual(mapped, { status: 'unknown', output: 'check timed out after 15s' });
});

test('a spawn failure is unknown with the error', async () => {
  const result = await jobs.checkJob(job({ cwd: join(tempDir(), 'missing'), checkCommand: 'true' }));
  assert.equal(result.status, 'unknown');
  assert.match(result.output, /ENOENT/);
});

test('jobs without a check: a process is healthy while its PID lives, and cron stays unknown', async () => {
  const deps = { pidAlive: (pid) => pid === 7 };
  assert.deepEqual(await jobs.checkJob(job({ kind: 'process', pid: 7 }), deps), { status: 'healthy', output: 'pid 7 is running' });
  assert.deepEqual(await jobs.checkJob(job({ kind: 'process', pid: 8 }), deps), { status: 'unhealthy', output: 'pid 8 is not running' });
  assert.deepEqual(await jobs.checkJob(job({ kind: 'cron' }), deps), { status: 'unknown', output: 'no check command' });
});

test('at most 4 checks run at once, and results are recorded in input order', async () => {
  const store = await memoryStore();
  for (let i = 0; i < 10; i++) store.registerJob({ name: `job-${i}`, kind: 'cron', cwd: '/tmp', checkCommand: `check ${i}` }, 'user');
  let running = 0;
  let peak = 0;
  const run = async (command) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return { code: command.endsWith('3') ? 1 : 0, output: command, timedOut: false };
  };
  const checked = await jobs.checkJobs(store, store.listJobs(), { run });
  assert.equal(peak, 4);
  assert.deepEqual(checked.map((j) => j.name), store.listJobs().map((j) => j.name));
  assert.equal(store.listJobs().find((j) => j.name === 'job-3').lastCheckStatus, 'unhealthy');
});

test('only stale, active jobs are checked, and an aborted run records nothing', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.registerJob({ name: 'fresh', kind: 'cron', cwd: '/tmp', checkCommand: 'a' }, 'user');
  store.registerJob({ name: 'stale', kind: 'cron', cwd: '/tmp', checkCommand: 'b' }, 'user');
  store.registerJob({ name: 'gone', kind: 'cron', cwd: '/tmp', checkCommand: 'c' }, 'user');
  store.markJobStopped('J-3', 'user');
  store.recordJobCheck('J-2', 'healthy', '');
  now.advance(60_000);
  store.recordJobCheck('J-1', 'healthy', '');
  now.advance(59_000);
  assert.equal(jobs.isStale(store.getJob('J-1'), now()), false);
  assert.equal(jobs.isStale(store.getJob('J-2'), now()), true);
  const seen = [];
  await jobs.checkStaleJobs(store, { run: async (command) => { seen.push(command); return { code: 0, output: '', timedOut: false }; } });
  assert.deepEqual(seen, ['b']);
  const controller = new AbortController();
  controller.abort();
  const before = store.getJob('J-1').lastCheckAt;
  await jobs.checkJobs(store, [store.getJob('J-1')], { signal: controller.signal, run: async () => ({ code: 0, output: '', timedOut: false }) });
  assert.equal(store.getJob('J-1').lastCheckAt, before);
});

test('stopping runs the stop command, or sends SIGTERM to a process, and a failed stop changes nothing', async () => {
  const store = await memoryStore();
  store.registerJob({ name: 'with-stop', kind: 'cron', cwd: '/tmp', stopCommand: 'ok' }, 'user');
  store.registerJob({ name: 'failing', kind: 'cron', cwd: '/tmp', stopCommand: 'bad' }, 'user');
  store.registerJob({ name: 'proc', kind: 'process', cwd: '/tmp', pid: 4242 }, 'user');
  store.registerJob({ name: 'plain', kind: 'cron', cwd: '/tmp' }, 'user');
  const kills = [];
  const deps = {
    run: async (command) => (command === 'ok' ? { code: 0, output: '', timedOut: false } : { code: 2, output: 'permission denied\n', timedOut: false }),
    kill: (pid, signal) => kills.push([pid, signal]),
  };
  assert.ok((await jobs.stopJob(store, store.getJob('J-1'), 'user', deps)).job.stoppedAt);
  await assert.rejects(jobs.stopJob(store, store.getJob('J-2'), 'user', deps), /Stop command failed: permission denied/);
  assert.equal(store.getJob('J-2').stoppedAt, null);
  await jobs.stopJob(store, store.getJob('J-3'), 'user', deps);
  assert.deepEqual(kills, [[4242, 'SIGTERM']]);
  const gone = await jobs.stopJob(store, store.getJob('J-4'), 'user', deps);
  assert.match(gone.note, /no stop command/);
  const esrch = { kill: () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); } };
  store.registerJob({ name: 'exited', kind: 'process', cwd: '/tmp', pid: 4243 }, 'user');
  assert.match((await jobs.stopJob(store, store.getJob('J-5'), 'user', esrch)).note, /already exited/);
  await assert.rejects(jobs.stopJob(store, store.getJob('J-1'), 'user', deps), /already stopped/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/job-checks.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/jobs.ts`.

- [ ] **Step 3: Implement checks and stopping**

Create `src/work/jobs.ts`:

```ts
import { spawn } from "node:child_process";
import { pidAlive } from "./liveness.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, Job, JobHealth } from "./types.ts";
import { NOTE_MAX } from "./types.ts";

export const CHECK_TIMEOUT_MS = 15_000;
export const OUTPUT_CAP = 64 * 1024;
export const CHECK_STALE_MS = 60_000;
export const CHECK_CONCURRENCY = 4;

export type ShellResult = { code: number | null; output: string; timedOut: boolean; error?: string };
export type ShellRunner = (command: string, cwd: string, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ShellResult>;
export type CheckResult = { status: JobHealth; output: string };
export type JobDeps = {
	run?: ShellRunner;
	pidAlive?: (pid: number) => boolean;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	concurrency?: number;
	signal?: AbortSignal;
};

// Runs /bin/sh -c in its own process group with no stdin. A timeout or abort kills the whole group.
export const runShell: ShellRunner = (command, cwd, options = {}) =>
	new Promise((resolve) => {
		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		const finish = (result: ShellResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const killGroup = (): void => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group already exited.
			}
		};
		const onAbort = (): void => {
			killGroup();
			finish({ code: null, output, timedOut: false, error: "cancelled" });
		};
		try {
			child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		} catch (error) {
			resolve({ code: null, output: "", timedOut: false, error: errorMessage(error) });
			return;
		}
		const append = (chunk: Buffer): void => {
			if (output.length < OUTPUT_CAP) output += chunk.toString("utf8").slice(0, OUTPUT_CAP - output.length);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => finish({ code: null, output, timedOut: false, error: error.message }));
		child.on("close", (code) => finish({ code, output, timedOut: false }));
		timer = setTimeout(() => {
			killGroup();
			finish({ code: null, output, timedOut: true });
		}, options.timeoutMs ?? CHECK_TIMEOUT_MS);
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort);
	});

export function summarize(output: string): string {
	const line = output.split(/\r?\n/).map((part) => part.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()).find(Boolean) ?? "";
	return line.slice(0, NOTE_MAX);
}

export async function checkJob(job: Job, deps: JobDeps = {}): Promise<CheckResult> {
	if (!job.checkCommand) {
		if (job.kind === "process" && job.pid) {
			const alive = (deps.pidAlive ?? ((pid: number) => pidAlive(pid, null)))(job.pid);
			return alive ? { status: "healthy", output: `pid ${job.pid} is running` } : { status: "unhealthy", output: `pid ${job.pid} is not running` };
		}
		return { status: "unknown", output: "no check command" };
	}
	const result = await (deps.run ?? runShell)(job.checkCommand, job.cwd, { signal: deps.signal });
	if (result.error) return { status: "unknown", output: summarize(result.error) };
	if (result.timedOut) return { status: "unknown", output: `check timed out after ${CHECK_TIMEOUT_MS / 1000}s` };
	return { status: result.code === 0 ? "healthy" : "unhealthy", output: summarize(result.output) || `exit ${result.code}` };
}

export async function checkJobs(store: WorkStore, jobs: readonly Job[], deps: JobDeps = {}): Promise<Job[]> {
	const results: (Job | undefined)[] = new Array(jobs.length).fill(undefined);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < jobs.length) {
			const index = next++;
			const result = await checkJob(jobs[index], deps);
			if (deps.signal?.aborted) return;
			results[index] = store.recordJobCheck(jobs[index].id, result.status, result.output);
		}
	};
	await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? CHECK_CONCURRENCY, jobs.length) }, worker));
	return results.filter((job): job is Job => job !== undefined);
}

export function isStale(job: Job, now: Date, staleMs: number = CHECK_STALE_MS): boolean {
	return !job.lastCheckAt || now.getTime() - Date.parse(job.lastCheckAt) >= staleMs;
}

export function checkStaleJobs(store: WorkStore, deps: JobDeps = {}): Promise<Job[]> {
	const now = store.clock();
	return checkJobs(store, store.listJobs({ activeOnly: true }).filter((job) => isStale(job, now)), deps);
}

export async function stopJob(store: WorkStore, job: Job, actor: Actor, deps: JobDeps = {}): Promise<{ job: Job; note: string }> {
	if (job.stoppedAt) throw new Error(`${job.id} is already stopped`);
	let note = "";
	if (job.stopCommand) {
		const result = await (deps.run ?? runShell)(job.stopCommand, job.cwd);
		if (result.error || result.timedOut || result.code !== 0) {
			const reason = summarize(result.error ?? result.output) || (result.timedOut ? "timed out" : `exit ${result.code}`);
			throw new Error(`Stop command failed: ${reason}`);
		}
	} else if (job.kind === "process" && job.pid) {
		const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => {
			process.kill(pid, signal);
		});
		try {
			kill(job.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			note = "; it had already exited";
		}
	} else {
		note = "; no stop command, so only the record changed";
	}
	return { job: store.markJobStopped(job.id, actor), note };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/work/job-checks.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/jobs.ts tests/work/job-checks.test.mjs
git commit -m "feat: run job health checks and stop jobs"
```

---

### Task 15: `job_register` and `work job`

**Files:**
- Modify: `src/work/jobs.ts`: `registerAgentJob` and `formatJob`
- Modify: `extensions/work.ts`: the static `job_register` tool
- Modify: `src/work/cli.ts`: `parseFlags` and the `job` command
- Test: `tests/work/job-register.test.mjs`

**Interfaces:**
- Consumes: `store.registerJob`, `getJob`, `listJobs` (Task 13). `checkJobs` (Task 14). `store.sessionLink` (Task 1). `formatAge` (Task 8).
- Produces:
  - `JobRegisterParams = { name; kind: JobKind; cwd; schedule?; pid?; check_command?; stop_command?; log_path?; relates_to? }`
  - `registerAgentJob(store, params, sessionId): { job; created; message }`. The owner is the calling session. The item is `relates_to` when it names an existing item, and otherwise the session's linked item. The actor is `agent:<sessionId>`.
  - `formatJob(job, now): string`
  - `JOB_REGISTER_DESCRIPTION`, and the tool `job_register`
  - `parseFlags(args, allowed): Record<string, string>`
  - `work job` (list), `work job add --name … --kind … [--cwd …] [--schedule …] [--pid …] [--check …] [--stop …] [--log …] [--item W-n]`, and `work job check [J-n]`

- [ ] **Step 1: Write the failing tests**

Create `tests/work/job-register.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { captureIo, load, memoryRuntime, tempDir } from './helpers.mjs';

const { createWorkExtension, JOB_REGISTER_DESCRIPTION } = await load('extensions/work.ts');
const { registerAgentJob, formatJob } = await load('src/work/jobs.ts');
const { runCli, parseFlags } = await load('src/work/cli.ts');

async function cli(rt, argv, cwd = '/srv') {
  const io = captureIo();
  const code = await runCli(argv, { runtime: () => rt, io: io.io, cwd, env: {}, repoFromCwd: () => undefined });
  return { code, ...io };
}

test('registerAgentJob fills the owner and item from the session, and relates_to overrides the item', async () => {
  const rt = await memoryRuntime();
  const a = rt.store.addItem({ project: 'misc', title: 'A', origin: 'manual' }, 'user');
  const b = rt.store.addItem({ project: 'misc', title: 'B', origin: 'manual' }, 'user');
  rt.store.startSession({ id: 's1', file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: true });
  rt.store.linkSession('s1', a.id, 'env', 'session:s1');
  const first = registerAgentJob(rt.store, { name: 'dev-server', kind: 'process', cwd: '/src/api', pid: 4242, check_command: 'curl -fs localhost:8080/health' }, 's1');
  assert.equal(first.created, true);
  assert.deepEqual([first.job.ownerSession, first.job.itemId, first.job.pid, first.job.checkCommand], ['s1', 'W-1', 4242, 'curl -fs localhost:8080/health']);
  assert.equal(rt.store.listEvents().at(-1).actor, 'agent:s1');
  assert.match(first.message, /^Registered J-1 dev-server\./);
  const second = registerAgentJob(rt.store, { name: 'dev-server', kind: 'process', cwd: '/src/api', relates_to: b.id }, 's1');
  assert.equal(second.created, false);
  assert.equal(second.job.itemId, 'W-2');
  assert.equal(second.job.checkCommand, 'curl -fs localhost:8080/health');
  assert.match(registerAgentJob(rt.store, { name: 'other', kind: 'cron', cwd: '/', relates_to: 'W-99' }, 's1').message, /ignored unknown item W-99/);
});

test('job_register is static and registers for the calling session', async () => {
  const rt = await memoryRuntime();
  const tools = new Map();
  createWorkExtension({ runtime: () => rt, env: {}, git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter() })({
    registerCommand() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    on() {},
  });
  const tool = tools.get('job_register');
  assert.equal(tool.description, JOB_REGISTER_DESCRIPTION);
  assert.equal(Object.hasOwn(tool, 'promptSnippet'), false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['check_command', 'cwd', 'kind', 'log_path', 'name', 'pid', 'relates_to', 'schedule', 'stop_command']);
  const ctx = { sessionManager: { getSessionId: () => 'sess-9' } };
  const result = await tool.execute('c1', { name: 'nightly', kind: 'cron', cwd: '/srv', schedule: '0 3 * * *' }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { jobId: 'J-1', created: true });
  assert.equal(rt.store.getJob('J-1').ownerSession, 'sess-9');
});

test('work job add, list, and check', async () => {
  const rt = await memoryRuntime();
  const dir = tempDir();
  const added = await cli(rt, ['job', 'add', '--name', 'ok-check', '--kind', 'cron', '--schedule', '*/5 * * * *', '--check', 'echo fine']);
  assert.deepEqual([added.code, added.out], [0, ['Added J-1 ok-check']]);
  assert.equal(rt.store.getJob('J-1').cwd, '/srv');
  await cli(rt, ['job', 'add', '--name', 'bad-check', '--kind', 'cron', '--cwd', dir, '--check', 'echo broken; exit 1']);
  assert.equal(rt.store.getJob('J-2').cwd, dir);
  const listed = await cli(rt, ['job']);
  assert.match(listed.out[0].split('\n')[0], /^J-2 +unchecked +bad-check {2}cron {2}never checked$/);
  rt.store.registerJob({ name: 'ok-check', kind: 'cron', cwd: dir }, 'user');
  const checked = await cli(rt, ['job', 'check']);
  assert.equal(checked.code, 0);
  const lines = checked.out[0].split('\n');
  assert.match(lines[0], /^J-2 +unhealthy +bad-check {2}cron {2}checked 0s ago: broken$/);
  assert.match(lines[1], /^J-1 +healthy +ok-check {2}cron \*\/5 \* \* \* \* {2}checked 0s ago: fine$/);
  const one = await cli(rt, ['job', 'check', 'J-1']);
  assert.equal(one.out[0].split('\n').length, 1);
  const bad = await cli(rt, ['job', 'add', '--name', 'x']);
  assert.equal(bad.code, 1);
  assert.match(bad.err[0], /Usage: work job add/);
  const unknown = await cli(rt, ['job', 'check', 'J-9']);
  assert.match(unknown.err[0], /Unknown job: J-9/);
});

test('parseFlags and formatJob', () => {
  assert.deepEqual(parseFlags(['--name', 'a b', '--kind', 'cron'], ['name', 'kind']), { name: 'a b', kind: 'cron' });
  assert.throws(() => parseFlags(['--nope', 'x'], ['name']), /Unknown option: --nope/);
  assert.throws(() => parseFlags(['--name'], ['name']), /--name needs a value/);
  const now = new Date('2026-09-25T09:10:00.000Z');
  const stopped = { id: 'J-3', name: 'old', kind: 'process', schedule: null, stoppedAt: '2026-09-25T09:00:00.000Z', lastCheckAt: '2026-09-25T09:05:00.000Z', lastCheckStatus: 'healthy', lastCheckOutput: 'pid 1 is running' };
  assert.equal(formatJob(stopped, now), 'J-3   stopped   old  process  checked 5m ago: pid 1 is running');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/job-register.test.mjs`
Expected: FAIL. `registerAgentJob` is not exported, and there is no `job_register` tool.

- [ ] **Step 3: Implement agent registration and formatting**

In `src/work/jobs.ts`, change the type import to `import type { Actor, Job, JobHealth, JobKind } from "./types.ts";`, add `import { formatAge } from "./dash/text.ts";`, and append:

```ts
export type JobRegisterParams = {
	name: string;
	kind: JobKind;
	cwd: string;
	schedule?: string;
	pid?: number;
	check_command?: string;
	stop_command?: string;
	log_path?: string;
	relates_to?: string;
};

export function registerAgentJob(store: WorkStore, params: JobRegisterParams, sessionId: string): { job: Job; created: boolean; message: string } {
	let itemId = store.sessionLink(sessionId)?.itemId ?? null;
	let note = "";
	if (params.relates_to) {
		let found: string | undefined;
		try {
			found = store.getItem(params.relates_to)?.id;
		} catch {
			found = undefined;
		}
		if (found) itemId = found;
		else note = ` (ignored unknown item ${params.relates_to})`;
	}
	const { job, created } = store.registerJob({
		name: params.name,
		kind: params.kind,
		cwd: params.cwd,
		schedule: params.schedule,
		pid: params.pid,
		checkCommand: params.check_command,
		stopCommand: params.stop_command,
		logPath: params.log_path,
		ownerSession: sessionId,
		itemId,
	}, `agent:${sessionId}`);
	return { job, created, message: `${created ? "Registered" : "Updated"} ${job.id} ${job.name}.${note} The user sees its health on the work dashboard.` };
}

export function formatJob(job: Pick<Job, "id" | "name" | "kind" | "schedule" | "stoppedAt" | "lastCheckAt" | "lastCheckStatus" | "lastCheckOutput">, now: Date): string {
	const health = job.stoppedAt ? "stopped" : (job.lastCheckStatus ?? "unchecked");
	const when = job.lastCheckAt ? `checked ${formatAge(now.getTime() - Date.parse(job.lastCheckAt))} ago` : "never checked";
	return `${job.id.padEnd(5)} ${health.padEnd(9)} ${job.name}  ${job.kind}${job.schedule ? ` ${job.schedule}` : ""}  ${when}${job.lastCheckOutput ? `: ${job.lastCheckOutput}` : ""}`;
}
```

Note that the message places `note` after the period: `Registered J-1 dev-server. (ignored unknown item W-99) The user sees …`. The first test's `/^Registered J-1 dev-server\./` pattern covers this.

- [ ] **Step 4: Register the tool**

In `extensions/work.ts`, add `import { registerAgentJob } from "../src/work/jobs.ts";`, and add `JOB_KINDS` to the `../src/work/types.ts` import. After `SESSION_STATUS_DESCRIPTION`, add:

```ts
export const JOB_REGISTER_DESCRIPTION = "Register a background job you started, such as a cron entry or a long-running process, so the user can see its health on the work dashboard. Give a check_command that exits 0 when the job is healthy, and a stop_command when stopping needs more than SIGTERM to pid. Registering the same name again updates the job.";
```

Register the tool after `session_status`:

```ts
		pi.registerTool({
			name: "job_register",
			label: "Job Register",
			description: JOB_REGISTER_DESCRIPTION,
			parameters: Type.Object({
				name: Type.String({ minLength: 1, maxLength: 80 }),
				kind: StringEnum([...JOB_KINDS] as const),
				cwd: Type.String({ minLength: 1 }),
				schedule: Type.Optional(Type.String({ maxLength: 100 })),
				pid: Type.Optional(Type.Integer({ minimum: 1 })),
				check_command: Type.Optional(Type.String({ maxLength: 1000 })),
				stop_command: Type.Optional(Type.String({ maxLength: 1000 })),
				log_path: Type.Optional(Type.String({ maxLength: 500 })),
				relates_to: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = registerAgentJob(rt().store, params, ctx.sessionManager.getSessionId());
				return { content: [{ type: "text", text: result.message }], details: { jobId: result.job.id, created: result.created } };
			},
		});
```

- [ ] **Step 5: Add `work job`**

In `src/work/cli.ts`, add:

```ts
import { checkJobs, formatJob } from "./jobs.ts";
```

Add `Job` and `JobKind` to the `./types.ts` type import. After `parseBoolean`, add:

```ts
export function parseFlags(args: string[], allowed: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i += 2) {
		const match = /^--([a-z]+)$/.exec(args[i]);
		if (!match || !allowed.includes(match[1])) throw new UsageError(`Unknown option: ${args[i]}`);
		const value = args[i + 1];
		if (value === undefined) throw new UsageError(`--${match[1]} needs a value`);
		out[match[1]] = value;
	}
	return out;
}
```

Add this command after `dash`:

```ts
const JOB_USAGE = "Usage: work job add --name <name> --kind cron|process [--cwd <dir>] [--schedule <cron>] [--pid <n>] [--check <cmd>] [--stop <cmd>] [--log <path>] [--item W-n]";

const job: CliCommand = {
	usage: "job [add --name <n> --kind <k> ... | check [J-n]]   List, register, or check background jobs",
	async run(args, deps) {
		const rt = deps.runtime();
		const [action, ...rest] = args;
		if (!action) {
			const jobs = rt.store.listJobs();
			deps.io.out(jobs.length ? jobs.map((j) => formatJob(j, rt.store.clock())).join("\n") : "No jobs");
			return 0;
		}
		if (action === "add") {
			const flags = parseFlags(rest, ["name", "kind", "cwd", "schedule", "pid", "check", "stop", "log", "item"]);
			if (!flags.name || !flags.kind) throw new UsageError(JOB_USAGE);
			const { job: registered, created } = rt.store.registerJob({
				name: flags.name,
				kind: flags.kind as JobKind,
				cwd: flags.cwd ?? deps.cwd,
				schedule: flags.schedule,
				pid: flags.pid === undefined ? undefined : Number(flags.pid),
				checkCommand: flags.check,
				stopCommand: flags.stop,
				logPath: flags.log,
				itemId: flags.item,
			}, "user");
			deps.io.out(`${created ? "Added" : "Updated"} ${registered.id} ${registered.name}`);
			return 0;
		}
		if (action === "check") {
			const targets: Job[] = [];
			if (rest[0]) {
				const one = rt.store.getJob(rest[0]);
				if (!one) throw new UsageError(`Unknown job: ${rest[0]}`);
				targets.push(one);
			} else {
				targets.push(...rt.store.listJobs({ activeOnly: true }));
			}
			const checked = await checkJobs(rt.store, targets);
			deps.io.out(checked.length ? checked.map((j) => formatJob(j, rt.store.clock())).join("\n") : "No jobs to check");
			return 0;
		}
		throw new UsageError(JOB_USAGE);
	},
};
```

In `COMMANDS`, add `job,` after `dash,`.

`runCli` passes each `io.out` call through as one string, so the tests split multi-line output. Active jobs are listed by name (`bad-check`, then `ok-check`), so `J-2` prints first.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/work/job-register.test.mjs tests/work/cli.test.mjs tests/work/extension.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/work/jobs.ts src/work/cli.ts extensions/work.ts tests/work/job-register.test.mjs
git commit -m "feat: register jobs from agents and the work CLI"
```

---

### Task 16: Jobs in the dashboard and the planner snapshot

**Files:**
- Modify: `src/work/jobs.ts`: `jobDetails`
- Modify: `src/work/dash/model.ts` and `src/work/dash/view.ts`: full replacements below
- Modify: `src/work/dash/app.ts`: job keys, details, and background checks
- Modify: `src/work/snapshot.ts`: `jobs` in the planner snapshot
- Modify: `tests/work/dash-view.test.mjs` (the Jobs section is now always present), `tests/work/dash-app.test.mjs`, and `tests/work/snapshot.test.mjs`

**Interfaces:**
- Consumes: `store.listJobs`, `deleteJob` (Task 13). `checkJobs`, `checkStaleJobs`, `stopJob`, `JobDeps` (Task 14).
- Produces:
  - `jobDetails(store, job, now): string`
  - `DashRow` gains `{ kind: "job"; key: "job:<id>"; job }` and `{ kind: "alert"; key: "alert:<id>"; job }`. `DashInput.jobs?: readonly Job[]`. The sections are now `decisions`, `waiting`, `working`, `jobs`, and `other`.
  - `DashDeps.jobs?: JobDeps`. `MAIN_ACTIONS = ["L", "c", "x", "D", "R", "?"]`.
  - `Snapshot.jobs: { id; kind; external_name; status; checked_at }[]` (active jobs; the snapshot never runs checks)

Layout additions: Decisions ends with one `alert` row per active `unhealthy` job. The Jobs section lists every job, with active jobs by name, then stopped jobs (dimmed), newest first. Job rows use their own column widths: name (capped at 20, or 32 when wide), schedule or kind (12, or 20 when wide), and check age (4). The label shows health (`healthy`, `unhealthy`, `unknown`, or `stopped`), and the note is the check summary.

Keys on job rows: `Enter` shows details (commands, owner, item, last output). `c` checks now in the background. `x` then `y` stops the job (`stopJob`). `D` then `y` deletes a stopped job. When the dashboard opens, and on `R`, stale checks (older than 60 seconds) run in the background, at most 4 at a time. Closing the dashboard aborts in-flight checks.

- [ ] **Step 1: Update the part 1 view tests for the always-present Jobs section**

In `tests/work/dash-view.test.mjs`:
- In the first test, change the section ID list to `['decisions', 'waiting', 'working', 'jobs', 'other']`, add `assert.deepEqual(m.sections[3].rows, []);`, and change `m.sections[3].rows.map((r) => r.key)` to `m.sections[4].rows.map((r) => r.key)`.
- In the child test, change `m.sections[3]` to `m.sections[4]`.
- In the 80-column, 160-column, and filter frames, insert `'Jobs (0)',` directly after `'Working (0)',`. In the `launch` filter check, change `assert.equal(byTitle.length, 8)` to `9`.
- In the ANSI test, change `lines[11]` to `lines[12]`.

Append:

```js
const jobEntry = (overrides) => ({
  id: 'J-1', name: 'n', kind: 'cron', ownerSession: null, itemId: null, schedule: null, pid: null, cwd: '/srv', checkCommand: null, stopCommand: null, logPath: null,
  lastCheckAt: null, lastCheckStatus: null, lastCheckOutput: null, createdAt: ago(9000), updatedAt: ago(9000), stoppedAt: null, ...overrides,
});
const JOBS = [
  jobEntry({ id: 'J-2', name: 'dev-server', kind: 'process', lastCheckAt: ago(1), lastCheckStatus: 'unhealthy', lastCheckOutput: 'connection refused' }),
  jobEntry({ id: 'J-1', name: 'nightly-export', schedule: '0 3 * * *', lastCheckAt: ago(5), lastCheckStatus: 'healthy', lastCheckOutput: 'wrote 1204 rows' }),
  jobEntry({ id: 'J-3', name: 'old-sync', stoppedAt: ago(60), lastCheckAt: ago(2880), lastCheckStatus: 'healthy', lastCheckOutput: 'ok' }),
];

test('unhealthy jobs are decisions, and the Jobs section uses its own columns', () => {
  const m = buildDashModel({ sessions: [], triageCount: 0, jobs: JOBS, now: NOW });
  assert.deepEqual(m.sections[0].rows.map((r) => r.key), ['alert:J-2']);
  assert.deepEqual(m.sections[3].rows.map((r) => r.key), ['job:J-2', 'job:J-1', 'job:J-3']);
  assert.deepEqual(plain(renderDash(m, state({ selected: 'alert:J-2' }), 80, 24, plainStyle)).slice(0, 10), [
    'Work dashboard',
    'Decisions (1)',
    '> unhealthy  dev-server      process    1m  connection refused',
    'Waiting (0)',
    'Working (0)',
    'Jobs (3)',
    '  unhealthy  dev-server      process    1m  connection refused',
    '  healthy    nightly-export  0 3 * * *  5m  wrote 1204 rows',
    '  stopped    old-sync        cron       2d  ok',
    'Other sessions (0)',
  ]);
  const colored = renderDash(m, state({ selected: null }), 80, 24, ansiStyle);
  assert.ok(colored[2].startsWith('\x1b[31m'));
  assert.ok(colored[8].startsWith('\x1b[2m'));
});
```

In `tests/work/dash-app.test.mjs`, change `open` so that it accepts and forwards fake job dependencies, and never runs real shell checks:

```js
function open(rt, { insideTmux = true, kills = [], run = async () => ({ code: 0, output: 'ok', timedOut: false }) } = {}) {
  const terminal = fakeTerminal();
  const calls = [];
  const ran = [];
  const result = runDash({
    runtime: rt, terminal, tmux: tmuxFake(calls), insideTmux, readers: alive(11, 13), style: plainStyle, refreshMs: 0,
    bootId: () => 'boot-1', fileExists: () => true, kill: (pid, signal) => kills.push([pid, signal]),
    jobs: { run: async (command, ...rest) => { ran.push(command); return run(command, ...rest); }, pidAlive: () => true },
  });
  return { terminal, calls, result, kills, ran };
}
```

Append to `tests/work/dash-app.test.mjs`:

```js
async function jobFixture() {
  const { rt, store } = await fixture();
  store.registerJob({ name: 'dev-server', kind: 'process', cwd: '/src/api', pid: 4242, checkCommand: 'curl -fs localhost:8080', stopCommand: 'kill-dev', ownerSession: 'live-1' }, 'agent:live-1');
  store.recordJobCheck('J-1', 'unhealthy', 'connection refused');
  store.registerJob({ name: 'old-sync', kind: 'cron', cwd: '/srv' }, 'user');
  store.recordJobCheck('J-2', 'healthy', 'ok');
  store.markJobStopped('J-2', 'user');
  return { rt, store };
}

test('an unhealthy job is a decision, and Enter shows its details', async () => {
  const { rt } = await jobFixture();
  const d = open(rt);
  assert.match(d.terminal.screen()[4], /^ {2}unhealthy\s+dev-server\s+process\s+0s\s+connection refused$/);
  d.terminal.send('j', 'j', '\r');
  await tick();
  const screen = d.terminal.screen();
  assert.equal(screen[0], 'Job J-1');
  assert.ok(screen.includes('check: curl -fs localhost:8080'));
  assert.ok(screen.includes('registered by: session live-1 (window sap-rfc)'));
  assert.deepEqual(d.ran, []);
  d.terminal.send('q');
  await tick();
  d.terminal.send('q');
  await d.result;
});

test('c checks the selected job in the background', async () => {
  const { rt, store } = await jobFixture();
  const d = open(rt, { run: async () => ({ code: 0, output: 'up\n', timedOut: false }) });
  d.terminal.send('j', 'j', 'j', 'c');
  await tick();
  await tick();
  assert.deepEqual(d.ran, ['curl -fs localhost:8080']);
  assert.equal(store.getJob('J-1').lastCheckStatus, 'healthy');
  assert.equal(d.terminal.screen().at(-1), 'J-1 healthy: up');
  assert.equal(d.terminal.screen().some((line) => line.startsWith('  unhealthy')), false);
  d.terminal.send('q');
  await d.result;
});

test('x then y stops a job with its stop command; D then y deletes only stopped jobs', async () => {
  const { rt, store } = await jobFixture();
  const d = open(rt);
  d.terminal.send('j', 'j', 'j', 'D');
  assert.equal(d.terminal.screen().at(-1), 'Stop the job before deleting it');
  d.terminal.send('x');
  assert.match(d.terminal.screen().at(-1), /^Stop J-1 dev-server\? y to confirm/);
  d.terminal.send('y');
  await tick();
  assert.deepEqual(d.ran, ['kill-dev']);
  assert.ok(store.getJob('J-1').stoppedAt);
  assert.equal(d.terminal.screen().at(-1), 'Stopped J-1 dev-server');
  d.terminal.send('G', 'k', 'D', 'y');
  await tick();
  assert.equal(store.getJob('J-2'), undefined);
  d.terminal.send('q');
  await d.result;
});

test('opening the dashboard checks stale jobs in the background', async () => {
  const { rt, store } = await jobFixture();
  rt.store.clock.advance?.(61_000);
  const d = open(rt, { run: async () => ({ code: 7, output: 'still down', timedOut: false }) });
  await tick();
  await tick();
  assert.deepEqual(d.ran, ['curl -fs localhost:8080']);
  assert.equal(store.getJob('J-1').lastCheckOutput, 'still down');
  d.terminal.send('q');
  await d.result;
});
```

`memoryRuntime({ now: clock() })` passes a helper clock with `advance`, so `rt.store.clock.advance` exists.

Append to `tests/work/snapshot.test.mjs`:

```js
test('the snapshot lists active jobs with their last known status', async () => {
  const store = await memoryStore();
  store.registerJob({ name: 'nightly', kind: 'cron', cwd: '/srv', checkCommand: 'exit 1' }, 'user');
  store.recordJobCheck('J-1', 'unhealthy', 'boom');
  store.registerJob({ name: 'idle', kind: 'cron', cwd: '/srv' }, 'user');
  store.registerJob({ name: 'gone', kind: 'cron', cwd: '/srv' }, 'user');
  store.markJobStopped('J-3', 'user');
  const snap = buildSnapshot(store, new Date('2026-09-25T09:00:00.000Z'));
  assert.deepEqual(snap.jobs, [
    { id: 'J-2', kind: 'cron', external_name: 'idle', status: 'unknown', checked_at: null },
    { id: 'J-1', kind: 'cron', external_name: 'nightly', status: 'unhealthy', checked_at: '2026-09-25T09:00:00.000Z' },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/dash-view.test.mjs tests/work/dash-app.test.mjs tests/work/snapshot.test.mjs`
Expected: FAIL. There is no Jobs section yet, and `snap.jobs` is `undefined`.

- [ ] **Step 3: Add job details**

Append to `src/work/jobs.ts`:

```ts
export function jobDetails(store: WorkStore, job: Job, now: Date): string {
	const owner = job.ownerSession ? store.getSession(job.ownerSession) : undefined;
	const item = job.itemId ? store.getItem(job.itemId) : undefined;
	const status = job.stoppedAt ? `stopped at ${job.stoppedAt}` : (job.lastCheckStatus ?? "unknown");
	const checked = job.lastCheckAt ? `, checked ${formatAge(now.getTime() - Date.parse(job.lastCheckAt))} ago` : ", never checked";
	const stop = job.stopCommand ?? (job.kind === "process" && job.pid ? `SIGTERM to pid ${job.pid}` : "-");
	const owned = job.ownerSession ? `session ${job.ownerSession}${owner?.tmuxWindow ? ` (window ${owner.tmuxWindow})` : ""}` : "user";
	return [
		`${job.name} (${job.kind}${job.schedule ? `, ${job.schedule}` : ""})`,
		`status: ${status}${checked}`,
		`last output: ${job.lastCheckOutput ?? "-"}`,
		`cwd: ${job.cwd}`,
		`check: ${job.checkCommand ?? "-"}`,
		`stop: ${stop}`,
		`pid: ${job.pid ?? "-"}`,
		`log: ${job.logPath ?? "-"}`,
		`registered by: ${owned}`,
		`item: ${item ? `${item.id} ${item.title}` : "-"}`,
		`created: ${job.createdAt}`,
		`updated: ${job.updatedAt}`,
	].join("\n");
}
```

- [ ] **Step 4: Replace the model**

Replace `src/work/dash/model.ts` with:

```ts
import type { PidReaders, ProbedSession } from "../liveness.ts";
import { probeSessions } from "../liveness.ts";
import type { WorkStore } from "../store.ts";
import type { TmuxPane } from "../tmux.ts";
import type { Job, Session } from "../types.ts";

export type SectionId = "decisions" | "waiting" | "working" | "jobs" | "other";
export type SessionEntry = ProbedSession & { itemId: string | null; itemTitle: string | null };
export type DashRow =
	| { kind: "session"; key: string; session: SessionEntry; depth: 0 | 1 }
	| { kind: "triage"; key: string; count: number }
	| { kind: "job"; key: string; job: Job }
	| { kind: "alert"; key: string; job: Job };
export type DashSection = { id: SectionId; title: string; rows: DashRow[] };
export type DashModel = { sections: DashSection[]; now: Date };
export type DashInput = { sessions: readonly SessionEntry[]; triageCount: number; jobs?: readonly Job[]; now: Date };

export const RECENT_MS = 7 * 86_400_000;

export function lastActivity(session: Session): string {
	return session.lastTurnAt ?? session.startedAt;
}

export function loadSessions(store: WorkStore, panes: readonly TmuxPane[] | undefined, readers?: PidReaders): SessionEntry[] {
	return probeSessions(store.listSessions(), panes, readers).map((session) => {
		const link = store.sessionLink(session.id);
		const item = link ? store.getItem(link.itemId) : undefined;
		return { ...session, itemId: item?.id ?? null, itemTitle: item?.title ?? null };
	});
}

const byStatusAt = (a: Session, b: Session): number => a.statusAt.localeCompare(b.statusAt) || a.id.localeCompare(b.id);
const byStart = (a: Session, b: Session): number => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
const byRecentActivity = (a: Session, b: Session): number => lastActivity(b).localeCompare(lastActivity(a)) || a.id.localeCompare(b.id);

export function buildDashModel(input: DashInput): DashModel {
	const cutoff = input.now.getTime() - RECENT_MS;
	const sessions = input.sessions.filter((s) => s.liveness === "live" || Date.parse(lastActivity(s)) >= cutoff);
	const children = new Map<string, SessionEntry[]>();
	for (const session of sessions) {
		if (session.parentSession) children.set(session.parentSession, [...(children.get(session.parentSession) ?? []), session]);
	}
	const placed = new Set<string>();
	const rows = (list: readonly SessionEntry[]): DashRow[] => list.flatMap((session) => {
		placed.add(session.id);
		const kids = [...(children.get(session.id) ?? [])].sort(byStart);
		for (const kid of kids) placed.add(kid.id);
		return [
			{ kind: "session" as const, key: `session:${session.id}`, session, depth: 0 as const },
			...kids.map((kid) => ({ kind: "session" as const, key: `session:${kid.id}`, session: kid, depth: 1 as const })),
		];
	});

	const top = sessions.filter((s) => !s.parentSession);
	const live = top.filter((s) => s.liveness === "live");
	const jobs = input.jobs ?? [];
	const decisions = rows(live.filter((s) => s.status === "needs-me").sort(byStatusAt));
	if (input.triageCount > 0) decisions.push({ kind: "triage", key: "triage", count: input.triageCount });
	for (const job of jobs) {
		if (!job.stoppedAt && job.lastCheckStatus === "unhealthy") decisions.push({ kind: "alert", key: `alert:${job.id}`, job });
	}
	const waiting = rows(live.filter((s) => s.status === "waiting-external").sort(byStatusAt));
	const working = rows(live.filter((s) => s.status === "working").sort(byStatusAt));
	const jobRows: DashRow[] = jobs.map((job) => ({ kind: "job", key: `job:${job.id}`, job }));
	const done = live.filter((s) => s.status === "done").sort((a, b) => byStatusAt(b, a));
	const ended = top.filter((s) => s.liveness !== "live").sort(byRecentActivity);
	const other = rows([...done, ...ended]);
	const orphans = sessions.filter((s) => s.parentSession && !placed.has(s.id)).sort(byRecentActivity);
	other.push(...orphans.map((session) => ({ kind: "session" as const, key: `session:${session.id}`, session, depth: 0 as const })));

	return {
		now: input.now,
		sections: [
			{ id: "decisions", title: "Decisions", rows: decisions },
			{ id: "waiting", title: "Waiting", rows: waiting },
			{ id: "working", title: "Working", rows: working },
			{ id: "jobs", title: "Jobs", rows: jobRows },
			{ id: "other", title: "Other sessions", rows: other },
		],
	};
}

export function allRows(model: DashModel): DashRow[] {
	return model.sections.flatMap((section) => section.rows);
}
```

`store.listJobs()` already returns active jobs by name, then stopped jobs newest first, so the model keeps that order.

- [ ] **Step 5: Replace the view**

Replace `src/work/dash/view.ts` with:

```ts
import { basename } from "node:path";
import type { DashModel, DashRow, SessionEntry } from "./model.ts";
import { allRows, lastActivity } from "./model.ts";
import type { Style } from "./text.ts";
import { fit, formatAge, oneLine, sanitize, truncate, visibleWidth } from "./text.ts";

export type ViewState = { selected: string | null; filter: string; editing: boolean; message: string };
export type Cells = { label: string; window: string; item: string; age: string; note: string };
type Widths = { window: number; item: number; age: number };
type Caps = readonly [number, number, number];

export const HINTS = "j/k move · enter open · L link · D delete · / filter · ? help · q quit";
const LABEL_WIDTH = 9;
const GAP = "  ";
const SESSION_CAPS: { narrow: Caps; wide: Caps } = { narrow: [16, 6, 4], wide: [28, 40, 4] };
const JOB_CAPS: { narrow: Caps; wide: Caps } = { narrow: [20, 12, 4], wide: [32, 20, 4] };

const isJobRow = (row: DashRow): boolean => row.kind === "job" || row.kind === "alert";

export function sessionLabel(session: SessionEntry): string {
	if (session.liveness !== "live") return session.liveness;
	return session.status === "waiting-external" ? "waiting" : session.status;
}

export function rowCells(row: DashRow, now: Date, wide: boolean): Cells {
	if (row.kind === "triage") return { label: "triage", window: "", item: "", age: "", note: `${row.count} pending candidate${row.count === 1 ? "" : "s"}` };
	if (row.kind === "job" || row.kind === "alert") {
		const job = row.job;
		const health = job.stoppedAt ? "stopped" : (job.lastCheckStatus ?? "unknown");
		return {
			label: row.kind === "alert" ? "unhealthy" : health,
			window: oneLine(job.name),
			item: oneLine(job.schedule ?? job.kind),
			age: job.lastCheckAt ? formatAge(now.getTime() - Date.parse(job.lastCheckAt)) : "-",
			note: oneLine(job.lastCheckOutput ?? ""),
		};
	}
	const s = row.session;
	const child = s.parentSession !== null;
	const since = child || s.liveness !== "live" ? lastActivity(s) : s.statusAt;
	const window = child ? (s.name ?? `child ${s.id.slice(0, 8)}`) : (s.tmuxWindow ?? basename(s.cwd));
	const item = s.itemId ? (wide && s.itemTitle ? `${s.itemId} ${s.itemTitle}` : s.itemId) : "-";
	const note = s.note ? `"${s.note}"` : child ? "" : (s.name ?? "");
	return { label: sessionLabel(s), window: oneLine(window), item: oneLine(item), age: formatAge(now.getTime() - Date.parse(since)), note: oneLine(note) };
}

export function rowMatches(row: DashRow, filter: string, now: Date): boolean {
	if (!filter) return true;
	const cells = rowCells(row, now, true);
	return [cells.label, cells.window, cells.item, cells.note].join(" ").toLowerCase().includes(filter.toLowerCase());
}

export function filterModel(model: DashModel, filter: string): DashModel {
	if (!filter) return model;
	return { ...model, sections: model.sections.map((section) => ({ ...section, rows: section.rows.filter((row) => rowMatches(row, filter, model.now)) })) };
}

function widths(rows: readonly DashRow[], now: Date, wide: boolean, caps: Caps): Widths {
	const cells = rows.map((row) => rowCells(row, now, wide));
	const max = (pick: (cell: Cells) => string, cap: number): number => Math.min(cap, Math.max(1, ...cells.map((cell) => visibleWidth(pick(cell)))));
	return { window: max((c) => c.window, caps[0]), item: max((c) => c.item, caps[1]), age: max((c) => c.age, caps[2]) };
}

function rowText(row: DashRow, now: Date, wide: boolean, w: { session: Widths; job: Widths }, width: number): string {
	const cells = rowCells(row, now, wide);
	if (row.kind === "triage") return truncate(`${fit(cells.label, LABEL_WIDTH)}${GAP}${cells.note}`, width);
	const cw = isJobRow(row) ? w.job : w.session;
	const indent = row.kind === "session" && row.depth === 1 ? "  " : "";
	const head = [fit(cells.label, LABEL_WIDTH), fit(cells.window, cw.window), fit(cells.item, cw.item), cells.age.padStart(cw.age)].join(GAP);
	return truncate(`${indent}${head}${GAP}${cells.note}`, width);
}

function styleRow(row: DashRow, line: string, style: Style): string {
	if (row.kind === "alert") return style.color("red", line);
	if (row.kind === "job") {
		if (row.job.stoppedAt) return style.dim(line);
		return row.job.lastCheckStatus === "unhealthy" ? style.color("red", line) : line;
	}
	if (row.kind !== "session") return line;
	if (row.session.liveness === "crashed") return style.color("red", line);
	if (row.session.liveness === "closed" || row.session.status === "done") return style.dim(line);
	if (row.session.status === "needs-me" && row.depth === 0) return style.color("yellow", line);
	return line;
}

export function renderDash(model: DashModel, state: ViewState, width: number, height: number, style: Style): string[] {
	const wide = width >= 120;
	const all = allRows(model);
	const w = {
		session: widths(all.filter((row) => row.kind === "session"), model.now, wide, wide ? SESSION_CAPS.wide : SESSION_CAPS.narrow),
		job: widths(all.filter(isJobRow), model.now, wide, wide ? JOB_CAPS.wide : JOB_CAPS.narrow),
	};
	const shown = filterModel(model, state.filter);
	const body: string[] = [];
	let selectedLine = -1;
	for (const section of shown.sections) {
		const count = section.rows.filter((row) => row.kind !== "session" || row.depth === 0).length;
		body.push(style.bold(truncate(`${section.title} (${count})`, width)));
		for (const row of section.rows) {
			const text = rowText(row, model.now, wide, w, width - 2);
			if (row.key === state.selected) {
				selectedLine = body.length;
				body.push(style.inverse(fit(`> ${text}`, width)));
			} else {
				body.push(styleRow(row, `  ${text}`, style));
			}
		}
	}
	const bodyHeight = Math.max(1, height - 3);
	const offset = selectedLine >= bodyHeight ? selectedLine - bodyHeight + 1 : 0;
	const title = state.filter || state.editing ? `Work dashboard  /${state.filter}${state.editing ? "_" : ""}` : "Work dashboard";
	return [
		style.bold(truncate(sanitize(title), width)),
		...body.slice(offset, offset + bodyHeight),
		style.dim(truncate(HINTS, width)),
		truncate(oneLine(state.message), width),
	];
}
```

- [ ] **Step 6: Add job keys to the app**

In `src/work/dash/app.ts`:

1. Add these imports, and add `Job` to the `../types.ts` type import:

```ts
import type { JobDeps } from "../jobs.ts";
import { checkJobs, checkStaleJobs, jobDetails, stopJob } from "../jobs.ts";
```

2. Add `jobs?: JobDeps;` to `DashDeps`.

3. Replace `MAIN_ACTIONS`, `HELP_TEXT`, and `CONFIRM_TEXT` with:

```ts
export const MAIN_ACTIONS: readonly string[] = ["L", "c", "x", "D", "R", "?"];
export const CONFIRM_ACTIONS: readonly string[] = ["x", "D"];
export const HELP_TEXT = [
	"j / k            down / up",
	"gg / G           first / last row",
	"Ctrl-d / Ctrl-u  half page down / up",
	"Tab / Shift-Tab  next / previous section (also ] and [)",
	"/ then n / N     filter as you type, then next / previous match; Esc clears",
	"Enter            jump to a session, reopen a closed or crashed one, open triage,",
	"                 show a child agent's transcript, or show job details",
	"L                link the session to an item",
	"c                check the selected job now",
	"x then y         stop the selected job, or a running child agent (SIGTERM)",
	"D then y         delete a stopped job, or a closed or crashed session record",
	"R                refresh and re-run stale job checks",
	"?                this help",
	"q / Esc          close",
].join("\n");
```

```ts
function jobOf(row: DashRow | undefined): Job | undefined {
	return row?.kind === "job" || row?.kind === "alert" ? row.job : undefined;
}

function confirmPrompt(key: string, row: DashRow | undefined): string {
	const job = jobOf(row);
	if (job) return key === "x" ? `Stop ${job.id} ${job.name}? y to confirm, any other key cancels` : `Delete stopped job ${job.id}? y to confirm, any other key cancels`;
	return key === "x" ? "Stop this child agent with SIGTERM? y to confirm, any other key cancels" : "Delete this session record? y to confirm, any other key cancels";
}
```

4. After `let triage: TriageState | undefined;`, add:

```ts
	let checking = false;
	const checkAbort = new AbortController();
	const jobDeps = (): JobDeps => ({ ...deps.jobs, signal: checkAbort.signal });
```

5. In `reload`, change the `buildDashModel` call to:

```ts
		model = buildDashModel({ sessions, triageCount: openCandidates(store).length, jobs: store.listJobs(), now: store.clock() });
```

6. In `finish`, add `checkAbort.abort();` directly after `if (timer) clearInterval(timer);`.

7. After `perform`, add:

```ts
	// Checks run in the background so the dashboard stays responsive; results re-render when they land.
	function backgroundCheck(targets?: Job[]): void {
		if (checking) {
			if (targets) message = "A check is already running";
			return;
		}
		checking = true;
		const run = targets ? checkJobs(store, targets, jobDeps()) : checkStaleJobs(store, jobDeps());
		run
			.then((checked) => {
				if (targets) message = checked.map((job) => `${job.id} ${job.lastCheckStatus}: ${job.lastCheckOutput ?? ""}`).join("; ");
			})
			.catch((error: unknown) => {
				message = errorMessage(error);
			})
			.finally(() => {
				checking = false;
				if (closed) return;
				safeReload();
				render();
			});
	}
```

8. In `activate`, directly after the `row.kind === "triage"` block, add:

```ts
		if (row.kind === "job" || row.kind === "alert") {
			const job = row.job;
			await ask<void>((resolve) => messageBox(`Job ${job.id}`, jobDetails(store, job, store.clock()), resolve));
			return;
		}
```

9. In `runAction`, replace the `key === "R"` block with the following, and add the `c` block after it:

```ts
		if (key === "R") {
			message = "Refreshed";
			backgroundCheck();
			return;
		}
		if (key === "c") {
			const job = jobOf(selectedRow());
			if (!job) {
				message = "c checks the selected job";
				return;
			}
			message = `Checking ${job.id}…`;
			backgroundCheck([job]);
			return;
		}
```

10. Replace `canConfirm` with:

```ts
	function canConfirm(key: string): boolean {
		const row = selectedRow();
		const job = jobOf(row);
		if (job) {
			if (key === "x" && !job.stoppedAt) return true;
			if (key === "D" && job.stoppedAt) return true;
			message = key === "x" ? "This job is already stopped" : "Stop the job before deleting it";
			return false;
		}
		const session = sessionOf(row);
		if (key === "D" && session && session.liveness !== "live") return true;
		if (key === "x" && session?.parentSession && session.alive) return true;
		message = key === "D" ? "D deletes only closed or crashed sessions" : "x stops only running child agents";
		return false;
	}
```

11. In `runConfirmed`, directly after `confirmTarget = null;`, add:

```ts
		const job = jobOf(row);
		if (job) {
			if (key === "x") {
				const stopped = await stopJob(store, job, "user", deps.jobs);
				message = `Stopped ${stopped.job.id} ${stopped.job.name}${stopped.note}`;
			} else {
				store.deleteJob(job.id, "user");
				message = `Deleted ${job.id}`;
			}
			return;
		}
```

12. In `mainKey`, in the `confirming` case, change `message = CONFIRM_TEXT[action.key] ?? "y to confirm";` to `message = confirmPrompt(action.key, selectedRow());`, and delete the now-unused `CONFIRM_TEXT` constant.

13. At the end of `runDash`, directly after the first `render();` (before the refresh timer), add `backgroundCheck();`.

- [ ] **Step 7: Add jobs to the planner snapshot**

In `src/work/snapshot.ts`, add this field to the `Snapshot` type, after `nudges: Nudge[];`:

```ts
	jobs: { id: string; kind: string; external_name: string; status: string; checked_at: string | null }[];
```

In `buildSnapshot`'s returned object, add after `nudges,`:

```ts
		jobs: store.listJobs({ activeOnly: true }).map((job) => ({ id: job.id, kind: job.kind, external_name: job.name, status: job.lastCheckStatus ?? "unknown", checked_at: job.lastCheckAt })),
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/work/dash-view.test.mjs tests/work/dash-app.test.mjs tests/work/snapshot.test.mjs tests/work/planner-tools.test.mjs tests/work/pi-free.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/work/jobs.ts src/work/dash src/work/snapshot.ts tests/work/dash-view.test.mjs tests/work/dash-app.test.mjs tests/work/snapshot.test.mjs
git commit -m "feat: show, check, stop, and delete jobs from the dashboard"
```

---

### Task 17: Usage recording

**Files:**
- Create: `src/work/usage.ts`
- Modify: `src/work/types.ts`, `src/work/store.ts`: usage rows
- Modify: `src/work/config.ts`: `"usage": false`
- Modify: `src/work/cli.ts`: record every command, and restore runs
- Modify: `src/work/cli-triage.ts`, `src/work/triage-actions.ts`: record triage outcomes
- Modify: `src/work/planner-tools.ts`: record plan saves with follow-through
- Modify: `src/work/session-tracker.ts`, `extensions/work.ts`: Pi commands and `session.responded`
- Modify: `src/work/dash/app.ts`: dashboard actions
- Modify: `src/work/sync.ts`: 180-day retention
- Test: `tests/work/usage.test.mjs`

**Interfaces:**
- Consumes: the `usage` table (Task 1), and every surface above.
- Produces:
  - `UsageSurface = "dash" | "cli" | "pi" | "triage" | "planner"`, `UsageContext = Record<string, number | boolean | string>`, `UsageRow = { id; at; surface; action; context }`
  - `store.recordUsage(surface, action, context)`, `store.listUsage({ since? })`, `store.pruneUsage(before): number`
  - `WorkConfig.usage?: boolean`
  - `usage.ts`: `USAGE_RETENTION_DAYS = 180`, `UsageTarget = { store; config: { usage?: boolean } }`, `sanitizeContext(context)`, `recordUsage(target, surface, action, context?)` (never throws), `recordTriage(target, action, candidate)`, `pruneUsage(store, now)`, `planFollowThrough(store, date): { focus; followed }`
  - `SessionTracker.input(text, source)`, and `TrackerDeps.onResponded?: (seconds) => void`

What is recorded, and nothing else. Context values are numbers, booleans, or enum-like strings matching `/^[a-z0-9][a-z0-9._-]{0,39}$/`, so titles, notes, and commands can never be stored.
- `cli/<command>` `{ exit }` for every command, and `cli/restore.run` `{ mode, ran, placed, skipped, failed }`.
- `pi/todo`, `pi/triage`, `pi/today`, `pi/dash`, and `pi/session.responded` `{ seconds }` (time from `status_at` to the next typed user message while `needs-me`; slash commands and extension-sent input do not count).
- `triage/<accept|apply|merge|dismiss|snooze|accept-all|promote>` `{ source, kind }`, only when the action happened.
- `planner/save` `{ focus, prev_focus, followed }`.
- `dash/<open|jump|reopen|transcript|link|check|stop|delete|filter|triage|details|refresh|help|restore>`, and `dash/close` `{ moves, seconds }` (decision 14).

- [ ] **Step 1: Write the failing tests**

Create `tests/work/usage.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { captureIo, clock, DAY, load, memoryRuntime, memoryStore } from './helpers.mjs';

const usage = await load('src/work/usage.ts');
const { runCli } = await load('src/work/cli.ts');
const { parseWorkConfig, emptyConfig } = await load('src/work/config.ts');
const { createWorkExtension } = await load('extensions/work.ts');
const { handleTriageAction } = await load('src/work/triage-ui.ts');
const { registerPlannerTools } = await load('src/work/planner-tools.ts');
const { syncAll } = await load('src/work/sync.ts');
const { runDash } = await load('src/work/dash/app.ts');
const { plainStyle } = await load('src/work/dash/text.ts');

const rows = (store, surface) => store.listUsage().filter((row) => !surface || row.surface === surface).map((row) => [row.surface, row.action, row.context]);

test('contexts keep only numbers, booleans, and short enum-like strings', () => {
  assert.deepEqual(
    usage.sanitizeContext({ seconds: 12, ok: true, source: 'github', title: 'Fix the login bug', Bad: 1, nan: Number.NaN, nested: { a: 1 }, long: 'x'.repeat(50) }),
    { seconds: 12, ok: true, source: 'github' },
  );
});

test('recording honors "usage": false, ignores invalid actions, and never throws', async () => {
  const store = await memoryStore();
  usage.recordUsage({ store, config: { usage: false } }, 'cli', 'add');
  usage.recordUsage({ store, config: {} }, 'cli', 'Not An Action');
  usage.recordUsage({ store, config: {} }, 'cli', 'add', { exit: 0 });
  assert.deepEqual(rows(store), [['cli', 'add', { exit: 0 }]]);
  store.close();
  assert.doesNotThrow(() => usage.recordUsage({ store, config: {} }, 'cli', 'add'));
});

test('the config can turn usage off', () => {
  assert.equal(parseWorkConfig('{"usage": false}').config.usage, false);
  assert.equal(parseWorkConfig('{}').config.usage, undefined);
  assert.match(parseWorkConfig('{"usage": "no"}').warnings[0], /usage must be true or false/);
});

test('CLI commands are recorded with their exit code, and restore runs with counts', async () => {
  const rt = await memoryRuntime();
  const io = captureIo();
  const deps = { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, repoFromCwd: () => undefined, tmux: () => '', readers: { kill: () => { throw new Error('kill ESRCH'); }, environ: () => undefined }, bootId: () => 'b' };
  await runCli(['add', 'write', 'docs'], deps);
  await runCli(['set', 'W-9', 'status=done'], deps);
  await runCli(['restore', '--dry-run'], deps);
  assert.deepEqual(rows(rt.store), [
    ['cli', 'add', { exit: 0 }],
    ['cli', 'set', { exit: 1 }],
    ['cli', 'restore.run', { mode: 'dry-run', ran: false, placed: 0, skipped: 0, failed: 0 }],
    ['cli', 'restore', { exit: 0 }],
  ]);
});

test('Pi commands and needs-me response times are recorded without content', async () => {
  const now = clock();
  const rt = await memoryRuntime({ now });
  const commands = new Map();
  const events = new Map();
  createWorkExtension({ runtime: () => rt, repoFromCwd: () => undefined, env: { TMUX: 't', TMUX_PANE: '%1' }, pid: 1, tmux: () => 'api\n', git: () => { throw new Error('not a git repository'); }, signals: new EventEmitter() })({
    registerCommand(name, definition) { commands.set(name, definition.handler); },
    registerTool() {},
    on(name, handler) { events.set(name, handler); },
  });
  const ctx = { cwd: '/src/api', mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 's1', getSessionFile: () => undefined, getSessionName: () => undefined }, ui: { notify() {}, setStatus() {} } };
  await commands.get('todo')('secret title', ctx);
  await events.get('session_start')({ reason: 'startup' }, ctx);
  now.advance(90_000);
  await events.get('input')({ text: '/todo x', source: 'interactive' }, ctx);
  await events.get('input')({ text: 'queued', source: 'extension' }, ctx);
  await events.get('input')({ text: 'yes, trim it', source: 'interactive' }, ctx);
  assert.deepEqual(rows(rt.store), [['pi', 'todo', {}], ['pi', 'session.responded', { seconds: 90 }]]);
  assert.equal(JSON.stringify(rt.store.listUsage()).includes('secret'), false);
});

test('triage outcomes are recorded by source and kind, only when they happen', async () => {
  const rt = await memoryRuntime();
  const ctx = { ui: { notify() {}, input: async () => undefined, select: async () => undefined, confirm: async () => false, custom: async () => undefined } };
  const dismissed = rt.store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k1', title: 'T', reason: 'r' }, 'sync:github');
  await handleTriageAction(ctx, rt, 'd', dismissed);
  const cancelled = rt.store.addCandidate({ kind: 'new-item', source: 'agent', dedupeKey: 'k2', title: 'T2', reason: 'r' }, 'agent:s');
  await handleTriageAction(ctx, rt, 'a', cancelled);
  assert.deepEqual(rows(rt.store), [['triage', 'dismiss', { source: 'github', kind: 'new-item' }]]);
});

test('saving a plan records how many of the previous focus items saw activity', async () => {
  const now = clock();
  const rt = await memoryRuntime({ now });
  const [a, b, c] = ['A', 'B', 'C'].map((title) => rt.store.addItem({ project: 'misc', title, origin: 'manual' }, 'user'));
  now.advance(1000);
  rt.store.savePlan({ date: '2026-09-24', itemIds: [a.id, b.id, c.id], quickActions: [], notes: '' }, 'planner');
  now.advance(60_000);
  rt.store.updateItem(a.id, { status: 'doing' }, 'user');
  now.advance(DAY);
  const tools = new Map();
  registerPlannerTools({ registerTool(definition) { tools.set(definition.name, definition); } }, () => rt);
  await tools.get('work_plan_save').execute('c1', { focus: [b.id], quick_actions: [] });
  assert.deepEqual(rows(rt.store, 'planner'), [['planner', 'save', { focus: 1, prev_focus: 3, followed: 1 }]]);
});

test('dashboard actions are recorded, and navigation is summarized when it closes', async () => {
  const rt = await memoryRuntime();
  rt.store.startSession({ id: 's1', file: null, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  let input = () => {};
  const terminal = { columns: () => 80, rows: () => 24, write() {}, onInput(handler) { input = handler; }, onResize() {}, start() {}, stop() {} };
  const result = runDash({
    runtime: rt, terminal, tmux: (args) => (args[0] === 'list-panes' ? '%1\t@1\tapi\tmain\t/src/api\tnode' : ''), insideTmux: true,
    readers: { kill: () => {}, environ: () => undefined }, style: plainStyle, refreshMs: 0, bootId: () => 'b',
  });
  for (const key of ['j', 'k', '/', '\x1b', '\r']) input(key);
  await result;
  const dash = rows(rt.store, 'dash');
  assert.deepEqual(dash.map(([, action]) => action), ['open', 'filter', 'jump', 'close']);
  assert.equal(dash.at(-1)[2].moves, 2);
});

test('sync deletes usage rows older than 180 days', async () => {
  const now = clock();
  const store = await memoryStore(now);
  store.recordUsage('cli', 'old', {});
  now.advance(181 * DAY);
  store.recordUsage('cli', 'new', {});
  await syncAll(store, emptyConfig(), {});
  assert.deepEqual(store.listUsage().map((row) => row.action), ['new']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/work/usage.test.mjs`
Expected: FAIL with `Cannot find module` for `src/work/usage.ts`.

- [ ] **Step 3: Add usage rows to the store and config**

Append to `src/work/types.ts`:

```ts
export type UsageSurface = "dash" | "cli" | "pi" | "triage" | "planner";
export type UsageContext = Record<string, number | boolean | string>;
export type UsageRow = { id: number; at: string; surface: UsageSurface; action: string; context: UsageContext };
```

In `src/work/store.ts`, add `UsageContext`, `UsageRow`, and `UsageSurface` to the type import. Directly before `// Connector runs and meta (operational: no events)`, add:

```ts
	// Usage (operational: no events)

	recordUsage(surface: UsageSurface, action: string, context: UsageContext): void {
		this.run("INSERT INTO usage (at, surface, action, context) VALUES (?, ?, ?, ?)", this.now(), surface, action, JSON.stringify(context));
	}

	listUsage(filter: { since?: string } = {}): UsageRow[] {
		const rows = filter.since ? this.all("SELECT * FROM usage WHERE at >= ? ORDER BY id", filter.since) : this.all("SELECT * FROM usage ORDER BY id");
		return rows.map((r) => ({ id: Number(r.id), at: String(r.at), surface: r.surface as UsageSurface, action: String(r.action), context: json<UsageContext>(r.context, {}) }));
	}

	pruneUsage(before: string): number {
		return this.run("DELETE FROM usage WHERE at < ?", before).changes;
	}

```

In `src/work/config.ts`, change `WorkConfig` to:

```ts
export type WorkConfig = { jira?: JiraConfig; github: { accounts: GithubAccount[] }; projects: ProjectConfig[]; rules: Rule[]; plannerCwd?: string; usage?: boolean };
```

In `parseWorkConfig`, directly before `return { config, warnings };`, add:

```ts
	if (data.usage !== undefined) {
		if (typeof data.usage === "boolean") config.usage = data.usage;
		else warnings.push("usage must be true or false; usage tracking stays on");
	}
```

- [ ] **Step 4: Implement the usage module**

Create `src/work/usage.ts`:

```ts
import type { WorkStore } from "./store.ts";
import type { Candidate, UsageContext, UsageSurface } from "./types.ts";

export const USAGE_RETENTION_DAYS = 180;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const ENUM = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export type UsageTarget = { store: WorkStore; config: { usage?: boolean } };

// Only numbers, booleans, and enum-like strings survive, so no title, note, or command is ever recorded.
export function sanitizeContext(context: Record<string, unknown>): UsageContext {
	const out: UsageContext = {};
	for (const [key, value] of Object.entries(context)) {
		if (!KEY.test(key)) continue;
		if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
		else if (typeof value === "boolean") out[key] = value;
		else if (typeof value === "string" && ENUM.test(value)) out[key] = value;
	}
	return out;
}

export function recordUsage(target: UsageTarget, surface: UsageSurface, action: string, context: Record<string, unknown> = {}): void {
	if (target.config.usage === false || !ENUM.test(action)) return;
	try {
		target.store.recordUsage(surface, action, sanitizeContext(context));
	} catch {
		// Usage is best effort and never interrupts the user.
	}
}

export function recordTriage(target: UsageTarget, action: string, candidate: Candidate): void {
	recordUsage(target, "triage", action, { source: candidate.source, kind: candidate.kind });
}

export function pruneUsage(store: WorkStore, now: Date): number {
	return store.pruneUsage(new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000).toISOString());
}

// For the previous plan: how many focus items saw any item event after it was saved, or are done.
export function planFollowThrough(store: WorkStore, date: string): { focus: number; followed: number } {
	const previous = store.latestPlanBefore(date);
	if (!previous) return { focus: 0, followed: 0 };
	let followed = 0;
	for (const id of previous.itemIds) {
		let done = false;
		try {
			done = store.getItem(id)?.status === "done";
		} catch {
			done = false;
		}
		const touched = store.listEvents({ since: previous.savedAt, entityPrefix: `item:${id}` }).some((event) => event.entity === `item:${id}` && event.at > previous.savedAt);
		if (done || touched) followed++;
	}
	return { focus: previous.itemIds.length, followed };
}
```

- [ ] **Step 5: Record from each surface**

**CLI** (`src/work/cli.ts`): add `import { recordUsage } from "./usage.ts";`. In `runCli`, replace the final `try { … } catch { … }` block with:

```ts
	let code: number;
	try {
		code = await command.run(args, deps);
	} catch (error) {
		deps.io.err(error instanceof Error ? error.message : String(error));
		code = 1;
	}
	try {
		recordUsage(deps.runtime(), "cli", name, { exit: code });
	} catch {
		// Usage is best effort; the runtime may not open (for example, a newer schema).
	}
	return code;
```

In `restoreCommand.run`, directly after `const report = runRestore(…);`, add:

```ts
		recordUsage(rt, "cli", "restore.run", { mode, ran: report.ran, placed: report.placed.length, skipped: report.skipped.length, failed: report.failed.length });
```

**Triage actions** (`src/work/triage-actions.ts`): add `import { recordTriage } from "./usage.ts";`. Change `applyUpdate` to return `Promise<boolean>`. It returns `false` on the unconfirmed early return, and `result === "applied"` at the end. Then, in `runTriageAction`:
- After `dismissCandidate(store, candidate.id);` add `recordTriage(runtime, "dismiss", candidate);`.
- After `snoozeCandidate(…);` add `recordTriage(runtime, "snooze", candidate);`.
- In `A`, replace the notify line with:

```ts
			const accepted = acceptAllFromSource(store, candidate.source);
			recordTriage(runtime, "accept-all", candidate);
			ui.notify(`Accepted ${accepted.length} from ${candidate.source}`, "info");
```

- In `m`, change `if (target) mergeCandidate(store, candidate.id, target.id);` to:

```ts
			if (!target) return;
			mergeCandidate(store, candidate.id, target.id);
			recordTriage(runtime, "merge", candidate);
```

- In the Jira branch, change `await applyUpdate(ui, runtime, candidate);` to `if (await applyUpdate(ui, runtime, candidate)) recordTriage(runtime, "apply", candidate);`.
- After `const item = acceptCandidate(store, candidate.id, edits);` add `recordTriage(runtime, key === "p" ? "promote" : "accept", candidate);`.

**CLI triage** (`src/work/cli-triage.ts`): add `import { recordTriage } from "./usage.ts";`. Change `cliApplyJiraUpdate` to return `Promise<boolean>`: `false` when not confirmed, and otherwise `result === "applied"` after printing. In `runCliTriage`:
- After `io.out("Dismissed");` add `recordTriage(rt, "dismiss", candidate);`.
- After `io.out("Snoozed");` add `recordTriage(rt, "snooze", candidate);`.
- After `io.out(\`Merged into ${target}\`);` add `recordTriage(rt, "merge", candidate);`.
- In `A`, after the `io.out(…)` line add `recordTriage(rt, "accept-all", candidate);`.
- Change `await cliApplyJiraUpdate(rt, io, candidate);` to `if (await cliApplyJiraUpdate(rt, io, candidate)) recordTriage(rt, "apply", candidate);`.
- After `const item = acceptCandidate(rt.store, candidate.id, edits);` add `recordTriage(rt, answer === "p" ? "promote" : "accept", candidate);`.

**Planner** (`src/work/planner-tools.ts`): add `import { planFollowThrough, recordUsage } from "./usage.ts";`. Replace the `work_plan_save` `execute` with:

```ts
		async execute(_toolCallId, params) {
			const r = rt();
			const now = r.store.clock();
			const follow = planFollowThrough(r.store, localDate(now));
			const plan = plannerSavePlan(r.store, params, now);
			recordUsage(r, "planner", "save", { focus: params.focus.length, prev_focus: follow.focus, followed: follow.followed });
			return json(plan);
		},
```

**Session tracker** (`src/work/session-tracker.ts`): add `onResponded?: (seconds: number) => void;` to `TrackerDeps`, and `input(text: string, source: string): void;` to `SessionTracker`. Add this method to the returned object, after `start`:

```ts
		input(text, source) {
			if (source === "extension" || text.trimStart().startsWith("/")) return;
			guard((store, sessionId) => {
				const session = store.getSession(sessionId);
				if (session?.status !== "needs-me") return;
				deps.onResponded?.(Math.max(0, Math.round((store.clock().getTime() - Date.parse(session.statusAt)) / 1000)));
			});
		},
```

**Extension** (`extensions/work.ts`): add `import { recordUsage } from "../src/work/usage.ts";`. After `const rt = …`, add:

```ts
		const track = (action: string, context: Record<string, unknown> = {}): void => {
			try {
				recordUsage(rt(), "pi", action, context);
			} catch {
				// Usage is best effort.
			}
		};
```

Add `onResponded: (seconds) => track("session.responded", { seconds }),` to the `createSessionTracker` options. Add `track("todo");`, `track("triage");`, `track("today");`, and `track("dash");` as the first line of the corresponding command handlers. Add the hook:

```ts
		pi.on("input", async (event) => {
			tracker.input(event.text, event.source);
		});
```

**Dashboard** (`src/work/dash/app.ts`): add `import { recordUsage } from "../usage.ts";`. After `const kill = …`, add:

```ts
	const track = (action: string, context: Record<string, unknown> = {}): void => recordUsage(deps.runtime, "dash", action, context);
	const openedAt = store.clock().getTime();
	let moves = 0;
```

Then add these calls:
- `finish`: `track("close", { moves, seconds: Math.round((store.clock().getTime() - openedAt) / 1000) });` directly before `term.stop();`.
- `jump`: `track("jump");` as its first line.
- `showTranscript`: `track("transcript");` directly before `await ask`.
- `openTriage`: `track("triage");` directly before `triage = { … }`.
- `activate`: `track("details");` directly before the job `await ask`, and `track("reopen");` directly before the final `jump(reopenSession(…))`.
- `runAction`: `track("refresh");` in `R`, `track("help");` in `?`, `track("check");` in `c` directly before `backgroundCheck([job])`, and `track("link");` after `store.linkSession(…)`.
- `runConfirmed`: `track("stop", { target: "job" });` after `stopJob`, `track("delete", { target: "job" });` after `deleteJob`, `track("delete", { target: "session" });` after `deleteSession`, and `track("stop", { target: "child" });` after `kill(…)`.
- `mainKey`: before `keyStep`, add `const wasEditing = keys.editing;`. In the `move` case add `moves++;`. In the `filter` case add `if (!wasEditing && action.editing) track("filter");`.
- `autoRestore`: `track("restore", { placed: report.placed.length, failed: report.failed.length });` directly after `if (!report.ran) return;`.
- At the end of `runDash`, directly before `term.start();`, add `track("open");`.

**Retention** (`src/work/sync.ts`): add `import { pruneUsage } from "./usage.ts";`. In `syncAll`, directly after `const report: SyncReport = …;`, add `pruneUsage(store, now);`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/work/usage.test.mjs && npm test && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/work tests/work/usage.test.mjs extensions/work.ts
git commit -m "feat: record local, content-free usage from every surface"
```

---

### Task 18: `work usage` report

**Files:**
- Modify: `src/work/usage.ts`: `usageReport` and `DASH_FEATURES`
- Modify: `src/work/cli.ts`: the `usage` command
- Test: `tests/work/usage-report.test.mjs`

**Interfaces:**
- Consumes: `store.listUsage` (Task 17), and `formatAge` (Task 8).
- Produces: `DASH_FEATURES`, `usageReport(store, days, now): string`, and `work usage [--days <n>]` (1 to 180, default 30)

- [ ] **Step 1: Write the failing test**

Create `tests/work/usage-report.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIo, clock, load, memoryRuntime } from './helpers.mjs';

const { runCli } = await load('src/work/cli.ts');

test('work usage summarizes response times, triage, planning, the dashboard, and commands', async () => {
  const now = clock('2026-08-16T09:00:00.000Z');
  const rt = await memoryRuntime({ now });
  const record = (surface, action, context = {}) => rt.store.recordUsage(surface, action, context);
  record('cli', 'ancient');
  now.set('2026-09-25T09:00:00.000Z');
  for (const seconds of [60, 1800, 300]) record('pi', 'session.responded', { seconds });
  record('triage', 'accept', { source: 'github', kind: 'new-item' });
  record('triage', 'dismiss', { source: 'github', kind: 'new-item' });
  record('triage', 'dismiss', { source: 'agent', kind: 'new-item' });
  record('planner', 'save', { focus: 2, prev_focus: 4, followed: 3 });
  record('planner', 'save', { focus: 3, prev_focus: 2, followed: 1 });
  record('dash', 'open');
  record('dash', 'open');
  record('dash', 'jump');
  record('dash', 'filter');
  record('cli', 'add');
  record('cli', 'add');
  record('cli', 'list');
  record('pi', 'todo');
  const io = captureIo();
  const code = await runCli(['usage', '--days', '30'], { runtime: () => rt, io: io.io, cwd: '/tmp', env: {} });
  assert.equal(code, 0);
  assert.equal(io.out[0], [
    '## Work usage, last 30 days',
    '',
    '16 usage rows. No content is recorded.',
    '',
    '### Time in needs-me',
    '- 3 responses; median 5m; 90th percentile 30m',
    '',
    '### Triage outcomes',
    '| source | accept | dismiss |',
    '| --- | --- | --- |',
    '| agent | 0 | 1 |',
    '| github | 1 | 1 |',
    '',
    '### Planner follow-through',
    '- 2 plans saved; 4 of 6 previous focus items had activity or were done by the next plan (67%)',
    '',
    '### Dashboard',
    '- 2 opens (0.1 per day); 1 jump (50% of opens)',
    '- unused in this window: reopen, transcript, link, check, stop, delete, triage, details, refresh, help',
    '',
    '### Commands',
    '- cli: add 2, list 1',
    '- pi: todo 1',
  ].join('\n'));
  const bad = await runCli(['usage', '--days', '0'], { runtime: () => rt, io: captureIo().io, cwd: '/tmp', env: {} });
  assert.equal(bad, 1);
});
```

This test's own `work usage` run is recorded only after the report prints, so it is not counted.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/work/usage-report.test.mjs`
Expected: FAIL with `Unknown command: usage`.

- [ ] **Step 3: Implement the report**

In `src/work/usage.ts`, add `import { formatAge } from "./dash/text.ts";`, and append:

```ts
export const DASH_FEATURES: readonly string[] = ["jump", "reopen", "transcript", "link", "check", "stop", "delete", "filter", "triage", "details", "refresh", "help"];

function percentile(sorted: readonly number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const duration = (seconds: number): string => formatAge(seconds * 1000);

export function usageReport(store: WorkStore, days: number, now: Date): string {
	const rows = store.listUsage({ since: new Date(now.getTime() - days * 86_400_000).toISOString() });
	const lines: string[] = [`## Work usage, last ${days} days`, "", `${rows.length} usage rows. No content is recorded.`, ""];

	const responses = rows.filter((row) => row.action === "session.responded").map((row) => Number(row.context.seconds)).filter(Number.isFinite).sort((a, b) => a - b);
	lines.push(
		"### Time in needs-me",
		responses.length ? `- ${plural(responses.length, "response")}; median ${duration(percentile(responses, 0.5))}; 90th percentile ${duration(percentile(responses, 0.9))}` : "- no responses recorded",
		"",
	);

	const triage = rows.filter((row) => row.surface === "triage");
	lines.push("### Triage outcomes");
	if (triage.length === 0) {
		lines.push("- none");
	} else {
		const sourceOf = (row: (typeof triage)[number]): string => String(row.context.source ?? "unknown");
		const actions = [...new Set(triage.map((row) => row.action))].sort();
		const sources = [...new Set(triage.map(sourceOf))].sort();
		lines.push(`| source | ${actions.join(" | ")} |`, `| --- | ${actions.map(() => "---").join(" | ")} |`);
		for (const source of sources) {
			lines.push(`| ${source} | ${actions.map((action) => triage.filter((row) => row.action === action && sourceOf(row) === source).length).join(" | ")} |`);
		}
	}
	lines.push("");

	const saves = rows.filter((row) => row.surface === "planner" && row.action === "save");
	const focus = saves.reduce((sum, row) => sum + (Number(row.context.prev_focus) || 0), 0);
	const followed = saves.reduce((sum, row) => sum + (Number(row.context.followed) || 0), 0);
	lines.push(
		"### Planner follow-through",
		saves.length
			? `- ${saves.length} plan${saves.length === 1 ? "" : "s"} saved; ${followed} of ${focus} previous focus items had activity or were done by the next plan${focus ? ` (${Math.round((followed / focus) * 100)}%)` : ""}`
			: "- no plans saved",
		"",
	);

	const dash = rows.filter((row) => row.surface === "dash");
	const count = (action: string): number => dash.filter((row) => row.action === action).length;
	const opens = count("open");
	const jumps = count("jump");
	lines.push(
		"### Dashboard",
		`- ${plural(opens, "open")} (${(opens / days).toFixed(1)} per day); ${plural(jumps, "jump")} (${opens ? Math.round((jumps / opens) * 100) : 0}% of opens)`,
		`- unused in this window: ${DASH_FEATURES.filter((feature) => count(feature) === 0).join(", ") || "none"}`,
		"",
	);

	lines.push("### Commands");
	for (const surface of ["cli", "pi"] as const) {
		const counts = new Map<string, number>();
		for (const row of rows) {
			if (row.surface === surface && row.action !== "session.responded") counts.set(row.action, (counts.get(row.action) ?? 0) + 1);
		}
		const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([action, n]) => `${action} ${n}`).join(", ");
		lines.push(`- ${surface}: ${list || "none"}`);
	}
	return lines.join("\n");
}
```

In `src/work/cli.ts`, change the usage import to `import { recordUsage, usageReport } from "./usage.ts";`, and add this command after `job`:

```ts
const usageCommand: CliCommand = {
	usage: "usage [--days <n>]                   Markdown summary of how the tracker is used (default 30 days)",
	async run(args, deps) {
		const index = args.indexOf("--days");
		const days = index >= 0 ? Number(args[index + 1]) : 30;
		if (!Number.isInteger(days) || days < 1 || days > 180) throw new UsageError("--days must be a whole number from 1 to 180");
		const rt = deps.runtime();
		deps.io.out(usageReport(rt.store, days, rt.store.clock()));
		return 0;
	},
};
```

In `COMMANDS`, add `usage: usageCommand,` after `job,`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/work/usage-report.test.mjs && npm run -s typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/work/usage.ts src/work/cli.ts tests/work/usage-report.test.mjs
git commit -m "feat: summarize local usage with work usage"
```

---

### Task 19: Part 2 documentation and final release gates

**Files:**
- Modify: `README.md`: the `work` section

- [ ] **Step 1: Document jobs and usage**

In `README.md`, in the CLI sentence updated in Task 12, change `` `restore`, `dash`, `` to `` `restore`, `dash`, `job`, `usage`, ``. Directly before the paragraph that begins ``Data lives in``, add:

````markdown
**Jobs.** Agents register background jobs they start with the static `job_register` tool (a cron entry or a process, with an optional `check_command`, `stop_command`, and log path). Users register them with `work job add --name <n> --kind cron|process [--check <cmd>] [--stop <cmd>] …`. There is no approval step. Instead, every job records the session that registered it, and the dashboard's details view shows the exact commands. Checks run only when you look: when the dashboard opens (for checks older than 60 seconds), on `c`, or with `work job check [J-n]`. Each check runs `/bin/sh -c` in the job's directory with a 15-second timeout, at most 4 at a time. Exit 0 is healthy. Unhealthy jobs appear in Decisions. `x` then `y` stops a job, and `D` then `y` deletes a stopped one.

**Usage.** The tracker records local, content-free usage rows (actions, counts, and durations, never titles, notes, or commands), and keeps them for 180 days. `work usage [--days 30]` prints a Markdown summary: time in `needs-me`, triage outcomes, planner follow-through, and dashboard use. Set `"usage": false` in the config to turn recording off.
````

In the configuration example JSON block, add `"usage": true` as the last property (after `"planner"`).

- [ ] **Step 2: Run the final release gates**

Run: `npm test`
Expected: PASS, with 0 failures.

Run: `npm run -s typecheck`
Expected: exit 0, no output.

Run: `npm run -s check`
Expected: `repository-boundary-ok files=<n>`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document work jobs and usage"
```

- [ ] **Step 4: STOP for final review**

Report the gate results, the commits for Tasks 13–19, and every entry in the deviations file. Do not push, tag, bump the version, or change dotfiles. The dotfiles changes (`bind D display-popup …`, `@resurrect-hook-post-restore-all 'work restore --auto'`, a `work` wrapper on `PATH`, and the `pi-tools` tag bump) happen after release, in the dotfiles repository.

