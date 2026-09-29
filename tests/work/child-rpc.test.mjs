import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, readJsonl, tempDir, until } from './helpers.mjs';

const { spawnRpcChild } = await load('src/work/children/rpc.ts');
const FAKE = fileURLToPath(new URL('./fixtures/fake-rpc-child.mjs', import.meta.url));

function start(behavior = {}, command = [process.execPath, FAKE, '--mode', 'rpc']) {
  const log = join(tempDir(), 'child.jsonl');
  const child = spawnRpcChild(command, { cwd: tempDir(), env: { PATH: process.env.PATH, FAKE_CHILD: JSON.stringify(behavior), FAKE_CHILD_LOG: log } });
  const events = [];
  const exits = [];
  child.onEvent((event) => events.push(event));
  child.onExit((exit) => exits.push(exit));
  return { child, log, events, exits };
}

test('requests are correlated with their responses, and failed commands reject', async () => {
  const c = start({ sessionId: 'child-s1', onPrompt: 'hang' });
  assert.deepEqual(await c.child.request({ type: 'get_state' }), { sessionId: 'child-s1', isStreaming: false });
  await assert.rejects(c.child.request({ type: 'compact' }), /unsupported compact/);
  assert.equal(typeof c.child.pid, 'number');
  await c.child.shutdown(1000);
});

test('events stream after a prompt until agent_settled', async () => {
  const c = start();
  await c.child.request({ type: 'prompt', message: 'go' });
  await until(() => c.events.some((event) => event.type === 'agent_settled'));
  assert.deepEqual(c.events.map((event) => event.type), ['agent_start', 'message_end', 'agent_end', 'agent_settled']);
  assert.equal(c.events[1].message.usage.cost.total, 0.25);
  await c.child.shutdown(1000);
});

test('shutdown closes stdin and signals, and a cooperative child exits without SIGKILL', async () => {
  const c = start({ onPrompt: 'hang' });
  await c.child.request({ type: 'get_state' });
  const exit = await c.child.shutdown(5000);
  assert.notEqual(exit.signal, 'SIGKILL');
  assert.ok(readJsonl(c.log).some((entry) => entry.stdin === 'closed' || entry.signal === 'SIGTERM'));
  assert.equal(c.child.exited, true);
  await assert.rejects(c.child.request({ type: 'get_state' }), /not running/);
  assert.deepEqual(await c.child.shutdown(5000), exit);
});

test('a child that ignores stdin close and SIGTERM gets SIGKILL after the grace period', async () => {
  const c = start({ onPrompt: 'hang', ignoreStdinClose: true, ignoreTerm: true });
  await c.child.request({ type: 'get_state' });
  const started = Date.now();
  const exit = await c.child.shutdown(300);
  assert.equal(exit.signal, 'SIGKILL');
  assert.ok(Date.now() - started >= 250);
  const log = readJsonl(c.log);
  assert.ok(log.some((entry) => entry.stdin === 'closed'));
  assert.ok(log.some((entry) => entry.signal === 'SIGTERM'));
  assert.deepEqual(c.exits, [exit]);
});

test('a crash reports its exit and keeps the end of stderr', async () => {
  const c = start({ onPrompt: 'exit', exitCode: 3, stderr: 'boom: provider unreachable\n' });
  await c.child.request({ type: 'prompt', message: 'go' });
  await until(() => c.exits.length === 1);
  assert.deepEqual(c.exits[0], { code: 3, signal: null });
  assert.match(c.child.stderrTail(), /boom: provider unreachable/);
  const late = [];
  c.child.onExit((exit) => late.push(exit));
  assert.deepEqual(late, [{ code: 3, signal: null }]);
});

test('a missing executable rejects requests and reports the spawn error', async () => {
  const c = start({}, ['/nonexistent/pi', '--mode', 'rpc']);
  await assert.rejects(c.child.request({ type: 'get_state' }), /exited|not running/);
  await until(() => c.exits.length === 1);
  assert.match(c.child.stderrTail(), /ENOENT/);
});
