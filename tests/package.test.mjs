import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const extensions = [
  './extensions/claude-skill.ts',
  './extensions/loop.ts',
  './extensions/messaging.ts',
  './extensions/task.ts',
  './extensions/theme-sync.ts',
  './extensions/work.ts',
  './extensions/worktree-manager.ts',
];

test('root manifest exposes one Pi package', () => {
  assert.equal(pkg.name, 'pi-tools');
  assert.equal(pkg.version, '0.1.1');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.pi?.extensions, extensions);
  assert.equal(pkg.exports?.['./messaging/public'], './src/messaging/public.ts');
  assert.deepEqual(pkg.engines, { node: '>=22.19.0' });
});

test('Pi host imports are peers and NATS clients are runtime dependencies', () => {
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(pkg.peerDependencies?.[name], '*');
  }
  for (const name of ['@nats-io/transport-node', '@nats-io/jetstream', '@nats-io/kv']) {
    assert.equal(pkg.dependencies?.[name], '3.4.0');
  }
  assert.equal(pkg.devDependencies?.jiti, '2.7.0');
});


test('package resources exist', () => {
  for (const path of extensions) {
    assert.equal(existsSync(new URL(`..${path.slice(1)}`, import.meta.url)), true, path);
  }
});

test('public documentation covers installation and safety boundaries', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const name of ['claude-skill', 'loop', 'messaging', 'task', 'theme-sync', 'worktree-manager']) {
    assert.match(readme, new RegExp(name));
  }
  assert.match(readme, /full system access/i);
  assert.match(readme, /NATS Server 2\.14\.6/);
  assert.match(readme, /loopback/i);
  assert.match(readme, /human-controlled/i);
  assert.match(readme, /pi install git:git@github\.com:dvdkrv\/pi-tools\.git@v0\.1\.1/);
  assert.match(readme, /pi -e git:git@github\.com:dvdkrv\/pi-tools\.git@v0\.1\.1/);
});

test('root scripts include the production install matrix', () => {
  assert.equal(pkg.scripts?.['test:install'], 'node --test tests/install.test.mjs');
});

test('repository check exists and package boundary is flat', () => {
  assert.equal(existsSync(new URL('../scripts/check-repository.mjs', import.meta.url)), true);
  for (const path of ['pi-claude-bridge', 'pi-loop-package', 'pi-messaging', 'pi-task', 'pi-theme-sync', 'pi-worktree-core', 'pi-worktree-manager']) {
    assert.equal(existsSync(new URL(`../${path}/package.json`, import.meta.url)), false, path);
  }
});
