// Runs the coordinator's "Decide" script straight out of review.yml against fake GitHub data.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8').split('\n');
const start = workflow.findIndex((line, i) => /^\s*script: \|$/.test(line) && workflow.slice(i - 8, i).some(l => l.includes('id: decide')));
const indent = workflow[start].search(/\S/) + 2;
const body = [];
for (const line of workflow.slice(start + 1)) {
  if (line.trim() && line.search(/\S/) < indent) break;
  body.push(line.slice(indent));
}
const decide = new (Object.getPrototypeOf(async () => {}).constructor)('github', 'context', 'core', body.join('\n'));

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const codexState = (state) => ({
  user: { login: 'chatgpt-codex-connector[bot]' },
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(state)} -->\n## Codex Review Summary`,
});
const review = (sha, findings, status = 'completed') => ({ commit_sha: sha, status, has_any_findings: findings, has_unresolved_findings: findings });
const glmComment = (sha, verdict, text = 'VERDICT: FINDINGS\n1. [P1] a.js:1 — bug') => ({
  user: { login: 'github-actions[bot]' },
  body: `<!-- ai-review:glm sha=${sha} verdict=${verdict} -->\n### GLM review\nCommit \`${sha.slice(0, 7)}\`\n\n${text}`,
});
const ask = (sha, round, login = 'o') => ({ user: { login }, body: `@codex ...\n<!-- ai-review:coord sha=${sha} round=${round} -->` });

async function run(comments, { hasPat = 'true', maxRounds = '3', asker = 'o', inline = [] } = {}) {
  const statuses = [];
  const outputs = {};
  const pr = { state: 'open', draft: false, head: { sha: HEAD, repo: { full_name: 'o/r' } } };
  const github = {
    paginate: async (fn) => (fn === github.rest.pulls.listReviewComments ? inline : comments),
    rest: {
      pulls: { get: async () => ({ data: pr }), listReviewComments: () => {} },
      issues: { listComments: () => {} },
      repos: { createCommitStatus: async (s) => statuses.push(`${s.state}: ${s.description}`) },
    },
  };
  Object.assign(process.env, { PR_NUMBER: '7', MAX_ROUNDS: maxRounds, HAS_PAT: hasPat, ASKER: asker });
  await decide(github, { repo: { owner: 'o', repo: 'r' } }, { setOutput: (k, v) => { outputs[k] = v; } });
  return { statuses, outputs };
}

test('both clean on the head → success', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), glmComment(HEAD, 'clean', 'VERDICT: CLEAN')]);
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
  assert.equal(r.outputs.ask, undefined);
});

test('GLM not in yet → pending', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) })]);
  assert.deepEqual(r.statuses, ['pending: waiting for GLM']);
});

test('GLM verdict for an older head does not count', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), glmComment(OLD, 'clean')]);
  assert.deepEqual(r.statuses, ['pending: waiting for GLM']);
});

test('security review still on an older head → waiting for Codex', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(OLD, false) }), glmComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['pending: waiting for Codex']);
});

test('no security review configured → code review alone decides', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), glmComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
});

test('findings → asks Codex once, as round 1, with the GLM text', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), glmComment(HEAD, 'findings')]);
  assert.equal(r.outputs.ask, 'true');
  assert.match(r.outputs.body, /^@codex /);
  assert.match(r.outputs.body, /\[P1\] a\.js:1/);
  assert.match(r.outputs.body, new RegExp(`<!-- ai-review:coord sha=${HEAD} round=1 -->$`));
  assert.deepEqual(r.statuses, ['pending: round 1: Codex is ruling on the findings']);
});

test('unknown (null) Codex result with an inline Codex comment on the head → treated as findings', async () => {
  const unknown = { ...review(HEAD, false), has_any_findings: null, has_unresolved_findings: null };
  const inline = [{ user: { login: 'chatgpt-codex-connector[bot]' }, original_commit_id: HEAD }];
  const r = await run([codexState({ code_review: unknown, security_review: review(HEAD, false) }), glmComment(HEAD, 'clean')], { inline });
  assert.equal(r.outputs.ask, 'true');
});

test('unknown (null) Codex result with Codex comments only on older heads → clean', async () => {
  const unknown = { ...review(HEAD, false), has_any_findings: null, has_unresolved_findings: null };
  const inline = [{ user: { login: 'chatgpt-codex-connector[bot]' }, original_commit_id: OLD }];
  const r = await run([codexState({ code_review: unknown, security_review: review(HEAD, false) }), glmComment(HEAD, 'clean')], { inline });
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
});

test('already asked about this head → does nothing', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'findings'), ask(HEAD, 1)]);
  assert.deepEqual(r.statuses, []);
  assert.equal(r.outputs.ask, undefined);
});

test('findings after three rounds → failure', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'clean'), ask(OLD, 1), ask(OLD, 2), ask(OLD, 3)]);
  assert.deepEqual(r.statuses, ['failure: findings remain after 3 Codex rounds']);
});

test('markers from anyone but the owner are ignored', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'clean'), ask(HEAD, 1, 'stranger'), ask(OLD, 2, 'stranger'), ask(OLD, 3, 'stranger')]);
  assert.equal(r.outputs.ask, 'true');
  assert.match(r.outputs.body, /round=1 -->$/);
});

test("rounds follow the token's account even when it is not the repository owner", async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'clean'), ask(OLD, 1, 'bot-user'), ask(OLD, 2, 'bot-user'), ask(OLD, 3, 'bot-user')], { asker: 'bot-user' });
  assert.deepEqual(r.statuses, ['failure: findings remain after 3 Codex rounds']);
});

test('missing token → failure instead of a silent stall', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), glmComment(HEAD, 'findings')], { hasPat: 'false' });
  assert.deepEqual(r.statuses, ['failure: CODEX_TRIGGER_PAT secret is missing']);
});
