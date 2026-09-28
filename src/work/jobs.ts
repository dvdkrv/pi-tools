import { spawn } from "node:child_process";
import { formatAge } from "./dash/text.ts";
import { pidAlive } from "./liveness.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, Job, JobHealth, JobKind } from "./types.ts";
import { NOTE_MAX } from "./types.ts";

export const CHECK_TIMEOUT_MS = 15_000;
export const OUTPUT_CAP = 64 * 1024;
export const CHECK_STALE_MS = 60_000;
export const CHECK_CONCURRENCY = 4;

export type ShellResult = { code: number | null; output: string; timedOut: boolean; error?: string };
export type ShellRunner = (command: string, cwd: string, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ShellResult>;
export type CheckResult = { status: JobHealth; output: string };
export type JobDeps = {
	run?: ShellRunner;
	pidAlive?: (pid: number) => boolean;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	concurrency?: number;
	signal?: AbortSignal;
};

// Runs /bin/sh -c in its own process group with no stdin. A timeout or abort kills the whole group.
export const runShell: ShellRunner = (command, cwd, options = {}) =>
	new Promise((resolve) => {
		let output = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		const finish = (result: ShellResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const killGroup = (): void => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group already exited.
			}
		};
		const onAbort = (): void => {
			killGroup();
			finish({ code: null, output, timedOut: false, error: "cancelled" });
		};
		try {
			child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		} catch (error) {
			resolve({ code: null, output: "", timedOut: false, error: errorMessage(error) });
			return;
		}
		const append = (chunk: Buffer): void => {
			if (output.length < OUTPUT_CAP) output += chunk.toString("utf8").slice(0, OUTPUT_CAP - output.length);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => finish({ code: null, output, timedOut: false, error: error.message }));
		child.on("close", (code) => finish({ code, output, timedOut: false }));
		timer = setTimeout(() => {
			killGroup();
			finish({ code: null, output, timedOut: true });
		}, options.timeoutMs ?? CHECK_TIMEOUT_MS);
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort);
	});

export function summarize(output: string): string {
	const line = output.split(/\r?\n/).map((part) => part.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()).find(Boolean) ?? "";
	return line.slice(0, NOTE_MAX);
}

export async function checkJob(job: Job, deps: JobDeps = {}): Promise<CheckResult> {
	if (!job.checkCommand) {
		if (job.kind === "process" && job.pid) {
			const alive = (deps.pidAlive ?? ((pid: number) => pidAlive(pid, null)))(job.pid);
			return alive ? { status: "healthy", output: `pid ${job.pid} is running` } : { status: "unhealthy", output: `pid ${job.pid} is not running` };
		}
		return { status: "unknown", output: "no check command" };
	}
	const result = await (deps.run ?? runShell)(job.checkCommand, job.cwd, { signal: deps.signal });
	if (result.error) return { status: "unknown", output: summarize(result.error) };
	if (result.timedOut) return { status: "unknown", output: `check timed out after ${CHECK_TIMEOUT_MS / 1000}s` };
	return { status: result.code === 0 ? "healthy" : "unhealthy", output: summarize(result.output) || `exit ${result.code}` };
}

export async function checkJobs(store: WorkStore, jobs: readonly Job[], deps: JobDeps = {}): Promise<Job[]> {
	const results: (Job | undefined)[] = new Array(jobs.length).fill(undefined);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < jobs.length) {
			const index = next++;
			const result = await checkJob(jobs[index], deps);
			if (deps.signal?.aborted) return;
			results[index] = store.recordJobCheck(jobs[index].id, result.status, result.output);
		}
	};
	await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? CHECK_CONCURRENCY, jobs.length) }, worker));
	return results.filter((job): job is Job => job !== undefined);
}

export function isStale(job: Job, now: Date, staleMs: number = CHECK_STALE_MS): boolean {
	return !job.lastCheckAt || now.getTime() - Date.parse(job.lastCheckAt) >= staleMs;
}

export function checkStaleJobs(store: WorkStore, deps: JobDeps = {}): Promise<Job[]> {
	const now = store.clock();
	return checkJobs(store, store.listJobs({ activeOnly: true }).filter((job) => isStale(job, now)), deps);
}

