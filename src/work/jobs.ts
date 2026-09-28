import { spawn } from "node:child_process";
import { pidAlive } from "./liveness.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, Job, JobHealth } from "./types.ts";
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
