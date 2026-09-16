import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { registerMessaging } = await jiti.import('../../extensions/messaging.ts');
const p = await jiti.import('../../src/messaging/policy.ts');
const { QUIET_GUIDANCE } = await jiti.import('../../src/messaging/identity.ts');
import { randomUUID } from 'node:crypto';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, validateToolArguments } from '@earendil-works/pi-ai';
const sdkEntry = process.env.PI_MESSAGING_PI_SDK ? pathToFileURL(process.env.PI_MESSAGING_PI_SDK).href : import.meta.resolve('@earendil-works/pi-coding-agent');
const sdkRequire = createRequire(sdkEntry); const corePackage = '@earendil-works/pi-agent-core/package.json';
const { Agent } = await import(new URL(sdkRequire(corePackage).main, pathToFileURL(sdkRequire.resolve(corePackage))).href);
const { wrapToolDefinition } = await import(new URL('./core/tools/tool-definition-wrapper.js', sdkEntry).href);

function fixture(t) {
  const state = p.newLedger(randomUUID()); const group = p.createGroup(state, 'review');
  const other = p.joinPeer(state, group, { sessionId: 'other', displayName: 'Other' });
  const events = new Map(); const commands = new Map(); const tools = new Map(); const renderers = new Map();
  const bodies = new Map(); const activeTools = ['peer_message'];
  const delivered = []; const notices = []; const statuses = []; const confirmations = [];
  const ensureCalls = []; const connectCalls = []; const lifecycle = { joins: 0, resumes: 0, takeovers: 0, suspends: 0, leaves: 0, closes: 0, bodyReads: 0 }; let callSequence = 0; let ensureError;
  let peer; let lease; let closed = false;
  const install = stored => { lease = p.leaseOf(stored); peer = p.publicPeer(stored); return { ...peer }; };
  const clear = () => { peer = undefined; lease = undefined; };
  const backend = {
    get peer() { return peer; }, get closed() { return closed; },
    listGroups: async () => Object.values(state.groups).map(p.refOf), createGroup: async label => p.createGroup(state, label),
    getGroupSummary: async g => p.summary(state, g), peers: async g => Object.values(state.peers).filter(x => x.groupId === g.id).map(p.publicPeer),
    routes: async g => Object.values(state.routes).filter(route => route.groupId === g.id).map(route => ({ ...route })),
    setRoute: async (g, from, to, mode, recover) => p.setRoute(state, g, from, to, mode, recover),
    join: async (g, info) => { lifecycle.joins++; return install(p.joinPeer(state, g, info)); },
    resume: async (g, id, sessionId) => { lifecycle.resumes++; return install(p.resumePeer(state, g, sessionId, id)); },
    takeover: async (g, id, sessionId) => { lifecycle.takeovers++; return install(p.takeoverPeer(state, g, sessionId, id)); },
    suspend: async () => { lifecycle.suspends++; if (lease) p.suspendPeer(state, lease); clear(); },
    leave: async () => { lifecycle.leaves++; if (lease) p.leavePeer(state, lease); clear(); }, close: async () => { lifecycle.closes++; closed = true; },
    heartbeat: async name => { if (lease) { p.heartbeat(state, lease, name); peer = p.publicPeer(p.requireLease(state, lease)); } }, onChange: () => () => {}, reserve: async () => [],
    arm: async (g, limit) => p.arm(state, g, limit), pause: async g => p.pause(state, g), maintain: async (_g, now) => p.maintain(state, now),
    send: async (input, key) => { const m = p.prepareMessage(state, lease, input, key); bodies.set(m.id, input.text); return m; },
    listMessages: async g => Object.values(state.messages).filter(m => m.groupId === g.id).sort((a, b) => b.sequence - a.sequence),
    readBody: async (_g, id) => { lifecycle.bodyReads++; return p.envelope(state, state.messages[id], bodies.get(id)); },
    resolveMessage: async (g, id, action) => p.resolveMessage(state, g, id, action),
    revoke: async (g, id) => p.revokePeer(state, g, id),
    prune: async (g, execute, before = Date.now() - p.HISTORY_TTL_MS) => { const ids = p.prunable(state, g, before); if (execute) for (const id of ids) delete state.messages[id]; return ids; },
  };
  const pi = {
    on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    sendMessage: (...args) => delivered.push(args), getSessionName: () => 'Local', getActiveTools: () => activeTools,
  };
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getSessionFile: () => '/tmp/session.jsonl', getSessionId: () => 'local', getSessionName: () => 'Local' },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args),
      confirm: async (...args) => { confirmations.push(args); return true; }, input: async () => 'Local', select: async (_, choices) => choices[0], editor: async () => 'human text' } };
  registerMessaging(
    pi,
    async () => { connectCalls.push(++callSequence); closed = false; return backend; },
    async () => { ensureCalls.push(++callSequence); if (ensureError) throw ensureError; },
  );
  t.after(async () => { await events.get('session_shutdown')?.({}, ctx); });
  return {
    state, group, other, backend, events, commands, tools, renderers, delivered, notices, statuses, confirmations, lifecycle,
    ensureCalls, connectCalls, setEnsureError: error => { ensureError = error; }, activeTools, ctx, pi,
  };
}
async function execute(f, action, fields = {}) { return f.tools.get('peer_message').execute(randomUUID(), { action, ...fields }, undefined, undefined, f.ctx); }
async function moduleFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...await moduleFiles(url));
    else if (entry.name.endsWith('.mjs')) files.push(url);
  }
  return files;
}
function callArgumentCount(source, open) {
  const stack = ['(']; let commas = 0; let content = false; let quote; let lineComment = false; let blockComment = false;
  for (let index = open + 1; index < source.length; index++) {
    const char = source[index]; const next = source[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index++; } continue; }
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = undefined; continue; }
    if (char === '/' && next === '/') { lineComment = true; index++; continue; }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; content = true; continue; }
    if ('([{'.includes(char)) { stack.push(char); content = true; continue; }
    if (')]}'.includes(char)) {
      stack.pop();
      if (stack.length === 0) return content ? commas + 1 : 0;
      continue;
    }
    if (char === ',' && stack.length === 1) commas++;
    else if (!/\s/.test(char)) content = true;
  }
  throw new Error('Unterminated registerMessaging call');
}

