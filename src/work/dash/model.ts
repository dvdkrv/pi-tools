import type { PidReaders, ProbedSession } from "../liveness.ts";
import { probeSessions } from "../liveness.ts";
import type { WorkStore } from "../store.ts";
import type { TmuxPane } from "../tmux.ts";
import type { Session } from "../types.ts";

export type SectionId = "decisions" | "waiting" | "working" | "jobs" | "other";
export type SessionEntry = ProbedSession & { itemId: string | null; itemTitle: string | null };
export type DashRow =
	| { kind: "session"; key: string; session: SessionEntry; depth: 0 | 1 }
	| { kind: "triage"; key: string; count: number };
export type DashSection = { id: SectionId; title: string; rows: DashRow[] };
export type DashModel = { sections: DashSection[]; now: Date };
export type DashInput = { sessions: readonly SessionEntry[]; triageCount: number; now: Date };

export const RECENT_MS = 7 * 86_400_000;

export function lastActivity(session: Session): string {
	return session.lastTurnAt ?? session.startedAt;
}

export function loadSessions(store: WorkStore, panes: readonly TmuxPane[] | undefined, readers?: PidReaders): SessionEntry[] {
	return probeSessions(store.listSessions(), panes, readers).map((session) => {
		const link = store.sessionLink(session.id);
		const item = link ? store.getItem(link.itemId) : undefined;
		return { ...session, itemId: item?.id ?? null, itemTitle: item?.title ?? null };
	});
}

const byStatusAt = (a: Session, b: Session): number => a.statusAt.localeCompare(b.statusAt) || a.id.localeCompare(b.id);
const byStart = (a: Session, b: Session): number => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
const byRecentActivity = (a: Session, b: Session): number => lastActivity(b).localeCompare(lastActivity(a)) || a.id.localeCompare(b.id);

export function buildDashModel(input: DashInput): DashModel {
	const cutoff = input.now.getTime() - RECENT_MS;
	const sessions = input.sessions.filter((s) => s.liveness === "live" || Date.parse(lastActivity(s)) >= cutoff);
	const children = new Map<string, SessionEntry[]>();
	for (const session of sessions) {
		if (session.parentSession) children.set(session.parentSession, [...(children.get(session.parentSession) ?? []), session]);
	}
	const placed = new Set<string>();
	const rows = (list: readonly SessionEntry[]): DashRow[] => list.flatMap((session) => {
		placed.add(session.id);
		const kids = [...(children.get(session.id) ?? [])].sort(byStart);
		for (const kid of kids) placed.add(kid.id);
		return [
			{ kind: "session" as const, key: `session:${session.id}`, session, depth: 0 as const },
			...kids.map((kid) => ({ kind: "session" as const, key: `session:${kid.id}`, session: kid, depth: 1 as const })),
		];
	});

	const top = sessions.filter((s) => !s.parentSession);
	const live = top.filter((s) => s.liveness === "live");
	const decisions = rows(live.filter((s) => s.status === "needs-me").sort(byStatusAt));
	if (input.triageCount > 0) decisions.push({ kind: "triage", key: "triage", count: input.triageCount });
	const waiting = rows(live.filter((s) => s.status === "waiting-external").sort(byStatusAt));
	const working = rows(live.filter((s) => s.status === "working").sort(byStatusAt));
	const done = live.filter((s) => s.status === "done").sort((a, b) => byStatusAt(b, a));
	const ended = top.filter((s) => s.liveness !== "live").sort(byRecentActivity);
	const other = rows([...done, ...ended]);
	const orphans = sessions.filter((s) => s.parentSession && !placed.has(s.id)).sort(byRecentActivity);
	other.push(...orphans.map((session) => ({ kind: "session" as const, key: `session:${session.id}`, session, depth: 0 as const })));

	return {
		now: input.now,
		sections: [
			{ id: "decisions", title: "Decisions", rows: decisions },
			{ id: "waiting", title: "Waiting", rows: waiting },
			{ id: "working", title: "Working", rows: working },
			{ id: "other", title: "Other sessions", rows: other },
		],
	};
}

export function allRows(model: DashModel): DashRow[] {
	return model.sections.flatMap((section) => section.rows);
}
