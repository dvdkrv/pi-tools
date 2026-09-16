import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const p = await jiti.import('../../src/messaging/policy.ts');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fixture() {
  const state = p.newLedger(randomUUID());
  const group = p.createGroup(state, 'review');
  const a = p.joinPeer(state, group, { sessionId: 'session-a', displayName: 'Alice' });
  const b = p.joinPeer(state, group, { sessionId: 'session-b', displayName: 'Bob' });
  return { state, group, a, b };
}
function lease(peer) { return { peerId: peer.id, leaseId: peer.leaseId }; }
function send(f, key = randomUUID(), text = 'hello') {
  return p.prepareMessage(f.state, lease(f.a), { toPeerId: f.b.id, text }, key);
}
function addPeer(f, suffix) {
  return p.joinPeer(f.state, f.group, { sessionId: `session-${suffix}`, displayName: `Peer ${suffix}` });
}
function sendFrom(f, sender, key = randomUUID(), text = 'hello') {
  return p.prepareMessage(f.state, lease(sender), { toPeerId: f.b.id, text }, key);
}

test('joining cannot grant queue capacity; admissions consume a shared non-refilling budget', () => {
  const f = fixture();
  assert.throws(() => send(f), /allowance|capacity/i);
  p.arm(f.state, f.group, 2);
  const first = send(f);
  const r = p.admit(f.state, lease(f.b), first.id);
  assert.equal(f.state.groups[f.group.id].used, 1);
  assert.equal(p.admit(f.state, lease(f.b), first.id), null);
  const second = sendFrom(f, addPeer(f, 'c'));
  assert.equal(p.admit(f.state, lease(f.b), second.id), null, 'unresolved attempt gates recipient');
  p.observe(f.state, lease(f.b), r);
  assert.ok(p.admit(f.state, lease(f.b), second.id));
  assert.equal(f.state.groups[f.group.id].mode, 'exhausted');
  p.arm(f.state, f.group, 12);
  assert.equal(p.admit(f.state, lease(f.b), second.id), null, 'rearming cannot replay attempts');
});

test('send retries preserve identity after capacity closes while new sender work is bounded', () => {
  const f = fixture(); p.arm(f.state, f.group, 1);
  const m = send(f, 'call-1');
  assert.equal(send(f, 'call-1').id, m.id);
  assert.throws(() => send(f, 'call-1', 'changed'), /conflict/i);
  assert.throws(() => sendFrom(f, addPeer(f, 'c')), /allowance|capacity/i);
  assert.equal(send(f, 'call-1').id, m.id);
  assert.equal(Object.keys(f.state.messages).length, 1);
});

test('queued messages reserve allowance and cancellation releases it while pause preserves it', () => {
  const f = fixture(); const c = addPeer(f, 'c'); const d = addPeer(f, 'd');
  p.arm(f.state, f.group, 2); p.pause(f.state, f.group);
  const first = send(f, 'a-one');
  const second = sendFrom(f, c, 'c-one');
  assert.equal(f.state.groups[f.group.id].used, 0);
  assert.throws(() => sendFrom(f, d, 'd-one'), /allowance|capacity/i);
  p.resolveMessage(f.state, f.group, second.id, 'canceled');
  assert.ok(sendFrom(f, d, 'd-one'));
  assert.throws(() => p.arm(f.state, f.group, 1), /queued|allowance|limit/i);
  assert.equal(f.state.groups[f.group.id].limit, 2);
  assert.equal(f.state.messages[first.id].state, 'queued');
});

test('one sender may have only one unresolved outbound until it becomes terminal', () => {
  const f = fixture(); p.arm(f.state, f.group, 4);
  const first = send(f, 'first');
  assert.throws(() => send(f, 'second'), /sender|unresolved|busy/i);
  p.resolveMessage(f.state, f.group, first.id, 'canceled');
  const second = send(f, 'second'); const reservation = p.admit(f.state, lease(f.b), second.id);
  assert.throws(() => send(f, 'third'), /sender|unresolved|busy/i);
  p.observe(f.state, lease(f.b), reservation);
  assert.ok(send(f, 'third'));
});

