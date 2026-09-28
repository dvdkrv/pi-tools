export type Move = "down" | "up" | "top" | "bottom" | "half-down" | "half-up" | "next-section" | "prev-section";
export type KeyAction =
	| { type: "none" }
	| { type: "pending" }
	| { type: "move"; move: Move }
	| { type: "enter" }
	| { type: "close" }
	| { type: "action"; key: string }
	| { type: "confirming"; key: string }
	| { type: "confirmed"; key: string }
	| { type: "cancelled"; key: string }
	| { type: "filter"; text: string; editing: boolean }
	| { type: "match"; direction: 1 | -1 };
export type KeyState = { pendingG: boolean; confirming: string | null; filter: string; editing: boolean };
export type KeymapOptions = { actions: readonly string[]; confirm?: readonly string[]; filter?: boolean };
type Step = { state: KeyState; action: KeyAction };

export const INITIAL_KEY_STATE: KeyState = { pendingG: false, confirming: null, filter: "", editing: false };

const MOVES: Record<string, Move> = {
	j: "down",
	down: "down",
	k: "up",
	up: "up",
	G: "bottom",
	home: "top",
	end: "bottom",
	"ctrl+d": "half-down",
	"ctrl+u": "half-up",
	pagedown: "half-down",
	pageup: "half-up",
	tab: "next-section",
	"]": "next-section",
	"shift+tab": "prev-section",
	"[": "prev-section",
};

const SEQUENCES: Record<string, string> = {
	"\r": "enter",
	"\n": "enter",
	"\t": "tab",
	"\x1b": "escape",
	"\x7f": "backspace",
	"\b": "backspace",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1b[Z": "shift+tab",
	"\x1b[H": "home",
	"\x1b[F": "end",
	"\x1b[1~": "home",
	"\x1b[4~": "end",
	"\x1b[5~": "pageup",
	"\x1b[6~": "pagedown",
	"\x1b[3~": "delete",
};

export function normalizeKey(name: string): string {
	const shifted = /^shift\+([a-z])$/.exec(name);
	if (shifted) return shifted[1].toUpperCase();
	if (name === "space") return " ";
	if (name === "return") return "enter";
	return name;
}

// Decodes one legacy terminal key sequence into the key names pi-tui's parseKey uses.
export function decodeKey(data: string): string | undefined {
	const known = SEQUENCES[data];
	if (known) return known;
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
	}
	if ([...data].length === 1 && data >= " ") return data;
	return undefined;
}

// Splits a chunk of raw input into single key sequences (CSI and SS3 escapes, or one code point).
export function splitKeys(data: string): string[] {
	const keys: string[] = [];
	let i = 0;
	while (i < data.length) {
		if (data[i] === "\x1b" && data[i + 1] === "[") {
			let j = i + 2;
			while (j < data.length && !/[@-~]/.test(data[j])) j++;
			keys.push(data.slice(i, j + 1));
			i = j + 1;
			continue;
		}
		if (data[i] === "\x1b" && data[i + 1] === "O" && i + 2 < data.length) {
			keys.push(data.slice(i, i + 3));
			i += 3;
			continue;
		}
		const char = String.fromCodePoint(data.codePointAt(i) as number);
		keys.push(char);
		i += char.length;
	}
	return keys;
}

function isText(key: string): boolean {
	return [...key].length === 1 && key >= " ";
}

function editFilter(state: KeyState, key: string): Step {
	if (key === "escape") return { state: { ...state, editing: false, filter: "" }, action: { type: "filter", text: "", editing: false } };
	if (key === "enter") return { state: { ...state, editing: false }, action: { type: "filter", text: state.filter, editing: false } };
	if (key === "backspace" || isText(key)) {
		const filter = key === "backspace" ? [...state.filter].slice(0, -1).join("") : state.filter + key;
		return { state: { ...state, filter }, action: { type: "filter", text: filter, editing: true } };
	}
	return { state, action: { type: "none" } };
}

export function keyStep(state: KeyState, rawKey: string, options: KeymapOptions): Step {
	const key = normalizeKey(rawKey);
	if (state.confirming) {
		const confirming = state.confirming;
		const next = { ...state, confirming: null };
		return { state: next, action: key === "y" ? { type: "confirmed", key: confirming } : { type: "cancelled", key: confirming } };
	}
	if (state.editing) return editFilter(state, key);
	if (state.pendingG) {
		const next = { ...state, pendingG: false };
		if (key === "g") return { state: next, action: { type: "move", move: "top" } };
		return keyStep(next, key, options);
	}
	if (key === "g") return { state: { ...state, pendingG: true }, action: { type: "pending" } };
	const move = MOVES[key];
	if (move) return { state, action: { type: "move", move } };
	if (key === "enter") return { state, action: { type: "enter" } };
	if (options.filter && key === "/") return { state: { ...state, editing: true, filter: "" }, action: { type: "filter", text: "", editing: true } };
	if (options.filter && state.filter && (key === "n" || key === "N")) return { state, action: { type: "match", direction: key === "n" ? 1 : -1 } };
	if (key === "escape") {
		if (state.filter) return { state: { ...state, filter: "" }, action: { type: "filter", text: "", editing: false } };
		return { state, action: { type: "close" } };
	}
	if (options.actions.includes(key)) {
		if (options.confirm?.includes(key)) return { state: { ...state, confirming: key }, action: { type: "confirming", key } };
		return { state, action: { type: "action", key } };
	}
	if (key === "q") return { state, action: { type: "close" } };
	return { state, action: { type: "none" } };
}

export function moveIndex(index: number, count: number, move: Move, page: number): number {
	if (count <= 0) return 0;
	const half = Math.max(1, Math.floor(page / 2));
	const targets: Record<Move, number> = {
		down: index + 1,
		up: index - 1,
		top: 0,
		bottom: count - 1,
		"half-down": index + half,
		"half-up": index - half,
		"next-section": index,
		"prev-section": index,
	};
	return Math.max(0, Math.min(count - 1, targets[move]));
}
