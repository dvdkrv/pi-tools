export type ProjectStatus = "active" | "parked" | "archived";
export type ItemStatus = "todo" | "doing" | "waiting" | "parked" | "done" | "dropped";
export type WaitingOn = "review" | "ci" | "person" | "external";
export type Origin = "manual" | "jira" | "github" | "agent";
export type LinkKind = "jira" | "github-pr" | "github-issue" | "chat" | "note" | "url" | "session";
export type CandidateKind = "new-item" | "attach-link" | "jira-update";
export type CandidateSource = "jira" | "github" | "agent";
export type CandidateState = "pending" | "accepted" | "merged" | "dismissed" | "snoozed" | "withdrawn";
export type SignalKind =
	| "pr-merged"
	| "pr-closed"
	| "review-received"
	| "comments-new"
	| "checks-failing"
	| "checks-passing"
	| "jira-status-changed"
	| "jira-unassigned";
export type ConnectorStatus = "ok" | "auth-failed" | "unreachable" | "error";
export type Actor = "user" | "planner" | `agent:${string}` | `sync:${string}` | `session:${string}`;
export type JsonObject = Record<string, unknown>;

export const ITEM_STATUSES: readonly ItemStatus[] = ["todo", "doing", "waiting", "parked", "done", "dropped"];
export const WAITING_ON: readonly WaitingOn[] = ["review", "ci", "person", "external"];
export const OPEN_ITEM_STATUSES: readonly ItemStatus[] = ["todo", "doing", "waiting", "parked"];

export type Project = { slug: string; title: string; status: ProjectStatus; jiraEpic: string | null; notesPath: string | null };

export type Item = {
	id: string;
	project: string;
	title: string;
	notes: string;
	status: ItemStatus;
	waitingOn: WaitingOn | null;
	waitingReason: string | null;
	waitingSince: string | null;
	due: string | null;
	pinned: boolean;
	origin: Origin;
	createdAt: string;
	updatedAt: string;
};

export type Link = {
	id: number;
	itemId: string;
	kind: LinkKind;
	key: string;
	url: string | null;
	state: JsonObject | null;
	stateAt: string | null;
};

export type NewLink = { kind: LinkKind; key: string; url?: string | null; state?: JsonObject | null };

export type Signal = {
	id: number;
	itemId: string;
	linkId: number;
	kind: SignalKind;
	detail: string;
	observedAt: string;
	seenInPlan: boolean;
};

export type Proposer = { sessionId: string; repo: string | null };

export type Candidate = {
	id: number;
	kind: CandidateKind;
	source: CandidateSource;
	query: string | null;
	dedupeKey: string;
	title: string;
	reason: string;
	evidence: string | null;
	proposedProject: string | null;
	relatesTo: string | null;
	payload: JsonObject;
	proposer: Proposer | null;
	state: CandidateState;
	snoozeUntil: string | null;
	createdAt: string;
	resolvedAt: string | null;
};

export type NewCandidate = {
	kind: CandidateKind;
	source: CandidateSource;
	query?: string | null;
	dedupeKey: string;
	title: string;
	reason: string;
	evidence?: string | null;
	proposedProject?: string | null;
	relatesTo?: string | null;
	payload?: JsonObject;
	proposer?: Proposer | null;
};

export type Plan = { date: string; itemIds: string[]; quickActions: string[]; notes: string; savedAt: string };

export type WorkEvent = { id: number; at: string; actor: string; entity: string; action: string; data: unknown };

export type ConnectorRun = {
	connector: string;
	query: string;
	status: ConnectorStatus;
	error: string | null;
	at: string;
	lastOkAt: string | null;
};

export type ObservationMeta = {
	repo?: string;
	org?: string;
	jiraKeys?: string[];
	jiraEpic?: string;
	jiraProject?: string;
	summary?: string;
};

export type Observation = {
	key: string;
	kind: LinkKind;
	url: string;
	title: string;
	reason: string;
	state: JsonObject;
	observedAt: string;
	meta: ObservationMeta;
};

export type ConnectorResult = {
	connector: "jira" | "github";
	query: string;
	complete: boolean;
	status: ConnectorStatus;
	error?: string;
	observations: Observation[];
};

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

export type UsageSurface = "dash" | "cli" | "pi" | "triage" | "planner";
export type UsageContext = Record<string, number | boolean | string>;
export type UsageRow = { id: number; at: string; surface: UsageSurface; action: string; context: UsageContext };
