import type { LinkDeps } from "./linking.ts";
import { autoLinkSession } from "./linking.ts";
import type { TmuxRunner } from "./planner.ts";
import type { GitRunner } from "./rules.ts";
import { errorMessage } from "./secrets.ts";
import type { WorkStore } from "./store.ts";
import { listPanes, windowNameOf } from "./tmux.ts";
import { lastAssistantLine } from "./transcript.ts";
import type { DeclaredStatus } from "./types.ts";

export const PARENT_SESSION_ENV = "PI_WORK_PARENT_SESSION";

export type SessionInfo = { id: string; file: string | null; cwd: string; name: string | null; mode: string };
export type TrackerDeps = {
	store: () => WorkStore;
	pid: number;
	env: NodeJS.ProcessEnv;
	tmux: TmuxRunner;
	git: GitRunner;
	warn: (message: string) => void;
	onResponded?: (seconds: number) => void;
};
export type SessionTracker = {
	readonly pane: string | null;
	start(info: SessionInfo): void;
	input(text: string, source: string): void;
	agentStart(): void;
	declare(status: DeclaredStatus, note: string): boolean;
	agentEnd(messages: readonly unknown[]): void;
	rename(name: string | null): void;
	shutdown(clean: boolean): void;
};
export type SignalName = "SIGHUP" | "SIGTERM";
export type SignalSource = {
	on(event: SignalName, listener: () => void): unknown;
	off(event: SignalName, listener: () => void): unknown;
	listenerCount(event: string): number;
};

export function createSessionTracker(deps: TrackerDeps): SessionTracker {
	let id: string | undefined;
	let pane: string | null = null;
	let disabled = false;
	let declared = false;
	const linkDeps: LinkDeps = { env: deps.env, git: deps.git };

	// Registry failures never break the Pi session: warn once, then stop recording for this session.
	const guard = (fn: (store: WorkStore, sessionId: string) => void): boolean => {
		if (disabled || !id) return false;
		try {
			fn(deps.store(), id);
			return true;
		} catch (error) {
			disabled = true;
			deps.warn(`Work session registry is off for this session: ${errorMessage(error)}`);
			return false;
		}
	};

	return {
		get pane() {
			return pane;
		},
		start(info) {
			const headless = info.mode !== "tui";
			// Terminal sessions are always top-level; only headless sessions can be children.
			const parentSession = headless ? deps.env[PARENT_SESSION_ENV]?.trim() || null : null;
			// print and json runs are one-shot scripts: record them only as child agents. rpc always registers.
			if (headless && info.mode !== "rpc" && !parentSession) return;
			id = info.id;
			pane = !headless && deps.env.TMUX && deps.env.TMUX_PANE ? deps.env.TMUX_PANE : null;
			guard((store, sessionId) => {
				store.startSession({
					id: sessionId,
					file: info.file,
					cwd: info.cwd,
					name: info.name,
					pid: deps.pid,
					tmuxPane: pane,
					tmuxWindow: pane ? windowNameOf(deps.tmux, pane) : null,
					parentSession,
					headless,
				});
				autoLinkSession(store, sessionId, linkDeps);
			});
		},
		input(text, source) {
			if (source === "extension" || text.trimStart().startsWith("/")) return;
			guard((store, sessionId) => {
				const session = store.getSession(sessionId);
				if (session?.status !== "needs-me") return;
				deps.onResponded?.(Math.max(0, Math.round((store.clock().getTime() - Date.parse(session.statusAt)) / 1000)));
			});
		},
		agentStart() {
			declared = false;
			guard((store, sessionId) => {
				store.setSessionStatus(sessionId, "working", "", "auto");
			});
		},
		declare(status, note) {
			const recorded = guard((store, sessionId) => {
				store.setSessionStatus(sessionId, status, note, "agent");
			});
			if (recorded) declared = true;
			return recorded;
		},
		agentEnd(messages) {
			guard((store, sessionId) => {
				if (!declared) store.setSessionStatus(sessionId, "needs-me", lastAssistantLine(messages), "auto");
				const window = pane ? windowNameOf(deps.tmux, pane) : null;
				store.updateSession(sessionId, window ? { lastTurnAt: store.now(), tmuxWindow: window } : { lastTurnAt: store.now() });
				autoLinkSession(store, sessionId, linkDeps);
			});
			declared = false;
		},
		rename(name) {
			guard((store, sessionId) => {
				store.updateSession(sessionId, { name });
			});
		},
		shutdown(clean) {
			if (!clean) return;
			guard((store, sessionId) => {
				store.updateSession(sessionId, { endedAt: store.now() });
			});
		},
	};
}

// Pi emits session_shutdown even for SIGHUP and SIGTERM. Closing a pane is a clean close, but a signal
// while the pane still exists, or with the tmux server gone (reboot, kill-server), is a crash to restore.
export function shutdownIsClean(input: { reason: string; signalled: boolean; pane: string | null; tmux: TmuxRunner }): boolean {
	if (input.reason !== "quit" || !input.signalled || !input.pane) return true;
	const panes = listPanes(input.tmux);
	if (!panes) return false;
	return !panes.some((pane) => pane.paneId === input.pane);
}

// Listens only for signals Pi already handles, so adding a listener never disables Node's default exit.
export function watchSignals(source: SignalSource, onSignal: () => void): () => void {
	const events = (["SIGHUP", "SIGTERM"] as const).filter((event) => source.listenerCount(event) > 0);
	for (const event of events) source.on(event, onSignal);
	return () => {
		for (const event of events) source.off(event, onSignal);
	};
}
