import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIo, clock, load, memoryRuntime, tempDir } from './helpers.mjs';

const { runDash } = await load('src/work/dash/app.ts');
const { plainStyle } = await load('src/work/dash/text.ts');
const { runCli } = await load('src/work/cli.ts');

function fakeTerminal(columns = 100, rows = 30) {
  let input = () => {};
  const t = {
    writes: [],
    stopped: false,
    columns: () => columns,
    rows: () => rows,
    write(data) { t.writes.push(data); },
    onInput(handler) { input = handler; },
    onResize() {},
    start() {},
    stop() { t.stopped = true; },
    send(...keys) { for (const key of keys) input(key); },
    screen() {
      return t.writes.at(-1).replace(/^\x1b\[H/, '').replace(/\x1b\[J$/, '').split('\x1b[K\r\n').map((line) => line.replace(/\x1b\[K$/, '').trimEnd());
    },
  };
  return t;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const PANES = ['%1\t@1\tsap-rfc\tmain\t/src/sap\tnode', '%5\t@5\tshell\tmain\t/home\tzsh'].join('\n');

function tmuxFake(calls) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'list-panes') return PANES;
    if (args[0] === 'new-window') return '@9\t%20\n';
    if (args[0] === 'split-window') return '%21\n';
    return '';
  };
}
const alive = (...pids) => ({ kill: (pid) => { if (!pids.includes(pid)) throw new Error('kill ESRCH'); }, environ: () => undefined });

async function fixture({ restored = true } = {}) {
  const rt = await memoryRuntime({ now: clock() });
  const { store } = rt;
  store.addItem({ project: 'misc', title: 'SAP RFC overview', origin: 'manual' }, 'user');
  store.addItem({ project: 'misc', title: 'Fix login', origin: 'manual' }, 'user');
  const childFile = join(tempDir(), 'child-1.jsonl');
  writeFileSync(childFile, [
    JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: 't', message: { role: 'user', content: 'Implement the parser' } }),
    JSON.stringify({ type: 'message', id: 'b', parentId: 'a', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'Which test runner should I use?' }] } }),
  ].join('\n'));
  const start = (id, fields) => store.startSession({ id, file: `/s/${id}.jsonl`, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession: null, headless: false, ...fields });
  start('live-1', { cwd: '/src/sap', pid: 11, tmuxPane: '%1', tmuxWindow: 'sap-rfc' });
  store.setSessionStatus('live-1', 'needs-me', 'Trim the overview?', 'agent');
  start('child-1', { file: childFile, pid: 13, parentSession: 'live-1', headless: true, name: 'impl-parser' });
  start('dead-1', { cwd: '/src/infra', pid: 12, tmuxPane: '%2', tmuxWindow: 'infra' });
  store.setSessionStatus('dead-1', 'working', '', 'auto');
  if (restored) store.setMeta('restore:boot:boot-1', 'handled');
  return { rt, store };
}

function open(rt, { insideTmux = true, kills = [], run = async () => ({ code: 0, output: 'ok', timedOut: false }) } = {}) {
  const terminal = fakeTerminal();
  const calls = [];
  const ran = [];
  const result = runDash({
    runtime: rt, terminal, tmux: tmuxFake(calls), insideTmux, readers: alive(11, 13), style: plainStyle, refreshMs: 0,
    bootId: () => 'boot-1', fileExists: () => true, kill: (pid, signal) => kills.push([pid, signal]),
    jobs: { run: async (command, ...rest) => { ran.push(command); return run(command, ...rest); }, pidAlive: () => true },
  });
  return { terminal, calls, result, kills, ran };
}
const actions = (calls) => calls.filter((call) => call[0] !== 'list-panes');

test('the dashboard shows parents with their children and jumps to a live session with Enter', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  const screen = d.terminal.screen();
  assert.equal(screen[0], 'Work dashboard');
  assert.equal(screen[1], 'Decisions (1)');
  assert.match(screen[2], /^> needs-me\s+sap-rfc\s+-\s+0s\s+"Trim the overview\?"$/);
  assert.match(screen[3], /^ {4}needs-me\s+impl-parser\s+-\s+0s\s+"new session"$/);
  assert.ok(screen.includes('Other sessions (1)'));
  assert.match(screen.find((line) => line.includes('crashed')), /infra/);
  d.terminal.send('\r');
  assert.deepEqual(await d.result, {});
  assert.deepEqual(actions(d.calls), [['switch-client', '-t', '%1'], ['select-window', '-t', '%1'], ['select-pane', '-t', '%1']]);
  assert.equal(d.terminal.stopped, true);
});

test('outside tmux, Enter prints the tmux command instead', async () => {
  const { rt } = await fixture();
  const d = open(rt, { insideTmux: false });
  d.terminal.send('\r');
  assert.deepEqual(await d.result, { print: "tmux attach-session -t '%1' \\; select-window -t '%1' \\; select-pane -t '%1'" });
});

