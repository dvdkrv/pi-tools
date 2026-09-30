import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { GitRunner } from "../rules.ts";
import type { ChildFlag, ChildRun } from "../types.ts";
import type { DiffStats } from "./git.ts";
import { measureDiff } from "./git.ts";
import { BUILT_IN_IGNORE, expensiveVerdict, inScope, overBudgetAllowed, restrictedVerdict } from "./guards.ts";
import { messageCost, priceFor } from "./pricing.ts";

export const CHILD_RUN_ENV = "PI_WORK_CHILD_RUN";
export const PARENT_PID_ENV = "PI_WORK_PARENT_PID";

export type GuardBlock = { block: true; reason: string };
export type GuardRecord = { flags?: ChildFlag[]; spendUsd?: number; diffLines?: number; diffFiles?: number };
export type ChildGuardDeps = {
	run: ChildRun;
	config: ChildrenConfig;
	cwd: string;
	git: GitRunner;
	record: (patch: GuardRecord) => void;
	abort: () => void;
};
export type ChildGuard = {
	readonly flags: readonly ChildFlag[];
	toolCall(toolName: string, input: Record<string, unknown>): GuardBlock | undefined;
	toolResult(toolName: string): string | undefined;
	assistantCost(usage: unknown): void;
	agentEnd(): void;
};

const EDIT_TOOLS: readonly string[] = ["edit", "write"];
const OVER_BUDGET = "Blocked: the diff budget is exceeded. Commit what you have with git add and git commit, then end with session_status.";
const OVER_SPEND = "Blocked: the spending cap is reached, and this run is stopping.";
const NO_GIT = "Blocked: git is unavailable here, so the diff budget cannot be measured and edits are off. End with session_status.";
const READ_ONLY = "Blocked: this is a read-only run. Report what you found in your final message instead.";

function gitStatus(git: GitRunner, cwd: string): string | undefined {
	try {
		return git(cwd, ["status", "--porcelain"]);
	} catch {
		return undefined;
	}
}

// Used before the run is loaded, or when it cannot be: reading stays possible, changing things does not.
export function failClosedGuard(reason: string): ChildGuard {
	return {
		flags: [],
		toolCall: (toolName) => (toolName === "bash" || EDIT_TOOLS.includes(toolName) ? { block: true, reason } : undefined),
		toolResult: () => undefined,
		assistantCost: () => {},
		agentEnd: () => {},
	};
}