test('test and smoke backend injections always provide inert readiness', async () => {
  const missing = [];
  for (const file of await Promise.all([
    moduleFiles(new URL('./', import.meta.url)),
    moduleFiles(new URL('../../scripts/', import.meta.url)),
  ]).then(groups => groups.flat())) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bregisterMessaging\s*\(/g)) {
      const open = match.index + match[0].lastIndexOf('(');
      if (callArgumentCount(source, open) === 2) {
        const line = source.slice(0, match.index).split('\n').length;
        missing.push(`${file.pathname}:${line}`);
      }
    }
  }
  assert.deepEqual(missing, [], `Injected backend factories missing inert readiness:\n${missing.join('\n')}`);
});

test('native slash completion lists subcommands with hints and replaces the full argument prefix', async t => {
  const f = fixture(t); const command = f.commands.get('messages');
  assert.equal(typeof command.getArgumentCompletions, 'function');
  const provider = new CombinedAutocompleteProvider([{ name: 'messages', ...command }], '/tmp');
  const options = { signal: new AbortController().signal };
  const menu = await provider.getSuggestions(['/messages '], 0, '/messages '.length, options);
  assert.deepEqual(menu.items.map(i => i.value.trim()).sort(), ['arm', 'inbox', 'join', 'leave', 'pause', 'prune', 'revoke', 'routes', 'send', 'status']);
  assert.ok(menu.items.every(i => i.description));
  assert.match(menu.items.find(i => i.value.trim() === 'join').label, /group/i);
  assert.match(menu.items.find(i => i.value.trim() === 'arm').label, /1.*100/);
  const typed = '/messages jo';
  const suggestions = await provider.getSuggestions([typed], 0, typed.length, options);
  assert.equal(suggestions.items.length, 1);
  const completed = provider.applyCompletion([typed], 0, typed.length, suggestions.items[0], suggestions.prefix);
  assert.deepEqual(completed.lines, ['/messages join ']);
  assert.equal(f.connectCalls.length, 0); assert.equal(f.confirmations.length, 0); assert.equal(f.delivered.length, 0);
});

test('allowance completion supplies hints without arming and never suggests invalid arguments', async t => {
  const f = fixture(t); const complete = f.commands.get('messages').getArgumentCompletions;
  assert.equal(typeof complete, 'function');
  const choices = complete('arm ');
  assert.ok(choices.some(i => i.value === 'arm 2'));
  assert.ok(choices.some(i => i.value === 'arm 12' && /default/i.test(i.description)));
  assert.deepEqual(complete('arm 37').map(i => i.value), ['arm 37']);
  for (const prefix of ['arm 0', 'arm 101', 'arm -1', 'arm 2 extra', 'pause extra', 'unknown']) assert.equal(complete(prefix), null);
  const provider = new CombinedAutocompleteProvider([{ name: 'messages', ...f.commands.get('messages') }], '/tmp');
  const typed = '/messages arm 2';
  const suggestions = await provider.getSuggestions([typed], 0, typed.length, { signal: new AbortController().signal });
  assert.deepEqual(provider.applyCompletion([typed], 0, typed.length, suggestions.items[0], suggestions.prefix).lines, ['/messages arm 2']);
  assert.equal(f.state.groups[f.group.id].limit, 0); assert.equal(f.confirmations.length, 0); assert.equal(f.connectCalls.length, 0);
});

test('join completion uses groups learned by human commands without broker reads while typing', async t => {
  const f = fixture(t); const complete = f.commands.get('messages').getArgumentCompletions;
  assert.equal(typeof complete, 'function'); assert.equal(complete('join re'), null);
  p.createGroup(f.state, 'release');
  await f.commands.get('messages').handler('status', f.ctx);
  f.backend.listGroups = async () => { throw Error('Completion must not read the broker'); };
  assert.deepEqual(complete('join re').map(i => i.value), ['join release', 'join review']);
  assert.equal(f.backend.peer, undefined); assert.equal(f.state.groups[f.group.id].limit, 0);
  await f.events.get('session_shutdown')({}, f.ctx);
  assert.equal(complete('join re'), null);
});

test('newly created groups become completable without retaining them across reload', async t => {
  const f = fixture(t); const complete = f.commands.get('messages').getArgumentCompletions;
  assert.equal(typeof complete, 'function');
  await f.commands.get('messages').handler('join new-group', f.ctx);
  assert.deepEqual(complete('join new').map(i => i.value), ['join new-group']);
  await f.events.get('session_start')({}, f.ctx);
  assert.equal(complete('join new'), null);
});

test('session start ensures infrastructure without participation', async t => {
  const f = fixture(t);
  assert.equal(f.ensureCalls.length, 0); assert.equal(f.connectCalls.length, 0);
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.ensureCalls.length, 1);
  assert.equal(f.connectCalls.length, 0);
  assert.equal(f.backend.peer, undefined);
  assert.equal(f.delivered.length, 0);
});

test('startup failure warns without participation or model work', async t => {
  const f = fixture(t); const groupBefore = structuredClone(f.state.groups[f.group.id]);
  f.setEnsureError(new Error('private readiness failure'));
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  assert.equal(f.ensureCalls.length, 1); assert.equal(f.connectCalls.length, 0);
  assert.equal(f.notices.length, 1); assert.match(f.notices[0][0], /broker|messaging/i); assert.equal(f.notices[0][1], 'warning');
  assert.equal(f.backend.peer, undefined); assert.deepEqual(f.state.groups[f.group.id], groupBefore);
  assert.equal(f.delivered.length, 0);
});

test('command retries readiness before backend connection', async t => {
  const f = fixture(t); f.setEnsureError(new Error('not ready'));
  await f.events.get('session_start')({ reason: 'startup' }, f.ctx);
  f.setEnsureError(undefined);
  await f.commands.get('messages').handler('status', f.ctx);
  assert.equal(f.ensureCalls.length, 2); assert.equal(f.connectCalls.length, 1);
  assert.ok(f.ensureCalls[1] < f.connectCalls[0]);
  assert.equal(f.backend.peer, undefined); assert.equal(f.delivered.length, 0);
});

