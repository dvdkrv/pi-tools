import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { connect } from '@nats-io/transport-node';
import { jetstreamManager } from '@nats-io/jetstream';
import { createJiti } from 'jiti';
import { freePort } from './helpers/broker.mjs';

const jiti = createJiti(import.meta.url);
const { ensureBroker, probeBroker, writeServerConfig } = await jiti.import('../../src/messaging/broker-lifecycle.ts');
const { runBroker } = await jiti.import('../../src/messaging/broker.ts');
const { prepareConfig, readConfig } = await jiti.import('../../src/messaging/config.ts');

const binary = process.env.NATS_SERVER || 'nats-server';
function requireBroker(t) {
  if (spawnSync(binary, ['--version']).status === 0) return true;
  if (process.env.PI_MESSAGING_REQUIRE_BROKER) throw new Error('NATS_SERVER required');
  t.skip('nats-server unavailable'); return false;
}
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stopPid(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  await until(() => !alive(pid), `broker ${pid} exit`);
}
async function isolatedRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-messaging-autostart-'));
  const port = await freePort(); const ownedChildren = [];
  t.after(async () => {
    for (const { child, processFile } of ownedChildren) {
      try {
        const { pid } = JSON.parse(await readFile(processFile, 'utf8'));
        if (pid === child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
        }
      } catch {}
    }
    try {
      const value = JSON.parse(await readFile(join(root, 'messaging', 'broker-process.json'), 'utf8'));
      if (Number.isSafeInteger(value.pid)) await stopPid(value.pid);
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { root, port, trackChild(child, processFile) { ownedChildren.push({ child, processFile }); } };
}
async function configBytes(root) {
  return readFile(join(root, 'messaging', 'config.json'));
}
async function runContenders(options, count, fixture = {}) {
  const children = Array.from({ length: count }, (_, index) => {
    const child = fork(
      fixture.module ?? new URL('./helpers/autostart-contender.mjs', import.meta.url),
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    fixture.onChild?.(child, index);
    return child;
  });
  const exits = children.map(child => new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', () => child.once('close', resolve));
  }));
  const completions = children.map(child => new Promise((resolve, reject) => {
    let result; let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', value => {
      if (result !== undefined) reject(new Error('Contender returned more than one result'));
      result = value;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal) reject(new Error(`Contender exited ${signal ?? code}: ${stderr}`));
      else if (result === undefined) reject(new Error(`Contender exited without a result: ${stderr}`));
      else resolve(result);
    });
  }));
  for (const [index, child] of children.entries()) child.send(typeof options === 'function' ? options(index) : options);
  const settled = await Promise.allSettled(completions);
  await Promise.all(exits);
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map(result => result.value);
}
async function assertConfigUnchanged(root, before) {
  assert.deepEqual(await configBytes(root), before);
}
async function startRawBroker(t, serverFile, processFile, registerCleanup = true) {
  const child = spawn(binary, ['-c', serverFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (registerCleanup) t.after(async () => {
    try {
      const { pid } = JSON.parse(await readFile(processFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid === child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      }
    } catch {}
  });
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error(output || 'broker timeout')), 5000);
    child.stderr.on('data', chunk => { output += chunk; if (output.includes('Server is ready')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`broker exited ${code}: ${output}`)); });
  });
  return child;
}
async function startForeign(t, root, port) {
  const config = prepareConfig(root, port);
  const foreignRoot = await mkdtemp(join(tmpdir(), 'pi-messaging-foreign-'));
  const serverFile = join(foreignRoot, 'server.json');
  await writeFile(serverFile, JSON.stringify({
    host: '127.0.0.1', port,
    authorization: { token: 'f'.repeat(64) },
    jetstream: { store_dir: join(foreignRoot, 'data') },
  }), { mode: 0o600 });
  const child = await startRawBroker(t, serverFile, join(foreignRoot, 'broker-process.json'));
  await writeFile(join(foreignRoot, 'broker-process.json'), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
  t.after(() => rm(foreignRoot, { recursive: true, force: true }));
  return config;
}

// These are real-process tests: every detached PID is scoped to, read from, and
// cleaned up through broker-process.json beneath its own temporary agent root.
test('healthy authenticated broker is an autostart no-op', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const foreground = await runBroker(f.root, binary, f.port);
  t.after(() => foreground.stop());
  const before = await stat(join(f.root, 'messaging', 'server.json'));
  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port });
  assert.equal(result.state, 'running');
  assert.equal((await stat(join(f.root, 'messaging', 'server.json'))).mtimeMs, before.mtimeMs);
  assert.equal(await probeBroker(result.config), 'ready');
});

