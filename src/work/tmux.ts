import { execFileSync } from "node:child_process";
import type { TmuxRunner } from "./planner.ts";
import { shellQuote } from "./planner.ts";

export type TmuxPane = { paneId: string; windowId: string; windowName: string; sessionName: string; path: string; command: string };
export type JumpResult = { kind: "jumped" } | { kind: "print"; command: string };

export const PANE_FORMAT = ["#{pane_id}", "#{window_id}", "#{window_name}", "#{session_name}", "#{pane_current_path}", "#{pane_current_command}"].join("\t");
const SHELLS: readonly string[] = ["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu"];

// Quiet runner: tmux errors are captured instead of printed over the dashboard.
// With a socket name, it targets an isolated server and hides the caller's own tmux client.
export function tmuxRunner(socket?: string): TmuxRunner {
	const env = { ...process.env };
	if (socket) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const prefix = socket ? ["-L", socket] : [];
	return (args) => execFileSync("tmux", [...prefix, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
}

export function parsePanes(output: string): TmuxPane[] {
	return output.split("\n").filter((line) => line.trim()).map((line) => {
		const [paneId = "", windowId = "", windowName = "", sessionName = "", path = "", command = ""] = line.split("\t");
		return { paneId, windowId, windowName, sessionName, path, command };
	});
}

export function listPanes(tmux: TmuxRunner): TmuxPane[] | undefined {
	try {
		return parsePanes(tmux(["list-panes", "-a", "-F", PANE_FORMAT]));
	} catch {
		return undefined;
	}
}

export function isShell(command: string): boolean {
	return SHELLS.includes(command.replace(/^-/, ""));
}

export function windowNameOf(tmux: TmuxRunner, pane: string): string | null {
	try {
		return tmux(["display-message", "-p", "-t", pane, "#{window_name}"]).trim() || null;
	} catch {
		return null;
	}
}

export function jumpToPane(tmux: TmuxRunner, pane: string, insideTmux: boolean): JumpResult {
	const target = shellQuote(pane);
	if (!insideTmux) return { kind: "print", command: `tmux attach-session -t ${target} \\; select-window -t ${target} \\; select-pane -t ${target}` };
	try {
		tmux(["switch-client", "-t", pane]);
	} catch {
		// No attached client (for example an isolated test server); selecting still moves the session's focus.
	}
	tmux(["select-window", "-t", pane]);
	tmux(["select-pane", "-t", pane]);
	return { kind: "jumped" };
}

export function popupArgs(command: string): string[] {
	return ["display-popup", "-E", "-w", "90%", "-h", "90%", command];
}
