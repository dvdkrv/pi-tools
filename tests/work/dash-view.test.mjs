import test from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryStore } from './helpers.mjs';

const { buildDashModel, loadSessions } = await load('src/work/dash/model.ts');
const { renderDash, hintsFor } = await load('src/work/dash/view.ts');
const { formatChildRun, renderResult } = await load('src/work/children/format.ts');
const { DEFAULT_CHILDREN } = await load('src/work/config.ts');
const { plainStyle, ansiStyle } = await load('src/work/dash/text.ts');

const NOW = new Date('2026-09-25T09:00:00.000Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const entry = (overrides) => ({
  id: 'x', file: null, cwd: '/src/x', name: null, pid: 1, tmuxPane: '%1', tmuxWindow: null, startedAt: ago(600), lastTurnAt: ago(10), endedAt: null,
  status: 'working', note: '', statusSource: 'auto', statusAt: ago(0), restoredFrom: null, parentSession: null, headless: false,
  liveness: 'live', alive: true, itemId: null, itemTitle: null, ...overrides,
});
const SESSIONS = [
  entry({ id: 'd1', tmuxWindow: 'sap-rfc', status: 'needs-me', statusAt: ago(12), note: 'Trim the overview to 1.5k words?', itemId: 'W-7', itemTitle: 'SAP RFC connector overview' }),
  entry({ id: 'c1', parentSession: 'd1', headless: true, tmuxPane: null, name: 'impl-auth', status: 'needs-me', statusAt: ago(3), lastTurnAt: ago(3), note: 'Which test runner?' }),
  entry({ id: 'd2', tmuxWindow: 'payments-api', status: 'needs-me', statusAt: ago(2), name: 'Fix flaky test' }),
  entry({ id: 'w1', tmuxWindow: 'web', status: 'waiting-external', statusAt: ago(180), note: 'CI run for PR 42', itemId: 'W-3', itemTitle: 'Launch checklist' }),
  entry({ id: 'o1', tmuxWindow: 'docs', status: 'done', statusAt: ago(120), note: 'Published the guide', itemId: 'W-2', itemTitle: 'Docs refresh' }),
  entry({ id: 'o2', tmuxWindow: 'infra', status: 'needs-me', liveness: 'crashed', alive: false, lastTurnAt: ago(1440), note: 'Which region first?' }),
  entry({ id: 'o3', cwd: '/src/old-tool', liveness: 'closed', alive: false, endedAt: ago(1200), lastTurnAt: ago(1200) }),
  entry({ id: 'o4', tmuxWindow: 'ancient', liveness: 'closed', alive: false, endedAt: ago(11520), lastTurnAt: ago(11520) }),
];
const model = () => buildDashModel({ sessions: SESSIONS, triageCount: 3, now: NOW });
const state = (overrides = {}) => ({ selected: 'session:d1', filter: '', editing: false, message: '', ...overrides });
const plain = (lines) => lines.map((line) => line.trimEnd());
const TAIL = 'j/k move · / filter · ? all keys · q quit';
const hints = (...parts) => [...parts, TAIL].join(' · ');
const LIVE_HINTS = hints('enter jump', 'L link');
const ENDED_HINTS = hints('enter reopen', 'L link', 'D delete');
const G = 1024 ** 3;
const HOST = {
  hostname: 'devbox', uptimeSeconds: 172 * 86_400, cpuCount: 16, load: [4.52, 3.91, 4.02], cpuPercent: 28.4,
  corePercents: [30, 4, 2, 15, 1, 3, 90, 2, 1, 0, 6, 14, 2, 1, 3, 1],
  memory: { totalBytes: 60.1 * G, availableBytes: 37 * G, swapTotalBytes: 8 * G, swapFreeBytes: 7 * G },
  cgroup: { memoryMaxBytes: null, memoryCurrentBytes: null, cpuLimit: null, pidsMax: 4096, pidsCurrent: 312 },
  disks: [{ mount: '/', usedBytes: 366 * G, totalBytes: 416 * G }, { mount: '/home/u/data', usedBytes: 97 * G, totalBytes: 100 * G }],
  topCpu: [{ pid: 2, comm: 'java', value: 31.4 }], topMemory: [{ pid: 2, comm: 'java', value: 4.2 * G }],
  piProcesses: 11, orphans: [{ comm: 'ssh', count: 2 }], sample: { at: 0, cpu: [], procTicks: new Map() },
};

