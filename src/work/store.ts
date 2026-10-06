import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";
import type {
	AcceptanceResult,
	Actor,
	Brief,
	Candidate,
	CandidateKind,
	CandidateSource,
	CandidateState,
	ChildEndOutcome,
	ChildFlag,
	ChildKind,
	ChildOutcome,
	ChildRun,
	ChildRunInput,
	ChildWorktree,
	ConnectorRun,
	ConnectorStatus,
	Item,
	ItemStatus,
	Job,
	JobHealth,
	JobInput,
	JobKind,
	JsonObject,
	Link,
	LinkKind,
	LinkVia,
	MessageLogEntry,
	MessageLogKind,
	NewCandidate,
	NewLink,
	Origin,
	Plan,
	Project,
	ProjectStatus,
	Session,
	SessionStart,
	SessionStatus,
	Signal,
	SignalKind,
	StatusSource,
	UsageContext,
	UsageRow,
	UsageSurface,
	WaitingOn,
	WorkEvent,
} from "./types.ts";
import { JOB_KINDS, NOTE_MAX, OPEN_MESSAGE_STATES } from "./types.ts";

export class WorkStoreError extends Error {}

type Row = Record<string, unknown>;
type Param = string | number | null;

export type ItemPatch = {
	title?: string;
	notes?: string;
	status?: ItemStatus;
	waitingOn?: WaitingOn | null;
	waitingReason?: string | null;
	due?: string | null;
	pinned?: boolean;
	project?: string;
};

export type CandidatePatch = {
	state?: CandidateState;
	snoozeUntil?: string | null;
	title?: string;
	reason?: string;
	evidence?: string | null;
};

export type SessionPatch = { lastTurnAt?: string; tmuxWindow?: string | null; name?: string | null; endedAt?: string | null; restoredFrom?: number | null };

const SESSION_COLUMNS: Record<keyof SessionPatch, string> = {
	lastTurnAt: "last_turn_at",
	tmuxWindow: "tmux_window",
	name: "name",
	endedAt: "ended_at",
	restoredFrom: "restored_from",
};

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

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RESOLVED_STATES: readonly CandidateState[] = ["accepted", "merged", "dismissed", "withdrawn"];
const TABLES = ["project", "item", "link", "signal", "candidate", "dismissal", "plan", "event", "connector_run", "meta", "job", "child_run"] as const;
const REPLACE_TABLES: readonly string[] = ["project", "connector_run", "meta"];

export function itemId(num: number): string {
	return `W-${num}`;
}

export function itemNum(id: string): number {
	const match = /^W-(\d+)$/.exec(id.trim());
	if (!match) throw new WorkStoreError(`Invalid item ID: ${id}`);
	return Number(match[1]);
}

export function sessionLinkKey(sessionId: string): string {
	return `session:${sessionId}`;
}

export function jobId(num: number): string {
	return `J-${num}`;
}

export function jobNum(id: string): number {
	const match = /^J-(\d+)$/.exec(id.trim());
	if (!match) throw new WorkStoreError(`Invalid job ID: ${id}`);
	return Number(match[1]);
}

export function childRunId(num: number): string {
	return `C-${num}`;
}

export function childRunNum(id: string): number {
	const match = /^C-(\d+)$/.exec(id.trim());
	if (!match) throw new WorkStoreError(`Invalid child run ID: ${id}`);
	return Number(match[1]);
}

function text(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
	return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
}

