import { applyJiraUpdate, formatPreview, promoteItem, promotionPreview } from "./connectors/jira.ts";
import type { Runtime } from "./runtime.ts";
import {
	acceptAllFromSource,
	acceptCandidate,
	candidateDetails,
	dismissCandidate,
	mergeCandidate,
	snoozeCandidate,
	TriageError,
} from "./triage.ts";
import type { Candidate, Item } from "./types.ts";
import { OPEN_ITEM_STATUSES } from "./types.ts";
import { recordTriage } from "./usage.ts";

export type TriageKey = "a" | "m" | "d" | "z" | "A" | "p" | "enter";
export const TRIAGE_ACTIONS: readonly string[] = ["a", "m", "d", "z", "A", "p"];

// The UI surface triage actions need. Pi's /triage and the dashboard's triage view each implement it.
export type TriageActionUi = {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	pickItem(title: string, items: Item[]): Promise<Item | undefined>;
};

export async function confirmAndPromote(ui: TriageActionUi, runtime: Runtime, itemId: string): Promise<void> {
	if (!runtime.jira) throw new TriageError("Jira is not configured");
	const preview = promotionPreview(runtime.store, itemId, runtime.jira.config);
	if (!(await ui.confirm(`Create Jira ${preview.issueType} for ${itemId}?`, formatPreview(preview)))) return;
	const link = await promoteItem(runtime.store, itemId, runtime.jira);
	ui.notify(`Created ${link.key.slice("jira:".length)} for ${itemId}`, "info");
}

async function applyUpdate(ui: TriageActionUi, runtime: Runtime, candidate: Candidate): Promise<boolean> {
	if (!runtime.jira) throw new TriageError("Jira is not configured");
	if (!(await ui.confirm("Apply Jira update?", candidateDetails(candidate)))) return false;
	const result = await applyJiraUpdate(runtime.store, candidate.id, runtime.jira, async (options) => {
		const labels = options.map((option) => `${option.name} (${option.category})`);
		const choice = await ui.select(`Transition for ${String(candidate.payload.ticket)}`, labels);
		return options[labels.indexOf(choice ?? "")];
	});
	ui.notify(result === "applied" ? `Updated ${String(candidate.payload.ticket)}` : "Cancelled", "info");
	return result === "applied";
}

export async function runTriageAction(ui: TriageActionUi, runtime: Runtime, key: TriageKey, candidate: Candidate): Promise<void> {
	const { store } = runtime;
	const isJira = candidate.kind === "jira-update";
	switch (key) {
		case "enter":
			ui.notify(candidateDetails(candidate), "info");
			return;
		case "d":
			dismissCandidate(store, candidate.id);
			recordTriage(runtime, "dismiss", candidate);
			return;
		case "z": {
			const days = await ui.input("Snooze for how many days?", "3");
			if (days === undefined) return;
			snoozeCandidate(store, candidate.id, days.trim() ? Number(days) : 3);
			recordTriage(runtime, "snooze", candidate);
			return;
		}
		case "A": {
			if (isJira) throw new TriageError("Jira updates can't be bulk accepted");
			const accepted = acceptAllFromSource(store, candidate.source);
			recordTriage(runtime, "accept-all", candidate);
			ui.notify(`Accepted ${accepted.length} from ${candidate.source}`, "info");
			return;
		}
		case "m": {
			if (isJira) throw new TriageError("Jira updates can't be merged");
			const target = await ui.pickItem("Merge into item", store.listItems({ statuses: OPEN_ITEM_STATUSES }));
			if (!target) return;
			mergeCandidate(store, candidate.id, target.id);
			recordTriage(runtime, "merge", candidate);
			return;
		}
		case "a":
		case "p": {
			if (isJira) {
				if (key === "p") throw new TriageError("Use a to apply a Jira update");
				if (await applyUpdate(ui, runtime, candidate)) recordTriage(runtime, "apply", candidate);
				return;
			}
			let edits: { title?: string; project?: string } = {};
			if (candidate.kind === "new-item") {
				const title = await ui.input("Title (empty keeps it)", candidate.title);
				if (title === undefined) return;
				const proposed = candidate.proposedProject ?? "misc";
				const project = await ui.select("Project", [proposed, ...[...runtime.knownProjects()].filter((slug) => slug !== proposed).sort()]);
				if (!project) return;
				edits = { title: title.trim() || undefined, project };
			}
			const item = acceptCandidate(store, candidate.id, edits);
			recordTriage(runtime, key === "p" ? "promote" : "accept", candidate);
			if (key === "p") await confirmAndPromote(ui, runtime, item.id);
			return;
		}
	}
}
