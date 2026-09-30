import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { renderHostPanel, renderHostStrip, formatBytes } = await load('src/work/dash/host-view.ts');
const { plainStyle, ansiStyle, visibleWidth } = await load('src/work/dash/text.ts');

const G = 1024 ** 3;
const cores = [30, 4, 2, 15, 1, 3, 90, 2, 1, 0, 6, 14, 2, 1, 3, 1];
const host = (overrides = {}) => ({
  hostname: 'box', uptimeSeconds: 172 * 86_400 + 3600, cpuCount: 16, load: [4.52, 3.91, 4.02],
  cpuPercent: 28.4, corePercents: cores,
  memory: { totalBytes: 60.1 * G, availableBytes: 37 * G, swapTotalBytes: 8 * G, swapFreeBytes: 7 * G },
  cgroup: { memoryMaxBytes: null, memoryCurrentBytes: null, cpuLimit: null, pidsMax: 4096, pidsCurrent: 312 },
  disks: [{ mount: '/', usedBytes: 366 * G, totalBytes: 416 * G }, { mount: '/home/u/data', usedBytes: 97 * G, totalBytes: 100 * G }],
  topCpu: [{ pid: 2, comm: 'java', value: 31.4 }, { pid: 3, comm: 'pi', value: 8 }, { pid: 4, comm: 'pi', value: 1.2 }],
  topMemory: [{ pid: 2, comm: 'java', value: 4.2 * G }, { pid: 3, comm: 'pi', value: 568 * 1024 * 1024 }],
  piProcesses: 11, orphans: [{ comm: 'dbus-daemon', count: 2192 }, { comm: 'ssh', count: 2 }],
  sample: { at: 0, cpu: [], procTicks: new Map() },
  ...overrides,
});
const trimmed = (lines) => lines.map((line) => line.trimEnd());

test('formatBytes uses 1024 units, one decimal below 100', () => {
  assert.equal(formatBytes(23.1 * G), '23.1G');
  assert.equal(formatBytes(568 * 1024 * 1024), '568M');
  assert.equal(formatBytes(4096), '4.0K');
  assert.equal(formatBytes(512), '512B');
});

test('panel renders host, cpu, memory, disks, top, pi, and orphan lines at width 52', () => {
  assert.deepEqual(trimmed(renderHostPanel(host(), 9, 52, 20, plainStyle)), [
    'Host   up 172d · 16 cpu · load 4.52 3.91 4.02',
    'CPU    28%  ▃▁▁▂▁▁▇▁▁▁▁▂▁▁▁▁',
    'Mem    38%  23.1/60.1G',
    'Swap   13%  1.0/8.0G',
    'Pids   312/4096',
    'Disk   /             88%  366/416G',
    '       /home/u/data  97%  97.0/100G',
    'Top    cpu java 31% · pi 8% · pi 1%',
    '       mem java 4.2G · pi 568M',
    'Pi     11 processes · 9 live sessions',
    'Orphan dbus-daemon 2192 · ssh 2',
  ]);
});

test('cgroup limits and swapless memory show, missing memory drops its lines', () => {
  const limited = renderHostPanel(host({
    cgroup: { memoryMaxBytes: 60.1 * G, memoryCurrentBytes: 23.1 * G, cpuLimit: 2, pidsMax: null, pidsCurrent: null },
    memory: { totalBytes: 60.1 * G, availableBytes: 37 * G, swapTotalBytes: 0, swapFreeBytes: 0 },
  }), 9, 52, 20, plainStyle);
  assert.match(limited[0], /· limit 2 cpu ·/);
  assert.equal(trimmed(limited)[2], 'Mem    38%  23.1/60.1G · cgroup 23.1/60.1G');
  assert.equal(trimmed(limited)[3], 'Swap   none');
  assert.equal(limited.some((line) => line.startsWith('Pids')), false);

  const bare = trimmed(renderHostPanel(host({ memory: null, disks: [], topCpu: [], topMemory: [], orphans: [] }), 1, 52, 20, plainStyle));
  assert.deepEqual(bare.filter((line) => /^(Mem|Swap|Disk|Top)/.test(line)), []);
  assert.equal(bare.at(-1), 'Pi     11 processes · 1 live session');
});

test('the first sample leaves cpu blank and the missing host renders one collecting line', () => {
  const first = renderHostPanel(host({ cpuPercent: null, corePercents: [] }), 9, 52, 20, plainStyle);
  assert.equal(trimmed(first)[1], 'CPU    …');
  assert.deepEqual(renderHostPanel(undefined, 9, 52, 20, plainStyle), ['Host   collecting…']);
  assert.equal(renderHostStrip(undefined, 9, 80, plainStyle), 'Host   collecting…');
});

test('the strip joins segments, omits missing data, and drops trailing segments that do not fit', () => {
  const full = renderHostStrip(host({ disks: [{ mount: '/', usedBytes: 89 * G, totalBytes: 100 * G }] }), 9, 80, plainStyle);
  assert.equal(full, 'load 4.5/16 · cpu 28% · mem 38% · disk / 89% · pi 11 · orphans 2194');
  assert.equal(renderHostStrip(host({ load: null, cpuPercent: null, memory: null, orphans: [] }), 9, 80, plainStyle), 'disk /home/u/data 97% · pi 11');
  const narrow = renderHostStrip(host(), 9, 34, plainStyle);
  assert.equal(narrow, 'load 4.5/16 · cpu 28% · mem 38%');
  assert.ok(visibleWidth(narrow) <= 34);
});

test('percentages turn yellow at 80 and red at 95, labels are dim', () => {
  const lines = renderHostPanel(host({ disks: [{ mount: '/', usedBytes: 89 * G, totalBytes: 100 * G }, { mount: '/var', usedBytes: 97 * G, totalBytes: 100 * G }] }), 9, 52, 20, ansiStyle);
  const disks = lines.filter((line) => line.includes('/100G'));
  assert.ok(disks[0].includes('\x1b[33m 89%\x1b[39m'));
  assert.ok(disks[1].includes('\x1b[31m 97%\x1b[39m'));
  assert.ok(lines[0].startsWith('\x1b[2mHost  \x1b[22m'));
  assert.ok(lines[2].includes('38%') && !lines[2].includes('\x1b[33m38%'));
  assert.ok(renderHostStrip(host({ cpuPercent: 96 }), 9, 80, ansiStyle).includes('cpu \x1b[31m96%\x1b[39m'));
});

test('every line fits the width and height caps the panel', () => {
  for (const width of [40, 52]) {
    for (const line of renderHostPanel(host(), 9, width, 20, plainStyle)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    for (const line of renderHostPanel(host(), 9, width, 20, ansiStyle)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  assert.equal(renderHostPanel(host(), 9, 40, 3, plainStyle).length, 3);
  const wrapped = trimmed(renderHostPanel(host(), 9, 24, 20, plainStyle));
  assert.equal(wrapped[1], 'CPU    28%  ▃▁▁▂▁▁▇▁▁▁▁▂');
  assert.equal(wrapped[2], '      ▁▁▁▁');
});
