import { fuzzyFilter } from "../../worktree/fuzzy-filter.ts";
import type { Style } from "./text.ts";
import { fit, oneLine, sanitize, truncate, visibleWidth } from "./text.ts";

// A modal owns all keys until it calls its resolve function. Keys are keymap names (decodeKey output).
export type Modal = { handle(key: string): void; lines(width: number, height: number, style: Style): string[] };

const isText = (key: string): boolean => [...key].length === 1 && key >= " ";
const dropLast = (value: string): string => [...value].slice(0, -1).join("");

function row(label: string, selected: boolean, width: number, style: Style): string {
	return selected ? style.inverse(fit(`> ${oneLine(label)}`, width)) : truncate(`  ${oneLine(label)}`, width);
}

export function textPrompt(title: string, placeholder: string, resolve: (value: string | undefined) => void): Modal {
	let value = "";
	return {
		handle(key) {
			if (key === "enter") resolve(value);
			else if (key === "escape") resolve(undefined);
			else if (key === "backspace") value = dropLast(value);
			else if (isText(key)) value += key;
		},
		lines(width, _height, style) {
			const input = value ? truncate(`> ${sanitize(value)}`, width) : `> ${style.dim(truncate(oneLine(placeholder), Math.max(0, width - 2)))}`;
			return [style.bold(truncate(oneLine(title), width)), input, style.dim(truncate("enter accept · esc cancel", width))];
		},
	};
}

export function selectList(title: string, options: readonly string[], resolve: (value: string | undefined) => void): Modal {
	let index = 0;
	return {
		handle(key) {
			if (key === "enter") resolve(options[index]);
			else if (key === "escape" || key === "q") resolve(undefined);
			else if (key === "j" || key === "down") index = Math.min(options.length - 1, index + 1);
			else if (key === "k" || key === "up") index = Math.max(0, index - 1);
		},
		lines(width, height, style) {
			const visible = Math.max(1, height - 1);
			const start = Math.max(0, index - visible + 1);
			const rows = options.slice(start, start + visible).map((option, i) => row(option, start + i === index, width, style));
			return [style.bold(truncate(oneLine(title), width)), ...rows];
		},
	};
}

export function confirmBox(title: string, message: string, resolve: (value: boolean) => void): Modal {
	return {
		handle(key) {
			if (key === "y") resolve(true);
			else if (key === "n" || key === "escape" || key === "q") resolve(false);
		},
		lines(width, height, style) {
			const body = message.split("\n").slice(0, Math.max(0, height - 2)).map((line) => truncate(sanitize(line), width));
			return [style.bold(truncate(oneLine(title), width)), ...body, style.dim(truncate("y confirm · n cancel", width))];
		},
	};
}

function wrapLine(value: string, width: number): string[] {
	if (width <= 0) return [""];
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const char of value) {
		const charWidth = visibleWidth(char);
		if (line && used + charWidth > width) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += char;
		used += charWidth;
	}
	lines.push(line);
	return lines;
}

export function messageBox(title: string, text: string, resolve: () => void, options: { atEnd?: boolean; wrap?: boolean } = {}): Modal {
	const source = text.split("\n");
	let offset = options.atEnd ? Number.MAX_SAFE_INTEGER : 0;
	return {
		handle(key) {
			if (key === "j" || key === "down") offset += 1;
			else if (key === "k" || key === "up") offset = Math.max(0, offset - 1);
			else resolve();
		},
		lines(width, height, style) {
			const all = options.wrap ? source.flatMap((line) => wrapLine(sanitize(line), width)) : source;
			const visible = Math.max(1, height - 2);
			offset = Math.max(0, Math.min(offset, all.length - visible));
			const body = all.slice(offset, offset + visible).map((line) => truncate(sanitize(line), width));
			return [style.bold(truncate(oneLine(title), width)), ...body, style.dim(truncate("j/k scroll · any other key closes", width))];
		},
	};
}

export function fuzzyPicker<T>(title: string, items: readonly T[], label: (item: T) => string, resolve: (value: T | undefined) => void): Modal {
	let query = "";
	let index = 0;
	const matches = (): T[] => fuzzyFilter([...items], query, { getSearchText: label, limit: items.length });
	return {
		handle(key) {
			if (key === "enter") {
				resolve(matches()[index]);
				return;
			}
			if (key === "escape") {
				resolve(undefined);
				return;
			}
			if (key === "down" || key === "ctrl+n") index += 1;
			else if (key === "up" || key === "ctrl+p") index = Math.max(0, index - 1);
			else if (key === "backspace") {
				query = dropLast(query);
				index = 0;
			} else if (isText(key)) {
				query += key;
				index = 0;
			}
			index = Math.min(index, Math.max(0, matches().length - 1));
		},
		lines(width, height, style) {
			const visible = Math.max(1, height - 3);
			const list = matches();
			const start = Math.max(0, index - visible + 1);
			const rows = list.slice(start, start + visible).map((item, i) => row(label(item), start + i === index, width, style));
			return [
				style.bold(truncate(oneLine(title), width)),
				truncate(`/ ${sanitize(query)}`, width),
				...(rows.length ? rows : [style.dim("  no matches")]),
				style.dim(truncate("type to filter · ↑/↓ move · enter select · esc cancel", width)),
			];
		},
	};
}
