# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A reusable GitHub Actions workflow, `.github/workflows/review.yml`. Every enrolled poweruserz repository calls it from its own `.github/workflows/ai-review.yml`, which is a copy of `caller.yml`. Each pull request head is reviewed by Codex (an external app, configured outside this repository) and by Claude (run by this workflow). A coordinator then sets the commit status `ai-review`, which the Claude Code session that opened the pull request merges on.

`README.md` is the design document: it gives the reason, and often the measurement, behind each decision, and the meaning of each status. Read the relevant part before changing behavior.

There is no `package.json` and no dependency: workflow YAML, bash, and the Node 24 standard library.

## Commands

```sh
node --test                                   # everything
node --test test/coordinator.test.mjs         # one file
node --test --test-name-pattern="both clean on the head" test/coordinator.test.mjs   # one test
```

- Give the file along with `--test-name-pattern`. Without it, every file that has no matching test is counted as a passing test.
- `test/diff-step.test.mjs` runs the step's bash for real: it needs `bash` on PATH (Git Bash works on Windows) and git 2.40 or newer, for `--attr-source`.
- `.github/workflows/test.yml` runs them on every pull request and on a push to `main`, but no ruleset requires that check, so still run them before every push.

Two scripts act on GitHub for real and have no dry run. Both need `gh` signed in as the owner.

- `CLAUDE_TOKEN_FILE=<file> scripts/enrol.sh <repo>` enrols a repository, or brings its caller up to date: the secret, a runner for a private repository (through `wsl -e ssh dreamfyre`), the caller pull request, and the ruleset `scripts/ruleset.json`. Each step is skipped when it is already done.
- `scripts/recheck.sh <repo> <pr>` re-runs the coordinator job on the pull request's head. Nothing else wakes the coordinator after a ruling.

`node scripts/review-outcomes.mjs [account] [since] [--list]` only reads. It counts what became of Claude's findings in real pull requests (acted on, rejected, dropped, left open), which is what a gate model is judged by next to the 8-bug benchmark; the README holds the last count. With `--list` it names private repositories, so that output stays off public pages.

## Where a change lands

- Callers use `review.yml@main`, so a merge to `main` is live in every enrolled repository at once, with their secrets. Merging is the deploy. Treat `main` as production.
- This repository is enrolled too. A pull request here that edits `review.yml` is reviewed by the `review.yml` on `main`, not by its own version, so the tests are the only check of the new logic before it is live.
- A job that is re-run (`recheck.sh`, `gh run rerun`) uses `review.yml` as it was when that run first started.
- `issue_comment` events run a workflow from the default branch only.
- The repository is public, and so are its run logs. `scripts/nudge-codex.mjs` prints nothing that names a private repository (see `line()`); keep new log output that way.

## Architecture

### All logic is inline in `review.yml`

A job of a reusable workflow checks out the caller's pull request, not this repository, so it cannot load a file from here. That is why the step scripts live in the YAML and why `scripts/search-mcp.mjs` is pasted into a heredoc. Do not move step logic into a file that the job would have to fetch.

### Three jobs, split by what their token can do

| Job | Does | Token |
| --- | --- | --- |
| `claude` | writes the review inputs, runs the model, extracts the verdict | read-only; the only job with `CLAUDE_CODE_OAUTH_TOKEN` |
| `post` | creates or updates the "Claude review" comment | can comment; no model |
| `coordinate` | reads the comments and review threads, sets `ai-review` | can set statuses; no model |

The model reads untrusted code, so the job it runs in can write nothing. The steps of `claude`, by `id`:

1. `diff` (bash) writes `.ai-review.diff`, `.ai-review.skipped.diff` (lockfiles, generated files, clipped files) and `.ai-review.rules` (the `AGENTS.md` files of the base commit, so a pull request cannot rewrite its own rules). A diff past 40,000 bytes continues in `.ai-review.diff.2`, `.3` and so on, each small enough for one Read.
2. `context` writes `.ai-review.context`: the pull request text, the previous Claude review, the owner's rulings, and the diff since that review.
3. `search` writes the embedded MCP server (grep and glob through git, no shell).
4. `claude` runs the review with Read, grep and glob only.
5. `session` and `wrapup` resume the same session with tools off when it ran out of turns or wrapped the verdict in other text.
6. `result` checks the execution record (gate model on every answer, search server connected, no Read outside the workspace, answer shape, every line of the diff returned by a Read), anchors each finding to its quoted line, carries over findings that a resumed answer dropped, and scrubs credentials. Its outputs are `verdict` (`clean`, `findings` or `unavailable`), `text` and `reason`.