test('non-TUI controls fail before readiness or connection', async t => {
  const f = fixture(t);
  for (const mode of ['rpc', 'json', 'print']) await assert.rejects(f.commands.get('messages').handler('join review', { ...f.ctx, mode }), /TUI/i);
  await assert.rejects(execute(f, 'send', { kind: 'notice', toPeerId: f.other.id, text: 'x' }), /join/i);
  assert.equal(f.ensureCalls.length, 0); assert.equal(f.connectCalls.length, 0);
});

test('human join and arm are explicit; agent cannot grant itself controls or read pending bodies', async t => {
  const f = fixture(t);
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.state.groups[f.group.id].limit, 0);
  await f.commands.get('messages').handler('arm 2', f.ctx);
  assert.equal(f.state.groups[f.group.id].limit, 2); assert.ok(f.confirmations.length >= 2);
  for (const action of ['join', 'arm', 'rearm', 'inbox']) await assert.rejects(execute(f, action), /action/i);
  const sent = await execute(f, 'send', { kind: 'notice', toPeerId: f.other.id, text: 'PRIVATE_BODY' });
  assert.ok(sent.content[0].text.includes('queued'));
  const status = await execute(f, 'status'); assert.equal(JSON.stringify(status).includes('PRIVATE_BODY'), false);
  assert.equal(f.delivered.length, 0);
  const peers = await execute(f, 'peers'); assert.ok(peers.content[0].text.includes(f.other.id));
});

test('tree navigation suspends participation and explicit rejoin resumes the same identity without changing credits', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  const oldId = f.backend.peer.id;
  await f.commands.get('messages').handler('arm 2', f.ctx);
  const groupBefore = { ...f.state.groups[f.group.id] };
  await f.events.get('session_before_tree')({}, f.ctx);
  assert.equal(f.backend.peer, undefined); assert.equal(f.state.peers[oldId].active, true); assert.equal(f.state.peers[oldId].suspended, true);
  await assert.rejects(execute(f, 'status'), /join/i);
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.id, oldId); assert.equal(f.backend.peer.suspended, false);
  assert.deepEqual(f.state.groups[f.group.id], groupBefore);
  assert.equal(f.lifecycle.resumes, 1); assert.equal(f.delivered.length, 0); assert.equal(f.lifecycle.bodyReads, 0);
});

test('session replacement and shutdown suspend the same resumable identity', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); const id = f.backend.peer.id;
  await f.events.get('session_start')({ reason: 'reload' }, f.ctx);
  assert.equal(f.backend.peer, undefined); assert.equal(f.state.peers[id].active, true); assert.equal(f.state.peers[id].suspended, true);
  await f.commands.get('messages').handler('join review', f.ctx); assert.equal(f.backend.peer.id, id);
  await f.events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
  assert.equal(f.state.peers[id].active, true); assert.equal(f.state.peers[id].suspended, true);
  assert.equal(f.lifecycle.suspends, 2); assert.equal(f.lifecycle.leaves, 0);
});

test('failed suspension closes local state without reinterpreting it as final leave', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); const id = f.backend.peer.id;
  f.backend.suspend = async () => { f.lifecycle.suspends++; throw new Error('uncertain suspension'); };
  await assert.rejects(f.events.get('session_before_tree')({}, f.ctx), /uncertain suspension/);
  assert.equal(f.backend.closed, true); assert.equal(f.state.peers[id].active, true); assert.equal(f.lifecycle.leaves, 0);
  await assert.rejects(execute(f, 'status'), /join/i);
});

test('repeated same-group join is an informational no-op while cross-group join requires final leave', async t => {
  const f = fixture(t); const otherGroup = p.createGroup(f.state, 'other-group');
  await f.commands.get('messages').handler('join review', f.ctx);
  const original = f.backend.peer.id; const confirmations = f.confirmations.length;
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.id, original); assert.equal(f.lifecycle.joins, 1); assert.equal(f.lifecycle.resumes, 0);
  assert.equal(f.confirmations.length, confirmations); assert.match(f.notices.at(-1)[0], /already joined/i);
  await assert.rejects(f.commands.get('messages').handler(`join ${otherGroup.label}`, f.ctx), /leave.*current group/i);
  assert.equal(f.backend.peer.id, original);
  await f.commands.get('messages').handler('leave', f.ctx);
  assert.equal(f.state.peers[original].active, false);
  await f.commands.get('messages').handler(`join ${otherGroup.label}`, f.ctx);
  assert.notEqual(f.backend.peer.id, original); assert.equal(f.backend.peer.groupId, otherGroup.id);
});

test('single suspended candidate resumes only after confirmation and preserves role, routing, and allowance', async t => {
  const f = fixture(t); const candidate = p.joinPeer(f.state, f.group, { sessionId: 'local', displayName: 'review-lead' });
  p.suspendPeer(f.state, p.leaseOf(candidate)); const groupBefore = { ...f.state.groups[f.group.id] };
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.id, candidate.id); assert.equal(f.backend.peer.displayName, 'review-lead');
  assert.equal(f.lifecycle.resumes, 1); assert.equal(f.lifecycle.joins, 0); assert.equal(f.lifecycle.bodyReads, 0);
  assert.deepEqual(f.state.groups[f.group.id], groupBefore); assert.equal(f.delivered.length, 0);
  assert.ok(f.confirmations.some(([title, detail]) => /resume/i.test(title) && detail.includes('review-lead') && /suspended/i.test(detail)));
});

test('new session can take over one suspended member only after human confirmation', async t => {
  const f = fixture(t); const candidate = p.joinPeer(f.state, f.group, { sessionId: 'old-session', displayName: 'review-lead' });
  p.suspendPeer(f.state, p.leaseOf(candidate)); const oldLease = candidate.leaseId;
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.id, candidate.id);
  assert.equal(f.backend.peer.sessionId, 'local');
  assert.equal(f.backend.peer.displayName, 'review-lead');
  assert.notEqual(f.state.peers[candidate.id].leaseId, oldLease);
  assert.equal(f.lifecycle.takeovers, 1); assert.equal(f.lifecycle.joins, 0);
  assert.ok(f.confirmations.some(([title]) => /take over/i.test(title)));
});