test('one recipient accepts at most eight queued messages', () => {
  const f = fixture(); p.arm(f.state, f.group, 9);
  const senders = [f.a, ...Array.from({ length: 8 }, (_, i) => addPeer(f, `sender-${i}`))];
  for (let i = 0; i < 8; i++) assert.ok(sendFrom(f, senders[i], `message-${i}`));
  assert.throws(() => sendFrom(f, senders[8], 'message-8'), /eight|recipient|full/i);
  assert.equal(Object.values(f.state.messages).filter(m => m.state === 'queued').length, 8);
});

test('atomic batch admission preserves candidate order and spends one credit per message', () => {
  const f = fixture(); const c = addPeer(f, 'batch-c'); const d = addPeer(f, 'batch-d');
  p.arm(f.state, f.group, 3);
  const messages = [send(f, 'batch-a'), sendFrom(f, c, 'batch-c'), sendFrom(f, d, 'batch-d')];
  const batch = p.admitBatch(f.state, lease(f.b), messages.map(message => message.id));
  assert.deepEqual(batch.map(reservation => reservation.message.id), messages.map(message => message.id));
  assert.equal(new Set(batch.map(reservation => reservation.attemptId)).size, 3);
  assert.equal(f.state.groups[f.group.id].used, 3);
  assert.equal(f.state.groups[f.group.id].mode, 'exhausted');
  assert.ok(batch.every(reservation => reservation.round === f.state.groups[f.group.id].round));
});

test('batch admission validates bounds, skips terminal candidates, and honors remaining allowance', () => {
  const f = fixture(); const c = addPeer(f, 'batch-c'); const d = addPeer(f, 'batch-d');
  p.arm(f.state, f.group, 3);
  const terminal = send(f, 'terminal'); p.resolveMessage(f.state, f.group, terminal.id, 'canceled');
  const first = send(f, 'first'); const second = sendFrom(f, c, 'second'); const third = sendFrom(f, d, 'third');
  f.state.groups[f.group.id].limit = 2; // Simulate a retained pre-upgrade queue that exceeds a later allowance.
  assert.deepEqual(p.admitBatch(f.state, lease(f.b), []).map(r => r.message.id), []);
  assert.throws(() => p.admitBatch(f.state, lease(f.b), Array(9).fill(first.id)), /batch|validation/i);
  assert.throws(() => p.admitBatch(f.state, lease(f.b), [first.id, first.id]), /batch|duplicate|validation/i);
  const batch = p.admitBatch(f.state, lease(f.b), [terminal.id, first.id, second.id, third.id]);
  assert.deepEqual(batch.map(r => r.message.id), [first.id, second.id]);
  assert.equal(f.state.messages[third.id].state, 'queued');
  assert.equal(f.state.groups[f.group.id].used, 2);
});

test('an existing recipient attempt blocks a new batch and another inbox cannot be admitted', () => {
  const f = fixture(); const c = addPeer(f, 'batch-c'); const otherRecipient = addPeer(f, 'recipient');
  p.arm(f.state, f.group, 3);
  const attempted = send(f, 'attempted'); const firstReservation = p.admit(f.state, lease(f.b), attempted.id); assert.ok(firstReservation);
  const waiting = sendFrom(f, c, 'waiting');
  assert.deepEqual(p.admitBatch(f.state, lease(f.b), [waiting.id]), []);
  p.observe(f.state, lease(f.b), firstReservation);
  p.observe(f.state, lease(f.b), p.admit(f.state, lease(f.b), waiting.id));
  const sender = addPeer(f, 'other-sender');
  const other = p.prepareMessage(f.state, lease(sender), { toPeerId: otherRecipient.id, text: 'other inbox' }, 'other-inbox');
  assert.throws(() => p.admitBatch(f.state, lease(f.b), [other.id]), /inbox|recipient|corrupt/i);
});

