import { readFileSync } from "node:fs";
import type { TmuxPane } from "./tmux.ts";
import type { Liveness, Session } from "./types.ts";

export type PidReaders = { kill: (pid: number) => void; environ: (pid: number) => string | undefined };
export type ProbedSession = Session & { liveness: Liveness; alive: boolean };

export const systemPidReaders: PidReaders = {
	kill: (pid) => {
		process.kill(pid, 0);
	},
	environ: (pid) => {
		try {
			return readFileSync(`/proc/${pid}/environ`, "latin1");
		} catch {
			return undefined;
		}
	},
};

// A PID counts as the session's process only if it exists and, when the pane is known and /proc is
// readable, its environment names that pane. This guards against PID reuse after a reboot.
export function pidAlive(pid: number | null, pane: string | null, readers: PidReaders = systemPidReaders): boolean {
	if (!pid || pid <= 0) return false;
	try {
		readers.kill(pid);
	} catch {
		return false;
	}
	if (!pane) return true;
	const environ = readers.environ(pid);
	if (environ === undefined) return true;
	return environ.split("\0").includes(`TMUX_PANE=${pane}`);
}

export function livenessOf(session: Session, alive: boolean, panes: readonly TmuxPane[] | undefined): Liveness {
	const paneOk = !session.tmuxPane || panes === undefined || panes.some((pane) => pane.paneId === session.tmuxPane);
	if (alive && paneOk) return "live";
	return session.endedAt ? "closed" : "crashed";
}

export function probeSessions(sessions: readonly Session[], panes: readonly TmuxPane[] | undefined, readers: PidReaders = systemPidReaders): ProbedSession[] {
	return sessions.map((session) => {
		const alive = pidAlive(session.pid, session.tmuxPane, readers);
		return { ...session, alive, liveness: livenessOf(session, alive, panes) };
	});
}