test('Enter on a crashed session reopens it with the restore rules, then jumps', async () => {
  const { rt, store } = await fixture();
  const d = open(rt);
  d.terminal.send('G', '\r');
  assert.deepEqual(await d.result, {});
  assert.deepEqual(actions(d.calls), [
    ['new-window', '-d', '-P', '-F', '#{window_id}\t#{pane_id}', '-n', 'infra', '-c', '/src/infra', "pi --session '/s/dead-1.jsonl'"],
    ['switch-client', '-t', '%20'], ['select-window', '-t', '%20'], ['select-pane', '-t', '%20'],
  ]);
  assert.equal(store.getSession('dead-1').restoredFrom, 12);
});

test('Enter on a child opens its read-only transcript, and any key returns', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('j', '\r');
  await tick();
  const screen = d.terminal.screen();
  assert.equal(screen[0], 'Transcript: impl-parser (read-only)');
  assert.ok(screen.includes('  Implement the parser'));
  assert.ok(screen.includes('  Which test runner should I use?'));
  d.terminal.send('q');
  assert.equal(d.terminal.screen()[0], 'Work dashboard');
  await tick();
  d.terminal.send('q');
  await d.result;
});

test('x then y stops a running child with SIGTERM; x on a top-level session is refused', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('x');
  assert.equal(d.terminal.screen().at(-1), 'x stops only running child agents');
  d.terminal.send('j', 'x');
  assert.match(d.terminal.screen().at(-1), /^Stop this child agent with SIGTERM\? y to confirm/);
  d.terminal.send('y');
  await tick();
  assert.deepEqual(d.kills, [[13, 'SIGTERM']]);
  assert.equal(d.terminal.screen().at(-1), 'Sent SIGTERM to impl-parser');
  d.terminal.send('x', 'n');
  assert.equal(d.terminal.screen().at(-1), 'Cancelled');
  assert.equal(d.kills.length, 1);
  d.terminal.send('q');
  await d.result;
});

test('L links the selected session through the fuzzy picker', async () => {
  const { rt, store } = await fixture();
  const d = open(rt);
  d.terminal.send('L');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Link session to item');
  d.terminal.send('f', 'i', 'x', '\r');
  await tick();
  assert.equal(store.sessionLink('live-1').itemId, 'W-2');
  assert.deepEqual(store.sessionLink('live-1').state, { via: 'manual' });
  assert.equal(store.listEvents().at(-1).actor, 'user');
  assert.match(d.terminal.screen()[2], /sap-rfc\s+W-2/);
  assert.equal(d.terminal.screen().at(-1), 'Linked to W-2');
  d.terminal.send('q');
  await d.result;
});

test('D then y deletes a crashed session record; D on a live session is refused', async () => {
  const { rt, store } = await fixture();
  const d = open(rt);
  d.terminal.send('D');
  assert.equal(d.terminal.screen().at(-1), 'D deletes only closed or crashed sessions');
  d.terminal.send('G', 'D', 'y');
  await tick();
  assert.equal(store.getSession('dead-1'), undefined);
  assert.equal(d.terminal.screen().at(-1), 'Session record deleted');
  d.terminal.send('q');
  await d.result;
});

test('the filter hides rows as you type and Esc clears it', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('/', 'i', 'n', 'f', 'r', 'a');
  let screen = d.terminal.screen();
  assert.equal(screen[0], 'Work dashboard  /infra_');
  assert.equal(screen.some((line) => line.includes('sap-rfc')), false);
  assert.match(screen.find((line) => line.startsWith('> ')), /crashed\s+infra/);
  d.terminal.send('\x1b');
  screen = d.terminal.screen();
  assert.equal(screen[0], 'Work dashboard');
  assert.ok(screen.some((line) => line.includes('sap-rfc')));
  d.terminal.send('q');
  await d.result;
});

test('? shows the help and any key returns', async () => {
  const { rt } = await fixture();
  const d = open(rt);
  d.terminal.send('?');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Keys');
  assert.ok(d.terminal.screen().some((line) => line.includes('x then y')));
  d.terminal.send('z');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Work dashboard');
  d.terminal.send('q');
  await d.result;
});

test('the triage line opens triage, and dismissing the last candidate returns to the dashboard', async () => {
  const { rt, store } = await fixture();
  store.addCandidate({ kind: 'new-item', source: 'github', dedupeKey: 'k1', title: 'Review example-org/api#9', reason: 'Review requested' }, 'sync:github');
  const d = open(rt);
  assert.ok(d.terminal.screen().includes('  triage     1 pending candidate'));
  d.terminal.send('j', 'j', '\r');
  await tick();
  assert.equal(d.terminal.screen()[0], 'Triage (1 open)');
  d.terminal.send('d');
  await tick();
  assert.equal(store.isDismissed('k1'), true);
  assert.equal(d.terminal.screen()[0], 'Work dashboard');
  assert.equal(d.terminal.screen().at(-1), 'Triage inbox is empty');
  d.terminal.send('q');
  await d.result;
});

