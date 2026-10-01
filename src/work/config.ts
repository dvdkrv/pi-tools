import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoMatches } from "./rules.ts";
import { SLUG_PATTERN } from "./store.ts";

export type JiraConfig = { site: string; email: string; secretCommand: string[]; defaultProject: string; defaultIssueType: string };
export type GithubAccount = { user: string; orgs: string[] };
export type ProjectConfig = { slug: string; title: string; jiraEpic?: string; notesPath?: string };
export type Rule = { project: string; repo?: string; jiraEpic?: string; jiraProject?: string };
export type DashboardConfig = { showTriage: boolean };
export type MessagingConfig = { autoJoin: boolean; sendsPerHour: number; paused: boolean | string[]; retentionDays: number; routeCooldownMinutes: number };
export type WorkConfig = { jira?: JiraConfig; github: { accounts: GithubAccount[] }; projects: ProjectConfig[]; rules: Rule[]; plannerCwd?: string; usage?: boolean; notifications?: boolean; children?: ChildrenConfig; dashboard?: DashboardConfig; messaging?: MessagingConfig; bashTimeoutMinutes?: number };
export type LoadedConfig = { config: WorkConfig; warnings: string[] };
export type RepoChildrenConfig = { ignore: string[]; expensiveCommands: string[] };
export type DiffBudgetConfig = { defaultLines: number; defaultFiles: number; maxLines: number; prLines: number };
export type ChildrenConfig = {
	defaultModel: string;
	diffBudget: DiffBudgetConfig;
	spendCapUsd: number;
	commandTimeoutMinutes: number;
	warnPercent: number;
	// USD per million tokens. Cache reads and writes default to 10% and 125% of input when unset.
	pricing: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
	repos: Record<string, RepoChildrenConfig>;
};

export const DEFAULT_CHILDREN: ChildrenConfig = {
	defaultModel: "ai-gw-openai/openai/gpt-5.6-sol",
	diffBudget: { defaultLines: 300, defaultFiles: 8, maxLines: 800, prLines: 2000 },
	spendCapUsd: 5,
	commandTimeoutMinutes: 10,
	warnPercent: 80,
	pricing: {
		// List prices from Pi's model store for the same models (gateway models report cost 0).
		"ai-gw-openai/openai/gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
		"ai-gw-openai/openai/gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
		"ai-gw-openai/openai/gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		"ai-gw-anthropic-*/anthropic/claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	repos: {},
};

export const DEFAULT_BASH_TIMEOUT_MINUTES = 30;
export const DEFAULT_MESSAGING: MessagingConfig = { autoJoin: true, sendsPerHour: 10, paused: false, retentionDays: 30, routeCooldownMinutes: 10 };

// The timeout the tool_call hook gives a bash call that sets none (child runs keep their stricter commandTimeoutMinutes).
export function bashTimeoutMinutes(config: WorkConfig): number {
	return config.bashTimeoutMinutes ?? DEFAULT_BASH_TIMEOUT_MINUTES;
}

export function childrenConfig(config: WorkConfig): ChildrenConfig {
	return config.children ?? DEFAULT_CHILDREN;
}

export function messagingConfig(config: WorkConfig): MessagingConfig {
	return config.messaging ?? DEFAULT_MESSAGING;
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

function positiveNumber(record: Record<string, unknown>, key: string, fallback: number, path: string, warnings: string[], integer: boolean): number {
	const value = record[key];
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value))) return value;
	warnings.push(`${path}.${key} must be a positive ${integer ? "integer" : "number"}; using ${fallback}`);
	return fallback;
}