### State is comments and statuses

No run hands state to the next one. Each job reads the pull request afresh, and these markers are the protocol. Each is trusted from one author only.

| Marker | Written by | Read by |
| --- | --- | --- |
| `<!-- ai-review:claude sha=… verdict=… -->` | `post`, as `github-actions[bot]` | `coordinate`, `context` |
| `codex-review-state:v1 {json} -->` | Codex, as `chatgpt-codex-connector[bot]`, in its one summary comment | `coordinate`, `nudge-codex.mjs` |
| `<!-- ai-review:ruled sha=<full head SHA> -->` | the repository owner, after rejecting findings | `coordinate`, `context` |
| `<!-- aifix sha=… round=… -->` | the `CODEX_TRIGGER_PAT` account (`codex-fixes` only) | `coordinate` |

`codex-fixes` is off in every repository because Codex cannot push fixes (see the README). Its code and tests stay.

### Fail closed

The Claude review is the security gate. Anything unknown must end as `error` or `failure`, never `success`: no verdict, an answer from another model, a search server that did not start, an answer outside the two permitted shapes, changed files the model did not read, a diff line no Read returned, a Read outside the checkout. The extraction may move or mark a finding, and never drops one. Keep that direction in any change to the `result` and `decide` steps.

## Tests

`stepScript(id, …params)` and `stepRun(id)` cut the `script: |` or `run: |` block of the step with that `id:` out of `review.yml` and run it against fakes, so the tested code is the production code.

- A tested step keeps its `id:` within the 12 lines above its `script: |` or `run: |` line.
- A `github-script` step uses only what its `stepScript` call passes in (`github`, `context`, `core`, `exec`, `require`, depending on the step). A new global, or a `require` that the fake does not serve, fails the test.
- `run()` in `test/coordinator.test.mjs` defaults to `codexFixes: 'true'`. Pass `codexFixes: 'false'` to test the path that production takes.
- `test/workflow-security.test.mjs` quotes source text: the action pins (a commit each; `.github/dependabot.yml` proposes the Claude action's new releases), the job list, the `claude` job's permissions, the tool flags, the whole Read deny list, and the logins the coordinator trusts. Changing one of those lines means changing the test on purpose, in the same commit.

Steps by test file: `decide`, `session`, `result` and `post` in `coordinator.test.mjs`; `context` in `context-step.test.mjs`; `diff` in `diff-step.test.mjs`. The counting rules of `scripts/review-outcomes.mjs` are in `review-outcomes.test.mjs`.

## What changes together

A test keeps these in step:

- `scripts/search-mcp.mjs` and its copy in the `search` step's heredoc, which is indented 10 spaces. Edit the script, then paste it into the heredoc.
- The answer shape check (`shaped`) in the `session` step and in the `result` step.

Nothing but you keeps these in step:

- The finding line format in the prompt, and the code that parses it: `shaped`, `anchor` and the carry-over in `result`, which splits a finding on spaces to find its path, and `scripts/review-outcomes.mjs`, which reads findings back from the posted comment.
- The names of the diff files (`.ai-review.diff`, then `.ai-review.diff.2` and up): the `diff` step that writes them, the prompt that names them, and the read check in `result`.
- The comment layout that `post` builds (marker, heading, commit line, blank line, fenced text), which `context` and `decide` read back by position.
- The noise list (lockfiles, minified, vendored, generated): the `noise=(…)` array in the `diff` step, and `NOISE` in `search-mcp.mjs` and in its embedded copy.
- `caller.yml` and `.github/workflows/ai-review.yml`, which are identical copies. A caller change reaches the other repositories only when `enrol.sh` is run for each.
- The `codex-review-state:v1` parsing in the `decide` step and in `scripts/nudge-codex.mjs`.
- The status descriptions. `nudge-codex.mjs` matches `waiting for Codex` at the start, and sessions act on the wording.
- The gate model: `MODEL` in `review.yml`, `GATE` in `test/coordinator.test.mjs`, and the README.
- A behavior change, its comment in `review.yml`, and its paragraph in `README.md`.