test('batch observation validates every supplied correlation before mutating any member', () => {
  const f = fixture(); const c = addPeer(f, 'observe-c'); p.arm(f.state, f.group, 2);
  const messages = [send(f, 'observe-a'), sendFrom(f, c, 'observe-c')];
  const batch = p.admitBatch(f.state, lease(f.b), messages.map(message => message.id));
  const before = structuredClone(f.state);
  assert.throws(() => p.observeBatch(f.state, lease(f.b), [batch[0], { ...batch[1], attemptId: randomUUID() }]), /receipt/i);
  assert.deepEqual(f.state, before);
  assert.throws(() => p.observeBatch(f.state, lease(f.b), [batch[0], batch[0]]), /receipt|duplicate/i);
  assert.deepEqual(f.state, before);
  p.observeBatch(f.state, lease(f.b), batch);
  assert.ok(messages.every(message => f.state.messages[message.id].state === 'observed'));
});

test('batch observation preserves dismissal while recording observation', () => {
  const f = fixture(); p.arm(f.state, f.group, 1);
  const message = send(f, 'dismissed'); const batch = p.admitBatch(f.state, lease(f.b), [message.id]);
  p.resolveMessage(f.state, f.group, message.id, 'dismissed');
  p.observeBatch(f.state, lease(f.b), batch);
  assert.equal(f.state.messages[message.id].state, 'dismissed');
  assert.ok(f.state.messages[message.id].observedAt);
});

test('reject invalid bodies, names, groups, cross-group routing, replies, self-send and departed senders', () => {
  const f = fixture();
  for (const text of ['', '   ', '🙂'.repeat(2049)]) assert.throws(() => send(f, randomUUID(), text));
  for (const name of ['../bad', 'x.*', 'Upper', 'a'.repeat(49)]) assert.throws(() => p.createGroup(f.state, name));
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: 's', displayName: '\x1b[31mname' }));
  assert.throws(() => p.prepareMessage(f.state, lease(f.a), { toPeerId: f.a.id, text: 'x' }, 'self'));
  const g2 = p.createGroup(f.state, 'other');
  const outsider = p.joinPeer(f.state, g2, { sessionId: 's', displayName: 'Other' });
  assert.throws(() => p.prepareMessage(f.state, lease(f.a), { toPeerId: outsider.id, text: 'x' }, 'cross'));
  assert.throws(() => p.prepareMessage(f.state, lease(f.a), { toPeerId: f.b.id, text: 'x', inReplyTo: randomUUID() }, 'reply'));
  p.leavePeer(f.state, lease(f.a));
  assert.throws(() => send(f), /active|lease|participation/i);
});

test('membership and retained-group bounds reject overflow without changing existing state', () => {
  const f = fixture();
  for (let i = 2; i < 16; i++) p.joinPeer(f.state, f.group, { sessionId: `s-${i}`, displayName: `Peer ${i}` });
  assert.throws(() => p.joinPeer(f.state, f.group, { sessionId: 'extra', displayName: 'Extra' }), /full/i);
  assert.equal(Object.keys(f.state.peers).length, 16);
  for (let i = 1; i < 32; i++) p.createGroup(f.state, `group-${i}`);
  assert.throws(() => p.createGroup(f.state, 'extra'), /full/i);
  assert.equal(Object.keys(f.state.groups).length, 32);
  p.arm(f.state, f.group, 1);
  assert.ok(send(f, 'utf8-boundary', '🙂'.repeat(2048)));
  assert.equal(f.state.groups[f.group.id].used, 0);
});

test('pause, dismissal, and revocation cannot refund or replay; forged receipts fail', () => {
  const f = fixture(); p.arm(f.state, f.group, 3);
  const first = send(f); const r = p.admit(f.state, lease(f.b), first.id);
  assert.throws(() => p.observe(f.state, lease(f.b), { ...r, attemptId: randomUUID() }), /receipt/i);
  p.pause(f.state, f.group);
  p.resolveMessage(f.state, f.group, first.id, 'dismissed');
  p.observe(f.state, lease(f.b), r);
  assert.equal(f.state.messages[first.id].state, 'dismissed');
  assert.ok(f.state.messages[first.id].observedAt);
  assert.equal(f.state.groups[f.group.id].used, 1);
  const next = send(f); assert.equal(p.admit(f.state, lease(f.b), next.id), null);
  p.arm(f.state, f.group, 1); const departedLease = lease(f.b); p.leavePeer(f.state, departedLease);
  assert.throws(() => p.admit(f.state, departedLease, next.id), /participation|lease/i);
});

