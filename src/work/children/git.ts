import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRunner } from "../rules.ts";
import { errorMessage } from "../secrets.ts";
import { isIgnored } from "./guards.ts";

export type DiffStats = { lines: number; files: number };
export type NumstatEntry = { added: number; deleted: number; path: string };

const EXCLUDE_LINE = "/.pi/worktrees/";

// Like the tracker's git runner, but keeps git's own error text, which callers report to the lead.
export const runGit: GitRunner = (cwd, args) => {
	try {
		return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
			maxBuffer: 64 * 1024 * 1024,
		}).trim();
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		throw new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim() : errorMessage(error));
	}
};

export function gitText(git: GitRunner, cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args) || undefined;
	} catch {
		return undefined;
	}
}

export function parseNumstat(output: string): NumstatEntry[] {
	return output
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [added = "0", deleted = "0", ...path] = line.split("\t");
			return { added: Number(added) || 0, deleted: Number(deleted) || 0, path: path.join("\t") };
		});
}

function fileLines(path: string): number {
	try {
		const data = readFileSync(path);
		if (data.length === 0 || data.includes(0)) return 0;
		const text = data.toString("utf8");
		return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	} catch {
		return 0;
	}
}

// Lines added plus deleted, and files touched, from `from` to `to`, or to the working tree plus untracked files.
export function measureDiff(git: GitRunner, cwd: string, options: { from: string; to?: string; ignore: readonly string[] }): DiffStats {
	const range = options.to ? [options.from, options.to] : [options.from];
	const entries = parseNumstat(git(cwd, ["diff", "--numstat", "--no-renames", ...range]));
	if (!options.to) {
		for (const path of git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
			entries.push({ added: fileLines(join(cwd, path)), deleted: 0, path });
		}
	}
	const counted = entries.filter((entry) => !isIgnored(entry.path, options.ignore));
	return {
		lines: counted.reduce((sum, entry) => sum + entry.added + entry.deleted, 0),
		files: new Set(counted.map((entry) => entry.path)).size,
	};
}

export function isClean(git: GitRunner, cwd: string): boolean {
	return git(cwd, ["status", "--porcelain"]) === "";
}

export function commitsSince(git: GitRunner, cwd: string, base: string, ref = "HEAD"): number {
	return Number(git(cwd, ["rev-list", "--count", `${base}..${ref}`])) || 0;
}

// The remote default branch (for example origin/main), or a local main or master when origin/HEAD is unset.
export function defaultBranchRef(git: GitRunner, cwd: string): string | undefined {
	const remote = gitText(git, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remote) return remote;
	return ["main", "master"].find((name) => gitText(git, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]));
}

export function isDefaultBranch(branch: string, defaultRef: string | undefined): boolean {
	return branch === "main" || branch === "master" || (defaultRef !== undefined && defaultRef.replace(/^origin\//, "") === branch);
}

// Child worktrees live inside the repository, so they are excluded locally to keep the lead's tree clean.
export function excludeChildWorktrees(git: GitRunner, root: string): void {
	const file = join(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "info", "exclude");
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (current.split("\n").includes(EXCLUDE_LINE)) return;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
}

export function addWorktree(git: GitRunner, root: string, path: string, branch: string, start: string): void {
	git(root, ["worktree", "add", "-q", "-b", branch, path, start]);
}

export function removeWorktree(git: GitRunner, root: string, path: string | null, branch: string | null): void {
	if (path) {
		try {
			git(root, ["worktree", "remove", "--force", path]);
		} catch {
			// Already gone.
		}
	}
	if (branch) {
		try {
			git(root, ["branch", "-D", branch]);
		} catch {
			// Already gone.
		}
	}
}

export function parseGithubRepo(url: string): string | undefined {
	return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}
