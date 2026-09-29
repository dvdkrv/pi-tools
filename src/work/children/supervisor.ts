import { dirname, join } from "node:path";
import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { ShellRunner } from "../jobs.ts";
import { runShell } from "../jobs.ts";
import { WORK_ITEM_ENV } from "../linking.ts";
import type { PidReaders } from "../liveness.ts";
import type { GitRunner } from "../rules.ts";
import { repoFromCwd } from "../rules.ts";
import { errorMessage } from "../secrets.ts";
import { PARENT_SESSION_ENV } from "../session-tracker.ts";
import type { ChildRunEnd, WorkStore } from "../store.ts";
import type { AcceptanceResult, ChildRun, ChildWorktree } from "../types.ts";
import type { BriefParams } from "./brief.ts";
import { renderChildPrompt, renderFirstPrompt, resolveBrief } from "./brief.ts";
import { CHILD_RUN_ENV, PARENT_PID_ENV } from "./child-guard.ts";
import { formatChildRun, lastLine, renderResult } from "./format.ts";
import { addWorktree, commitsSince, defaultBranchRef, excludeChildWorktrees, gitText, isClean, isDefaultBranch, measureDiff, removeWorktree, runGit } from "./git.ts";
import { BUILT_IN_IGNORE } from "./guards.ts";
import type { RpcChild } from "./rpc.ts";
import { spawnRpcChild } from "./rpc.ts";

export const KILL_GRACE_MS = 10_000;

export type SupervisorDeps = {
	store: () => WorkStore;
	config: () => ChildrenConfig;
	notify: (text: string) => void;
	command?: readonly string[];
	env?: NodeJS.ProcessEnv;
	git?: GitRunner;
	shell?: ShellRunner;
	pid?: number;
	killGraceMs?: number;
	readers?: PidReaders;
};
export type DelegateResult = { ok: true; run: ChildRun; message: string } | { ok: false; message: string };
export type Supervisor = {
	delegate(leadSession: string, cwd: string, params: BriefParams): DelegateResult;
	list(leadSession: string): string;
};

type Handle = { child: RpcChild; started: boolean; stopping: boolean; finished: boolean };
type Ending = { kind: "settled" } | { kind: "exited"; detail: string } | { kind: "start-failed"; detail: string };