test('pruning preserves unresolved work and live-sender deduplication', () => {
  const f = fixture(); p.arm(f.state, f.group, 2);
  const canceled = send(f); p.resolveMessage(f.state, f.group, canceled.id, 'canceled');
  const queued = send(f);
  assert.deepEqual(p.prunable(f.state, f.group, Infinity), []);
  p.leavePeer(f.state, lease(f.a));
  assert.deepEqual(p.prunable(f.state, f.group, Infinity), [canceled.id]);
  assert.equal(f.state.messages[queued.id].state, 'queued');
});

test('lease rotation fences every old participant mutation after suspended recipient resume', () => {
  const f = fixture(); const senderLease = lease(f.a); const oldLease = lease(f.b);
  p.arm(f.state, f.group, 3);
  const first = send(f, 'before-suspend');
  p.suspendPeer(f.state, oldLease);
  assert.equal(f.state.peers[f.b.id].active, true);
  assert.equal(f.state.peers[f.b.id].suspended, true);
  assert.notEqual(f.state.peers[f.b.id].leaseId, oldLease.leaseId);
  const second = sendFrom(f, addPeer(f, 'while-suspended'), 'while-suspended');
  const third = sendFrom(f, addPeer(f, 'also-suspended'), 'also-suspended');
  const original = { id: f.b.id, sessionId: f.b.sessionId, displayName: f.b.displayName };
  const resumed = p.resumePeer(f.state, f.group, original.sessionId, original.id, 100_000);
  const resumedLease = p.leaseOf(resumed);
  assert.deepEqual({ id: resumed.id, sessionId: resumed.sessionId, displayName: resumed.displayName }, original);
  assert.notEqual(resumedLease.leaseId, oldLease.leaseId);
  assert.deepEqual(p.leaseOf(resumed), resumedLease);

  const beforeAdmission = structuredClone(f.state);
  assert.throws(() => p.admitBatch(f.state, oldLease, [first.id, second.id, third.id]), /participation|lease/i);
  assert.deepEqual(f.state, beforeAdmission, 'old-lease admission must spend no credit and mutate no message');
  const batch = p.admitBatch(f.state, resumedLease, [second.id, first.id, third.id]);
  assert.deepEqual(batch.map(item => item.message.id), [second.id, first.id, third.id]);
  assert.equal(f.state.groups[f.group.id].used, 3);

  const beforeOldOwner = structuredClone(f.state);
  for (const operation of [
    () => p.heartbeat(f.state, oldLease),
    () => p.heartbeat(f.state, oldLease, 'Hijacked Name'),
    () => p.prepareMessage(f.state, oldLease, { toPeerId: f.a.id, text: 'stale send' }, 'stale-send'),
    () => p.canReceive(f.state, oldLease),
    () => p.observeBatch(f.state, oldLease, batch),
    () => p.suspendPeer(f.state, oldLease),
    () => p.leavePeer(f.state, oldLease),
  ]) assert.throws(operation, /participation|lease/i);
  assert.deepEqual(f.state, beforeOldOwner, 'the old owner must mutate no participant or receipt state');
  assert.deepEqual(p.requireLease(f.state, resumedLease), resumed);
  p.observeBatch(f.state, resumedLease, batch);
  assert.ok(batch.every(item => f.state.messages[item.message.id].state === 'observed'));
  assert.equal(f.state.peers[f.b.id].displayName, original.displayName);
  assert.deepEqual(senderLease, lease(f.a));
});

test('human-confirmed takeover preserves a stale member id and fences its old session lease', () => {
  const f = fixture(); const oldLease = lease(f.b);
  f.b.lastSeen = 1_000;
  const taken = p.takeoverPeer(f.state, f.group, 'replacement-session', f.b.id, 40_001);
  assert.equal(taken.id, f.b.id);
  assert.equal(taken.sessionId, 'replacement-session');
  assert.equal(taken.displayName, 'Bob');
  assert.notEqual(taken.leaseId, oldLease.leaseId);
  assert.throws(() => p.heartbeat(f.state, oldLease), /lease|participation/i);
  assert.equal(f.state.routes[p.routeKey(f.a.id, f.b.id)].mode, 'open');
});

