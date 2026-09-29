import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const guards = await load('src/work/children/guards.ts');

const EXPENSIVE = {
  'npm test': true, 'npm run test': true, 'pnpm test': true, 'yarn test': true, 'npm test -- tests/a.test.mjs': false,
  'cd pkg && npm test 2>&1 | tail -5': true, 'CI=1 npm test': true, 'npm test > out.txt': true,
  pytest: true, 'pytest -x -q': true, 'pytest tests/test_a.py': false, 'pytest tests/test_a.py::test_b -x': false, 'python -m pytest': true, 'uv run pytest -q': true,
  'go test ./...': true, 'go test -race ./...': true, 'go test ./pkg/...': false,
  'cargo test': true, 'cargo test --release': true, 'cargo test -p core': false, 'cargo test --package core': false, 'cargo test parse_': false,
  'bazel test //...': true, 'bazel test //pkg/...': false,
  'make test': true, 'make test FILE=a': false,
  tox: true, 'tox -p': true, 'tox -e py311': false,
  'ddev test': true, 'ddev test -c': true, 'ddev test mycheck': false,
  'node --test tests/work/a.test.mjs': false, 'echo npm test': false,
};

const RESTRICTED = {
  'git push': /git push/, 'git push origin HEAD': /git push/, 'git -C /src/api push': /git push/, 'git status && git push': /git push/,
  'git remote add up x': /remotes/, 'git remote set-url origin y': /remotes/,
  'gh pr create --draft': /gh pr/, 'gh pr view 1': /gh pr/, 'gh api -X POST repos/x': /gh api/, 'gh api --method=PATCH x': /gh api/, 'gh api repos/x -f a=b': /gh api/,
  'git reset --hard HEAD~1': /history/, 'git rebase -i HEAD~2': /history/, 'git commit --amend': /history/, 'git commit -m x --amend --no-edit': /history/,
  'git switch main': /branches/, 'git checkout main': /branches/, 'git checkout -b other': /branches/,
  'npm install left-pad': /dependency/, 'npm i -D left-pad': /dependency/, 'yarn add x': /dependency/, 'pnpm add x': /dependency/, 'pip install x': /dependency/,
  'python -m pip install x': /dependency/, 'uv add x': /dependency/, 'uv pip install x': /dependency/, 'poetry add x': /dependency/, 'go get x': /dependency/, 'cargo add x': /dependency/,
};
const ALLOWED = ['git remote -v', 'gh api repos/x/y', 'gh api -X GET x', 'git reset HEAD src/a.ts', 'git commit -m x', 'git checkout -- src/a.ts', 'npm install', 'npm ci', 'uv sync', 'git diff'];

test('expensive-command patterns block repository-wide test runs only', () => {
  for (const [command, blocked] of Object.entries(EXPENSIVE)) {
    assert.equal(guards.expensiveVerdict(command) === guards.EXPENSIVE_MESSAGE, blocked, command);
  }
  assert.equal(guards.EXPENSIVE_MESSAGE, 'Blocked: repository-wide test run. Run only the tests covering the files you changed. Full-suite verification runs in CI on the draft PR.');
});

test('per-repository expensive commands are regular expressions matched per segment', () => {
  assert.equal(guards.expensiveVerdict('make e2e', ['^make e2e$']), guards.EXPENSIVE_MESSAGE);
  assert.equal(guards.expensiveVerdict('cd x && make e2e', ['^make e2e$']), guards.EXPENSIVE_MESSAGE);
  assert.equal(guards.expensiveVerdict('make e2e-one', ['^make e2e$']), undefined);
  assert.equal(guards.expensiveVerdict('make e2e', ['(broken']), undefined);
});

test('restricted actions are always blocked, with a reason', () => {
  for (const [command, reason] of Object.entries(RESTRICTED)) {
    const verdict = guards.restrictedVerdict(command);
    assert.match(verdict ?? '', /^Blocked: /, command);
    assert.match(verdict, reason, command);
  }
  for (const command of ALLOWED) assert.equal(guards.restrictedVerdict(command), undefined, command);
});

test('commandSegments splits chains and drops redirections and leading assignments', () => {
  assert.deepEqual(guards.commandSegments('cd pkg && FOO=1 BAR=2 npm test 2>&1 | tail -5; (git status)'), ['cd pkg', 'npm test', 'tail -5', 'git status']);
});

test('over budget, only git bookkeeping and the acceptance commands may run', () => {
  const acceptance = ['node --test tests/a.test.mjs'];
  for (const command of ['git status', 'git diff --stat', 'git log -3', 'git add -A && git commit -m "wip; partial"', 'git add src/a.ts; git commit -m wip', 'node --test tests/a.test.mjs']) {
    assert.equal(guards.overBudgetAllowed(command, acceptance), true, command);
  }
  for (const command of ['ls', 'git status; rm -rf src', 'git commit -m "$(rm -rf x)"', 'git diff > out.txt', 'git status | sh', 'node --test tests/b.test.mjs']) {
    assert.equal(guards.overBudgetAllowed(command, acceptance), false, command);
  }
});

test('globs support **, *, and ?, and a plain directory scope covers its contents', () => {
  const cases = [
    ['**/generated/**', 'src/generated/a.ts', true], ['**/generated/**', 'generated/a.ts', true], ['**/generated/**', 'src/gen/a.ts', false],
    ['src/**', 'src/a/b.ts', true], ['src/**', 'tests/a.ts', false], ['src/*.ts', 'src/a.ts', true], ['src/*.ts', 'src/a/b.ts', false],
    ['src/**/*.ts', 'src/a.ts', true], ['src/**/*.ts', 'src/x/y/a.ts', true], ['a?.ts', 'ab.ts', true], ['a.ts', 'abts', false],
  ];
  for (const [pattern, path, expected] of cases) assert.equal(guards.globRegExp(pattern).test(path), expected, `${pattern} ${path}`);
  assert.equal(guards.inScope('src/work/a.ts', ['src/work']), true);
  assert.equal(guards.inScope('src/workers/a.ts', ['src/work']), false);
  assert.equal(guards.inScope('src/a.ts', ['./src/**']), true);
  assert.equal(guards.inScope('docs/README.md', ['README.md']), false);
});

test('ignore patterns without a slash match the basename', () => {
  assert.equal(guards.isIgnored('packages/web/package-lock.json', guards.BUILT_IN_IGNORE), true);
  assert.equal(guards.isIgnored('src/__snapshots__/a.snap', guards.BUILT_IN_IGNORE), true);
  assert.equal(guards.isIgnored('src/a.ts', guards.BUILT_IN_IGNORE), false);
  assert.equal(guards.isIgnored('deps/x.lock', ['*.lock']), true);
  assert.equal(guards.isIgnored('src/fixtures/a.json', ['src/fixtures/**']), true);
});
