// Host metrics for the dashboard's host panel. Sources: /proc, cgroup v2 files, and statfs only.
// Rates (CPU percentages) need two samples; the first snapshot after start has them as null or empty.

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
