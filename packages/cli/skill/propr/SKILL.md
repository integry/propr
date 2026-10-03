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
propr task inspect
propr goal list --state active
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

## Run long-running goals from the CLI

A goal keeps one agent session working toward a continuing objective until it delivers a validated draft PR. Use it when the objective is broader than one issue; otherwise prefer the issue flow above. The `propr goal` commands use the normal CLI login and need no MCP connection:

```text
propr goal capabilities
propr goal create -p OWNER/REPO -a AGENT -m MODEL --file objective.md --idempotency-key KEY --json
propr goal inspect GOAL_ID --json
propr goal input GOAL_ID --file correction.md
propr goal inputs GOAL_ID
propr goal pause GOAL_ID
propr goal resume GOAL_ID
propr goal model GOAL_ID MODEL
propr goal cancel GOAL_ID
```

- `goal create` starts autonomous work immediately; only run it when starting work is authorized. Keep the returned goal ID.
- Supply your own `--idempotency-key` for every mutation and reuse it when retrying the same request. On `outcome_uncertain`, re-run with the same key rather than creating another goal; `idempotency_conflict` means the key was used for a different request.
- Inputs, pause, resume, cancel and model changes are accepted requests, not confirmations. Compare `lifecycle.requestedState` with `lifecycle.observedState` and `model.requested` with `model.effective`. A `delivered` input still does not prove the agent acted on it; check `goal inputs` before sending the same correction again.
- `lifecycle.goalCompleted` is the goal result; `currentTask.taskCompleted` is not. Judge completion from the goal result and its final PR (`goal.finalPr`, `goal.pullRequests`), then review that PR like any other.

## Receipts and errors

Keep every mutation receipt and follow it with `get_operation`; use
`list_operations` to recover recent handles when the exact ID is unavailable.
An accepted or queued receipt confirms dispatch, not completion. Respect its
polling hint and read the lifecycle state, timestamps, artifacts and progress.
On failure, preserve `error.code`, `error.stage`, `error.retryable` and any
`error.cause` in the report. `OUTCOME_UNKNOWN` means a mutation may have reached
an external system, so inspect the named target before considering a new action.

## Asking about ProPR

For questions about ProPR behavior, configuration or operator procedures, use
`search_docs` and then read the relevant result with `get_doc`. Use
`find_setting` when the question is specifically where a setting lives or how
it can be changed. Treat the bundled documentation as the product reference;
do not infer current behavior from repository content or task narration alone.

## Keep the deterministic boundary

- Inside a ProPR implementation task, edit and test only. Do not commit, push, repair Git permissions, or create another ProPR task recursively. ProPR finalizes Git changes.
- Never grant or broaden repository, provider, system, membership, or access-control permissions. Leave all such operations to a human administrator.
- Do not copy credentials or modify provider credential files. Never put secrets, tokens, device codes, or private configuration in issues, comments, logs, or command arguments.
- Diagnose without mutation unless implementation was requested. Treat merging the PR, publishing, deploying, account changes, and destructive cleanup as distinct authority.
- Preserve existing worktrees and user data. Prefer non-destructive validation with isolated stacks, ports, and data directories.