test('resume validates lifecycle attribution and serializes concurrent logical resumers', () => {
  const state = p.newLedger(randomUUID()); const group = p.createGroup(state, 'resume');
  const otherGroup = p.createGroup(state, 'resume-other');
  const peer = p.joinPeer(state, group, { sessionId: 'saved-session', displayName: 'Resumable' }, 70_000);
  const counters = structuredClone(state.groups);
  const beforeRejected = structuredClone(state);
  assert.throws(() => p.resumePeer(state, group, peer.sessionId, peer.id, 100_000), /online|participation/i, 'exactly 30 seconds remains online');
  assert.throws(() => p.resumePeer(state, group, 'wrong-session', peer.id, 100_001), /session|group|participation/i);
  assert.throws(() => p.resumePeer(state, otherGroup, peer.sessionId, peer.id, 100_001), /session|group|participation/i);
  assert.throws(() => p.resumePeer(state, group, peer.sessionId, randomUUID(), 100_001), /session|group|peer|participation/i);
  assert.deepEqual(state, beforeRejected);

  const resumed = p.resumePeer(state, group, peer.sessionId, peer.id, 100_001);
  const firstWinnerLease = p.leaseOf(resumed);
  assert.equal(resumed.lastSeen, 100_001);
  assert.throws(() => p.resumePeer(state, group, peer.sessionId, peer.id, 100_001), /online|participation/i);
  assert.deepEqual(p.leaseOf(state.peers[peer.id]), firstWinnerLease, 'a second logical resumer cannot rotate the winner lease');
  p.suspendPeer(state, firstWinnerLease);
  const resumedFromSuspension = p.resumePeer(state, group, peer.sessionId, peer.id, 100_001);
  assert.equal(resumedFromSuspension.suspended, false);
  const finalLease = p.leaseOf(resumedFromSuspension);
  p.leavePeer(state, finalLease);
  const beforeInactiveResume = structuredClone(state);
  assert.throws(() => p.resumePeer(state, group, peer.sessionId, peer.id, 200_000), /left|active|participation/i);
  assert.deepEqual(state, beforeInactiveResume);
  assert.deepEqual(state.groups, counters, 'resume/suspend/leave must not alter group counters');
});

test('suspended peers retain active slots and revoke finalizes only a group-attributed peer', () => {
  const f = fixture();
  for (let index = 2; index < 16; index++) addPeer(f, `slot-${index}`);
  const oldLease = lease(f.b); p.suspendPeer(f.state, oldLease);
  assert.equal(Object.values(f.state.peers).filter(peer => peer.groupId === f.group.id && peer.active).length, 16);
  assert.throws(() => addPeer(f, 'overflow'), /full/i);
  const resumed = p.resumePeer(f.state, f.group, f.b.sessionId, f.b.id, f.b.lastSeen);
  assert.equal(Object.values(f.state.peers).filter(peer => peer.groupId === f.group.id && peer.active).length, 16);

  const other = p.createGroup(f.state, 'revoke-other'); const beforeWrongGroup = structuredClone(f.state);
  assert.throws(() => p.revokePeer(f.state, other, resumed.id), /group|missing/i);
  assert.deepEqual(f.state, beforeWrongGroup);
  const currentLease = p.leaseOf(resumed); p.revokePeer(f.state, f.group, resumed.id);
  assert.equal(resumed.active, false); assert.equal(resumed.suspended, false);
  assert.notEqual(resumed.leaseId, currentLease.leaseId);
  assert.throws(() => p.requireLease(f.state, currentLease), /participation|lease/i);
});

test('batch admission remains blocked without refund when an attempted recipient resumes', () => {
  const f = fixture(); const waitingSender = addPeer(f, 'waiting'); p.arm(f.state, f.group, 3);
  const attempted = send(f, 'attempted-before-resume');
  const reservation = p.admit(f.state, lease(f.b), attempted.id); assert.ok(reservation);
  const waiting = sendFrom(f, waitingSender, 'queued-before-resume');
  const oldLease = lease(f.b); p.suspendPeer(f.state, oldLease);
  const resumed = p.resumePeer(f.state, f.group, f.b.sessionId, f.b.id, f.b.lastSeen);
  const before = structuredClone(f.state);
  assert.deepEqual(p.admitBatch(f.state, p.leaseOf(resumed), [waiting.id]), []);
  assert.deepEqual(f.state, before);
  assert.equal(f.state.messages[attempted.id].state, 'attempted');
  assert.equal(f.state.messages[attempted.id].attemptId, reservation.attemptId);
  assert.equal(f.state.groups[f.group.id].used, 1);
});