test('sections order sessions, nest children under their parent, and drop old ended sessions', () => {
  const m = model();
  assert.deepEqual(m.sections.map((s) => s.id), ['decisions', 'waiting', 'working', 'jobs', 'messages', 'other']);
  assert.deepEqual(m.sections[0].rows.map((r) => r.key), ['session:d1', 'session:c1', 'session:d2', 'triage']);
  assert.equal(m.sections[0].rows[1].depth, 1);
  assert.deepEqual(m.sections[1].rows.map((r) => r.key), ['session:w1']);
  assert.deepEqual(m.sections[2].rows, []);
  assert.deepEqual(m.sections[3].rows, []);
  assert.deepEqual(m.sections[5].rows.map((r) => r.key), ['session:o1', 'session:o3', 'session:o2']);
  assert.equal(buildDashModel({ sessions: SESSIONS, triageCount: 0, now: NOW }).sections[0].rows.some((r) => r.kind === 'triage'), false);
});

test('never-turned automatic sessions leave Decisions and display idle without their legacy note', () => {
  const sessions = [
    entry({ id: 'fresh', tmuxWindow: 'pi', lastTurnAt: null, status: 'needs-me', note: '' }),
    entry({ id: 'legacy', tmuxWindow: 'bash', lastTurnAt: null, status: 'needs-me', note: 'new session' }),
  ];
  const m = buildDashModel({ sessions, triageCount: 0, now: NOW });
  assert.deepEqual(m.sections[0].rows, []);
  assert.deepEqual(m.sections[5].rows.map((r) => r.key), ['session:fresh', 'session:legacy']);
  const lines = plain(renderDash(m, state({ selected: null }), 80, 20, plainStyle));
  assert.ok(lines.some((line) => /^ {2}idle\s+x\s+-\s+0s$/.test(line)), lines.join('\n'));
  assert.equal(lines.some((line) => line.includes('new session')), false);
});

test('a live child follows its parent into any section, and a live orphan is listed under Other sessions', () => {
  const m = buildDashModel({
    now: NOW,
    triageCount: 0,
    sessions: [
      entry({ id: 'p', tmuxWindow: 'api', status: 'waiting-external' }),
      entry({ id: 'k', parentSession: 'p', headless: true, tmuxPane: null, status: 'needs-me' }),
      entry({ id: 'lost', parentSession: 'gone', headless: true, tmuxPane: null, status: 'needs-me' }),
    ],
  });
  assert.deepEqual(m.sections[0].rows, []);
  assert.deepEqual(m.sections[1].rows.map((r) => [r.key, r.depth]), [['session:p', 0], ['session:k', 1]]);
  assert.deepEqual(m.sections[5].rows.map((r) => [r.key, r.depth]), [['session:lost', 0]]);
});

test('ended children fold under a shown lead after its live children', () => {
  const sessions = [
    entry({ id: 'p', tmuxWindow: 'api', status: 'working', note: 'marker' }),
    entry({ id: 'live-1', parentSession: 'p', headless: true, tmuxPane: null }),
    entry({ id: 'ended-1', parentSession: 'p', headless: true, tmuxPane: null, liveness: 'closed', alive: false }),
    entry({ id: 'live-2', parentSession: 'p', headless: true, tmuxPane: null }),
    entry({ id: 'ended-2', parentSession: 'p', headless: true, tmuxPane: null, liveness: 'crashed', alive: false }),
    entry({ id: 'ended-3', parentSession: 'p', headless: true, tmuxPane: null, liveness: 'closed', alive: false }),
  ];
  const m = buildDashModel({ sessions, triageCount: 0, now: NOW });
  assert.deepEqual(m.sections[2].rows.map((r) => [r.kind, r.key, r.depth, r.count]), [
    ['session', 'session:p', 0, undefined],
    ['session', 'session:live-1', 1, undefined],
    ['session', 'session:live-2', 1, undefined],
    ['ended', 'ended:p', 1, 3],
  ]);
  for (const width of [80, 120]) {
    const frame = plain(renderDash(m, state({ selected: null }), width, 24, plainStyle));
    const parent = frame.find((line) => line.includes('"marker"'));
    const fold = frame.find((line) => line.includes('+3 ended child sessions'));
    assert.equal(fold.indexOf('+3 ended child sessions'), parent.indexOf('"marker"'), frame.join('\n'));
  }
  const lines = plain(renderDash(m, state({ selected: 'ended:p', filter: 'child sessions' }), 80, 24, plainStyle));
  assert.equal(lines.find((line) => line.startsWith('> ')), '> ended                              +3 ended child sessions');
});

