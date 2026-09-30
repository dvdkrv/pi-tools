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

test('messageCost prices zero-cost token usage and charges cache tokens at full input price', () => {
  assert.equal(messageCost(usage({ input: 100_000, output: 20_000, cacheRead: 30_000, cacheWrite: 50_000 }), { input: 4, output: 20 }), 1.12);
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
