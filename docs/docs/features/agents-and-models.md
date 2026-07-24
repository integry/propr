---
sidebar_position: 5
---

# Agents and Models

ProPR runs coding work through configurable agents. Each agent is a CLI tool packaged in its own Docker image, with credentials mounted from the host. Models are addressed by stable ProPR model IDs that work everywhere a model can be chosen: issue labels, the Web UI, the CLI (`-a`/`-m`), and PR commands (`/switch`, `/use`, `/review <model>`).

The canonical catalog lives in `packages/shared/src/modelDefinitions.ts`. The tables below reflect that file; if they ever disagree, the source file wins. Custom model IDs can also be added per agent in the Web UI (**AI Agents**) or with `propr agent add`.

## What Routing Solves

Different agents are better at different work, and most teams hold a mix of subscription access, API access, and provider-specific limits. ProPR treats the agent and model as routing decisions within a single workflow: the same issue intake, planning, PR creation, comment handling, and task history apply whichever agent runs the task.

Use routing when you want to:

- Choose a default agent for routine implementation
- Use a stronger or different model for reviews
- Compare outputs from multiple models
- Keep using subscription-backed CLI credentials where available
- Fall back to another provider when rate limits or quota are tight
- Preserve the same PR follow-up workflow across providers

## Supported Agents

| Agent | Type | Docker image | Host credentials |
|-------|------|--------------|------------------|
| Claude Code (Anthropic) | `claude` | `propr/agent` | `HOST_CLAUDE_DIR` → `~/.claude` |
| Codex (OpenAI) | `codex` | `propr/agent` | `HOST_CODEX_DIR` → `~/.codex` |
| Antigravity (Google, multi-model) | `antigravity` | `propr/agent` | `HOST_ANTIGRAVITY_DIR` → `~/.gemini` (authenticate with `agy login`) |
| OpenCode | `opencode` | `propr/agent` | `HOST_OPENCODE_XDG_DIR` → `~/.config/opencode` (plus data dir; see below) |
| Mistral Vibe | `vibe` | `propr/agent` | `HOST_VIBE_DIR` → `~/.vibe` (plus `HOST_VIBE_PROMPT_CACHE_DIR`/`VIBE_PROMPT_CACHE_DIR` for the prompt cache) |

Authenticate each agent's CLI on the host first; the launcher and compose files mount the credential directories into agent containers at their host paths. These mounts are read-write — worker containers may refresh auth state (the launcher mounts the OpenCode data directory read-write for workers and read-only elsewhere); only the `.env` file is mounted read-only. Gemini CLI was discontinued upstream; Gemini models route through Antigravity.

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

{/* SCREENSHOT PLACEHOLDER (P2 — interim: the site's ui-agents.png): Capture the AI Agents page with the agent configuration modal open for a Claude agent: agent type, alias, enable toggle, supported models checklist with one default model selected, and the config path field. */}

## Reasoning Levels

The system setting `model_reasoning_level` applies to Claude and Codex agent invocations, including implementation runs and lightweight analysis runs such as planning context, plan generation, and PR review. Short task-title generation does not inherit the system setting, avoiding high-cost reasoning for a trivial summary; a model-specific reasoning override or `level-*` label still applies. Leave the setting empty to use each CLI's default. Each supported model can also set one of its agent runtime's native reasoning levels in the agent configuration; that model-specific value overrides the system setting. An issue or PR `level-*` label has the highest precedence and overrides both.

