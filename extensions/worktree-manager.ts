import { existsSync, readFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { actionPicker, textInput } from "../src/worktree/fuzzy-select.ts";
import {
	discoverRepositories,
	ensureWorktree,
	errorText,
	expandHome,
	forceRemovalPrompt,
	identifyPiManagedWorktree,
	identifyPiManagedWorktreeForRepo,
	isCleanWorktreeStatus,
	managingRepoRootForWorktree,
	parseWorktreeList,
	parseWorktreeManagerConfig,
	runGit,
	tmuxLaunchCommand,
	worktreePickerEntries,
	worktreeRemovalCommands,
	type RepoCandidate,
	type WorktreeEntry,
	type WorktreeManagerConfig,
	type WorktreePickerEntry,
} from "../src/worktree/index.ts";

export {
	discoverRepositories,
	expandHome,
	forceRemovalPrompt,
	identifyPiManagedWorktree,
	identifyPiManagedWorktreeForRepo,
	isCleanWorktreeStatus,
	managingRepoRootForWorktree,
	parseWorktreeList,
	parseWorktreeManagerConfig,
	tmuxLaunchCommand,
	worktreePickerEntries,
	worktreeRemovalCommands,
};
export type { RepoCandidate, WorktreeEntry, WorktreeManagerConfig, WorktreePickerEntry };

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "worktree-manager.json");
}

function loadConfig(): WorktreeManagerConfig & { warnings: string[] } {
	const path = configPath();
	if (!existsSync(path)) return { repoSearchRoots: [], warnings: [] };
	return parseWorktreeManagerConfig(readFileSync(path, "utf8"));
}

type MinimalCommandContext = {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		confirm: (title: string, message: string) => Promise<boolean>;
		custom: <T>(factory: (tui: { requestRender: () => void }, theme: any, keybindings: unknown, done: (value: T) => void) => any) => Promise<T>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
	};
};

function launchTmux(info: { name: string; path: string }, ctx: MinimalCommandContext): void {
	const launch = tmuxLaunchCommand({ name: info.name, path: info.path, insideTmux: Boolean(process.env.TMUX) });
	execFileSync(launch.command, launch.args, { encoding: "utf8" });
	ctx.ui.notify(launch.description, "info");
}

function listWorktreesForRepos(repos: RepoCandidate[], ctx: MinimalCommandContext): WorktreePickerEntry[] {
	const entries: WorktreePickerEntry[] = [];
	for (const repo of repos) {
		try {
			entries.push(...worktreePickerEntries(repo, runGit(repo.root, ["worktree", "list", "--porcelain"])));
		} catch (error) {
			ctx.ui.notify(`Could not list worktrees for ${repo.alias}: ${errorText(error)}`, "warning");
		}
	}
	return entries;
}

async function chooseRepo(repos: RepoCandidate[], ctx: MinimalCommandContext): Promise<RepoCandidate | undefined> {
	type RepoOption = RepoCandidate & { manual?: boolean };
	const options: RepoOption[] = [...repos, { alias: "Enter repo path manually…", root: "", manual: true }];
	const result = await actionPicker(ctx, {
		title: "Create worktree: choose repo",
		items: options,
		limit: 12,
		placeholder: "type repo alias",
		getLabel: (repo) => repo.alias,
		getDescription: (repo) => repo.manual ? "Enter an absolute or ~ path" : repo.root,
		getSearchText: (repo) => `${repo.alias}\n${repo.root}`,
	});
	if (result.type !== "select") return undefined;
	if (!result.item.manual) return result.item;

	const manual = await textInput(ctx, "Repo path", "~/src/github.com/owner/repo");
	if (!manual) return undefined;
	try {
		const root = runGit(expandHome(manual), ["rev-parse", "--show-toplevel"]);
		return { alias: basename(root), root: normalize(root) };
	} catch (error) {
		ctx.ui.notify(`Invalid repo path: ${errorText(error)}`, "error");
		return undefined;
	}
}

async function createWorktreeFlow(repos: RepoCandidate[], ctx: MinimalCommandContext): Promise<void> {
	const repo = await chooseRepo(repos, ctx);
	if (!repo) return;
	const rawName = await textInput(ctx, "Worktree name", "feature-auth");
	if (!rawName) return;

	try {
		const info = ensureWorktree(repo.root, rawName);
		ctx.ui.notify(`${info.created ? "Created" : "Using"} ${repo.alias} / ${info.name}`, "info");
		launchTmux({ name: info.name, path: info.path }, ctx);
	} catch (error) {
		ctx.ui.notify(`Create failed: ${errorText(error)}`, "error");
	}
}

function deleteManagedBranch(repoRoot: string, branch: string | undefined, ctx: MinimalCommandContext): void {
	if (!branch) return;
	try {
		runGit(repoRoot, ["branch", "-D", branch]);
	} catch (error) {
		ctx.ui.notify(`Branch deletion failed for ${branch}: ${errorText(error)}`, "warning");
	}
}

