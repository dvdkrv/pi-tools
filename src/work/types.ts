export type ProjectStatus = "active" | "parked" | "archived";
export type ItemStatus = "todo" | "doing" | "waiting" | "parked" | "done" | "dropped";
export type WaitingOn = "review" | "ci" | "person" | "external";
export type Origin = "manual" | "jira" | "github" | "agent";
export type LinkKind = "jira" | "github-pr" | "github-issue" | "chat" | "note" | "url";
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
export type Actor = "user" | "planner" | `agent:${string}` | `sync:${string}`;
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