test('online same-session match blocks before takeover UI or mutation', async t => {
  const f = fixture(t); const online = p.joinPeer(f.state, f.group, { sessionId: 'local', displayName: 'online-owner' });
  const before = structuredClone(f.state); const confirmations = f.confirmations.length;
  await assert.rejects(f.commands.get('messages').handler('join review', f.ctx), /online.*return|return.*revoke/i);
  assert.deepEqual(f.state, before); assert.equal(f.confirmations.length, confirmations);
  assert.equal(f.lifecycle.joins, 0); assert.equal(f.lifecycle.resumes, 0); assert.equal(f.backend.peer, undefined);
  assert.equal(f.state.peers[online.id].active, true);
});

test('multiple resume candidates use an attributed numbered picker and metadata-only unresolved counts', async t => {
  const f = fixture(t); const sessionId = 'local';
  const stale = p.joinPeer(f.state, f.group, { sessionId, displayName: 'stale-role' }); stale.lastSeen = Date.now() - 45_000;
  const suspended = p.joinPeer(f.state, f.group, { sessionId, displayName: 'suspended-role' }); p.suspendPeer(f.state, p.leaseOf(suspended));
  const sender = p.joinPeer(f.state, f.group, { sessionId: 'sender-two', displayName: 'Sender Two' });
  p.arm(f.state, f.group, 2);
  p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'notice', toPeerId: stale.id, text: 'metadata only one' }, 'candidate-one');
  p.prepareMessage(f.state, p.leaseOf(sender), { kind: 'notice', toPeerId: suspended.id, text: 'metadata only two' }, 'candidate-two');
  let resumeChoices;
  f.ctx.ui.select = async (title, choices) => {
    if (title === 'Resume messaging participation') { resumeChoices = choices; return choices[1]; }
    return choices[0];
  };
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(resumeChoices.length, 3); assert.ok(resumeChoices.slice(0, 2).every((label, index) => label.startsWith(`${index + 1}. `)));
  assert.equal(resumeChoices[2], '+ Create new participation');
  assert.match(resumeChoices[0], /stale-role.*session local.*stale.*45s.*1 unresolved/i);
  assert.match(resumeChoices[1], /suspended-role.*session local.*suspended.*1 unresolved/i);
  assert.equal(f.backend.peer.id, suspended.id); assert.equal(f.lifecycle.resumes, 1); assert.equal(f.lifecycle.joins, 0);
  assert.equal(f.lifecycle.bodyReads, 0); assert.equal(f.delivered.length, 0); assert.equal(f.state.groups[f.group.id].used, 0);
});

test('canceling resume selection or confirmation mutates nothing', async t => {
  const selection = fixture(t);
  const first = p.joinPeer(selection.state, selection.group, { sessionId: 'local', displayName: 'first' }); first.lastSeen = Date.now() - 40_000;
  const second = p.joinPeer(selection.state, selection.group, { sessionId: 'local', displayName: 'second' }); p.suspendPeer(selection.state, p.leaseOf(second));
  const selectionBefore = structuredClone(selection.state); selection.ctx.ui.select = async title => title === 'Resume messaging participation' ? undefined : 'review';
  await selection.commands.get('messages').handler('join review', selection.ctx);
  assert.deepEqual(selection.state, selectionBefore); assert.equal(selection.lifecycle.resumes, 0); assert.equal(selection.backend.peer, undefined);

  const confirmation = fixture(t); const candidate = p.joinPeer(confirmation.state, confirmation.group, { sessionId: 'local', displayName: 'candidate' });
  p.suspendPeer(confirmation.state, p.leaseOf(candidate)); const confirmationBefore = structuredClone(confirmation.state);
  confirmation.ctx.ui.confirm = async title => !/resume/i.test(title);
  await confirmation.commands.get('messages').handler('join review', confirmation.ctx);
  assert.deepEqual(confirmation.state, confirmationBefore); assert.equal(confirmation.lifecycle.resumes, 0); assert.equal(confirmation.backend.peer, undefined);
});

test('late resume confirmation cannot attach to a replacement tree context', async t => {
  const f = fixture(t); const candidate = p.joinPeer(f.state, f.group, { sessionId: 'local', displayName: 'candidate' });
  p.suspendPeer(f.state, p.leaseOf(candidate)); let release; let begun; let dialogTitle;
  const started = new Promise(resolve => { begun = resolve; });
  f.ctx.ui.confirm = async title => { dialogTitle = title; begun(); return new Promise(resolve => { release = resolve; }); };
  const resuming = f.commands.get('messages').handler('join review', f.ctx); await started;
  await f.events.get('session_before_tree')({}, f.ctx); release(true);
  await assert.rejects(resuming, /session change/i); assert.match(dialogTitle, /resume/i);
  assert.equal(f.lifecycle.resumes, 0); assert.equal(f.backend.peer, undefined);
  assert.equal(f.state.peers[candidate.id].active, true); assert.equal(f.state.peers[candidate.id].suspended, true);
});

test('an old selected group is never silently replaced by another group with the same label', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await f.commands.get('messages').handler('leave', f.ctx);
  f.state.groups = {}; f.state.peers = {}; p.createGroup(f.state, 'review');
  await assert.rejects(f.commands.get('messages').handler('status', f.ctx), /no longer|missing|not found/i);
});

test('leave during a status read returns a participation error rather than following the replacement peer', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  let release; let started; const ready = new Promise(r => { started = r; });
  f.backend.listMessages = () => { started(); return new Promise(r => { release = r; }); };
  const pending = execute(f, 'status'); await ready;
  await f.commands.get('messages').handler('leave', f.ctx); release([]);
  await assert.rejects(pending, /participation|session changed/i);
});

test('session-ID defaults require no naming dialog and are independent of session titles', async t => {
  const f = fixture(t); const sessionId = 'a31b7c92-1111-4444-8888-123456789abc';
  f.ctx.sessionManager.getSessionId = () => sessionId;
  f.ctx.ui.input = async () => { throw Error('No name input expected'); };
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.equal(f.backend.peer.displayName, sessionId);
  assert.equal(f.backend.peer.sessionId, sessionId);
  assert.ok(f.confirmations.some(([, text]) => text.includes(sessionId)));
  await f.events.get('session_info_changed')?.({ name: 'Renamed title' }, f.ctx);
  assert.equal(f.backend.peer.displayName, sessionId);
  assert.equal(f.state.groups[f.group.id].limit, 0); assert.equal(f.delivered.length, 0);
});

