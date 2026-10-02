import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Input, parseKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { KeyState } from "./keymap.ts";
import { INITIAL_KEY_STATE, keyStep, moveIndex } from "./keymap.ts";
import { NOTE_MAX } from "./types.ts";

export const ASK_USER_DESCRIPTION =
	"Ask the user one question with 2 to 6 discrete options and wait for the answer, which comes back as this tool's result. Use it for decisions with discrete options; mark the option you recommend with `recommended`. For open-ended discussion, write normal text and end with session_status needs-me instead.";
export const ASK_USER_DISMISSED = "The user dismissed the question; ask in plain text or proceed without it.";
export const ASK_USER_NO_UI = "ask_user cannot show a dialog in this session. Ask the question in plain text instead and end with session_status needs-me.";

const OTHER_LABEL = "Type something else…";

export const AskUserParams = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 300 }),
	options: Type.Array(
		Type.Object({
			label: Type.String({ minLength: 1, maxLength: 60 }),
			description: Type.Optional(Type.String({ maxLength: 120 })),
		}),
		{ minItems: 2, maxItems: 6 },
	),
	recommended: Type.Optional(Type.Integer({ minimum: 0, description: "0-based index into options of the option you recommend" })),
	allow_other: Type.Optional(Type.Boolean({ default: true, description: `Offer a "${OTHER_LABEL}" row for a free-text answer` })),
	context: Type.Optional(Type.String({ maxLength: 600, description: "Short context shown above the question" })),
});

export type AskUserInput = Static<typeof AskUserParams>;
export type AskUserAnswer = { kind: "option"; index: number; label: string } | { kind: "other"; text: string } | { kind: "dismissed" };


export function askUserProblem(input: AskUserInput): string | undefined {
	const { recommended, options } = input;
	if (recommended === undefined) return undefined;
	if (recommended < 0 || recommended >= options.length) return `recommended must be a 0-based index into options (0 to ${options.length - 1}), got ${recommended}`;
	return undefined;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
// Counts and cuts by code point, so an emoji is never split.
const cut = (text: string, length: number): string => [...text].slice(0, length).join("");

export function askUserNote(input: AskUserInput): string {
	const question = oneLine(input.question);
	const labels = ` [${input.options.map((option) => oneLine(option.label)).join(" / ")}]`;
	const full = question + labels;
	const size = (text: string) => [...text].length;
	if (size(full) <= NOTE_MAX) return full;
	if (size(labels) + 2 > NOTE_MAX) return `${cut(full, NOTE_MAX - 1)}…`;
	return `${cut(question, NOTE_MAX - size(labels) - 1)}…${labels}`;
}

export function answerText(answer: AskUserAnswer): string {
	if (answer.kind === "option") return `The user chose "${answer.label}" (option index ${answer.index}).`;
	if (answer.kind === "other") return `The user answered in their own words: ${answer.text}`;
	return ASK_USER_DISMISSED;
}

export function askUserComponent(
	input: AskUserInput,
	tui: { requestRender(): void },
	theme: Pick<Theme, "fg" | "bold">,
	done: (answer: AskUserAnswer) => void,
): { render(width: number): string[]; invalidate(): void; handleInput(data: string): void } {
	const allowOther = input.allow_other !== false;
	const rows = allowOther ? input.options.length + 1 : input.options.length;
	const recommended = askUserProblem(input) === undefined ? input.recommended : undefined;
	let selected = recommended ?? 0;
	let editing = false;
	let keys: KeyState = INITIAL_KEY_STATE;
	const answer = new Input({ placeholder: "your answer" });
	// It receives keys only while editing; focus places the terminal cursor in the field.
	answer.focused = true;

	const refresh = () => {
		tui.requestRender();
	};
	const leaveEditing = () => {
		editing = false;
		answer.setValue("");
		refresh();
	};
	answer.onSubmit = (value: string) => {
		const text = value.trim();
		if (text) done({ kind: "other", text });
		else leaveEditing();
	};

	return {
		invalidate() {
			answer.invalidate();
		},
		render(width: number): string[] {
			const w = Math.max(1, width);
			const border = new DynamicBorder((s: string) => theme.fg("accent", s)).render(w)[0] ?? "";
			const lines = [border];
			const wrap = (text: string, indent = "") => {
				for (const line of wrapTextWithAnsi(text, Math.max(1, w - indent.length))) lines.push(indent + line);
			};
			if (input.context) {
				wrap(theme.fg("muted", input.context));
				lines.push("");
			}
			wrap(theme.bold(input.question));
			lines.push("");
			for (let i = 0; i < rows; i++) {
				const option = input.options[i];
				const label = option ? option.label + (i === recommended ? " (recommended)" : "") : OTHER_LABEL;
				const text = `${i + 1}. ${label}`;
				const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
				wrap(prefix + (i === selected ? theme.fg("accent", text) : text));
				if (option?.description) wrap(theme.fg("muted", option.description), "     ");
			}
			if (editing) {
				lines.push("", truncateToWidth(theme.fg("muted", "Your answer:"), w));
				for (const line of answer.render(w)) lines.push(line);
			}
			lines.push("", truncateToWidth(theme.fg("dim", editing ? "enter submit • esc back" : "j/k move • enter choose • esc dismiss"), w), border);
			return lines.map((line) => truncateToWidth(line, w));
		},
		handleInput(data: string): void {
			// The dialog has focus, so Pi never sees Ctrl+C: treat it as dismissing, in either mode.
			if (parseKey(data) === "ctrl+c") {
				done({ kind: "dismissed" });
				return;
			}
			if (editing) {
				if (parseKey(data) === "escape") {
					leaveEditing();
					return;
				}
				answer.handleInput(data);
				refresh();
				return;
			}
			const name = parseKey(data);
			// The shared keymap closes on q; a question closes only on Esc or Ctrl+C, so it is never dismissed by a stray key.
			if (!name || name === "q") return;
			const step = keyStep(keys, name, { actions: [] });
			keys = step.state;
			const { action } = step;
			if (action.type === "close") {
				done({ kind: "dismissed" });
				return;
			}
			if (action.type === "enter") {
				const option = input.options[selected];
				if (option) done({ kind: "option", index: selected, label: option.label });
				else editing = true;
				refresh();
				return;
			}
			if (action.type === "move") selected = moveIndex(selected, rows, action.move, rows);
			refresh();
		},
	};
}
