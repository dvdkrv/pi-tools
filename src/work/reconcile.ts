import type { WorkConfig } from "./config.ts";
import { itemForKeys, itemWithoutJiraByTitle, projectFor } from "./rules.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, CandidateSource, ConnectorResult, JsonObject, LinkKind, Observation, SignalKind } from "./types.ts";

export type ReconcileSummary = { updatedLinks: number; signals: number; created: number; withdrawn: number };
export type SignalChange = { kind: SignalKind; detail: string };

export function emptySummary(): ReconcileSummary {
	return { updatedLinks: 0, signals: 0, created: 0, withdrawn: 0 };
}

function plural(count: number, word: string): string {
	return `${count} new ${word}${count === 1 ? "" : "s"}`;
}

export function diffSignals(kind: LinkKind, prev: JsonObject | null, next: JsonObject): SignalChange[] {
	if (!prev) return [];
	const out: SignalChange[] = [];
	if (kind === "github-pr") {
		if (prev.detailed !== true || next.detailed !== true) return [];
		if (prev.state !== "MERGED" && next.state === "MERGED") out.push({ kind: "pr-merged", detail: "merged" });
		else if (prev.state === "OPEN" && next.state === "CLOSED") out.push({ kind: "pr-closed", detail: "closed without merging" });
		const reviews = Number(next.reviews ?? 0) - Number(prev.reviews ?? 0);
		if (reviews > 0) out.push({ kind: "review-received", detail: `${plural(reviews, "review")}${next.reviewDecision ? ` (${String(next.reviewDecision)})` : ""}` });
		const comments = Number(next.comments ?? 0) - Number(prev.comments ?? 0);
		if (comments > 0) out.push({ kind: "comments-new", detail: plural(comments, "comment") });
		if (next.checks === "failing" && prev.checks !== "failing") out.push({ kind: "checks-failing", detail: "checks failing" });
		if (prev.checks === "failing" && next.checks === "passing") out.push({ kind: "checks-passing", detail: "checks passing again" });
	} else if (kind === "jira") {
		if (prev.status !== next.status) out.push({ kind: "jira-status-changed", detail: `${String(prev.status)} → ${String(next.status)}` });
		if (prev.assignedToMe === true && next.assignedToMe === false) out.push({ kind: "jira-unassigned", detail: "no longer assigned to you" });
	}
	return out;
}

function proposeJiraDone(store: WorkStore, itemId: string, obs: Observation, actor: Actor): number {
	let created = 0;
	for (const link of store.listLinks(itemId)) {
		if (link.kind !== "jira" || link.state?.category === "done") continue;
		const ticket = link.key.slice("jira:".length);
		const dedupeKey = `jira-update:${ticket}:done`;
		if (store.isDismissed(dedupeKey) || store.findOpenCandidate(dedupeKey)) continue;
		store.addCandidate({
			kind: "jira-update",
			source: "github",
			query: null,
			dedupeKey,
			title: `Move ${ticket} to Done?`,
			reason: `${obs.title} merged`,
			evidence: obs.url,
			relatesTo: itemId,
			payload: { ticket, targetCategory: "done" },
		}, actor);
		created++;
	}
	return created;
}

export function reconcile(store: WorkStore, result: ConnectorResult, config: WorkConfig): ReconcileSummary {
	const summary = emptySummary();
	const actor: Actor = `sync:${result.connector}`;
	const source: CandidateSource = result.connector;
	return store.transaction(() => {
		const known = new Set(store.listProjects().filter((project) => project.status !== "archived").map((project) => project.slug));
		for (const obs of result.observations) {
			const link = store.findLinkByKey(obs.key);
			if (link) {
				if (obs.state.detailed === false && link.state?.detailed === true) continue;
				const changes = diffSignals(link.kind, link.state, obs.state);
				store.updateLinkState(link.id, obs.state, actor);
				summary.updatedLinks++;
				for (const change of changes) {
					store.addSignal({ itemId: link.itemId, linkId: link.id, kind: change.kind, detail: change.detail }, actor);
					summary.signals++;
					if (change.kind === "pr-merged") summary.created += proposeJiraDone(store, link.itemId, obs, actor);
				}
				continue;
			}
			if (store.isDismissed(obs.key) || store.findOpenCandidate(obs.key)) continue;
			const related = itemForKeys(store, (obs.meta.jiraKeys ?? []).map((key) => `jira:${key}`))
				?? (obs.kind === "jira" && obs.meta.summary ? itemWithoutJiraByTitle(store, obs.meta.summary) : undefined);
			store.addCandidate({
				kind: related ? "attach-link" : "new-item",
				source,
				query: result.query,
				dedupeKey: obs.key,
				title: obs.title,
				reason: obs.reason,
				evidence: obs.url,
				proposedProject: related ? null : projectFor({ repo: obs.meta.repo, jiraEpic: obs.meta.jiraEpic, jiraProject: obs.meta.jiraProject }, config.rules, known),
				relatesTo: related ?? null,
				payload: { link: { kind: obs.kind, key: obs.key, url: obs.url, state: obs.state } },
			}, actor);
			summary.created++;
		}
		if (result.complete) {
			const seen = new Set(result.observations.map((obs) => obs.key));
			for (const candidate of store.listCandidates({ states: ["pending", "snoozed"], source, query: result.query })) {
				if (candidate.kind === "jira-update" || seen.has(candidate.dedupeKey)) continue;
				store.updateCandidate(candidate.id, { state: "withdrawn" }, actor);
				summary.withdrawn++;
			}
		}
		return summary;
	});
}
