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
  execFileSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_SHA, HEAD_SHA, GITHUB_OUTPUT: out } });
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return { diff: read('.ai-review.diff'), rules: read('.ai-review.rules'), output: read('github-output') };
}

test('the diff ignores attributes the pull request adds, and the rules come from the base commit', () => {
  const { dir, commit } = repo();
  const base = commit({ 'a.js': 'const a = 1;\n', 'AGENTS.md': '## Code Review Rules\n- base rule\n', 'sub/AGENTS.md': '- sub rule\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit({ 'a.js': 'const a = 2;\n', '.gitattributes': 'a.js -diff\n', 'AGENTS.md': '## Code Review Rules\n- pr rule: skip a.js\n' }, 'pr');
  const { diff, rules, output } = run(dir, base, head);
  assert.match(diff, /^-const a = 1;$/m);
  assert.match(diff, /^\+const a = 2;$/m);
  assert.doesNotMatch(diff, /Binary files/);
  assert.match(rules, /^===== AGENTS\.md on the base branch, covers \.\/ =====\n## Code Review Rules\n- base rule$/m);
  assert.match(rules, /^===== sub\/AGENTS\.md on the base branch, covers sub\/ =====\n- sub rule$/m);
  assert.doesNotMatch(rules, /pr rule/);
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
