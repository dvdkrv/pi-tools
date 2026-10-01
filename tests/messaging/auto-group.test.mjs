import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const p = await createJiti(import.meta.url).import('../../src/messaging/policy.ts');

function fixture(auto = true) {
  const state = p.newLedger(randomUUID());
  const group = p.createGroup(state, 'host', { auto });
  const a = p.joinPeer(state, group, { sessionId: 'a', displayName: 'Alice' }, 0);
  const b = p.joinPeer(state, group, { sessionId: 'b', displayName: 'Bob' }, 0);
  return { state, group, a, b };
}
const lease = peer => p.leaseOf(peer);
const notice = (f, key, now, options) => p.prepareMessage(f.state, lease(f.a), { kind: 'notice', toPeerId: f.b.id, text: key }, key, now, options);
const request = (f, key, now, options) => p.prepareMessage(f.state, lease(f.a), { kind: 'request', toPeerId: f.b.id, text: key }, key, now, options);

function terminalize(f, message, now) {
  p.resolveMessage(f.state, f.group, message.id, 'canceled', now);
}

test('auto groups spend and continuously refill each sender budget with a one-hour cap', () => {
  const f = fixture();
  const first = notice(f, 'first', 0, { sendsPerHour: 2 });
  assert.equal(f.a.credits, 1); assert.equal(f.a.creditsAt, 0);
  assert.equal(p.publicPeer(f.a).credits, 1); assert.equal(p.publicPeer(f.a).creditsAt, 0);
  terminalize(f, first, 0);
  const second = notice(f, 'second', 0, { sendsPerHour: 2 }); terminalize(f, second, 0);
  assert.equal(f.a.credits, 0);
  assert.throws(() => notice(f, 'spent', 0, { sendsPerHour: 2 }), error => {
    assert.equal(error.code, 'allowance');
    assert.equal(error.message, 'Messaging budget spent (2 sends per hour); the next send is possible in about 30 minute(s)');
    return true;
  });
  const refilled = notice(f, 'refilled', 30 * 60_000, { sendsPerHour: 2 }); terminalize(f, refilled, 30 * 60_000);
  assert.equal(f.a.credits, 0);
  assert.equal(p.peerCredits(f.a, 2, 90 * 60_000), 2, 'refill must hold no more than one hour of sends');
});

test('replies are free and an idempotent retry is not charged twice', () => {
  const f = fixture();
  const sent = request(f, 'request', 100, { sendsPerHour: 1 });
  assert.equal(f.a.credits, 0);
  assert.equal(request(f, 'request', 100, { sendsPerHour: 1 }).id, sent.id);
  assert.equal(f.a.credits, 0);
  const reservation = p.admit(f.state, lease(f.b), sent.id, 200); p.observe(f.state, lease(f.b), reservation, 300);
  f.b.credits = 0; f.b.creditsAt = 300;
  const reply = p.prepareMessage(f.state, lease(f.b), { kind: 'reply', toPeerId: f.a.id, text: 'done', inReplyTo: sent.id }, 'reply', 300, { sendsPerHour: 1 });
  assert.equal(reply.kind, 'reply'); assert.equal(f.b.credits, 0); assert.equal(f.b.creditsAt, 300);
});

test('auto admission ignores shared allowance without replaying an attempted inbox', () => {
  const f = fixture();
  const first = notice(f, 'first', 100);
  assert.equal(p.canReceive(f.state, lease(f.b), 101), true);
  const reservation = p.admit(f.state, lease(f.b), first.id, 102);
  assert.ok(reservation); assert.equal(reservation.round, 0);
  assert.deepEqual({ mode: f.state.groups[f.group.id].mode, limit: f.state.groups[f.group.id].limit, used: f.state.groups[f.group.id].used }, { mode: 'paused', limit: 0, used: 0 });
  assert.equal(p.canReceive(f.state, lease(f.b), 103), false);
  assert.deepEqual(p.admitBatch(f.state, lease(f.b), [], 103), []);
  p.observe(f.state, lease(f.b), reservation, 104);
  assert.equal(p.canReceive(f.state, lease(f.b), 105), true);
  assert.equal(p.summary(f.state, f.group).auto, true);
});

