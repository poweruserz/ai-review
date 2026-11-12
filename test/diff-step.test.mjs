// Runs the "Write the pull request diff and the review rules" step straight out of review.yml, in bash, against
// a throwaway repository whose pull request tries to hide its change (`-diff` attribute) and to rewrite the rules.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
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
  const rows = Array.from({ length: 1700 }, (_, i) => `row ${i + 1}`).join('\n');
  const base = commit({ 'a.js': thirty('old'), 'big.js': `${rows}\nrequireAuthorization();\n` }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit({ 'a.js': thirty('new'), 'big.js': 'handleRequest();\n' }, 'pr');
  const { diff, skipped } = run(dir, base, head);
  assert.match(diff, /^@@ -7,17 \+7,17 @@/m);
  assert.doesNotMatch(diff, /^===== Not in this diff/);
  // 5 header lines and 1495 removed rows make the 1500 kept; the other 207 of 1707 are clipped, the removed check
  // among them, so the whole diff of the file has to be in the second file.
  assert.match(diff, /^-row 1495\n… clipped: 207 more lines of this file in the diff; its whole diff is in \.\/\.ai-review\.skipped\.diff\n$/m);
  assert.doesNotMatch(diff, /row 1496|requireAuthorization/);
  assert.match(skipped, /^===== The whole diff of each file clipped in \.\/\.ai-review\.diff =====\ndiff --git a\/big\.js b\/big\.js\n/m);
  assert.match(skipped, /^-requireAuthorization\(\);\n\+handleRequest\(\);\n$/m);
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

test('a diff past 40,000 bytes continues in numbered parts: whole files where they fit, a larger file cut with its header repeated', () => {
  const { dir, commit } = repo();
  const base = commit({ 'README.md': 'x\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const text = (tag, n, width) => Array.from({ length: n }, (_, i) => `${tag} ${i} ${'x'.repeat(width)}`).join('\n') + '\n';
  // About 14 KB each for a.js and b.js, 99 KB for big.js, and a word of Turkish, which is two bytes a letter.
  const head = commit({ 'a.js': text('a', 300, 40), 'b.js': text('b', 300, 40), 'big.js': text('big', 1400, 60), 'son.js': 'çğış\n' }, 'pr');
  // A part left by an earlier run on a persistent runner, or committed by the pull request, must not survive.
  writeFileSync(join(dir, '.ai-review.diff.9'), 'stale\n');
  const { diff, output } = run(dir, base, head);
  const count = Number(/^parts=(\d+)$/m.exec(output)[1]);
  const parts = [diff, ...Array.from({ length: count - 1 }, (_, i) => readFileSync(join(dir, `.ai-review.diff.${i + 2}`), 'utf8'))];
  assert.equal(count, 4);
  assert.match(output, /^more=\.\/\.ai-review\.diff\.2, \.\/\.ai-review\.diff\.3, \.\/\.ai-review\.diff\.4$/m);
  assert.ok(!existsSync(join(dir, '.ai-review.diff.9')));
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 40000, `a part of ${Buffer.byteLength(p)} bytes`);
  // a.js and b.js fit one part together and are not cut; big.js does not fit what is left, so it starts the next.
  assert.deepEqual(parts.map(p => p.match(/^diff --git a\/(\S+)/gm).map(l => l.slice(13))), [['a.js', 'b.js'], ['big.js'], ['big.js'], ['big.js', 'son.js']]);
  assert.match(parts[1], /^diff --git a\/big\.js b\/big\.js\n/);
  for (const p of parts.slice(2)) assert.match(p, /^… the diff of this file continues from the previous part\ndiff --git a\/big\.js b\/big\.js\n\+big \d+ /);
  // Nothing is lost or repeated: every added line is there once, in order.
  assert.deepEqual(parts.join('').match(/^\+big \d+ /gm).map(l => Number(l.split(' ')[1])), Array.from({ length: 1400 }, (_, i) => i));
  assert.match(parts[3], /^\+çğış$/m);
});

test('a diff under 40,000 bytes stays one file', () => {
  const { dir, commit } = repo();
  const base = commit({ 'a.js': 'const a = 1;\n' }, 'base');
  git(dir, 'switch', '-q', '-c', 'pr');
  const head = commit({ 'a.js': 'const a = 2;\n' }, 'pr');
  const { output } = run(dir, base, head);
  assert.match(output, /^parts=1\nmore=$/m);
  assert.ok(!existsSync(join(dir, '.ai-review.diff.2')));
});
