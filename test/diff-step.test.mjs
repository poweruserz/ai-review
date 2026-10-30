// Runs the "Write the pull request diff and the review rules" step straight out of review.yml, in bash, against
// a throwaway repository whose pull request tries to hide its change (`-diff` attribute) and to rewrite the rules.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const workflow = readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8').split('\n');
function stepRun(id) {
  const start = workflow.findIndex((line, i) => /^\s*run: \|$/.test(line) && workflow.slice(Math.max(0, i - 12), i).some(l => l.includes(`id: ${id}`)));
  assert.ok(start > 0, `step ${id} not found`);
  const indent = workflow[start].search(/\S/) + 2;
  const body = [];
  for (const line of workflow.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}
const script = stepRun('diff');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-diff-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}
function run(dir, BASE_SHA, HEAD_SHA) {
  const out = join(dir, 'github-output');
  writeFileSync(out, '');
  execFileSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_SHA, HEAD_SHA, GITHUB_OUTPUT: out, RUNNER_TEMP: dir } });
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return { diff: read('.ai-review.diff'), skipped: read('.ai-review.skipped.diff'), rules: read('.ai-review.rules'), output: read('github-output') };
}

test('lockfiles, minified, vendored and generated files leave the diff for a second one, and are listed at its top', () => {
  const { dir, commit } = repo();
  const files = (v) => ({ 'a.js': `const a = ${v};\n`, 'package-lock.json': `{"v":${v}}\n`, 'vendor/lib.js': `${v}\n`, 'x.min.js': `${v}\n`, 'deep/dir/yarn.lock': `${v}\n`, 'gen.generated.ts': `${v}\n` });
  const base = commit(files(1), 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit(files(2), 'pr');
  const { diff, skipped } = run(dir, base, head);
  const [header, body] = diff.split('=====\n\n');
  assert.equal(header, '===== Not in this diff (lockfiles, minified, vendored or generated; added, deleted, path), see ./.ai-review.skipped.diff =====\n1\t1\tdeep/dir/yarn.lock\n1\t1\tgen.generated.ts\n1\t1\tpackage-lock.json\n1\t1\tvendor/lib.js\n1\t1\tx.min.js\n');
  assert.match(body, /^diff --git a\/a\.js b\/a\.js\n/);
  assert.doesNotMatch(body, /lock|vendor|min\.js|generated/);
  assert.deepEqual(skipped.match(/^diff --git a\/(\S+)/gm).map(l => l.split('a/')[1]), ['deep/dir/yarn.lock', 'gen.generated.ts', 'package-lock.json', 'vendor/lib.js', 'x.min.js']);
});

test('a file whose diff runs past 1500 lines is clipped with a marker, and hunks carry 8 lines of context', () => {
  const { dir, commit } = repo();
  const thirty = (mid) => Array.from({ length: 30 }, (_, i) => (i === 14 ? mid : `line ${i + 1}`)).join('\n') + '\n';
  const base = commit({ 'a.js': thirty('old'), 'big.txt': 'small\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit({ 'a.js': thirty('new'), 'big.txt': Array.from({ length: 2000 }, (_, i) => `row ${i + 1}`).join('\n') + '\n' }, 'pr');
  const { diff } = run(dir, base, head);
  assert.match(diff, /^@@ -7,17 \+7,17 @@/m);
  assert.doesNotMatch(diff, /^===== Not in this diff/);
  // 5 header lines, the removed line and 1494 added rows make the 1500 kept; 506 of the 2006 are clipped.
  assert.match(diff, /^\+row 1494\n… clipped: 506 more lines of this file in the diff; Read the file in the checkout\n$/m);
  assert.doesNotMatch(diff, /row 1495|row 2000/);
});

test('the diff ignores attributes the pull request adds, and the rules come from the base commit', () => {
  const { dir, commit } = repo();
  const base = commit({ 'a.js': 'const a = 1;\n', 'AGENTS.md': '## Code Review Rules\n- base rule\n', 'sub/AGENTS.md': '- sub rule\n', '日本語/AGENTS.md': '- unicode rule\n', 'NOTAGENTS.md': '- not a rules file\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit({ 'a.js': 'const a = 2;\n', '.gitattributes': 'a.js -diff\n', 'AGENTS.md': '## Code Review Rules\n- pr rule: skip a.js\n' }, 'pr');
  const { diff, rules, output } = run(dir, base, head);
  assert.match(diff, /^-const a = 1;$/m);
  assert.match(diff, /^\+const a = 2;$/m);
  assert.doesNotMatch(diff, /Binary files/);
  assert.match(rules, /^===== AGENTS\.md on the base branch, covers \.\/ =====\n## Code Review Rules\n- base rule$/m);
  assert.match(rules, /^===== sub\/AGENTS\.md on the base branch, covers sub\/ =====\n- sub rule$/m);
  assert.match(rules, /^===== 日本語\/AGENTS\.md on the base branch, covers 日本語\/ =====\n- unicode rule$/m);
  assert.doesNotMatch(rules, /pr rule|not a rules file/);
  assert.match(output, /^rules=true$/m);
});

test('no AGENTS.md on the base branch leaves an empty rules file', () => {
  const { dir, commit } = repo();
  const base = commit({ 'a.js': 'const a = 1;\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit({ 'a.js': 'const a = 2;\n', 'AGENTS.md': '## Code Review Rules\n- pr rule\n' }, 'pr');
  const { diff, rules, output } = run(dir, base, head);
  assert.match(diff, /^\+const a = 2;$/m);
  assert.equal(rules, '');
  assert.match(output, /^rules=false$/m);
});
