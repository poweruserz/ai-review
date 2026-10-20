// Runs scripts straight out of review.yml: the coordinator's "Decide" against fake GitHub data, and the Claude
// session finder against fake execution files.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

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
const decide = stepScript('decide', 'github', 'context', 'core');
const findSession = stepScript('session', 'require', 'core');
const extractVerdict = stepScript('result', 'require', 'core');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const codexState = (state, updated_at = '2026-10-20T10:00:00Z') => ({
  user: { login: 'chatgpt-codex-connector[bot]' },
  updated_at,
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(state)} -->\n## Codex Review Summary`,
});
const review = (sha, findings, status = 'completed') => ({ commit_sha: sha, status, has_any_findings: findings, has_unresolved_findings: findings });
const claudeComment = (sha, verdict, text = 'VERDICT: FINDINGS\n1. [P1] a.js:1 — bug', updated_at = '2026-10-20T10:00:00Z') => ({
  user: { login: 'github-actions[bot]' },
  updated_at,
  body: `<!-- ai-review:claude sha=${sha} verdict=${verdict} -->\n### Claude review\nCommit \`${sha.slice(0, 7)}\`\n\n${text}`,
});
const ruling = (sha = HEAD, login = 'o', created_at = '2026-10-20T11:00:00Z') => ({ user: { login }, created_at, body: `<!-- ai-review:ruled sha=${sha} -->\nRejected: …` });
const ask = (sha, round, login = 'o', created_at = '2026-10-19T06:39:51Z') => ({ user: { login }, created_at, body: `@codex ...\n<!-- aifix sha=${sha} round=${round} -->` });
const codexReply = (body, created_at = '2026-10-19T06:40:02Z') => ({ user: { login: 'chatgpt-codex-connector[bot]' }, created_at, body });

const thread = (isResolved, login = 'chatgpt-codex-connector') => ({ isResolved, comments: { nodes: [{ author: { login } }] } });

// Without explicit threads, an unresolved code-review flag in the Codex state stands for one open Codex thread.
function threadsFromState(comments) {
  const m = comments.map(c => /codex-review-state:v1 (\{.*?\}) -->/s.exec(c.body ?? '')).find(Boolean);
  return m && JSON.parse(m[1]).code_review?.has_unresolved_findings ? [thread(false)] : [];
}

async function run(comments, { hasPat = 'true', maxRounds = '3', asker = 'o', threads, codexFixes = 'true', author = 'o', base = 'main' } = {}) {
  const statuses = [];
  const outputs = {};
  const pr = { state: 'open', draft: false, user: { login: author }, base: { ref: base }, head: { sha: HEAD, repo: { full_name: 'o/r' } } };
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
  await decide(github, { repo: { owner: 'o', repo: 'r' }, payload: { repository: { default_branch: 'main' } } }, { setOutput: (k, v) => { outputs[k] = v; } });
  return { statuses, outputs };
}

test('both clean on the head → success', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), claudeComment(HEAD, 'clean', 'VERDICT: CLEAN')]);
  assert.deepEqual(r.statuses, ['success: Codex and Claude found nothing']);
  assert.equal(r.outputs.ask, undefined);
});

test('Claude gave no verdict → error, never a pass', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), claudeComment(HEAD, 'unavailable', '_no verdict_')]);
  assert.deepEqual(r.statuses, ['error: Claude gave no verdict: see its comment, then re-run the workflow']);
});

test('Dependabot pull request → no status, since Claude never reviews it', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) })], { author: 'dependabot[bot]' });
  assert.deepEqual(r.statuses, []);
});

test('pull request into another branch → error, so retargeting it cannot carry a success over', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), claudeComment(HEAD, 'clean', 'VERDICT: CLEAN')], { base: 'feature' });
  assert.deepEqual(r.statuses, ['error: into feature, not main: not reviewed; after retargeting, push a new commit']);
});

test('Codex still on an older commit → waiting, naming the commit it last reviewed', async () => {
  const r = await run([codexState({ code_review: review(OLD, false), security_review: review(OLD, false) }), claudeComment(HEAD, 'clean', 'VERDICT: CLEAN')]);
  assert.deepEqual(r.statuses, ['pending: waiting for Codex; Codex last reviewed bbbbbbb']);
});

test('Claude not in yet → pending', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) })]);
  assert.deepEqual(r.statuses, ['pending: waiting for Claude']);
});

