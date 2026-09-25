---
sidebar_position: 6
title: PR Follow-up
---

# PR Follow-up

ProPR turns implementation work into pull requests automatically, then keeps follow-up work in the pull request. You review the result, leave normal GitHub comments, request AI review, apply the suggestions you keep, switch models, and ask for branch help without leaving the PR. This page describes how that loop works; command syntax and rules live in [PR Comment Commands](./pr-commands.md).

## Automatic Pull Request Creation

When ProPR finishes an implementation task, it handles the GitHub plumbing around it:

- Creates the feature branch (named with the issue number and model identifier)
- Commits the agent's changes
- Pushes to GitHub
- Opens a pull request linked to the source issue
- Posts status back to GitHub
- Attaches focused [visual previews](./visual-previews.md) when the repository enables them and the change has a visible result
- Updates task and label state (`<trigger>-processing` → `<trigger>-done`, or `<trigger>-failed-*` on failure)

This keeps the agent focused on code while ProPR handles the repeatable workflow around the code.

## Use ProPR On Any Pull Request

You can skip ProPR-driven PR creation entirely and still use its review and fix tools. The pull request is an entry point on its own, so you can apply ProPR to PRs opened by a teammate, another agent, or yourself outside ProPR:

- **Review or fix only**: comment `/review` on any eligible PR to get AI review feedback, then `/fix` to apply the suggestions you keep.
- **Take over an existing PR**: add a configured processing label (for example `AI` or `propr`) to the open PR. From then on, normal follow-up comments are picked up just like on a ProPR-created PR, and ProPR continues the work in place.

Once ProPR is engaged, follow-up comments and slash commands behave the same way on a handed-over PR as on a ProPR-created one. Other details can still differ — a handed-over PR keeps its original branch name, may link no source issue, and carries no prior ProPR task history — but the command and follow-up behavior is identical.

## Natural Follow-Up Comments

For ordinary refinement, plain comments are all you need. Post a normal PR comment that describes the requested change:

```text
Please update the empty state copy and add a regression test for the loading spinner.
```

ProPR picks up the comment, includes PR context and the comment content, and queues the requested change for processing. What that pickup gives you:

- Comments posted while a job for the same PR is already running are batched and handled together once the active job finishes.
- Line-level review comments carry their file path, line, and diff hunk to the agent, so "fix this" on a specific line has real context.
- Images attached to comments are available to the agent — paste a screenshot of the bug and the agent sees it.

