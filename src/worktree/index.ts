import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export type WorktreeEntry = { path: string; name: string; branch: string | undefined };
export type RepoCandidate = { alias: string; root: string };
export type WorktreeManagerConfig = { repoSearchRoots: string[] };
export type WorktreePlan = { repoRoot: string; name: string; branch: string; path: string };
export type WorktreeBaseMode = "current" | "remoteDefault";
export type EnsureWorktreeOptions = { baseRef?: string; defaultBase?: WorktreeBaseMode };
export type EnsuredWorktree = WorktreePlan & { created: boolean };
export type WorktreePickerEntry = WorktreeEntry & {
	repo: RepoCandidate;
	label: string;
	description: string;
	searchText: string;
	managed?: WorktreeEntry;
};
export type RepoDiscoveryOps = {
	listDirectories: (path: string) => string[];
	gitRoot: (path: string) => string | undefined;
	realpath: (path: string) => string;
};

export function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function errorText(error: unknown): string {
	if (error && typeof error === "object") {
		const maybe = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
		const parts = [maybe.stderr, maybe.stdout, maybe.message]
			.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
			.map((part) => part.trim());
		if (parts.length > 0) return parts.join("\n");
	}
	return error instanceof Error ? error.message : String(error);
}

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-") || "worktree";
}