test('peer selection shows role and session ID without conflating identical labels', async t => {
  const f = fixture(t);
  const sessionId = 'f82e409a-1111-4444-8888-123456789abc';
  f.other.displayName = 'test-reviewer'; f.other.sessionId = sessionId;
  const second = p.joinPeer(f.state, f.group, { sessionId, displayName: 'test-reviewer' });
  await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 1);
  f.ctx.ui.select = async (title, choices) => {
    if (title === 'Message kind') return choices[0];
    assert.equal(title, 'Send to peer'); assert.equal(choices.length, 2);
    assert.ok(choices.every(c => c.includes('test-reviewer') && c.includes('f82e409a')));
    assert.notEqual(choices[0], choices[1]); return choices[1];
  };
  await f.commands.get('messages').handler('send', f.ctx);
  assert.equal(Object.values(f.state.messages)[0].recipientPeerId, second.id);
});

test('role rename changes only self while discovery retains session and routing IDs', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 1);
  const before = { ...f.backend.peer }; const groupBefore = { ...f.state.groups[f.group.id] };
  const queued = p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'notice', toPeerId: before.id, text: 'PRIVATE_BODY' }, 'incoming');
  const result = JSON.parse((await execute(f, 'rename', { displayName: '  test-reviewer  ' })).content[0].text);
  assert.deepEqual(result, { id: before.id, sessionId: 'local', displayName: 'test-reviewer' });
  assert.equal(f.backend.peer.displayName, 'test-reviewer'); assert.equal(f.other.displayName, 'Other');
  await f.events.get('session_info_changed')?.({ name: 'Unrelated title' }, f.ctx);
  assert.equal(f.backend.peer.displayName, 'test-reviewer');
  assert.equal(queued.recipientPeerId, before.id); assert.equal(queued.state, 'queued');
  assert.deepEqual(f.state.groups[f.group.id], groupBefore);
  const discovery = JSON.parse((await execute(f, 'peers')).content[0].text);
  assert.equal(discovery.selfId, before.id); assert.equal(discovery.selfSessionId, 'local');
  assert.deepEqual(discovery.peers.find(p => p.id === before.id), { id: before.id, sessionId: 'local', displayName: 'test-reviewer', presence: 'online', sendMode: 'closed' });
  assert.equal(discovery.peers.find(p => p.id === f.other.id).sessionId, 'other');
  assert.equal(JSON.stringify(discovery).includes('PRIVATE_BODY'), false); assert.equal(f.delivered.length, 0);
  await f.commands.get('messages').handler('leave', f.ctx);
  await f.commands.get('messages').handler('join review', f.ctx);
  assert.notEqual(f.backend.peer.id, before.id); assert.equal(f.backend.peer.sessionId, before.sessionId);
  assert.equal(f.backend.peer.displayName, 'local'); assert.equal(queued.recipientPeerId, before.id);
});

test('rename rejects administrative targets, invalid names, and unjoined or non-TUI callers', async t => {
  const f = fixture(t);
  await assert.rejects(execute(f, 'rename', { displayName: 'reviewer' }), /join/i);
  assert.equal(f.connectCalls.length, 0);
  await f.commands.get('messages').handler('join review', f.ctx);
  for (const displayName of [undefined, 123, '', ' ', 'x'.repeat(65), 'review\nlead', '\x1b[31mreview', '\u202elead']) {
    await assert.rejects(execute(f, 'rename', { displayName }), /display.?name|rename/i);
  }
  for (const fields of [{ kind: 'notice', toPeerId: f.other.id }, { text: 'unused' }, { inReplyTo: randomUUID() }]) {
    await assert.rejects(execute(f, 'rename', { displayName: 'reviewer', ...fields }), /rename|only/i);
  }
  for (const mode of ['rpc', 'json', 'print']) {
    await assert.rejects(f.tools.get('peer_message').execute('rename', { action: 'rename', displayName: 'reviewer' }, undefined, undefined, { ...f.ctx, mode }), /TUI/i);
  }
  assert.equal(f.backend.peer.displayName, 'local'); assert.equal(f.other.displayName, 'Other');
  await execute(f, 'rename', { displayName: '🧪'.repeat(64) });
  assert.equal(f.backend.peer.displayName, '🧪'.repeat(64));
});

test('real Pi argument pipeline accepts captured-style padding without changing input or sending extra work', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 2);
  const tool = f.tools.get('peer_message');
  const calls = [
    { action: 'peers', displayName: 'test-crawler', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 },
    { action: 'rename', displayName: 'test-crawler', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 },
    { action: 'send', kind: 'notice', displayName: 'not-a-rename', toPeerId: f.other.id, text: '  exact body\n', inReplyTo: '', beforeSequence: 1 },
    { action: 'send', kind: 'notice', displayName: null, toPeerId: f.other.id, text: 'second body', inReplyTo: null, beforeSequence: null },
    { action: 'rename', displayName: null },
    { action: 'send', kind: 'notice', toPeerId: f.other.id, text: null },
  ];
  const original = structuredClone(calls); let requests = 0;
  const agent = new Agent({
    initialState: { model: { id: 'scripted', name: 'Scripted regression', provider: 'test', api: 'openai-responses', baseUrl: 'https://invalid.example',
      reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      tools: [wrapToolDefinition(tool, () => f.ctx)] },
    streamFn: () => {
      assert.ok(requests <= calls.length, 'Scripted provider must stay bounded');
      if (requests === 3) {
        const first = Object.values(f.state.messages)[0];
        p.resolveMessage(f.state, f.group, first.id, 'canceled');
      }
      const args = calls[requests++];
      const message = { role: 'assistant', api: 'openai-responses', provider: 'test', model: 'scripted', timestamp: 1,
        content: args ? [{ type: 'toolCall', id: `call-${requests}`, name: 'peer_message', arguments: args }] : [{ type: 'text', text: 'done' }],
        stopReason: args ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
    },
  });
  t.after(() => agent.abort()); await agent.prompt('Exercise the isolated messaging fixture');
  const results = agent.state.messages.filter(m => m.role === 'toolResult');
  assert.equal(results.length, 6);
  const listed = JSON.parse(results[0].content[0].text);
  assert.equal(listed.peers.find(peer => peer.id === listed.selfId).displayName, 'local');
  assert.ok(results.slice(0, 4).every(m => !m.isError), JSON.stringify(results.map(m => m.content)));
  assert.ok(results.slice(4).every(m => m.isError), 'Required nulls must not be coerced into a literal name/body "null"');
  assert.deepEqual(calls, original); assert.equal(f.backend.peer.displayName, 'test-crawler'); assert.equal(f.other.displayName, 'Other');
  const messages = Object.values(f.state.messages);
  assert.equal(messages.length, 2); assert.ok(messages.every(m => m.recipientPeerId === f.other.id && m.inReplyTo === undefined));
  assert.equal((await f.backend.readBody(f.group, messages[0].id)).text, '  exact body\n');
  assert.equal(f.state.groups[f.group.id].used, 0); assert.equal(f.delivered.length, 0); assert.equal(requests, 7);
});

