---
sidebar_position: 4
---

# Agent Routing

ProPR can route work to different coding agents without forcing you to change the rest of the workflow. The same issue intake, planning, PR creation, comment handling, and task history apply whichever agent runs the task.

ProPR supports five agents:

- **Claude Code** (Anthropic)
- **Codex** (OpenAI)
- **Antigravity** (Google's multi-model CLI; routes to Gemini, Claude, and GPT-OSS backends through one agent)
- **OpenCode** (built-in free models without provider login)
- **Mistral Vibe**

The full list of models and their labels lives in [Agents and Models](./agents-and-models.md).

## What Routing Solves

Different agents are better at different work. You may also have a mix of subscription access, API access, and provider-specific limits. ProPR treats the agent and model as routing decisions within a single workflow.

Use routing when you want to:

- Choose a default agent for routine implementation
- Use a stronger or different model for reviews
- Compare outputs from multiple models
- Keep using subscription-backed CLI credentials where available
- Fall back to another provider when rate limits or quota are tight
- Preserve the same PR follow-up workflow across providers

## Agent Configuration

The Web UI includes an AI Agents page for configuring coding agents. Each agent entry defines:

- Agent type (claude, codex, antigravity, opencode, vibe)
- A unique alias (lowercase alphanumeric and hyphens)
- An enable toggle
- The Docker image (predefined per agent type)
- The credential/config path mounted into agent containers
- The supported model list (toggle individual models on or off)
- The default model
- Optional per-model custom labels
- Optional environment variables and an API key
- The agent CLI version (default or a pinned custom version)

The model IDs you enable here become the durable names used by labels and slash commands.

{/* SCREENSHOT PLACEHOLDER: Capture the AI Agents page with the agent configuration modal open for a Claude agent: agent type, alias, enable toggle, supported models checklist with one default model selected, and the config path field. */}

## Model Labels

ProPR uses the same model naming across the system:

- Issue and PR labels use the form `llm-<agent-alias>-<model-alias>`
- Slash commands accept the same IDs (the `llm-` prefix is optional in command arguments)
- Task records show the selected agent and model
- Branch names include the model identifier for traceability

Examples of valid labels:

```text
llm-claude-opus48
llm-codex-gpt55
llm-antigravity-pro-high
llm-opencode-minimax-m3-free
llm-vibe-devstral
```

The exact IDs available in your deployment come from the AI Agents page; the built-in catalog is listed in [Agents and Models](./agents-and-models.md).

## Multi-Model Comparison

Add several `llm-*` labels to one issue to run it with several models at once. ProPR fans the issue out into one job per model label: each model gets its own run, its own worktree and branch (with the model name in the branch name), and its own pull request. Compare the PRs, merge the best one, and close the rest.

```text
AI
llm-claude-opus48
llm-codex-gpt55
```

This issue produces two tasks and two pull requests — one per model. If a `base-<branch>` label is also present, the fan-out is per base × per model.

## Routing On Pull Requests

Pull request follow-up can use the PR's configured model, switch the model permanently, or run a one-time task with a temporary model:

- `/switch <model-id>` changes the PR's model label for future work.
- `/use <model-id>` runs one immediate follow-up task with that model.
- `/review <model-id-a> <model-id-b>` requests one review comment per listed model.

See [PR Slash Commands](./pr-commands.md) for command syntax.

## Why This Is Core

Agent routing lets you choose the right agent without splitting planning, review, task history, and recovery across separate tools. The workflow stays stable while the agent choice changes.
