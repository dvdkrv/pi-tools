// Display helpers shared by the dashboard and desktop notifications.
import { basename } from "node:path";

// Window names tmux gives a window from its command: they say nothing about the session.
export const DEFAULT_WINDOW_NAMES: ReadonlySet<string> = new Set(["pi", "zsh", "bash"]);

// The tmux window name, unless it is a default name; then the repository, then the cwd basename.
export function sessionDisplayName(window: string | null, repo: string | null, cwd: string): string {
	const name = window?.trim();
	if (name && !DEFAULT_WINDOW_NAMES.has(name)) return name;
	return repo?.trim() || basename(cwd) || cwd;
}

// Plain text from a one-line Markdown note: emphasis, code, links, headings, quotes, and list markers go.
export function stripMarkdown(value: string): string {
	return value
		.replace(/```[^\n]*\n?/g, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
		.replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
		.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "");
}