async function deleteWorktree(entry: WorktreePickerEntry, ctx: MinimalCommandContext): Promise<void> {
	if (!entry.managed) {
		ctx.ui.notify("Only Pi-managed worktrees can be deleted with D", "warning");
		return;
	}

	const remove = await ctx.ui.confirm("Remove Pi worktree?", `Remove ${entry.label}?\n\n${entry.path}`);
	if (!remove) return;

	const commands = worktreeRemovalCommands(entry.path);
	try {
		runGit(entry.repo.root, commands.safe);
		deleteManagedBranch(entry.repo.root, entry.managed.branch, ctx);
		ctx.ui.notify(`Removed ${entry.label}`, "info");
		return;
	} catch (error) {
		const failure = errorText(error);
		const force = await ctx.ui.confirm("Force-remove Pi worktree?", forceRemovalPrompt(entry.path, failure));
		if (!force) {
			ctx.ui.notify(`Kept ${entry.label}`, "info");
			return;
		}
	}

	try {
		runGit(entry.repo.root, commands.force);
		deleteManagedBranch(entry.repo.root, entry.managed.branch, ctx);
		ctx.ui.notify(`Force-removed ${entry.label}`, "info");
	} catch (error) {
		ctx.ui.notify(`Force removal failed: ${errorText(error)}`, "error");
	}
}

async function showWorktreePicker(ctx: MinimalCommandContext): Promise<void> {
	const config = loadConfig();
	for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
	const discovered = discoverRepositories({ cwd: ctx.cwd, config });
	for (const warning of discovered.warnings) ctx.ui.notify(warning, "warning");

	if (discovered.repos.length === 0) {
		ctx.ui.notify("No repos found. Add repoSearchRoots to ~/.pi/agent/worktree-manager.json or run from a git repo.", "warning");
		return;
	}

	const entries = listWorktreesForRepos(discovered.repos, ctx);
	const result = await actionPicker(ctx, {
		title: "Worktrees",
		items: entries,
		limit: 12,
		placeholder: "type repo or worktree",
		emptyText: "No worktrees. Press N to create one.",
		getLabel: (entry) => entry.label,
		getDescription: (entry) => entry.description,
		getSearchText: (entry) => entry.searchText,
		actions: [
			{ key: "N", label: "new" },
			{ key: "D", label: "delete", requiresSelection: true },
		],
	});

	if (result.type === "cancel") return;
	if (result.type === "custom" && result.key === "N") {
		await createWorktreeFlow(discovered.repos, ctx);
		return;
	}
	if (result.type === "custom" && result.key === "D" && result.item) {
		await deleteWorktree(result.item, ctx);
		return;
	}
	if (result.type === "select") {
		try {
			launchTmux({ name: result.item.name, path: result.item.path }, ctx);
		} catch (error) {
			ctx.ui.notify(`Tmux launch failed: ${errorText(error)}`, "error");
		}
	}
}

export function shouldCleanupManagedWorktree(event: { reason?: string }): boolean {
	return event.reason === "quit";
}

async function cleanupCurrentManagedWorktree(event: { reason?: string }, ctx: MinimalCommandContext): Promise<void> {
	if (!shouldCleanupManagedWorktree(event)) return;

	let managed: WorktreeEntry | undefined;
	try {
		const root = runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
		const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
		managed = identifyPiManagedWorktree(root, branch);
	} catch {
		return;
	}
	if (!managed?.branch) return;

	const repoRoot = managingRepoRootForWorktree(managed.path);
	const autoCleanup = process.env.PI_WORKTREE_AUTO_CLEANUP === "1";
	if (autoCleanup) {
		const status = runGit(managed.path, ["status", "--porcelain"]);
		if (!isCleanWorktreeStatus(status)) {
			ctx.ui.notify(`Kept dirty worktree ${managed.name}; clean or remove it explicitly`, "warning");
			return;
		}
	} else {
		if (!ctx.hasUI) return;
		const remove = await ctx.ui.confirm("Remove Pi worktree?", `Remove clean worktree ${managed.name}?\n\n${managed.path}\n\nThe branch will be preserved.`);
		if (!remove) return;
	}

	try {
		runGit(repoRoot, worktreeRemovalCommands(managed.path).safe);
		ctx.ui.notify(`Removed worktree ${managed.name}; preserved branch ${managed.branch}`, "info");
	} catch (error) {
		ctx.ui.notify(`Safe worktree cleanup failed; worktree and branch were preserved: ${errorText(error)}`, "error");
	}
}

export default function worktreeManager(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async (event, ctx) => {
		await cleanupCurrentManagedWorktree(event, ctx as MinimalCommandContext);
	});

	pi.registerCommand("worktree", {
		description: "Pick, create, or remove Pi-managed git worktrees",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/worktree is available only in interactive TUI mode", "error");
				return;
			}
			await showWorktreePicker(ctx as MinimalCommandContext);
		},
	});
}
