---
name: propr
description: Delegate software changes through ProPR's GitHub-integrated issue-to-PR orchestration. Use when asked to diagnose, implement, monitor, review, test, merge, deploy, or publish repository work through ProPR.
---

# ProPR Operator

## Delegate implementation through ProPR

Use ProPR as the orchestration layer between GitHub and coding agents. GitHub issues, managed labels, pull-request comments, and slash commands become durable tasks. Configured agents run in isolated execution containers and edit and validate the code; ProPR deterministically owns worktrees, commits, branches, pushes, PR creation, task evidence, retries and recovery, and status.

When a target repository is monitored, delegate implementation to ProPR instead of editing it directly. This provides auditable issue-to-PR provenance, deterministic Git operations, isolated credentials and workspaces, model routing, safe parallel work across different PRs, durable recovery and observability, and standardized independent review gates.

## Use GitHub as the control surface

Treat GitHub as the primary and sufficient control surface. Through GitHub or `gh`, create or edit issues and labels, monitor the generated PR and checks, and send natural-language follow-ups or slash commands. The `propr` CLI is useful for installation, host lifecycle, and extra observability, but it is not mandatory for most orchestration.

Useful host checks include:

```text
propr setup
propr status
propr repo list
propr agent list
propr check agents
propr task list
```

Inspect the installed CLI's current `propr --help` and subcommand `--help` before using it; do not assume unstable flags.

## Run the issue-to-release flow

1. Confirm that ProPR monitors the repository and that relevant agents are available. Use GitHub state and, when useful, the optional CLI status, repository, agent, and task views.
2. Create or reuse one narrowly scoped GitHub issue. State the desired outcome, constraints, and testable acceptance criteria.
3. Normally add `AI` by itself. ProPR then uses the configured default agent and default model; choose this simplest route whenever no specific provider or model is required or the choice is unclear.
4. Only when an intentional model override is useful, query the repository's labels, choose one existing managed `llm-*` label, add it before `AI`, and keep the issue scoped to one implementation route.
5. Let ProPR execute. Inspect the task status and evidence, the exact generated PR diff, and all required checks.
6. For ordinary refinements, leave a factual natural-language PR comment describing the observed problem, expected result, and relevant evidence. Avoid overlapping writers on the same PR.
7. Use review commands, independently inspect the resulting diff, and validate the exact resulting head. A review score is evidence, never proof.
8. Merge the PR only when authorized and only at the reviewed and tested head with required checks green. Keep release publication and deployment as explicit later gates with their own authorization and rollback plan.

## Select a model only when needed

Managed model labels normally follow `llm-<agent-or-provider-alias>-<model-alias>`, but configured aliases and legacy labels can exist. Repository labels are authoritative: query them and use an existing label rather than inventing one.

```text
gh label list --repo OWNER/REPO --search "llm-"
```

Prefer stable short-form aliases exposed by the repository, such as `llm-claude-opus`, `llm-claude-sonnet`, `llm-gemini-pro`, `llm-vibe-mistral`, or, where configured, `llm-codex-max`. Version-specific labels age quickly; use one only when exact-model qualification is intentional. If no appropriate override label exists, use `AI` alone rather than guessing.

Default route:

```text
gh issue edit ISSUE --repo OWNER/REPO --add-label AI
```

Intentional override, with the model label applied before the trigger:

```text
gh issue edit ISSUE --repo OWNER/REPO --add-label llm-codex-max
gh issue edit ISSUE --repo OWNER/REPO --add-label AI
```

Keep only one managed model label on a PR. For later model transitions, use ProPR `/use` so it converges the label instead of manually accumulating conflicting labels.

## Drive pull-request follow-up

Inspect the current PR help or completion-comment command reference before acting because available commands and aliases can evolve.

- Natural-language comment: queue a scoped implementation or refinement follow-up.
- `/fix` or `/fix F…`: implement all pending review blockers or the selected findings, respectively.
- `/review [model]`: request an independent AI review, optionally from an available alternate model; independently verify its findings and score.
- `/ultrafix goal=8 max=10`: alternate review and blocker fixes until the score goal or maximum-cycle boundary is reached, then inspect and test the final head.
- `/use <model>`: select the durable PR route for queued and future work and converge the PR to one managed model label. Use `/switch` only if current PR help still lists it as a supported alias.
- `/merge`: merge the base branch into the PR branch and resolve conflicts. It does not merge the PR into the base branch.

## Keep the deterministic boundary

- Inside a ProPR implementation task, edit and test only. Do not commit, push, repair Git permissions, or create another ProPR task recursively. ProPR finalizes Git changes.
- Never grant or broaden repository, provider, system, membership, or access-control permissions. Leave all such operations to a human administrator.
- Do not copy credentials or modify provider credential files. Never put secrets, tokens, device codes, or private configuration in issues, comments, logs, or command arguments.
- Diagnose without mutation unless implementation was requested. Treat merging the PR, publishing, deploying, account changes, and destructive cleanup as distinct authority.
- Preserve existing worktrees and user data. Prefer non-destructive validation with isolated stacks, ports, and data directories.