test('direct execution normalizes neutral padding but preserves real reply references and status cursors', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 2);
  for (const empty of ['', null, undefined]) {
    await execute(f, 'rename', { displayName: 'test-reviewer', toPeerId: empty, text: empty, inReplyTo: empty, beforeSequence: 1 });
  }
  const base = Date.now();
  const incoming = p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'request', toPeerId: f.backend.peer.id, text: 'one' }, 'incoming-request', base);
  const admitted = p.admit(f.state, p.leaseOf(f.state.peers[f.backend.peer.id]), incoming.id, base + 1);
  p.observe(f.state, p.leaseOf(f.state.peers[f.backend.peer.id]), admitted, base + 2);
  await execute(f, 'send', { kind: 'reply', toPeerId: f.other.id, text: 'reply', inReplyTo: incoming.id });
  assert.equal(Object.values(f.state.messages)[1].inReplyTo, incoming.id);
  const tool = f.tools.get('peer_message'); assert.equal(typeof tool.prepareArguments, 'function');
  const statusArgs = tool.prepareArguments({ action: 'status', displayName: '', toPeerId: '', text: '', inReplyTo: '', beforeSequence: 1 });
  assert.equal(statusArgs.beforeSequence, 1);
  const status = JSON.parse((await tool.execute('status', statusArgs, undefined, undefined, f.ctx)).content[0].text);
  assert.equal(status.outgoing.length, 0);
  const firstPage = tool.prepareArguments({ action: 'status', beforeSequence: null });
  const outgoing = JSON.parse((await tool.execute('status', firstPage, undefined, undefined, f.ctx)).content[0].text).outgoing;
  assert.equal(outgoing.length, 1); assert.equal(outgoing[0].kind, 'reply'); assert.equal(outgoing[0].inReplyTo, incoming.id);
  assert.throws(() => validateToolArguments(tool, { name: 'peer_message', arguments: tool.prepareArguments({ action: 'status', beforeSequence: 0 }) }), /beforeSequence|minimum/i);
  assert.throws(() => validateToolArguments(tool, { name: 'peer_message', arguments: tool.prepareArguments({ action: 'peers', unexpected: null }) }), /unexpected|additional/i);
  for (const input of [null, undefined, [], 1, 'peers']) {
    assert.throws(() => validateToolArguments(tool, { name: 'peer_message', arguments: tool.prepareArguments(input) }));
  }
});

test('padding compatibility cannot discard meaningful rename targets, malformed IDs, or required values', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  for (const input of [
    { action: 'rename', displayName: 'other-role', toPeerId: f.other.id, beforeSequence: 1 },
    { action: 'rename', displayName: 'other-role', text: 'not harmless padding' },
    { action: 'rename', displayName: '' }, { action: 'rename', displayName: null },
    { action: 'send', kind: 'notice', toPeerId: '', text: 'body' }, { action: 'send', kind: 'notice', toPeerId: null, text: 'body' },
    { action: 'send', kind: 'notice', toPeerId: f.other.id, text: '' }, { action: 'send', kind: 'notice', toPeerId: f.other.id, text: null },
    ...['not-a-uuid', ' ', 'null'].map(inReplyTo => ({ action: 'send', kind: 'reply', toPeerId: f.other.id, text: 'body', inReplyTo })),
  ]) await assert.rejects(execute(f, input.action, input), /rename|display.?name|send|body|peer|reply/i);
  assert.equal(f.backend.peer.displayName, 'local'); assert.equal(f.other.displayName, 'Other');
  assert.equal(Object.keys(f.state.messages).length, 0); assert.equal(f.state.groups[f.group.id].limit, 0);
});

test('agent sends require one explicit static protocol kind', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 2);
  const tool = f.tools.get('peer_message');
  assert.deepEqual(tool.parameters.properties.kind.anyOf?.map(item => item.const) ?? tool.parameters.properties.kind.enum, ['notice', 'request', 'reply']);
  await assert.rejects(execute(f, 'send', { toPeerId: f.other.id, text: 'ambiguous' }), /kind/i);
  await assert.rejects(execute(f, 'peers', { kind: 'notice' }), /kind|send/i);
  const sent = JSON.parse((await execute(f, 'send', { kind: 'notice', toPeerId: f.other.id, text: 'one way' })).content[0].text);
  assert.equal(f.state.messages[sent.id].kind, 'notice');
});

test('send validation identifies the bad ID field rather than blaming a valid recipient', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await assert.rejects(execute(f, 'send', { kind: 'reply', toPeerId: f.other.id, text: 'body', inReplyTo: 'not-a-message-id' }), /inReplyTo/);
  await assert.rejects(execute(f, 'send', { kind: 'notice', toPeerId: 'not-a-peer-id', text: 'body' }), /toPeerId/);
  assert.equal(Object.keys(f.state.messages).length, 0); assert.equal(f.state.groups[f.group.id].used, 0);
});

