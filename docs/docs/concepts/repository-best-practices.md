# Repository Best Practices

ProPR opens pull requests; it does not run your test suite or linters before committing. Its execution flow has no validation phase — agent output is committed and pushed, and **your CI is the layer that catches regressions**. A repository set up with strong CI and good hygiene gets safer, more autonomous results from ProPR; one without it relies entirely on human review to catch problems.

These practices are about preparing a repository so ProPR's automation works *with* you. None of them are enforced by ProPR — they are the conditions under which it performs best.

## Make CI The Quality Gate

Run lint, type checks, tests, and the build on every pull request through GitHub Actions (or your CI of choice). Because ProPR commits agent changes without validating them itself, CI is what verifies an agent-generated PR actually works.

Two ProPR features consume CI results directly, so CI is not just a reviewer aid — it changes how automation behaves:

- **Auto-merge** (`--auto-merge`, or the `auto-merge` label) enables GitHub's native auto-merge, which holds the merge until all **required** status checks and approvals pass. This is only as safe as your branch protection: if no checks are marked *required*, auto-merge can merge as soon as the PR is mergeable. Define required status checks in branch protection so auto-merge waits for them. See [`--auto-merge`](../features/propr-cli.md) and [Planner Studio](../tutorials/planner-studio.md).
- **`/ultrafix`** defers its next review/fix cycle until checks are passing and resumes when a `check_run` completes. Fast, reliable CI means tighter cleanup loops; slow or flaky CI stalls them. Note that a commit with *no* check runs is treated as ready, so `/ultrafix` only benefits from CI when checks actually exist. See [UltraFix commands](../features/pr-ultrafix-commands.md).

Practical implications: keep CI **fast** (loops and merges wait on it) and **deterministic** — flaky tests stall `/ultrafix`, block auto-merge, and can send fix loops chasing failures that aren't real.

## Keep A Human Gate Where You Want One

Auto-merge removes the human from the loop once checks pass, which is appropriate for low-risk paths but not for everything. To keep a person in the loop on sensitive areas, add a `CODEOWNERS` file and require code-owner approval in branch protection. Required reviews are enforced by GitHub the same way required checks are, so auto-merge waits for them too — letting you mix hands-off merging for routine changes with mandatory human sign-off on the parts that matter.

## Harden Your CI

Agent-generated PRs run through the same pipelines as any other, so the usual supply-chain hygiene applies — and matters more when PRs are opened automatically:

- Grant the workflow `GITHUB_TOKEN` the least privilege it needs (`permissions:` scoped per workflow/job; default to `contents: read`).
- Pin third-party actions to a full commit SHA rather than a moving tag.
- Be deliberate about `pull_request_target` and workflows that expose secrets to PR-triggered runs.
- Keep secrets out of logs and out of the agent's reach; never echo them in CI output.

## Keep Changes Reviewable

Lint rules that cap file length, function size, and cyclomatic complexity keep diffs small and focused. This helps two audiences at once: human reviewers, and the agent — smaller, well-scoped files give it tighter context to reason over and reduce the chance it edits the wrong layer.

ProPR does not measure or enforce complexity, and it indexes large files like any other. But repository knowledge degrades when structure is unclear: plans miss important files, agents change the wrong layer, and suggestions get generic (see [Repository Knowledge](../features/repository-knowledge.md)). Clear module boundaries and small files improve both planning and review.

:::tip[Scope work small]
Acceptance rate drops when tasks are too broad. Prefer smaller issues that produce focused PRs — see [Work Splitting](../features/work-splitting.md) and [Planning](../features/planning.md). Low PR acceptance usually points to scope, not the agent ([System Metrics](../operations/system-metrics.md)).
:::

## Match The Agent Environment To CI

Agents run in isolated execution containers. Use `.propr/setup.sh` (scaffolded by `propr init`) to install the dependencies and task-specific tooling the agent needs, so it can build and run the project the same way CI does. Keeping the agent environment and CI aligned means changes that look right in the run also pass the pipeline, and it lets `/fix` repair environment problems in scope. See [ProPR CLI](../features/propr-cli.md).

## Document Conventions

ProPR's planning and review draw on repository knowledge. A clear `README`, a `CONTRIBUTING` guide, and documented build/test conventions help it produce accurate plans and on-target changes instead of generic ones. If you keep agent-specific guidance, put it where the agent will use it rather than relying on it to infer conventions. See [Repository Knowledge](../features/repository-knowledge.md).

## Checklist

- Required status checks (lint, type check, tests, build) configured in branch protection
- CI is fast and free of flaky tests
- `CODEOWNERS` + required reviews where human sign-off should gate merges
- Workflow `GITHUB_TOKEN` scoped to least privilege; third-party actions pinned to SHAs; secrets kept out of logs
- Lint rules cap file size and complexity to keep diffs reviewable
- `.propr/setup.sh` installs the same dependencies CI uses
- Issues are scoped small enough to produce focused PRs
- Conventions documented in `README`/`CONTRIBUTING`

For how ProPR reviews PRs and what "good" looks like, see [PR Review Guidelines](./pr-review-guidelines.md) and [Execution Safety](../features/execution-safety.md).
