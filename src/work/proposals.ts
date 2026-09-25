import type { WorkConfig } from "./config.ts";
import { projectFor } from "./rules.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, Candidate, Proposer } from "./types.ts";

export const MAX_PENDING_PER_SESSION = 5;

export type ProposalInput = { title: string; reason: string; evidence?: string; project?: string; relatesTo?: string };
export type ProposalResult = { status: "created" | "updated" | "refused"; candidate?: Candidate; message: string };

export function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function refused(message: string): ProposalResult {
	return { status: "refused", message: `Not proposed: ${message}.` };
}

export function proposeCandidate(store: WorkStore, input: ProposalInput, proposer: Proposer, config: WorkConfig): ProposalResult {
	const title = input.title.trim();
	const reason = input.reason.trim();
	const evidence = input.evidence?.trim() || null;
	if (title.length < 3 || title.length > 120) return refused("title must be 3 to 120 characters");
	if (!reason || reason.length > 500) return refused("reason must be 1 to 500 characters");
	if (evidence && evidence.length > 1000) return refused("evidence must be at most 1000 characters");
	const actor: Actor = `agent:${proposer.sessionId}`;
	const dedupeKey = `agent:${proposer.repo ?? "none"}:${normalizeTitle(title)}`;
	return store.transaction(() => {
		const existing = store.findOpenCandidate(dedupeKey);
		if (existing) {
			const candidate = store.updateCandidate(existing.id, { reason, evidence }, actor);
			return { status: "updated", candidate, message: `Updated existing proposal #${candidate.id}; the user will review it in triage.` };
		}
		if (store.isDismissed(dedupeKey)) return refused("the user already dismissed this proposal; do not propose it again");
		const pending = store.listCandidates({ states: ["pending", "snoozed"], proposerSession: proposer.sessionId }).length;
		if (pending >= MAX_PENDING_PER_SESSION) {
			return refused(`this session already has ${MAX_PENDING_PER_SESSION} pending proposals; include further follow-ups in your final summary instead`);
		}
		const known = new Set(store.listProjects().map((project) => project.slug));
		const project = input.project && known.has(input.project)
			? input.project
			: projectFor({ repo: proposer.repo ?? undefined }, config.rules, known);
		let relatesTo: string | null = null;
		let note = "";
		if (input.relatesTo) {
			try {
				if (store.getItem(input.relatesTo)) relatesTo = input.relatesTo;
			} catch {
				relatesTo = null;
			}
			if (!relatesTo) note = ` (ignored unknown item ${input.relatesTo})`;
		}
		const candidate = store.addCandidate({ kind: "new-item", source: "agent", query: null, dedupeKey, title, reason, evidence, proposedProject: project, relatesTo, proposer }, actor);
		return { status: "created", candidate, message: `Proposed #${candidate.id} for triage in #${project}${note}. The user decides whether it becomes an item.` };
	});
}
