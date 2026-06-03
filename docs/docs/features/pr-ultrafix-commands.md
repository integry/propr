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

ProPR merges the base branch into the PR branch. If conflicts appear, it can attempt to resolve them and report the result back to the PR.

Use this before final review when the base branch has moved or the PR has conflicts.

## `/ultrafix`

Post:

```text
/ultrafix
```

Or configure the loop:

```text
/ultrafix goal=8 max=5 pause=60 model=<model-id>
```

`/ultrafix` alternates review and fix cycles until the review reaches the target score or the maximum cycle count is reached.

## Waiting Rules

Between cycles, ProPR waits for:

- Required checks to pass
- The configured cooldown
- PR inactivity, so it does not race human pushes or comments

## Stopping The Loop

The loop is controlled by the visible `ultrafix` PR label. Removing that label stops the loop after the current cycle finishes.

Use `/ultrafix` for stronger cleanup passes, not for every small edit. For direct changes, a normal PR comment is usually better.
