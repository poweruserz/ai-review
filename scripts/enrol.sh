#!/usr/bin/env bash
# Enrols one repository in the AI review pipeline: its CLAUDE_CODE_OAUTH_TOKEN secret, a review-only dreamfyre
# runner for a private repository (user gha-review, label dreamfyre-review), and a pull request that adds caller.yml
# as .github/workflows/ai-review.yml, or updates it when the one on the default branch differs. Run it again once
# Codex has reviewed an enrolment pull request: it adds the ruleset that makes merging need ai-review success, then
# re-runs the coordinator, which nothing else wakes before the caller merges.
# Run from the owner's machine (needs gh and `wsl -e ssh dreamfyre`). Every step is skipped when done,
# so re-running is safe.
# Usage: CLAUDE_TOKEN_FILE=<file> scripts/enrol.sh <repo>
set -euo pipefail
OWNER=poweruserz
REPO="${1:-}"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+$ && "$REPO" != .* || "$REPO" == .github ]] || { echo "usage: enrol.sh <repo>" >&2; exit 1; }
: "${CLAUDE_TOKEN_FILE:?set CLAUDE_TOKEN_FILE}"
here="$(cd "$(dirname "$0")" && pwd)"
say() { echo "[$REPO] $*"; }
attribution="$(printf 'Co-Authored-By: Claude Mythos 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01X8NDCJer3icfvYuk4P3vCJ')"
trailer="$(printf '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01X8NDCJer3icfvYuk4P3vCJ')"

IFS=$'\t' read -r private fork archived branch < <(gh api "repos/$OWNER/$REPO" --jq '[.private, .fork, .archived, .default_branch] | @tsv')
if [ "$fork" = true ] || [ "$archived" = true ]; then say "fork or archived, skipped"; exit 0; fi

# The token goes from the file straight to gh and is never printed. CODEX_TRIGGER_PAT lives only in the
# ai-review repository (for nudge-codex.yml; codex-fixes is off), so the owner's PAT is not copied into every repository.
tr -d '\r\n' < "$CLAUDE_TOKEN_FILE" | gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$OWNER/$REPO"
say "secret set"

# Writes caller.yml as the caller on <branch>; a push there starts that branch's review.
put_caller() {
  local head="$1" title="$2" sha
  local args=(-f branch="$head" -f content="$(base64 -w0 < "$here/../caller.yml")" -f message="$(printf '%s\n\n%s' "$title" "$attribution")")
  sha="$(gh api "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml?ref=$head" --jq .sha 2>/dev/null || true)"
  [ -z "$sha" ] || args+=(-f sha="$sha")
  gh api -X PUT "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml" "${args[@]}" >/dev/null
}
# Opens a pull request from <branch> with caller.yml as the caller, creating or moving the branch to the default
# branch's head first.
caller_pr() {
  local head="$1" title="$2" body="$3" base_sha
  base_sha="$(gh api "repos/$OWNER/$REPO/git/ref/heads/$branch" --jq .object.sha)"
  gh api -X POST "repos/$OWNER/$REPO/git/refs" -f ref="refs/heads/$head" -f sha="$base_sha" >/dev/null 2>&1 \
    || gh api -X PATCH "repos/$OWNER/$REPO/git/refs/heads/$head" -f sha="$base_sha" -F force=true >/dev/null
  put_caller "$head" "$title"
  gh pr create -R "$OWNER/$REPO" --base "$branch" --head "$head" --title "$title" --body "$(printf '%s\n\n%s' "$body" "$trailer")"
}
# For an open pull request from <branch>: a caller that fell behind caller.yml is rewritten, which restarts the
# review; otherwise the coordinator is re-run, since nothing but Codex's comments wakes it.
refresh_or_recheck() {
  local head="$1" number="$2"
  if [ "$(gh api "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml?ref=$head" --jq .content | base64 -d)" != "$(cat "$here/../caller.yml")" ]; then
    put_caller "$head" "Update AI review: refresh the caller"
    say "PR #$number refreshed with the current caller; its review restarts"
    exit 0
  fi
  exec bash "$here/recheck.sh" "$REPO" "$number"
}

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

ensure_ruleset() {
  # A plain assignment, so that set -e stops the script when the lookup fails instead of skipping the ruleset.
  rulesets="$(gh api "repos/$OWNER/$REPO/rulesets" --jq '[.[] | select(.name == "ai-review required")] | length')"
  if [ "$rulesets" = 0 ]; then
    gh api -X POST "repos/$OWNER/$REPO/rulesets" --input "$here/ruleset.json" >/dev/null
    say "ruleset added: merging into $branch needs ai-review success"
  else
    say "ruleset already there"
  fi
}

if live="$(gh api "repos/$OWNER/$REPO/contents/.github/workflows/ai-review.yml?ref=$branch" --jq .content 2>/dev/null)"; then
  ensure_ruleset
  if [ "$(printf '%s' "$live" | base64 -d)" = "$(cat "$here/../caller.yml")" ]; then say "caller up to date on $branch"; exit 0; fi
  open_pr="$(gh pr list -R "$OWNER/$REPO" --head ci/ai-review-update --state open --json number --jq '.[0].number // ""')"
  if [ -n "$open_pr" ]; then refresh_or_recheck ci/ai-review-update "$open_pr"; fi
  caller_pr ci/ai-review-update "Update AI review: Claude reviews every pull request" \
    'Updates `.github/workflows/ai-review.yml` to the current [poweruserz/ai-review](https://github.com/poweruserz/ai-review) caller: Claude (Opus 5.5, max effort, through the owner'"'"'s subscription) replaces GLM next to Codex, and the review is the security gate, so the session merges on `ai-review` success without a separate local gate.'
  exit 0
fi
open_pr="$(gh pr list -R "$OWNER/$REPO" --head ci/ai-review --state open --json number --jq '.[0].number // ""')"
if [ -n "$open_pr" ]; then
  # Not before the pull request: the ruleset names GitHub Actions as the status source, which GitHub may refuse
  # until Actions has run here, and the pull request's own run can be the first. It goes in before the merge, so
  # that pull request too merges only on success, which the coordinator re-run gives it: until the caller merges,
  # Codex finishing wakes nothing here.
  ensure_ruleset
  refresh_or_recheck ci/ai-review "$open_pr"
fi

caller_pr ci/ai-review "Add AI review: Codex and Claude review every pull request" \
  'Adds `.github/workflows/ai-review.yml`, the caller for [poweruserz/ai-review](https://github.com/poweruserz/ai-review): Claude (Opus 5.5, max effort) reviews every pull request head next to Codex, and a coordinator sets commit status `ai-review` (success, failure = findings for the Claude session, error).

The coordinator'"'"'s `issue_comment` trigger runs from the default branch, so until this merges, `scripts/enrol.sh` run again re-runs the coordinator here.'
