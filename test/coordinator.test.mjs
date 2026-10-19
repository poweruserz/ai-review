// Runs scripts straight out of review.yml: the coordinator's "Decide" against fake GitHub data, and the GLM
// session finder against fake execution files.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const workflow = readFileSync(new URL('../.github/workflows/review.yml', import.meta.url), 'utf8').split('\n');
function stepScript(id, ...params) {
  const start = workflow.findIndex((line, i) => /^\s*script: \|$/.test(line) && workflow.slice(i - 8, i).some(l => l.includes(`id: ${id}`)));
  assert.ok(start > 0, `step ${id} not found`);
  const indent = workflow[start].search(/\S/) + 2;
  const body = [];
  for (const line of workflow.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return new (Object.getPrototypeOf(async () => {}).constructor)(...params, body.join('\n'));
}
const decide = stepScript('decide', 'github', 'context', 'core');
const findSession = stepScript('session', 'require', 'core');

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
const ask = (sha, round, login = 'o', created_at = '2026-10-19T06:39:51Z') => ({ user: { login }, created_at, body: `@codex ...\n<!-- aifix sha=${sha} round=${round} -->` });
const codexReply = (body, created_at = '2026-10-19T06:40:02Z') => ({ user: { login: 'chatgpt-codex-connector[bot]' }, created_at, body });

const thread = (isResolved, login = 'chatgpt-codex-connector') => ({ isResolved, comments: { nodes: [{ author: { login } }] } });

// Without explicit threads, an unresolved code-review flag in the Codex state stands for one open Codex thread.
function threadsFromState(comments) {
  const m = comments.map(c => /codex-review-state:v1 (\{.*?\}) -->/s.exec(c.body ?? '')).find(Boolean);
  return m && JSON.parse(m[1]).code_review?.has_unresolved_findings ? [thread(false)] : [];
}

async function run(comments, { hasPat = 'true', maxRounds = '3', asker = 'o', threads, codexFixes = 'true', author = 'o' } = {}) {
  const statuses = [];
  const outputs = {};
  const pr = { state: 'open', draft: false, user: { login: author }, head: { sha: HEAD, repo: { full_name: 'o/r' } } };
  const nodes = threads ?? threadsFromState(comments);
  const github = {
    paginate: async () => comments,
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } }),
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      issues: { listComments: () => {} },
      repos: { createCommitStatus: async (s) => statuses.push(`${s.state}: ${s.description}`) },
    },
  };
  Object.assign(process.env, { PR_NUMBER: '7', MAX_ROUNDS: maxRounds, HAS_PAT: hasPat, ASKER: asker, CODEX_FIXES: codexFixes });
  await decide(github, { repo: { owner: 'o', repo: 'r' } }, { setOutput: (k, v) => { outputs[k] = v; } });
  return { statuses, outputs };
}

test('both clean on the head → success', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), glmComment(HEAD, 'clean', 'VERDICT: CLEAN')]);
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
  assert.equal(r.outputs.ask, undefined);
});

test('Dependabot pull request → no status, since GLM never reviews it', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) })], { author: 'dependabot[bot]' });
  assert.deepEqual(r.statuses, []);
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

test('code review findings → failure without waiting for a security review still running, which it names', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, null, 'running') }), glmComment(HEAD, 'clean')], { codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex; Codex security review still running']);
});

test('a clean code review still waits for the security review', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, null, 'running') }), glmComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['pending: waiting for Codex']);
});

test('no security review configured → code review alone decides', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), glmComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
});

test('findings → asks Codex once, as round 1, with the GLM text', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), glmComment(HEAD, 'findings')]);
  assert.equal(r.outputs.ask, 'true');
  assert.match(r.outputs.body, /^@codex Fix /);
  assert.match(r.outputs.body, /\[P1\] a\.js:1/);
  assert.match(r.outputs.body, new RegExp(`<!-- aifix sha=${HEAD} round=1 -->$`));
  assert.deepEqual(r.statuses, ['pending: round 1: Codex is ruling on the findings']);
});

test('a stale "unresolved" flag is ignored once every Codex thread is resolved', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), glmComment(HEAD, 'clean')],
    { threads: [thread(true), thread(true)], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
});

