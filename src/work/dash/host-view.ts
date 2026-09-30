// Renders a HostSnapshot as the dashboard's side panel or, when narrow, as one strip line.
// Lines are built from plain segments, truncated, then styled (see text.ts).
import type { Disk, HostSnapshot, TopProcess } from "./host.ts";
import type { Style } from "./text.ts";
import { fit, oneLine, truncate, visibleWidth } from "./text.ts";

const LABEL = 6;
const BLOCKS = "▁▂▃▄▅▆▇█";
const UNITS = ["B", "K", "M", "G", "T", "P"];
const SEP = " · ";
const MOUNT_CAP = 16;

type Paint = (value: string) => string;
type Part = { text: string; paint?: Paint };

function unitFor(n: number): number {
	let unit = 0;
	let value = n;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit;
}

function inUnit(n: number, unit: number): string {
	const value = n / 1024 ** unit;
	return value >= 100 || unit === 0 ? String(Math.round(value)) : value.toFixed(1);
}

export function formatBytes(n: number): string {
	const value = Math.max(0, n);
	const unit = unitFor(value);
	return `${inUnit(value, unit)}${UNITS[unit]}`;
}

// Both sides share the larger value's unit: 366/416G.
function bytesPair(used: number, total: number): string {
	const unit = unitFor(total);
	return `${inUnit(Math.max(0, used), unit)}/${inUnit(total, unit)}${UNITS[unit]}`;
}

const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function paintPercent(style: Style, pct: number): Paint | undefined {
	if (pct >= 95) return (v) => style.color("red", v);
	if (pct >= 80) return (v) => style.color("yellow", v);
	return undefined;
}

function uptime(seconds: number): string {
	const minutes = Math.floor(Math.max(0, seconds) / 60);
	if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
	return `${minutes}m`;
}

function line(parts: readonly Part[], width: number): string {
	let used = 0;
	let out = "";
	for (const part of parts) {
		if (used >= width) break;
		const cut = truncate(part.text, width - used);
		used += visibleWidth(cut);
		out += part.paint ? part.paint(cut) : cut;
	}
	return out;
}

const labelPart = (label: string, style: Style): Part => ({ text: `${fit(label, LABEL)} `, paint: style.dim });
const pctPart = (pct: number, style: Style, text = `${pct}%`): Part => ({ text, paint: paintPercent(style, pct) });
const collecting = (width: number, style: Style): string => line([{ text: "Host   collecting…", paint: style.dim }], width);

