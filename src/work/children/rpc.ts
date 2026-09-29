import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export type RpcEvent = { type: string } & Record<string, unknown>;
export type RpcExit = { code: number | null; signal: NodeJS.Signals | null };
export type RpcChild = {
	readonly pid: number | undefined;
	readonly exited: boolean;
	request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
	onEvent(listener: (event: RpcEvent) => void): void;
	onExit(listener: (exit: RpcExit) => void): void;
	stderrTail(): string;
	shutdown(graceMs: number): Promise<RpcExit>;
};

export const STDERR_TAIL = 2000;
export const REQUEST_TIMEOUT_MS = 30_000;

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

// A minimal client for Pi's documented RPC protocol: one JSON record per LF-terminated line, responses matched
// by id, and every other stdout record an event. Stderr is kept (the last STDERR_TAIL characters), never printed.
export function spawnRpcChild(command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): RpcChild {
	if (command.length === 0) throw new Error("empty child command");
	const proc: ChildProcess = spawn(command[0] as string, command.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	const eventListeners: ((event: RpcEvent) => void)[] = [];
	const exitListeners: ((exit: RpcExit) => void)[] = [];
	const pending = new Map<string, Pending>();
	let nextId = 0;
	let buffer = "";
	let stderr = "";
	let exit: RpcExit | undefined;
	let stopping: Promise<RpcExit> | undefined;

	const keepStderr = (text: string): void => {
		stderr = (stderr + text).slice(-STDERR_TAIL);
	};
	const handleLine = (line: string): void => {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (record.type === "response") {
			const request = typeof record.id === "string" ? pending.get(record.id) : undefined;
			if (!request) return;
			pending.delete(record.id as string);
			clearTimeout(request.timer);
			if (record.success === false) request.reject(new Error(String(record.error ?? `${String(record.command)} failed`)));
			else request.resolve(record.data);
			return;
		}
		if (typeof record.type === "string") for (const listener of eventListeners) listener(record as RpcEvent);
	};
	const finish = (result: RpcExit): void => {
		if (exit) return;
		exit = result;
		const error = new Error(`child exited (${result.signal ?? `code ${result.code}`})`);
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
		for (const listener of exitListeners) listener(result);
	};

	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (line.trim()) handleLine(line);
		}
	});
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", keepStderr);
	// Writes after the child is gone fail with EPIPE; the close event reports the exit.
	proc.stdin?.on("error", () => {});
	proc.on("error", (error) => {
		keepStderr(`${error.message}\n`);
		finish({ code: null, signal: null });
	});
	proc.on("close", (code, signal) => finish({ code, signal }));

	const signal = (name: NodeJS.Signals): void => {
		try {
			proc.kill(name);
		} catch {
			// Already gone.
		}
	};

	return {
		get pid() {
			return proc.pid;
		},
		get exited() {
			return exit !== undefined;
		},
		request(commandRecord, timeoutMs = REQUEST_TIMEOUT_MS) {
			if (exit || !proc.stdin?.writable) return Promise.reject(new Error("child is not running"));
			const id = `w${++nextId}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`${String(commandRecord.type)} timed out after ${timeoutMs} ms`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				proc.stdin?.write(`${JSON.stringify({ ...commandRecord, id })}\n`);
			});
		},
		onEvent(listener) {
			eventListeners.push(listener);
		},
		onExit(listener) {
			if (exit) listener(exit);
			else exitListeners.push(listener);
		},
		stderrTail() {
			return stderr;
		},
		// Close stdin, send SIGTERM, and send SIGKILL if the child is still running after graceMs.
		shutdown(graceMs) {
			if (exit) return Promise.resolve(exit);
			stopping ??= new Promise((resolve) => {
				const timer = setTimeout(() => signal("SIGKILL"), graceMs);
				exitListeners.push((result) => {
					clearTimeout(timer);
					resolve(result);
				});
				proc.stdin?.end();
				signal("SIGTERM");
			});
			return stopping;
		},
	};
}
