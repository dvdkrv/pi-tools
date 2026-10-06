import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { MessagingError } = await jiti.import('../../src/messaging/contracts.ts');
const { backoffDelay, isRecoverable } = await jiti.import('../../src/messaging/recovery.ts');

test('backoff delay uses bounded jitter and caps at sixty seconds', () => {
  assert.equal(backoffDelay(0, () => 0), 750);
  assert.equal(backoffDelay(0, () => 1), 1000);
  assert.equal(backoffDelay(3, () => 0.5), 7000);
  assert.equal(backoffDelay(6, () => 0), 45000);
  assert.equal(backoffDelay(20, () => 1), 60000);
  assert.ok(backoffDelay(20, () => 0.999999) <= 60000);
});

test('only transport-like and transient messaging errors are recoverable', () => {
  assert.equal(isRecoverable(new Error('socket reset')), true);
  for (const code of ['uncertain', 'unavailable', 'contended']) assert.equal(isRecoverable(new MessagingError(code, code)), true, code);
  for (const code of ['busy', 'participation', 'authority', 'corrupt', 'configuration', 'missing', 'full', 'validation', 'route', 'allowance']) {
    assert.equal(isRecoverable(new MessagingError(code, code)), false, code);
  }
});
