import { dirname, isAbsolute, join } from "node:path";
import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { ShellRunner } from "../jobs.ts";
import { runShell } from "../jobs.ts";
import { WORK_ITEM_ENV } from "../linking.ts";
import type { PidReaders } from "../liveness.ts";
import { systemPidReaders } from "../liveness.ts";
import type { GitRunner } from "../rules.ts";
import { repoFromCwd } from "../rules.ts";
import { errorMessage } from "../secrets.ts";
import { PARENT_SESSION_ENV } from "../session-tracker.ts";
import type { ChildRunEnd, WorkStore } from "../store.ts";
import type { AcceptanceResult, ChildRun, ChildWorktree } from "../types.ts";
import type { BriefParams } from "./brief.ts";
import { leadShortId, renderChildPrompt, renderFirstPrompt, resolveBrief } from "./brief.ts";
import { CHILD_RUN_ENV, PARENT_PID_ENV } from "./child-guard.ts";
import { formatChildRun, lastLine, renderResult } from "./format.ts";
import { addWorktree, commitsSince, defaultBranchRef, excludeChildWorktrees, gitText, isClean, isDefaultBranch, measureDiff, removeWorktree, runGit } from "./git.ts";
import { BUILT_IN_IGNORE } from "./guards.ts";
import { messageCost, priceFor } from "./pricing.ts";
import type { RpcChild, RpcEvent } from "./rpc.ts";
import { spawnRpcChild } from "./rpc.ts";

export const KILL_GRACE_MS = 10_000;
export const ABORT_TIMEOUT_MS = 5_000;

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
	steer(leadSession: string, id: string, text: string, urgent: boolean): Promise<string>;
	stop(leadSession: string, id: string, discard: boolean): Promise<string>;
	recover(leadSession: string): ChildRun[];
	shutdownAll(): Promise<void>;
};

type Handle = {
	child: RpcChild;
	started: boolean;
	stopping: boolean;
	finished: boolean;
	successfulAssistant: boolean;
	lastAssistantError: string | null;
	lastAssistantErrored: boolean;
};
type Ending = { kind: "settled" } | { kind: "exited"; detail: string } | { kind: "start-failed"; detail: string };

function trackAssistant(handle: Handle, event: RpcEvent): void {
	const message = event.message;
	if (!message || typeof message !== "object" || Array.isArray(message) || (message as Record<string, unknown>).role !== "assistant") return;
	const assistant = message as Record<string, unknown>;
	// Only a provider error counts: an aborted message (a stop or the spend cap) keeps its own outcome.
	const errored = assistant.stopReason === "error";
	const detail = typeof assistant.errorMessage === "string" && assistant.errorMessage.trim() ? assistant.errorMessage : null;
	handle.lastAssistantErrored = errored;
	if (errored) handle.lastAssistantError = detail ?? "unknown error";
	else handle.successfulAssistant = true;
}

// An assistant message whose spend cannot be known: no reported cost, tokens used, and no price for the model.
function unpricedUsage(event: RpcEvent, config: ChildrenConfig, model: string): boolean {
	const message = event.message as { role?: unknown; usage?: unknown } | undefined;
	return message?.role === "assistant" && messageCost(message.usage, priceFor(config.pricing, model)) === "unknown";
}