test('active stale and suspended recipients remain routable with exact queued-capacity reservation', () => {
  const f = fixture(); p.arm(f.state, f.group, 8);
  f.state.peers[f.b.id].lastSeen = 0;
  assert.equal(p.peerPresence(f.b, 30_001), 'stale');
  const senders = [f.a, ...Array.from({ length: 8 }, (_, index) => addPeer(f, `route-${index}`))];
  assert.ok(sendFrom(f, senders[0], 'stale-recipient'));
  p.suspendPeer(f.state, lease(f.b));
  for (let index = 1; index < 8; index++) assert.ok(sendFrom(f, senders[index], `suspended-recipient-${index}`));
  const before = structuredClone(f.state);
  assert.throws(() => sendFrom(f, senders[8], 'capacity-overflow'), /allowance|capacity|eight|full/i);
  assert.deepEqual(f.state, before);
  assert.equal(Object.values(f.state.messages).filter(message => message.recipientPeerId === f.b.id && message.state === 'queued').length, 8);
  assert.equal(f.state.groups[f.group.id].used, 0);
});

test('bare peer IDs never bypass exact lease authorization', () => {
  const f = fixture(); const before = structuredClone(f.state);
  for (const operation of [
    () => p.requireLease(f.state, f.a.id),
    () => p.heartbeat(f.state, f.a.id),
    () => p.prepareMessage(f.state, f.a.id, { toPeerId: f.b.id, text: 'bare send' }, 'bare-send'),
    () => p.canReceive(f.state, f.b.id),
    () => p.admitBatch(f.state, f.b.id, []),
    () => p.admit(f.state, f.b.id, randomUUID()),
    () => p.observeBatch(f.state, f.b.id, []),
    () => p.observeBatch(f.state, []),
    () => p.observe(f.state, f.b.id, {}),
    () => p.suspendPeer(f.state, f.a.id),
    () => p.leavePeer(f.state, f.a.id),
  ]) assert.throws(operation, /participation|lease/i);
  assert.deepEqual(f.state, before);
});

test('shared lifecycle timestamps reject non-finite values before mutation', () => {
  const state = p.newLedger(randomUUID()); const group = p.createGroup(state, 'timestamps');
  for (const now of [NaN, Infinity, -Infinity]) {
    const before = structuredClone(state);
    assert.throws(() => p.joinPeer(state, group, { sessionId: `invalid-${String(now)}`, displayName: 'Invalid Time' }, now), /validation|timestamp|time/i);
    assert.deepEqual(state, before);
  }
  const peer = p.joinPeer(state, group, { sessionId: 'valid-time', displayName: 'Valid Time' }, 0);
  const beforeResume = structuredClone(state);
  assert.throws(() => p.resumePeer(state, group, peer.sessionId, peer.id, NaN), /validation|timestamp|time/i);
  assert.deepEqual(state, beforeResume);
});

