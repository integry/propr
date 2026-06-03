---
sidebar_position: 9
---

# Repository Knowledge

Repository knowledge helps ProPR plan and run with better context. Not every task needs it, but it becomes important once you use ProPR across larger or less familiar codebases.

## Repository Summaries

ProPR can maintain summaries and repository-level context to help you and the agents understand what a repository contains. Summaries are useful when:

- Planning work in a large repo
- Onboarding a new agent or user to a codebase
- Comparing related areas before splitting work
- Checking whether a generated plan is looking at the right part of the repository

Good summaries should stay grounded in repository facts:

- Major application areas
- Important entry points
- Test and build commands
- Known architectural boundaries
- Areas that are risky to edit casually

Summaries should not become a substitute for current file context. They are a map, not the source of truth.

## Context Gathering And Preview

Before generating a plan, Planner Studio can gather and preview context. You can inspect whether the selected files, notes, attachments, or repository signals look relevant before the run starts.

Good context preview reduces blind agent runs. If the gathered context looks wrong, reset or refine the draft before implementation.

Preview is especially important before larger plans. A weak preview is a signal to add more specific instructions, attach better supporting material, or split the request before it runs.

## Improvement Suggestions

Repository knowledge can also support improvement suggestions: areas where code, tests, documentation, or architecture may need cleanup. These suggestions should be treated as planning inputs rather than automatic changes.

Useful suggestions usually include:

- A concrete target area
- Why the change matters
- What evidence points to the issue
- A suggested reviewable scope

Suggestions should not automatically become implementation work. They should feed into planning, where a human can decide priority, scope, and timing.

## Repository Todos

Repository todos help turn ongoing maintenance ideas into trackable work. They are most useful when connected to planning and reviewable pull requests, rather than kept as unstructured notes.

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

In those cases, refresh repository summaries, improve todos, add clearer workflow guidance, or split the work into a smaller planning pass.

## Reindexing And Recovery

If repository knowledge looks stale, use the repository workspace in the Web UI to reindex or refresh the relevant repository. Low-level indexing recovery details live in operations docs, but the rule is simple: refresh stale context before planning or running work that depends on it.

Reindex before high-stakes runs after major refactors, dependency changes, directory moves, or repository renames. For routine follow-up on a small PR, the PR diff and comments may be enough.