export function parseMessaging(value: unknown, warnings: string[]): MessagingConfig {
	const d = DEFAULT_MESSAGING;
	if (!isRecord(value)) {
		warnings.push("messaging must be an object; using the defaults");
		return d;
	}
	let autoJoin = d.autoJoin;
	if (value.autoJoin !== undefined) {
		if (typeof value.autoJoin === "boolean") autoJoin = value.autoJoin;
		else warnings.push(`messaging.autoJoin must be true or false; using ${d.autoJoin}`);
	}
	let sendsPerHour = positiveNumber(value, "sendsPerHour", d.sendsPerHour, "messaging", warnings, true);
	if (sendsPerHour > 1000) {
		warnings.push(`messaging.sendsPerHour must be at most 1000; using ${d.sendsPerHour}`);
		sendsPerHour = d.sendsPerHour;
	}
	let paused: boolean | string[] = d.paused;
	if (value.paused !== undefined) {
		if (typeof value.paused === "boolean") paused = value.paused;
		else if (Array.isArray(value.paused) && value.paused.every((name) => typeof name === "string" && name.trim())) paused = value.paused.map((name) => (name as string).trim());
		else warnings.push("messaging.paused must be true, false, or a list of session names or id prefixes; using false");
	}
	return {
		autoJoin,
		sendsPerHour,
		paused,
		retentionDays: positiveNumber(value, "retentionDays", d.retentionDays, "messaging", warnings, true),
		routeCooldownMinutes: positiveNumber(value, "routeCooldownMinutes", d.routeCooldownMinutes, "messaging", warnings, false),
	};
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
	if (value.pricing !== undefined && !isRecord(value.pricing)) warnings.push("children.pricing must be an object keyed by model; invalid entries skipped");
	const pricing: ChildrenConfig["pricing"] = { ...d.pricing };
	for (const [model, entry] of Object.entries(isRecord(value.pricing) ? value.pricing : {})) {
		const input = isRecord(entry) ? entry.input : undefined;
		const output = isRecord(entry) ? entry.output : undefined;
		if (model.trim() && typeof input === "number" && Number.isFinite(input) && input > 0 && typeof output === "number" && Number.isFinite(output) && output > 0) {
			const price: ChildrenConfig["pricing"][string] = { input, output };
			for (const field of ["cacheRead", "cacheWrite"] as const) {
				const rate = (entry as Record<string, unknown>)[field];
				if (rate === undefined) continue;
				if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0) price[field] = rate;
				else warnings.push(`children.pricing.${model}.${field} must be a non-negative price; using the default`);
			}
			pricing[model] = price;
		} else warnings.push(`children.pricing.${model} needs positive input and output prices; skipped`);
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
		pricing,
		repos,
	};
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
	if (data.usage !== undefined) {
		if (typeof data.usage === "boolean") config.usage = data.usage;
		else warnings.push("usage must be true or false; usage tracking stays on");
	}
	if (data.dashboard !== undefined) {
		if (!isRecord(data.dashboard)) warnings.push("dashboard must be an object; using the defaults");
		else if (data.dashboard.showTriage === undefined || typeof data.dashboard.showTriage === "boolean") {
			config.dashboard = { showTriage: data.dashboard.showTriage === true };
		} else {
			config.dashboard = { showTriage: false };
			warnings.push("dashboard.showTriage must be true or false; using false");
		}
	}
	if (data.notifications !== undefined) {
		if (typeof data.notifications === "boolean") config.notifications = data.notifications;
		else warnings.push("notifications must be true or false; notifications stay on");
	}
	if (data.bashTimeoutMinutes !== undefined) {
		const minutes = data.bashTimeoutMinutes;
		if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) config.bashTimeoutMinutes = minutes;
		else warnings.push(`bashTimeoutMinutes must be a positive number; using ${DEFAULT_BASH_TIMEOUT_MINUTES}`);
	}
	if (data.children !== undefined) config.children = parseChildren(data.children, warnings);
	if (data.messaging !== undefined) config.messaging = parseMessaging(data.messaging, warnings);
	return { config, warnings };
}

export function loadWorkConfig(path: string = defaultConfigPath()): LoadedConfig {
	if (!existsSync(path)) return { config: emptyConfig(), warnings: [`work config not found at ${path}; Jira and GitHub are disabled`] };
	return parseWorkConfig(readFileSync(path, "utf8"));
}