test('ended orphans from different missing leads share one fold while live orphans stay listed', () => {
  const sessions = [
    entry({ id: 'live', parentSession: 'missing-a', headless: true, tmuxPane: null }),
    entry({ id: 'ended-a', parentSession: 'missing-a', headless: true, tmuxPane: null, liveness: 'closed', alive: false }),
    entry({ id: 'ended-b', parentSession: 'missing-b', headless: true, tmuxPane: null, liveness: 'crashed', alive: false }),
  ];
  const other = buildDashModel({ sessions, triageCount: 0, now: NOW }).sections[5].rows;
  assert.deepEqual(other.map((r) => [r.kind, r.key, r.depth, r.count]), [
    ['session', 'session:live', 0, undefined],
    ['ended', 'ended:orphans', 0, 2],
  ]);
});

test('Other sessions folds top-level sessions older than 24 hours but a filter reveals them', () => {
  const m = buildDashModel({
    now: NOW,
    triageCount: 0,
    sessions: [
      entry({ id: 'recent', tmuxWindow: 'recent', liveness: 'closed', alive: false, lastTurnAt: ago(60), note: 'marker' }),
      entry({ id: 'old', tmuxWindow: 'old-api', liveness: 'closed', alive: false, lastTurnAt: ago(1500) }),
      entry({ id: 'old-child', parentSession: 'old', headless: true, tmuxPane: null, liveness: 'closed', alive: false, lastTurnAt: ago(1490) }),
      entry({ id: 'live-old', tmuxWindow: 'still-live', status: 'done', lastTurnAt: ago(3000) }),
    ],
  });
  assert.deepEqual(m.sections[5].rows.map((r) => [r.kind, r.key, r.count]), [
    ['session', 'session:live-old', undefined],
    ['session', 'session:recent', undefined],
    ['older', 'older', 1],
  ]);
  for (const width of [80, 120]) {
    const lines = plain(renderDash(m, state({ selected: null }), width, 20, plainStyle));
    const recent = lines.find((line) => line.includes('recent'));
    const fold = lines.find((line) => line.includes('+1 older'));
    assert.equal(fold.indexOf('+1 older'), recent.indexOf('"marker"'), lines.join('\n'));
  }
  const filtered = plain(renderDash(m, state({ selected: null, filter: 'old-api' }), 80, 20, plainStyle));
  assert.ok(filtered.some((line) => line.includes('old-api')), filtered.join('\n'));
  assert.equal(filtered.some((line) => line.includes('+1 older')), false);
});

test('top-level rows prefer repository names for default windows and strip Markdown from notes', () => {
  const m = buildDashModel({
    now: NOW,
    triageCount: 0,
    sessions: [entry({ id: 'repo', tmuxWindow: 'pi', repo: 'payments-api', status: 'needs-me', note: '**Merge** [PR 12](https://x/12)?' })],
  });
  const line = plain(renderDash(m, state({ selected: null }), 100, 20, plainStyle))[2];
  assert.match(line, /needs-me\s+payments-api\s+-\s+0s\s+"Merge PR 12\?"$/);
});

test('an 80-column frame', () => {
  assert.deepEqual(plain(renderDash(model(), state(), 80, 24, plainStyle)), [
    'Work dashboard',
    'Decisions (3)',
    '> needs-me   sap-rfc       W-7  12m  "Trim the overview to 1.5k words?"',
    '  needs-me     impl-auth   -     3m  "Which test runner?"',
    '  needs-me   payments-api  -     2m  Fix flaky test',
    '  triage     3 pending candidates',
    'Waiting (1)',
    '  waiting    web           W-3   3h  "CI run for PR 42"',
    'Other sessions (3)',
    '  done       docs          W-2   2h  "Published the guide"',
    '  closed     old-tool      -    20h',
    '  crashed    infra         -    24h  "Which region first?"',
    LIVE_HINTS,
    '',
  ]);
});

