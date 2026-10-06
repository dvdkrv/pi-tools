import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect } from '@nats-io/transport-node';
import { Kvm } from '@nats-io/kv';
import { createJiti } from 'jiti';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../../src/messaging/nats-backend.ts');
const { LEDGER_REFRESH_MS, validateLedger } = await createJiti(import.meta.url).import('../../src/messaging/policy.ts');

async function fixture(t, count = 2) {
  const f = await brokerFixture(t); if (!f) return null;
  const backends = [];
  for (let i = 0; i < count; i++) {
    const backend = await connectBackend(f.config, i === 0 ? { initialize: true } : {});
    t.after(() => backend.close()); backends.push(backend);
  }
  const group = await backends[0].createGroup('presence');
  for (let i = 0; i < count; i++) await backends[i].join(group, { sessionId: `session-${i}`, displayName: `Peer ${i}` });
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  return { ...f, backends, group, kv: await new Kvm(nc).open('PM_CONTROL') };
}

async function keys(kv, filter) { const found = []; for await (const key of await kv.keys(filter)) found.push(key); return found; }
async function updateState(kv, mutate) { const entry = await kv.get('state'); const state = entry.json(); mutate(state); await kv.update('state', JSON.stringify(state), entry.revision); return state; }
async function eventually(read, accept, timeout = 2000) {
  const deadline = Date.now() + timeout; let value;
  do { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.fail(`condition not reached: ${JSON.stringify(value)}`);
}
async function migrationCase(t, version) {
  const f = await brokerFixture(t); if (!f) return;
  const initializer = await connectBackend(f.config, { initialize: true }); await initializer.close();
  const nc = await connect({ servers: f.config.server, token: f.config.token }); t.after(() => nc.close());
  const kv = await new Kvm(nc).open('PM_CONTROL'); const groupId = randomUUID(); const peerId = randomUUID(); const leaseId = randomUUID(); const lastSeen = Date.now();
  const group = { authorityId: f.config.authorityId, id: groupId, label: `migration-${version}`, mode: 'paused', round: 0, limit: 0, used: 0 };
  const peer = { id: peerId, groupId, sessionId: `legacy-${version}`, displayName: `Legacy ${version}`, active: true, suspended: false, lastSeen, leaseId };
  const seeded = { version, authorityId: f.config.authorityId, sequence: 0, groups: { [groupId]: group }, peers: { [peerId]: peer }, ...(version === 3 ? { routes: {} } : {}), messages: {} };
  const initial = await kv.get('state'); await kv.update('state', JSON.stringify(seeded), initial.revision);
  const backend = await connectBackend(f.config); t.after(() => backend.close()); const afterConnect = await kv.get('state');
  assert.equal((await backend.peers(group))[0].lastSeen, lastSeen);
  assert.equal(await kv.get(`presence.${peerId}`), null);
  await backend.reattach(group, { peerId, leaseId }); await backend.heartbeat();
  assert.equal((await kv.get('state')).revision, afterConnect.revision);
  assert.equal((await kv.get(`presence.${peerId}`)).json().leaseId, leaseId);
}

test('concurrent heartbeats use independent presence keys without rewriting the ledger', { timeout: 20000 }, async t => {
  const f = await fixture(t, 12); if (!f) return;
  const before = await f.kv.get('state');
  for (let round = 0; round < 4; round++) await Promise.all(f.backends.map(backend => backend.heartbeat()));
  const after = await f.kv.get('state');
  assert.equal(after.revision, before.revision);
  const presenceKeys = await keys(f.kv, 'presence.>');
  assert.deepEqual(new Set(presenceKeys), new Set(f.backends.map(backend => `presence.${backend.peer.id}`)));
});

test('fresh matching presence governs online refusal and member expiry over an old ledger timestamp', async t => {
  const f = await fixture(t, 2); if (!f) return;
  const [owner, observer] = f.backends; const peer = owner.peer;
  const resume = await connectBackend(f.config); const takeover = await connectBackend(f.config);
  t.after(() => resume.close()); t.after(() => takeover.close());
  await owner.heartbeat();
  await updateState(f.kv, state => { state.peers[peer.id].lastSeen = Date.now() - 25 * 60 * 60 * 1000; });
  const listed = await eventually(() => observer.peers(f.group), peers => peers.find(item => item.id === peer.id)?.lastSeen > Date.now() - 30_000);
  assert.ok(listed.find(item => item.id === peer.id).active);
  assert.equal((await observer.getGroupSummary(f.group)).onlinePeers, 2);
  await assert.rejects(resume.resume(f.group, peer.id, peer.sessionId), /still online/i);
  await assert.rejects(takeover.takeover(f.group, peer.id, 'replacement'), /online member/i);
  await observer.maintain(f.group, Date.now());
  assert.equal((await observer.peers(f.group)).find(item => item.id === peer.id).active, true);
});

test('presence is ignored when its lease no longer matches the active ledger peer', async t => {
  const f = await fixture(t); if (!f) return;
  const [owner, observer] = f.backends; const peer = owner.peer; await owner.heartbeat();
  const ledgerSeen = Date.now() - 60_000;
  await updateState(f.kv, state => { state.peers[peer.id].leaseId = randomUUID(); state.peers[peer.id].lastSeen = ledgerSeen; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await observer.peers(f.group)).find(item => item.id === peer.id).lastSeen, ledgerSeen);
});

test('an old raw timestamp refreshes once for old clients while newer raw heartbeats remain authoritative', async t => {
  const f = await fixture(t); if (!f) return;
  const [owner, observer] = f.backends; const peer = owner.peer; await owner.heartbeat();
  await updateState(f.kv, state => { state.peers[peer.id].lastSeen = Date.now() - LEDGER_REFRESH_MS - 1; });
  const before = await f.kv.get('state'); await owner.heartbeat(); const refreshed = await f.kv.get('state');
  assert.equal(refreshed.revision, before.revision + 2, 'one presence put and one state put should advance the stream');
  const raw = refreshed.json(); validateLedger(raw, f.config.authorityId);
  assert.ok(raw.peers[peer.id].lastSeen > Date.now() - 30_000);
  await owner.heartbeat(); assert.equal((await f.kv.get('state')).revision, refreshed.revision);
  const oldClientSeen = Date.now() + 5_000;
  await updateState(f.kv, state => { state.peers[peer.id].lastSeen = oldClientSeen; });
  assert.equal((await eventually(() => observer.peers(f.group), peers => peers.find(item => item.id === peer.id)?.lastSeen === oldClientSeen)).find(item => item.id === peer.id).lastSeen, oldClientSeen);
  await owner.heartbeat('Renamed');
  assert.equal((await f.kv.get('state')).json().peers[peer.id].lastSeen, oldClientSeen);
});

test('v2 migration preserves lastSeen and starts presence without another state write', async t => migrationCase(t, 2));
test('v3 startup preserves lastSeen and starts presence without a state write', async t => migrationCase(t, 3));

test('reattach creates presence and leave removes it', async t => {
  const f = await fixture(t); if (!f) return;
  const owner = f.backends[0]; const peer = owner.peer; const lease = owner.lease;
  await owner.close();
  const replacement = await connectBackend(f.config); t.after(() => replacement.close());
  await replacement.reattach(f.group, lease);
  assert.equal((await f.kv.get(`presence.${peer.id}`)).json().leaseId, lease.leaseId);
  await replacement.leave();
  assert.equal(await f.kv.get(`presence.${peer.id}`), null);
});

test('executed prune removes presence for inactive and absent peers', async t => {
  const f = await fixture(t); if (!f) return;
  const [owner, departing] = f.backends; const departed = departing.peer; await departing.heartbeat();
  const absentId = randomUUID(); await f.kv.put(`presence.${absentId}`, JSON.stringify({ version: 1, peerId: absentId, leaseId: randomUUID(), lastSeen: Date.now() }));
  await updateState(f.kv, state => {
    const peer = state.peers[departed.id]; peer.active = false; peer.endedAt = Date.now(); peer.endReason = 'revoke'; peer.leaseId = randomUUID();
    state.routes = Object.fromEntries(Object.entries(state.routes).filter(([, route]) => route.fromPeerId !== departed.id && route.toPeerId !== departed.id));
  });
  await eventually(async () => {
    await owner.prune(f.group, true);
    return Promise.all([f.kv.get(`presence.${departed.id}`), f.kv.get(`presence.${absentId}`)]);
  }, entries => entries.every(entry => entry === null));
});
