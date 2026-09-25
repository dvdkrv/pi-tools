import { linkFromUrl } from "./capture.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, Candidate, CandidateSource, Item, Link, NewLink } from "./types.ts";

export class TriageError extends Error {}

const URL_START = /^(?:https?|obsidian):\/\//i;

export function openCandidates(store: WorkStore): Candidate[] {
	const now = store.now();
	return store.listCandidates({ states: ["pending", "snoozed"] })
		.filter((candidate) => candidate.state === "pending" || (candidate.snoozeUntil !== null && candidate.snoozeUntil <= now));
}

function requireOpen(store: WorkStore, id: number): Candidate {
	const candidate = store.getCandidate(id);
	if (!candidate) throw new TriageError(`Unknown candidate: ${id}`);
	if (candidate.state !== "pending" && candidate.state !== "snoozed") throw new TriageError(`Candidate ${id} is already ${candidate.state}`);
	return candidate;
}

function candidateLink(candidate: Candidate): NewLink | undefined {
	const link = candidate.payload.link as NewLink | undefined;
	if (link && typeof link.key === "string" && typeof link.kind === "string") return link;
	if (candidate.source === "agent" && candidate.evidence && URL_START.test(candidate.evidence.trim())) return linkFromUrl(candidate.evidence.trim());
	return undefined;
}

function agentNotes(candidate: Candidate): string {
	return [candidate.reason, candidate.evidence].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
}

export function mergeCandidate(store: WorkStore, id: number, targetItemId: string, actor: Actor = "user"): Link | undefined {
	return store.transaction(() => {
		const candidate = requireOpen(store, id);
		if (candidate.kind === "jira-update") throw new TriageError("Jira updates can't be merged");
		const target = store.getItem(targetItemId);
		if (!target) throw new TriageError(`Unknown item: ${targetItemId}`);
		const link = candidateLink(candidate);
		const added = link && !store.findLinkByKey(link.key) ? store.addLink(target.id, link, actor) : undefined;
		if (candidate.source === "agent") {
			const note = agentNotes(candidate);
			if (note) store.updateItem(target.id, { notes: target.notes ? `${target.notes}\n\n${note}` : note }, actor);
		}
		store.updateCandidate(candidate.id, { state: "merged" }, actor);
		return added;
	});
}

export function acceptCandidate(store: WorkStore, id: number, edits: { title?: string; project?: string } = {}, actor: Actor = "user"): Item {
	return store.transaction(() => {
		const candidate = requireOpen(store, id);
		if (candidate.kind === "jira-update") throw new TriageError("Jira updates are applied with applyJiraUpdate");
		if (candidate.kind === "attach-link") {
			if (!candidate.relatesTo) throw new TriageError(`Candidate ${id} has no related item`);
			mergeCandidate(store, id, candidate.relatesTo, actor);
			return store.getItem(candidate.relatesTo) as Item;
		}
		const item = store.addItem({
			project: edits.project ?? candidate.proposedProject ?? "misc",
			title: edits.title?.trim() || candidate.title,
			notes: candidate.source === "agent" ? agentNotes(candidate) : "",
			origin: candidate.source,
		}, actor);
		const link = candidateLink(candidate);
		if (link && !store.findLinkByKey(link.key)) store.addLink(item.id, link, actor);
		store.updateCandidate(candidate.id, { state: "accepted" }, actor);
		return item;
	});
}

export function dismissCandidate(store: WorkStore, id: number, actor: Actor = "user"): void {
	store.transaction(() => {
		const candidate = requireOpen(store, id);
		store.addDismissal(candidate.dedupeKey, actor);
		store.updateCandidate(candidate.id, { state: "dismissed" }, actor);
	});
}

export function snoozeCandidate(store: WorkStore, id: number, days = 3, actor: Actor = "user"): Candidate {
	if (!Number.isInteger(days) || days < 1 || days > 90) throw new TriageError("Snooze days must be a whole number between 1 and 90");
	requireOpen(store, id);
	const until = new Date(store.clock().getTime() + days * 86_400_000).toISOString();
	return store.updateCandidate(id, { state: "snoozed", snoozeUntil: until }, actor);
}

export function acceptAllFromSource(store: WorkStore, source: CandidateSource, actor: Actor = "user"): Item[] {
	return store.transaction(() => {
		const items: Item[] = [];
		for (const candidate of openCandidates(store)) {
			if (candidate.source !== source || candidate.kind === "jira-update") continue;
			items.push(acceptCandidate(store, candidate.id, {}, actor));
		}
		return items;
	});
}

export function candidateLabel(candidate: Candidate): string {
	const kind = candidate.kind === "new-item" ? "" : `${candidate.kind} `;
	return `[${candidate.source}] ${kind}${candidate.title}`;
}

export function candidateDetails(candidate: Candidate, remaining?: number): string {
	const lines = [`${remaining ? `(${remaining} open) ` : ""}${candidateLabel(candidate)}`, `  reason: ${candidate.reason}`];
	if (candidate.evidence) lines.push(`  evidence: ${candidate.evidence}`);
	if (candidate.relatesTo) lines.push(`  relates to: ${candidate.relatesTo}`);
	else if (candidate.kind === "new-item") lines.push(`  project: #${candidate.proposedProject ?? "misc"}`);
	if (candidate.proposer) lines.push(`  proposed by session ${candidate.proposer.sessionId}${candidate.proposer.repo ? ` in ${candidate.proposer.repo}` : ""}`);
	return lines.join("\n");
}
