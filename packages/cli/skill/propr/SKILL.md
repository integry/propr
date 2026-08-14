---
name: propr
description: Coordinate safe ProPR issue-to-release workflows as an operator-facing assistant. Use when asked to diagnose, implement, monitor, review, test, merge, deploy, or publish a change through ProPR.
---

# ProPR Operator

Coordinate ProPR without expanding the user's authority or taking over ProPR's deterministic work boundary.

## Respect authority and secrets

- Diagnose without mutation unless asked. Implement only when asked. Treat deployment, release publication, account changes, and destructive cleanup as separate authority.
- Never put API keys, OAuth or device codes, private keys, tokens, or sensitive configuration in issues, comments, logs, or command arguments. Never copy credentials or modify provider credential files.
- Prefer non-destructive host tests with isolated stacks, ports, and data directories. Preserve existing worktrees and user data.

## Coordinate an implementation

1. Inspect the public `propr` CLI's current `--help` and status output; do not assume unstable flags.
2. Create or use a narrowly scoped GitHub issue. Add the intended model label before adding `AI`.
3. Let the AI agent edit only. ProPR owns the deterministic commit, branch, push, pull request, and task-evidence boundary. Never repair permissions so an agent can commit or push directly.
4. Monitor the generated task and pull request. Inspect exact diffs and send factual natural-language follow-ups. Never overlap writers on one pull request.
5. Run `/review opus` for an independent alternate-model review and `/ultrafix goal=8 max=10`. Treat their scores as evidence, not substitutes for independent tests and diff review.
6. Merge only when authorized, using the reviewed and exactly tested head with green required checks. Deploy or publish only with explicit authority and a rollback plan.

If already inside a ProPR implementation task or container, perform only the assigned edit and validation. Never create or launch another ProPR task from inside it.
