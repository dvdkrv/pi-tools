import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, symlink, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const { prepareConfig, readConfig, markInitialized, validateConfig } = await createJiti(import.meta.url).import('../../src/messaging/config.ts');
async function root(t) { const r = await mkdtemp(join(tmpdir(), 'pi-message-config-')); t.after(() => rm(r, { recursive: true, force: true })); return r; }

test('missing configuration is read-only; explicit setup creates private stable authority and token', async t => {
  const r = await root(t); assert.throws(() => readConfig(r));
  const config = prepareConfig(r, 4422);
  assert.equal(config.initialized, false); assert.equal(config.server, 'nats://127.0.0.1:4422');
  assert.equal((await stat(join(r, 'messaging'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(r, 'messaging/config.json'))).mode & 0o777, 0o600);
  markInitialized(r, config); assert.equal(readConfig(r).initialized, true);
  assert.equal(prepareConfig(r, 4422).authorityId, config.authorityId);
  assert.equal(prepareConfig(r, 4422).token, config.token);
});

test('unsafe permissions, symlinks, non-loopback endpoints, and malformed configuration fail closed', async t => {
  const r = await root(t); const c = prepareConfig(r, 4423);
  for (const server of ['nats://example.com:4222', 'nats://0.0.0.0:4222', 'nats://user:pass@127.0.0.1:4222', 'http://127.0.0.1:4222', 'nats://127.0.0.1:4222/?x=y']) assert.throws(() => validateConfig({ ...c, server }));
  assert.throws(() => validateConfig({ ...c, version: 2 }));
  await chmod(join(r, 'messaging/config.json'), 0o644); assert.throws(() => readConfig(r), /private|permissions/i);
  await chmod(join(r, 'messaging/config.json'), 0o600);
  const contents = await readFile(join(r, 'messaging/config.json'));
  await rm(join(r, 'messaging/config.json')); await writeFile(join(r, 'other.json'), contents);
  await symlink(join(r, 'other.json'), join(r, 'messaging/config.json')); assert.throws(() => readConfig(r), /symlink/i);
  const second = await root(t); await mkdir(join(second, 'elsewhere'));
  await symlink(join(second, 'elsewhere'), join(second, 'messaging')); assert.throws(() => prepareConfig(second, 4423), /symlink/i);
});
