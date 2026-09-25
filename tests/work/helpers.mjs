import { createJiti } from 'jiti';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
