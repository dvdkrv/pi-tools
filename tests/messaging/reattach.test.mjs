import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { brokerFixture } from './helpers/broker.mjs';
const { connectBackend } = await createJiti(import.meta.url).import('../../src/messaging/nats-backend.ts');

test('a fresh connection reattaches a still-current lease without a ledger write, and a rotated lease is refused', { timeout: 15000 }, async t => {
  const f = await brokerFixture(t); if (!f) return;
  const a = await connectBackend(f.config, { initialize: true }); t.after(() => a.close());
  const g = await a.createGroup('reattach'); const peer = await a.join(g, { sessionId: 'a', displayName: 'Alice' });
  const lease = a.lease; assert.equal(lease.peerId, peer.id); assert.match(lease.leaseId, /^[0-9a-f-]{36}$/);
  const before = await a.snapshot();
  const b = await connectBackend(f.config); t.after(() => b.close());
  const again = await b.reattach(g, lease);
  assert.equal(again.id, peer.id); assert.equal(b.peer.id, peer.id); assert.deepEqual(b.lease, lease);
  assert.equal((await b.snapshot()).revision, before.revision, 'reattach writes nothing to the shared ledger');
  await assert.rejects(b.reattach(g, lease), /Leave the current group/);

  const c = await connectBackend(f.config); t.after(() => c.close());
  await b.suspend(); // rotates the lease
  await assert.rejects(c.reattach(g, lease), error => error.code === 'participation');
  assert.equal(c.peer, undefined);
});
