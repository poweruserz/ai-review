# ai-review

Reusable GitHub Actions workflow that puts every pull request in poweruserz's repositories through two AI reviewers.

1. **Codex** (the ChatGPT Codex Connector app) runs its code review and security review on every push. It is configured in chatgpt.com/settings/code-review, not here.
2. **GLM** reviews the same head through [claude-code-action](https://github.com/anthropics/claude-code-action) pointed at Z.ai's Anthropic-compatible endpoint, at max reasoning effort. It gets read-only tools.
3. **The coordinator** is plain script logic, not a model. It waits until both have reported on the current head and sets the commit status `ai-review`:

| Status | Meaning | What the Claude session that opened the PR does |
| --- | --- | --- |
| `pending` | reviews are still running | waits |
| `success` | Codex and GLM found nothing | runs its security gate (Mythos 5.1), then merges and deploys |
| `failure` | findings to rule on | reads Codex's inline comments and the GLM comment, fixes the real ones, pushes; each push is a new round |
| `error` | the pipeline could not finish | stops and reports |

With `codex-fixes: true` the coordinator instead asks Codex, using the owner's token because Codex ignores bot accounts, to rule on the findings and push fixes, for up to `max-rounds` rounds. It is off because GitHub `@codex` fix requests currently need a legacy Codex Cloud environment. Without one, Codex asks for it. With only a new-style environment, it runs a review instead (2026-10-19).

## Enrol a repository

Add `.github/workflows/ai-review.yml`:

```yaml
name: AI review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment: # Codex's review-state comment wakes the coordinator; runs from the default branch only
    types: [created, edited]

permissions:
  contents: read
  issues: write
  pull-requests: write
  statuses: write

jobs:
  ai-review:
    # Second gate next to the reusable workflow's own: other comments never start it.
    if: github.event_name == 'pull_request' || github.event.comment.user.login == 'chatgpt-codex-connector[bot]'
    # Tracks @main on purpose (owner's decision, 2026-10-19): the logic is maintained once for every repository.
    # Only this account can push to poweruserz/ai-review, and it can already write here directly, so a SHA pin
    # would cost one PR per repository per update without stopping a real attacker. Only two secrets go there.
    uses: poweruserz/ai-review/.github/workflows/review.yml@main
    with:
      runner: '["self-hosted","dreamfyre"]' # private repositories; public ones use '"ubuntu-latest"'
    secrets: # only these two, never `inherit`
      ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
      CODEX_TRIGGER_PAT: ${{ secrets.CODEX_TRIGGER_PAT }}
```

The caller tracks `@main`, so a change here reaches every repository at once. That is the point of keeping the logic in one place. The cost is that a push to this repository's `main` runs with the two secrets above in every enrolled repository, so treat `main` here like production code.

Then set up the secrets and the runner:

- Add the secrets `ZAI_API_KEY` (a GLM Coding Plan key) and `CODEX_TRIGGER_PAT` (a fine-grained PAT that only needs Issues: read and write).
- For a private repository, register a dreamfyre runner for it.
- Make sure the repository has Codex code review enabled and a Codex cloud environment.

The coordinator acts only once the caller is on the default branch, because `issue_comment` workflows run from there.

## Test

```sh
node --test
```

The tests take the coordinator's decision script straight out of `review.yml` and run it against fake GitHub data.
