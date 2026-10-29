#!/usr/bin/env node
// Asks Codex for a review, as the owner, on every open pull request whose head it has left unreviewed for
// 20 minutes. Codex skips a push that lands while it is still reviewing the one before, and a review job it
// starts on a freshly opened pull request can stay `running` forever (openai/codex#55890, #57619); a fresh
// `@codex review` comment from the owner makes it finish in a few minutes. Run by nudge-codex.yml with
// CODEX_TRIGGER_PAT as GH_TOKEN, because Codex ignores comments from bot accounts.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WAIT_MINUTES = 20;

// The decision alone, so it can be tested: `statuses` are the head's commit statuses, `comments` the pull
// request's, `owner` the account that will comment. Returns 'kick' or the reason not to.
export function decide({ head, statuses, comments, owner, now }) {
  const mine = statuses.filter(s => s.context === 'ai-review').sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const latest = mine.at(-1);
  if (!latest) return 'no ai-review status';
  if (latest.state !== 'pending' || !latest.description.startsWith('waiting for Codex')) return `${latest.state}: ${latest.description}`;
  const since = Date.parse(mine[0].created_at); // the coordinator's first status follows the push within a minute
  const minutes = (now - since) / 60000;
  if (minutes < WAIT_MINUTES) return `${minutes.toFixed(0)} min since the push`;
  let codex;
  for (const c of comments) {
    if (c.user.login !== 'chatgpt-codex-connector[bot]') continue;
    const m = /codex-review-state:v1 (\{.*?\}) -->/s.exec(c.body);
    if (m) try { codex = JSON.parse(m[1]); } catch {}
  }
  const onHead = r => r?.commit_sha === head && r.status === 'completed';
  if (onHead(codex?.code_review) && (!codex.security_review || onHead(codex.security_review))) return 'Codex has finished on this head; the coordinator is late, not Codex';
  if (comments.some(c => c.user.login === owner && Date.parse(c.created_at) >= since && /@codex review/i.test(c.body))) return 'already asked since the push';
  return 'kick';
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 << 20 });
const api = (path, ...fields) => JSON.parse(gh('api', '-X', 'GET', '--paginate', '--slurp', path, ...fields.flatMap(f => ['-f', f]))).flat();

export function main(account) {
  const owner = gh('api', 'user', '--jq', '.login').trim();
  const now = Date.now();
  const items = api('search/issues', `q=owner:${account} is:pr is:open draft:false`, 'per_page=100').flatMap(p => p.items ?? []);
  for (const item of items) {
    const repo = item.repository_url.split('/').slice(-2).join('/');
    const pr = api(`repos/${repo}/pulls/${item.number}`)[0];
    if (pr.head.repo?.full_name !== repo) continue; // a fork's head gets no status
    const head = pr.head.sha;
    const statuses = api(`repos/${repo}/commits/${head}/statuses`, 'per_page=100');
    const comments = api(`repos/${repo}/issues/${item.number}/comments`, 'per_page=100');
    const verdict = decide({ head, statuses, comments, owner, now });
    console.log(`${repo}#${item.number} ${head.slice(0, 7)}: ${verdict}`);
    if (verdict !== 'kick') continue;
    gh('api', '-X', 'POST', `repos/${repo}/issues/${item.number}/comments`, '-f', `body=@codex review\n\n<!-- ai-review:nudge sha=${head} -->`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2] ?? 'poweruserz');
