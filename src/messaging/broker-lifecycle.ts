import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrokerConfig } from './contracts.ts';
import { defaultAgentDir, markInitialized, messagingDir, prepareConfig, privatePath, readConfig, validateConfig } from './config.ts';
import { connectBackend } from './nats-backend.ts';
import { fail, safeText } from './policy.ts';

export interface EnsureBrokerOptions {
  agentDir?: string;
  binary?: string;
  port?: number;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
}
export type BrokerReadiness = 'ready' | 'unavailable';

const unavailablePattern = /ECONNREFUSED|connection refused|TIMEOUT|timed out|no servers available/i;
const stateNames = ['data', 'server.json', 'broker.log', 'broker-process.json', 'startup.lock'];
const lifecycleFiles = ['server.json', 'broker.log', 'broker-process.json', 'startup.lock'];

function writePrivate(path: string, value: string): void {
  if (existsSync(path)) privatePath(path, false);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
}

function writePrivateJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { closeSync(fd); }
  try {
    if (existsSync(path)) privatePath(path, false);
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

export function writeServerConfig(agentDir: string, config: BrokerConfig): string {
  validateConfig(config);
  const dir = messagingDir(agentDir); const data = join(dir, 'data');
  if (!existsSync(data)) mkdirSync(data, { mode: 0o700 });
  privatePath(data, true);
  const file = join(dir, 'server.json');
  writePrivate(file, JSON.stringify({
    host: '127.0.0.1',
    port: Number(new URL(config.server).port),
    authorization: { token: config.token },
    max_payload: 4 * 1024 * 1024,
    jetstream: {
      store_dir: data,
      max_file_store: 128 * 1024 * 1024,
      sync_interval: 'always',
    },
  }));
  return file;
}

function isUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return unavailablePattern.test(text);
}

export async function probeBroker(config: BrokerConfig, timeoutMs = 500): Promise<BrokerReadiness> {
  validateConfig(config);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50) fail('validation', 'Broker probe timeout must be finite and at least 50ms');
  try {
    const backend = await connectBackend(config, { timeoutMs });
    await backend.close();
    return 'ready';
  } catch (error) {
    if (isUnavailable(error)) return 'unavailable';
    throw error;
  }
}

async function initializeOrProbe(agentDir: string, config: BrokerConfig, timeoutMs: number): Promise<BrokerReadiness> {
  if (config.initialized) return probeBroker(config, timeoutMs);
  try {
    const backend = await connectBackend(config, { initialize: true, timeoutMs });
    await backend.close();
    markInitialized(agentDir, config);
    return 'ready';
  } catch (error) {
    if (isUnavailable(error)) return 'unavailable';
    throw error;
  }
}

function pathLexicallyExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function validateLifecyclePrivacy(agentDir: string): BrokerConfig {
  const config = readConfig(agentDir);
  const dir = messagingDir(agentDir);
  for (const name of lifecycleFiles) {
    const path = join(dir, name);
    if (pathLexicallyExists(path)) privatePath(path, false);
  }
  const data = join(dir, 'data');
  if (pathLexicallyExists(data)) privatePath(data, true);
  return config;
}

function readyResult(agentDir: string, state: 'running' | 'started', expected: BrokerConfig): { state: 'running' | 'started'; config: BrokerConfig } {
  const config = validateLifecyclePrivacy(agentDir);
  if (!config.initialized || config.authorityId !== expected.authorityId || config.token !== expected.token || config.server !== expected.server) {
    fail('authority', 'Messaging configuration changed during broker readiness');
  }
  return { state, config };
}

function loadOrCreateConfig(agentDir: string, port: number | undefined): BrokerConfig {
  try {
    const config = readConfig(agentDir);
    if (port !== undefined && Number(new URL(config.server).port) !== port) fail('configuration', 'Existing broker uses a different port; use its configured port');
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const dir = join(agentDir, 'messaging');
    if (stateNames.some(name => pathLexicallyExists(join(dir, name)))) fail('configuration', 'Messaging configuration is missing while broker state exists; refusing replacement authority');
    return prepareConfig(agentDir, port ?? 4223);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try { child.kill('SIGTERM'); } catch { return; }
  const graceful = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { return; }
    await exited;
  }
}

