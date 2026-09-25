import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { fuzzySelect } from "../worktree/fuzzy-select.ts";
import { applyJiraUpdate, formatPreview, promoteItem, promotionPreview } from "./connectors/jira.ts";
import type { Runtime } from "./runtime.ts";
import { errorMessage } from "./secrets.ts";
import {
	acceptAllFromSource,
	acceptCandidate,
	candidateDetails,
	candidateLabel,
	dismissCandidate,
	mergeCandidate,
	openCandidates,
	snoozeCandidate,
	TriageError,
} from "./triage.ts";
import type { Candidate } from "./types.ts";

export type TriageKey = "a" | "m" | "d" | "z" | "A" | "p" | "enter";
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

const ACTION_KEYS: readonly string[] = ["a", "m", "d", "z", "A", "p"];
const WINDOW = 10;

export function triageKeyFor(data: string): TriageKey | undefined {
	if (ACTION_KEYS.includes(data)) return data as TriageKey;
	if (matchesKey(data, Key.enter)) return "enter";
	return undefined;
}

function summaryLine(candidate: Candidate): string {
	const target = candidate.relatesTo ? `→ ${candidate.relatesTo}` : candidate.kind === "new-item" ? `#${candidate.proposedProject ?? "misc"}` : "";
	return [target, candidate.reason, candidate.evidence ?? ""].filter(Boolean).join(" · ");
}

export function triageList(ctx: TriageUiContext, candidates: Candidate[]): Promise<ListResult> {
	return ctx.ui.custom<ListResult>((tui, theme, _keybindings, done) => {
		let selected = 0;
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
					lines.push(truncateToWidth(`    ${theme.fg("muted", summaryLine(candidates[i]))}`, width));
				}
				lines.push("", truncateToWidth(theme.fg("dim", "↑↓ move • a accept/apply • m merge • d dismiss • z snooze • A all from source • p accept+promote • enter details • esc close"), width), border);
				return lines;
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					done({ type: "cancel" });
					return;
				}
				const key = triageKeyFor(data);
				if (key) {
					done({ type: "action", key, candidate: candidates[selected] });
					return;
				}
				if (matchesKey(data, Key.up)) selected = Math.max(0, selected - 1);
				if (matchesKey(data, Key.down)) selected = Math.min(candidates.length - 1, selected + 1);
				tui.requestRender();
			},
		};
	});
}

export async function promoteWithConfirm(ctx: TriageUiContext, runtime: Runtime, itemId: string): Promise<void> {
	if (!runtime.jira) throw new TriageError("Jira is not configured");
	const preview = promotionPreview(runtime.store, itemId, runtime.jira.config);
	if (!(await ctx.ui.confirm(`Create Jira ${preview.issueType} for ${itemId}?`, formatPreview(preview)))) return;
	const link = await promoteItem(runtime.store, itemId, runtime.jira);
	ctx.ui.notify(`Created ${link.key.slice("jira:".length)} for ${itemId}`, "info");
}

async function applyUpdate(ctx: TriageUiContext, runtime: Runtime, candidate: Candidate): Promise<void> {
	if (!runtime.jira) throw new TriageError("Jira is not configured");
	if (!(await ctx.ui.confirm("Apply Jira update?", candidateDetails(candidate)))) return;
	const result = await applyJiraUpdate(runtime.store, candidate.id, runtime.jira, async (options) => {
		const labels = options.map((option) => `${option.name} (${option.category})`);
		const choice = await ctx.ui.select(`Transition for ${String(candidate.payload.ticket)}`, labels);
		return options[labels.indexOf(choice ?? "")];
	});
	ctx.ui.notify(result === "applied" ? `Updated ${String(candidate.payload.ticket)}` : "Cancelled", "info");
}

export async function handleTriageAction(ctx: TriageUiContext, runtime: Runtime, key: TriageKey, candidate: Candidate): Promise<void> {
	const { store } = runtime;
	const isJira = candidate.kind === "jira-update";
	switch (key) {
		case "enter":
			ctx.ui.notify(candidateDetails(candidate), "info");
			return;
		case "d":
			dismissCandidate(store, candidate.id);
			return;
		case "z": {
			const days = await ctx.ui.input("Snooze for how many days?", "3");
			if (days === undefined) return;
			snoozeCandidate(store, candidate.id, days.trim() ? Number(days) : 3);
			return;
		}
		case "A": {
			if (isJira) throw new TriageError("Jira updates can't be bulk accepted");
			ctx.ui.notify(`Accepted ${acceptAllFromSource(store, candidate.source).length} from ${candidate.source}`, "info");
			return;
		}
		case "m": {
			if (isJira) throw new TriageError("Jira updates can't be merged");
			const target = await fuzzySelect(ctx, {
				title: "Merge into item",
				items: store.listItems({ statuses: ["todo", "doing", "waiting", "parked"] }),
				getLabel: (item) => `${item.id} ${item.title}`,
				getDescription: (item) => `#${item.project} · ${item.status}`,
				getSearchText: (item) => `${item.id} ${item.title} ${item.project}`,
			});
			if (target) mergeCandidate(store, candidate.id, target.id);
			return;
		}
		case "a":
		case "p": {
			if (isJira) {
				if (key === "p") throw new TriageError("Use a to apply a Jira update");
				await applyUpdate(ctx, runtime, candidate);
				return;
			}
			let edits: { title?: string; project?: string } = {};
			if (candidate.kind === "new-item") {
				const title = await ctx.ui.input("Title (empty keeps it)", candidate.title);
				if (title === undefined) return;
				const proposed = candidate.proposedProject ?? "misc";
				const project = await ctx.ui.select("Project", [proposed, ...[...runtime.knownProjects()].filter((slug) => slug !== proposed).sort()]);
				if (!project) return;
				edits = { title: title.trim() || undefined, project };
			}
			const item = acceptCandidate(store, candidate.id, edits);
			if (key === "p") await promoteWithConfirm(ctx, runtime, item.id);
			return;
		}
	}
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