test('concurrent self-renames are rejected instead of racing the local name cache', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  assert.ok(f.tools.get('peer_message').parameters.properties.action.enum.includes('rename'));
  let release; let started; const ready = new Promise(r => { started = r; });
  const barrier = new Promise(r => { release = r; }); const self = f.backend.peer;
  f.backend.heartbeat = async name => { started(); await barrier; const stored = f.state.peers[self.id]; p.heartbeat(f.state, p.leaseOf(stored), name); Object.assign(self, p.publicPeer(stored)); };
  const first = execute(f, 'rename', { displayName: 'first-reviewer' }); await ready;
  await assert.rejects(execute(f, 'rename', { displayName: 'second-reviewer' }), /busy|progress/i);
  release(); await first; assert.equal(f.backend.peer.displayName, 'first-reviewer');
});

test('late rename acknowledgment cannot follow replacement membership or block its naming', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  assert.ok(f.tools.get('peer_message').parameters.properties.action.enum.includes('rename'));
  let release; let started; const ready = new Promise(r => { started = r; });
  const barrier = new Promise(r => { release = r; }); const oldId = f.backend.peer.id;
  const heartbeat = f.backend.heartbeat;
  f.backend.heartbeat = async name => { await heartbeat(name); started(); await barrier; };
  const pending = execute(f, 'rename', { displayName: 'old-reviewer' }); await ready;
  await f.commands.get('messages').handler('leave', f.ctx);
  await f.commands.get('messages').handler('join review', f.ctx);
  f.backend.heartbeat = heartbeat;
  await execute(f, 'rename', { displayName: 'new-reviewer' });
  release(); await assert.rejects(pending, /participation|session changed/i);
  assert.notEqual(f.backend.peer.id, oldId); assert.equal(f.backend.peer.displayName, 'new-reviewer');
});

test('normal human and agent member lists hide finalized tombstones', async t => {
  const f = fixture(t); p.suspendPeer(f.state, p.leaseOf(f.other));
  const departed = p.joinPeer(f.state, f.group, { sessionId: 'departed', displayName: 'Departed' }); p.leavePeer(f.state, p.leaseOf(departed));
  f.ctx.ui.select = async (title, choices) => title === 'Resume messaging participation' ? choices.at(-1) : choices[0];
  await f.commands.get('messages').handler('join review', f.ctx);
  await f.commands.get('messages').handler('status', f.ctx);
  const notice = f.notices.at(-1)[0]; assert.match(notice, /Other.*suspended/i); assert.doesNotMatch(notice, /Departed|left/i);
  const discovery = JSON.parse((await execute(f, 'peers')).content[0].text);
  assert.equal(discovery.peers.find(peer => peer.id === f.other.id).presence, 'suspended');
  assert.equal(discovery.peers.some(peer => peer.id === departed.id), false);
  assert.ok(discovery.peers.every(peer => ['online', 'stale', 'suspended'].includes(peer.presence)));
});

test('peer discovery exposes caller-specific route metadata without bodies', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 1);
  p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'notice', toPeerId: f.backend.peer.id, text: 'PRIVATE_ROUTE_BODY' }, 'route-notice');
  const discovery = JSON.parse((await execute(f, 'peers')).content[0].text);
  assert.equal(discovery.peers.find(peer => peer.id === f.other.id).sendMode, 'closed');
  assert.equal(JSON.stringify(discovery).includes('PRIVATE_ROUTE_BODY'), false);
});

test('messaging exposes identity only through the API and registers no context hook', async t => {
  const f = fixture(t);
  assert.equal(f.events.has('context'), false);
  await f.commands.get('messages').handler('join review', f.ctx);
  const result = await execute(f, 'peers');
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(
    { id: value.selfId, sessionId: value.selfSessionId, displayName: value.selfDisplayName },
    { id: f.backend.peer.id, sessionId: 'local', displayName: 'local' },
  );
  assert.equal(f.delivered.some(([message]) => message.customType === 'pi-messaging.identity.v1'), false);
  const tool = f.tools.get('peer_message');
  const metadata = JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });
  for (const runtimeValue of [f.group.id, f.backend.peer.id, f.backend.peer.sessionId, String(f.backend.peer.lastSeen)]) {
    assert.equal(metadata.includes(runtimeValue), false);
  }
});

test('busy work cannot enable admission; settling idle admits one queued message', { timeout: 2000 }, async t => {
  const f = fixture(t); let reserves = 0; let statusSeen;
  const status = new Promise(resolve => { statusSeen = resolve; });
  f.ctx.ui.setStatus = () => statusSeen(); f.ctx.isIdle = () => false;
  f.backend.reserve = async () => { reserves++; return []; };
  await f.events.get('agent_start')({}, f.ctx);
  await f.commands.get('messages').handler('join review', f.ctx); await status;
  assert.equal(reserves, 0); assert.equal(f.delivered.length, 0);
  p.arm(f.state, f.group, 1);
  const message = p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'notice', toPeerId: f.backend.peer.id, text: 'quiet message' }, 'quiet');
  f.backend.reserve = async () => { const reservations = p.admitBatch(f.state, p.leaseOf(f.state.peers[f.backend.peer.id]), [message.id]); return reservations.map(reservation => ({ ...reservation, envelope: p.envelope(f.state, message, 'quiet message') })); };
  let delivered; const delivery = new Promise(resolve => { delivered = resolve; });
  f.pi.sendMessage = (...args) => { f.delivered.push(args); delivered(); };
  f.ctx.isIdle = () => true; await f.events.get('agent_settled')({}, f.ctx); await delivery;
  assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0][1].deliverAs, 'followUp');
  assert.equal(f.state.groups[f.group.id].used, 1);
});

test('messaging tool registration stays byte-stable across identity and metadata operations', async t => {
  const f = fixture(t); const tool = f.tools.get('peer_message');
  const baseline = { object: tool.parameters, names: [...f.tools.keys()], schema: JSON.stringify(tool.parameters), prompt: JSON.stringify({ description: tool.description, snippet: tool.promptSnippet, guidelines: tool.promptGuidelines }) };
  await f.commands.get('messages').handler('join review', f.ctx);
  await execute(f, 'rename', { displayName: 'cache-stable-reviewer' });
  await execute(f, 'peers'); await execute(f, 'status'); await f.backend.maintain(f.group);
  const current = f.tools.get('peer_message');
  assert.equal(current.parameters, baseline.object); assert.deepEqual([...f.tools.keys()], baseline.names);
  assert.equal(JSON.stringify(current.parameters), baseline.schema);
  assert.equal(JSON.stringify({ description: current.description, snippet: current.promptSnippet, guidelines: current.promptGuidelines }), baseline.prompt);
  assert.equal(f.events.has('context'), false); assert.equal(f.delivered.length, 0);
});