async function waitForReady(agentDir: string, child: ChildProcess, timeoutMs: number, probeTimeoutMs: number): Promise<BrokerConfig> {
  let stopped = false;
  let reportChildFailure!: (error: Error) => void;
  const childFailure = new Promise<Error>(resolve => { reportChildFailure = resolve; });
  const onError = (error: Error) => reportChildFailure(new Error(`Could not spawn nats-server: ${safeText(error.message)}`));
  const onExit = (code: number | null) => reportChildFailure(new Error(`nats-server exited (${code ?? 1}) before readiness`));
  child.once('error', onError);
  child.once('exit', onExit);

  const readiness = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (!stopped && Date.now() < deadline) {
      const config = readConfig(agentDir);
      if (await initializeOrProbe(agentDir, config, probeTimeoutMs) === 'ready') return readConfig(agentDir);
      if (!stopped) await delay(50);
    }
    throw new Error(stopped ? 'Messaging broker startup canceled' : 'Messaging broker startup timed out');
  })();
  const outcome = await Promise.race([
    readiness.then(config => ({ kind: 'ready' as const, config }), error => ({ kind: 'readiness-failure' as const, error })),
    childFailure.then(error => ({ kind: 'child-failure' as const, error })),
  ]);
  stopped = true;
  child.off('error', onError);
  child.off('exit', onExit);
  if (outcome.kind === 'ready') return outcome.config;
  if (outcome.kind === 'child-failure') await readiness.catch(() => {});
  throw outcome.error;
}

export async function ensureBroker(options: EnsureBrokerOptions = {}): Promise<{ state: 'running' | 'started'; config: BrokerConfig }> {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const binary = options.binary ?? process.env.NATS_SERVER ?? 'nats-server';
  const probeTimeoutMs = options.probeTimeoutMs ?? 500;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs < 50 || !Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 250) fail('validation', 'Invalid broker startup timeout');

  let config = loadOrCreateConfig(agentDir, options.port);
  if (config.initialized && await probeBroker(config, probeTimeoutMs) === 'ready') {
    return readyResult(agentDir, 'running', config);
  }

  const dir = messagingDir(agentDir); const lock = join(dir, 'startup.lock');
  const deadline = Date.now() + startupTimeoutMs;
  let ownedLock: { dev: number; ino: number } | undefined;
  while (!ownedLock) {
    try {
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
        const lockStat = fstatSync(fd); ownedLock = { dev: lockStat.dev, ino: lockStat.ino };
      } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = readConfig(agentDir);
      let readiness: BrokerReadiness | undefined; let probeError: unknown;
      try { readiness = await probeBroker(current, probeTimeoutMs); }
      catch (probeFailure) { probeError = probeFailure; }
      let stale;
      try {
        privatePath(lock, false);
        stale = statSync(lock);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw inspectionError;
      }
      if (readiness === 'ready' && current.initialized) return readyResult(agentDir, 'running', current);
      if (Date.now() - stale.mtimeMs > startupTimeoutMs) {
        // Reclaim only after an unavailable probe; reachable or malformed brokers keep their owner's lock.
        if (probeError) throw probeError;
        if (readiness === 'unavailable') {
          try {
            const currentLock = lstatSync(lock);
            if (currentLock.dev === stale.dev && currentLock.ino === stale.ino) unlinkSync(lock);
          } catch (inspectionError) {
            if ((inspectionError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectionError;
          }
          continue;
        }
      }
      if (Date.now() >= deadline) fail('busy', 'Messaging broker startup is already in progress');
      await delay(50);
    }
  }

  let child: ChildProcess | undefined;
  let logFd: number | undefined;
  try {
    config = readConfig(agentDir);
    if (await probeBroker(config, probeTimeoutMs) === 'ready') {
      validateLifecyclePrivacy(agentDir);
      if (!config.initialized) markInitialized(agentDir, config);
      return readyResult(agentDir, 'running', config);
    }
    const serverFile = writeServerConfig(agentDir, config);
    const log = join(dir, 'broker.log');
    if (existsSync(log)) privatePath(log, false);
    logFd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    child = spawn(binary, ['-c', serverFile], { detached: true, stdio: ['ignore', logFd, logFd] });
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve);
      child!.once('error', error => reject(new Error(`Could not spawn nats-server: ${safeText(error.message)}`)));
    });
    if (!Number.isSafeInteger(child.pid)) throw new Error('Could not spawn nats-server');
    writePrivateJson(join(dir, 'broker-process.json'), { pid: child.pid, startedAt: Date.now(), server: config.server });
    const ready = await waitForReady(agentDir, child, Math.max(250, deadline - Date.now()), probeTimeoutMs);
    child.unref();
    return readyResult(agentDir, 'started', ready);
  } catch (error) {
    if (child) await stopChild(child);
    throw error;
  } finally {
    if (logFd !== undefined) closeSync(logFd);
    try {
      const currentLock = lstatSync(lock);
      if (currentLock.dev === ownedLock.dev && currentLock.ino === ownedLock.ino) unlinkSync(lock);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
