---
sidebar_position: 5
---

# Agents and Models

ProPR runs coding work through configurable agents. Each agent is a CLI tool packaged in its own Docker image, with credentials mounted from the host. Models are addressed by stable ProPR model IDs that work everywhere a model can be chosen: issue labels, the Web UI, the CLI (`-a`/`-m`), and PR commands (`/switch`, `/use`, `/review <model>`).

The canonical catalog lives in `packages/shared/src/modelDefinitions.ts`. The tables below reflect that file; if they ever disagree, the source file wins. Custom model IDs can also be added per agent in the Web UI (**AI Agents**) or with `propr agent add`.

## Supported Agents

| Agent | Type | Docker image | Host credentials |
|-------|------|--------------|------------------|
| Claude Code (Anthropic) | `claude` | `propr/agent-claude` | `HOST_CLAUDE_DIR` → `~/.claude` |
| Codex (OpenAI) | `codex` | `propr/agent-codex` | `HOST_CODEX_DIR` → `~/.codex` |
| Antigravity (Google, multi-model) | `antigravity` | `propr/agent-antigravity` | `HOST_ANTIGRAVITY_DIR` → `~/.gemini` (authenticate with `agy login`) |
| OpenCode | `opencode` | `propr/agent-opencode` | `HOST_OPENCODE_XDG_DIR` → `~/.config/opencode` (plus data dir; see below) |
| Mistral Vibe | `vibe` | `propr/agent-vibe` | `HOST_VIBE_DIR` → `~/.vibe` (plus `HOST_VIBE_PROMPT_CACHE_DIR`/`VIBE_PROMPT_CACHE_DIR` for the prompt cache) |

Authenticate each agent's CLI on the host first; the launcher and compose files mount the credential directories into agent containers at their host paths. These mounts are read-write — worker containers may refresh auth state (the launcher mounts the OpenCode data directory read-write for workers and read-only elsewhere); only the `.env` file is mounted read-only. Gemini CLI was discontinued upstream and is not a supported agent — Gemini models route through Antigravity.

## Model Labels

Every model has a GitHub label of the form `llm-<agent>-<model-alias>`. Add one to an issue (together with your trigger label, such as `AI`) to route that issue to the model. Adding **several** model labels to one issue creates a separate run, branch, and pull request per model, which is the built-in way to compare model output on the same task.

The same model IDs work in PR comments:

```
/switch claude-opus48     # future follow-ups on this PR use this model
/use codex-gpt55            # one follow-up with this model
/review claude-opus48 codex-gpt55   # independent reviews from two models
```

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

GPT-5.5 is the recommended default. GPT-5.4 Mini/Nano suit fast or subagent passes; GPT-5.3 Codex targets agentic coding.

| Model | Label | Context |
|-------|-------|---------|
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

OpenCode host setup. The `auth.json` copy into `xdg-data` (and the matching `XDG_DATA_HOME` env var) is a fallback for when the normal data-directory mount is unavailable — skip those steps if `HOST_OPENCODE_DATA_DIR` is mounted:

```bash
curl -fsSL https://opencode.ai/install | bash
mkdir -p ~/.config/opencode ~/.opencode
opencode auth login
mkdir -p ~/.config/opencode/xdg-data/opencode && \
  cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
```

OpenCode writes `auth.json` under `~/.local/share/opencode`, but ProPR mounts the configured OpenCode config directory into the container. With copied file-based auth, set `XDG_DATA_HOME=/home/node/.config/opencode/xdg-data` as an env var on the OpenCode agent. Use `~/.config/opencode` as the config path.

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

See [Agent Routing](./agent-routing.md) for how routing decisions flow through the system.
