// Parent mode: start a child that watches this process, print the child's PID, and exit without cleaning up.
// Child mode: run the watchdog with a short interval and exit when the parent is gone (or after 10 seconds).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'parent') {
  const child = spawn(process.execPath, [self, 'child'], { stdio: 'ignore', env: { ...process.env, WATCHDOG_PARENT: String(process.pid) } });
  process.stdout.write(`${child.pid}\n`);
  setTimeout(() => process.exit(0), 100);
} else {
  const { startWatchdog } = await createJiti(import.meta.url).import('../../../src/work/children/watchdog.ts');
  startWatchdog(() => process.exit(0), { parentPid: Number(process.env.WATCHDOG_PARENT), intervalMs: 50 });
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), 10_000);
}
