import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { fuzzySelect } from "../worktree/fuzzy-select.ts";
import type { KeyState } from "./keymap.ts";
import { INITIAL_KEY_STATE, keyStep, moveIndex } from "./keymap.ts";
import type { Runtime } from "./runtime.ts";
import { errorMessage } from "./secrets.ts";
import type { TriageActionUi, TriageKey } from "./triage-actions.ts";
import { confirmAndPromote, runTriageAction, TRIAGE_ACTIONS } from "./triage-actions.ts";
import { candidateLabel, candidateSummary, openCandidates } from "./triage.ts";
import type { Candidate } from "./types.ts";

export type { TriageKey } from "./triage-actions.ts";
export type TriageUiContext = {
	ui: {
		custom: <T>(factory: (tui: { requestRender: () => void }, theme: any, keybindings: unknown, done: (value: T) => void) => any) => Promise<T>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
	};
};
type ListResult = { type: "action"; key: TriageKey; candidate: Candidate } | { type: "cancel" };

const WINDOW = 10;
const HINTS = "j/k move • gg/G first/last • ^d/^u half page • a accept/apply • m merge • d dismiss • z snooze • A all from source • p accept+promote • enter details • esc close";

export function triageList(ctx: TriageUiContext, candidates: Candidate[]): Promise<ListResult> {
	return ctx.ui.custom<ListResult>((tui, theme, _keybindings, done) => {
		let selected = 0;
		let keys: KeyState = INITIAL_KEY_STATE;
		return {
			invalidate() {},
			render(width: number): string[] {
				const border = new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "";
				const lines = [border, truncateToWidth(theme.fg("accent", theme.bold(`Work triage (${candidates.length} open)`)), width), ""];
				const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), candidates.length - WINDOW));
				for (let i = start; i < Math.min(candidates.length, start + WINDOW); i++) {
					const label = candidateLabel(candidates[i]);
					const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
					lines.push(truncateToWidth(prefix + (i === selected ? theme.fg("accent", label) : label), width));
					lines.push(truncateToWidth(`    ${theme.fg("muted", candidateSummary(candidates[i]))}`, width));
				}
				lines.push("", truncateToWidth(theme.fg("dim", HINTS), width), border);
				return lines;
			},
			handleInput(data: string): void {
				const name = parseKey(data);
				if (!name) return;
				const step = keyStep(keys, name, { actions: TRIAGE_ACTIONS });
				keys = step.state;
				const { action } = step;
				if (action.type === "close") {
					done({ type: "cancel" });
					return;
				}
				if (action.type === "enter" || action.type === "action") {
					done({ type: "action", key: action.type === "enter" ? "enter" : (action.key as TriageKey), candidate: candidates[selected] });
					return;
				}
				if (action.type === "move") selected = moveIndex(selected, candidates.length, action.move, WINDOW);
				tui.requestRender();
			},
		};
	});
}

export function piTriageUi(ctx: TriageUiContext): TriageActionUi {
	return {
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		notify: (message, level) => ctx.ui.notify(message, level),
		pickItem: (title, items) => fuzzySelect(ctx, {
			title,
			items,
			getLabel: (item) => `${item.id} ${item.title}`,
			getDescription: (item) => `#${item.project} · ${item.status}`,
			getSearchText: (item) => `${item.id} ${item.title} ${item.project}`,
		}),
	};
}

export async function promoteWithConfirm(ctx: TriageUiContext, runtime: Runtime, itemId: string): Promise<void> {
	await confirmAndPromote(piTriageUi(ctx), runtime, itemId);
}

export async function handleTriageAction(ctx: TriageUiContext, runtime: Runtime, key: TriageKey, candidate: Candidate): Promise<void> {
	await runTriageAction(piTriageUi(ctx), runtime, key, candidate);
}

export async function runTriageUi(ctx: TriageUiContext, runtime: Runtime): Promise<void> {
	for (;;) {
		const open = openCandidates(runtime.store);
		if (open.length === 0) {
			ctx.ui.notify("Triage inbox is empty", "info");
			return;
		}
		const result = await triageList(ctx, open);
		if (result.type === "cancel") return;
		try {
			await handleTriageAction(ctx, runtime, result.key, result.candidate);
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
		}
	}
}
