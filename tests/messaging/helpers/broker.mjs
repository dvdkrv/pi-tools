import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
export async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
export async function brokerFixture(t) {
  const binary = process.env.NATS_SERVER || 'nats-server';
  if (spawnSync(binary, ['--version']).status !== 0) {
    if (process.env.PI_MESSAGING_REQUIRE_BROKER) throw new Error('NATS_SERVER must point to nats-server for the broker gate');
    t.skip('nats-server unavailable; run test:broker with NATS_SERVER'); return null;
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-messaging-test-'));
  const port = await freePort();
  const config = { version: 1, authorityId: randomUUID(), server: `nats://127.0.0.1:${port}`, token: randomBytes(32).toString('hex'), initialized: true };
  const file = join(root, 'server.json');
  await writeFile(file, JSON.stringify({ host: '127.0.0.1', port, authorization: { token: config.token }, max_payload: 4 * 1024 * 1024, jetstream: { store_dir: join(root, 'data'), max_file_store: 128 * 1024 * 1024, sync_interval: 'always' } }), { mode: 0o600 });
  let child;
  async function start() {
    child = spawn(binary, ['-c', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error(`Broker startup timeout: ${output}`)), 10000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Broker exited ${code}: ${output}`)); });
      child.stderr.on('data', b => { output += b; if (output.includes('Server is ready')) { clearTimeout(timer); resolve(); } });
    });
  }
  async function stop(signal = 'SIGTERM') { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(signal); await exited; } }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start(); return { config, root, start, stop };
}
