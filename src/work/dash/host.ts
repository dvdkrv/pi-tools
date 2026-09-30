// Host metrics for the dashboard's host panel. Sources: /proc, cgroup v2 files, and statfs only.
// Rates (CPU percentages) need two samples; the first snapshot after start has them as null or empty.

import { statfsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { cpus, homedir, hostname } from "node:os";

// Cumulative CPU ticks from /proc/stat: index 0 is the "cpu" total line, then one entry per core.
export type CpuTimes = { idle: number; total: number };
// Everything the next collection needs from this one.
export type HostSample = { at: number; cpu: CpuTimes[]; procTicks: Map<number, number> };

export type Disk = { mount: string; usedBytes: number; totalBytes: number };
// value: CPU percent of one core (topCpu) or resident bytes (topMemory).
export type TopProcess = { pid: number; comm: string; value: number };
export type OrphanGroup = { comm: string; count: number };

export type HostSnapshot = {
	hostname: string;
	uptimeSeconds: number | null;
	cpuCount: number;
	load: [number, number, number] | null;
	cpuPercent: number | null;
	corePercents: number[];
	memory: { totalBytes: number; availableBytes: number; swapTotalBytes: number; swapFreeBytes: number } | null;
	// Each field is null when there is no cgroup limit or the file is missing. cpuLimit is in CPUs (quota / period).
	cgroup: { memoryMaxBytes: number | null; memoryCurrentBytes: number | null; cpuLimit: number | null; pidsMax: number | null; pidsCurrent: number | null };
	disks: Disk[];
	topCpu: TopProcess[];
	topMemory: TopProcess[];
	piProcesses: number;
	orphans: OrphanGroup[];
	sample: HostSample;
};

export type StatFs = { bsize: number; blocks: number; bfree: number; bavail: number };
// Every reader turns a failure into undefined (or an empty list) so collection cannot throw.
export type HostReaders = {
	readFile(path: string): Promise<string | undefined>;
	readDir(path: string): Promise<string[]>;
	statfs(path: string): StatFs | undefined;
	hostname(): string;
	home: string;
	now(): number;
	cpuCount(): number;
};
export type Mount = { device: string; mount: string; type: string };
export type ProcStat = { pid: number; ppid: number; comm: string; ticks: number; rssBytes: number };

const safe = <T>(fn: () => T): T | undefined => {
	try {
		return fn();
	} catch {
		return undefined;
	}
};

export function nodeHostReaders(home = homedir()): HostReaders {
	return {
		readFile: (path) => readFile(path, "utf8").catch(() => undefined),
		readDir: (path) => readdir(path).catch(() => []),
		statfs: (path) => safe(() => {
			const s = statfsSync(path);
			return { bsize: Number(s.bsize), blocks: Number(s.blocks), bfree: Number(s.bfree), bavail: Number(s.bavail) };
		}),
		hostname: () => safe(hostname) ?? "",
		home,
		now: Date.now,
		cpuCount: () => safe(() => cpus().length) || 1,
	};
}

const numbers = (text: string): number[] => text.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));

// "cpu" first, then cpu0, cpu1, ...; idle counts iowait as idle, the way top does.
export function parseCpuTimes(text: string): CpuTimes[] {
	const out: CpuTimes[] = [];
	for (const line of text.split("\n")) {
		const match = /^cpu\d*\s+(.+)$/.exec(line);
		const fields = match ? numbers(match[1]!) : [];
		if (fields.length >= 5) out.push({ idle: fields[3]! + fields[4]!, total: fields.reduce((a, b) => a + b, 0) });
	}
	return out;
}

export function cpuPercents(prev: readonly CpuTimes[], cur: readonly CpuTimes[]): number[] {
	return cur.map((now, i) => {
		const before = prev[i];
		const total = before ? now.total - before.total : 0;
		if (!before || total <= 0) return 0;
		return Math.max(0, Math.min(100, ((total - (now.idle - before.idle)) / total) * 100));
	});
}