test('v1 ledger migration preserves every authoritative field and adds private leases', () => {
  const authorityId = randomUUID(); const groupId = randomUUID();
  const activeSenderId = randomUUID(); const activeRecipientId = randomUUID(); const inactiveId = randomUUID();
  const queuedId = randomUUID(); const attemptedId = randomUUID(); const observedId = randomUUID();
  const attemptedAttemptId = randomUUID(); const observedAttemptId = randomUUID();
  const v1 = {
    version: 1,
    authorityId,
    sequence: 3,
    groups: {
      [groupId]: { authorityId, id: groupId, label: 'legacy-review', mode: 'armed', round: 7, limit: 6, used: 2 },
    },
    peers: {
      [activeSenderId]: { id: activeSenderId, groupId, sessionId: 'active-sender-session', displayName: 'Active Sender', active: true, lastSeen: 1_000 },
      [activeRecipientId]: { id: activeRecipientId, groupId, sessionId: 'active-recipient-session', displayName: 'Active Recipient', active: true, lastSeen: 1_001 },
      [inactiveId]: { id: inactiveId, groupId, sessionId: 'inactive-session', displayName: 'Inactive Peer', active: false, lastSeen: 999 },
    },
    messages: {
      [queuedId]: {
        id: queuedId, sequence: 1, groupId, senderPeerId: activeSenderId, recipientPeerId: inactiveId,
        senderName: 'Active Sender', requestKey: 'queued-request-key', hash: '1'.repeat(64), createdAt: 1_010, state: 'queued',
      },
      [attemptedId]: {
        id: attemptedId, sequence: 2, groupId, senderPeerId: activeSenderId, recipientPeerId: activeRecipientId,
        senderName: 'Active Sender', requestKey: 'attempted-request-key', hash: '2'.repeat(64), createdAt: 1_020,
        state: 'attempted', inReplyTo: queuedId, attemptId: attemptedAttemptId, attemptRound: 7, attemptedAt: 1_021,
      },
      [observedId]: {
        id: observedId, sequence: 3, groupId, senderPeerId: inactiveId, recipientPeerId: activeSenderId,
        senderName: 'Inactive Peer', requestKey: 'observed-request-key', hash: '3'.repeat(64), createdAt: 1_030,
        state: 'observed', inReplyTo: attemptedId, attemptId: observedAttemptId, attemptRound: 6,
        attemptedAt: 1_031, observedAt: 1_032, terminalAt: 1_033,
      },
    },
  };
  const before = structuredClone(v1);

  const { ledger, migrated } = p.migrateLedger(v1, authorityId);
  assert.equal(migrated, true);
  assert.equal(ledger.version, 3);
  assert.deepEqual(ledger.groups, before.groups);
  assert.deepEqual(ledger.messages, Object.fromEntries(Object.entries(before.messages).map(([id, message]) => [id, { ...message, kind: 'legacy' }])));
  assert.deepEqual(Object.keys(ledger.routes).sort(), [p.routeKey(activeRecipientId, activeSenderId), p.routeKey(activeSenderId, activeRecipientId)].sort());
  assert.equal(ledger.sequence, before.sequence);
  for (const [id, oldPeer] of Object.entries(before.peers)) {
    assert.deepEqual(p.publicPeer(ledger.peers[id]), { ...oldPeer, suspended: false });
    assert.match(ledger.peers[id].leaseId, UUID_PATTERN);
  }
  assert.equal(ledger.peers[inactiveId].active, false);
  assert.deepEqual(v1, before, 'migration must not mutate its input');
  const current = p.migrateLedger(ledger, authorityId);
  assert.equal(current.migrated, false);
  assert.equal(current.ledger, ledger);
});

test('ledger versions and validators fail closed around migration boundaries', () => {
  const authorityId = randomUUID(); const groupId = randomUUID(); const peerId = randomUUID();
  const literalV1 = {
    version: 1, authorityId, sequence: 0,
    groups: { [groupId]: { authorityId, id: groupId, label: 'boundary', mode: 'paused', round: 0, limit: 0, used: 0 } },
    peers: { [peerId]: { id: peerId, groupId, sessionId: 'session', displayName: 'Peer', active: true, lastSeen: 10 } },
    messages: {},
  };
  const current = p.migrateLedger(literalV1, authorityId).ledger;
  assert.equal(p.newLedger(authorityId).version, 3);
  assert.throws(() => p.migrateLedger(literalV1, randomUUID()), /authority/i);
  for (const version of [0, 3, 900]) assert.throws(() => p.migrateLedger({ ...literalV1, version }, authorityId), /unsupported|corrupt|route/i);
  assert.throws(() => p.migrateLedger({ ...literalV1, peers: [] }, authorityId), /corrupt/i);
  assert.throws(() => p.migrateLedger({ ...current, messages: [] }, authorityId), /corrupt/i);
  assert.throws(() => p.migrateLedger({ ...current, peers: { [peerId]: { ...current.peers[peerId], suspended: undefined } } }, authorityId), /suspension|corrupt/i);
  assert.throws(() => p.migrateLedger({ ...current, peers: { [peerId]: { ...current.peers[peerId], leaseId: undefined } } }, authorityId), /lease|corrupt/i);
  assert.throws(() => p.migrateLedger({ ...current, peers: { [peerId]: { ...current.peers[peerId], active: false, suspended: true } } }, authorityId), /inactive|corrupt/i);

  const tooManyGroups = Object.fromEntries(Array.from({ length: 33 }, (_, index) => {
    const id = randomUUID();
    return [id, { authorityId, id, label: `group-${index}`, mode: 'paused', round: 0, limit: 0, used: 0 }];
  }));
  assert.throws(() => p.migrateLedger({ ...literalV1, groups: tooManyGroups, peers: {} }, authorityId), /bounds|corrupt/i);

  const messageId = randomUUID();
  const invalidAttempt = {
    ...literalV1,
    sequence: 1,
    messages: {
      [messageId]: {
        id: messageId, sequence: 1, groupId, senderPeerId: peerId, recipientPeerId: peerId,
        senderName: 'Peer', requestKey: 'attempt', hash: 'a'.repeat(64), createdAt: 11, state: 'attempted',
      },
    },
  };
  assert.throws(() => p.migrateLedger(invalidAttempt, authorityId), /attempt|corrupt/i);
});

