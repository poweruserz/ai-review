#!/usr/bin/env bash
# Re-runs the coordinator on a pull request's head, so it reads Codex, GLM, the threads and any ruling afresh.
# Needed after a ruling, because resolving threads and the owner's comments wake nothing, and on an enrolment
# pull request, whose issue_comment wake-ups start only once the caller is on the default branch.
# Usage: scripts/recheck.sh <repo> <pr>
set -euo pipefail
R="poweruserz/${1:?usage: recheck.sh <repo> <pr>}"
PR="${2:?usage: recheck.sh <repo> <pr>}"
head="$(gh pr view "$PR" -R "$R" --json headRefOid --jq .headRefOid)"
IFS=$'\t' read -r run state < <(gh run list -R "$R" --workflow ai-review.yml --event pull_request --commit "$head" \
  --limit 1 --json databaseId,status --jq '.[0] // {} | [.databaseId, .status] | @tsv')
[ -n "$run" ] || { echo "#$PR: no AI review run for ${head:0:7}" >&2; exit 1; }
# A run still going ends with the coordinator anyway, and only a finished run can be re-run.
if [ "$state" != completed ]; then echo "#$PR: reviews still running on ${head:0:7}, the coordinator decides when they end"; exit 0; fi
job="$(gh run view "$run" -R "$R" --json jobs --jq '.jobs[] | select(.name | endswith("Coordinate")) | .databaseId')"
gh run rerun "$run" -R "$R" --job "$job"
echo "#$PR: coordinator re-run on ${head:0:7}"
