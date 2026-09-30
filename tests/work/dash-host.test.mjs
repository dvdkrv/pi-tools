import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const h = await load('src/work/dash/host.ts');

// pid (comm) state ppid ... utime stime ... rss, with rss in 4 KiB pages.
const procStat = (pid, comm, ppid, ticks, rssPages) =>
  `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 100 1000 ${rssPages} 18446744073709551615\n`;

const fakeReaders = (files, state = {}) => ({
  readFile: async (path) => files[path],
  readDir: async () => Object.keys(files).flatMap((p) => /^\/proc\/(\d+)\/stat$/.exec(p)?.slice(1) ?? []),
  statfs: (mount) => (state.fs ?? {})[mount],
  hostname: () => 'box',
  home: '/home/u',
  now: () => state.now ?? 1000,
  cpuCount: () => 4,
});

test('parsers read /proc, cgroup, and mount fixtures', () => {
  const cpu = h.parseCpuTimes('cpu  10 0 5 100 5 0 0 0\ncpu0 5 0 2 50 3 0 0 0\ncpu1 5 0 3 50 2 0 0 0\nintr 1 2\n');
  assert.equal(cpu.length, 3);
  assert.deepEqual(cpu[0], { idle: 105, total: 120 });
  assert.deepEqual(h.cpuPercents(cpu, [{ idle: 155, total: 220 }, cpu[1], cpu[2]]), [50, 0, 0]);
  assert.deepEqual(h.parseLoadavg('0.50 1.00 2.00 1/200 12345\n'), [0.5, 1, 2]);
  assert.equal(h.parseLoadavg(''), null);
  assert.equal(h.parseUptime('1234.56 900.00\n'), 1234.56);
  assert.deepEqual(h.parseMeminfo('MemTotal:  1024 kB\nMemFree: 100 kB\nMemAvailable: 512 kB\nSwapTotal: 2048 kB\nSwapFree: 1024 kB\n'), {
    totalBytes: 1048576, availableBytes: 524288, swapTotalBytes: 2097152, swapFreeBytes: 1048576,
  });
  assert.equal(h.parseMeminfo('Bogus: 1 kB\n'), null);
  assert.equal(h.parseCgroupNumber('max\n'), null);
  assert.equal(h.parseCgroupNumber(undefined), null);
  assert.equal(h.parseCgroupNumber('1048576\n'), 1048576);
  assert.equal(h.parseCpuMax('200000 100000\n'), 2);
  assert.equal(h.parseCpuMax('max 100000\n'), null);
  assert.deepEqual(h.parseMounts('/dev/sda1 /mnt/my\\040disk ext4 rw 0 0\nbad line\n'), [{ device: '/dev/sda1', mount: '/mnt/my disk', type: 'ext4' }]);
  assert.deepEqual(h.parseProcStat(procStat(7, 'tmux: server', 1, 30, 2)), { pid: 7, ppid: 1, comm: 'tmux: server', ticks: 30, rssBytes: 8192 });
  assert.equal(h.parseProcStat(procStat(8, 'a) b', 3, 4, 1)).comm, 'a) b');
  assert.equal(h.parseProcStat('garbage'), null);
});

test('disks skip pseudo and network filesystems, dedupe one filesystem, and shorten home', async () => {
  const mounts = 'overlay / overlay rw 0 0\n/dev/root /var/lib/x ext4 rw 0 0\nproc /proc proc rw 0 0\ntmpfs /run tmpfs rw 0 0\ntmpfs /tmp tmpfs rw 0 0\nhost:/s /mnt/share nfs4 rw 0 0\n/dev/sdb1 /home/u/data ext4 rw 0 0\n';
  const fs = {
    '/': { bsize: 4096, blocks: 100, bfree: 40, bavail: 30 },
    '/var/lib/x': { bsize: 4096, blocks: 100, bfree: 40, bavail: 30 },
    '/tmp': { bsize: 4096, blocks: 50, bfree: 25, bavail: 25 },
    '/run': { bsize: 4096, blocks: 10, bfree: 5, bavail: 5 },
    '/mnt/share': { bsize: 4096, blocks: 9, bfree: 1, bavail: 1 },
    '/home/u/data': { bsize: 4096, blocks: 200, bfree: 100, bavail: 90 },
  };
  const snap = await h.collectHost(undefined, fakeReaders({ '/proc/self/mounts': mounts }, { fs }));
  assert.deepEqual(new Set(snap.disks.map((d) => d.mount)), new Set(['/', '/tmp', '~/data']));
  assert.deepEqual(snap.disks.find((d) => d.mount === '/'), { mount: '/', usedBytes: 245760, totalBytes: 368640 });
});

test('collectHost leaves rates blank on the first call and fills them on the second', async () => {
  const state = { now: 1000 };
  const files = {
    '/proc/stat': 'cpu  10 0 5 100 5 0 0 0\ncpu0 5 0 2 50 3 0 0 0\ncpu1 5 0 3 50 2 0 0 0\n',
    '/proc/loadavg': '1.00 0.50 0.25 1/9 42\n',
    '/proc/uptime': '600.00 100.00\n',
    '/proc/meminfo': 'MemTotal: 1024 kB\nMemAvailable: 512 kB\n',
    '/sys/fs/cgroup/cpu.max': 'max 100000\n',
    '/sys/fs/cgroup/pids.max': '100\n',
    '/proc/100/stat': procStat(100, 'pi', 1, 10, 10),
    '/proc/101/stat': procStat(101, 'tmux: server', 1, 20, 50),
    '/proc/102/stat': procStat(102, 'pi', 1, 5, 20),
  };
  const readers = fakeReaders(files, state);
  const first = await h.collectHost(undefined, readers);
  assert.equal(first.cpuPercent, null);
  assert.deepEqual(first.corePercents, []);
  assert.deepEqual(first.topCpu, []);
  assert.equal(first.cpuCount, 2);
  assert.equal(first.piProcesses, 2);
  assert.deepEqual(first.orphans, [{ comm: 'pi', count: 2 }]);
  assert.deepEqual(first.topMemory.map((p) => p.pid), [101, 102, 100]);
  assert.deepEqual(first.cgroup, { memoryMaxBytes: null, memoryCurrentBytes: null, cpuLimit: null, pidsMax: 100, pidsCurrent: null });

  state.now = 2000;
  files['/proc/stat'] = 'cpu  60 0 5 150 5 0 0 0\ncpu0 30 0 2 75 3 0 0 0\ncpu1 30 0 3 75 2 0 0 0\n';
  files['/proc/100/stat'] = procStat(100, 'pi', 1, 60, 10);
  delete files['/proc/102/stat'];
  const second = await h.collectHost(first.sample, readers);
  assert.equal(Math.round(second.cpuPercent), 50);
  assert.equal(second.corePercents.length, 2);
  assert.deepEqual(second.topCpu, [{ pid: 100, comm: 'pi', value: 50 }]);
  assert.equal(second.sample.at, 2000);
});
