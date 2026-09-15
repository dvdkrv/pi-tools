import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createJiti } from 'jiti';

const root = resolve(new URL('..', import.meta.url).pathname);
const extensions = [
  'claude-skill.ts',
  'loop.ts',
  'messaging.ts',
  'task.ts',
  'theme-sync.ts',
  'worktree-manager.ts',
];

function packageRoot(name) {
  const directory = join(root, 'node_modules', ...name.split('/'));
  const manifest = join(directory, 'package.json');
  if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).name !== name) {
    throw new Error(`Could not locate host package ${name}`);
  }
  return directory;
}

function linkPackage(installRoot, name, source) {
  const destination = join(installRoot, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  symlinkSync(source, destination, 'dir');
}

test('production install loads every extension using only host-provided Pi peers', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pi-tools-production-'));
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    for (const relative of tracked) {
      const source = join(root, relative);
      const destination = join(temporary, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true });
    }

    const install = spawnSync('npm', [
      'install',
      '--omit=dev',
      '--package-lock=false',
      '--ignore-scripts',
      '--legacy-peer-deps',
    ], {
      cwd: temporary,
      encoding: 'utf8',
      maxBuffer: 50 * 1024,
    });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`.slice(-50 * 1024));

    const codingAgent = packageRoot('@earendil-works/pi-coding-agent');
    for (const name of [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui',
      'typebox',
    ]) {
      linkPackage(temporary, name, packageRoot(name));
    }
    linkPackage(
      temporary,
      '@earendil-works/pi-agent-core',
      join(codingAgent, 'node_modules', '@earendil-works', 'pi-agent-core'),
    );

    const jiti = createJiti(join(temporary, 'production-load.mjs'));
    for (const extension of extensions) {
      const loaded = await jiti.import(join(temporary, 'extensions', extension));
      assert.equal(typeof loaded.default, 'function', extension);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
