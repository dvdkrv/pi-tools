import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIo, clock, load, memoryRuntime } from './helpers.mjs';

const { runCli } = await load('src/work/cli.ts');

test('work usage summarizes response times, triage, planning, the dashboard, and commands', async () => {
  const now = clock('2026-08-16T09:00:00.000Z');
  const rt = await memoryRuntime({ now });
  const record = (surface, action, context = {}) => rt.store.recordUsage(surface, action, context);
  record('cli', 'ancient');
  now.set('2026-09-25T09:00:00.000Z');
  for (const seconds of [60, 1800, 300]) record('pi', 'session.responded', { seconds });
  record('triage', 'accept', { source: 'github', kind: 'new-item' });
  record('triage', 'dismiss', { source: 'github', kind: 'new-item' });
  record('triage', 'dismiss', { source: 'agent', kind: 'new-item' });
  record('planner', 'save', { focus: 2, prev_focus: 4, followed: 3 });
  record('planner', 'save', { focus: 3, prev_focus: 2, followed: 1 });
  record('dash', 'open');
  record('dash', 'open');
  record('dash', 'jump');
  record('dash', 'filter');
  record('cli', 'add');
  record('cli', 'add');
  record('cli', 'list');
  record('pi', 'todo');
  const io = captureIo();
  const code = await runCli(['usage', '--days', '30'], { runtime: () => rt, io: io.io, cwd: '/tmp', env: {} });
  assert.equal(code, 0);
  assert.equal(io.out[0], [
    '## Work usage, last 30 days',
    '',
    '16 usage rows. No content is recorded.',
    '',
    '### Time in needs-me',
    '- 3 responses; median 5m; 90th percentile 30m',
    '',
    '### Triage outcomes',
    '| source | accept | dismiss |',
    '| --- | --- | --- |',
    '| agent | 0 | 1 |',
    '| github | 1 | 1 |',
    '',
    '### Planner follow-through',
    '- 2 plans saved; 4 of 6 previous focus items had activity or were done by the next plan (67%)',
    '',
    '### Dashboard',
    '- 2 opens (0.1 per day); 1 jump (50% of opens)',
    '- unused in this window: reopen, transcript, link, check, stop, delete, triage, details, refresh, help',
    '',
    '### Commands',
    '- cli: add 2, list 1',
    '- pi: todo 1',
  ].join('\n'));
  const bad = await runCli(['usage', '--days', '0'], { runtime: () => rt, io: captureIo().io, cwd: '/tmp', env: {} });
  assert.equal(bad, 1);
});
