import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { priceFor, messageCost } = await load('src/work/children/pricing.ts');

const usage = (overrides = {}) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...overrides,
});

test('priceFor prefers an exact model and supports glob keys', () => {
  const pricing = {
    'gateway-*/provider/model': { input: 1, output: 2 },
    'gateway-prod/provider/model': { input: 3, output: 4 },
    'gateway-*/provider/model.v2': { input: 5, output: 6 },
  };
  assert.deepEqual(priceFor(pricing, 'gateway-prod/provider/model'), { input: 3, output: 4 });
  assert.deepEqual(priceFor(pricing, 'gateway-dev/provider/model'), { input: 1, output: 2 });
  assert.equal(priceFor(pricing, 'gateway-dev/provider/modelXv2'), undefined);
  assert.equal(priceFor(pricing, 'other/provider/model'), undefined);
});

test('messageCost uses a reported positive cost before configured pricing', () => {
  assert.equal(messageCost(usage({ cost: { total: 0.25 } }), undefined), 0.25);
});

test('messageCost prices cache reads and writes at their own rates', () => {
  // 0.1M input * 4 + 0.03M cache read * 0.4 + 0.05M cache write * 5 + 0.02M output * 20
  const price = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
  assert.equal(messageCost(usage({ input: 100_000, output: 20_000, cacheRead: 30_000, cacheWrite: 50_000 }), price), 1.062);
});

test('messageCost defaults cache reads to 10% and cache writes to 125% of the input price', () => {
  assert.equal(messageCost(usage({ cacheRead: 1_000_000 }), { input: 4, output: 20 }), 0.4);
  assert.equal(messageCost(usage({ cacheWrite: 1_000_000 }), { input: 4, output: 20 }), 5);
});

test('a cache-heavy child run is no longer overestimated about fivefold', () => {
  // Token counts from a real gateway child run that hit the old cap: ~$5.58 at full input price.
  const run = usage({ input: 36, cacheRead: 1_168_974, cacheWrite: 188_255, output: 7_394 });
  const cost = messageCost(run, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  assert.ok(cost > 1.5 && cost < 1.6, String(cost));
});

test('messageCost is unknown only when nonzero token usage has no price', () => {
  assert.equal(messageCost(usage({ input: 1 }), undefined), 'unknown');
  assert.equal(messageCost(usage(), undefined), 0);
});

test('messageCost tolerates missing or malformed usage fields from the child process', () => {
  assert.equal(messageCost(undefined, undefined), 0);
  assert.equal(messageCost({ input: 1_000_000 }, { input: 4, output: 20 }), 4);
  assert.equal(messageCost({ output: 'x', input: -5, cost: null }, undefined), 0);
  assert.equal(messageCost({ output: 10 }, undefined), 'unknown');
});