test('ensureBroker starts a detached private broker', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port });
  assert.equal(result.state, 'started');
  assert.equal(readConfig(f.root).initialized, true);
  for (const name of ['config.json', 'server.json', 'broker.log', 'broker-process.json']) {
    assert.equal((await stat(join(f.root, 'messaging', name))).mode & 0o777, 0o600);
  }
  const processInfo = JSON.parse(await readFile(join(f.root, 'messaging', 'broker-process.json'), 'utf8'));
  assert.deepEqual(Object.keys(processInfo).sort(), ['pid', 'server', 'startedAt']);
  assert.equal((await readFile(join(f.root, 'messaging', 'broker.log'), 'utf8')).includes(result.config.token), false);
  assert.equal(alive(processInfo.pid), true);
});

test('healthy exact state repairs an uninitialized marker under startup ownership', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const foreground = await runBroker(f.root, binary, f.port);
  t.after(() => foreground.stop());
  const config = readConfig(f.root);
  await writeFile(
    join(f.root, 'messaging', 'config.json'),
    `${JSON.stringify({ ...config, initialized: false }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port });

  assert.equal(result.state, 'running');
  assert.equal(result.config.initialized, true);
  assert.equal(readConfig(f.root).initialized, true);
  await assert.rejects(lstat(join(f.root, 'messaging', 'startup.lock')), /ENOENT/);
});

test('startup repairs the crash window after exact state persisted before its initialized marker', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const foreground = await runBroker(f.root, binary, f.port);
  await foreground.stop();
  const config = readConfig(f.root);
  await writeFile(
    join(f.root, 'messaging', 'config.json'),
    `${JSON.stringify({ ...config, initialized: false }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port });

  assert.equal(result.state, 'started');
  assert.equal(result.config.initialized, true);
  assert.equal(readConfig(f.root).initialized, true);
  await assert.rejects(lstat(join(f.root, 'messaging', 'startup.lock')), /ENOENT/);
});

test('healthy broker rejects group-readable lifecycle paths', { timeout: 30_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const foreground = await runBroker(f.root, binary, f.port);
  t.after(() => foreground.stop());
  const dir = join(f.root, 'messaging');
  await writeFile(join(dir, 'broker.log'), '', { mode: 0o600 });
  await writeFile(join(dir, 'broker-process.json'), '{}\n', { mode: 0o600 });
  await writeFile(join(dir, 'startup.lock'), '{}\n', { mode: 0o600 });
  const cases = [
    ['messaging root', dir, 0o700, 0o750],
    ['config.json', join(dir, 'config.json'), 0o600, 0o640],
    ['server.json', join(dir, 'server.json'), 0o600, 0o640],
    ['broker.log', join(dir, 'broker.log'), 0o600, 0o640],
    ['broker-process.json', join(dir, 'broker-process.json'), 0o600, 0o640],
    ['startup.lock', join(dir, 'startup.lock'), 0o600, 0o640],
    ['data', join(dir, 'data'), 0o700, 0o750],
  ];
  for (const [name, path, privateMode, unsafeMode] of cases) await t.test(name, async () => {
    await chmod(path, unsafeMode);
    try {
      await assert.rejects(
        ensureBroker({ agentDir: f.root, binary, port: f.port }),
        /private|permissions|configuration/i,
      );
    } finally {
      await chmod(path, privateMode);
    }
  });
});

