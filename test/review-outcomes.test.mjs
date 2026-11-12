// The counting rules of scripts/review-outcomes.mjs, without GitHub.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviews, outcomes } from '../scripts/review-outcomes.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const body = (sha, verdict, ...lines) => [`<!-- ai-review:claude sha=${sha} verdict=${verdict} -->`, '### Claude review', `Commit \`${sha.slice(0, 7)}\``, '', '```text', `VERDICT: ${verdict.toUpperCase()}`, ...lines, '```'].join('\n');
const finding = (n, path, problem) => `${n}. [P1] ${path}:12 — ${problem} — input → outcome — fix — none — \`x\``;

test('the reviews of a pull request are the versions of the one comment, oldest first', () => {
  const comment = {
    createdAt: '2026-10-21T10:00:00Z',
    body: body(B, 'clean'),
    // Newest first, and the oldest entry is the original body under the date of the first edit.
    userContentEdits: { nodes: [{ createdAt: '2026-10-21T11:00:00Z', diff: body(B, 'clean') }, { createdAt: '2026-10-21T11:00:00Z', diff: body(A, 'findings', finding(1, 'src/a.js', 'wrong sum')) }] },
  };
  const list = reviews(comment);
  assert.deepEqual(list.map(r => [r.at, r.sha, r.verdict, r.findings.length]), [['2026-10-21T10:00:00Z', A, 'findings', 1], ['2026-10-21T11:00:00Z', B, 'clean', 0]]);
  assert.deepEqual(list[0].findings[0], { priority: 'P1', path: 'src/a.js', problem: 'wrong sum', unread: false });
  // A comment that was never edited is its only review.
  assert.equal(reviews({ createdAt: '2026-10-21T10:00:00Z', body: body(A, 'clean'), userContentEdits: { nodes: [] } }).length, 1);
});

test('a finding is judged where it was last raised: acted on, dropped, rejected or left open', () => {
  const list = [
    { sha: A, findings: [{ path: 'src/a.js', problem: 'wrong sum' }, { path: 'src/b.js', problem: 'no auth' }, { path: 'src/c.js', problem: 'race' }] },
    { sha: B, findings: [{ path: 'src/c.js', problem: 'race' }] },
    { sha: C, findings: [{ path: 'src/d.js', problem: 'leak' }, { path: 'x.js y.js', problem: 'not reviewed', unread: true }] },
  ];
  const out = outcomes({ list, ruled: new Set([B]), changed: [new Set(['src/a.js']), new Set(), null], codex: new Set(['src/a.js']) });
  assert.deepEqual(out.map(f => [f.path, f.sha, f.outcome, f.codexToo]), [
    ['src/a.js', A, 'acted on', true], // its file changed and the next review dropped it
    ['src/b.js', A, 'dropped', false], // dropped though its file did not change
    ['src/c.js', B, 'rejected', false], // repeated once, then ruled on: counted once, at the ruling
    ['src/d.js', C, 'left open', false], // the last review still raised it; the unread files are not a finding
  ]);
  // Two commits that cannot be compared (a rewritten branch) prove nothing either way.
  assert.equal(outcomes({ list: list.slice(0, 2), ruled: new Set(), changed: [null, null], codex: new Set() })[0].outcome, 'unknown');
  // The same bug in new words, in a file no push touched, is one finding, not one per review.
  const reworded = [{ sha: A, findings: [{ path: 'src/a.js', problem: 'wrong sum' }] }, { sha: B, findings: [{ path: 'src/a.js', problem: 'the total is off by one' }] }];
  assert.deepEqual(outcomes({ list: reworded, ruled: new Set(), changed: [new Set(['README.md']), null], codex: new Set() }).map(f => [f.sha, f.outcome]), [[B, 'left open']]);
});

test('the files the extraction reports as unread are told apart from findings, however many it names', () => {
  const unread = '2. [P1] tests/a.php, tests/b.php — not reviewed: the execution record shows no Read of 9 of the 20 lines of the diff, in these files — review them yourself before merging';
  const [review] = reviews({ createdAt: '2026-11-13T10:00:00Z', body: body(A, 'findings', finding(1, 'src/a.js', 'wrong sum'), unread), userContentEdits: { nodes: [] } });
  assert.deepEqual(review.findings.map(f => [f.path, f.unread]), [['src/a.js', false], ['tests/a.php, tests/b.php', true]]);
});
