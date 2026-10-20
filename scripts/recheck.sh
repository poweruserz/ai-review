#!/usr/bin/env bash
# Re-runs the coordinator on a pull request's head, so it reads Codex, GLM, the threads and any ruling afresh.
# Needed after a ruling, because resolving threads and the owner's comments wake nothing, and on an enrolment
# pull request, whose issue_comment wake-ups start only once the caller is on the default branch.
# The re-run uses review.yml as it was at the run's first attempt (GitHub keeps that SHA for a single job).
# Usage: scripts/recheck.sh <repo> <pr>
set -euo pipefail
R="poweruserz/${1:?usage: recheck.sh <repo> <pr>}"
PR="${2:?usage: recheck.sh <repo> <pr>}"
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "usage: recheck.sh <repo> <pr>" >&2; exit 1; }
IFS=$'\t' read -r head branch < <(gh pr view "$PR" -R "$R" --json headRefOid,headRefName --jq '[.headRefOid, .headRefName] | @tsv')
# Matched on the pull request too: another one with the same head has its own run, whose event names that one.
# GitHub can leave a run's pull_requests empty (reported for a workflow not yet on the default branch, as on an
# enrolment pull request); only then does the head branch decide, because a run keeps the branch name it started
# with while gh reports a renamed one. Compared here, not in jq: a branch name may hold a quote.
run=''; state=''
while IFS=$'\t' read -r id st br prs; do
  if { [ -n "$prs" ] && [[ ",$prs," == *",$PR,"* ]]; } || { [ -z "$prs" ] && [ "$br" = "$branch" ]; }; then run="$id"; state="$st"; break; fi
done < <(gh api "repos/$R/actions/runs?event=pull_request&head_sha=$head&per_page=100" --jq \
  '.workflow_runs[] | select(.path == ".github/workflows/ai-review.yml") | [.id, .status, .head_branch, (.pull_requests | map(.number) | join(","))] | @tsv')
[ -n "$run" ] || { echo "#$PR: no AI review run for ${head:0:7}" >&2; exit 1; }
# A run still going ends with the coordinator anyway, and only a finished run can be re-run.
if [ "$state" != completed ]; then echo "#$PR: reviews still running on ${head:0:7}, the coordinator decides when they end"; exit 0; fi
job="$(gh run view "$run" -R "$R" --json jobs --jq '.jobs[] | select(.name | endswith("Coordinate")) | .databaseId')"
gh run rerun "$run" -R "$R" --job "$job"
echo "#$PR: coordinator re-run on ${head:0:7}"
