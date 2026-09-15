import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type FuzzyFilterOptions<T> = {
	getSearchText: (item: T) => string;
	limit?: number;
};

export type PickerCustomAction = {
	key: string;
	label: string;
	requiresSelection?: boolean;
};

export type FuzzySelectOptions<T> = FuzzyFilterOptions<T> & {
	title: string;
	items: T[];
	getLabel: (item: T) => string;
	getDescription?: (item: T) => string | undefined;
	placeholder?: string;
};

export type ActionPickerOptions<T> = FuzzySelectOptions<T> & {
	actions?: PickerCustomAction[];
	emptyText?: string;
};

export type ActionPickerResult<T> =
	| { type: "select"; item: T }
	| { type: "custom"; key: string; item?: T }
	| { type: "cancel" };

type MinimalUiContext = {
	ui: {
		custom: <T>(factory: (tui: { requestRender: () => void }, theme: any, keybindings: unknown, done: (value: T) => void) => any) => Promise<T>;
		input?: (title: string, placeholder?: string) => Promise<string | undefined>;
	};
};

function fuzzyScore(text: string, query: string): number | undefined {
	const normalizedText = text.toLowerCase();
	const normalizedQuery = query.toLowerCase().trim();
	if (!normalizedQuery) return 0;

	let lastIndex = -1;
	let firstIndex = -1;
	let score = 0;
	for (const char of normalizedQuery) {
		const index = normalizedText.indexOf(char, lastIndex + 1);
		if (index === -1) return undefined;
		if (firstIndex === -1) firstIndex = index;
		const gap = index - lastIndex - 1;
		score += gap;
		lastIndex = index;
	}

	return score + firstIndex * 0.1 + normalizedText.length * 0.001;
}

export function fuzzyFilter<T>(items: T[], query: string, options: FuzzyFilterOptions<T>): T[] {
	const limit = options.limit ?? 10;
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return items.slice(0, limit);

	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(options.getSearchText(item), normalizedQuery) }))
		.filter((entry): entry is { item: T; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.item);
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

export function pickerInputAction(data: string, actions: PickerCustomAction[]): { type: "custom"; key: string } | undefined {
	const action = actions.find((candidate) => candidate.key === data);
	return action ? { type: "custom", key: action.key } : undefined;
}

function actionHelp(actions: PickerCustomAction[]): string {
	return actions.map((action) => `${action.key} ${action.label}`).join(" • ");
}

export async function actionPicker<T>(ctx: MinimalUiContext, options: ActionPickerOptions<T>): Promise<ActionPickerResult<T>> {
	return ctx.ui.custom<ActionPickerResult<T>>((tui, theme, _keybindings, done) => {
		let query = "";
		let selectedIndex = 0;
		const actions = options.actions ?? [];

		function results(): T[] {
			return fuzzyFilter(options.items, query, { getSearchText: options.getSearchText, limit: options.limit ?? 10 });
		}

		function selectedItem(): T | undefined {
			return results()[selectedIndex];
		}

		function clampSelection(): void {
			const count = results().length;
			selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, count - 1)));
		}

		function invalidate(): void {}

		return {
			invalidate,
			render(width: number): string[] {
				const currentResults = results();
				clampSelection();
				const lines: string[] = [];
				lines.push(new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "");
				lines.push(truncateToWidth(theme.fg("accent", theme.bold(options.title)), width));
				const prompt = query || theme.fg("dim", options.placeholder ?? "type to search");
				lines.push(truncateToWidth(`Search: ${prompt}`, width));
				lines.push("");

				if (currentResults.length === 0) {
					lines.push(truncateToWidth(theme.fg("warning", options.emptyText ?? "No matches"), width));
				} else {
					for (let i = 0; i < currentResults.length; i++) {
						const item = currentResults[i];
						const selected = i === selectedIndex;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const label = options.getLabel(item);
						const line = selected ? theme.fg("accent", label) : label;
						lines.push(truncateToWidth(prefix + line, width));
						const description = options.getDescription?.(item);
						if (description) lines.push(truncateToWidth(`    ${theme.fg("muted", description)}`, width));
					}
				}

				lines.push("");
				const actionText = actionHelp(actions);
				const help = `${currentResults.length} of ${options.items.length} shown • type search • ↑↓ navigate • enter open • esc cancel${actionText ? ` • ${actionText}` : ""}`;
				lines.push(truncateToWidth(theme.fg("dim", help), width));
				lines.push(new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "");
				return lines;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					done({ type: "cancel" });
					return;
				}
				const custom = pickerInputAction(data, actions);
				if (custom) {
					const action = actions.find((candidate) => candidate.key === custom.key);
					const item = selectedItem();
					if (action?.requiresSelection && !item) return;
					done({ type: "custom", key: custom.key, item });
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const item = selectedItem();
					if (item) done({ type: "select", item });
					return;
				}
				if (matchesKey(data, Key.up)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					selectedIndex = Math.min(Math.max(0, results().length - 1), selectedIndex + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.backspace)) {
					query = query.slice(0, -1);
					selectedIndex = 0;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.ctrl("u"))) {
					query = "";
					selectedIndex = 0;
					tui.requestRender();
					return;
				}
				if (isPrintable(data)) {
					query += data;
					selectedIndex = 0;
					tui.requestRender();
				}
			},
		};
	});
}

export async function textInput(ctx: MinimalUiContext, title: string, placeholder?: string): Promise<string | undefined> {
	if (!ctx.ui.input) throw new Error("Input UI is not available");
	const value = await ctx.ui.input(title, placeholder);
	const trimmed = value?.trim();
	return trimmed || undefined;
}

export async function fuzzySelect<T>(ctx: MinimalUiContext, options: FuzzySelectOptions<T>): Promise<T | undefined> {
	const result = await actionPicker(ctx, options);
	return result.type === "select" ? result.item : undefined;
}
