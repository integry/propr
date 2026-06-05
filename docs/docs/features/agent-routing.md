---
sidebar_position: 4
---

# Agent Routing

ProPR can route work to different coding agents without forcing you to change the rest of the workflow. The same issue intake, planning, PR creation, comment handling, and task history apply whether the selected agent is Claude Code, Codex, Antigravity, or another configured backend.

Antigravity is a multi-model CLI agent. In ProPR it can expose model IDs for different backing models through the same Antigravity container and credential mount, so labels route to Antigravity model choices instead of to a Google-only agent.

## What Routing Solves

Different agents are better at different work. You may also have a mix of subscription access, API access, and provider-specific limits. ProPR treats the agent and model as routing decisions, not as separate workflows.

Use routing when you want to:

- Choose a default agent for routine implementation
- Use a stronger or different model for reviews
- Compare outputs from multiple models
- Keep using subscription-backed CLI credentials where available
- Fall back to another provider when rate limits or quota are tight
- Preserve the same PR follow-up workflow across providers

## Agent Configuration

The Web UI includes an AI Agents area for configuring coding agents. An enabled agent entry can define:

- Provider or implementation type
- Supported model IDs
- Default model
- Docker image
- Credential or config path
- Runtime timeouts and limits

The configured model IDs become the durable names used by labels and slash commands.

## Model-Aware Workflows

ProPR uses the same model naming across the system:

- Issue and PR labels use `llm-<model-id>`
- Slash commands accept configured model IDs
- Task records show the selected agent and model
- Branch names include model identifiers for traceability

Examples:

```text
llm-claude-sonnet46
llm-codex-gpt54
llm-antigravity-gemini-pro
llm-antigravity-opus
```

The exact IDs available in your deployment come from AI Agents in the Web UI.

## Routing On Pull Requests

Pull request follow-up can use the PR's configured model, switch the model permanently, or run a one-time task with a temporary model:

- `/switch <model-id>` changes the PR's model label for future work.
- `/use <model-id>` runs one immediate follow-up task with that model.
- `/review <model-id-a> <model-id-b>` requests review comments from specific models.

See [PR Slash Commands](./pr-commands.md) for command syntax.

## Why This Is Core

Agent routing is part of ProPR's core promise because it lets you choose the right agent without splitting planning, review, task history, and recovery across separate tools. The workflow stays stable while the agent choice changes.
