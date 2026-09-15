import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
const paths = [...new Set(output.split('\0').filter(Boolean))].sort();
const privateNames = new Set(['config.json', 'server.json', 'broker.log', 'broker-process.json']);
const forbidden = [
  { name: 'organization identifier', pattern: new RegExp(['Data', 'Dog'].join(''), 'i') },
  { name: 'organization shorthand', pattern: new RegExp(['d', 'dog'].join(''), 'i') },
  { name: 'workspace home path', pattern: /\/home\/bits/ },
  { name: 'personal macOS home path', pattern: /\/Users\/david\.kirov/ },
  { name: 'private key material', pattern: new RegExp(['BEGIN OPENSSH', 'PRIVATE KEY'].join(' ')) },
  { name: 'broker token near control subject', pattern: new RegExp(['PM_', 'CONTROL.*token'].join(''), 'i') },
];
const failures = [];

for (const relative of paths) {
  const path = resolve(root, relative);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) failures.push(`${relative}: tracked symlink`);
  if (relative.split('/').includes('node_modules')) failures.push(`${relative}: tracked node_modules`);
  if (privateNames.has(basename(relative))) failures.push(`${relative}: private-state filename`);
  if (!stat.isFile()) continue;

  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) failures.push(`${relative}: ${rule.name}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`repository-boundary-ok files=${paths.length}`);
}