test('peer presence distinguishes online, stale, suspended, and left peers', () => {
  const state = p.newLedger(randomUUID()); const group = p.createGroup(state, 'presence');
  const joined = p.joinPeer(state, group, { sessionId: 'session', displayName: 'Peer' }, 70_000);
  assert.equal(joined.suspended, false); assert.equal(joined.lastSeen, 70_000); assert.match(joined.leaseId, UUID_PATTERN);
  const peer = p.publicPeer(joined);
  assert.equal(Object.hasOwn(peer, 'leaseId'), false);
  assert.equal(p.peerPresence(peer, 100_000), 'online');
  assert.equal(p.peerPresence({ ...peer, lastSeen: 69_999 }, 100_000), 'stale');
  assert.equal(p.peerPresence({ ...peer, suspended: true }, 100_000), 'suspended');
  assert.equal(p.peerPresence({ ...peer, active: false, suspended: false }, 100_000), 'left');
});

test('v3 ledger gives current member pairs open directional routes and migrates old messages as legacy', () => {
  const authorityId = randomUUID();
  const state = p.newLedger(authorityId);
  assert.equal(state.version, 3);
  const group = p.createGroup(state, 'protocol');
  const a = p.joinPeer(state, group, { sessionId: 'a', displayName: 'A' }, 100);
  const b = p.joinPeer(state, group, { sessionId: 'b', displayName: 'B' }, 101);
  assert.equal(state.routes[p.routeKey(a.id, b.id)].mode, 'open');
  assert.equal(state.routes[p.routeKey(b.id, a.id)].mode, 'open');

  const current = structuredClone(state);
  const v2 = { ...current, version: 2 };
  delete v2.routes;
  for (const peer of Object.values(v2.peers)) {
    delete peer.suspendedAt; delete peer.endedAt; delete peer.endReason;
  }
  const migrated = p.migrateLedger(v2, authorityId, 1_000);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.ledger.version, 3);
  assert.equal(migrated.ledger.routes[p.routeKey(a.id, b.id)].mode, 'open');
});

test('summaries omit bodies and authority mismatch or invalid state fails closed', () => {
  const f = fixture(); p.arm(f.state, f.group, 1); send(f, 'key', 'secret-body');
  assert.equal(JSON.stringify(p.summary(f.state, f.group)).includes('secret-body'), false);
  assert.throws(() => p.summary(f.state, { ...f.group, authorityId: randomUUID() }), /authority/i);
  assert.throws(() => p.validateLedger({ ...f.state, version: 900 }, f.state.authorityId));
  for (const field of ['groups', 'peers', 'messages']) assert.throws(() => p.validateLedger({ ...p.newLedger(f.state.authorityId), [field]: [] }, f.state.authorityId));
  f.state.groups[f.group.id].used = -1;
  assert.throws(() => p.validateLedger(f.state, f.state.authorityId));
  assert.equal(p.safeText('\x1b[31mhello\u202e'), '\\u001b[31mhello\\u202e');
  assert.equal(p.safeText('a\rb\tc\nend'), 'a\\u000db\\u0009c\nend');
});
