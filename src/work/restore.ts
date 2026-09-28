import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { PidReaders, ProbedSession } from "./liveness.ts";
import { probeSessions } from "./liveness.ts";
import type { TmuxRunner } from "./planner.ts";
import { shellQuote } from "./planner.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import type { TmuxPane } from "./tmux.ts";
import { isShell, listPanes } from "./tmux.ts";
import type { Session } from "./types.ts";

export const RESTORE_WINDOW_MS = 7 * 86_400_000;
export const RESTORE_FALLBACK_MS = 10 * 60_000;
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export class RestoreError extends Error {}

export type RestoreStep =
	| { kind: "send"; sessionId: string; pane: string; command: string }
	| { kind: "split"; sessionId: string; window: string; cwd: string; command: string }
	| { kind: "window"; sessionId: string; name: string; cwd: string; command: string };
export type RestoreSkip = { sessionId: string; reason: string };
export type Placed = { sessionId: string; pane: string };
export type RestoreFailure = { sessionId: string; error: string };
export type RestoreMode = "auto" | "manual" | "dry-run";
export type RestoreDeps = {
	store: WorkStore;
	tmux: TmuxRunner;
	readers?: PidReaders;
	bootId?: () => string | undefined;
	fileExists?: (path: string) => boolean;
	pi?: string;
};
export type RestoreReport = {
	mode: RestoreMode;
	ran: boolean;
	reason?: string;
	steps: RestoreStep[];
	placed: Placed[];
	failed: RestoreFailure[];
	skipped: RestoreSkip[];
};

export function restoreCommand(file: string, pi = "pi"): string {
	return `${pi} --session ${shellQuote(file)}`;
}

export function windowNameFor(session: Session): string {
	return session.tmuxWindow || basename(session.cwd) || "pi";
}

export function selectForRestore(
	sessions: readonly ProbedSession[],
	now: Date,
	fileExists: (path: string) => boolean = existsSync,
): { selected: ProbedSession[]; skipped: RestoreSkip[] } {
	const selected: ProbedSession[] = [];
	const skipped: RestoreSkip[] = [];
	for (const session of sessions) {
		// Headless sessions (child agents, non-terminal modes) are never reopened: their parent decides.
		// Terminal sessions that ran outside tmux have no pane to return to, so only Enter in the dashboard reopens them.
		if (session.liveness !== "crashed" || session.alive || session.status === "done" || session.headless || !session.tmuxPane) continue;
		if (now.getTime() - Date.parse(session.lastTurnAt ?? session.startedAt) > RESTORE_WINDOW_MS) continue;
		if (!session.file || !fileExists(session.file)) {
			skipped.push({ sessionId: session.id, reason: "session file missing" });
			continue;
		}
		selected.push(session);
	}
	selected.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
	return { selected, skipped };
}

export function planRestore(sessions: readonly Session[], panes: readonly TmuxPane[], pi = "pi"): RestoreStep[] {
	const used = new Set<string>();
	const created = new Set<string>();
	const steps: RestoreStep[] = [];
	for (const session of sessions) {
		if (!session.file) continue;
		const command = restoreCommand(session.file, pi);
		const name = windowNameFor(session);
		const shell = panes.find((pane) => !used.has(pane.paneId) && pane.windowName === name && pane.path === session.cwd && isShell(pane.command));
		if (shell) {
			used.add(shell.paneId);
			steps.push({ kind: "send", sessionId: session.id, pane: shell.paneId, command });
			continue;
		}
		const window = panes.find((pane) => pane.windowName === name);
		if (window) {
			steps.push({ kind: "split", sessionId: session.id, window: window.windowId, cwd: session.cwd, command });
			continue;
		}
		if (created.has(name)) {
			steps.push({ kind: "split", sessionId: session.id, window: `new:${name}`, cwd: session.cwd, command });
			continue;
		}
		created.add(name);
		steps.push({ kind: "window", sessionId: session.id, name, cwd: session.cwd, command });
	}
	return steps;
}

export function executeRestore(steps: readonly RestoreStep[], tmux: TmuxRunner): { placed: Placed[]; failed: RestoreFailure[] } {
	const created = new Map<string, string>();
	const placed: Placed[] = [];
	const failed: RestoreFailure[] = [];
	for (const step of steps) {
		try {
			if (step.kind === "send") {
				tmux(["send-keys", "-t", step.pane, "-l", step.command]);
				tmux(["send-keys", "-t", step.pane, "Enter"]);
				placed.push({ sessionId: step.sessionId, pane: step.pane });
			} else if (step.kind === "split") {
				const target = step.window.startsWith("new:") ? created.get(step.window.slice(4)) : step.window;
				if (!target) throw new RestoreError(`window ${step.window.slice(4)} was not created`);
				const pane = tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", target, "-c", step.cwd, step.command]).trim();
				placed.push({ sessionId: step.sessionId, pane });
			} else {
				const [windowId = "", pane = ""] = tmux(["new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}", "-n", step.name, "-c", step.cwd, step.command]).trim().split("\t");
				created.set(step.name, windowId);
				placed.push({ sessionId: step.sessionId, pane });
			}
		} catch (error) {
			failed.push({ sessionId: step.sessionId, error: errorMessage(error).split("\n")[0] ?? "" });
		}
	}
	return { placed, failed };
}

