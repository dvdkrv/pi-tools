import { formatAge } from "./dash/text.ts";
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

export const DASH_FEATURES: readonly string[] = ["jump", "reopen", "transcript", "link", "check", "stop", "delete", "filter", "triage", "details", "refresh", "help"];

function percentile(sorted: readonly number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const duration = (seconds: number): string => formatAge(seconds * 1000);

export function usageReport(store: WorkStore, days: number, now: Date): string {
	const rows = store.listUsage({ since: new Date(now.getTime() - days * 86_400_000).toISOString() });
	const lines: string[] = [`## Work usage, last ${days} days`, "", `${rows.length} usage rows. No content is recorded.`, ""];

	const responses = rows.filter((row) => row.action === "session.responded").map((row) => Number(row.context.seconds)).filter(Number.isFinite).sort((a, b) => a - b);
	lines.push(
		"### Time in needs-me",
		responses.length ? `- ${plural(responses.length, "response")}; median ${duration(percentile(responses, 0.5))}; 90th percentile ${duration(percentile(responses, 0.9))}` : "- no responses recorded",
		"",
	);

	const triage = rows.filter((row) => row.surface === "triage");
	lines.push("### Triage outcomes");
	if (triage.length === 0) {
		lines.push("- none");
	} else {
		const sourceOf = (row: (typeof triage)[number]): string => String(row.context.source ?? "unknown");
		const actions = [...new Set(triage.map((row) => row.action))].sort();
		const sources = [...new Set(triage.map(sourceOf))].sort();
		lines.push(`| source | ${actions.join(" | ")} |`, `| --- | ${actions.map(() => "---").join(" | ")} |`);
		for (const source of sources) {
			lines.push(`| ${source} | ${actions.map((action) => triage.filter((row) => row.action === action && sourceOf(row) === source).length).join(" | ")} |`);
		}
	}
	lines.push("");

	const saves = rows.filter((row) => row.surface === "planner" && row.action === "save");
	const focus = saves.reduce((sum, row) => sum + (Number(row.context.prev_focus) || 0), 0);
	const followed = saves.reduce((sum, row) => sum + (Number(row.context.followed) || 0), 0);
	lines.push(
		"### Planner follow-through",
		saves.length
			? `- ${saves.length} plan${saves.length === 1 ? "" : "s"} saved; ${followed} of ${focus} previous focus items had activity or were done by the next plan${focus ? ` (${Math.round((followed / focus) * 100)}%)` : ""}`
			: "- no plans saved",
		"",
	);

	const dash = rows.filter((row) => row.surface === "dash");
	const count = (action: string): number => dash.filter((row) => row.action === action).length;
	const opens = count("open");
	const jumps = count("jump");
	lines.push(
		"### Dashboard",
		`- ${plural(opens, "open")} (${(opens / days).toFixed(1)} per day); ${plural(jumps, "jump")} (${opens ? Math.round((jumps / opens) * 100) : 0}% of opens)`,
		`- unused in this window: ${DASH_FEATURES.filter((feature) => count(feature) === 0).join(", ") || "none"}`,
		"",
	);

	lines.push("### Commands");
	for (const surface of ["cli", "pi"] as const) {
		const counts = new Map<string, number>();
		for (const row of rows) {
			if (row.surface === surface && row.action !== "session.responded") counts.set(row.action, (counts.get(row.action) ?? 0) + 1);
		}
		const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([action, n]) => `${action} ${n}`).join(", ");
		lines.push(`- ${surface}: ${list || "none"}`);
	}
	return lines.join("\n");
}
