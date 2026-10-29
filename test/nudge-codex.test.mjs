import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, line } from '../scripts/nudge-codex.mjs';

const head = 'a'.repeat(40);
const t = (minute) => new Date(Date.UTC(2026, 9, 29, 10, minute)).toISOString();
const status = (state, description, minute) => ({ context: 'ai-review', state, description, created_at: t(minute) });
const codex = (sha, security = 'completed') => ({
  user: { login: 'chatgpt-codex-connector[bot]' }, created_at: t(1),
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status: 'completed' }, security_review: { commit_sha: sha, status: security } })} -->\n## Codex Review Summary`,
});
const ask = (minute, login = 'poweruserz') => ({ user: { login }, created_at: t(minute), body: '@codex review' });
const base = {
  head, owner: 'poweruserz', now: Date.parse(t(25)), pushed: Date.parse(t(0)),
  statuses: [status('pending', 'waiting for Codex and Claude', 0), status('pending', 'waiting for Codex', 4)],
  comments: [],
};

test('a head Codex has not reviewed 20 minutes after the push gets a nudge', () => {
  assert.equal(decide(base), 'kick');
});

test('younger than 20 minutes: wait', () => {
  assert.match(decide({ ...base, now: Date.parse(t(15)) }), /15 min since the push/);
});

test('a status that no longer waits for Codex: nothing', () => {
  for (const s of [status('pending', 'waiting for Claude', 5), status('success', 'Codex and Claude found nothing', 5), status('failure', 'findings to rule on from Codex', 5), status('error', 'Claude gave no verdict', 5)]) {
    assert.notEqual(decide({ ...base, statuses: [...base.statuses, s] }), 'kick', s.description);
  }
  assert.equal(decide({ ...base, statuses: [] }), 'no ai-review status');
});

test('Codex finished on this head and only the coordinator is late: nothing', () => {
  assert.match(decide({ ...base, comments: [codex(head)] }), /coordinator is late/);
});

test('Codex finished on an older head, or its security review hangs on this one: nudge', () => {
  assert.equal(decide({ ...base, comments: [codex('b'.repeat(40))], statuses: [...base.statuses, status('pending', 'waiting for Codex; Codex last reviewed bbbbbbb', 5)] }), 'kick');
  assert.equal(decide({ ...base, comments: [codex(head, 'running')] }), 'kick');
});

test("the public run log names a private repository's pull request, head and status in no case", () => {
  assert.equal(line(true, 'poweruserz/pub', 7, head, 'success: Codex and Claude found nothing'), `poweruserz/pub#7 ${head.slice(0, 7)}: success: Codex and Claude found nothing`);
  for (const [text, shown] of [['kick', 'asked'], ['error: into feat/secret-branch, not main', 'nothing to do'], ['failed: HTTP 404 repos/poweruserz/hidden-repo/pulls/7', 'failed'], ['failed:', 'failed']]) {
    const out = line(false, 'poweruserz/hidden-repo', 7, head, text);
    assert.equal(out, `a private repository: ${shown}`);
    for (const secret of ['hidden-repo', '7', head.slice(0, 7), 'secret-branch', '404']) assert.ok(!out.includes(secret), `${out} leaks ${secret}`);
  }
});

test('already asked since the push, by a session or by this script: nothing; an ask from before the push does not count', () => {
  assert.match(decide({ ...base, comments: [ask(21)] }), /already asked/);
  assert.match(decide({ ...base, comments: [{ ...ask(21), body: '@codex review\n\n<!-- ai-review:nudge sha=' + head + ' -->' }] }), /already asked/);
  assert.equal(decide({ ...base, comments: [ask(-5)] }), 'kick');
  assert.equal(decide({ ...base, comments: [ask(21, 'someone-else')] }), 'kick');
});

test('the clock is the push, not the first status: an ask before a late first status counts, and the wait starts at the push', () => {
  const late = { ...base, statuses: [status('pending', 'waiting for Codex', 10)], now: Date.parse(t(35)) };
  assert.match(decide({ ...late, comments: [ask(2)] }), /already asked/);
  assert.equal(decide({ ...late, now: Date.parse(t(22)) }), 'kick');
  assert.match(decide({ ...late, pushed: undefined, now: Date.parse(t(22)) }), /12 min since the push/);
});
