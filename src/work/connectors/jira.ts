import type { JiraConfig } from "../config.ts";
import type { SecretReader } from "../secrets.ts";
import { errorMessage, redact } from "../secrets.ts";
import type { WorkStore } from "../store.ts";
import type { ConnectorResult, ConnectorStatus, Observation } from "../types.ts";
import type { Actor, Link } from "../types.ts";

export type HttpResponse = { status: number; text(): Promise<string> };
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export class JiraError extends Error {
	status: ConnectorStatus;
	constructor(message: string, status: ConnectorStatus) {
		super(message);
		this.status = status;
	}
}

export type JiraIssue = {
	key: string;
	fields: {
		summary?: string;
		status?: { name?: string; statusCategory?: { key?: string } };
		assignee?: { accountId?: string } | null;
		parent?: { key?: string } | null;
		project?: { key?: string };
	};
};

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SEARCH_FIELDS = ["summary", "status", "assignee", "parent", "project"];
const BATCH = 50;

export class JiraClient {
	config: JiraConfig;
	private deps: { fetch: HttpFetch; readSecret: SecretReader };
	private secrets: string[] = [];
	private authorizationHeader: string | undefined;
	private accountId: string | undefined;

	constructor(config: JiraConfig, deps: { fetch: HttpFetch; readSecret: SecretReader }) {
		this.config = config;
		this.deps = deps;
	}

	clean(text: string): string {
		return redact(text, this.secrets);
	}

	private async authorization(): Promise<string> {
		if (!this.authorizationHeader) {
			const token = await this.deps.readSecret(this.config.secretCommand);
			const encoded = Buffer.from(`${this.config.email}:${token}`).toString("base64");
			this.secrets = [token, encoded];
			this.authorizationHeader = `Basic ${encoded}`;
		}
		return this.authorizationHeader;
	}

