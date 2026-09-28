import { basename } from "node:path";
import type { DashModel, DashRow, SessionEntry } from "./model.ts";
import { allRows, lastActivity } from "./model.ts";
import type { Style } from "./text.ts";
import { fit, formatAge, oneLine, sanitize, truncate, visibleWidth } from "./text.ts";

export type ViewState = { selected: string | null; filter: string; editing: boolean; message: string };
export type Cells = { label: string; window: string; item: string; age: string; note: string };
type Widths = { window: number; item: number; age: number };
type Caps = readonly [number, number, number];

export const HINTS = "j/k move · enter open · L link · D delete · / filter · ? help · q quit";
const LABEL_WIDTH = 9;
const GAP = "  ";
const SESSION_CAPS: { narrow: Caps; wide: Caps } = { narrow: [16, 6, 4], wide: [28, 40, 4] };
const JOB_CAPS: { narrow: Caps; wide: Caps } = { narrow: [20, 12, 4], wide: [32, 20, 4] };

const isJobRow = (row: DashRow): boolean => row.kind === "job" || row.kind === "alert";

export function sessionLabel(session: SessionEntry): string {
	if (session.liveness !== "live") return session.liveness;
	return session.status === "waiting-external" ? "waiting" : session.status;
}

export function rowCells(row: DashRow, now: Date, wide: boolean): Cells {
	if (row.kind === "triage") return { label: "triage", window: "", item: "", age: "", note: `${row.count} pending candidate${row.count === 1 ? "" : "s"}` };
	if (row.kind === "job" || row.kind === "alert") {
		const job = row.job;
		const health = job.stoppedAt ? "stopped" : (job.lastCheckStatus ?? "unknown");
		return {
			label: row.kind === "alert" ? "unhealthy" : health,
			window: oneLine(job.name),
			item: oneLine(job.schedule ?? job.kind),
			age: job.lastCheckAt ? formatAge(now.getTime() - Date.parse(job.lastCheckAt)) : "-",
			note: oneLine(job.lastCheckOutput ?? ""),
		};
	}
	const s = row.session;
	const child = s.parentSession !== null;
	const since = child || s.liveness !== "live" ? lastActivity(s) : s.statusAt;
	const window = child ? (s.name ?? `child ${s.id.slice(0, 8)}`) : (s.tmuxWindow ?? basename(s.cwd));
	const item = s.itemId ? (wide && s.itemTitle ? `${s.itemId} ${s.itemTitle}` : s.itemId) : "-";
	const note = s.note ? `"${s.note}"` : child ? "" : (s.name ?? "");
	return { label: sessionLabel(s), window: oneLine(window), item: oneLine(item), age: formatAge(now.getTime() - Date.parse(since)), note: oneLine(note) };
}

export function rowMatches(row: DashRow, filter: string, now: Date): boolean {
	if (!filter) return true;
	const cells = rowCells(row, now, true);
	return [cells.label, cells.window, cells.item, cells.note].join(" ").toLowerCase().includes(filter.toLowerCase());
}

export function filterModel(model: DashModel, filter: string): DashModel {
	if (!filter) return model;
	return { ...model, sections: model.sections.map((section) => ({ ...section, rows: section.rows.filter((row) => rowMatches(row, filter, model.now)) })) };
}

function widths(rows: readonly DashRow[], now: Date, wide: boolean, caps: Caps): Widths {
	const cells = rows.map((row) => rowCells(row, now, wide));
	const max = (pick: (cell: Cells) => string, cap: number): number => Math.min(cap, Math.max(1, ...cells.map((cell) => visibleWidth(pick(cell)))));
	return { window: max((c) => c.window, caps[0]), item: max((c) => c.item, caps[1]), age: max((c) => c.age, caps[2]) };
}

function rowText(row: DashRow, now: Date, wide: boolean, w: { session: Widths; job: Widths }, width: number): string {
	const cells = rowCells(row, now, wide);
	if (row.kind === "triage") return truncate(`${fit(cells.label, LABEL_WIDTH)}${GAP}${cells.note}`, width);
	const cw = isJobRow(row) ? w.job : w.session;
	const indent = row.kind === "session" && row.depth === 1 ? "  " : "";
	const head = [fit(cells.label, LABEL_WIDTH), fit(cells.window, cw.window), fit(cells.item, cw.item), cells.age.padStart(cw.age)].join(GAP);
	return truncate(`${indent}${head}${GAP}${cells.note}`, width);
}

function styleRow(row: DashRow, line: string, style: Style): string {
	if (row.kind === "alert") return style.color("red", line);
	if (row.kind === "job") {
		if (row.job.stoppedAt) return style.dim(line);
		return row.job.lastCheckStatus === "unhealthy" ? style.color("red", line) : line;
	}
	if (row.kind !== "session") return line;
	if (row.session.liveness === "crashed") return style.color("red", line);
	if (row.session.liveness === "closed" || row.session.status === "done") return style.dim(line);
	if (row.session.status === "needs-me" && row.depth === 0) return style.color("yellow", line);
	return line;
}

export function renderDash(model: DashModel, state: ViewState, width: number, height: number, style: Style): string[] {
	const wide = width >= 120;
	const all = allRows(model);
	const w = {
		session: widths(all.filter((row) => row.kind === "session"), model.now, wide, wide ? SESSION_CAPS.wide : SESSION_CAPS.narrow),
		job: widths(all.filter(isJobRow), model.now, wide, wide ? JOB_CAPS.wide : JOB_CAPS.narrow),
	};
	const shown = filterModel(model, state.filter);
	const body: string[] = [];
	let selectedLine = -1;
	for (const section of shown.sections) {
		const count = section.rows.filter((row) => row.kind !== "session" || row.depth === 0).length;
		body.push(style.bold(truncate(`${section.title} (${count})`, width)));
		for (const row of section.rows) {
			const text = rowText(row, model.now, wide, w, width - 2);
			if (row.key === state.selected) {
				selectedLine = body.length;
				body.push(style.inverse(fit(`> ${text}`, width)));
			} else {
				body.push(styleRow(row, `  ${text}`, style));
			}
		}
	}
	const bodyHeight = Math.max(1, height - 3);
	const offset = selectedLine >= bodyHeight ? selectedLine - bodyHeight + 1 : 0;
	const title = state.filter || state.editing ? `Work dashboard  /${state.filter}${state.editing ? "_" : ""}` : "Work dashboard";
	return [
		style.bold(truncate(sanitize(title), width)),
		...body.slice(offset, offset + bodyHeight),
		style.dim(truncate(HINTS, width)),
		truncate(oneLine(state.message), width),
	];
}
