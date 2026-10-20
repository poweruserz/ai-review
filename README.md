# ai-review

Reusable GitHub Actions workflow that puts every pull request in poweruserz's repositories through two AI reviewers.

1. **Codex** (the ChatGPT Codex Connector app) runs its code review and security review on every push. It is configured in chatgpt.com/settings/code-review, not here.
2. **GLM** reviews the same head through [claude-code-action](https://github.com/anthropics/claude-code-action) pointed at Z.ai's Anthropic-compatible endpoint, at max reasoning effort. It gets read-only tools. If it runs out of turns (`glm-max-turns`, default 100), the same session is resumed with tools off, so it gives its verdict from what it has read and names the files it did not get to.
3. **The coordinator** is plain script logic, not a model. It waits until both have reported on the current head and sets the commit status `ai-review`:

| Status | Meaning | What the Claude session that opened the PR does |
| --- | --- | --- |
| `pending` | reviews are still running | waits |
| `success` | Codex and GLM found nothing | runs its security gate (Mythos 5.1), then merges and deploys |
| `failure` | findings to rule on | reads Codex's inline comments and the GLM comment, fixes the real ones, pushes; each push is a new round |
| `error` | the pipeline could not finish | stops and reports |

A finding the session rejects gets a ruling instead of a push. The session replies to each Codex thread and resolves it, then posts one pull request comment that starts with `<!-- ai-review:ruled sha=<full head SHA> -->` and gives its reasons. Neither resolving a thread nor that comment wakes the coordinator, so the session then runs `scripts/recheck.sh <repo> <pr>`, which re-runs it. The coordinator sets `success` only when all of these hold:

- The comment is the repository owner's.
- It is newer than both reviews' results on that head.
- Codex has finished.
- Every Codex thread is resolved.

So a finding that lands after the ruling still blocks.

With `codex-fixes: true` the coordinator instead asks Codex, using the owner's token because Codex ignores bot accounts, to rule on the findings and push fixes, for up to `max-rounds` rounds. It is off because, as tested on 2026-10-19, Codex cannot push a fix to the pull request branch. GitHub `@codex` fix requests need a Codex Cloud (Legacy) environment for the repository. Without one, Codex asks for it, and a new-style environment alone gets a review instead. With a Legacy environment the task fixes, tests and commits the change, then reports "no configured Git remote or push destination" ([openai/codex#38351](https://github.com/openai/codex/issues/38351)).

## Enrol a repository

From the owner's machine (it needs `gh` and `wsl -e ssh dreamfyre`):

```sh
ZAI_KEY_FILE=<file> scripts/enrol.sh <repo>
```

The script does four things. Each step is skipped when it is already done, so it is safe to re-run.

- It sets the secret `ZAI_API_KEY` (a GLM Coding Plan key), which goes from the file straight to `gh`. `CODEX_TRIGGER_PAT` (a fine-grained PAT with Issues and Pull requests read and write) is added only to repositories that turn on `codex-fixes`.
- For a private repository, it registers a review-only dreamfyre runner through the host's root-owned `/usr/local/lib/gha-review/register.sh`. That runner runs as user `gha-review`, separate from the `gha` CI runners, has no Docker, and uses the label `dreamfyre-review`. Public repositories use GitHub-hosted runners, which are free for them; dreamfyre serves private repositories only.
- It adds the ruleset [`scripts/ruleset.json`](scripts/ruleset.json). From then on, merging into the default branch needs `ai-review` success, set by GitHub Actions (app 15368), so a status that another account posts does not count. It is a guard against merging too early, not a security boundary. A same-repository pull request that edits a workflow could post that status itself with its own `GITHUB_TOKEN`. Only someone with write access can open one, and in these single-owner repositories that person is an admin who can bypass the ruleset anyway. The Mythos gate reviews workflow changes before merge. If a repository gains a collaborator with write access, the status has to come from a `workflow_run` on the default branch instead. Fork pull requests cannot post it, because their token is read-only. The ruleset never requires the branch to be up to date, so a merge does not trigger another review. Repository admins can bypass it (`gh pr merge --admin`, or the bypass box in the merge dialog). This is for pull requests that get no status, and for direct pushes. Dependabot pull requests get no status, and neither do fork pull requests, on purpose: the owner merges outside code deliberately. A pull request into another branch gets `error`, because retargeting it to the default branch runs nothing and would otherwise keep a success computed against the old base.
- It opens a pull request that adds [`caller.yml`](caller.yml) as `.github/workflows/ai-review.yml`. The reusable workflow picks the runner from the repository's visibility. `issue_comment` workflows run from the default branch, so until this merges, neither Codex finishing nor a ruling wakes the coordinator after its first run. Once Codex has reviewed the pull request, and after any ruling, run the script again. It re-runs the coordinator, so the enrolment pull request also merges on a real `ai-review` success.

Codex code review must also be enabled for the repository in chatgpt.com/settings/code-review.

The caller tracks `@main`, so a change here reaches every repository at once. That is the point of keeping the logic in one place. The cost is that a push to this repository's `main` runs with those two secrets in every enrolled repository, so treat `main` here like production code.

## Test

```sh
node --test
```

The tests take the coordinator's decision script straight out of `review.yml` and run it against fake GitHub data.
