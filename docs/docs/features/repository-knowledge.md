---
sidebar_position: 9
---

# Repository Knowledge

Repository knowledge helps ProPR plan and run with better context. Not every task needs it, but it becomes important once you use ProPR across larger or less familiar codebases.

The Repositories page in the Web UI is the home for this: each repository entry has a status indicator and reindex control, plus a workspace with four tabs — **Chat**, **Improve**, **Browse**, and **To-Dos**.

<!-- SCREENSHOT PLACEHOLDER: Capture the Repositories page with one indexed repository selected and its workspace open on the Browse tab, showing the tab row (Chat / Improve / Browse / To-Dos), the indexing status indicator, and the reindex button. Index the repository first so the status reads "Indexed". -->

## Indexing And Summaries

ProPR indexes monitored repositories and maintains file and repository summaries. The repository list shows the indexing state per repo ("Not indexed", "Indexing" with progress, "Indexed", or "Failed"), and the **Browse** tab lets you read the generated summaries.

A background indexing worker scans for repositories to index (every 5 minutes by default, `INDEXING_SCAN_INTERVAL_MS`) and refreshes existing indexes periodically (daily by default, `INDEXING_REINDEX_INTERVAL_MS`). You can also trigger reindexing manually with the reindex button on the repository entry, or with `propr repo index` from the CLI.

Summaries are useful when:

- Planning work in a large repo
- Onboarding a new agent or user to a codebase
- Comparing related areas before splitting work
- Checking whether a generated plan is looking at the right part of the repository

Summaries are a map, not the source of truth — they do not replace current file context during implementation.

## Repository Chat

The **Chat** tab lets you ask questions about a repository. Messages run against the indexed repository context with a selectable context level, and the conversation history is persisted per repository (you can delete individual messages or clear the history).

Use chat to check assumptions before planning: where something is implemented, which layer owns a behavior, what a directory is for.

## Context Gathering And Preview

Before generating a plan, Planner Studio gathers and previews context: selected files, attachments, context statistics, and an estimated issue count. You can inspect whether the gathered context looks relevant before the run starts.

Good context preview reduces blind agent runs. If the gathered context looks wrong, reset or refine the draft before implementation. A weak preview is a signal to add more specific instructions, attach better supporting material, or split the request before it runs.

## Improvement Suggestions

The **Improve** tab generates improvement suggestions for a repository. You can:

- Pick suggestion categories (grouped into Health and Growth)
- Add a custom prompt to steer the analysis
- Optionally select a reference repository to compare against
- Select the suggestions worth keeping and convert them into repository todos or a new plan

Suggestions are planning inputs, not automatic changes. A human decides priority, scope, and timing before anything runs.

## Repository Todos

The **To-Dos** tab turns ongoing maintenance ideas into trackable work. Todos are organized into categories, can be reordered by drag-and-drop, searched, edited, completed, and restored after completion.

Use todos to capture:

- Follow-up cleanup discovered during implementation
- Known gaps that are too large for the current PR
- Documentation or test debt
- Areas that should be revisited after a dependency or architecture change

Todos are most effective when they are connected to a repository, a reason, and a next action. A vague todo such as "clean up auth" is much less useful than a scoped item with the files, risk, and expected outcome attached.

## When Knowledge Is Underpowered

Repository knowledge needs attention when:

- Plans repeatedly miss important files
- Agents make changes in the wrong layer
- Reviewers need to explain the same repository context on every PR
- Generated suggestions are too generic
- Tasks fail because setup, test, or build conventions were missing

In those cases, reindex the repository, improve todos, add clearer workflow guidance, or split the work into a smaller planning pass.

## Reindexing And Recovery

If repository knowledge looks stale, use the reindex button on the repository entry (or `propr repo index`). Reindex before high-stakes runs after major refactors, dependency changes, directory moves, or repository renames. For routine follow-up on a small PR, the PR diff and comments may be enough.

Low-level indexing recovery details live in the operations docs; see [Maintenance And Troubleshooting](../operations/maintenance.md).