test('Claude verdict for an older head does not count', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, false) }), claudeComment(OLD, 'clean')]);
  assert.deepEqual(r.statuses, ['pending: waiting for Claude']);
});

test('security review still on an older head → waiting for Codex', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(OLD, false) }), claudeComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['pending: waiting for Codex']);
});

test('code review findings → failure without waiting for a security review still running, which it names', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, null, 'running') }), claudeComment(HEAD, 'clean')], { codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex; Codex security review still running']);
});

test('a clean code review still waits for the security review', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, null, 'running') }), claudeComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['pending: waiting for Codex']);
});

test('no security review configured → code review alone decides', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), claudeComment(HEAD, 'clean')]);
  assert.deepEqual(r.statuses, ['success: Codex and Claude found nothing']);
});

test('findings → asks Codex once, as round 1, with the Claude text', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), claudeComment(HEAD, 'findings')]);
  assert.equal(r.outputs.ask, 'true');
  assert.match(r.outputs.body, /^@codex Fix /);
  assert.match(r.outputs.body, /\[P1\] a\.js:1/);
  assert.match(r.outputs.body, new RegExp(`<!-- aifix sha=${HEAD} round=1 -->$`));
  assert.deepEqual(r.statuses, ['pending: round 1: Codex is ruling on the findings']);
});

test('a stale "unresolved" flag is ignored once every Codex thread is resolved', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), claudeComment(HEAD, 'clean')],
    { threads: [thread(true), thread(true)], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['success: Codex and Claude found nothing']);
});

test('an open Codex thread counts even when the flag is null', async () => {
  const unknown = { ...review(HEAD, false), has_any_findings: null, has_unresolved_findings: null };
  const r = await run([codexState({ code_review: unknown, security_review: review(HEAD, false) }), claudeComment(HEAD, 'clean')],
    { threads: [thread(true), thread(false)], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex']);
});

test("other reviewers' open threads are not Codex findings", async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), claudeComment(HEAD, 'clean')],
    { threads: [thread(false, 'poweruserz')], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['success: Codex and Claude found nothing']);
});

test('already asked about this head → does nothing', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), claudeComment(HEAD, 'findings'), ask(HEAD, 1)]);
  assert.deepEqual(r.statuses, []);
  assert.equal(r.outputs.ask, undefined);
});

test('Claude fixes by default: findings → failure naming the sources, and Codex is not asked', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), claudeComment(HEAD, 'findings')], { codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex and Claude']);
  assert.equal(r.outputs.ask, undefined);
});

test('Claude fixes by default: Claude-only findings name Claude alone', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), claudeComment(HEAD, 'findings')], { codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Claude']);
});

// Every Codex thread is resolved in these, so only the ruling decides.
const ruled = (extra, opts = {}) => run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }), claudeComment(HEAD, 'findings'), ...extra],
  { threads: [thread(true)], codexFixes: 'false', ...opts });

test('the owner ruled on every finding after both results → success', async () => {
  const r = await ruled([ruling()]);
  assert.deepEqual(r.statuses, ['success: the owner ruled on the findings from Claude']);
});

test('a ruling also covers a stale security flag', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false), security_review: review(HEAD, true) }), claudeComment(HEAD, 'clean'), ruling()],
    { threads: [], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['success: the owner ruled on the findings from Codex']);
});

test('a ruling older than a result it would cover does not count', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false) }, '2026-10-20T12:00:00Z'), claudeComment(HEAD, 'findings'), ruling()],
    { threads: [thread(true)], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Claude']);
});

test('a ruling for another head does not count', async () => {
  const r = await ruled([ruling(OLD)]);
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Claude']);
});

test('a ruling from anyone but the owner does not count', async () => {
  const r = await ruled([ruling(HEAD, 'stranger')]);
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Claude']);
});

test('an open Codex thread still blocks a ruling', async () => {
  const r = await ruled([ruling()], { threads: [thread(true), thread(false)] });
  assert.deepEqual(r.statuses, ['failure: findings to rule on from Codex and Claude']);
});

test('a ruling does not cover a security review still running', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true), security_review: review(HEAD, false, 'running') }), claudeComment(HEAD, 'findings'), ruling()],
    { threads: [thread(true)], codexFixes: 'false' });
  assert.deepEqual(r.statuses, ['pending: waiting for Codex']);
});

