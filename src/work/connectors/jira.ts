import type { JiraConfig } from "../config.ts";
import type { SecretReader } from "../secrets.ts";
import { errorMessage, redact } from "../secrets.ts";
import type { ConnectorResult, ConnectorStatus, Observation } from "../types.ts";

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
