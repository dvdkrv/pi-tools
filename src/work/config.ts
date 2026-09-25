import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SLUG_PATTERN } from "./store.ts";

export type JiraConfig = { site: string; email: string; secretCommand: string[]; defaultProject: string; defaultIssueType: string };
export type GithubAccount = { user: string; orgs: string[] };
export type ProjectConfig = { slug: string; title: string; jiraEpic?: string; notesPath?: string };
export type Rule = { project: string; repo?: string; jiraEpic?: string; jiraProject?: string };
export type WorkConfig = { jira?: JiraConfig; github: { accounts: GithubAccount[] }; projects: ProjectConfig[]; rules: Rule[]; plannerCwd?: string };
export type LoadedConfig = { config: WorkConfig; warnings: string[] };

export function emptyConfig(): WorkConfig {
	return { github: { accounts: [] }, projects: [], rules: [] };
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "work", "config.json");
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "work");
}

export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJira(value: unknown, warnings: string[]): JiraConfig | undefined {
	const record = isRecord(value) ? value : {};
	const site = str(record.site);
	const email = str(record.email);
	const defaultProject = str(record.defaultProject);
	const command = isRecord(record.secret) ? record.secret.command : undefined;
	const validCommand = Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string" && part.length > 0);
	if (site && site.startsWith("https://") && email && defaultProject && validCommand) {
		return {
			site: site.replace(/\/+$/, ""),
			email,
			secretCommand: command as string[],
			defaultProject,
			defaultIssueType: str(record.defaultIssueType) ?? "Task",
		};
	}
	warnings.push("jira config needs an https site, email, secret.command, and defaultProject; Jira is disabled");
	return undefined;
}

export function parseWorkConfig(raw: string): LoadedConfig {
	const warnings: string[] = [];
	const config = emptyConfig();
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return { config, warnings: ["work config is not valid JSON; Jira and GitHub are disabled"] };
	}
	if (!isRecord(data)) return { config, warnings: ["work config must be a JSON object; Jira and GitHub are disabled"] };

	if (data.jira !== undefined) config.jira = parseJira(data.jira, warnings);

	if (data.github !== undefined) {
		const accounts = isRecord(data.github) && Array.isArray(data.github.accounts) ? data.github.accounts : undefined;
		if (!accounts) warnings.push("github.accounts must be a list; GitHub is disabled");
		for (const [index, account] of (accounts ?? []).entries()) {
			const user = isRecord(account) ? str(account.user) : undefined;
			const orgs = isRecord(account) && Array.isArray(account.orgs)
				? account.orgs.map(str).filter((org): org is string => Boolean(org))
				: [];
			if (user && orgs.length > 0) config.github.accounts.push({ user, orgs });
			else warnings.push(`github.accounts[${index}] needs user and orgs; skipped`);
		}
	}

	for (const [index, project] of (Array.isArray(data.projects) ? data.projects : []).entries()) {
		const slug = isRecord(project) ? str(project.slug) : undefined;
		const title = isRecord(project) ? str(project.title) : undefined;
		if (!slug || !SLUG_PATTERN.test(slug) || !title) {
			warnings.push(`projects[${index}] needs a lowercase kebab-case slug and a title; skipped`);
			continue;
		}
		const entry: ProjectConfig = { slug, title };
		const jiraEpic = str((project as Record<string, unknown>).jiraEpic);
		const notesPath = str((project as Record<string, unknown>).notesPath);
		if (jiraEpic) entry.jiraEpic = jiraEpic;
		if (notesPath) entry.notesPath = notesPath;
		config.projects.push(entry);
	}

	for (const [index, rule] of (Array.isArray(data.rules) ? data.rules : []).entries()) {
		const record = isRecord(rule) ? rule : {};
		const project = str(record.project);
		const matchers = (["repo", "jiraEpic", "jiraProject"] as const).filter((field) => str(record[field]));
		if (!project || !SLUG_PATTERN.test(project) || matchers.length !== 1) {
			warnings.push(`rules[${index}] needs a project and exactly one of repo, jiraEpic, or jiraProject; skipped`);
			continue;
		}
		const entry: Rule = { project };
		entry[matchers[0]] = str(record[matchers[0]]);
		config.rules.push(entry);
	}

	if (isRecord(data.planner)) {
		const cwd = str(data.planner.cwd);
		if (cwd) config.plannerCwd = cwd;
	}
	return { config, warnings };
}

export function loadWorkConfig(path: string = defaultConfigPath()): LoadedConfig {
	if (!existsSync(path)) return { config: emptyConfig(), warnings: [`work config not found at ${path}; Jira and GitHub are disabled`] };
	return parseWorkConfig(readFileSync(path, "utf8"));
}
