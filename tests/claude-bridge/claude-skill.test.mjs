import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const mod = await jiti.import('../../extensions/claude-skill.ts');

test('/claude-skill rejects non-TUI invocation before discovery or launch', async () => {
  let handler;
  const notifications = [];
  mod.default({
    registerCommand(_name, options) { handler = options.handler; },
  });

  await handler('', {
    mode: 'rpc',
    cwd: '/not/a/repository',
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  });

  assert.deepEqual(notifications, [{
    message: '/claude-skill is available only in interactive TUI mode',
    level: 'error',
  }]);
});

test('parseFrontmatter extracts skill name and description', () => {
  assert.deepEqual(mod.parseSkillFrontmatter(`---\nname: systematic-debugging\ndescription: Use when debugging failures\n---\n# Body\n`), {
    name: 'systematic-debugging',
    description: 'Use when debugging failures',
  });
});

test('discoverClaudeSkills finds skills in configured roots and sorts by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-skills-'));
  await mkdir(join(root, '.claude', 'skills', 'z-skill'), { recursive: true });
  await mkdir(join(root, '.agents', 'skills', 'a-skill'), { recursive: true });
  await writeFile(join(root, '.claude', 'skills', 'z-skill', 'SKILL.md'), `---\nname: z-skill\ndescription: Z desc\n---\n`);
  await writeFile(join(root, '.agents', 'skills', 'a-skill', 'SKILL.md'), `---\nname: a-skill\ndescription: A desc\n---\n`);

  assert.deepEqual(await mod.discoverClaudeSkills([join(root, '.claude', 'skills'), join(root, '.agents', 'skills')]), [
    { name: 'a-skill', description: 'A desc', path: join(root, '.agents', 'skills', 'a-skill', 'SKILL.md') },
    { name: 'z-skill', description: 'Z desc', path: join(root, '.claude', 'skills', 'z-skill', 'SKILL.md') },
  ]);
});

test('parseClaudeSkillArgs recognizes direct skill invocation', () => {
  assert.deepEqual(mod.parseClaudeSkillArgs('systematic-debugging investigate pipx'), {
    skillName: 'systematic-debugging',
    prompt: 'investigate pipx',
  });
});

test('buildClaudePrompt formats skill command with optional args', () => {
  assert.equal(mod.buildClaudePrompt('systematic-debugging', 'investigate pipx'), '/skill:systematic-debugging investigate pipx');
  assert.equal(mod.buildClaudePrompt('systematic-debugging', ''), '/skill:systematic-debugging');
});

test('tmuxLaunchCommand splits inside tmux and creates session outside tmux', () => {
  assert.deepEqual(mod.tmuxLaunchCommand({ cwd: '/repo', skillName: 'systematic-debugging', prompt: 'investigate pipx', insideTmux: true }), {
    command: 'tmux',
    args: ['split-window', '-h', '-c', '/repo', "claude '/skill:systematic-debugging investigate pipx'"],
    description: 'Started Claude skill systematic-debugging in a tmux pane',
  });

  assert.deepEqual(mod.tmuxLaunchCommand({ cwd: '/repo', skillName: 'systematic-debugging', prompt: '', insideTmux: false }), {
    command: 'tmux',
    args: ['new-session', '-d', '-s', 'claude-systematic-debugging', '-c', '/repo', 'claude /skill:systematic-debugging'],
    description: 'Started tmux session claude-systematic-debugging. Attach with: tmux attach -t claude-systematic-debugging',
  });
});
