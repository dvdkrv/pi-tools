import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { BrokerConfig } from './contracts.ts';
import { fail } from './policy.ts';

export function defaultAgentDir(): string { return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'); }
export function validateConfig(value: unknown): asserts value is BrokerConfig {
  const c = value as BrokerConfig;
  if (!c || c.version !== 1 || !/^[0-9a-f-]{36}$/.test(c.authorityId) || !/^[0-9a-f]{64}$/.test(c.token) || typeof c.initialized !== 'boolean' || typeof c.server !== 'string' || !/^nats:\/\/127\.0\.0\.1:[0-9]+$/.test(c.server)) fail('configuration', 'Invalid messaging configuration; v1 requires a token-authenticated loopback broker');
  const url = new URL(c.server); const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('configuration', 'Invalid broker port');
}
export function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail('configuration', 'Messaging path must not be a symlink');
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail('configuration', 'Messaging path must have private owner-only permissions');
}
export function messagingDir(agentDir: string, create = false): string {
  if (create) mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const root = join(realpathSync(agentDir), 'messaging');
  if (create && !existsSync(root)) mkdirSync(root, { mode: 0o700 });
  privatePath(root, true); return root;
}
export function readConfig(agentDir: string): BrokerConfig {
  const file = join(messagingDir(agentDir), 'config.json'); privatePath(file, false);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).size > 4096) fail('configuration', 'Messaging config is too large');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8')); validateConfig(value); return value;
  } finally { closeSync(fd); }
}
export function prepareConfig(agentDir: string, port = 4223): BrokerConfig {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('configuration', 'Invalid broker port');
  const dir = messagingDir(agentDir, true); const file = join(dir, 'config.json');
  const value: BrokerConfig = { version: 1, authorityId: randomUUID(), server: `nats://127.0.0.1:${port}`, token: randomBytes(32).toString('hex'), initialized: false };
  try { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const config = readConfig(agentDir);
  if (config.server !== value.server) fail('configuration', 'Existing broker uses a different port; use its configured port');
  return config;
}
export function markInitialized(agentDir: string, config: BrokerConfig): void {
  const current = readConfig(agentDir);
  if (current.authorityId !== config.authorityId || current.token !== config.token) fail('authority', 'Messaging configuration changed during bootstrap');
  const dir = messagingDir(agentDir); const temp = join(dir, `config-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify({ ...current, initialized: true }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, join(dir, 'config.json'));
}