function int(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function requireText(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new WorkStoreError(`${field} must not be empty`);
	return trimmed;
}

function assertDate(value: string): void {
	if (!DATE_PATTERN.test(value)) throw new WorkStoreError(`Invalid date: ${value}`);
}

function toProject(r: Row): Project {
	return {
		slug: String(r.slug),
		title: String(r.title),
		status: r.status as ProjectStatus,
		jiraEpic: text(r.jira_epic),
		notesPath: text(r.notes_path),
	};
}

function toItem(r: Row): Item {
	return {
		id: itemId(Number(r.num)),
		project: String(r.project),
		title: String(r.title),
		notes: String(r.notes),
		status: r.status as ItemStatus,
		waitingOn: text(r.waiting_on) as WaitingOn | null,
		waitingReason: text(r.waiting_reason),
		waitingSince: text(r.waiting_since),
		due: text(r.due),
		pinned: Number(r.pinned) === 1,
		origin: r.origin as Origin,
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	};
}

function toLink(r: Row): Link {
	return {
		id: Number(r.id),
		itemId: itemId(Number(r.item_num)),
		kind: r.kind as LinkKind,
		key: String(r.key),
		url: text(r.url),
		state: json<JsonObject | null>(r.state, null),
		stateAt: text(r.state_at),
	};
}

function toSignal(r: Row): Signal {
	return {
		id: Number(r.id),
		itemId: itemId(Number(r.item_num)),
		linkId: Number(r.link_id),
		kind: r.kind as SignalKind,
		detail: String(r.detail),
		observedAt: String(r.observed_at),
		seenInPlan: Number(r.seen_in_plan) === 1,
	};
}

function toCandidate(r: Row): Candidate {
	return {
		id: Number(r.id),
		kind: r.kind as CandidateKind,
		source: r.source as CandidateSource,
		query: text(r.query),
		dedupeKey: String(r.dedupe_key),
		title: String(r.title),
		reason: String(r.reason),
		evidence: text(r.evidence),
		proposedProject: text(r.proposed_project),
		relatesTo: r.relates_to === null || r.relates_to === undefined ? null : itemId(Number(r.relates_to)),
		payload: json<JsonObject>(r.payload, {}),
		proposer: r.proposer_session === null || r.proposer_session === undefined
			? null
			: { sessionId: String(r.proposer_session), repo: text(r.proposer_repo) },
		state: r.state as CandidateState,
		snoozeUntil: text(r.snooze_until),
		createdAt: String(r.created_at),
		resolvedAt: text(r.resolved_at),
	};
}

function toPlan(r: Row): Plan {
	return {
		date: String(r.date),
		itemIds: json<string[]>(r.item_ids, []),
		quickActions: json<string[]>(r.quick_actions, []),
		notes: String(r.notes),
		savedAt: String(r.saved_at),
	};
}

function toEvent(r: Row): WorkEvent {
	return { id: Number(r.id), at: String(r.at), actor: String(r.actor), entity: String(r.entity), action: String(r.action), data: json<unknown>(r.data, null) };
}

function toMessageLogEntry(r: Row): MessageLogEntry {
	return {
		id: String(r.id),
		at: String(r.at),
		groupLabel: String(r.group_label),
		senderPeer: String(r.sender_peer),
		senderSession: text(r.sender_session),
		senderName: String(r.sender_name),
		recipientPeer: String(r.recipient_peer),
		recipientSession: text(r.recipient_session),
		recipientName: String(r.recipient_name),
		kind: r.kind as MessageLogKind,
		inReplyTo: text(r.in_reply_to),
		state: String(r.state),
		stateAt: String(r.state_at),
		body: String(r.body),
	};
}

function toRun(r: Row): ConnectorRun {
	return {
		connector: String(r.connector),
		query: String(r.query),
		status: r.status as ConnectorStatus,
		error: text(r.error),
		at: String(r.at),
		lastOkAt: text(r.last_ok_at),
	};
}

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

function toChildRun(r: Row): ChildRun {
	const flags = json<ChildFlag[]>(r.flags, []);
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
		flags,
		spendUsd: flags.includes("unpriced") ? null : Number(r.spend_usd),
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

export class WorkStore {
	readonly db: DatabaseSync;
	readonly clock: () => Date;

	private constructor(db: DatabaseSync, clock: () => Date) {
		this.db = db;
		this.clock = clock;
	}

	static open(path: string, options: { now?: () => Date } = {}): WorkStore {
		const memory = path === ":memory:";
		if (!memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(path);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			const current = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
			if (current > SCHEMA_VERSION) {
				throw new WorkStoreError(`Database schema ${current} is newer than supported ${SCHEMA_VERSION}; upgrade pi-tools`);
			}
			if (!memory) {
				db.exec("PRAGMA journal_mode = WAL");
				chmodSync(path, 0o600);
			}
			db.exec("PRAGMA foreign_keys = ON");
			const store = new WorkStore(db, options.now ?? (() => new Date()));
			store.migrate();
			return store;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	private migrate(): void {
		const read = () => Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
		if (read() === SCHEMA_VERSION) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = read();
			if (current > SCHEMA_VERSION) throw new WorkStoreError(`Database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
			for (let version = current; version < SCHEMA_VERSION; version++) this.db.exec(MIGRATIONS[version]);
			this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}

	now(): string {
		return this.clock().toISOString();
	}

	transaction<T>(fn: () => T): T {
		if (this.db.isTransaction) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
		const result = this.db.prepare(sql).run(...params);
		return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
	}

	private one(sql: string, ...params: Param[]): Row | undefined {
		return this.db.prepare(sql).get(...params) as Row | undefined;
	}

	private all(sql: string, ...params: Param[]): Row[] {
		return this.db.prepare(sql).all(...params) as Row[];
	}

	private event(actor: Actor, entity: string, action: string, data: unknown): void {
		this.run("INSERT INTO event (at, actor, entity, action, data) VALUES (?, ?, ?, ?, ?)", this.now(), actor, entity, action, JSON.stringify(data ?? null));
	}

	private requireProject(slug: string): void {
		if (!this.getProject(slug)) throw new WorkStoreError(`Unknown project: ${slug}`);
	}

	// Projects

	upsertProject(input: { slug: string; title: string; status?: ProjectStatus; jiraEpic?: string | null; notesPath?: string | null }, actor: Actor): Project {
		if (!SLUG_PATTERN.test(input.slug)) throw new WorkStoreError(`Invalid project slug: ${input.slug}`);
		return this.transaction(() => {
			const before = this.getProject(input.slug);
			const next: Project = {
				slug: input.slug,
				title: requireText(input.title, "title"),
				status: input.status ?? before?.status ?? "active",
				jiraEpic: input.jiraEpic !== undefined ? input.jiraEpic : (before?.jiraEpic ?? null),
				notesPath: input.notesPath !== undefined ? input.notesPath : (before?.notesPath ?? null),
			};
			if (before && JSON.stringify(before) === JSON.stringify(next)) return before;
			this.run(
				`INSERT INTO project (slug, title, status, jira_epic, notes_path) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(slug) DO UPDATE SET title = excluded.title, status = excluded.status, jira_epic = excluded.jira_epic, notes_path = excluded.notes_path`,
				next.slug, next.title, next.status, next.jiraEpic, next.notesPath,
			);
			this.event(actor, `project:${next.slug}`, before ? "update" : "create", { before: before ?? null, after: next });
			return next;
		});
	}

	getProject(slug: string): Project | undefined {
		const row = this.one("SELECT * FROM project WHERE slug = ?", slug);
		return row ? toProject(row) : undefined;
	}

	listProjects(): Project[] {
		return this.all("SELECT * FROM project ORDER BY slug = 'misc', slug").map(toProject);
	}

	// Items

	addItem(input: { project: string; title: string; notes?: string; origin: Origin; due?: string | null; pinned?: boolean }, actor: Actor): Item {
		return this.transaction(() => {
			this.requireProject(input.project);
			if (input.due) assertDate(input.due);
			const now = this.now();
			const result = this.run(
				"INSERT INTO item (project, title, notes, status, due, pinned, origin, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?)",
				input.project, requireText(input.title, "title"), input.notes ?? "", input.due ?? null, input.pinned ? 1 : 0, input.origin, now, now,
			);
			const item = this.getItem(itemId(result.lastInsertRowid)) as Item;
			this.event(actor, `item:${item.id}`, "create", { after: item });
			return item;
		});
	}

	getItem(id: string): Item | undefined {
		const row = this.one("SELECT * FROM item WHERE num = ?", itemNum(id));
		return row ? toItem(row) : undefined;
	}

	listItems(filter: { statuses?: readonly ItemStatus[]; project?: string } = {}): Item[] {
		const clauses: string[] = [];
		const params: Param[] = [];
		if (filter.statuses?.length) {
			clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
			params.push(...filter.statuses);
		}
		if (filter.project) {
			clauses.push("project = ?");
			params.push(filter.project);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		return this.all(`SELECT * FROM item${where} ORDER BY num`, ...params).map(toItem);
	}

	updateItem(id: string, patch: ItemPatch, actor: Actor): Item {
		return this.transaction(() => {
			const before = this.getItem(id);
			if (!before) throw new WorkStoreError(`Unknown item: ${id}`);
			if (patch.project !== undefined) this.requireProject(patch.project);
			if (patch.due) assertDate(patch.due);
			const status = patch.status ?? before.status;
			let waitingOn = before.waitingOn;
			let waitingReason = before.waitingReason;
			let waitingSince = before.waitingSince;
			if (status === "waiting") {
				waitingOn = patch.waitingOn !== undefined ? patch.waitingOn : before.waitingOn;
				if (!waitingOn) throw new WorkStoreError("waiting_on is required when status is waiting");
				if (patch.waitingReason !== undefined) waitingReason = patch.waitingReason;
				if (before.status !== "waiting") waitingSince = this.now();
			} else {
				if (patch.waitingOn) throw new WorkStoreError("waiting_on is only valid when status is waiting");
				waitingOn = null;
				waitingReason = null;
				waitingSince = null;
			}
			const after: Item = {
				...before,
				project: patch.project ?? before.project,
				title: patch.title !== undefined ? requireText(patch.title, "title") : before.title,
				notes: patch.notes ?? before.notes,
				status,
				waitingOn,
				waitingReason,
				waitingSince,
				due: patch.due !== undefined ? patch.due : before.due,
				pinned: patch.pinned ?? before.pinned,
				updatedAt: before.updatedAt,
			};
			if (JSON.stringify(after) === JSON.stringify(before)) return before;
			after.updatedAt = this.now();
			this.run(
				"UPDATE item SET project = ?, title = ?, notes = ?, status = ?, waiting_on = ?, waiting_reason = ?, waiting_since = ?, due = ?, pinned = ?, updated_at = ? WHERE num = ?",
				after.project, after.title, after.notes, after.status, after.waitingOn, after.waitingReason, after.waitingSince, after.due, after.pinned ? 1 : 0, after.updatedAt, itemNum(id),
			);
			this.event(actor, `item:${id}`, "update", { before, after });
			return after;
		});
	}

	// Links

	addLink(targetItemId: string, input: NewLink, actor: Actor): Link {
		return this.transaction(() => {
			if (!this.getItem(targetItemId)) throw new WorkStoreError(`Unknown item: ${targetItemId}`);
			const existing = this.findLinkByKey(input.key);
			if (existing) throw new WorkStoreError(`Link ${input.key} already belongs to ${existing.itemId}`);
			const state = input.state ?? null;
			const result = this.run(
				"INSERT INTO link (item_num, kind, key, url, state, state_at) VALUES (?, ?, ?, ?, ?, ?)",
				itemNum(targetItemId), input.kind, input.key, input.url ?? null, state === null ? null : JSON.stringify(state), state === null ? null : this.now(),
			);
			const link = this.getLink(result.lastInsertRowid) as Link;
			this.event(actor, `link:${link.id}`, "create", { after: link });
			return link;
		});
	}

	getLink(id: number): Link | undefined {
		const row = this.one("SELECT * FROM link WHERE id = ?", id);
		return row ? toLink(row) : undefined;
	}

	findLinkByKey(key: string): Link | undefined {
		const row = this.one("SELECT * FROM link WHERE key = ?", key);
		return row ? toLink(row) : undefined;
	}

	listLinks(targetItemId: string): Link[] {
		return this.all("SELECT * FROM link WHERE item_num = ? ORDER BY id", itemNum(targetItemId)).map(toLink);
	}

	listAllLinks(): Link[] {
		return this.all("SELECT * FROM link ORDER BY id").map(toLink);
	}

	updateLinkState(linkId: number, state: JsonObject, actor: Actor): Link {
		return this.transaction(() => {
			const before = this.getLink(linkId);
			if (!before) throw new WorkStoreError(`Unknown link: ${linkId}`);
			const serialized = JSON.stringify(state);
			this.run("UPDATE link SET state = ?, state_at = ? WHERE id = ?", serialized, this.now(), linkId);
			if (JSON.stringify(before.state) !== serialized) this.event(actor, `link:${linkId}`, "state", { before: before.state, after: state });
			return this.getLink(linkId) as Link;
		});
	}

	// Signals

	addSignal(input: { itemId: string; linkId: number; kind: SignalKind; detail: string }, actor: Actor): Signal {
		return this.transaction(() => {
			const result = this.run(
				"INSERT INTO signal (item_num, link_id, kind, detail, observed_at) VALUES (?, ?, ?, ?, ?)",
				itemNum(input.itemId), input.linkId, input.kind, input.detail, this.now(),
			);
			const signal = toSignal(this.one("SELECT * FROM signal WHERE id = ?", result.lastInsertRowid) as Row);
			this.event(actor, `signal:${signal.id}`, "create", { after: signal });
			return signal;
		});
	}

	listSignals(filter: { unseenOnly?: boolean; itemId?: string } = {}): Signal[] {
		const clauses: string[] = [];
		const params: Param[] = [];
		if (filter.unseenOnly) clauses.push("seen_in_plan = 0");
		if (filter.itemId) {
			clauses.push("item_num = ?");
			params.push(itemNum(filter.itemId));
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		return this.all(`SELECT * FROM signal${where} ORDER BY id`, ...params).map(toSignal);
	}

	markSignalsSeen(ids: readonly number[], actor: Actor): number {
		if (ids.length === 0) return 0;
		return this.transaction(() => {
			let changed = 0;
			for (const id of ids) changed += this.run("UPDATE signal SET seen_in_plan = 1 WHERE id = ? AND seen_in_plan = 0", id).changes;
			if (changed > 0) this.event(actor, "signals", "seen", { ids: [...ids] });
			return changed;
		});
	}

	// Candidates

	addCandidate(input: NewCandidate, actor: Actor): Candidate {
		return this.transaction(() => {
			const result = this.run(
				`INSERT INTO candidate (kind, source, query, dedupe_key, title, reason, evidence, proposed_project, relates_to, payload, proposer_session, proposer_repo, state, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
				input.kind, input.source, input.query ?? null, input.dedupeKey, input.title, input.reason, input.evidence ?? null, input.proposedProject ?? null,
				input.relatesTo ? itemNum(input.relatesTo) : null, JSON.stringify(input.payload ?? {}), input.proposer?.sessionId ?? null, input.proposer?.repo ?? null, this.now(),
			);
			const candidate = this.getCandidate(result.lastInsertRowid) as Candidate;
			this.event(actor, `candidate:${candidate.id}`, "create", { after: candidate });
			return candidate;
		});
	}

	getCandidate(id: number): Candidate | undefined {
		const row = this.one("SELECT * FROM candidate WHERE id = ?", id);
		return row ? toCandidate(row) : undefined;
	}

	findOpenCandidate(dedupeKey: string): Candidate | undefined {
		const row = this.one("SELECT * FROM candidate WHERE dedupe_key = ? AND state IN ('pending', 'snoozed')", dedupeKey);
		return row ? toCandidate(row) : undefined;
	}

	listCandidates(filter: { states?: readonly CandidateState[]; source?: CandidateSource; query?: string; proposerSession?: string } = {}): Candidate[] {
		const clauses: string[] = [];
		const params: Param[] = [];
		if (filter.states?.length) {
			clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
			params.push(...filter.states);
		}
		if (filter.source) {
			clauses.push("source = ?");
			params.push(filter.source);
		}
		if (filter.query) {
			clauses.push("query = ?");
			params.push(filter.query);
		}
		if (filter.proposerSession) {
			clauses.push("proposer_session = ?");
			params.push(filter.proposerSession);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		return this.all(`SELECT * FROM candidate${where} ORDER BY source, id`, ...params).map(toCandidate);
	}

	updateCandidate(id: number, patch: CandidatePatch, actor: Actor): Candidate {
		return this.transaction(() => {
			const before = this.getCandidate(id);
			if (!before) throw new WorkStoreError(`Unknown candidate: ${id}`);
			const after: Candidate = {
				...before,
				state: patch.state ?? before.state,
				snoozeUntil: patch.snoozeUntil !== undefined ? patch.snoozeUntil : before.snoozeUntil,
				title: patch.title ?? before.title,
				reason: patch.reason ?? before.reason,
				evidence: patch.evidence !== undefined ? patch.evidence : before.evidence,
			};
			if (after.state !== "snoozed") after.snoozeUntil = null;
			if (RESOLVED_STATES.includes(after.state) && !RESOLVED_STATES.includes(before.state)) after.resolvedAt = this.now();
			if (JSON.stringify(after) === JSON.stringify(before)) return before;
			this.run(
				"UPDATE candidate SET state = ?, snooze_until = ?, title = ?, reason = ?, evidence = ?, resolved_at = ? WHERE id = ?",
				after.state, after.snoozeUntil, after.title, after.reason, after.evidence, after.resolvedAt, id,
			);
			this.event(actor, `candidate:${id}`, "update", { before, after });
			return after;
		});
	}

	// Dismissals

	addDismissal(key: string, actor: Actor): void {
		this.transaction(() => {
			const result = this.run("INSERT OR IGNORE INTO dismissal (key, dismissed_at) VALUES (?, ?)", key, this.now());
			if (result.changes > 0) this.event(actor, `dismissal:${key}`, "create", { key });
		});
	}

	isDismissed(key: string): boolean {
		return this.one("SELECT 1 AS found FROM dismissal WHERE key = ?", key) !== undefined;
	}

	removeDismissal(key: string, actor: Actor): boolean {
		return this.transaction(() => {
			const removed = this.run("DELETE FROM dismissal WHERE key = ?", key).changes > 0;
			if (removed) this.event(actor, `dismissal:${key}`, "delete", { key });
			return removed;
		});
	}

	// Plans

	savePlan(input: { date: string; itemIds: string[]; quickActions: string[]; notes: string }, actor: Actor): Plan {
		assertDate(input.date);
		return this.transaction(() => {
			const before = this.getPlan(input.date) ?? null;
			const plan: Plan = { ...input, savedAt: this.now() };
			this.run(
				`INSERT INTO plan (date, item_ids, quick_actions, notes, saved_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, quick_actions = excluded.quick_actions, notes = excluded.notes, saved_at = excluded.saved_at`,
				plan.date, JSON.stringify(plan.itemIds), JSON.stringify(plan.quickActions), plan.notes, plan.savedAt,
			);
			this.event(actor, `plan:${plan.date}`, "save", { before, after: plan });
			return plan;
		});
	}

	getPlan(date: string): Plan | undefined {
		const row = this.one("SELECT * FROM plan WHERE date = ?", date);
		return row ? toPlan(row) : undefined;
	}

	latestPlanBefore(date: string): Plan | undefined {
		const row = this.one("SELECT * FROM plan WHERE date < ? ORDER BY date DESC LIMIT 1", date);
		return row ? toPlan(row) : undefined;
	}

	// Events

	listEvents(filter: { since?: string; until?: string; entityPrefix?: string } = {}): WorkEvent[] {
		const clauses: string[] = [];
		const params: Param[] = [];
		if (filter.since) {
			clauses.push("at >= ?");
			params.push(filter.since);
		}
		if (filter.until) {
			clauses.push("at < ?");
			params.push(filter.until);
		}
		if (filter.entityPrefix) {
			clauses.push("substr(entity, 1, ?) = ?");
			params.push(filter.entityPrefix.length, filter.entityPrefix);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		return this.all(`SELECT * FROM event${where} ORDER BY id`, ...params).map(toEvent);
	}

	lastEventAt(entity: string): string | undefined {
		const row = this.one("SELECT MAX(at) AS at FROM event WHERE entity = ?", entity);
		return row && row.at !== null ? String(row.at) : undefined;
	}

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
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs-me', '', 'auto', ?)`,
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

	// Message log (operational: no events)

	logMessage(entry: Omit<MessageLogEntry, "stateAt"> & { stateAt?: string }): void {
		this.run(
			`INSERT OR IGNORE INTO message_log
			 (id, at, group_label, sender_peer, sender_session, sender_name, recipient_peer, recipient_session, recipient_name, kind, in_reply_to, state, state_at, body)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			entry.id, entry.at, entry.groupLabel, entry.senderPeer, entry.senderSession, entry.senderName, entry.recipientPeer, entry.recipientSession,
			entry.recipientName, entry.kind, entry.inReplyTo, entry.state, entry.stateAt ?? entry.at, entry.body,
		);
	}

	setMessageStates(updates: readonly { id: string; state: string; at: string }[]): number {
		return this.transaction(() => {
			let changed = 0;
			for (const update of updates) changed += this.run(
				"UPDATE message_log SET state = ?, state_at = ? WHERE id = ? AND state <> ? AND (state <> 'uncertain' OR ? IN ('observed', 'canceled', 'dismissed', 'expired', 'terminal-unresolved'))",
				update.state, update.at, update.id, update.state, update.state,
			).changes;
			return changed;
		});
	}

	openMessageIds(): string[] {
		const marks = OPEN_MESSAGE_STATES.map(() => "?").join(", ");
		return this.all(`SELECT id FROM message_log WHERE state IN (${marks}) ORDER BY at, id`, ...OPEN_MESSAGE_STATES).map((row) => String(row.id));
	}

	listMessageLog(filter: { since?: string; peer?: string; limit?: number } = {}): MessageLogEntry[] {
		const clauses: string[] = [];
		const params: Param[] = [];
		if (filter.since) {
			clauses.push("at >= ?");
			params.push(filter.since);
		}
		if (filter.peer) {
			clauses.push("(instr(lower(sender_name), lower(?)) > 0 OR instr(lower(recipient_name), lower(?)) > 0 OR instr(lower(sender_session), lower(?)) = 1 OR instr(lower(recipient_session), lower(?)) = 1)");
			params.push(filter.peer, filter.peer, filter.peer, filter.peer);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		const limit = filter.limit === undefined ? "" : " LIMIT ?";
		if (filter.limit !== undefined) params.push(filter.limit);
		return this.all(`SELECT * FROM message_log${where} ORDER BY at DESC, rowid DESC${limit}`, ...params).map(toMessageLogEntry);
	}

	messageThread(id: string): { message: MessageLogEntry; request: MessageLogEntry | null; replies: MessageLogEntry[] } | undefined {
		const row = this.one("SELECT * FROM message_log WHERE id = ?", id);
		if (!row) return undefined;
		const message = toMessageLogEntry(row);
		const requestRow = message.inReplyTo ? this.one("SELECT * FROM message_log WHERE id = ?", message.inReplyTo) : undefined;
		const replies = this.all("SELECT * FROM message_log WHERE in_reply_to = ? ORDER BY at, rowid", id).map(toMessageLogEntry);
		return { message, request: requestRow ? toMessageLogEntry(requestRow) : null, replies };
	}

	pruneMessageLog(before: string): number {
		return this.run("DELETE FROM message_log WHERE at < ?", before).changes;
	}

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

	// Connector runs and meta (operational: no events)

	recordConnectorRun(input: { connector: string; query: string; status: ConnectorStatus; error: string | null }): void {
		const now = this.now();
		this.run(
			`INSERT INTO connector_run (connector, query, status, error, at, last_ok_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(connector, query) DO UPDATE SET status = excluded.status, error = excluded.error, at = excluded.at,
			 last_ok_at = CASE WHEN excluded.status = 'ok' THEN excluded.at ELSE connector_run.last_ok_at END`,
			input.connector, input.query, input.status, input.error, now, input.status === "ok" ? now : null,
		);
	}

	listConnectorRuns(): ConnectorRun[] {
		return this.all("SELECT * FROM connector_run ORDER BY connector, query").map(toRun);
	}

	getMeta(key: string): string | undefined {
		const row = this.one("SELECT value FROM meta WHERE key = ?", key);
		return row ? String(row.value) : undefined;
	}

	setMeta(key: string, value: string): void {
		this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
	}

	// Backup support

	dumpTables(): Record<string, Record<string, unknown>[]> {
		const out: Record<string, Record<string, unknown>[]> = {};
		for (const table of TABLES) out[table] = this.all(`SELECT * FROM ${table}`).map((row) => ({ ...row }));
		return out;
	}

	isEmpty(): boolean {
		for (const table of ["item", "link", "candidate", "plan", "dismissal", "job", "child_run"]) {
			if (Number((this.one(`SELECT COUNT(*) AS n FROM ${table}`) as Row).n) > 0) return false;
		}
		return true;
	}

	loadTables(rows: { table: string; row: Record<string, unknown> }[]): void {
		this.transaction(() => {
			for (const table of TABLES) {
				for (const entry of rows) {
					if (entry.table !== table) continue;
					const data: Record<string, unknown> = { ...entry.row };
					if (table === "event") delete data.id;
					const columns = Object.keys(data);
					if (!columns.every((column) => /^[a-z_]+$/.test(column))) throw new WorkStoreError(`Invalid column in backup for ${table}`);
					const verb = REPLACE_TABLES.includes(table) ? "INSERT OR REPLACE" : "INSERT";
					this.run(`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...columns.map((column) => data[column] as Param));
				}
			}
			this.event("user", "store", "import", { rows: rows.length });
		});
	}
}
