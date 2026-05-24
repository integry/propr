---
sidebar_position: 4
---

# Planner Studio

This tutorial shows how to use Planner Studio to draft a plan in the Web UI, turn it into actionable issues, and execute the work through ProPR.

Planner Studio is already a UI-first workflow, but it works best when repository and agent defaults are also managed in the rest of the Web UI instead of being left as hidden deployment-only settings.

## Before You Start

Make sure:

- The Web UI is running and connected to the ProPR backend
- The target repository has already been added to the monitored repository list
- The agents and default models you want to use are already configured in the Web UI
- The repository entry has the correct `baseBranch` if you do not want to use the repository default branch

Important:

- Planner Studio does not let you type any branch name you want
- It resolves the branch from the monitored repository entry you selected

For the exact branch rules, see [Repository-Specific Default Branch Configuration](../features/branch-config.md).

## 1. Open Planner Studio And Create A Draft

In the Web UI, open Planner Studio and start a new draft.

If the repository or agent setup looks wrong, leave Planner Studio and fix it in Repositories, AI Agents, or Settings before you draft the plan.

Provide:

1. The repository you want to work in
2. A prompt describing the feature, bug fix, or workflow you want planned

Actionable advice:

- Ask for outcomes, not just implementation details
- Include constraints such as testing expectations, rollout limits, or files to avoid
- Use a short draft name if your team creates many plans

## 2. Add Supporting Context

Before generating the plan, attach the extra context the planner needs.

Useful context includes:

- Screenshots or mockups
- Product notes or specifications
- Reproduction steps
- Files or snippets that explain edge cases
- Related repositories if the change spans multiple codebases

Actionable advice:

- Attach only the material that changes the plan
- If the issue is repo-specific, prefer repository context over long free-form prompt text

## 3. Configure Planning Options

Adjust the plan settings before generation.

Common options:

1. Confirm the base branch resolved from the selected repository entry
2. Choose the task granularity that fits the work
3. Set context level based on how much repository context you want included
4. Enable compression if the prompt and file context are large
5. Select a generation model if your environment exposes that option

Actionable advice:

- Use `single` granularity for a tightly scoped task
- Use `balanced` for most product work
- Use `granular` when you expect several implementation issues or staged rollout

## 4. Preview The Context And Generate The Plan

Use the context preview to inspect what Planner Studio is about to send into planning, then generate the plan.

Look for:

- Estimated token usage and cost
- Automatically selected files
- Warnings about context size or missing inputs
- Repository or branch mismatches

If the preview looks wrong, fix the draft before generating.

## 5. Review The Generated Plan

After generation, Planner Studio moves the draft into review-oriented work.

Read through the proposed tasks and check:

1. The scope matches the original request
2. Tasks are ordered sensibly
3. Each task is independently understandable
4. Important risks, migrations, or testing steps are represented

Actionable advice:

- Merge or rewrite tasks that are too small to justify separate PRs
- Split tasks that would be hard to review or validate together

## 6. Refine The Plan

If the first plan is not right, refine it instead of starting over immediately.

Useful refinement instructions:

- "Split backend and frontend work into separate issues"
- "Add a migration task and rollback notes"
- "Reduce this to one issue with a smaller scope"
- "Add explicit test coverage expectations to each task"

Use refinement when the overall direction is correct but the structure or detail level needs adjustment.

## 7. Finalize The Plan Into Issues

When the plan looks correct, finalize it.

Finalizing creates the implementation issues that ProPR will later execute.

Before finalizing, confirm:

1. Titles are clear enough to become issue titles
2. Bodies contain enough detail for an agent and human reviewer
3. The number of issues matches how many PRs you want to manage

## 8. Choose How Execution Should Run

After finalization, decide how to execute the draft.

Planner Studio supports:

1. Implementing a single issue
2. Implementing all pending issues
3. Using an Epic PR workflow
4. Auto-merging individual issue PRs into the Epic PR
5. Starting Ultrafix automatically after PR creation

Actionable advice:

- Implement one issue first when trying a new repository or new agent setup
- Use implement-all when the plan is already stable and the issues are cleanly separated

## 9. Start Execution

Trigger execution from the draft's issue list.

What happens when you implement an issue:

1. Planner Studio triggers the issue by adding your configured primary processing label, such as `AI` or `propr`
2. The normal ProPR worker pipeline takes over
3. A branch, implementation run, and PR are created automatically

Issue statuses then move through stages such as:

- `pending`
- `processing`
- `under_review`
- `merged`
- `closed`

## 10. Monitor, Pause, Resume, Or Revise

Use the draft controls while work is active.

Available controls:

1. Pause the draft to stop the next pending issue from being triggered automatically
2. Resume the draft when you want execution to continue
3. Revise the draft to return to review and detach existing issue tracking while preserving the plan history
4. Reset to setup when the configuration itself needs to be rebuilt from the draft stage

Actionable advice:

- Use pause when a current issue can finish but you do not want the next one to start
- Use revise when the plan needs structural changes after partial execution
- Use reset to setup when branch, context, or planning inputs were wrong from the beginning

## 11. Review The Resulting PRs

Each implemented issue follows the same downstream PR workflow as a normal labeled issue.

For each PR:

1. Review the changes and checks
2. Use `/review` and `/fix` if you want AI-assisted refinement
3. Merge when the PR is ready

If you enabled Epic PR or auto-merge behavior, monitor that aggregate workflow in addition to the individual issue PRs.

## Practical Checklist

Use this checklist when running a draft end to end:

1. Select the correct monitored repository entry
2. Write a precise prompt and attach only useful supporting context
3. Preview context and fix branch or scope issues early
4. Review and refine the generated task list
5. Finalize only when the issue breakdown is strong
6. Start with one issue or run all, depending on confidence
7. Pause, resume, or revise as execution progresses
8. Review and merge the resulting PRs