test('Codex answers the fix request with an error → error that says why', async () => {
  const reply = codexReply('To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).');
  const r = await run([codexState({ code_review: review(HEAD, true) }), claudeComment(HEAD, 'findings'), ask(HEAD, 1), reply]);
  assert.deepEqual(r.statuses, ['error: Codex could not run the fix task: To use Codex here, create an environment for this repo.']);
});

test('a Codex error from before the request does not end the round', async () => {
  const early = codexReply('Codex Review: Something went wrong.', '2026-10-19T06:00:00Z');
  const r = await run([codexState({ code_review: review(HEAD, true) }), claudeComment(HEAD, 'findings'), early, ask(HEAD, 1)]);
  assert.deepEqual(r.statuses, []);
});

test('findings after three Codex rounds → error', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), claudeComment(HEAD, 'clean'), ask(OLD, 1), ask(OLD, 2), ask(OLD, 3)]);
  assert.deepEqual(r.statuses, ['error: findings remain after 3 Codex rounds']);
});

test('markers from anyone but the owner are ignored', async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), claudeComment(HEAD, 'clean'), ask(HEAD, 1, 'stranger'), ask(OLD, 2, 'stranger'), ask(OLD, 3, 'stranger')]);
  assert.equal(r.outputs.ask, 'true');
  assert.match(r.outputs.body, /round=1 -->$/);
});

test("rounds follow the token's account even when it is not the repository owner", async () => {
  const r = await run([codexState({ code_review: review(HEAD, true) }), claudeComment(HEAD, 'clean'), ask(OLD, 1, 'bot-user'), ask(OLD, 2, 'bot-user'), ask(OLD, 3, 'bot-user')], { asker: 'bot-user' });
  assert.deepEqual(r.statuses, ['error: findings remain after 3 Codex rounds']);
});

test('missing token → error instead of a silent stall', async () => {
  const r = await run([codexState({ code_review: review(HEAD, false) }), claudeComment(HEAD, 'findings')], { hasPat: 'false' });
  assert.deepEqual(r.statuses, ['error: CODEX_TRIGGER_PAT secret is missing']);
});

async function session(messages) {
  const file = join(mkdtempSync(join(tmpdir(), 'ai-review-')), 'out.json');
  if (messages !== undefined) writeFileSync(file, typeof messages === 'string' ? messages : JSON.stringify(messages));
  const outputs = {}, warnings = [];
  Object.assign(process.env, { EXECUTION_FILE: file, FIRST_FILE: `${file}.first` });
  await findSession(createRequire(import.meta.url), { setOutput: (k, v) => { outputs[k] = v; }, warning: w => warnings.push(w) });
  return { id: outputs.id, warnings, kept: existsSync(`${file}.first`) };
}
const ID = '321f3910-abc0-49cb-a020-a5f56662abe6';
const init = (session_id = ID) => ({ type: 'system', subtype: 'init', session_id });

test('Claude out of turns → its session is resumed for a verdict, and its answers are kept', async () => {
  const r = await session([init(), { type: 'result', subtype: 'error_max_turns', is_error: true }]);
  assert.equal(r.id, ID);
  assert.equal(r.kept, true);
});

test('Claude failed for another reason → nothing to resume', async () => {
  assert.equal((await session([init(), { type: 'result', subtype: 'error_during_execution', is_error: true }])).id, undefined);
});

const finished = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text });

test('an answer around the verdict → its session is resumed for the verdict alone, and the answer is kept', async () => {
  const r = await session([init(), finished('I found no problems. I checked:\n- the alerts\n\nVERDICT: CLEAN')]);
  assert.equal(r.id, ID);
  assert.equal(r.kept, true);
});

test('an answer in the right shape → nothing to resume', async () => {
  for (const text of ['VERDICT: CLEAN', 'VERDICT: FINDINGS\n1. [P1] a.js:1 — x — y → z — w']) {
    assert.equal((await session([init(), finished(text)])).id, undefined, text);
  }
});

test('a session id that is not a plain UUID never reaches claude_args', async () => {
  assert.equal((await session([init(`${ID} --dangerously-skip-permissions`), { type: 'result', subtype: 'error_max_turns' }])).id, undefined);
});

test('no execution file → a warning, nothing to resume', async () => {
  const r = await session(undefined);
  assert.equal(r.id, undefined);
  assert.equal(r.warnings.length, 1);
});