export async function stopJob(store: WorkStore, job: Job, actor: Actor, deps: JobDeps = {}): Promise<{ job: Job; note: string }> {
	if (job.stoppedAt) throw new Error(`${job.id} is already stopped`);
	let note = "";
	if (job.stopCommand) {
		const result = await (deps.run ?? runShell)(job.stopCommand, job.cwd);
		if (result.error || result.timedOut || result.code !== 0) {
			const reason = summarize(result.error ?? result.output) || (result.timedOut ? "timed out" : `exit ${result.code}`);
			throw new Error(`Stop command failed: ${reason}`);
		}
	} else if (job.kind === "process" && job.pid) {
		const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => {
			process.kill(pid, signal);
		});
		try {
			kill(job.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			note = "; it had already exited";
		}
	} else {
		note = "; no stop command, so only the record changed";
	}
	return { job: store.markJobStopped(job.id, actor), note };
}

export type JobRegisterParams = {
	name: string;
	kind: JobKind;
	cwd: string;
	schedule?: string;
	pid?: number;
	check_command?: string;
	stop_command?: string;
	log_path?: string;
	relates_to?: string;
};

export function registerAgentJob(store: WorkStore, params: JobRegisterParams, sessionId: string): { job: Job; created: boolean; message: string } {
	let itemId = store.sessionLink(sessionId)?.itemId ?? null;
	let note = "";
	if (params.relates_to) {
		let found: string | undefined;
		try {
			found = store.getItem(params.relates_to)?.id;
		} catch {
			found = undefined;
		}
		if (found) itemId = found;
		else note = ` (ignored unknown item ${params.relates_to})`;
	}
	const { job, created } = store.registerJob({
		name: params.name,
		kind: params.kind,
		cwd: params.cwd,
		schedule: params.schedule,
		pid: params.pid,
		checkCommand: params.check_command,
		stopCommand: params.stop_command,
		logPath: params.log_path,
		ownerSession: sessionId,
		itemId,
	}, `agent:${sessionId}`);
	return { job, created, message: `${created ? "Registered" : "Updated"} ${job.id} ${job.name}.${note} The user sees its health on the work dashboard.` };
}

export function formatJob(job: Pick<Job, "id" | "name" | "kind" | "schedule" | "stoppedAt" | "lastCheckAt" | "lastCheckStatus" | "lastCheckOutput">, now: Date): string {
	const health = job.stoppedAt ? "stopped" : (job.lastCheckStatus ?? "unchecked");
	const when = job.lastCheckAt ? `checked ${formatAge(now.getTime() - Date.parse(job.lastCheckAt))} ago` : "never checked";
	return `${job.id.padEnd(5)} ${health.padEnd(9)} ${job.name}  ${job.kind}${job.schedule ? ` ${job.schedule}` : ""}  ${when}${job.lastCheckOutput ? `: ${job.lastCheckOutput}` : ""}`;
}

export function jobDetails(store: WorkStore, job: Job, now: Date): string {
	const owner = job.ownerSession ? store.getSession(job.ownerSession) : undefined;
	const item = job.itemId ? store.getItem(job.itemId) : undefined;
	const status = job.stoppedAt ? `stopped at ${job.stoppedAt}` : (job.lastCheckStatus ?? "unknown");
	const checked = job.lastCheckAt ? `, checked ${formatAge(now.getTime() - Date.parse(job.lastCheckAt))} ago` : ", never checked";
	const stop = job.stopCommand ?? (job.kind === "process" && job.pid ? `SIGTERM to pid ${job.pid}` : "-");
	const owned = job.ownerSession ? `session ${job.ownerSession}${owner?.tmuxWindow ? ` (window ${owner.tmuxWindow})` : ""}` : "user";
	return [
		`${job.name} (${job.kind}${job.schedule ? `, ${job.schedule}` : ""})`,
		`status: ${status}${checked}`,
		`last output: ${job.lastCheckOutput ?? "-"}`,
		`cwd: ${job.cwd}`,
		`check: ${job.checkCommand ?? "-"}`,
		`stop: ${stop}`,
		`pid: ${job.pid ?? "-"}`,
		`log: ${job.logPath ?? "-"}`,
		`registered by: ${owned}`,
		`item: ${item ? `${item.id} ${item.title}` : "-"}`,
		`created: ${job.createdAt}`,
		`updated: ${job.updatedAt}`,
	].join("\n");
}
