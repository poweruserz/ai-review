#!/usr/bin/env bash
# Enrols one repository in the AI review pipeline: its two secrets, a dreamfyre runner for a private
# repository, and a pull request that adds caller.yml as .github/workflows/ai-review.yml.
# Run from the owner's machine (needs gh and `wsl -e ssh dreamfyre`). Every step is skipped when done,
# so re-running is safe.
# Usage: ZAI_KEY_FILE=<file> CODEX_PAT_FILE=<file> scripts/enrol.sh <repo>
set -euo pipefail
OWNER=poweruserz
REPO="${1:-}"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+$ && "$REPO" != .* || "$REPO" == .github ]] || { echo "usage: enrol.sh <repo>" >&2; exit 1; }
: "${ZAI_KEY_FILE:?set ZAI_KEY_FILE}" "${CODEX_PAT_FILE:?set CODEX_PAT_FILE}"
here="$(cd "$(dirname "$0")" && pwd)"
say() { echo "[$REPO] $*"; }

IFS=$'\t' read -r private fork archived branch < <(gh api "repos/$OWNER/$REPO" --jq '[.private, .fork, .archived, .default_branch] | @tsv')
if [ "$fork" = true ] || [ "$archived" = true ]; then say "fork or archived, skipped"; exit 0; fi

# Secrets go from the files straight to gh and are never printed.
tr -d '\r\n' < "$ZAI_KEY_FILE" | gh secret set ZAI_API_KEY -R "$OWNER/$REPO"
tr -d '\r\n' < "$CODEX_PAT_FILE" | gh secret set CODEX_TRIGGER_PAT -R "$OWNER/$REPO"
say "secrets set"

if [ "$private" = true ]; then
  runner='["self-hosted","dreamfyre"]'
  if [ "$(gh api "repos/$OWNER/$REPO/actions/runners" --jq '[.runners[] | select(any(.labels[]; .name == "dreamfyre"))] | length')" = 0 ]; then
    wsl -e ssh dreamfyre "sudo -u gha -H env XDG_RUNTIME_DIR=/run/user/1009 bash -s -- '$REPO' prepare" < "$here/dreamfyre-runner.sh"
    # The registration token goes through the pipe only (register.sh reads it from stdin).
    gh api -X POST "repos/$OWNER/$REPO/actions/runners/registration-token" --jq .token \
      | wsl -e ssh dreamfyre "sudo -u gha -H bash /home/gha/runners/register.sh '$REPO'" | grep -E '√|Error|error' || true
    wsl -e ssh dreamfyre "sudo -u gha -H env XDG_RUNTIME_DIR=/run/user/1009 bash -s -- '$REPO' start" < "$here/dreamfyre-runner.sh"
    say "runner dreamfyre-$REPO started"
  else
    say "dreamfyre runner already registered"
  fi
else
  # The dreamfyre runner serves private repositories only; public ones run on GitHub-hosted runners for free.
  runner='"ubuntu-latest"'
fi

if gh api "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml?ref=$branch" >/dev/null 2>&1; then
  say "caller already on $branch"; exit 0
fi
open_pr="$(gh pr list -R "$OWNER/$REPO" --head ci/ai-review --state open --json url --jq '.[0].url // ""')"
if [ -n "$open_pr" ]; then say "PR already open: $open_pr"; exit 0; fi

base_sha="$(gh api "repos/$OWNER/$REPO/git/ref/heads/$branch" --jq .object.sha)"
gh api -X POST "repos/$OWNER/$REPO/git/refs" -f ref=refs/heads/ci/ai-review -f sha="$base_sha" >/dev/null 2>&1 \
  || gh api -X PATCH "repos/$OWNER/$REPO/git/refs/heads/ci/ai-review" -f sha="$base_sha" -F force=true >/dev/null
content="$(sed "s|runner: '.*'|runner: '$runner'|" "$here/../caller.yml" | base64 -w0)"
gh api -X PUT "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml" -f branch=ci/ai-review -f content="$content" \
  -f message="$(printf 'Add AI review: Codex and GLM review every pull request\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_018sTpGTbWLyCYygSZ4GoHwv')" >/dev/null
gh pr create -R "$OWNER/$REPO" --base "$branch" --head ci/ai-review \
  --title "Add AI review: Codex and GLM review every pull request" \
  --body "$(printf 'Adds `.github/workflows/ai-review.yml`, the caller for [poweruserz/ai-review](https://github.com/poweruserz/ai-review): GLM reviews every pull request head next to Codex, and a coordinator sets commit status `ai-review` (success, failure = findings for the Claude session, error). Same file as poweruserz/meteosfer#36, which passed the Mythos security gate.\n\nThe coordinator'"'"'s `issue_comment` trigger runs from the default branch, so the full loop starts after this merges.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_018sTpGTbWLyCYygSZ4GoHwv')"