export function shellQuote(input: string): string {
	return `'${input.replace(/'/g, `'\\''`)}'`;
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	for (const rawBlock of porcelain.split(/\n\s*\n/)) {
		const block = rawBlock.trim();
		if (!block) continue;
		const lines = block.split(/\n/);
		const worktreeLine = lines.find((line) => line.startsWith("worktree "));
		if (!worktreeLine) continue;

		const path = worktreeLine.slice("worktree ".length);
		const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
		const branch = branchRef?.replace(/^refs\/heads\//, "");
		entries.push({ path, name: basename(path), branch });
	}
	return entries;
}

export function tmuxLaunchCommand(info: { name: string; path: string; insideTmux?: boolean }): {
	command: "tmux";
	args: string[];
	description: string;
} {
	const windowName = slugify(info.name);
	if (info.insideTmux) {
		return {
			command: "tmux",
			args: ["new-window", "-n", windowName, "-c", info.path, "pi -c"],
			description: `Started tmux window ${windowName}`,
		};
	}

	const session = `pi-${windowName}`;
	return {
		command: "tmux",
		args: ["new-session", "-d", "-s", session, "-c", info.path, "pi -c"],
		description: `Started tmux session ${session}. Attach with: tmux attach -t ${session}`,
	};
}

export function tmuxPiLaunchCommand(info: { name: string; path: string; prompt: string; insideTmux?: boolean; split?: boolean; autoCleanup?: boolean }): {
	command: "tmux";
	args: string[];
	description: string;
} {
	const windowName = slugify(info.name);
	const command = `${info.autoCleanup ? "PI_WORKTREE_AUTO_CLEANUP=1 " : ""}pi ${shellQuote(info.prompt)}`;
	if (info.insideTmux && info.split) {
		return {
			command: "tmux",
			args: ["split-window", "-c", info.path, command],
			description: `Started tmux split pane ${windowName}`,
		};
	}
	if (info.insideTmux) {
		return {
			command: "tmux",
			args: ["new-window", "-n", windowName, "-c", info.path, command],
			description: `Started tmux window ${windowName}`,
		};
	}
	const session = `pi-${windowName}`;
	return {
		command: "tmux",
		args: ["new-session", "-d", "-s", session, "-c", info.path, command],
		description: `Started tmux session ${session}. Attach with: tmux attach -t ${session}`,
	};
}

export function identifyPiManagedWorktree(repoRoot: string, branch: string): WorktreeEntry | undefined {
	const normalized = normalize(repoRoot);
	const marker = `${sep}.pi${sep}worktrees${sep}`;
	const markerIndex = normalized.indexOf(marker);
	if (markerIndex === -1) return undefined;
	if (!branch.startsWith("worktree-")) return undefined;

	const name = normalized.slice(markerIndex + marker.length);
	if (!name || name.includes(sep) || branch !== `worktree-${name}`) return undefined;

	return { path: normalized, name, branch };
}

export function identifyPiManagedWorktreeForRepo(repoRoot: string, worktreePath: string, branch?: string): WorktreeEntry | undefined {
	if (!branch) return undefined;
	const normalizedRepo = normalize(repoRoot);
	const normalizedPath = normalize(worktreePath);
	const prefix = normalize(join(normalizedRepo, ".pi", "worktrees")) + sep;
	if (!normalizedPath.startsWith(prefix)) return undefined;

	const name = normalizedPath.slice(prefix.length);
	if (!name || name.includes(sep) || branch !== `worktree-${name}`) return undefined;
	return { path: normalizedPath, name, branch };
}

export function managingRepoRootForWorktree(worktreePath: string): string {
	return dirname(dirname(dirname(normalize(worktreePath))));
}

export function worktreeRemovalCommands(worktreePath: string): { safe: string[]; force: string[] } {
	return {
		safe: ["worktree", "remove", worktreePath],
		force: ["worktree", "remove", "--force", worktreePath],
	};
}

export function isCleanWorktreeStatus(porcelain: string): boolean {
	return porcelain.trim().length === 0;
}

export function forceRemovalPrompt(worktreePath: string, failure: string): string {
	return `Safe removal failed:\n\n${failure}\n\nForce-remove this worktree? This will run:\n\n  git worktree remove --force ${worktreePath}\n\nThe worktree directory and uncommitted/untracked files under this path would be removed:\n\n${worktreePath}`;
}

export function parseWorktreeManagerConfig(raw: string): WorktreeManagerConfig & { warnings: string[] } {
	const warnings: string[] = [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { repoSearchRoots: [], warnings: ["worktree-manager config is not valid JSON"] };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { repoSearchRoots: [], warnings: ["worktree-manager config must be an object"] };
	}

	const value = (parsed as { repoSearchRoots?: unknown }).repoSearchRoots;
	if (value === undefined) return { repoSearchRoots: [], warnings };
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		warnings.push("repoSearchRoots must be an array of strings");
		return { repoSearchRoots: [], warnings };
	}
	return { repoSearchRoots: value, warnings };
}

export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function defaultRepoDiscoveryOps(): RepoDiscoveryOps {
	return {
		listDirectories(path: string): string[] {
			return readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(path, entry.name));
		},
		gitRoot(path: string): string | undefined {
			try {
				return runGit(path, ["rev-parse", "--show-toplevel"]);
			} catch {
				return undefined;
			}
		},
		realpath(path: string): string {
			try {
				return realpathSync(path);
			} catch {
				return resolve(path);
			}
		},
	};
}

export function discoverRepositories(options: {
	cwd: string;
	config: WorktreeManagerConfig;
	ops?: RepoDiscoveryOps;
}): { repos: RepoCandidate[]; warnings: string[] } {
	const ops = options.ops ?? defaultRepoDiscoveryOps();
	const warnings: string[] = [];
	const repos: RepoCandidate[] = [];
	const seen = new Set<string>();

	function add(path: string | undefined): void {
		if (!path) return;
		const root = ops.gitRoot(path);
		if (!root) return;
		const normalized = ops.realpath(root);
		if (seen.has(normalized)) return;
		seen.add(normalized);
		repos.push({ alias: basename(normalized), root: normalized });
	}

	add(options.cwd);
	for (const rawRoot of options.config.repoSearchRoots) {
		const searchRoot = expandHome(rawRoot);
		let children: string[];
		try {
			children = ops.listDirectories(searchRoot);
		} catch (error) {
			warnings.push(`Could not scan ${searchRoot}: ${errorText(error)}`);
			continue;
		}
		for (const child of children) add(child);
	}

	const rootsByAlias = new Map<string, string[]>();
	for (const repo of repos) {
		const roots = rootsByAlias.get(repo.alias) ?? [];
		roots.push(repo.root);
		rootsByAlias.set(repo.alias, roots);
	}
	const ambiguousAliases = new Set<string>();
	for (const [alias, roots] of rootsByAlias) {
		if (roots.length < 2) continue;
		ambiguousAliases.add(alias);
		warnings.push(`Ambiguous repo alias ${alias}: ${roots.join(", ")}`);
	}

	return { repos: repos.filter((repo) => !ambiguousAliases.has(repo.alias)), warnings };
}

export function worktreePickerEntries(repo: RepoCandidate, porcelain: string): WorktreePickerEntry[] {
	return parseWorktreeList(porcelain).map((entry) => {
		const label = `${repo.alias} / ${entry.name}`;
		const description = `${entry.branch ? `${entry.branch} — ` : ""}${entry.path}`;
		return {
			...entry,
			repo,
			label,
			description,
			searchText: `${repo.alias}\n${entry.name}\n${entry.branch ?? ""}\n${entry.path}`,
			managed: identifyPiManagedWorktreeForRepo(repo.root, entry.path, entry.branch),
		};
	});
}

export function ensureWorktreePlan(repoRoot: string, rawName?: string): WorktreePlan {
	const name = slugify(rawName?.trim() || "worktree");
	return {
		repoRoot,
		name,
		branch: `worktree-${name}`,
		path: join(repoRoot, ".pi", "worktrees", name),
	};
}

function remoteDefaultHeadRef(repoRoot: string): string {
	runGit(repoRoot, ["fetch", "origin"]);
	try {
		return runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	} catch {
		// Some clones do not have origin/HEAD configured locally. Ask git to set it
		// from the remote after fetching, then read the symbolic ref again.
		runGit(repoRoot, ["remote", "set-head", "origin", "--auto"]);
		return runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	}
}

export function resolveWorktreeBaseRef(repoRoot: string, options: EnsureWorktreeOptions = {}): string {
	const explicit = options.baseRef?.trim();
	if (explicit) return explicit;
	if (options.defaultBase === "remoteDefault") return remoteDefaultHeadRef(repoRoot);
	return runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function ensureWorktree(repoRoot: string, rawName?: string, options: EnsureWorktreeOptions = {}): EnsuredWorktree {
	const plan = ensureWorktreePlan(repoRoot, rawName);
	mkdirSync(dirname(plan.path), { recursive: true });

	let created = false;
	if (existsSync(plan.path)) {
		const existing = parseWorktreeList(runGit(repoRoot, ["worktree", "list", "--porcelain"]))
			.find((entry) => normalize(entry.path) === normalize(plan.path));
		if (!existing || existing.branch !== plan.branch) {
			throw new Error(`${plan.path} exists but is not the expected git worktree on ${plan.branch}`);
		}
	} else {
		const baseRef = resolveWorktreeBaseRef(repoRoot, options);
		runGit(repoRoot, ["worktree", "add", "-b", plan.branch, plan.path, baseRef]);
		created = true;
	}
	return { ...plan, created };
}