test('opening the dashboard restores crashed sessions once per boot', async () => {
  const { rt } = await fixture({ restored: false });
  const first = open(rt);
  assert.equal(first.terminal.screen().at(-1), 'Restored 1 crashed session');
  assert.ok(actions(first.calls).some((call) => call[0] === 'new-window'));
  first.terminal.send('q');
  await first.result;
  const second = open(rt);
  assert.equal(actions(second.calls).length, 0);
  second.terminal.send('q');
  await second.result;
});

test('work dash runs through the CLI and prints jump commands outside tmux', async () => {
  const { rt } = await fixture();
  const io = captureIo();
  const terminal = fakeTerminal();
  const code = runCli(['dash'], { runtime: () => rt, io: io.io, cwd: '/tmp', env: {}, tmux: tmuxFake([]), readers: alive(11, 13), bootId: () => 'boot-1', terminal });
  await tick();
  terminal.send('\r');
  assert.equal(await code, 0);
  assert.deepEqual(io.out, ["tmux attach-session -t '%1' \\; select-window -t '%1' \\; select-pane -t '%1'"]);
});

async function jobFixture() {
  const { rt, store } = await fixture();
  store.registerJob({ name: 'dev-server', kind: 'process', cwd: '/src/api', pid: 4242, checkCommand: 'curl -fs localhost:8080', stopCommand: 'kill-dev', ownerSession: 'live-1' }, 'agent:live-1');
  store.recordJobCheck('J-1', 'unhealthy', 'connection refused');
  store.registerJob({ name: 'old-sync', kind: 'cron', cwd: '/srv' }, 'user');
  store.recordJobCheck('J-2', 'healthy', 'ok');
  store.markJobStopped('J-2', 'user');
  return { rt, store };
}

test('an unhealthy job is a decision, and Enter shows its details', async () => {
  const { rt } = await jobFixture();
  const d = open(rt);
  assert.match(d.terminal.screen()[4], /^ {2}unhealthy\s+dev-server\s+process\s+0s\s+connection refused$/);
  d.terminal.send('j', 'j', '\r');
  await tick();
  const screen = d.terminal.screen();
  assert.equal(screen[0], 'Job J-1');
  assert.ok(screen.includes('check: curl -fs localhost:8080'));
  assert.ok(screen.includes('registered by: session live-1 (window sap-rfc)'));
  assert.deepEqual(d.ran, []);
  d.terminal.send('q');
  await tick();
  d.terminal.send('q');
  await d.result;
});

test('c checks the selected job in the background', async () => {
  const { rt, store } = await jobFixture();
  const d = open(rt, { run: async () => ({ code: 0, output: 'up\n', timedOut: false }) });
  d.terminal.send('j', 'j', 'j', 'c');
  await tick();
  await tick();
  assert.deepEqual(d.ran, ['curl -fs localhost:8080']);
  assert.equal(store.getJob('J-1').lastCheckStatus, 'healthy');
  assert.equal(d.terminal.screen().at(-1), 'J-1 healthy: up');
  assert.equal(d.terminal.screen().some((line) => line.startsWith('  unhealthy')), false);
  d.terminal.send('q');
  await d.result;
});

test('x then y stops a job with its stop command; D then y deletes only stopped jobs', async () => {
  const { rt, store } = await jobFixture();
  const d = open(rt);
  d.terminal.send('j', 'j', 'j', 'D');
  assert.equal(d.terminal.screen().at(-1), 'Stop the job before deleting it');
  d.terminal.send('x');
  assert.match(d.terminal.screen().at(-1), /^Stop J-1 dev-server\? y to confirm/);
  d.terminal.send('y');
  await tick();
  assert.deepEqual(d.ran, ['kill-dev']);
  assert.ok(store.getJob('J-1').stoppedAt);
  assert.equal(d.terminal.screen().at(-1), 'Stopped J-1 dev-server');
  d.terminal.send('G', 'k', 'D', 'y');
  await tick();
  assert.equal(store.getJob('J-2'), undefined);
  d.terminal.send('q');
  await d.result;
});

test('opening the dashboard checks stale jobs in the background', async () => {
  const { rt, store } = await jobFixture();
  rt.store.clock.advance?.(61_000);
  const d = open(rt, { run: async () => ({ code: 7, output: 'still down', timedOut: false }) });
  await tick();
  await tick();
  assert.deepEqual(d.ran, ['curl -fs localhost:8080']);
  assert.equal(store.getJob('J-1').lastCheckOutput, 'still down');
  d.terminal.send('q');
  await d.result;
});
