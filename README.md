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

With `codex-fixes: true` the coordinator instead asks Codex, using the owner's token because Codex ignores bot accounts, to rule on the findings and push fixes, for up to `max-rounds` rounds. It is off because, as tested on 2026-10-19, Codex cannot push a fix to the pull request branch. GitHub `@codex` fix requests need a Codex Cloud (Legacy) environment for the repository. Without one, Codex asks for it, and a new-style environment alone gets a review instead. With a Legacy environment the task fixes, tests and commits the change, then reports "no configured Git remote or push destination" ([openai/codex#38351](https://github.com/openai/codex/issues/38351)).

## Enrol a repository

From the owner's machine (it needs `gh` and `wsl -e ssh dreamfyre`):

```sh
ZAI_KEY_FILE=<file> scripts/enrol.sh <repo>
```

The script does three things. Each step is skipped when it is already done, so it is safe to re-run.

- It sets the secret `ZAI_API_KEY` (a GLM Coding Plan key), which goes from the file straight to `gh`. `CODEX_TRIGGER_PAT` (a fine-grained PAT with Issues and Pull requests read and write) is added only to repositories that turn on `codex-fixes`.
- For a private repository, it registers a review-only dreamfyre runner through the host's root-owned `/usr/local/lib/gha-review/register.sh`. That runner runs as user `gha-review`, separate from the `gha` CI runners, has no Docker, and uses the label `dreamfyre-review`. Public repositories use GitHub-hosted runners, which are free for them; dreamfyre serves private repositories only.
- It opens a pull request that adds [`caller.yml`](caller.yml) as `.github/workflows/ai-review.yml`. The reusable workflow picks the runner from the repository's visibility.

Codex code review must also be enabled for the repository in chatgpt.com/settings/code-review.

The coordinator acts on Codex's comments only once the caller is on the default branch, because `issue_comment` workflows run from there.

The caller tracks `@main`, so a change here reaches every repository at once. That is the point of keeping the logic in one place. The cost is that a push to this repository's `main` runs with those two secrets in every enrolled repository, so treat `main` here like production code.

## Test

```sh
node --test
```

The tests take the coordinator's decision script straight out of `review.yml` and run it against fake GitHub data.
