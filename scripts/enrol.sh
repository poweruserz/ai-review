#!/usr/bin/env bash
# Enrols one repository in the AI review pipeline: its ZAI_API_KEY secret, a review-only dreamfyre runner for
# a private repository (user gha-review, label dreamfyre-review), and a pull request that adds caller.yml as
# .github/workflows/ai-review.yml.
# Run from the owner's machine (needs gh and `wsl -e ssh dreamfyre`). Every step is skipped when done,
# so re-running is safe.
# Usage: ZAI_KEY_FILE=<file> scripts/enrol.sh <repo>
set -euo pipefail
OWNER=poweruserz
REPO="${1:-}"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+$ && "$REPO" != .* || "$REPO" == .github ]] || { echo "usage: enrol.sh <repo>" >&2; exit 1; }
: "${ZAI_KEY_FILE:?set ZAI_KEY_FILE}"
here="$(cd "$(dirname "$0")" && pwd)"
say() { echo "[$REPO] $*"; }

IFS=$'\t' read -r private fork archived branch < <(gh api "repos/$OWNER/$REPO" --jq '[.private, .fork, .archived, .default_branch] | @tsv')
if [ "$fork" = true ] || [ "$archived" = true ]; then say "fork or archived, skipped"; exit 0; fi

# The key goes from the file straight to gh and is never printed. CODEX_TRIGGER_PAT is only for
# codex-fixes, which is off, so the owner's PAT is not copied into every repository.
tr -d '\r\n' < "$ZAI_KEY_FILE" | gh secret set ZAI_API_KEY -R "$OWNER/$REPO"
say "secret set"

# Public repositories run on GitHub-hosted runners for free and never get a dreamfyre runner.
if [ "$private" = true ]; then
  if [ "$(gh api "repos/$OWNER/$REPO/actions/runners" --jq '[.runners[] | select(any(.labels[]; .name == "dreamfyre-review"))] | length')" = 0 ]; then
    # The registration token goes through the pipe only; the root-owned register.sh reads it from stdin.
    gh api -X POST "repos/$OWNER/$REPO/actions/runners/registration-token" --jq .token \
      | wsl -e ssh dreamfyre "sudo -u gha-review -H env XDG_RUNTIME_DIR=/run/user/1010 /usr/local/lib/gha-review/register.sh '$REPO'"
  else
    say "review runner already registered"
  fi
fi

if gh api "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml?ref=$branch" >/dev/null 2>&1; then
  say "caller already on $branch"; exit 0
fi
open_pr="$(gh pr list -R "$OWNER/$REPO" --head ci/ai-review --state open --json url --jq '.[0].url // ""')"
if [ -n "$open_pr" ]; then say "PR already open: $open_pr"; exit 0; fi

base_sha="$(gh api "repos/$OWNER/$REPO/git/ref/heads/$branch" --jq .object.sha)"
gh api -X POST "repos/$OWNER/$REPO/git/refs" -f ref=refs/heads/ci/ai-review -f sha="$base_sha" >/dev/null 2>&1 \
  || gh api -X PATCH "repos/$OWNER/$REPO/git/refs/heads/ci/ai-review" -f sha="$base_sha" -F force=true >/dev/null
content="$(base64 -w0 < "$here/../caller.yml")"
gh api -X PUT "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml" -f branch=ci/ai-review -f content="$content" \
  -f message="$(printf 'Add AI review: Codex and GLM review every pull request\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_018sTpGTbWLyCYygSZ4GoHwv')" >/dev/null
gh pr create -R "$OWNER/$REPO" --base "$branch" --head ci/ai-review \
  --title "Add AI review: Codex and GLM review every pull request" \
  --body "$(printf 'Adds `.github/workflows/ai-review.yml`, the caller for [poweruserz/ai-review](https://github.com/poweruserz/ai-review): GLM reviews every pull request head next to Codex, and a coordinator sets commit status `ai-review` (success, failure = findings for the Claude session, error). Same file as poweruserz/meteosfer#36, which passed the Mythos security gate.\n\nThe coordinator'"'"'s `issue_comment` trigger runs from the default branch, so the full loop starts after this merges.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_018sTpGTbWLyCYygSZ4GoHwv')"
