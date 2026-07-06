---
sidebar_position: 16
---

# Ultrafix And Branch Commands

Use these commands when the PR needs branch help or an automated correction loop.

## `/merge`

Post:

```text
/merge
```

ProPR merges the base branch into the PR branch inside an isolated worktree. An agent run accompanies the merge:

- On a clean merge, the agent verifies the result before it is pushed.
- On conflicts, the agent resolves the conflict markers; ProPR then scans the tree to confirm no conflict markers remain before pushing. If markers remain, the task fails instead of pushing a broken merge.

ProPR posts a status comment on the PR when the merge starts and updates it with the result.

Use `/merge` before final review when the base branch has moved or the PR has conflicts.

## `/ultrafix`

Post:

```text
/ultrafix
```

Or configure the loop:

```text
/ultrafix goal=8 max=10 pause=120 model=llm-claude-opus48
```

`/ultrafix` alternates review and fix cycles until the latest review score reaches the goal or the maximum cycle count is exhausted.

### Parameters

| Parameter | Meaning | Constraints | Default |
|---|---|---|---|
| `goal` | Target review score (`Score: N/10`) | Integer 1–10 | 7 |
| `max` | Maximum fix cycles before giving up | Positive integer | 5 |
| `pause` | Seconds to wait between cycles | Non-negative integer | 60 |
| `model` | Model for the review cycles | Configured model ID (`llm-` prefix optional) | PR review model from Settings |

A bare number is treated as the goal: `/ultrafix 8` is the same as `/ultrafix goal=8`. Defaults can be changed in Settings. Unknown keys and invalid values are ignored with a warning. Lines below the command become extra instructions for the cycles.

### Waiting Rules

Before each cycle, ProPR checks readiness:

- Required CI checks must be passing; if they are not, the continuation is deferred and resumes when check results arrive.
- The PR must be inactive, so the loop does not race human pushes or comments.
- The configured `pause` delay is applied between cycles.

### Stopping The Loop

The loop is controlled by the visible `ultrafix` PR label, which acts as a circuit breaker. Remove the label to stop the loop after the current cycle finishes.

### Completion

- **Goal reached**: the `ultrafix` label is removed. If the PR belongs to a planned issue labeled `auto-merge`, ProPR re-enables GitHub auto-merge on the PR.
- **Max cycles exhausted**: ProPR posts a warning comment with the requested goal and the last score, and manual review takes over.

Reserve `/ultrafix` for stronger cleanup passes. For small edits and direct changes, a normal PR comment is usually better.