	async request(method: string, path: string, body?: unknown): Promise<unknown> {
		let authorization: string;
		try {
			authorization = await this.authorization();
		} catch (error) {
			throw new JiraError(`Jira secret unavailable: ${this.clean(errorMessage(error))}`, "auth-failed");
		}
		const headers: Record<string, string> = { Authorization: authorization, Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		let response: HttpResponse;
		try {
			response = await this.deps.fetch(`${this.config.site}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		} catch (error) {
			throw new JiraError(`Jira unreachable: ${this.clean(errorMessage(error))}`, "unreachable");
		}
		const text = await response.text();
		if (response.status === 401 || response.status === 403) throw new JiraError(`Jira authentication failed (HTTP ${response.status})`, "auth-failed");
		if (response.status < 200 || response.status >= 300) throw new JiraError(`Jira HTTP ${response.status}: ${this.clean(text).slice(0, 300)}`, "error");
		return text ? JSON.parse(text) : undefined;
	}

	async myAccountId(): Promise<string> {
		if (!this.accountId) {
			const me = (await this.request("GET", "/rest/api/3/myself")) as { accountId?: string } | undefined;
			if (!me?.accountId) throw new JiraError("Jira /myself returned no accountId", "error");
			this.accountId = me.accountId;
		}
		return this.accountId;
	}

	async search(jql: string, maxPages = 10): Promise<{ issues: JiraIssue[]; complete: boolean }> {
		const issues: JiraIssue[] = [];
		let nextPageToken: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const body: Record<string, unknown> = { jql, fields: SEARCH_FIELDS, maxResults: 100 };
			if (nextPageToken) body.nextPageToken = nextPageToken;
			const result = (await this.request("POST", "/rest/api/3/search/jql", body)) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
			issues.push(...(result.issues ?? []));
			if (result.isLast === true || !result.nextPageToken) return { issues, complete: true };
			nextPageToken = result.nextPageToken;
		}
		return { issues, complete: false };
	}

	async createIssue(fields: Record<string, unknown>): Promise<string> {
		const created = (await this.request("POST", "/rest/api/3/issue", { fields })) as { key?: string } | undefined;
		if (!created?.key) throw new JiraError("Jira create returned no key", "error");
		return created.key;
	}

	async transitions(key: string): Promise<Transition[]> {
		const result = (await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)) as {
			transitions?: { id: string; name: string; to?: { statusCategory?: { key?: string } } }[];
		} | undefined;
		return (result?.transitions ?? []).map((t) => ({ id: t.id, name: t.name, category: t.to?.statusCategory?.key ?? "unknown" }));
	}

	async transition(key: string, transitionId: string): Promise<void> {
		await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } });
	}
}

export function issueObservation(site: string, issue: JiraIssue, me: string, observedAt: string, reason: string): Observation {
	const summary = issue.fields.summary ?? "";
	const meta: Observation["meta"] = { summary };
	if (issue.fields.parent?.key) meta.jiraEpic = issue.fields.parent.key;
	if (issue.fields.project?.key) meta.jiraProject = issue.fields.project.key;
	return {
		key: `jira:${issue.key}`,
		kind: "jira",
		url: `${site}/browse/${issue.key}`,
		title: `${issue.key}: ${summary}`,
		reason,
		observedAt,
		state: {
			status: issue.fields.status?.name ?? "unknown",
			category: issue.fields.status?.statusCategory?.key ?? "unknown",
			assignedToMe: issue.fields.assignee?.accountId === me,
		},
		meta,
	};
}

function asJiraError(error: unknown): JiraError {
	return error instanceof JiraError ? error : new JiraError(errorMessage(error), "error");
}

function failure(query: string, error: JiraError): ConnectorResult {
	return { connector: "jira", query, complete: false, status: error.status, error: error.message, observations: [] };
}

export async function fetchJira(client: JiraClient, linkedKeys: string[], now: Date): Promise<ConnectorResult[]> {
	const at = now.toISOString();
	const site = client.config.site;
	let me: string;
	try {
		me = await client.myAccountId();
	} catch (error) {
		const e = asJiraError(error);
		return [failure("assigned-open", e), failure("linked-state", e)];
	}
	const results: ConnectorResult[] = [];
	try {
		const found = await client.search("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
		results.push({ connector: "jira", query: "assigned-open", complete: found.complete, status: "ok", observations: found.issues.map((issue) => issueObservation(site, issue, me, at, "Assigned to you in Jira")) });
	} catch (error) {
		results.push(failure("assigned-open", asJiraError(error)));
	}

	const keys = [...new Set(linkedKeys)].filter((key) => ISSUE_KEY.test(key));
	const observations: Observation[] = [];
	let complete = true;
	try {
		for (let i = 0; i < keys.length; i += BATCH) {
			const batch = keys.slice(i, i + BATCH);
			try {
				const found = await client.search(`key in (${batch.join(",")})`);
				complete &&= found.complete;
				observations.push(...found.issues.map((issue) => issueObservation(site, issue, me, at, "Linked ticket")));
			} catch (error) {
				if (asJiraError(error).status !== "error") throw error;
				complete = false;
				for (const key of batch) {
					try {
						const found = await client.search(`key in (${key})`);
						observations.push(...found.issues.map((issue) => issueObservation(site, issue, me, at, "Linked ticket")));
					} catch (inner) {
						if (asJiraError(inner).status !== "error") throw inner;
					}
				}
			}
		}
		results.push({ connector: "jira", query: "linked-state", complete, status: "ok", observations });
	} catch (error) {
		results.push(failure("linked-state", asJiraError(error)));
	}
	return results;
}

export type Transition = { id: string; name: string; category: string };
export type PromotionPreview = { itemId: string; projectKey: string; issueType: string; summary: string; description: string; epic: string | null };

export function promotionPreview(store: WorkStore, itemId: string, config: JiraConfig): PromotionPreview {
	const item = store.getItem(itemId);
	if (!item) throw new JiraError(`Unknown item: ${itemId}`, "error");
	const links = store.listLinks(itemId);
	if (links.some((link) => link.kind === "jira")) throw new JiraError(`${itemId} already has a Jira ticket`, "error");
	const linkLines = links.map((link) => `- ${link.url ?? link.key}`);
	const description = [item.notes.trim(), linkLines.length ? `Links:\n${linkLines.join("\n")}` : ""].filter(Boolean).join("\n\n");
	return {
		itemId,
		projectKey: config.defaultProject,
		issueType: config.defaultIssueType,
		summary: item.title,
		description,
		epic: store.getProject(item.project)?.jiraEpic ?? null,
	};
}

export function formatPreview(preview: PromotionPreview): string {
	return [
		`${preview.issueType} in ${preview.projectKey}${preview.epic ? ` under ${preview.epic}` : ""}, assigned to you`,
		`Summary: ${preview.summary}`,
		preview.description ? `Description:\n${preview.description}` : "Description: (empty)",
	].join("\n");
}

export function adfDocument(text: string): Record<string, unknown> {
	const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim());
	return {
		type: "doc",
		version: 1,
		content: paragraphs.map((paragraph) => ({
			type: "paragraph",
			content: paragraph.split("\n").flatMap((line, index) => [
				...(index > 0 ? [{ type: "hardBreak" }] : []),
				...(line ? [{ type: "text", text: line }] : []),
			]),
		})),
	};
}

export async function promoteItem(store: WorkStore, itemId: string, client: JiraClient, actor: Actor = "user"): Promise<Link> {
	const preview = promotionPreview(store, itemId, client.config);
	const accountId = await client.myAccountId();
	const fields: Record<string, unknown> = {
		project: { key: preview.projectKey },
		issuetype: { name: preview.issueType },
		summary: preview.summary,
		description: adfDocument(preview.description || preview.summary),
		assignee: { accountId },
	};
	if (preview.epic) fields.parent = { key: preview.epic };
	const key = await client.createIssue(fields);
	return store.addLink(itemId, { kind: "jira", key: `jira:${key}`, url: `${client.config.site}/browse/${key}`, state: null }, actor);
}

export function chooseTransition(transitions: Transition[], category: string): Transition | undefined {
	const matches = transitions.filter((transition) => transition.category === category);
	return matches.length === 1 ? matches[0] : undefined;
}

export async function applyJiraUpdate(
	store: WorkStore,
	candidateId: number,
	client: JiraClient,
	pick: (options: Transition[]) => Promise<Transition | undefined>,
	actor: Actor = "user",
): Promise<"applied" | "cancelled"> {
	const candidate = store.getCandidate(candidateId);
	if (!candidate || candidate.kind !== "jira-update" || (candidate.state !== "pending" && candidate.state !== "snoozed")) {
		throw new JiraError(`Candidate ${candidateId} is not an open Jira update`, "error");
	}
	const ticket = String(candidate.payload.ticket);
	const category = String(candidate.payload.targetCategory);
	const transitions = await client.transitions(ticket);
	const chosen = chooseTransition(transitions, category) ?? (await pick(transitions));
	if (!chosen) return "cancelled";
	await client.transition(ticket, chosen.id);
	store.transaction(() => {
		const link = store.findLinkByKey(`jira:${ticket}`);
		if (link) store.updateLinkState(link.id, { ...(link.state ?? {}), category: chosen.category }, actor);
		store.updateCandidate(candidate.id, { state: "accepted" }, actor);
	});
	return "applied";
}