test('healthy broker rejects symlinked lifecycle paths', { timeout: 30_000 }, async t => {
  if (!requireBroker(t)) return;
  for (const name of ['server.json', 'startup.lock', 'data']) await t.test(name, async t => {
    const f = await isolatedRoot(t);
    const foreground = await runBroker(f.root, binary, f.port);
    t.after(() => foreground.stop());
    const path = join(f.root, 'messaging', name);
    const target = join(f.root, 'messaging', `${name}.target`);
    if (name === 'startup.lock') await writeFile(path, '{}\n', { mode: 0o600 });
    await rename(path, target);
    await symlink(target, path);

    await assert.rejects(
      ensureBroker({ agentDir: f.root, binary, port: f.port }),
      /symlink|private|configuration/i,
    );
  });
});

test('probeBroker rejects non-finite and sub-50ms timeouts', async t => {
  const f = await isolatedRoot(t);
  const config = prepareConfig(f.root, f.port);
  for (const timeoutMs of [49, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => probeBroker(config, timeoutMs), /timeout|validation/i);
  }
});

test('concurrent starter processes elect one broker authority that outlives them', { timeout: 30_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const contend = async () => (await runContenders({ agentDir: f.root, binary, port: f.port }, 1))[0];
  const results = await runContenders({ agentDir: f.root, binary, port: f.port }, 8);
  assert.equal(results.filter(result => result.state === 'started').length, 1);
  assert.equal(new Set(results.map(result => result.authorityId)).size, 1);
  assert.equal((await contend()).state, 'running');
  assert.equal(await probeBroker(readConfig(f.root)), 'ready');
  const processFile = join(f.root, 'messaging', 'broker-process.json');
  assert.equal(alive(JSON.parse(await readFile(processFile, 'utf8')).pid), true);
});

test('runContenders settles every child exit before propagating a failure', { timeout: 5000 }, async () => {
  let exits = 0;
  await assert.rejects(
    runContenders(
      index => ({ delayMs: [10, 250, 500][index], fail: index === 0 }),
      3,
      {
        module: new URL('./helpers/contender-completion.mjs', import.meta.url),
        onChild: child => child.once('exit', () => { exits++; }),
      },
    ),
    /planned contender failure/,
  );
  assert.equal(exits, 3);
});

test('missing binary fails without replacing configuration authority', { timeout: 15_000 }, async t => {
  const f = await isolatedRoot(t); prepareConfig(f.root, f.port); const before = await configBytes(f.root);
  await assert.rejects(
    ensureBroker({ agentDir: f.root, binary: join(f.root, 'missing-nats'), port: f.port, startupTimeoutMs: 1000 }),
    /spawn|ENOENT|nats-server|binary/i,
  );
  await assertConfigUnchanged(f.root, before);
});

test('a different-token process occupying the port fails closed', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t); await startForeign(t, f.root, f.port); const before = await configBytes(f.root);
  await assert.rejects(
    ensureBroker({ agentDir: f.root, binary, port: f.port, startupTimeoutMs: 1000 }),
    /authentication|authorization|permissions/i,
  );
  await assertConfigUnchanged(f.root, before);
});

test('initialized configuration with missing streams is never reinitialized', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t); const config = prepareConfig(f.root, f.port);
  await writeFile(join(f.root, 'messaging', 'config.json'), `${JSON.stringify({ ...config, initialized: true }, null, 2)}\n`, { mode: 0o600 });
  const before = await configBytes(f.root); const serverFile = writeServerConfig(f.root, readConfig(f.root));
  const rawProcessFile = join(f.root, 'messaging', 'raw-broker-process.json');
  const child = await startRawBroker(t, serverFile, rawProcessFile, false);
  await writeFile(rawProcessFile, JSON.stringify({ pid: child.pid }), { mode: 0o600 }); f.trackChild(child, rawProcessFile);
  await assert.rejects(ensureBroker({ agentDir: f.root, binary, port: f.port }), /stream|bucket|not found|missing/i);
  await assertConfigUnchanged(f.root, before);
});

