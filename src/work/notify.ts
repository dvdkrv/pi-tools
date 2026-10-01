import { sessionDisplayName, stripMarkdown } from "./display.ts";
import type { TmuxRunner } from "./planner.ts";
import type { Session } from "./types.ts";

export type NotificationSession = Pick<Session, "cwd" | "tmuxPane" | "tmuxWindow" | "status" | "note">;
export type NotifyNeedsMeOptions = {
	session: NotificationSession;
	repo: string | null | undefined;
	env: NodeJS.ProcessEnv;
	tmux: TmuxRunner;
	write: (value: string) => void;
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function oneLine(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(CONTROL, "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, length: number): string {
	const characters = [...value];
	return characters.length <= length ? value : `${characters.slice(0, length - 1).join("")}…`;
}

function activeClientPane(tmux: TmuxRunner, pane: string): boolean {
	try {
		return tmux(["list-clients", "-F", "#{pane_id}"]).split("\n").some((entry) => entry.trim() === pane);
	} catch {
		return false;
	}
}

// Best effort by contract: a terminal or tmux failure must never affect the session.
export function notifyNeedsMe(options: NotifyNeedsMeOptions): void {
	try {
		if (options.session.status !== "needs-me") return;
		const pane = options.env.TMUX_PANE?.trim();
		if (options.env.TMUX && pane && activeClientPane(options.tmux, pane)) return;
		const name = sessionDisplayName(options.session.tmuxWindow, options.repo ?? null, options.session.cwd);
		const title = `π ${oneLine(name).replace(/;/g, "")}`;
		const body = truncate(oneLine(stripMarkdown(options.session.note)), 120);
		const sequence = `\x1b]777;notify;${title};${body}\x07`;
		options.write(options.env.TMUX ? `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : sequence);
	} catch {
		// Notifications are optional and must not break the session.
	}
}