export function createChildGuard(deps: ChildGuardDeps): ChildGuard {
	const { run, config, cwd, git } = deps;
	const implement = run.kind === "implement";
	const repo = repoChildrenConfig(config, run.repo);
	const ignore = [...BUILT_IN_IGNORE, ...repo.ignore];
	const timeoutSeconds = Math.max(1, Math.round(config.commandTimeoutMinutes * 60));
	const flags = new Set<ChildFlag>(run.flags);
	let spend = run.spendUsd ?? 0;
	let spendWarned = false;
	let pending: string | undefined;
	let wipCommitted = false;
	const leadStatus = implement ? undefined : gitStatus(git, cwd);

	const flag = (name: ChildFlag): void => {
		if (flags.has(name)) return;
		flags.add(name);
		deps.record({ flags: [...flags] });
	};

	const measure = (): DiffStats | undefined => {
		if (!run.baseCommit) return undefined;
		try {
			const stats = measureDiff(git, cwd, { from: run.baseCommit, ignore });
			deps.record({ diffLines: stats.lines, diffFiles: stats.files });
			return stats;
		} catch {
			flag("no-git");
			return undefined;
		}
	};
	if (implement) measure();

	const editBlock = (input: Record<string, unknown>): string | undefined => {
		if (!implement) return READ_ONLY;
		if (flags.has("no-git")) return NO_GIT;
		if (flags.has("over-budget")) return OVER_BUDGET;
		const target = resolve(cwd, String(input.path ?? "").replace(/^@/, ""));
		const rel = relative(cwd, target);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep)[0] === ".git") return `Blocked: ${target} is outside your worktree.`;
		const path = rel.split(sep).join("/");
		if (!inScope(path, run.brief.scope)) return `Blocked: ${path} is outside your scope (${run.brief.scope.join(", ")}). Needing it is a question for the lead.`;
		return undefined;
	};

	const budgetNote = (): string | undefined => {
		if (flags.has("no-git")) return undefined;
		const stats = measure();
		if (!stats) {
			if (!flags.has("no-git")) return undefined;
			deps.abort();
			return "Stopped: git failed, so the diff budget cannot be measured. Edits are blocked, and this run ends as failed.";
		}
		const lines = run.budgetLines ?? Number.POSITIVE_INFINITY;
		const files = run.budgetFiles ?? Number.POSITIVE_INFINITY;
		// Reaching a limit exactly is fine; only going past it blocks.
		if (stats.lines > lines || stats.files > files) {
			flag("over-budget");
			return `Budget exceeded (${stats.lines}/${lines} lines, ${stats.files}/${files} files). Edits are blocked. Commit what you have with git add and git commit, then end with session_status.`;
		}
		const warnAt = config.warnPercent / 100;
		if (stats.lines >= lines * warnAt) return `Budget ${stats.lines}/${lines} lines: finish the smallest working change.`;
		if (stats.files >= files * warnAt) return `Budget ${stats.files}/${files} files: finish the smallest working change.`;
		return undefined;
	};

	return {
		get flags() {
			return [...flags];
		},
		toolCall(toolName, input) {
			const changing = toolName === "bash" || EDIT_TOOLS.includes(toolName);
			if (changing && flags.has("over-spend")) return { block: true, reason: OVER_SPEND };
			if (EDIT_TOOLS.includes(toolName)) {
				const reason = editBlock(input);
				return reason ? { block: true, reason } : undefined;
			}
			if (toolName !== "bash") return undefined;
			const command = String(input.command ?? "");
			const overBudget = flags.has("over-budget") && !overBudgetAllowed(command, run.brief.acceptance)
				? `${OVER_BUDGET} Allowed now: git status, diff, log, add, commit, and your acceptance commands.`
				: undefined;
			const reason = restrictedVerdict(command) ?? expensiveVerdict(command, repo.expensiveCommands) ?? overBudget;
			if (reason) return { block: true, reason };
			const requested = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : timeoutSeconds;
			input.timeout = Math.min(requested, timeoutSeconds);
			return undefined;
		},
		toolResult(toolName) {
			const notes: string[] = [];
			if (pending) {
				notes.push(pending);
				pending = undefined;
			}
			if (implement && (toolName === "bash" || EDIT_TOOLS.includes(toolName))) {
				const note = budgetNote();
				if (note) notes.push(note);
			}
			if (!implement && toolName === "bash" && leadStatus !== undefined && !flags.has("modified-files") && gitStatus(git, cwd) !== leadStatus) {
				flag("modified-files");
				notes.push("Warning: that command changed files in the lead's working directory. They were left in place, and the lead will be told. This run is read-only.");
			}
			return notes.length > 0 ? notes.join("\n") : undefined;
		},
		assistantCost(usage) {
			if (flags.has("unpriced")) return;
			const cost = messageCost(usage, priceFor(config.pricing, run.model));
			if (cost === "unknown") {
				flag("unpriced");
				pending = undefined;
				return;
			}
			if (!(cost > 0)) return;
			spend += cost;
			deps.record({ spendUsd: spend });
			const cap = config.spendCapUsd;
			if (spend >= cap) {
				if (flags.has("over-spend")) return;
				flag("over-spend");
				deps.abort();
			} else if (!spendWarned && spend >= (cap * config.warnPercent) / 100) {
				spendWarned = true;
				pending = `Spend $${spend.toFixed(2)} of $${cap.toFixed(2)}: finish the smallest working change.`;
			}
		},
		// After a spend-cap abort, the work so far is committed so the lead can continue from it.
		agentEnd() {
			if (!implement || wipCommitted || !flags.has("over-spend")) return;
			wipCommitted = true;
			try {
				if (git(cwd, ["status", "--porcelain"]) === "") return;
				git(cwd, ["add", "-A"]);
				git(cwd, ["commit", "--no-verify", "-q", "-m", `WIP: ${run.id} stopped at the spend cap`]);
			} catch {
				// The lead still finds the uncommitted work in the worktree.
			}
		},
	};
}