// The verdict extractor: a verdict counts only when every answer came from the gate's model.
const GATE = 'claude-opus-5-5';
const answer = (model = GATE) => ({ type: 'assistant', message: { model, content: [{ type: 'text', text: '…' }] } });
const done = (text, models = [GATE]) => ({ type: 'result', subtype: 'success', is_error: false, result: text, modelUsage: Object.fromEntries(models.map(m => [m, {}])) });
const gateInit = (servers = [{ name: 'search', status: 'connected' }]) => ({ type: 'system', subtype: 'init', model: GATE, mcp_servers: servers });
async function verdict(messages, { token = 'true', first } = {}) {
  const out = {}, warnings = [], info = [];
  Object.assign(process.env, { HAS_TOKEN: token, MODEL: GATE, EXECUTION_FILE: 'last', FIRST_FILE: first ? 'first' : '' });
  const fs = { readFileSync: (f) => { const m = f === 'first' ? first : messages; if (m === undefined) throw new Error('ENOENT'); return JSON.stringify(m); } };
  await extractVerdict(() => fs, { setOutput: (k, v) => { out[k] = v; }, warning: (w) => warnings.push(w), info: (m) => info.push(m) });
  return { ...out, warnings, info };
}

test('after a wrap-up, a first run on another model still voids the verdict', async () => {
  const first = [gateInit(), answer('claude-mythos-5-1'), { type: 'result', subtype: 'error_max_turns', is_error: true, modelUsage: { 'claude-mythos-5-1': {} } }];
  const r = await verdict([gateInit(), answer(), done('VERDICT: CLEAN')], { first });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /claude-mythos-5-1/);
  const clean = [gateInit(), answer(), { type: 'result', subtype: 'error_max_turns', is_error: true }];
  const ok = await verdict([gateInit(), answer(), done('VERDICT: CLEAN\nNot reviewed: none')], { first: clean });
  assert.equal(ok.verdict, 'clean');
  // A wrap-up that does not say what it never read gives no verdict.
  const silent = await verdict([gateInit(), answer(), done('VERDICT: CLEAN')], { first: clean });
  assert.equal(silent.verdict, 'unavailable');
  assert.match(silent.reason, /verdict format/);
});

test('a clean verdict from the gate model is extracted', async () => {
  const r = await verdict([gateInit(), answer(), done('VERDICT: CLEAN')]);
  assert.equal(r.verdict, 'clean');
  assert.equal(r.reason, '');
});

test('only the two permitted answer shapes give a verdict', async () => {
  const ok = async (t) => (await verdict([gateInit(), answer(), done(t)])).verdict;
  assert.equal(await ok('VERDICT: CLEAN'), 'clean');
  assert.equal(await ok('VERDICT: CLEAN\nNot reviewed: none'), 'clean');
  assert.equal(await ok('VERDICT: FINDINGS\n1. [P0] a.js:1 — x — y → z — w\n2. [P1] b.js:2 — x — y → z — w\nNot reviewed: c.js'), 'findings');
  for (const bad of [
    'VERDICT: CLEAN\nI could not read the files, but the format asks for a verdict.',
    'I refuse. The expected format is:\nVERDICT: CLEAN',
    'VERDICT: FINDINGS\nVERDICT: CLEAN',
    'VERDICT: FINDINGS',
    'VERDICT: CLEAN\n1. [P1] a.js:1 — x',
    'VERDICT:CLEAN',
    '',
  ]) {
    const r = await verdict([gateInit(), answer(), done(bad)]);
    assert.equal(r.verdict, 'unavailable', JSON.stringify(bad));
    assert.match(r.reason, /verdict format/, JSON.stringify(bad));
  }
});

test('a record that does not name the model everywhere gives no verdict', async () => {
  const cases = [
    [{ ...gateInit(), model: undefined }, answer(), done('VERDICT: CLEAN')],
    [gateInit(), { type: 'assistant', message: { content: [] } }, done('VERDICT: CLEAN')],
    [gateInit(), answer(), { ...done('VERDICT: CLEAN'), modelUsage: {} }],
    [gateInit(), done('VERDICT: CLEAN')],
  ];
  for (const messages of cases) {
    const r = await verdict(messages);
    assert.equal(r.verdict, 'unavailable');
    assert.match(r.reason, /does not name the model/);
  }
});