export function readBootId(path: string = BOOT_ID_PATH): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function markRestore(store: WorkStore, bootId: string | undefined, now: Date): void {
	if (bootId) store.setMeta(`restore:boot:${bootId}`, now.toISOString());
	store.setMeta("restore:last", now.toISOString());
}

// Atomically claims this boot for automatic restore. Without a boot ID, allows one run per 10 minutes.
export function claimRestore(store: WorkStore, bootId: string | undefined, now: Date): boolean {
	return store.transaction(() => {
		if (bootId) {
			if (store.getMeta(`restore:boot:${bootId}`)) return false;
		} else {
			const last = store.getMeta("restore:last");
			if (last && now.getTime() - Date.parse(last) < RESTORE_FALLBACK_MS) return false;
		}
		markRestore(store, bootId, now);
		return true;
	});
}

export function runRestore(mode: RestoreMode, deps: RestoreDeps): RestoreReport {
	const { store } = deps;
	const now = store.clock();
	const panes = listPanes(deps.tmux);
	const { selected, skipped } = selectForRestore(probeSessions(store.listSessions(), panes, deps.readers), now, deps.fileExists);
	const steps = planRestore(selected, panes ?? [], deps.pi);
	const report: RestoreReport = { mode, ran: false, steps, placed: [], failed: [], skipped };
	if (mode === "dry-run") return report;
	if (!panes) return { ...report, reason: "tmux is not running" };
	const bootId = (deps.bootId ?? readBootId)();
	if (mode === "auto") {
		if (!claimRestore(store, bootId, now)) return { ...report, reason: "already restored since this boot" };
	} else {
		markRestore(store, bootId, now);
	}
	for (const session of selected) store.updateSession(session.id, { restoredFrom: session.pid });
	const result = executeRestore(steps, deps.tmux);
	return { ...report, ran: true, placed: result.placed, failed: result.failed };
}

export function reopenSession(
	store: WorkStore,
	session: ProbedSession,
	tmux: TmuxRunner,
	panes: readonly TmuxPane[],
	options: { fileExists?: (path: string) => boolean; pi?: string } = {},
): string {
	if (session.alive) throw new RestoreError(`Session is still running as pid ${session.pid}`);
	if (!session.file || !(options.fileExists ?? existsSync)(session.file)) throw new RestoreError("Session file is missing");
	const steps = planRestore([session], panes, options.pi);
	store.updateSession(session.id, { restoredFrom: session.pid });
	const result = executeRestore(steps, tmux);
	if (result.failed.length > 0) throw new RestoreError(result.failed[0].error);
	return result.placed[0].pane;
}

const sessionCount = (count: number): string => `${count} session${count === 1 ? "" : "s"}`;

export function describeStep(step: RestoreStep): string {
	switch (step.kind) {
		case "send":
			return `${step.sessionId}: type into shell pane ${step.pane}: ${step.command}`;
		case "split":
			return `${step.sessionId}: split window ${step.window.startsWith("new:") ? step.window.slice(4) : step.window}: ${step.command}`;
		case "window":
			return `${step.sessionId}: new window ${step.name} in ${step.cwd}: ${step.command}`;
	}
}

export function formatRestoreReport(report: RestoreReport): string {
	const lines: string[] = [];
	if (report.mode === "dry-run") {
		lines.push(report.steps.length ? `Would restore ${sessionCount(report.steps.length)}:` : "Nothing to restore");
		for (const step of report.steps) lines.push(`  ${describeStep(step)}`);
	} else if (!report.ran) {
		lines.push(`Restore skipped: ${report.reason ?? "unknown reason"}`);
	} else {
		lines.push(report.placed.length ? `Restored ${sessionCount(report.placed.length)}` : "Nothing to restore");
		for (const placed of report.placed) lines.push(`  ${placed.sessionId} in pane ${placed.pane}`);
	}
	for (const skip of report.skipped) lines.push(`Skipped ${skip.sessionId}: ${skip.reason}`);
	for (const failure of report.failed) lines.push(`Failed ${failure.sessionId}: ${failure.error}`);
	return lines.join("\n");
}