export const parseLoadavg = (text: string): [number, number, number] | null => {
	const f = numbers(text);
	return f.length >= 3 ? [f[0]!, f[1]!, f[2]!] : null;
};
export const parseUptime = (text: string): number | null => numbers(text)[0] ?? null;

export function parseMeminfo(text: string): HostSnapshot["memory"] {
	const bytes = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)/.exec(line);
		if (match) bytes.set(match[1]!, Number(match[2]) * 1024);
	}
	const total = bytes.get("MemTotal");
	if (total === undefined) return null;
	return { totalBytes: total, availableBytes: bytes.get("MemAvailable") ?? 0, swapTotalBytes: bytes.get("SwapTotal") ?? 0, swapFreeBytes: bytes.get("SwapFree") ?? 0 };
}

// cgroup v2 writes "max" for "no limit", which the panel treats like a missing file.
export function parseCgroupNumber(text: string | undefined): number | null {
	const value = text?.trim();
	const n = value ? Number(value) : Number.NaN;
	return value && value !== "max" && Number.isFinite(n) ? n : null;
}

// cpu.max is "<quota> <period>" in microseconds; the limit is the number of CPUs it allows.
export function parseCpuMax(text: string | undefined): number | null {
	const [quota, period] = (text ?? "").trim().split(/\s+/).map(Number);
	return Number.isFinite(quota) && Number.isFinite(period) && period! > 0 ? quota! / period! : null;
}

// Mount fields escape spaces, tabs, newlines, and backslashes as octal.
const unescapeMount = (field: string): string => field.replace(/\\(040|011|012|134)/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));

export function parseMounts(text: string): Mount[] {
	return text.split("\n").map((line) => line.split(" ")).filter((f) => f.length >= 3 && f[1]).map((f) => ({ device: unescapeMount(f[0]!), mount: unescapeMount(f[1]!), type: f[2]! }));
}

// USER_HZ is 100 ticks per second and the page size is 4096 bytes on the platforms this runs on.
export function parseProcStat(text: string): ProcStat | null {
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	const pid = open > 0 ? Number(text.slice(0, open).trim()) : Number.NaN;
	// rest[0] is field 3 (the state letter), so ppid is rest[1], utime rest[11], stime rest[12], and rss rest[21] in pages.
	const rest = close > open ? text.slice(close + 1).trim().split(/\s+/) : [];
	const [ppid, utime, stime, rss] = [rest[1], rest[11], rest[12], rest[21]].map(Number);
	if (!Number.isFinite(pid) || rest.length < 22 || !Number.isFinite(ppid! + utime! + stime! + rss!)) return null;
	return { pid, ppid: ppid!, comm: text.slice(open + 1, close), ticks: utime! + stime!, rssBytes: rss! * 4096 };
}

const SKIP_FS = new Set("proc sysfs cgroup cgroup2 devpts mqueue securityfs debugfs tracefs fusectl configfs pstore bpf autofs hugetlbfs devtmpfs binfmt_misc nsfs rpc_pipefs ramfs squashfs".split(" "));

// statfs can hang on network and FUSE filesystems, so those never get probed.
function skipMount({ mount, type }: Mount): boolean {
	if (SKIP_FS.has(type) || type.startsWith("fuse") || type.startsWith("nfs") || type.startsWith("smb") || type === "cifs" || type === "9p") return true;
	return type === "tmpfs" && mount !== "/tmp";
}

// One line per filesystem, under its shortest mount point: an overlay root and its bind mounts are one disk.
function collectDisks(mounts: readonly Mount[], readers: HostReaders): Disk[] {
	const byFs = new Map<string, Disk>();
	for (const entry of mounts) {
		if (skipMount(entry)) continue;
		const fs = readers.statfs(entry.mount);
		if (!fs || fs.blocks <= 0) continue;
		const key = `${fs.bsize}:${fs.blocks}:${fs.bfree}`;
		const seen = byFs.get(key);
		if (seen && seen.mount.length <= entry.mount.length) continue;
		const usedBytes = (fs.blocks - fs.bfree) * fs.bsize;
		byFs.set(key, { mount: entry.mount, usedBytes, totalBytes: usedBytes + fs.bavail * fs.bsize });
	}
	const home = readers.home;
	const short = (mount: string): string => (home && (mount === home || mount.startsWith(`${home}/`)) ? `~${mount.slice(home.length)}` : mount);
	return [...byFs.values()].map((disk) => ({ ...disk, mount: short(disk.mount) })).sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, 6);
}