// Child worktrees live at <root>/.pi/worktrees/child-<id>, so the repository root is three levels up.
function rootOf(run: ChildRun): string | undefined {
	return run.worktree ? dirname(dirname(dirname(run.worktree))) : undefined;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
	const git = deps.git ?? runGit;
	const grace = deps.killGraceMs ?? KILL_GRACE_MS;
	const handles = new Map<string, Handle>();
	const actorOf = (run: ChildRun): `session:${string}` => `session:${run.leadSession}`;

	function delegate(leadSession: string, cwd: string, params: BriefParams): DelegateResult {
		const config = deps.config();
		const store = deps.store();
		const repo = repoFromCwd(cwd, git) ?? null;
		const resolved = resolveBrief(params, config, repo);
		if ("error" in resolved) return { ok: false, message: `Refused: ${resolved.error.replace(/\.?$/, ".")}` };
		let prepare: ((id: string) => ChildWorktree) | undefined;
		let root: string | undefined;
		if (resolved.brief.kind === "implement") {
			root = gitText(git, cwd, ["rev-parse", "--show-toplevel"]);
			if (!root) return { ok: false, message: "Refused: implement runs need a git repository." };
			const leadBranch = gitText(git, cwd, ["branch", "--show-current"]);
			if (!leadBranch) return { ok: false, message: "Refused: check out a branch first (HEAD is detached)." };
			if (isDefaultBranch(leadBranch, defaultBranchRef(git, cwd))) {
				return { ok: false, message: `Refused: ${leadBranch} is the default branch. Create a feature branch for this work first.` };
			}
			excludeChildWorktrees(git, root);
			if (!isClean(git, cwd)) {
				return { ok: false, message: "Refused: your working tree has uncommitted changes. Commit them first, so the child starts from your current HEAD." };
			}
			const start = git(cwd, ["rev-parse", "HEAD"]);
			const baseCommit = start;
			const repoRoot = root;
			prepare = (id) => {
				const worktree = join(repoRoot, ".pi", "worktrees", `child-${id}`);
				const branch = `child/${leadBranch}/${id}`;
				addWorktree(git, repoRoot, worktree, branch, start);
				return { worktree, branch, baseCommit };
			};
		}
		let run: ChildRun;
		try {
			const input = { leadSession, brief: resolved.brief, model: resolved.model, repo, budgetLines: resolved.budgetLines, budgetFiles: resolved.budgetFiles };
			run = store.createChildRun(input, `session:${leadSession}`, prepare);
		} catch (error) {
			return { ok: false, message: `Refused: could not create the child run: ${errorMessage(error)}` };
		}
		launch(run, cwd, config);
		const where = run.branch ? `on ${run.branch}` : "(read-only, in your working directory)";
		return { ok: true, run, message: [`Started ${run.id} ${where} with ${run.model}.`, ...resolved.notes, "Its result arrives as a message when it finishes; keep working meanwhile."].join(" ") };
	}

	function launch(run: ChildRun, leadCwd: string, config: ChildrenConfig): void {
		const store = deps.store();
		const env: NodeJS.ProcessEnv = {
			...(deps.env ?? process.env),
			[PARENT_SESSION_ENV]: run.leadSession,
			[CHILD_RUN_ENV]: run.id,
			[PARENT_PID_ENV]: String(deps.pid ?? process.pid),
		};
		const link = store.sessionLink(run.leadSession);
		if (link) env[WORK_ITEM_ENV] = link.itemId;
		else delete env[WORK_ITEM_ENV];
		const args = ["--mode", "rpc", "--model", run.model, "--name", `child ${run.id}: ${run.brief.goal}`, "--append-system-prompt", renderChildPrompt(run, config)];
		if (run.kind === "read-only") args.push("--exclude-tools", "edit,write");
		const child = spawnRpcChild([...(deps.command ?? ["pi"]), ...args], { cwd: run.worktree ?? leadCwd, env });
		const handle: Handle = { child, started: false, stopping: false, finished: false };
		handles.set(run.id, handle);
		store.updateChildRun(run.id, { pid: child.pid ?? null });
		child.onEvent((event) => {
			if (event.type === "agent_settled") void finish(run.id, { kind: "settled" });
		});
		child.onExit((exit) => {
			void finish(run.id, { kind: "exited", detail: exit.signal ?? `code ${exit.code}` });
		});
		void (async () => {
			try {
				const state = (await child.request({ type: "get_state" })) as { sessionId?: unknown } | undefined;
				if (typeof state?.sessionId === "string") store.updateChildRun(run.id, { childSession: state.sessionId });
				await child.request({ type: "prompt", message: renderFirstPrompt(run.brief) });
				handle.started = true;
			} catch (error) {
				await finish(run.id, { kind: "start-failed", detail: errorMessage(error) });
			}
		})();
	}

	// Records the outcome once, ends the child process, and sends the lead its one message.
	async function finish(id: string, ending: Ending): Promise<void> {
		const handle = handles.get(id);
		if (!handle || handle.finished) return;
		handle.finished = true;
		handles.delete(id);
		try {
			const store = deps.store();
			let run = store.getChildRun(id) as ChildRun;
			if (run.outcome === "running") {
				let end: ChildRunEnd;
				if (handle.stopping) {
					end = { outcome: "stopped", summary: "stopped by the lead", ...diffOf(run) };
				} else if (ending.kind === "settled") {
					end = await settledEnd(run);
				} else {
					const failedStart = ending.kind === "start-failed" || !handle.started;
					const stderr = lastLine(handle.child.stderrTail());
					end = { outcome: "failed", summary: `${failedStart ? "failed to start" : "exited"}: ${ending.detail}${stderr ? `; ${stderr}` : ""}`, ...diffOf(run) };
					const root = rootOf(run);
					if (failedStart && root) removeWorktree(git, root, run.worktree, run.branch);
				}
				run = store.endChildRun(id, end, actorOf(run));
			}
			if (!handle.stopping) deps.notify(renderResult(run, deps.config()));
		} catch (error) {
			if (!handle.stopping) deps.notify(`Child ${id} ended, but recording its result failed: ${errorMessage(error)}`);
		} finally {
			void handle.child.shutdown(grace);
		}
	}

	async function settledEnd(run: ChildRun): Promise<ChildRunEnd> {
		const session = run.childSession ? deps.store().getSession(run.childSession) : undefined;
		const declared = session?.statusSource === "agent" ? session.status : undefined;
		const summary = session?.note ?? "";
		const diff = diffOf(run);
		if (run.flags.includes("over-spend")) return { outcome: "over-spend", summary, ...diff };
		if (run.flags.includes("over-budget")) return { outcome: "over-budget", summary, ...diff };
		if (run.flags.includes("no-git")) return { outcome: "failed", summary: summary || "git was unavailable, so the diff budget could not be measured", ...diff };
		if (run.kind === "read-only") return { outcome: declared === "done" ? "done" : "incomplete", summary };
		let committed = false;
		try {
			committed = run.worktree !== null && run.baseCommit !== null && commitsSince(git, run.worktree, run.baseCommit) > 0;
		} catch {
			committed = false;
		}
		if (declared !== "done" || !committed) return { outcome: "incomplete", summary, ...diff };
		return { outcome: "done", summary, acceptance: await runAcceptance(run), ...diff };
	}

	// The lead runs the acceptance commands itself, in the child's worktree, rather than trusting the child.
	async function runAcceptance(run: ChildRun): Promise<AcceptanceResult[]> {
		const minutes = deps.config().commandTimeoutMinutes;
		const results: AcceptanceResult[] = [];
		for (const command of run.brief.acceptance) {
			const result = await (deps.shell ?? runShell)(command, run.worktree as string, { timeoutMs: minutes * 60_000 });
			const failedToRun = result.timedOut || result.error !== undefined;
			const summary = result.timedOut ? `timed out after ${minutes} minutes` : lastLine(result.error ?? result.output);
			results.push({ command, exitCode: failedToRun ? null : result.code, summary });
		}
		return results;
	}

	function diffOf(run: ChildRun): { diffLines?: number; diffFiles?: number } {
		if (!run.worktree || !run.baseCommit) return {};
		try {
			const ignore = [...BUILT_IN_IGNORE, ...repoChildrenConfig(deps.config(), run.repo).ignore];
			const stats = measureDiff(git, run.worktree, { from: run.baseCommit, ignore });
			return { diffLines: stats.lines, diffFiles: stats.files };
		} catch {
			return {};
		}
	}

	function list(leadSession: string): string {
		const store = deps.store();
		const runs = store.listChildRuns({ leadSession });
		if (runs.length === 0) return "No child runs yet. Use delegate to start one.";
		return runs
			.map((run) => {
				const session = run.childSession ? store.getSession(run.childSession) : undefined;
				return formatChildRun(run, run.summary || (session?.statusSource === "agent" ? session.note : ""));
			})
			.join("\n");
	}

	return { delegate, list };
}