test('stationary tool guidance directs agents to the API without dynamic identity values', t => {
  const f = fixture(t); const tool = f.tools.get('peer_message');
  assert.ok(tool.promptGuidelines.includes(QUIET_GUIDANCE));
  assert.match(tool.promptGuidelines.join('\n'), /action peers/i);
  assert.match(tool.promptGuidelines.join('\n'), /conversation context/i);
  assert.match(tool.promptGuidelines.join('\n'), /notice forbids.*repl/i);
  assert.match(tool.promptGuidelines.join('\n'), /request.*exact.*reply/i);
});

test('human inbox offers one exact reply only for a delivered open request', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 2);
  const request = p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'request', toPeerId: f.backend.peer.id, text: 'review' }, 'human-request');
  const receipt = p.admit(f.state, p.leaseOf(f.state.peers[f.backend.peer.id]), request.id); p.observe(f.state, p.leaseOf(f.state.peers[f.backend.peer.id]), receipt);
  let step = 0;
  f.ctx.ui.select = async (title, choices) => {
    if (title.startsWith('Inbox:')) return step++ === 0 ? choices[0] : 'Close';
    if (title.includes(request.id)) { assert.ok(choices.includes('Reply to request')); return 'Reply to request'; }
    return choices[0];
  };
  f.ctx.ui.editor = async title => { assert.match(title, /reply/i); return 'human response'; };
  await f.commands.get('messages').handler('inbox', f.ctx);
  const reply = Object.values(f.state.messages).find(message => message.kind === 'reply');
  assert.equal(reply.inReplyTo, request.id); assert.equal(reply.recipientPeerId, f.other.id);
});

test('human route controls change initiation only and agents cannot invoke them', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  const self = f.backend.peer.id; const groupBefore = { ...f.state.groups[f.group.id] };
  f.ctx.ui.select = async (title, choices) => title === 'Route action' ? choices[1] : choices[0];
  await f.commands.get('messages').handler('routes', f.ctx);
  assert.equal(f.state.routes[p.routeKey(self, f.other.id)].mode, 'closed');
  assert.deepEqual(f.state.groups[f.group.id], groupBefore);
  await assert.rejects(execute(f, 'routes'), /action/i);
  assert.equal(f.delivered.length, 0);
});

test('human composition queues as the joined peer and inbox viewing/cancellation never enters model context', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx); p.arm(f.state, f.group, 1);
  await f.commands.get('messages').handler('send', f.ctx);
  const m = Object.values(f.state.messages)[0]; assert.equal(m.senderPeerId, f.backend.peer.id); assert.equal(m.kind, 'notice');
  const choices = ['message', 'View body', 'message', 'Cancel queued message', 'Close'];
  let views = 0;
  f.ctx.ui.select = async (_title, options) => { const choice = choices.shift(); return choice === 'message' ? options[0] : choice; };
  f.ctx.ui.editor = async (_title, text) => { assert.equal(text, 'human text'); views++; return 'must not be sent'; };
  await f.commands.get('messages').handler('inbox', f.ctx);
  assert.equal(views, 1); assert.equal(m.state, 'canceled'); assert.equal(f.delivered.length, 0);
  assert.match(f.confirmations.at(-1)[1], /releases this queued reservation/i);
  assert.equal(Object.keys(f.state.messages).length, 1);
});

test('human dismissal, revocation and pruning preserve spent allowance', async t => {
  const f = fixture(t); await f.commands.get('messages').handler('join review', f.ctx);
  await f.commands.get('messages').handler('arm 2', f.ctx);
  const m = p.prepareMessage(f.state, p.leaseOf(f.other), { kind: 'notice', toPeerId: f.backend.peer.id, text: 'uncertain' }, 'other-send');
  p.admitBatch(f.state, p.leaseOf(f.state.peers[f.backend.peer.id]), [m.id]);
  const choices = ['message', 'Dismiss uncertain attempt', 'Close'];
  f.ctx.ui.select = async (_title, options) => { const choice = choices.shift(); return choice === 'message' ? options[0] : choice; };
  await f.commands.get('messages').handler('inbox', f.ctx);
  assert.equal(m.state, 'dismissed');
  assert.match(f.confirmations.at(-1)[1], /does not refund the spent allowance/i);
  f.ctx.ui.select = async (_title, options) => options[0];
  await f.commands.get('messages').handler('revoke', f.ctx);
  assert.equal(f.state.peers[f.other.id].active, false);
  await f.commands.get('messages').handler('prune', f.ctx);
  assert.equal(Object.keys(f.state.messages).length, 1, 'recent terminal history is retained for seven days');
  assert.equal(f.state.groups[f.group.id].used, 1);
});

test('a late join dialog cannot mutate participation after tree navigation', async t => {
  const f = fixture(t); let release; let begun; const started = new Promise(r => { begun = r; });
  f.ctx.ui.confirm = async () => { begun(); return new Promise(r => { release = r; }); };
  const joining = f.commands.get('messages').handler('join review', f.ctx); await started;
  await f.events.get('session_before_tree')({}, f.ctx); release(true);
  await assert.rejects(joining, /session change/i);
  assert.equal(f.backend.peer, undefined); assert.equal(Object.keys(f.state.peers).length, 1);
});

test('canceled join confirmation makes no participation; renderer escapes terminal controls and wraps narrow widths', async t => {
  const f = fixture(t); f.ctx.ui.confirm = async () => false;
  await f.commands.get('messages').handler('join review', f.ctx); assert.equal(f.backend.peer, undefined);
  const render = f.renderers.get('pi-messaging.peer.v1');
  const component = render({ content: 'peer\x1b[31m'.repeat(8) }, {}, {});
  for (const width of [8, 20, 80]) {
    const lines = component.render(width); assert.ok(lines.length); assert.ok(lines.every(line => !line.includes('\x1b[31m')));
  }
});
