import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SPECIFIERS = [
  /^\s*(?:import|export)\s[^'"]*?\sfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiers(file) {
  const source = readFileSync(file, 'utf8');
  return SPECIFIERS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

test('bin/work.ts and everything it imports use only Node built-ins, so the dashboard runs without Pi packages', () => {
  const seen = new Set();
  const bare = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith('.')) walk(resolve(dirname(file), specifier));
      else if (!specifier.startsWith('node:')) bare.set(specifier, file.slice(root.length));
    }
  };
  walk(resolve(root, 'bin/work.ts'));
  assert.ok(seen.has(resolve(root, 'src/work/dash/app.ts')), 'the dashboard is reachable from bin/work.ts');
  assert.deepEqual(Object.fromEntries(bare), {});
});