test('uninitialized persisted partial stream state fails closed after broker start', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t); const config = prepareConfig(f.root, f.port);
  const before = await configBytes(f.root); const serverFile = writeServerConfig(f.root, config);
  const rawProcessFile = join(f.root, 'messaging', 'raw-broker-process.json');
  const child = await startRawBroker(t, serverFile, rawProcessFile, false);
  await writeFile(rawProcessFile, JSON.stringify({ pid: child.pid }), { mode: 0o600 }); f.trackChild(child, rawProcessFile);
  const nc = await connect({ servers: config.server, token: config.token, reconnect: false });
  try {
    await (await jetstreamManager(nc)).streams.add({
      name: 'PM_MESSAGES', subjects: ['pm.message.>'], storage: 'file', retention: 'limits', discard: 'new',
      max_msgs: 2000, max_bytes: 32 * 1024 * 1024, max_msg_size: 65536, max_age: 0, max_consumers: 512,
    });
  } finally { await nc.close(); }
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;

  await assert.rejects(
    ensureBroker({ agentDir: f.root, binary, port: f.port }),
    /partial|incompatible|stream|bucket|missing/i,
  );
  await assertConfigUnchanged(f.root, before);
  assert.equal(readConfig(f.root).initialized, false);
});

test('symlink lock, server, and log paths fail without replacing configuration', { timeout: 15_000 }, async t => {
  for (const name of ['startup.lock', 'server.json', 'broker.log']) {
    await t.test(name, async t => {
      const f = await isolatedRoot(t); prepareConfig(f.root, f.port); const before = await configBytes(f.root);
      const target = join(f.root, `${name}.target`); await writeFile(target, 'sentinel', { mode: 0o600 });
      await symlink(target, join(f.root, 'messaging', name));
      await assert.rejects(
        ensureBroker({ agentDir: f.root, binary, port: f.port, startupTimeoutMs: 500 }),
        /symlink|private|ELOOP|configuration/i,
      );
      assert.equal(await readFile(target, 'utf8'), 'sentinel');
      await assertConfigUnchanged(f.root, before);
    });
  }
});

test('group-readable messaging files fail closed', { timeout: 15_000 }, async t => {
  for (const name of ['config.json', 'startup.lock', 'server.json', 'broker.log']) {
    await t.test(name, async t => {
      const f = await isolatedRoot(t); prepareConfig(f.root, f.port);
      const path = join(f.root, 'messaging', name);
      if (name !== 'config.json') await writeFile(path, '{}', { mode: 0o600 });
      const before = await configBytes(f.root); await chmod(path, 0o640);
      await assert.rejects(
        ensureBroker({ agentDir: f.root, binary, port: f.port, startupTimeoutMs: 500 }),
        /private|permissions|configuration/i,
      );
      await assertConfigUnchanged(f.root, before);
    });
  }
});

test('a stale private startup lock is reclaimed only after an unavailable probe', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t); prepareConfig(f.root, f.port);
  const lock = join(f.root, 'messaging', 'startup.lock');
  await writeFile(lock, JSON.stringify({ pid: 999999, createdAt: 1 }), { mode: 0o600 });
  await utimes(lock, new Date(0), new Date(0));
  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port, startupTimeoutMs: 1000 });
  assert.equal(result.state, 'started');
  await assert.rejects(lstat(lock), /ENOENT/);
});

