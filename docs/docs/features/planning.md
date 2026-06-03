---
sidebar_position: 3
---

# Planning Before Execution

ProPR is designed to put structure in front of agent runs. Instead of sending a vague issue straight to a coding agent, use Planner Studio to create a draft, gather context, review the plan, refine it, and approve the work when it is ready.

## Why Planning Matters

Planning reduces the two most common failure modes in agent-driven development:

- The agent starts with too little context and solves the wrong problem.
- The agent attempts too much in one branch, making the result hard to review.

Planner Studio gives you a checkpoint before code changes happen. The plan makes the intended work explicit: what should change, what should stay out of scope, which repository and branch are targeted, and how the work should be split.

## Draft Workflow

A typical planning pass looks like this:

1. Create a draft from the Web UI.
2. Select the repository and branch context.
3. Add the user request, attachments, screenshots, or supporting notes.
4. Preview gathered context before generating the plan.
5. Generate structured implementation steps.
6. Edit, refine, or regenerate the plan.
7. Approve individual issues or the full plan to run.

The draft can be paused, resumed, or reset back to setup if the inputs were wrong. That makes planning useful for exploratory work as well as well-defined tickets.

## Context Assembly

Planner Studio can include several kinds of context before generation:

- Repository selection from monitored repos
- Branch-aware planning based on the configured repository entry
- File and repository context previews
- Attachments and supporting material
- Relevance and context statistics before generation

The goal is not to flood the model with every file. The goal is to make the proposed work easy to inspect before it runs, so reviewers can tell whether the agent saw enough relevant context.

## Review Before Running

Plans stay in draft until you approve them. Before running anything, you can:

- Edit scope before implementation starts
- Remove risky or low-value steps
- Split oversized steps into smaller issues
- Add acceptance criteria
- Send the plan back for refinement
- Approve one planned issue at a time

This keeps the agent useful without letting a rough plan turn directly into repository changes.

## Running From A Plan

After approval, ProPR can run the planned work in a controlled way:

- Implement one planned issue
- Implement all approved issues in a plan
- Track each run as a task record
- Link generated pull requests back to the source plan
- Continue work later from the same planning context

For larger work, combine this with [Work Splitting](./work-splitting.md) so the final pull requests stay reviewable.