Comment pickup is gated by processing labels, trigger keywords, and author permissions; see [Who Can Trigger Commands](./pr-commands.md#who-can-trigger-commands) for the rules.

## The Review And Fix Loop

When you want a quality pass on top of your own reading, the loop goes: ask, prune, apply.

1. `/review` posts AI review feedback with severity findings and a score — the code is untouched.
2. You edit the feedback: delete suggestions you disagree with, sharpen vague ones, keep what matters.
3. `/fix` applies the `/review`'s pending suggestions in one implementation pass.

The split by feedback source keeps intent clear: plain user comments start follow-up work directly the moment you post them, and `/fix` handles the AI review suggestions from `/review`.

For more autonomous cleanup, `/ultrafix` alternates review and fix cycles until the review score reaches its goal, waiting for CI and PR inactivity between cycles; a visible PR label acts as its circuit breaker. When the base branch has moved, `/merge` brings the base branch into the PR branch and resolves conflicts with agent help — you merge the PR itself when you are satisfied.

Full syntax, parameters, and trigger rules for every command are in [PR Comment Commands](./pr-commands.md).

## Cancelling Obsolete Checks During Follow-Up

While a follow-up implements, the checks running on the commit it is about to replace are already obsolete, and on a busy repository they keep runners occupied for work nobody will read. GitHub's own `cancel-in-progress` concurrency only helps once a replacement workflow starts, which is after the new commit is pushed.

The repository setting **Cancel CI while follow-up implementation is in progress** (Repositories → repository → Automation, off by default) closes that window:

- Cancellation happens only once a follow-up is authorized and actually implementing, including `/fix`. Comments, pending requests, reviews and rejected requests never cancel anything.
- **You choose the workflows; ProPR never guesses.** Next to the option, **Validation workflows to cancel** holds the exact workflows it may cancel for this repository. Nothing else is ever cancelled — not a workflow with a similar name, not a new workflow somebody adds later. This is deliberate: a workflow called `Build` or `CI` is free to deploy, and only you know whether cancelling it is safe. While the list is empty this repository selects nothing of its own, and the instance-wide `CANCEL_CI_FOLLOWUP_WORKFLOWS` fallback below decides instead; with neither, nothing is cancelled. The settings screen says so in its empty state rather than promising that nothing is cancelled.
- Select each workflow by any of its complete identities: its file name (`pr-build-check.yml`), its path (`.github/workflows/pr-build-check.yml`), the name shown on the pull request (`Build & Lint Check`), or its numeric workflow ID. Matching is case-insensitive and exact — never a substring, so `pr-build-check.yml` does not select `pr-build-check-matrix.yml`. Separate entries with commas.
- Of a selected workflow, only queued or running GitHub Actions runs that GitHub itself associates with that exact pull request and that exact head commit are cancelled. Manual, scheduled, branch, tag and other pull requests' runs, other revisions and non-Actions checks are never touched, and a branch name alone never qualifies a run. A selected workflow is eligible on both `pull_request` and `pull_request_target`, because selecting it is the decision that it is safe to cancel.
- **Instances configured outside the Web UI** can set `CANCEL_CI_FOLLOWUP_WORKFLOWS` to the same kind of comma-separated list. It is a fallback, not an addition: it applies only to repositories whose own selection is empty, and a repository selection always wins over it. A selection ProPR cannot read at all is not an empty one: nothing is cancelled for that repository until the configuration is readable again, because its stored selection may name workflows the fallback does not.
- When implementation pushes a replacement commit, its checks run normally. When it produces no commit, fails or is cancelled, ProPR restarts the cancelled runs for the still-current commit — after re-reading the live pull request head, including after every wait for a cancellation to finish, and without duplicating a run GitHub already restarted. Only a run of the same workflow that validates that same pull request head on a pull request event counts as that replacement: a push or another pull request's run of the same commit validates something else and never settles the obligation. Cancellations stay visibly cancelled in the meantime; ProPR never reports a check as successful and never relaxes required checks.
- The obligation is stored durably before each cancel request is sent, so a crash or a lost response can never leave CI cancelled without a restart obligation; reconciliation reads each run's real outcome and restarts only what GitHub really cancelled. The attempt that outcome is read for is the one ProPR's request affected, established from the run's own attempts rather than from whatever attempt the run shows later: if somebody reruns a cancelled attempt before ProPR does, that rerun already restored the validation, and ProPR never restarts the newer attempt on their behalf, however it ends. A denied retry never discards an obligation an earlier attempt already took on, and a restart that GitHub refuses or that keeps failing keeps its runs recorded in a blocked state that every later reconciliation retries, however long that takes — cancelled checks are released only once their restart is confirmed, the pull request closes or its head is replaced. It also picks up runs that GitHub queued after the cancellation, and releases the suspension if you switch the option off mid-task.
- Every step for one pull request — starting, sweeping, restoring and releasing — runs while holding a shared database lease, so two workers can never act on the same pull request at once and no run is ever cancelled after a restart has begun. A pull request another worker is already handling is left alone and picked up by the next reconciliation.

Prerequisite: the GitHub App installation needs **Actions: Read and write**. With read-only Actions access the option is inert — the attempt is logged as a permission error and implementation continues with CI untouched. If access is lost after checks were already cancelled, the obligation to restart them survives and is honoured as soon as the access is granted back. Fork contributions that ProPR publishes to a continuation pull request are handled through that continuation; runs GitHub does not associate with a pull request are left alone.

{/* VIDEO PLACEHOLDER: Record a 45-second clip: post a natural follow-up comment on a ProPR-created PR, show the task appearing in the Web UI task list, then return to the PR to show the new commit and the completion comment. Show the completion comment's expandable slash-command block as the key moment. */}