test('waiter preserves an old owned lock while readiness is ready and uninitialized', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t);
  const foreground = await runBroker(f.root, binary, f.port);
  t.after(() => foreground.stop());
  const config = readConfig(f.root);
  await writeFile(
    join(f.root, 'messaging', 'config.json'),
    `${JSON.stringify({ ...config, initialized: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const lock = join(f.root, 'messaging', 'startup.lock');
  const lockBytes = `${JSON.stringify({ pid: process.pid, createdAt: 1 })}\n`;
  await writeFile(lock, lockBytes, { mode: 0o600 });
  await utimes(lock, new Date(0), new Date(0));

  await assert.rejects(
    ensureBroker({ agentDir: f.root, binary, port: f.port, probeTimeoutMs: 50, startupTimeoutMs: 250 }),
    /already in progress|busy/i,
  );
  assert.equal(await readFile(lock, 'utf8'), lockBytes);
  assert.equal(readConfig(f.root).initialized, false);
});

test('readiness stops after child failure and cannot initialize after lock release', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t); const config = prepareConfig(f.root, f.port);
  const before = await configBytes(f.root); const serverFile = writeServerConfig(f.root, config);
  const failingBinary = join(f.root, 'fail-after-start');
  await writeFile(failingBinary, '#!/bin/sh\nsleep 0.2\nexit 1\n', { mode: 0o700 });
  await assert.rejects(
    ensureBroker({ agentDir: f.root, binary: failingBinary, port: f.port, probeTimeoutMs: 100, startupTimeoutMs: 1500 }),
    /exited.*before readiness/i,
  );
  await assert.rejects(lstat(join(f.root, 'messaging', 'startup.lock')), /ENOENT/);

  const rawProcessFile = join(f.root, 'messaging', 'raw-broker-process.json');
  const child = await startRawBroker(t, serverFile, rawProcessFile, false);
  await writeFile(rawProcessFile, JSON.stringify({ pid: child.pid }), { mode: 0o600 }); f.trackChild(child, rawProcessFile);
  await new Promise(resolve => setTimeout(resolve, 350));
  await assertConfigUnchanged(f.root, before);
  assert.equal(readConfig(f.root).initialized, false);
});

test('waiter retries when startup lock disappears during its probe', { timeout: 15_000 }, async t => {
  if (!requireBroker(t)) return;
  const f = await isolatedRoot(t); prepareConfig(f.root, f.port);
  const lock = join(f.root, 'messaging', 'startup.lock');
  await writeFile(lock, JSON.stringify({ pid: 999999, createdAt: Date.now() }), { mode: 0o600 });

  const sockets = new Set(); let connections = 0; let released = false;
  const blocker = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    connections++;
    if (connections === 2) {
      setTimeout(() => { void unlink(lock).then(() => { released = true; }); }, 75);
      setTimeout(() => { blocker.close(); }, 100);
    }
  });
  blocker.listen(f.port, '127.0.0.1'); await once(blocker, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
  });

  const result = await ensureBroker({ agentDir: f.root, binary, port: f.port, probeTimeoutMs: 200, startupTimeoutMs: 3000 });
  assert.equal(released, true);
  assert.equal(result.state, 'started');
});

test('probe rejects relaxed configured stream resource limits', { timeout: 30_000 }, async t => {
  if (!requireBroker(t)) return;
  const cases = [
    ['message max consumers', 'PM_MESSAGES', { max_consumers: 513 }],
    ['KV maximum bytes', 'KV_PM_CONTROL', { max_bytes: 16 * 1024 * 1024 }],
    ['KV maximum value size', 'KV_PM_CONTROL', { max_msg_size: 3 * 1024 * 1024 }],
  ];
  for (const [name, stream, update] of cases) await t.test(name, async t => {
    const f = await isolatedRoot(t); const foreground = await runBroker(f.root, binary, f.port);
    t.after(() => foreground.stop());
    const config = readConfig(f.root);
    const nc = await connect({ servers: config.server, token: config.token, reconnect: false });
    try { await (await jetstreamManager(nc)).streams.update(stream, update); }
    finally { await nc.close(); }
    await assert.rejects(probeBroker(config), /Unsafe or incompatible broker stream configuration/i);
  });
});
