---
sidebar_position: 3
---

# PR Slash Commands

ProPR supports three slash commands that you can use in pull request comments to trigger automated actions: `/review`, `/fix`, and `/merge`. Each command serves a distinct purpose in the PR workflow.

## `/review` — Request an AI Code Review

Posts one AI review comment per requested model. Reviews are read-only — they do **not** apply any code changes.

### Usage

```
/review
```

Request a review using the default model.

```
/review claude-opus claude-sonnet
```

Request reviews from specific models. Each model posts its own review comment.

```
/review
Please focus on security and error handling
```

Add multiline instructions after the command to guide the review focus.

### Behavior

1. ProPR dispatches one review job per requested model.
2. Each model analyzes the PR diff and posts a separate review comment.
3. Review comments are tagged with a hidden marker (`<!-- propr:ai-review model="..." -->`) so the system can identify them later.
4. No code is changed — reviews are informational only.

## `/fix` — Apply AI Review Suggestions

Gathers all **unprocessed** AI review comments on the PR and applies the suggested changes in a single pass.

### Usage

```
/fix
```

Apply all unprocessed AI review suggestions.

```
/fix only address the critical findings
```

Add instructions to narrow the scope of changes.

### Behavior

1. ProPR collects all AI review comments that have not yet been processed by a prior `/fix` run.
2. The gathered review feedback is sent to the AI along with any extra instructions you provided.
3. The AI implements the requested fixes and the system commits the changes to the PR branch.
4. Processed review comments are marked so they are not picked up by subsequent `/fix` runs.

### Editing Reviews Before `/fix`

You can **edit or delete** AI review comments before running `/fix` to control which suggestions are applied. For example:

- Delete a review comment you disagree with — `/fix` will skip it.
- Edit a review comment to refine the suggestion — `/fix` will use the updated text.

This gives you full control over what the AI implements.

## `/merge` — Merge Base Branch into PR

Merges the target base branch into the current PR branch to resolve conflicts or bring it up to date.

### Usage

```
/merge
```

### Behavior

1. ProPR detects the PR's base branch and merges it into the feature branch.
2. If merge conflicts are found, the AI attempts to resolve them automatically.
3. A status comment is posted with the result.

## Typical Workflow

A common workflow combining all three commands:

1. **Create a PR** (manually or via ProPR issue automation).
2. **`/review`** — Request AI reviews from one or more models.
3. **Read the reviews** — Edit or delete review comments you disagree with.
4. **`/fix`** — Apply the remaining suggestions automatically.
5. **Iterate** — Run `/review` and `/fix` again if needed.
6. **`/merge`** — Bring the branch up to date before final merge.

## Notes

- `/review` and `/fix` are independent commands. You can run `/fix` without a prior `/review` if you post your own instructions.
- Multiple `/review` calls accumulate review comments; `/fix` processes all unprocessed ones at once.
- Each command must be the first line of the PR comment. Any text after the first line is treated as extra instructions.
