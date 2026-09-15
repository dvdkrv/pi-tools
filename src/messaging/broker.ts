import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBackend } from './nats-backend.ts';
import { defaultAgentDir, markInitialized, prepareConfig } from './config.ts';
import { writeServerConfig } from './broker-lifecycle.ts';

/** Explicit foreground launcher. Never imported or invoked by the extension. */
export async function runBroker(agentDir: string, binary = 'nats-server', port = 4223): Promise<{ child: ChildProcess; done: Promise<number>; stop: () => Promise<void> }> {
  const config = prepareConfig(agentDir, port);
  const file = writeServerConfig(agentDir, config);
  const child = spawn(binary, ['-c', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  const done = new Promise<number>(resolve => child.once('close', code => resolve(code ?? 1)));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
    await done; clearTimeout(timer);
  };
  const onSignal = () => { void stop(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  void done.then(() => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Messaging broker startup timed out')), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Messaging broker exited (${code}) before readiness: ${output}`)); });
      child.stderr?.on('data', chunk => {
        output = (output + String(chunk)).slice(-8192);
        if (output.includes('Server is ready')) { clearTimeout(timeout); resolve(); }
      });
    });
    const backend = await connectBackend(config, { initialize: !config.initialized });
    await backend.close();
    if (!config.initialized) markInitialized(agentDir, config);
    return { child, done, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) throw new Error('Usage: npm run broker -- [--port 4223]');
    const port = args.length ? Number(args[1]) : 4223;
    const broker = await runBroker(defaultAgentDir(), process.env.NATS_SERVER || 'nats-server', port);
    console.log(`Messaging broker ready at nats://127.0.0.1:${port}. Ctrl+C stops this broker; persisted state is retained.`);
    process.exitCode = await broker.done;
  } catch (error) { console.error(error instanceof Error ? error.message : 'Messaging broker failed'); process.exitCode = 1; }
}
