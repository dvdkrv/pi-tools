import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { Rule } from "./config.ts";
import type { WorkStore } from "./store.ts";
import { OPEN_ITEM_STATUSES } from "./types.ts";

export type ProjectHints = { repo?: string; jiraEpic?: string; jiraProject?: string };
export type GitRunner = (cwd: string, args: string[]) => string;

const defaultGit: GitRunner = (cwd, args) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function repoMatches(ruleRepo: string, repo: string): boolean {
	const a = ruleRepo.toLowerCase();
	const b = repo.toLowerCase();
	return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

export function projectFor(hints: ProjectHints, rules: Rule[], known: ReadonlySet<string>): string {
	for (const rule of rules) {
		if (!known.has(rule.project)) continue;
		if (rule.repo && hints.repo && repoMatches(rule.repo, hints.repo)) return rule.project;
		if (rule.jiraEpic && hints.jiraEpic === rule.jiraEpic) return rule.project;
		if (rule.jiraProject && hints.jiraProject === rule.jiraProject) return rule.project;
	}
	return "misc";
}

export function repoFromCwd(cwd: string, git: GitRunner = defaultGit): string | undefined {
	try {
		const common = resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
		const repoDir = basename(common) === ".git" ? dirname(common) : common;
		return basename(repoDir) || undefined;
	} catch {
		return undefined;
	}
}

const JIRA_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

export function jiraKeysIn(text: string): string[] {
	return [...new Set(text.match(JIRA_KEY) ?? [])];
}

export function itemForKeys(store: WorkStore, keys: string[]): string | undefined {
	for (const key of keys) {
		const link = store.findLinkByKey(key);
		if (link) return link.itemId;
	}
	return undefined;
}

export function itemWithoutJiraByTitle(store: WorkStore, title: string): string | undefined {
	const wanted = title.trim().toLowerCase();
	for (const item of store.listItems({ statuses: OPEN_ITEM_STATUSES })) {
		if (item.title.trim().toLowerCase() !== wanted) continue;
		if (store.listLinks(item.id).some((link) => link.kind === "jira")) continue;
		return item.id;
	}
	return undefined;
}