test('a 160-column frame shows item titles', () => {
  assert.deepEqual(plain(renderDash(model(), state(), 160, 24, plainStyle)), [
    'Work dashboard',
    'Decisions (3)',
    '> needs-me   sap-rfc       W-7 SAP RFC connector overview  12m  "Trim the overview to 1.5k words?"',
    '  needs-me     impl-auth   -                                3m  "Which test runner?"',
    '  needs-me   payments-api  -                                2m  Fix flaky test',
    '  triage     3 pending candidates',
    'Waiting (1)',
    '  waiting    web           W-3 Launch checklist             3h  "CI run for PR 42"',
    'Other sessions (3)',
    '  done       docs          W-2 Docs refresh                 2h  "Published the guide"',
    '  closed     old-tool      -                               20h',
    '  crashed    infra         -                               24h  "Which region first?"',
    LIVE_HINTS,
    '',
  ]);
});

test('with a host, a wide frame adds the side panel and a narrow one a strip under the header', () => {
  const wide = plain(renderDash(model(), state(), 160, 24, plainStyle, HOST));
  assert.equal(wide[0], 'Work dashboard · devbox');
  assert.equal(wide[1], 'Decisions (3)'.padEnd(105) + ' │ Host   up 172d · 16 cpu · load 4.52 3.91 4.02');
  assert.match(wide[2], /^> needs-me {3}sap-rfc .* {2}│ CPU {4}28% {2}▃▁▁▂▁▁█▁▁▁▁▂▁▁▁▁$/);
  assert.equal(wide.at(-3), '  crashed    infra         -                               24h  "Which region first?"'.padEnd(105) + ' │ Orphan ssh 2');
  assert.ok(wide.some((line) => line.includes('│ Pi     11 processes · 5 live sessions')));
  assert.equal(wide.at(-2), LIVE_HINTS);
  const short = plain(renderDash(model(), state(), 160, 24, plainStyle, { ...HOST, topCpu: [], topMemory: [], orphans: [] }));
  assert.ok(short.slice(1, -2).every((line) => line.includes(' │')), 'the separator runs past a shorter panel');

  const narrow = plain(renderDash(model(), state({ refreshedAt: new Date(2026, 8, 25, 9, 4, 5), stale: true }), 80, 24, plainStyle, HOST));
  assert.match(narrow[0], /^Work dashboard · devbox · \d\d:\d\d:\d\d · stale$/);
  assert.equal(narrow[1], 'load 4.5/16 · cpu 28% · mem 38% · disk /home/u/data 97% · pi 11 · orphans 2');
  assert.equal(narrow[2], 'Decisions (3)');
  assert.equal(narrow.length, 15);
});

test('ANSI styling highlights the selection, colors crashed rows, and colors only a status word', () => {
  const lines = renderDash(model(), state(), 80, 24, ansiStyle);
  assert.ok(lines[2].startsWith('\x1b[7m> needs-me'));
  assert.ok(lines[11].startsWith('\x1b[31m  crashed'));
  assert.equal(lines[3], '  \x1b[33mneeds-me\x1b[39m     impl-auth   -     3m  "Which test runner?"');
  assert.equal(lines[7], '  \x1b[36mwaiting\x1b[39m    web           W-3   3h  "CI run for PR 42"');
  assert.ok(lines.every((line) => !line.includes('\n')));
});

