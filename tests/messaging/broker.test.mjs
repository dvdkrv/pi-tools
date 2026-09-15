import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';
import { freePort } from './helpers/broker.mjs';
const jiti = createJiti(import.meta.url);
const { readConfig } = await jiti.import('../../src/messaging/config.ts');
const { connectBackend } = await jiti.import('../../src/messaging/nats-backend.ts');

test('foreground bootstrap owns its child, authenticates clients and refuses lost initialized state', { timeout: 30000 }, async t => {
  const binary = process.env.NATS_SERVER || 'nats-server';
  if (spawnSync(binary, ['--version']).status !== 0) {
    if (process.env.PI_MESSAGING_REQUIRE_BROKER) throw new Error('NATS_SERVER required');
    t.skip('nats-server unavailable'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-broker-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await freePort();
  const args = ['--experimental-strip-types', fileURLToPath(new URL('../../src/messaging/broker.ts', import.meta.url)), '--port', String(port)];
  function start() {
    const child = spawn(process.execPath, args, { env: { ...process.env, PI_CODING_AGENT_DIR: root, NATS_SERVER: binary }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } });
    return child;
  }
  const child = start();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Broker readiness timeout')), 10000);
    let output = '';
    child.stdout.on('data', b => { output += b; if (output.includes('Messaging broker ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Bootstrap exited ${code}`)); });
    child.stderr.on('data', b => { output += b; });
  });
  const config = readConfig(root); assert.equal(config.initialized, true);
  await assert.rejects(connect({ servers: config.server, reconnect: false, timeout: 1000 }), /authorization|authentication/i);
  const backend = await connectBackend(config); const group = await backend.createGroup('durable'); await backend.arm(group, 2);
  const nc = await connect({ servers: config.server, token: config.token });
  await (await jetstreamManager(nc)).streams.delete('KV_PM_CONTROL'); await nc.close(); await backend.close();
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  const next = start(); const [code] = await once(next, 'exit'); assert.notEqual(code, 0);
  assert.equal(readConfig(root).authorityId, config.authorityId);
});
