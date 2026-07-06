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

{/* VIDEO PLACEHOLDER: Record a 45-second clip: post a natural follow-up comment on a ProPR-created PR, show the task appearing in the Web UI task list, then return to the PR to show the new commit and the completion comment. Show the completion comment's expandable slash-command block as the key moment. */}