test('the filter hides non-matching rows, matches item titles at any width, and shows in the title', () => {
  assert.deepEqual(plain(renderDash(model(), state({ selected: 'session:o2', filter: 'infra' }), 80, 24, plainStyle)), [
    'Work dashboard  /infra',
    'Other sessions (1)',
    '> crashed    infra         -    24h  "Which region first?"',
    ENDED_HINTS,
    '',
  ]);
  assert.deepEqual(plain(renderDash(model(), state({ selected: null, filter: 'nothing' }), 80, 24, plainStyle)), [
    'Work dashboard  /nothing',
    '  No rows match /nothing',
    TAIL,
    '',
  ]);
  assert.deepEqual(plain(renderDash(buildDashModel({ sessions: [], triageCount: 0, now: NOW }), state({ selected: null }), 80, 24, plainStyle)), [
    'Work dashboard',
    '  Nothing to show',
    TAIL,
    '',
  ]);
  const byTitle = plain(renderDash(model(), state({ selected: null, filter: 'launch', editing: true }), 80, 24, plainStyle));
  assert.equal(byTitle[0], 'Work dashboard  /launch_');
  assert.ok(byTitle.includes('  waiting    web           W-3   3h  "CI run for PR 42"'));
  assert.equal(byTitle.length, 5);
});

test('scrolling keeps the selected row visible, and the message line is last', () => {
  assert.deepEqual(plain(renderDash(model(), state({ selected: 'session:o3', message: 'Refreshed' }), 80, 6, plainStyle)), [
    'Work dashboard',
    'Other sessions (3)',
    '  done       docs          W-2   2h  "Published the guide"',
    '> closed     old-tool      -    20h',
    ENDED_HINTS,
    'Refreshed',
  ]);
});

test('hostile notes cannot inject terminal escapes', () => {
  const m = buildDashModel({ now: NOW, triageCount: 0, sessions: [entry({ id: 'h', tmuxWindow: 'x\x1b]0;evil\x07', status: 'needs-me', note: 'bad\x1b[2Jnote\nsecond' })] });
  const lines = renderDash(m, state({ selected: null }), 80, 24, plainStyle);
  assert.ok(lines.every((line) => !/[\x00-\x1f]/.test(line)));
  assert.match(lines[2], /"bad \[2Jnote second"/);
});

test('loadSessions adds liveness and the linked item', async () => {
  const store = await memoryStore();
  const item = store.addItem({ project: 'misc', title: 'Linked work', origin: 'manual' }, 'user');
  store.startSession({ id: 's1', file: null, cwd: '/src/api', name: null, pid: 10, tmuxPane: '%1', tmuxWindow: 'api', parentSession: null, headless: false });
  store.startSession({ id: 's2', file: null, cwd: '/src/api', name: null, pid: 11, tmuxPane: '%2', tmuxWindow: 'api', parentSession: null, headless: false });
  store.linkSession('s1', item.id, 'manual', 'user');
  const readers = { kill: (pid) => { if (pid !== 10) throw new Error('kill ESRCH'); }, environ: () => undefined };
  const [s1, s2] = loadSessions(store, [{ paneId: '%1', windowId: '@1', windowName: 'api', sessionName: 'main', path: '/src/api', command: 'node' }], readers);
  assert.deepEqual([s1.liveness, s1.itemId, s1.itemTitle], ['live', 'W-1', 'Linked work']);
  assert.deepEqual([s2.liveness, s2.itemId], ['crashed', null]);
});

const jobEntry = (overrides) => ({
  id: 'J-1', name: 'n', kind: 'cron', ownerSession: null, itemId: null, schedule: null, pid: null, cwd: '/srv', checkCommand: null, stopCommand: null, logPath: null,
  lastCheckAt: null, lastCheckStatus: null, lastCheckOutput: null, createdAt: ago(9000), updatedAt: ago(9000), stoppedAt: null, ...overrides,
});
const JOBS = [
  jobEntry({ id: 'J-2', name: 'dev-server', kind: 'process', lastCheckAt: ago(1), lastCheckStatus: 'unhealthy', lastCheckOutput: 'connection refused' }),
  jobEntry({ id: 'J-1', name: 'nightly-export', schedule: '0 3 * * *', lastCheckAt: ago(5), lastCheckStatus: 'healthy', lastCheckOutput: 'wrote 1204 rows' }),
  jobEntry({ id: 'J-3', name: 'old-sync', stoppedAt: ago(60), lastCheckAt: ago(2880), lastCheckStatus: 'healthy', lastCheckOutput: 'ok' }),
];