test('an open Codex thread counts even when the flag is null', async () => {
  const unknown = { ...review(HEAD, false), has_any_findings: null, has_unresolved_findings: null };
  const r = await run([codexState({ code_review: unknown, security_review: review(HEAD, false) }), glmComment(HEAD, 'clean')],
    { threads: [thread(true), thread(false)], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex']);
});

test("other reviewers' open threads are not Codex findings", async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), glmComment(HEAD, 'clean')],
    { threads: [thread(false, 'poweruserz')], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['success: Codex and GLM found nothing']);
});

test('already asked about this head → does nothing', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'findings'), ask(HEAD, 1)]);
  assert.deepEqual(r.statuses, []);
  assert.equal(r.outputs.ask, undefined);
});

test('Claude fixes by default: findings → failure naming the sources, and Codex is not asked', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), glmComment(HEAD, 'findings')], { codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex and GLM']);
  assert.equal(r.outputs.ask, undefined);
});

test('Claude fixes by default: GLM-only findings name GLM alone', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), glmComment(HEAD, 'findings')], { codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from GLM']);
});

test('Codex answers the fix request with an error → error that says why', async () => {
  const reply = codexReply('To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).');
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'findings'), ask(HEAD, 1), reply]);
  assert.deepEqual(r.statuses, ['error: Codex could not run the fix task: To use Codex here, create an environment for this repo.']);
});

test('a Codex error from before the request does not end the round', async () => {
  const early = codexReply('Codex Review: Something went wrong.', '2026-10-19T06:00:00Z');
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'findings'), early, ask(HEAD, 1)]);
  assert.deepEqual(r.statuses, []);
});

test('findings after three Codex rounds → error', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'clean'), ask(OLD, 1), ask(OLD, 2), ask(OLD, 3)]);
  assert.deepEqual(r.statuses, ['error: findings remain after 3 Codex rounds']);
});

test('markers from anyone but the owner are ignored', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'clean'), ask(HEAD, 1, 'stranger'), ask(OLD, 2, 'stranger'), ask(OLD, 3, 'stranger')]);
  assert.equal(r.outputs.ask, 'true');
  assert.match(r.outputs.body, /round=1 -->$/);
});

test("rounds follow the token's account even when it is not the repository owner", async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), glmComment(HEAD, 'clean'), ask(OLD, 1, 'bot-user'), ask(OLD, 2, 'bot-user'), ask(OLD, 3, 'bot-user')], { asker: 'bot-user' });
  assert.deepEqual(r.statuses, ['error: findings remain after 3 Codex rounds']);
});

test('missing token → error instead of a silent stall', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), glmComment(HEAD, 'findings')], { hasPat: 'false' });
  assert.deepEqual(r.statuses, ['error: CODEX_TRIGGER_PAT secret is missing']);
});

async function session(messages) {
  const file = join(mkdtempSync(join(tmpdir(), 'ai-review-')), 'out.json');
  if (messages !== undefined) writeFileSync(file, typeof messages === 'string' ? messages : JSON.stringify(messages));
  const outputs = {}, warnings = [];
  process.env.EXECUTION_FILE = file;
  await findSession(createRequire(import.meta.url), { setOutput: (k, v) => { outputs[k] = v; }, warning: w => warnings.push(w) });
  return { id: outputs.id, warnings };
}
const ID = '321f3910-abc0-49cb-a020-a5f56662abe6';
const init = (session_id = ID) => ({ type: 'system', subtype: 'init', session_id });

test('GLM out of turns → its session is resumed for a verdict', async () => {
  assert.equal((await session([init(), { type: 'result', subtype: 'error_max_turns', is_error: true }])).id, ID);
});

test('GLM failed for another reason → nothing to resume', async () => {
  assert.equal((await session([init(), { type: 'result', subtype: 'error_during_execution', is_error: true }])).id, undefined);
});

test('a session id that is not a plain UUID never reaches claude_args', async () => {
  assert.equal((await session([init(`${ID} --dangerously-skip-permissions`), { type: 'result', subtype: 'error_max_turns' }])).id, undefined);
});

test('no execution file → a warning, nothing to resume', async () => {
  const r = await session(undefined);
  assert.equal(r.id, undefined);
  assert.equal(r.warnings.length, 1);
});
