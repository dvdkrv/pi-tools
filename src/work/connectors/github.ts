import { execFile } from "node:child_process";
import type { GithubAccount } from "../config.ts";
import { jiraKeysIn } from "../rules.ts";
import { errorMessage, redact } from "../secrets.ts";
import type { ConnectorResult, ConnectorStatus, Observation } from "../types.ts";

export type GhRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

export class GhError extends Error {
	status: ConnectorStatus;
	constructor(message: string, status: ConnectorStatus) {
		super(message);
		this.status = status;
	}
}

export function classifyGhError(text: string, code?: unknown): ConnectorStatus {
	if (/bad credentials|authentication|\b401\b|not logged in|gh auth login|no oauth token/i.test(text)) return "auth-failed";
	if (code === "ENOENT") return "error";
	if (/could not resolve|timed? ?out|connection refused|network|ECONN|\b50[234]\b/i.test(text)) return "unreachable";
	return "error";
}

export const defaultGhRunner: GhRunner = (args, env = {}) =>
	new Promise((resolve, reject) => {
		execFile("gh", args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
			if (!error) {
				resolve(stdout);
				return;
			}
			const text = (stderr || error.message).trim();
			reject(new GhError(text.slice(0, 300), classifyGhError(text, (error as NodeJS.ErrnoException).code)));
		});
	});

export function prKey(repo: string, number: number): string {
	return `github:pr:${repo.toLowerCase()}#${number}`;
}

