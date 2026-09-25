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
