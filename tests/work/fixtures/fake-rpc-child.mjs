// Stand-in for `pi --mode rpc` in the children tests. It speaks the RPC protocol on stdin and stdout, never calls
// a model, and appends its argv, cwd, PI_WORK_* environment, commands, stdin close, and signals to FAKE_CHILD_LOG.
// FAKE_CHILD holds a JSON behavior:
//   sessionId         returned by get_state (default "fake-<pid>")
//   onPrompt          "settle" (default): emit agent_start, one assistant message_end, agent_end, and agent_settled
//                     "model-error": settle with an assistant errorMessage; "hang": accept the prompt and do nothing;
//                     "exit": exit with exitCode shortly after accepting
//   errorMessage      assistant error for onPrompt "model-error"
//   exitCode          exit code for onPrompt "exit" (default 1)
//   commit            { file, text }: write the file in the cwd and commit it when the prompt arrives
//   settleOnFollowUp  emit agent_settled after a follow_up
//   ignoreStdinClose  keep running after stdin closes; ignoreTerm: keep running after SIGTERM
//   stderr            text written to stderr at startup
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const behavior = JSON.parse(process.env.FAKE_CHILD ?? '{}');
const log = (entry) => {
  if (process.env.FAKE_CHILD_LOG) appendFileSync(process.env.FAKE_CHILD_LOG, `${JSON.stringify(entry)}\n`);
};
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const workEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PI_WORK_')));
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: workEnv, pid: process.pid });
if (behavior.stderr) process.stderr.write(behavior.stderr);

process.on('SIGTERM', () => {
  log({ signal: 'SIGTERM' });
  if (!behavior.ignoreTerm) process.exit(143);
});

const settle = () => {
  send({ type: 'agent_start' });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { cost: { total: 0.25 } } } });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'agent_settled' });
};

const modelError = () => {
  send({ type: 'agent_start' });
  send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: behavior.errorMessage } });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'agent_settled' });
};

function handle(command) {
  log({ command });
  const reply = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, ...(data === undefined ? {} : { data }) });
  switch (command.type) {
    case 'get_state':
      reply({ sessionId: behavior.sessionId ?? `fake-${process.pid}`, isStreaming: false });
      return;
    case 'prompt':
      reply();
      if (behavior.commit) {
        writeFileSync(join(process.cwd(), behavior.commit.file), behavior.commit.text);
        execFileSync('git', ['add', '-A']);
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'child work']);
      }
      if ((behavior.onPrompt ?? 'settle') === 'settle') setTimeout(settle, 10);
      else if (behavior.onPrompt === 'model-error') setTimeout(modelError, 10);
      else if (behavior.onPrompt === 'exit') setTimeout(() => process.exit(behavior.exitCode ?? 1), 20);
      return;
    case 'follow_up':
      reply();
      if (behavior.settleOnFollowUp) setTimeout(settle, 10);
      return;
    case 'steer':
      reply();
      return;
    case 'abort':
      reply();
      setTimeout(() => {
        send({ type: 'agent_end', messages: [] });
        send({ type: 'agent_settled' });
      }, 10);
      return;
    default:
      send({ id: command.id, type: 'response', command: command.type, success: false, error: `unsupported ${command.type}` });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  log({ stdin: 'closed' });
  if (!behavior.ignoreStdinClose) process.exit(0);
});
setInterval(() => {}, 1000);