test('auto protocol closures record closedAt at every closure site', async t => {
  await t.test('notice and reply', () => {
    const noticeFixture = fixture(); notice(noticeFixture, 'notice', 111);
    assert.equal(noticeFixture.state.routes[p.routeKey(noticeFixture.b.id, noticeFixture.a.id)].closedAt, 111);

    const replyFixture = fixture(); const sent = request(replyFixture, 'request', 100);
    const admitted = p.admit(replyFixture.state, lease(replyFixture.b), sent.id, 200); p.observe(replyFixture.state, lease(replyFixture.b), admitted, 300);
    p.prepareMessage(replyFixture.state, lease(replyFixture.b), { kind: 'reply', toPeerId: replyFixture.a.id, text: 'done', inReplyTo: sent.id }, 'reply', 333);
    assert.equal(replyFixture.state.routes[p.routeKey(replyFixture.a.id, replyFixture.b.id)].closedAt, 333);
    assert.equal(replyFixture.state.routes[p.routeKey(replyFixture.b.id, replyFixture.a.id)].closedAt, 333);
  });

  await t.test('queued, attempted, and unanswered request expiry', () => {
    const queued = fixture(); request(queued, 'queued', 100);
    p.maintain(queued.state, 100 + p.QUEUED_TTL_MS);
    assert.equal(queued.state.routes[p.routeKey(queued.b.id, queued.a.id)].closedAt, 100 + p.QUEUED_TTL_MS);

    const attempted = fixture(); const attemptedRequest = request(attempted, 'attempted', 100);
    p.admit(attempted.state, lease(attempted.b), attemptedRequest.id, 200);
    p.maintain(attempted.state, 200 + p.ATTEMPT_TTL_MS);
    assert.equal(attempted.state.routes[p.routeKey(attempted.b.id, attempted.a.id)].closedAt, 200 + p.ATTEMPT_TTL_MS);

    const unanswered = fixture(); const unansweredRequest = request(unanswered, 'unanswered', 100);
    const reservation = p.admit(unanswered.state, lease(unanswered.b), unansweredRequest.id, 200); p.observe(unanswered.state, lease(unanswered.b), reservation, 300);
    p.maintain(unanswered.state, 300 + p.REPLY_TTL_MS);
    assert.equal(unanswered.state.routes[p.routeKey(unanswered.b.id, unanswered.a.id)].closedAt, 300 + p.REPLY_TTL_MS);
  });

  await t.test('canceled and dismissed requests', () => {
    const canceled = fixture(); const canceledRequest = request(canceled, 'canceled', 100);
    p.resolveMessage(canceled.state, canceled.group, canceledRequest.id, 'canceled', 500);
    assert.equal(canceled.state.routes[p.routeKey(canceled.b.id, canceled.a.id)].closedAt, 500);

    const dismissed = fixture(); const dismissedRequest = request(dismissed, 'dismissed', 100);
    p.admit(dismissed.state, lease(dismissed.b), dismissedRequest.id, 200);
    p.resolveMessage(dismissed.state, dismissed.group, dismissedRequest.id, 'dismissed', 600);
    assert.equal(dismissed.state.routes[p.routeKey(dismissed.b.id, dismissed.a.id)].closedAt, 600);
  });
});

test('cooldown reopens protocol closures but never a human-closed route', () => {
  const f = fixture(); notice(f, 'notice', 1_000);
  const protocolKey = p.routeKey(f.b.id, f.a.id);
  p.maintain(f.state, 1_599, { routeCooldownMs: 600 }); assert.equal(f.state.routes[protocolKey].mode, 'closed');
  p.maintain(f.state, 1_600, { routeCooldownMs: 600 });
  assert.deepEqual(f.state.routes[protocolKey], { groupId: f.group.id, fromPeerId: f.b.id, toPeerId: f.a.id, mode: 'open' });

  const humanKey = p.routeKey(f.a.id, f.b.id);
  p.setRoute(f.state, f.group, f.a.id, f.b.id, 'closed');
  assert.equal(f.state.routes[humanKey].closedAt, undefined);
  p.maintain(f.state, 10_000, { routeCooldownMs: 1 }); assert.equal(f.state.routes[humanKey].mode, 'closed');
});