export function parsePrKey(key: string): { repo: string; number: number } | undefined {
	const match = /^github:pr:([^/#\s]+\/[^#\s]+)#(\d+)$/.exec(key);
	return match ? { repo: match[1], number: Number(match[2]) } : undefined;
}

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];

export function checksSummary(rollup: unknown): "passing" | "failing" | "pending" | "none" {
	if (!Array.isArray(rollup) || rollup.length === 0) return "none";
	let pending = false;
	for (const check of rollup as Record<string, unknown>[]) {
		const conclusion = String(check.conclusion ?? "").toUpperCase();
		const state = String(check.state ?? "").toUpperCase();
		const status = String(check.status ?? "").toUpperCase();
		if (FAILED.includes(conclusion) || state === "FAILURE" || state === "ERROR") return "failing";
		if ((status && status !== "COMPLETED") || state === "PENDING" || state === "EXPECTED") pending = true;
	}
	return pending ? "pending" : "passing";
}

type SearchPr = { url: string; title: string; number: number; repository: { nameWithOwner: string } };
type PrView = {
	url: string;
	title: string;
	number: number;
	state: string;
	headRefName?: string;
	reviewDecision?: string;
	reviews?: unknown[];
	comments?: unknown[];
	statusCheckRollup?: unknown[];
};

const SEARCH_LIMIT = 100;
const SEARCH_FIELDS = "url,title,number,repository";
const VIEW_FIELDS = "url,title,number,state,headRefName,reviewDecision,reviews,comments,statusCheckRollup";
const QUERIES = ["review-requested", "authored", "linked-prs"] as const;

function asGhError(error: unknown, secrets: readonly string[] = []): GhError {
	if (error instanceof GhError) return new GhError(redact(error.message, secrets), error.status);
	const message = redact(errorMessage(error), secrets);
	return new GhError(message, classifyGhError(message));
}

function failure(query: string, error: GhError): ConnectorResult {
	return { connector: "github", query, complete: false, status: error.status, error: error.message, observations: [] };
}

function shallowObservation(pr: SearchPr, observedAt: string): Observation {
	const repo = pr.repository.nameWithOwner;
	return {
		key: prKey(repo, pr.number),
		kind: "github-pr",
		url: pr.url,
		title: `Review ${repo}#${pr.number}: ${pr.title}`,
		reason: "Review requested",
		observedAt,
		state: { detailed: false, state: "OPEN" },
		meta: { repo, org: repo.split("/")[0], jiraKeys: jiraKeysIn(pr.title) },
	};
}

function detailedObservation(repo: string, view: PrView, reason: string, observedAt: string): Observation {
	return {
		key: prKey(repo, view.number),
		kind: "github-pr",
		url: view.url,
		title: `${repo}#${view.number}: ${view.title}`,
		reason,
		observedAt,
		state: {
			detailed: true,
			state: view.state,
			checks: checksSummary(view.statusCheckRollup),
			reviews: view.reviews?.length ?? 0,
			comments: view.comments?.length ?? 0,
			reviewDecision: view.reviewDecision || null,
		},
		meta: { repo, org: repo.split("/")[0], jiraKeys: jiraKeysIn(`${view.title} ${view.headRefName ?? ""}`) },
	};
}

export async function fetchGithub(accounts: GithubAccount[], run: GhRunner, linkedPrKeys: string[], now: Date): Promise<ConnectorResult[]> {
	const at = now.toISOString();
	const results: ConnectorResult[] = [];
	const linked = linkedPrKeys.map(parsePrKey).filter((key): key is { repo: string; number: number } => key !== undefined);
	for (const account of accounts) {
		let token: string;
		try {
			token = (await run(["auth", "token", "--user", account.user])).trim();
			if (!token) throw new GhError(`no token for ${account.user}`, "auth-failed");
		} catch (error) {
			const e = asGhError(error);
			const failed = e.status === "error" ? new GhError(e.message, "auth-failed") : e;
			for (const org of account.orgs) for (const query of QUERIES) results.push(failure(`${query}:${org}`, failed));
			continue;
		}
		const gh = async (args: string[]) => {
			try {
				return await run(args, { GH_TOKEN: token });
			} catch (error) {
				throw asGhError(error, [token]);
			}
		};
		const viewPr = async (repo: string, number: number) =>
			JSON.parse(await gh(["pr", "view", String(number), "--repo", repo, "--json", VIEW_FIELDS])) as PrView;

		for (const org of account.orgs) {
			const covered = new Set<string>();
			try {
				const prs = JSON.parse(await gh(["search", "prs", "--review-requested=@me", "--state=open", "--owner", org, "--json", SEARCH_FIELDS, "--limit", String(SEARCH_LIMIT)])) as SearchPr[];
				results.push({ connector: "github", query: `review-requested:${org}`, complete: prs.length < SEARCH_LIMIT, status: "ok", observations: prs.map((pr) => shallowObservation(pr, at)) });
			} catch (error) {
				results.push(failure(`review-requested:${org}`, asGhError(error, [token])));
			}
			try {
				const prs = JSON.parse(await gh(["search", "prs", "--author=@me", "--state=open", "--owner", org, "--json", SEARCH_FIELDS, "--limit", String(SEARCH_LIMIT)])) as SearchPr[];
				const observations: Observation[] = [];
				for (const pr of prs) {
					const repo = pr.repository.nameWithOwner;
					observations.push(detailedObservation(repo, await viewPr(repo, pr.number), "Your open PR", at));
					covered.add(prKey(repo, pr.number));
				}
				results.push({ connector: "github", query: `authored:${org}`, complete: prs.length < SEARCH_LIMIT, status: "ok", observations });
			} catch (error) {
				results.push(failure(`authored:${org}`, asGhError(error, [token])));
			}
			try {
				const observations: Observation[] = [];
				for (const pr of linked) {
					if (pr.repo.split("/")[0] !== org.toLowerCase() || covered.has(prKey(pr.repo, pr.number))) continue;
					observations.push(detailedObservation(pr.repo, await viewPr(pr.repo, pr.number), "Linked PR", at));
				}
				results.push({ connector: "github", query: `linked-prs:${org}`, complete: true, status: "ok", observations });
			} catch (error) {
				results.push(failure(`linked-prs:${org}`, asGhError(error, [token])));
			}
		}
	}
	return results;
}
