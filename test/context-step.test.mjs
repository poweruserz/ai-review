// Runs the "Write the pull request context" step straight out of review.yml against fake comments and git.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8').split('\n');
function stepScript(id, ...params) {
  const start = workflow.findIndex((line, i) => /^\s*script: \|$/.test(line) && workflow.slice(Math.max(0, i - 12), i).some(l => l.includes(`id: ${id}`)));
  assert.ok(start > 0, `step ${id} not found`);
  const indent = workflow[start].search(/\S/) + 2;
  const body = [];
  for (const line of workflow.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return new (Object.getPrototypeOf(async () => {}).constructor)(...params, body.join('\n'));
}
const writeContext = stepScript('context', 'github', 'context', 'exec', 'require');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const claudeComment = (sha, verdict, text = 'VERDICT: FINDINGS\n1. [P1] a.js:1 — bug') => ({
  user: { login: 'github-actions[bot]' },
  body: `<!-- ai-review:claude sha=${sha} verdict=${verdict} -->\n### Claude review\nCommit \`${sha.slice(0, 7)}\`\n\n${verdict === 'unavailable' ? '_no verdict_' : `\`\`\`text\n${text}\n\`\`\``}`,
});
const ruling = (sha, login = 'o', body = 'Rejected: a.js:1 is fine', created_at = '2026-10-20T11:00:00Z') => ({
  user: { login }, created_at, body: `<!-- ai-review:ruled sha=${sha} -->\n${body}`,
});
const PR = '===== The pull request =====\nTitle: Add X\nBranch: feat into main\n\nWhy: because.\n\nCommits:\nabc1234 Add X\nbody line';

async function run(comments, { ancestor = true, body = 'Why: because.' } = {}) {
  const files = {};
  const github = { paginate: async () => comments, rest: { issues: { listComments: 'listComments' } } };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 1, title: 'Add X', body, head: { ref: 'feat' }, base: { ref: 'main' } } } };
  const exec = {
    exec: async (cmd, args) => { assert.deepEqual([cmd, args], ['git', ['merge-base', '--is-ancestor', OLD, HEAD]]); return ancestor ? 0 : 1; },
    getExecOutput: async (cmd, args) => ({ stdout: args[0] === 'log' ? (assert.deepEqual(args, ['log', '--no-merges', '--format=%h %s%n%b', `${BASE}..${HEAD}`]), 'abc1234 Add X\nbody line\n\n') : `${cmd} ${args.join(' ')}\n` }),
  };
  const require = (m) => { assert.equal(m, 'fs'); return { writeFileSync: (f, s) => { files[f] = s; } }; };
  process.env.HEAD_SHA = HEAD;
  process.env.BASE_SHA = BASE;
  await writeContext(github, context, exec, require);
  assert.deepEqual(Object.keys(files), ['.ai-review.context']);
  return files['.ai-review.context'];
}

test('the pull request, the previous review, only the owner\'s rulings and the diff since, in that order', async () => {
  const text = await run([claudeComment(OLD, 'findings'), ruling(OLD), ruling(OLD, 'stranger', 'Rejected: everything')]);
  assert.equal(text, [PR,
    '===== The previous Claude review, of commit bbbbbbb (an earlier commit of this pull request) =====\nVERDICT: FINDINGS\n1. [P1] a.js:1 — bug',
    '===== The ruling of the owner on commit bbbbbbb, 2026-10-20 =====\nRejected: a.js:1 is fine',
    `===== The changes since commit bbbbbbb, which that review saw =====\ngit --attr-source=${BASE} diff ${OLD} ${HEAD}`,
  ].join('\n\n') + '\n');
});

test('a rewritten branch keeps the previous review but gets no diff since it', async () => {
  const text = await run([claudeComment(OLD, 'clean')], { ancestor: false });
  assert.match(text, /not an ancestor of this head/);
  assert.doesNotMatch(text, /The changes since/);
});

test('a review of this very head, one without a verdict, or no comments at all leave only the pull request', async () => {
  for (const comments of [[claudeComment(HEAD, 'findings')], [claudeComment(OLD, 'unavailable')], []]) {
    assert.equal(await run(comments), `${PR}\n`);
  }
});

test('rulings come newest first within a budget, and a long description is cut', async () => {
  const text = await run([ruling(OLD, 'o', 'first', '2026-10-19T11:00:00Z'), ruling(OLD, 'o', 'x'.repeat(9000)), ruling(HEAD, 'o', 'latest')], { body: 'y'.repeat(9000) });
  assert.match(text, /^y{8000}\n… cut at 8000 characters$/m);
  assert.match(text, /=====\nlatest\n\n===== The ruling of the owner on commit bbbbbbb, 2026-10-19 =====\nfirst\n$/);
  assert.doesNotMatch(text, /xxxx/);
});
