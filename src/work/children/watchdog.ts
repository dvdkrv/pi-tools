import { readFileSync } from "node:fs";

export const WATCHDOG_INTERVAL_MS = 5000;

export type WatchdogReaders = { ppid: () => number; alive: (pid: number) => boolean; startTime: (pid: number) => string | undefined };

export const systemWatchdogReaders: WatchdogReaders = {
	ppid: () => process.ppid,
	alive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	// Field 22 of /proc/<pid>/stat; the fields after the command name start at field 3.
	startTime: (pid) => {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		} catch {
			return undefined;
		}
	},
};

// Ends a child whose lead is gone: the lead died, or its PID now belongs to another process. Without an
// explicit parent PID it watches the current parent, and a changed parent (the child was reparented) also counts.
export function startWatchdog(onGone: () => void, options: { parentPid?: number; intervalMs?: number; readers?: WatchdogReaders } = {}): () => void {
	const readers = options.readers ?? systemWatchdogReaders;
	const parent = options.parentPid ?? readers.ppid();
	const started = readers.startTime(parent);
	let fired = false;
	const timer = setInterval(() => {
		if (fired) return;
		const reparented = options.parentPid === undefined && readers.ppid() !== parent;
		const reused = started !== undefined && readers.startTime(parent) !== started;
		if (!reparented && readers.alive(parent) && !reused) return;
		fired = true;
		clearInterval(timer);
		onGone();
	}, options.intervalMs ?? WATCHDOG_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
