import type { WorkStore } from "./store.ts";
import type { Candidate, UsageContext, UsageSurface } from "./types.ts";

export const USAGE_RETENTION_DAYS = 180;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const ENUM = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export type UsageTarget = { store: WorkStore; config: { usage?: boolean } };

// Only numbers, booleans, and enum-like strings survive, so no title, note, or command is ever recorded.
export function sanitizeContext(context: Record<string, unknown>): UsageContext {
	const out: UsageContext = {};
	for (const [key, value] of Object.entries(context)) {
		if (!KEY.test(key)) continue;
		if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
		else if (typeof value === "boolean") out[key] = value;
		else if (typeof value === "string" && ENUM.test(value)) out[key] = value;
	}
	return out;
}

export function recordUsage(target: UsageTarget, surface: UsageSurface, action: string, context: Record<string, unknown> = {}): void {
	if (target.config.usage === false || !ENUM.test(action)) return;
	try {
		target.store.recordUsage(surface, action, sanitizeContext(context));
	} catch {
		// Usage is best effort and never interrupts the user.
	}
}

export function recordTriage(target: UsageTarget, action: string, candidate: Candidate): void {
	recordUsage(target, "triage", action, { source: candidate.source, kind: candidate.kind });
}

export function pruneUsage(store: WorkStore, now: Date): number {
	return store.pruneUsage(new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000).toISOString());
}

// For the previous plan: how many focus items saw any item event after it was saved, or are done.
export function planFollowThrough(store: WorkStore, date: string): { focus: number; followed: number } {
	const previous = store.latestPlanBefore(date);
	if (!previous) return { focus: 0, followed: 0 };
	let followed = 0;
	for (const id of previous.itemIds) {
		let done = false;
		try {
			done = store.getItem(id)?.status === "done";
		} catch {
			done = false;
		}
		const touched = store.listEvents({ since: previous.savedAt, entityPrefix: `item:${id}` }).some((event) => event.entity === `item:${id}` && event.at > previous.savedAt);
		if (done || touched) followed++;
	}
	return { focus: previous.itemIds.length, followed };
}
