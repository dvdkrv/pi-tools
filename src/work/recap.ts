import { localDate } from "./capture.ts";
import type { WorkStore } from "./store.ts";
import type { Item } from "./types.ts";

export type RecapRange = { from: string; to: string; label: string };

export function recapRange(which: "today" | "yesterday" | "week", now: Date): RecapRange {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	if (which === "today") return { from: start.toISOString(), to: now.toISOString(), label: localDate(start) };
	if (which === "yesterday") {
		const day = new Date(start);
		day.setDate(day.getDate() - 1);
		return { from: day.toISOString(), to: start.toISOString(), label: localDate(day) };
	}
	const week = new Date(start);
	week.setDate(week.getDate() - 6);
	return { from: week.toISOString(), to: now.toISOString(), label: `${localDate(week)} to ${localDate(start)}` };
}

function line(item: Item): string {
	return `- ${item.id} ${item.title} (#${item.project})`;
}

function section(title: string, lines: string[]): string[] {
	return [`### ${title}`, ...(lines.length ? lines : ["- none"]), ""];
}

export function renderRecap(store: WorkStore, range: RecapRange, now: Date): string {
	const done = new Set<string>();
	const created = new Set<string>();
	const touched = new Set<string>();
	for (const event of store.listEvents({ since: range.from, until: range.to, entityPrefix: "item:" })) {
		const id = event.entity.slice("item:".length);
		touched.add(id);
		if (event.action === "create") created.add(id);
		const data = event.data as { before?: { status?: string }; after?: { status?: string } } | null;
		if (event.action === "update" && data?.after?.status === "done" && data.before?.status !== "done") done.add(id);
	}
	const items = (ids: Iterable<string>) => [...ids].map((id) => store.getItem(id)).filter((item): item is Item => item !== undefined);
	const progressed = [...touched].filter((id) => !done.has(id) && !created.has(id));
	const waiting = store.listItems({ statuses: ["waiting"] }).map((item) => {
		const days = item.waitingSince ? Math.max(0, Math.floor((now.getTime() - Date.parse(item.waitingSince)) / 86_400_000)) : 0;
		return `${line(item)}: ${item.waitingOn} for ${days} day${days === 1 ? "" : "s"}${item.waitingReason ? `: ${item.waitingReason}` : ""}`;
	});
	return [
		`## Work recap: ${range.label}`,
		"",
		...section("Done", items(done).map(line)),
		...section("Progressed", items(progressed).map(line)),
		...section("New", items(created).map(line)),
		...section("Waiting on others", waiting),
	].join("\n");
}