Valid values are `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `ultracode`, and `auto`. ProPR accepts the union of the Claude and Codex vocabularies, then adapts it per runtime: Codex maps `ultracode` to `ultra` and omits `auto`; Claude maps `ultra` to `max` and passes `auto` through as Claude Code's adaptive effort mode.

Reasoning flags require Claude Code >= 2.1.68 and Codex CLI >= 0.144.0. Saving a global or model-specific reasoning level surfaces a non-blocking warning for enabled agents pinned below those versions. If the mismatch remains, ProPR also fails an affected run before starting the CLI with a version-specific error.

## Model Labels

Every model has a GitHub label of the form `llm-<agent>-<model-alias>`. Add one to an issue (together with your trigger label, such as `AI`) to route that issue to the model. The same identity follows the run through the system: task records show the selected agent and model, and branch names include the model identifier for traceability.

Adding **several** model labels to one issue fans the work out into one job per model label: each model gets its own run, its own worktree and branch, and its own pull request. Compare the PRs, merge the best one, and close the rest. If a `base-<branch>` label is also present, the fan-out is per base × per model.

```text
AI
llm-claude-opus48
llm-codex-gpt56-sol
```

This issue produces two tasks and two pull requests — one per model.

The same aliases work in PR comments (the `llm-` prefix is optional; the raw catalog model ids are accepted too):

```
/switch claude-opus48     # future follow-ups on this PR use this model
/use codex-gpt56-sol      # one follow-up with this model
/review claude-opus48 codex-gpt56-sol   # independent reviews from two models
```

See [PR Slash Commands](./pr-commands.md) for full command syntax.

## Claude Code Models

| Model | Label | Context |
|-------|-------|---------|
| Claude Fable 5 | `llm-claude-fable` | 1M |
| Claude Opus 4.8 | `llm-claude-opus48` | 1M |
| Claude Opus 4.7 | `llm-claude-opus47` | 1M |
| Claude Opus 4.6 | `llm-claude-opus46` | 1M |
| Claude Sonnet 4.6 | `llm-claude-sonnet46` | 1M |
| Claude Opus 4.5 | `llm-claude-opus45` | 200K |
| Claude Sonnet 4.5 | `llm-claude-sonnet45` | 200K |
| Claude Haiku 4.5 | `llm-claude-haiku` | 200K |

Some models require a minimum agent CLI version (for example, Fable 5 requires Claude Code ≥ 2.1.170); ProPR records this in the catalog and the agent image is kept current.

## Codex Models

GPT-5.6 Sol is the recommended default for complex implementation, research, and security work. GPT-5.6 Terra balances capability, speed, and cost for everyday work; GPT-5.6 Luna is the fastest and lowest-cost GPT-5.6 option. GPT-5.6 models require Codex CLI >= 0.144.0.

| Model | Label | Context |
|-------|-------|---------|
| GPT-5.6 Sol | `llm-codex-gpt56-sol` | 1M |
| GPT-5.6 Terra | `llm-codex-gpt56-terra` | 400K |
| GPT-5.6 Luna | `llm-codex-gpt56-luna` | 400K |
| GPT-5.5 | `llm-codex-gpt55` | 1M |
| GPT-5.5 Pro | `llm-codex-gpt55-pro` | 1M |
| GPT-5.4 | `llm-codex-gpt54` | 1M |
| GPT-5.4 Pro | `llm-codex-gpt54-pro` | 1M |
| GPT-5.4 Mini | `llm-codex-gpt54-mini` | 400K |
| GPT-5.4 Nano | `llm-codex-gpt54-nano` | 400K |
| GPT-5.3 Codex | `llm-codex-gpt53-codex` | 400K |
| GPT-5.3 Codex Spark | `llm-codex-spark` | 400K |
| GPT-5.2 | `llm-codex-gpt52` | 400K |
| GPT-5 Mini | `llm-codex-gpt5-mini` | 400K |
| GPT-5 Nano | `llm-codex-gpt5-nano` | 400K |

## Antigravity Models

Antigravity is a multi-model CLI: one container and credential mount expose several backing models. All entries have a 1M context window.

| Model | Label |
|-------|-------|
| Gemini 3.5 Flash Low / Medium / High | `llm-antigravity-flash-low` / `-flash-medium` / `-flash-high` |
| Gemini 3.1 Pro Low / High | `llm-antigravity-pro-low` / `-pro-high` |
| Claude Sonnet 4.6 Thinking | `llm-antigravity-sonnet46-thinking` |
| Claude Opus 4.6 Thinking | `llm-antigravity-opus46-thinking` |
| GPT-OSS 120B Medium | `llm-antigravity-gpt-oss-120b` |

## OpenCode Models

Built-in free models:

| Model | Label | Context |
|-------|-------|---------|
| MiniMax M3 Free | `llm-opencode-minimax-m3-free` | 200K |
| DeepSeek V4 Flash Free | `llm-opencode-deepseek-v4-flash-free` | 200K |
| MiMo V2.5 Free | `llm-opencode-mimo-v25-free` | 200K |
| Nemotron 3 Ultra Free | `llm-opencode-nemotron-3-ultra-free` | 1M |
| Big Pickle | `llm-opencode-big-pickle` | 200K |

OpenCode can also use any provider/model you have authenticated on the host. Run `opencode models` after `opencode auth login`, then register the IDs with ProPR's `opencode-` prefix (for example `opencode-openai/gpt-5.5`). Dynamic OpenCode labels use a `~` separator — `llm-<agent-alias>~<propr-opencode-model-id>`, for example `llm-opencode~opencode-openai/gpt-5.5`. The `~` format is a stable public contract: the labels persist on GitHub issues and are resolved for routing at execution time.

OpenCode host setup, in brief: install the CLI, run `opencode auth login`, and use `~/.config/opencode` as the agent config path. Provider auth lands in `~/.local/share/opencode/auth.json`, which the worker mounts into agent containers when `HOST_OPENCODE_DATA_DIR` is set (or inferred from the default config path). See [OpenCode in the Agent Runtime Reference](../architecture/agent-runtime.md#opencode) for the full host setup and the auth-data fallback options.

## Mistral Vibe Models

| Model | Label | Context |
|-------|-------|---------|
| Mistral Medium 3.5 | `llm-vibe-mistral` | 256K |
| Devstral Small | `llm-vibe-devstral` | 256K |

## Choosing Models per Phase

Planning, implementation, review, and follow-ups can each use a different agent or model:

- Defaults per agent are configured in the Web UI (**AI Agents**) or `propr agent add -d <model>`.
- Planner models are settings keys: `planner_context_model`, `planner_generation_model`, and `analysis_model_fast` (see `propr setting get`).
- Reviews use the configured `pr_review_model` unless a model is named in the `/review` command.
- Per-task overrides: issue labels, `propr issue implement -a <agent> -m <model>`, `/switch`, and `/use`.
