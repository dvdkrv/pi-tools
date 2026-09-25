import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkConfig } from "./config.ts";
import { defaultConfigPath, defaultDataDir, loadWorkConfig } from "./config.ts";
import type { GhRunner } from "./connectors/github.ts";
import { defaultGhRunner } from "./connectors/github.ts";
import { JiraClient } from "./connectors/jira.ts";
import { commandSecretReader } from "./secrets.ts";
import { WorkStore } from "./store.ts";

export type Runtime = {
	store: WorkStore;
	config: WorkConfig;
	warnings: string[];
	dataDir: string;
	backupDir: string;
	jira?: JiraClient;
	gh?: GhRunner;
	knownProjects(): Set<string>;
};

export type RuntimeOptions = { env?: NodeJS.ProcessEnv; home?: string; now?: () => Date; configPath?: string; dataDir?: string };

export function applyConfigProjects(store: WorkStore, config: WorkConfig): void {
	for (const project of config.projects) {
		store.upsertProject({ slug: project.slug, title: project.title, jiraEpic: project.jiraEpic ?? null, notesPath: project.notesPath ?? null }, "user");
	}
}

export function openRuntime(options: RuntimeOptions = {}): Runtime {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const dataDir = options.dataDir ?? defaultDataDir(env, home);
	const { config, warnings } = loadWorkConfig(options.configPath ?? defaultConfigPath(env, home));
	const store = WorkStore.open(join(dataDir, "work.db"), { now: options.now });
	chmodSync(dataDir, 0o700);
	applyConfigProjects(store, config);
	const jira = config.jira
		? new JiraClient(config.jira, { fetch: (url, init) => fetch(url, init), readSecret: commandSecretReader })
		: undefined;
	return {
		store,
		config,
		warnings,
		dataDir,
		backupDir: join(dataDir, "backups"),
		jira,
		gh: config.github.accounts.length > 0 ? defaultGhRunner : undefined,
		knownProjects: () => new Set(store.listProjects().map((project) => project.slug)),
	};
}
