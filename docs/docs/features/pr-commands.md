---
sidebar_position: 3
---

# PR Slash Commands

ProPR supports six slash commands that you can use in pull request comments to trigger automated actions: `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix`. Each command serves a distinct purpose in the PR workflow.

These commands are model-aware across ProPR's configured agents. If your environment has Claude, Codex, and Gemini agents enabled, you can target any supported model for review or follow-up work by using that model's ID or `llm-...` label.

## Model Naming

Canonical naming in this guide:

- Command arguments use the exact model IDs configured in your ProPR UI or agent settings, written below as placeholders like `<model-id>`
- GitHub labels use their `llm-...` form such as `llm-<model-id>`

If you are not sure which IDs are valid in your environment, check the configured agents in the Web UI. Legacy aliases may still resolve for backward compatibility, but the docs use the configured model ID form for durability.

## `/review` — Request an AI Code Review

Posts one AI review comment per requested model. Reviews are read-only — they do **not** apply any code changes.

### Usage

```
/review
```

Request a review using the default review model.

```text
/review <model-id-a> <model-id-b> <model-id-c>
```

Request reviews from specific models, even across different configured agent providers. Each model posts its own review comment.

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

Applies all **unprocessed** AI review comments on the PR in a single pass. If there are no unprocessed AI review comments, `/fix` can still run as a standalone follow-up task using the instructions in your PR comment.

### Usage

```
/fix
```

Apply all unprocessed AI review suggestions.

```
/fix
Only address the critical findings
```

Add instructions to narrow the scope of changes.

```text
/fix
Please update the tests and improve the retry handling
```

Run a standalone `/fix` pass from your own instructions when you do not need a preceding `/review`.

### Behavior

1. ProPR collects all AI review comments that have not yet been processed by a prior `/fix` run.
2. If review comments exist, the gathered review feedback is sent to the AI along with any extra instructions you provided.
3. If no unprocessed AI review comments exist, `/fix` uses only the instructions from your PR comment as a standalone follow-up task.
4. The AI implements the requested fixes and the system commits the changes to the PR branch.
5. Processed review comments are marked so they are not picked up by subsequent `/fix` runs.

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

## `/switch` — Permanently Change the PR Model

Updates the PR's model label so that all subsequent AI commands use the specified model.

### Usage

```text
/switch <model-id>
```

Switch the PR to use that model for all future commands.

```text
/switch <model-id>
Please re-review after switching
```

Switch models and include follow-up instructions. If instructions are provided, a review job is automatically queued with the new model after the label update.

### Behavior

1. ProPR removes existing model labels (for example `llm-claude-sonnet46` or `llm-gemini-pro`) from the PR.
2. A new model label is added for the requested model.
3. If trailing instructions are provided, a follow-up review job is dispatched with the new model.
4. Only one model argument is accepted; extra arguments are ignored with a warning.

## `/use` — One-Time Model Override

Runs one follow-up task immediately with a temporary model override, without changing the PR's labels. `/use` is self-contained: the same PR comment both selects the model and starts the run.

### Usage

```text
/use <model-id>
Please investigate the flaky test failure and update the PR if needed
```

Run one follow-up pass with a temporary model override. Put any instructions for that run below the first line in the same comment.

```text
/use <model-id>
Focus on performance optimizations
```

If you want a read-only analysis instead of a change-producing follow-up run, use `/review <model-id>` instead.

### Behavior

1. Posting `/use` immediately queues one follow-up run with the specified model.
2. Any text after the first line is passed to that run as instructions. `/use` does not store temporary state for a later comment.
3. The PR's model labels are not changed.
4. Only one model argument is accepted; extra arguments are ignored with a warning.
5. After that run completes, later commands revert to the PR's configured model unless you use `/switch` or another `/use`.

## `/ultrafix` — Automated Review→Fix Loop

Runs an automated loop of `/review` followed by `/fix` cycles until the review score reaches a target goal or a maximum number of cycles is exhausted.

### Usage

```
/ultrafix
```

Run with system defaults (goal=7, max=5, pause=60 unless changed by an admin in settings).

```
/ultrafix 8
```

Set the target score goal to 8 (positional argument).

```text
/ultrafix goal=8 max=10 pause=60 model=<model-id>
```

Use named arguments for full control:
- **goal** — Target review score to reach, 1-10 (system default: 7)
- **max** — Maximum review→fix iterations before giving up. One cycle means one `/review` and the matching `/fix` pass. `max=5` allows up to 5 reviews and 5 fixes. (system default: 5)
- **pause** — Seconds to wait between cycles (system default: 60)
- **model** — Override the review model for all cycles

```
/ultrafix
Focus only on security issues
```

Add multiline instructions after the command to guide both review and fix passes.

### Behavior

1. If unprocessed AI review comments already exist on the PR, the loop starts with `/fix`. Otherwise it starts with `/review`.
2. After each `/fix` pass, ProPR waits for:
   - All CI/CD checks to turn green.
   - The PR to be inactive (no new pushes or comments) for the configured pause duration.
3. The loop continues — alternating `/review` and `/fix` — until the review score reaches the **goal** or the **max** review→fix iteration count is hit.
4. A summary comment is posted at the end with the final status.

### Waiting Rules

Between each cycle iteration, `/ultrafix` enforces:
- **Green checks** — waits for all required status checks and CI jobs to pass before proceeding to the next step.
- **Cooldown** — if `pause` is set, waits the specified number of seconds after checks pass.
- **PR inactivity** — ensures no new commits or comments have appeared on the PR during the wait period to avoid conflicts.

### Circuit Breaker — The `ultrafix` Label

The `/ultrafix` loop is controlled by a PR label named `ultrafix`:

- **Starting**: When `/ultrafix` is invoked, the `ultrafix` label is automatically added to the PR. The loop runs as long as this label is present.
- **Stopping**: Removing the `ultrafix` label from the PR at any time will stop the loop after the current cycle completes. This is the manual circuit breaker.
- **Restarting**: Re-adding the `ultrafix` label (or posting another `/ultrafix` comment) restarts the loop.

This mechanism gives humans a simple, visible way to halt an automated loop without needing to post a comment.

## Typical Workflow

A common workflow combining these commands:

1. **Create a PR** (manually or via ProPR issue automation).
2. **`/review`** — Request AI reviews from one or more models.
3. **Read the reviews** — Edit or delete review comments you disagree with.
4. **`/fix`** — Apply the remaining suggestions automatically.
5. **Iterate** — Run `/review` and `/fix` again if needed.
6. **`/switch`** or **`/use`** — Change models if needed (permanently or for one run).
7. **`/merge`** — Bring the branch up to date before final merge.

## Notes

- `/review` and `/fix` are independent commands. You can run `/fix` without a prior `/review` if you post your own instructions.
- Multiple `/review` calls accumulate review comments; `/fix` processes all unprocessed ones at once.
- `/switch` and `/use` each accept exactly one model argument. The `llm-` prefix is optional when you reference a supported model label or model ID.
- `/switch` changes the PR labels permanently; `/use` triggers one immediate follow-up run with a temporary override and then reverts to the PR model.
- Each command must be the first line of the PR comment. Any text after the first line is treated as extra instructions.
