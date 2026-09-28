export type Color = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";
export type Style = {
	bold(value: string): string;
	dim(value: string): string;
	inverse(value: string): string;
	color(name: Color, value: string): string;
};

export const plainStyle: Style = { bold: (v) => v, dim: (v) => v, inverse: (v) => v, color: (_name, v) => v };

const CODES: Record<Color, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 };

export const ansiStyle: Style = {
	bold: (v) => `\x1b[1m${v}\x1b[22m`,
	dim: (v) => `\x1b[2m${v}\x1b[22m`,
	inverse: (v) => `\x1b[7m${v}\x1b[27m`,
	color: (name, v) => `\x1b[${CODES[name]}m${v}\x1b[39m`,
};

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}]/u;
const COMBINING = /\p{Mn}/u;

export function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code < 32 || (code >= 0x7f && code < 0xa0) || COMBINING.test(char)) return 0;
	return WIDE.test(char) ? 2 : 1;
}

export function visibleWidth(value: string): number {
	let width = 0;
	for (const char of stripAnsi(value)) width += charWidth(char);
	return width;
}

// Plain text only: styles are applied after truncation.
export function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	let out = "";
	let used = 0;
	for (const char of value) {
		const w = charWidth(char);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

export function fit(value: string, width: number): string {
	const cut = truncate(value, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

// External text (notes, titles, transcripts, command output) must never reach the terminal raw.
export function sanitize(value: string): string {
	return value.replace(CONTROL, " ");
}

export function oneLine(value: string): string {
	return sanitize(value).replace(/\s+/g, " ").trim();
}

export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