const top3 = (list: readonly TopProcess[]): TopProcess[] => [...list].sort((a, b) => b.value - a.value || a.pid - b.pid).slice(0, 3);

function orphanGroups(procs: readonly ProcStat[]): OrphanGroup[] {
	const counts = new Map<string, number>();
	for (const proc of procs) if (proc.ppid === 1) counts.set(proc.comm, (counts.get(proc.comm) ?? 0) + 1);
	return [...counts].filter(([, count]) => count >= 2).map(([comm, count]) => ({ comm, count })).sort((a, b) => b.count - a.count || a.comm.localeCompare(b.comm)).slice(0, 3);
}

const FILES = ["/proc/stat", "/proc/loadavg", "/proc/uptime", "/proc/meminfo", "/proc/self/mounts", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids.current"];

export async function collectHost(prev: HostSample | undefined, readers: HostReaders = nodeHostReaders()): Promise<HostSnapshot> {
	const at = readers.now();
	const read = (path: string) => readers.readFile(path);
	const [[stat, loadavg, uptime, meminfo, mounts, memMax, memCur, cpuMax, pidsMax, pidsCur], procNames] = await Promise.all([Promise.all(FILES.map(read)), readers.readDir("/proc")]);
	const cpu = parseCpuTimes(stat ?? "");
	const percents = prev && prev.cpu.length > 0 && cpu.length > 0 ? cpuPercents(prev.cpu, cpu) : [];
	// About 25 ms for 2,000 processes; pids that vanish mid-read just drop out.
	const stats = await Promise.all(procNames.filter((name) => /^\d+$/.test(name)).map(async (pid) => parseProcStat((await read(`/proc/${pid}/stat`)) ?? "")));
	const procs = stats.filter((p): p is ProcStat => p !== null);
	const elapsed = prev ? (at - prev.at) / 1000 : 0;
	const topCpu = prev && elapsed > 0
		? top3(procs.flatMap((p) => {
			const before = prev.procTicks.get(p.pid);
			// Ticks are USER_HZ = 100 per second, so one wholly busy core is 100 ticks per second.
			const value = before === undefined ? 0 : ((p.ticks - before) / 100 / elapsed) * 100;
			return value > 0 ? [{ pid: p.pid, comm: p.comm, value }] : [];
		}))
		: [];
	return {
		hostname: readers.hostname(),
		uptimeSeconds: parseUptime(uptime ?? ""),
		cpuCount: cpu.length > 1 ? cpu.length - 1 : readers.cpuCount(),
		load: parseLoadavg(loadavg ?? ""),
		cpuPercent: percents.length > 0 ? percents[0]! : null,
		corePercents: percents.slice(1),
		memory: parseMeminfo(meminfo ?? ""),
		cgroup: { memoryMaxBytes: parseCgroupNumber(memMax), memoryCurrentBytes: parseCgroupNumber(memCur), cpuLimit: parseCpuMax(cpuMax), pidsMax: parseCgroupNumber(pidsMax), pidsCurrent: parseCgroupNumber(pidsCur) },
		disks: collectDisks(parseMounts(mounts ?? ""), readers),
		topCpu,
		topMemory: top3(procs.map((p) => ({ pid: p.pid, comm: p.comm, value: p.rssBytes }))),
		piProcesses: procs.filter((p) => p.comm === "pi").length,
		orphans: orphanGroups(procs),
		sample: { at, cpu, procTicks: new Map(procs.map((p) => [p.pid, p.ticks])) },
	};
}
