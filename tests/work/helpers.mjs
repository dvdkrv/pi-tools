import { createJiti } from 'jiti';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jiti = createJiti(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

export const load = (path) => jiti.import(join(root, path));

export function clock(start = '2026-09-25T09:00:00.000Z') {
  let t = Date.parse(start);
  const fn = () => new Date(t);
  fn.advance = (ms) => { t += ms; };
  fn.set = (iso) => { t = Date.parse(iso); };
  return fn;
}

export const DAY = 86_400_000;

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'work-test-'));
}

export async function memoryStore(now = clock()) {
  const { WorkStore } = await load('src/work/store.ts');
  return WorkStore.open(':memory:', { now });
}

export async function memoryRuntime({ config, now = clock(), store, ...extra } = {}) {
  const { emptyConfig } = await load('src/work/config.ts');
  const { applyConfigProjects } = await load('src/work/runtime.ts');
  const s = store ?? await memoryStore(now);
  const cfg = config ?? emptyConfig();
  applyConfigProjects(s, cfg);
  const dataDir = tempDir();
  return {
    store: s,
    config: cfg,
    warnings: [],
    dataDir,
    backupDir: join(dataDir, 'backups'),
    knownProjects: () => new Set(s.listProjects().map((p) => p.slug)),
    ...extra,
  };
}

export function captureIo(answers = []) {
  const out = [];
  const err = [];
  const asked = [];
  return {
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      ask: async (question) => { asked.push(question); return answers.shift() ?? ''; },
    },
    out,
    err,
    asked,
  };
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// A committed repository on main with a local identity, no commit signing, and no hooks.
export function gitRepo(files = { 'README.md': 'hello\n' }) {
  const dir = realpathSync(tempDir());
  git(dir, 'init', '-q', '-b', 'main');
  configureGit(dir);
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export function configureGit(dir) {
  for (const [key, value] of [['user.email', 'pi@example.com'], ['user.name', 'Pi Test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) {
    git(dir, 'config', key, value);
  }
}

export function readJsonl(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

export async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