export function renderHostPanel(host: HostSnapshot | undefined, liveSessions: number, width: number, height: number, style: Style): string[] {
	if (!host) return [collecting(width, style)];
	const lines: string[] = [];
	const add = (...parts: Part[]): void => void lines.push(line(parts, width));
	const head: string[] = [];
	if (host.uptimeSeconds !== null) head.push(`up ${uptime(host.uptimeSeconds)}`);
	head.push(`${host.cpuCount} cpu`);
	if (host.cgroup.cpuLimit !== null) head.push(`limit ${host.cgroup.cpuLimit} cpu`);
	if (host.load) head.push(`load ${host.load.map((v) => v.toFixed(2)).join(" ")}`);
	add(labelPart("Host", style), { text: head.join(SEP) });

	if (host.cpuPercent === null) add(labelPart("CPU", style), { text: "…" });
	else {
		const pct = Math.round(host.cpuPercent);
		const blocks = host.corePercents.map((p) => BLOCKS[Math.min(7, Math.max(0, Math.floor(p / 12.5)))]).join("");
		const chunk = Math.max(1, width - LABEL - 1);
		const first = Math.max(1, chunk - `${pct}%`.length - 2);
		add(labelPart("CPU", style), pctPart(pct, style), { text: `  ${blocks.slice(0, first)}` });
		for (let i = first; i < blocks.length; i += chunk) add({ text: " ".repeat(LABEL) }, { text: blocks.slice(i, i + chunk) });
	}

	const mem = host.memory;
	if (mem && mem.totalBytes > 0) {
		const used = Math.max(0, mem.totalBytes - mem.availableBytes);
		const max = host.cgroup.memoryMaxBytes;
		const current = host.cgroup.memoryCurrentBytes;
		const tail = max === null ? "" : `${SEP}cgroup ${current === null ? formatBytes(max) : bytesPair(current, max)}`;
		add(labelPart("Mem", style), pctPart(percent(used, mem.totalBytes), style), { text: `  ${bytesPair(used, mem.totalBytes)}${tail}` });
		if (mem.swapTotalBytes > 0) {
			const swapUsed = Math.max(0, mem.swapTotalBytes - mem.swapFreeBytes);
			add(labelPart("Swap", style), pctPart(percent(swapUsed, mem.swapTotalBytes), style), { text: `  ${bytesPair(swapUsed, mem.swapTotalBytes)}` });
		} else add(labelPart("Swap", style), { text: "none" });
	}

	const { pidsCurrent, pidsMax } = host.cgroup;
	if (pidsMax !== null && pidsCurrent !== null) add(labelPart("Pids", style), pctPart(percent(pidsCurrent, pidsMax), style, `${pidsCurrent}/${pidsMax}`));

	const mount = Math.min(MOUNT_CAP, Math.max(1, ...host.disks.map((disk) => visibleWidth(disk.mount))));
	host.disks.forEach((disk, index) => {
		const pct = percent(disk.usedBytes, disk.totalBytes);
		add(labelPart(index === 0 ? "Disk" : "", style), { text: `${fit(disk.mount, mount)} ` }, pctPart(pct, style, `${pct}%`.padStart(4)), { text: `  ${bytesPair(disk.usedBytes, disk.totalBytes)}` });
	});

	const top = (label: string, kind: string, items: readonly TopProcess[], value: (p: TopProcess) => string): void => {
		if (!items.length) return;
		add(labelPart(label, style), { text: `${kind} ${items.slice(0, 3).map((p) => `${oneLine(p.comm)} ${value(p)}`).join(SEP)}` });
	};
	top("Top", "cpu", host.topCpu, (p) => `${Math.round(p.value)}%`);
	top(host.topCpu.length ? "" : "Top", "mem", host.topMemory, (p) => formatBytes(p.value));

	const processes = `${host.piProcesses} process${host.piProcesses === 1 ? "" : "es"}`;
	add(labelPart("Pi", style), { text: `${processes}${SEP}${liveSessions} live session${liveSessions === 1 ? "" : "s"}` });
	if (host.orphans.length) add(labelPart("Orphan", style), { text: host.orphans.map((group) => `${oneLine(group.comm)} ${group.count}`).join(SEP) });
	return lines.slice(0, Math.max(0, height));
}

// liveSessions keeps the strip's signature aligned with the panel; the strip has room only for the process count.
export function renderHostStrip(host: HostSnapshot | undefined, _liveSessions: number, width: number, style: Style): string {
	if (!host) return collecting(width, style);
	const segments: Part[][] = [];
	if (host.load) segments.push([{ text: `load ${host.load[0].toFixed(1)}/${host.cpuCount}` }]);
	if (host.cpuPercent !== null) segments.push([{ text: "cpu " }, pctPart(Math.round(host.cpuPercent), style)]);
	if (host.memory && host.memory.totalBytes > 0) segments.push([{ text: "mem " }, pctPart(percent(host.memory.totalBytes - host.memory.availableBytes, host.memory.totalBytes), style)]);
	const fullest = host.disks.reduce<Disk | null>((best, disk) => (best === null || percent(disk.usedBytes, disk.totalBytes) > percent(best.usedBytes, best.totalBytes) ? disk : best), null);
	if (fullest) segments.push([{ text: `disk ${oneLine(fullest.mount)} ` }, pctPart(percent(fullest.usedBytes, fullest.totalBytes), style)]);
	segments.push([{ text: `pi ${host.piProcesses}` }]);
	const orphans = host.orphans.reduce((sum, group) => sum + group.count, 0);
	if (orphans > 0) segments.push([{ text: `orphans ${orphans}` }]);
	// Whole segments only: a segment that does not fit ends the strip.
	const parts: Part[] = [];
	let used = 0;
	for (const segment of segments) {
		const need = segment.reduce((sum, part) => sum + visibleWidth(part.text), 0) + (parts.length ? SEP.length : 0);
		if (used + need > width) break;
		if (parts.length) parts.push({ text: SEP });
		parts.push(...segment);
		used += need;
	}
	return line(parts, width);
}