// Child worktrees live at <root>/.pi/worktrees/child-<id>, so the repository root is three levels up.
function rootOf(run: ChildRun): string | undefined {
	return run.worktree ? dirname(dirname(dirname(run.worktree))) : undefined;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
	const git = deps.git ?? runGit;
	const grace = deps.killGraceMs ?? KILL_GRACE_MS;
	const handles = new Map<string, Handle>();
	// Runs the lead stopped itself; a stop from the dashboard is still reported, since the lead did not see it.
	const stoppedByLead = new Set<string>();
	// The lead already acted on such a run (it can, while acceptance runs), so its result would only cost a turn.
	const alreadyHandled = (run: ChildRun): boolean =>
		run.outcome === "merged" || run.outcome === "discarded" || (run.outcome === "stopped" && stoppedByLead.has(run.id));
	const actorOf = (run: ChildRun): `session:${string}` => `session:${run.leadSession}`;

	function delegate(leadSession: string, cwd: string, params: BriefParams): DelegateResult {
		const config = deps.config();
		const store = deps.store();
		let previous = params.from ? find(leadSession, params.from) : undefined;
		let requestedRoot: string | null = null;
		if (params.repo !== undefined) {
			const requested = params.repo.trim();
			if (!isAbsolute(requested)) return { ok: false, message: "Refused: repo must be an absolute path." };
			requestedRoot = gitText(git, requested, ["rev-parse", "--show-toplevel"]) ?? null;
			if (!requestedRoot) return { ok: false, message: "Refused: repo must be inside a git repository." };
		}
		const previousRoot = previous?.brief.repo ?? null;
		if (previous && params.repo !== undefined && requestedRoot !== previousRoot) return { ok: false, message: "Refused: from must use the same repository as the earlier run." };
		const briefRoot = params.repo === undefined ? previousRoot : requestedRoot;
		const runCwd = briefRoot ?? cwd;
		const repo = repoFromCwd(runCwd, git) ?? null;
		const resolved = resolveBrief({ ...params, repo: briefRoot ?? undefined }, config, repo);
		if ("error" in resolved) return { ok: false, message: `Refused: ${resolved.error.replace(/\.?$/, ".")}` };
		let prepare: ((id: string) => ChildWorktree) | undefined;
		let root: string | undefined;
		if (resolved.brief.kind === "implement") {
			root = briefRoot ?? gitText(git, cwd, ["rev-parse", "--show-toplevel"]);
			if (!root) return { ok: false, message: "Refused: implement runs need a git repository." };
			let leadBranch: string;
			if (briefRoot) {
				leadBranch = `lead/${leadShortId(leadSession)}`;
			} else {
				const current = gitText(git, cwd, ["branch", "--show-current"]);
				if (!current) return { ok: false, message: "Refused: check out a branch first (HEAD is detached)." };
				if (isDefaultBranch(current, defaultBranchRef(git, cwd))) return { ok: false, message: `Refused: ${current} is the default branch. Create a feature branch for this work first.` };
				leadBranch = current;
			}
			excludeChildWorktrees(git, root);
			if (!isClean(git, root)) {
				const tree = briefRoot ? `${briefRoot} has` : "your working tree has";
				return { ok: false, message: `Refused: ${tree} uncommitted changes. Commit them first, so the child starts from the current HEAD.` };
			}
			let start = git(root, ["rev-parse", "HEAD"]);
			let baseCommit = start;
			if (resolved.brief.from) {
				previous = find(leadSession, resolved.brief.from);
				if (!previous?.branch || !previous.baseCommit) return { ok: false, message: `Refused: ${resolved.brief.from} is not one of your implement runs.` };
				if (["running", "merged", "discarded"].includes(previous.outcome)) return { ok: false, message: `Refused: ${previous.id} is ${previous.outcome}.` };
				commitLeftovers(previous);
				start = previous.branch;
				baseCommit = previous.baseCommit;
			}
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
		// The new branch holds the earlier run's commits, so the earlier worktree and branch can go.
		if (previous && root) {
			removeWorktree(git, root, previous.worktree, previous.branch);
			store.markChildRunDiscarded(previous.id, actorOf(previous));
		}
		launch(run, runCwd, config);
		const where = run.branch ? `on ${run.branch}` : resolved.brief.repo ? `(read-only, in ${resolved.brief.repo})` : "(read-only, in your working directory)";
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
		const handle: Handle = { child, started: false, stopping: false, finished: false, successfulAssistant: false, lastAssistantError: null, lastAssistantErrored: false };
		let unpricedNotified = false;
		handles.set(run.id, handle);
		store.updateChildRun(run.id, { pid: child.pid ?? null });
		child.onEvent((event) => {
			if (event.type === "message_end") trackAssistant(handle, event);
			if (event.type === "agent_settled") void finish(run.id, { kind: "settled" });
			if (event.type === "message_end" && !unpricedNotified && unpricedUsage(event, config, run.model)) {
				unpricedNotified = true;
				deps.notify(`Child ${run.id}: no price for ${run.model} in children.pricing, so its spend is unknown and the $${config.spendCapUsd.toFixed(2)} cap cannot be enforced. Add the model to children.pricing to enforce it.`);
			}
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
					end = await settledEnd(run, handle);
				} else {
					const failedStart = ending.kind === "start-failed" || !handle.started;
					const stderr = lastLine(handle.child.stderrTail());
					end = { outcome: "failed", summary: `${failedStart ? "failed to start" : "exited"}: ${ending.detail}${stderr ? `; ${stderr}` : ""}`, ...diffOf(run) };
					const root = rootOf(run);
					if (failedStart && root) removeWorktree(git, root, run.worktree, run.branch);
				}
				run = store.endChildRun(id, end, actorOf(run));
			}
			if (!handle.stopping && !alreadyHandled(run)) deps.notify(renderResult(run, deps.config()));
		} catch (error) {
			if (!handle.stopping) deps.notify(`Child ${id} ended, but recording its result failed: ${errorMessage(error)}`);
		} finally {
			void handle.child.shutdown(grace);
		}
	}

	async function settledEnd(run: ChildRun, handle: Handle): Promise<ChildRunEnd> {
		const session = run.childSession ? deps.store().getSession(run.childSession) : undefined;
		const declared = session?.statusSource === "agent" ? session.status : undefined;
		const summary = session?.note ?? "";
		const diff = diffOf(run);
		// A guard stop explains any error that follows it (the spend guard aborts the request).
		if (run.flags.includes("over-spend")) return { outcome: "over-spend", summary, ...diff };
		if (run.flags.includes("over-budget")) return { outcome: "over-budget", summary, ...diff };
		if (handle.lastAssistantError && (!handle.successfulAssistant || handle.lastAssistantErrored)) {
			return { outcome: "failed", summary: `model error: ${lastLine(handle.lastAssistantError)}`, ...diff };
		}
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

	function find(leadSession: string, id: string): ChildRun | undefined {
		try {
			const run = deps.store().getChildRun(id);
			return run?.leadSession === leadSession ? run : undefined;
		} catch {
			return undefined;
		}
	}

	function commitLeftovers(run: ChildRun): void {
		if (!run.worktree) return;
		try {
			if (git(run.worktree, ["status", "--porcelain"]) === "") return;
			git(run.worktree, ["add", "-A"]);
			git(run.worktree, ["commit", "--no-verify", "-q", "-m", `WIP: uncommitted work from ${run.id}`]);
		} catch {
			// The worktree may be gone already; its branch still holds the committed work.
		}
	}

	async function steer(leadSession: string, id: string, text: string, urgent: boolean): Promise<string> {
		const run = find(leadSession, id);
		if (!run) return `${id} is not one of your child runs.`;
		const handle = handles.get(id);
		if (!handle || handle.stopping) {
			const state = run.outcome === "running" ? "finishing" : run.outcome;
			return `${id} is ${state} and can no longer be steered. Delegate again${run.kind === "implement" ? ` with from: ${id}` : ""} to continue.`;
		}
		try {
			await handle.child.request({ type: urgent ? "steer" : "follow_up", message: text });
		} catch (error) {
			return `Could not reach ${id}: ${errorMessage(error)}`;
		}
		return urgent ? `Steered ${id}: it reads your message after its current tool calls.` : `Queued for ${id}: it reads your message at its next quiet moment.`;
	}

	async function stop(leadSession: string, id: string, discardToo: boolean): Promise<string> {
		const run = find(leadSession, id);
		if (!run) return `${id} is not one of your child runs.`;
		const handle = handles.get(id);
		const wasRunning = handle !== undefined || run.outcome === "running";
		if (wasRunning) stoppedByLead.add(id);
		if (handle) {
			handle.stopping = true;
			try {
				await handle.child.request({ type: "abort" }, ABORT_TIMEOUT_MS);
			} catch {
				// The shutdown below ends it anyway.
			}
			await finish(id, { kind: "settled" });
			await handle.child.shutdown(grace);
		} else if (run.outcome === "running") {
			killOrphan(run);
			deps.store().endChildRun(id, { outcome: "stopped", summary: "stopped by the lead" }, actorOf(run));
		}
		if (discardToo) return discard(id);
		if (!wasRunning) return `${id} already ended as ${run.outcome}. Pass discard: true to remove its worktree and branch.`;
		return `Stopped ${id}. Its worktree and branch are kept${run.branch ? ` (${run.branch})` : ""}.`;
	}

	function discard(id: string): string {
		const store = deps.store();
		const run = store.getChildRun(id) as ChildRun;
		if (run.outcome === "merged" || run.outcome === "discarded") return `${id} is already ${run.outcome}.`;
		const root = rootOf(run);
		if (root) removeWorktree(git, root, run.worktree, run.branch);
		store.markChildRunDiscarded(id, actorOf(run));
		return `Discarded ${id}${root ? ": removed its worktree and branch" : ""}.`;
	}

	// Only a PID whose environment names this run is signalled, so a reused PID is never hit.
	function killOrphan(run: ChildRun): void {
		const environ = run.pid ? (deps.readers ?? systemPidReaders).environ(run.pid) : undefined;
		if (!run.pid || !environ?.split("\0").includes(`${CHILD_RUN_ENV}=${run.id}`)) return;
		try {
			process.kill(run.pid, "SIGTERM");
		} catch {
			// It exited meanwhile.
		}
	}

	function recover(leadSession: string): ChildRun[] {
		const store = deps.store();
		return store
			.listChildRuns({ leadSession, outcome: "running" })
			.filter((run) => !handles.has(run.id))
			.map((run) => {
				killOrphan(run);
				return store.endChildRun(run.id, { outcome: "interrupted", summary: "the lead session ended while this child was running" }, actorOf(run));
			});
	}

	// A clean lead shutdown ends the processes but records nothing, so the next lead start reports the runs.
	async function shutdownAll(): Promise<void> {
		const all = [...handles.values()];
		handles.clear();
		for (const handle of all) handle.finished = true;
		await Promise.all(all.map((handle) => handle.child.shutdown(grace)));
	}

	return { delegate, list, steer, stop, recover, shutdownAll };
}