test('ledger validation accepts only valid optional auto, budget, and closure fields', () => {
  const f = fixture(); notice(f, 'notice', 100, { sendsPerHour: 10 });
  assert.doesNotThrow(() => p.validateLedger(f.state, f.state.authorityId));
  const group = f.state.groups[f.group.id];
  assert.throws(() => p.validateLedger({ ...f.state, groups: { ...f.state.groups, [f.group.id]: { ...group, auto: 'yes' } } }, f.state.authorityId), /group|corrupt/i);
  assert.throws(() => p.validateLedger({ ...f.state, peers: { ...f.state.peers, [f.a.id]: { ...f.a, credits: Infinity } } }, f.state.authorityId), /peer|credit|corrupt/i);
  assert.throws(() => p.validateLedger({ ...f.state, peers: { ...f.state.peers, [f.a.id]: { ...f.a, creditsAt: NaN } } }, f.state.authorityId), /peer|credit|corrupt/i);
  const openKey = p.routeKey(f.a.id, f.b.id); const closedKey = p.routeKey(f.b.id, f.a.id);
  assert.throws(() => p.validateLedger({ ...f.state, routes: { ...f.state.routes, [openKey]: { ...f.state.routes[openKey], closedAt: 100 } } }, f.state.authorityId), /route|closed/i);
  assert.throws(() => p.validateLedger({ ...f.state, routes: { ...f.state.routes, [closedKey]: { ...f.state.routes[closedKey], closedAt: NaN } } }, f.state.authorityId), /route|closed/i);
  for (const sendsPerHour of [0, 1.5, 1001]) assert.throws(() => notice(fixture(), `bad-${sendsPerHour}`, 100, { sendsPerHour }), /sendsPerHour|validation/i);
});

test('auto groups allow 32 active peers while manual groups retain the 16-peer cap', () => {
  const auto = p.newLedger(randomUUID()); const autoGroup = p.createGroup(auto, 'host', { auto: true });
  for (let index = 0; index < 32; index++) p.joinPeer(auto, autoGroup, { sessionId: `auto-${index}`, displayName: `Auto ${index}` }, 0);
  assert.throws(() => p.joinPeer(auto, autoGroup, { sessionId: 'auto-32', displayName: 'Auto 32' }, 0), /full/i);

  const manual = p.newLedger(randomUUID()); const manualGroup = p.createGroup(manual, 'manual');
  for (let index = 0; index < 16; index++) p.joinPeer(manual, manualGroup, { sessionId: `manual-${index}`, displayName: `Manual ${index}` }, 0);
  assert.throws(() => p.joinPeer(manual, manualGroup, { sessionId: 'manual-16', displayName: 'Manual 16' }, 0), /full/i);
});

test('creating auto groups is sticky while manual group policy remains unchanged', () => {
  const f = fixture(false);
  assert.equal(p.summary(f.state, f.group).auto, false);
  assert.throws(() => notice(f, 'manual-before-arm', 100), /allowance/i);
  p.arm(f.state, f.group, 1);
  const sent = notice(f, 'manual', 100); const reservation = p.admit(f.state, lease(f.b), sent.id, 200);
  assert.ok(reservation); assert.equal(f.state.groups[f.group.id].used, 1);
  assert.equal(f.state.routes[p.routeKey(f.b.id, f.a.id)].closedAt, undefined);

  assert.deepEqual(p.createGroup(f.state, 'host', { auto: true }), f.group);
  assert.equal(f.state.groups[f.group.id].auto, true);
  assert.deepEqual({ mode: f.state.groups[f.group.id].mode, limit: f.state.groups[f.group.id].limit, used: f.state.groups[f.group.id].used }, { mode: 'paused', limit: 0, used: 0 });
});