test('an unhealthy job is listed once, and job rows share the session columns', () => {
  const m = buildDashModel({ sessions: [], triageCount: 0, jobs: JOBS, now: NOW });
  assert.deepEqual(m.sections[0].rows.map((r) => r.key), ['alert:J-2']);
  assert.deepEqual(m.sections[3].rows.map((r) => r.key), ['job:J-1', 'job:J-3']);
  assert.deepEqual(plain(renderDash(m, state({ selected: 'alert:J-2' }), 160, 24, plainStyle)), [
    'Work dashboard',
    'Decisions (1)',
    '> unhealthy  dev-server      process    1m  connection refused',
    'Jobs (2)',
    '  healthy    nightly-export  0 3 * * *  5m  wrote 1204 rows',
    '  stopped    old-sync        cron       2d  ok',
    hints('enter details', 'c check', 'x stop'),
    '',
  ]);
  const colored = renderDash(m, state({ selected: null }), 160, 24, ansiStyle);
  assert.ok(colored[2].startsWith('\x1b[31m'));
  assert.ok(colored[5].startsWith('\x1b[2m'));
});

test('hints follow the selected row', () => {
  const rows = (m) => m.sections.flatMap((section) => section.rows);
  const jobRows = rows(buildDashModel({ sessions: [], triageCount: 0, jobs: JOBS, now: NOW }));
  assert.equal(hintsFor(jobRows.find((r) => r.key === 'job:J-1')), hints('enter details', 'c check', 'x stop'));
  assert.equal(hintsFor(jobRows.find((r) => r.key === 'job:J-3')), hints('enter details', 'D delete'));
  const sessionRows = rows(model());
  assert.equal(hintsFor(sessionRows.find((r) => r.key === 'session:o3')), ENDED_HINTS);
  assert.equal(hintsFor(sessionRows.find((r) => r.key === 'session:c1')), hints('enter transcript', 'x stop'));
  assert.equal(hintsFor(sessionRows.find((r) => r.key === 'triage')), hints('enter triage'));
});

test('child displays show their model, spend or dash, and diff against budget', () => {
  const run = {
    id: 'C-4', leadSession: 'p', childSession: 'c', kind: 'implement', model: 'provider/unknown', spendUsd: null,
    diffLines: 212, diffFiles: 2, budgetLines: 300, budgetFiles: 8, outcome: 'running', flags: ['unpriced'], acceptance: [], summary: '',
    brief: { goal: 'Add retry to fetchJira', acceptance: [] }, branch: null, baseCommit: null,
  };
  const sessions = [
    entry({ id: 'p', tmuxWindow: 'api', status: 'working' }),
    entry({ id: 'c', parentSession: 'p', headless: true, tmuxPane: null, status: 'done', run }),
  ];
  const lines = plain(renderDash(buildDashModel({ sessions, triageCount: 0, now: NOW }), state({ selected: null }), 100, 20, plainStyle));
  assert.ok(lines.some((line) => /^ {2}done {9}C-4\s+-\s+\S+\s+unknown — 212\/300 "Add retry to fetchJira"$/.test(line)), lines.join('\n'));
  assert.match(formatChildRun(run, ''), /^C-4  running  unknown  —  /);
  assert.match(renderResult(run, DEFAULT_CHILDREN), /Spend: — of \$5\.00 \(no price for provider\/unknown in children\.pricing; the cap is not enforced\)/);
});

test('loadSessions attaches each child session its run', async () => {
  const store = await memoryStore();
  const start = (id, parentSession) => store.startSession({ id, file: null, cwd: '/src/api', name: null, pid: 1, tmuxPane: null, tmuxWindow: null, parentSession, headless: parentSession !== null });
  start('p', null);
  start('c', 'p');
  const brief = { goal: 'Map it', kind: 'read-only', scope: [], nonGoals: [], acceptance: [], context: '', model: null, modelReason: null, from: null };
  store.createChildRun({ leadSession: 'p', brief, model: 'anthropic/claude-sonnet-5', repo: null, budgetLines: null, budgetFiles: null }, 'session:p');
  store.updateChildRun('C-1', { childSession: 'c' });
  const entries = loadSessions(store, [], { kill: () => {}, environ: () => undefined });
  assert.equal(entries.find((e) => e.id === 'c').run.id, 'C-1');
  assert.equal(entries.find((e) => e.id === 'p').run, null);
});