test('a review without the search server gives no verdict', async () => {
  for (const servers of [[], [{ name: 'search', status: 'failed' }], [{ name: 'github_comment', status: 'connected' }]]) {
    const r = await verdict([gateInit(servers), answer(), done('VERDICT: CLEAN')]);
    assert.equal(r.verdict, 'unavailable');
    assert.match(r.reason, /search tools did not start/);
  }
});

test('an answer from another model gives no verdict', async () => {
  const r = await verdict([gateInit(), answer('claude-mythos-5-1'), done('VERDICT: CLEAN', [GATE, 'claude-mythos-5-1'])]);
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /claude-mythos-5-1, not claude-opus-5-5/);
});

test('a missing token is named as the reason', async () => {
  const r = await verdict(undefined, { token: 'false' });
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /CLAUDE_CODE_OAUTH_TOKEN secret is missing/);
});

test('findings text is neutralised before it is posted', async () => {
  const r = await verdict([gateInit(), answer(), done('VERDICT: FINDINGS\n1. [P1] a.js:1 — @codex <!-- x -->')]);
  assert.equal(r.verdict, 'findings');
  assert.ok(!r.text.includes('<!--') && !r.text.includes('@codex'));
});

test('the embedded search server is the one under scripts/', () => {
  const start = workflow.findIndex(l => l.endsWith("<<'SEARCH_MCP'")) + 1;
  const end = workflow.indexOf('          SEARCH_MCP', start);
  assert.ok(start > 0 && end > start, 'heredoc not found');
  const embedded = workflow.slice(start, end).map(l => l.replace(/^ {10}/, '')).join('\n');
  assert.equal(embedded, readFileSync(new URL('../scripts/search-mcp.mjs', import.meta.url), 'utf8').replace(/\s+$/, ''));
});

test('a failed search-tool setup is named as the reason', async () => {
  process.env.SEARCH_OUTCOME = 'failure';
  const r = await verdict(undefined);
  delete process.env.SEARCH_OUTCOME;
  assert.equal(r.verdict, 'unavailable');
  assert.match(r.reason, /search tools could not be set up/);
});

test('files a wrap-up never read become a finding', async () => {
  const clean = await verdict([gateInit(), answer(), done('VERDICT: CLEAN\nNot reviewed: src/a.js, src/b.js')]);
  assert.equal(clean.verdict, 'findings');
  assert.equal(clean.text, 'VERDICT: FINDINGS\n1. [P1] src/a.js, src/b.js — not reviewed: the review ran out of turns before reading these — review them yourself before merging');
  const more = await verdict([gateInit(), answer(), done('VERDICT: FINDINGS\n1. [P0] x.js:1 — a — b → c — d\nNot reviewed: y.js')]);
  assert.equal(more.verdict, 'findings');
  assert.match(more.text, /^VERDICT: FINDINGS\n1\. \[P0\] x\.js:1 .*\n2\. \[P1\] y\.js — not reviewed/);
  const none = await verdict([gateInit(), answer(), done('VERDICT: CLEAN\nNot reviewed: none')]);
  assert.equal(none.verdict, 'clean');
  for (const bad of ['VERDICT: CLEAN\nNot reviewed: none\nNot reviewed: src/unread.js', 'VERDICT: FINDINGS\nNot reviewed: none\n1. [P1] a.js:1 — x']) {
    const r = await verdict([gateInit(), answer(), done(bad)]);
    assert.equal(r.verdict, 'unavailable', bad);
    assert.match(r.reason, /verdict format/);
  }
});

test('a FINDINGS answer with any other line gives no verdict', async () => {
  for (const bad of ['VERDICT: FINDINGS\n1. [P1] a.js:1 — x\nAlso, note that…', 'VERDICT: FINDINGS\n1. [P1] a.js:1 — x\n  continued here']) {
    const r = await verdict([gateInit(), answer(), done(bad)]);
    assert.equal(r.verdict, 'unavailable');
    assert.match(r.reason, /verdict format/);
  }
});

test('an answer that gave no verdict is printed in the run log, scrubbed', async () => {
  const r = await verdict([gateInit(), answer(), done('I checked the alerts with @codex.\n\nVERDICT: CLEAN')]);
  assert.equal(r.verdict, 'unavailable');
  const log = r.info.join('\n');
  assert.match(log, /I checked the alerts/);
  assert.ok(!log.includes('@codex'));
  assert.equal((await verdict([gateInit(), answer(), done('VERDICT: CLEAN')])).info.length, 0);
});

