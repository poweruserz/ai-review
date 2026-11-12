#!/usr/bin/env node
// What became of Claude's findings in real pull requests: the number the gate model is judged by, next to the
// benchmark, which only asks whether Claude repeats what Codex found. Each finding is followed from the last
// review that raised it:
//   acted on    the next push changed the file it points to and the next review no longer raised it
//   rejected    the owner ruled on that commit (<!-- ai-review:ruled -->)
//   dropped     the next review no longer raised it, though its file did not change (rejected without a ruling,
//               or fixed in another file)
//   left open   the last review of the pull request still raised it
// Run from the owner's machine with gh signed in. The output names private repositories: keep it off public pages.
// Usage: node scripts/review-outcomes.mjs [account] [since, YYYY-MM-DD] [--list]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MARKER = /^<!-- ai-review:claude sha=([0-9a-f]{40}) verdict=(clean|findings|unavailable) -->/;

// One review per version of the comment: the post job edits a single comment, so the earlier reviews are its edit
// history (newest first, and the oldest entry holds the original body, dated by the comment itself).
export function reviews(comment) {
  const edits = comment.userContentEdits?.nodes ?? [];
  const bodies = edits.length
    ? edits.map((e, i) => ({ at: i === edits.length - 1 ? comment.createdAt : e.createdAt, body: e.diff ?? '' })).reverse()
    : [{ at: comment.createdAt, body: comment.body }];
  return bodies.flatMap(({ at, body }) => {
    const m = MARKER.exec(body);
    if (!m) return [];
    const findings = body.split('\n').flatMap(l => {
      const f = /^\d+\. \[(P[01])\] (.+?) — (.*)$/.exec(l.trimEnd());
      // The extraction's own lines (files nobody read, which it names as a list) are not the model's findings.
      return f ? [{ priority: f[1], path: f[2].replace(/:\d+$/, ''), problem: f[3].split(' — ')[0], unread: /^not reviewed: /.test(f[3]) }] : [];
    });
    return [{ at, sha: m[1], verdict: m[2], findings }];
  });
}

// `list` is one pull request's reviews in order, one per head (a re-run replaces the review of the same head);
// `ruled` the heads the owner ruled on; `changed[i]` the files changed between review i and the next one, or null
// when the two commits cannot be compared; `codex` the files Codex commented on in this pull request.
export function outcomes({ list, ruled, changed, codex }) {
  const out = [];
  list.forEach((review, i) => {
    const next = list[i + 1];
    for (const f of review.findings.filter(f => !f.unread)) {
      // Raised again, word for word or in new words about a file that did not change in between: the same
      // finding, judged where it was last seen.
      if (next?.findings.some(n => !n.unread && n.path === f.path && (n.problem === f.problem || !changed[i]?.has(f.path)))) continue;
      const outcome = ruled.has(review.sha) ? 'rejected' : !next ? 'left open'
        : !changed[i] ? 'unknown' : changed[i].has(f.path) ? 'acted on' : 'dropped';
      out.push({ ...f, sha: review.sha, outcome, codexToo: codex.has(f.path) });
    }
  });
  return out;
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const rest = (path, ...fields) => JSON.parse(gh('api', '-X', 'GET', '--paginate', '--slurp', path, ...fields.flatMap(f => ['-f', f]))).flat();
// shortcut: the first 100 comments and review threads of a pull request, page when one has more.
const QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  state
  comments(first: 100) { nodes { author { login } createdAt body userContentEdits(first: 100) { nodes { createdAt diff } } } }
  reviewThreads(first: 100) { nodes { path comments(first: 1) { nodes { author { login } } } } } } } }`;

export function main(account, since, listAll) {
  const owner = gh('api', 'user', '--jq', '.login').trim();
  const items = rest('search/issues', `q=owner:${account} is:pr updated:>=${since}`, 'per_page=100').flatMap(p => p.items ?? []);
  const tally = {}, count = (k, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  for (const item of items) {
    const [repoOwner, repo] = item.repository_url.split('/').slice(-2);
    const pr = JSON.parse(gh('api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${repoOwner}`, '-f', `repo=${repo}`, '-F', `number=${item.number}`)).data.repository.pullRequest;
    const comment = pr.comments.nodes.find(c => c.author?.login === 'github-actions' && MARKER.test(c.body));
    if (!comment) continue;
    const all = reviews(comment).filter(r => r.at.slice(0, 10) >= since);
    if (!all.length) continue;
    count('pull requests');
    count('reviews', all.length);
    for (const r of all) count(`reviews: ${r.verdict === 'unavailable' ? 'no verdict' : r.verdict}`);
    count('reviews that left files unread', all.filter(r => r.findings.some(f => f.unread)).length);
    // One review per head, the last one: a re-run of the same head replaces it.
    const list = all.filter(r => r.verdict !== 'unavailable').filter((r, i, a) => a[i + 1]?.sha !== r.sha);
    const ruled = new Set(pr.comments.nodes.filter(c => c.author?.login === owner).map(c => /^<!-- ai-review:ruled sha=([0-9a-f]{40}) -->/.exec(c.body)?.[1]).filter(Boolean));
    const codex = new Set(pr.reviewThreads.nodes.filter(t => t.comments.nodes[0]?.author?.login === 'chatgpt-codex-connector').map(t => t.path));
    const changed = list.map((r, i) => {
      if (!list[i + 1] || !r.findings.length) return null;
      try { return new Set(rest(`repos/${repoOwner}/${repo}/compare/${r.sha}...${list[i + 1].sha}`, 'per_page=100').flatMap(p => p.files ?? []).map(f => f.filename)); } catch { return null; }
    });
    for (const f of outcomes({ list, ruled, changed, codex })) {
      count(`findings: ${f.outcome}`);
      if (f.outcome === 'acted on') count(`acted on, ${f.codexToo ? 'in a file Codex commented on too' : 'in a file Codex said nothing about'}`);
      if (listAll) console.log(`${repoOwner}/${repo}#${item.number} ${f.sha.slice(0, 7)} [${f.priority}] ${f.path} — ${f.outcome}${f.codexToo ? ' (Codex too)' : ''} — ${f.problem.slice(0, 120)}`);
    }
  }
  console.log(`Claude reviews since ${since} in ${account}'s repositories`);
  for (const [k, n] of Object.entries(tally).sort()) console.log(`${String(n).padStart(5)}  ${k}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter(a => a !== '--list');
  main(args[0] ?? 'poweruserz', args[1] ?? '2026-10-20', process.argv.includes('--list'));
}