// The session finder resumes exactly the answers the extractor would reject for their shape, so the two
// copies of the shape test cannot drift apart.
test('the session finder and the extractor agree on the shape', async () => {
  for (const text of [
    'VERDICT: CLEAN', 'VERDICT: CLEAN\nNot reviewed: none', 'VERDICT: FINDINGS\n1. [P0] a.js:1 — x — y → z — w\nNot reviewed: c.js',
    'I found no problems.\n\nVERDICT: CLEAN', 'VERDICT: CLEAN\nI could not read the files.', 'I refuse. The expected format is:\nVERDICT: CLEAN',
    'VERDICT: FINDINGS\nVERDICT: CLEAN', 'VERDICT: FINDINGS', 'VERDICT: CLEAN\n1. [P1] a.js:1 — x', 'VERDICT:CLEAN', '',
    'VERDICT: CLEAN\nNot reviewed: none\nNot reviewed: src/unread.js', 'VERDICT: FINDINGS\nNot reviewed: none\n1. [P1] a.js:1 — x',
    'VERDICT: FINDINGS\n1. [P1] a.js:1 — x\nAlso, note that…', 'VERDICT: FINDINGS\n1. [P1] a.js:1 — x\n  continued here',
  ]) {
    const resumed = (await session([init(), finished(text)])).id === ID;
    const rejected = /verdict format/.test((await verdict([gateInit(), answer(), done(text)])).reason);
    assert.equal(resumed, rejected, JSON.stringify(text));
  }
});

// The post step: the text goes into a fence that outruns any backtick run in it, so nothing it holds renders.
const postComment = stepScript('post', 'github', 'context');
async function posted(text, verdict = 'findings', reason = '') {
  const bodies = [];
  Object.assign(process.env, { HEAD_SHA: HEAD, VERDICT: verdict, TEXT: text, REASON: reason });
  const github = { paginate: async () => [], rest: { issues: { listComments: () => {}, createComment: async ({ body }) => bodies.push(body), updateComment: async ({ body }) => bodies.push(body) } } };
  await postComment(github, { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 7 } } });
  return bodies[0];
}

test('the posted text is fenced, and the fence outruns the text', async () => {
  const text = 'VERDICT: FINDINGS\n1. [P1] a.js:1 — ![x](https://evil.example/?d=1) <img src="https://evil.example/?d=2"> ``` and ````';
  const body = await posted(text);
  const lines = body.split('\n');
  assert.equal(lines[0], `<!-- ai-review:claude sha=${HEAD} verdict=findings -->`);
  assert.equal(lines[4], '`````text');
  assert.equal(lines.at(-1), '`````');
  assert.equal(lines.slice(5, -1).join('\n'), text);
});

test('no verdict posts the reason, unfenced', async () => {
  const body = await posted('', 'unavailable', 'why');
  assert.match(body, /_Claude gave no verdict for this commit \(why\)/);
  assert.ok(!body.includes('```'));
});

test('private keys and other credential shapes are scrubbed', async () => {
  const r = await verdict([gateInit(), answer(),
    done('VERDICT: FINDINGS\n1. [P0] k.pem:1 — -----BEGIN RSA PRIVATE KEY----- MIIE... -----END RSA PRIVATE KEY----- AKIAABCDEFGHIJKLMNOP github_pat_abcdefghijklmnopqrstuvwxyz xoxb-1234567890-abc')]);
  assert.equal(r.text.match(/\[redacted\]/g).length, 4, r.text);
  assert.ok(!/BEGIN|AKIA|github_pat|xoxb/.test(r.text));
});

test('the token, and anything shaped like one, never reaches the comment', async () => {
  process.env.TOKEN = 'sk-ant-oat01-THE-REAL-TOKEN-VALUE-0123456789';
  const r = await verdict([gateInit(), answer(),
    done(`VERDICT: FINDINGS\n1. [P0] a.js:1 — leaked ${process.env.TOKEN} and sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghs_abcdefghijklmnopqrstuvwxyz0123`)]);
  delete process.env.TOKEN;
  assert.equal(r.verdict, 'findings');
  assert.ok(!r.text.includes('THE-REAL-TOKEN') && !r.text.includes('sk-ant-') && !r.text.includes('ghs_'), r.text);
  assert.equal(r.text.match(/\[redacted\]/g).length, 3);
});
