---
sidebar_position: 5
---

# OpenCode Integration

The OpenCode integration lets ProPR run OpenCode as an additional coding agent alongside Claude Code, Codex, Antigravity, and Mistral Vibe. It is implemented by the OpenCode agent class, the OpenCode Docker image, and the shared agent registry.

This page covers OpenCode-specific setup and runtime behavior. For the common pattern shared by all coding agents, see [Coding Agent Integration](./coding-agent-integration.md).

## Components

```text
ProPR Worker
    |
    | resolves agent alias and model
    v
AgentRegistry
    |
    | creates OpenCodeAgent from saved config
    v
OpenCodeAgent
    |
    | docker run propr/agent-opencode
    v
OpenCode CLI
```

The main files are:

- `packages/core/src/agents/impl/OpenCodeAgent.ts` - executes tasks and analysis jobs.
- `packages/core/src/agents/impl/openCodeUtils.ts` - builds Docker arguments, prompts, and parses OpenCode JSON output.
- `Dockerfile.opencode` - builds the OpenCode execution image from `propr/agent-base`.
- `scripts/opencode-entrypoint.sh` and `scripts/opencode-run.sh` - prepare the container and invoke OpenCode in JSON mode.

## Host Setup

Install OpenCode on the host and initialize the directories ProPR can mount:

```bash
curl -fsSL https://opencode.ai/install | bash
# or: npm install -g opencode-ai

mkdir -p ~/.config/opencode ~/.local/share/opencode
opencode --version
opencode auth login
```

OpenCode's config location is `~/.config/opencode`. Configure agents with that path.

OpenCode includes built-in free models that can run without provider login. Operators only need to provide credentials for OpenCode Go or any other authenticated provider/model source they configure.

The OpenCode model list is dynamic. Run `opencode models` on the host after changing auth providers, then add any desired authenticated provider IDs, such as `openai/gpt-5.5`, to that OpenCode agent's `supportedModels`. ProPR keeps only the built-in free OpenCode models as defaults and does not add authenticated provider models automatically.

OpenCode stores provider auth in `~/.local/share/opencode/auth.json`. Deployments must make credentials available to the OpenCode agent container by either:

- Passing provider API keys as agent `envVars`.
- Using the default development compose mounts with a saved `configPath` under `/home/your-user/.config/opencode`; ProPR infers `/home/your-user/.local/share/opencode` and mounts it into spawned OpenCode agent containers when that directory exists.
- Setting `HOST_OPENCODE_DATA_DIR=/home/your-user/.local/share/opencode` when using the production launcher. The worker will mount that host directory into spawned OpenCode agent containers at `/home/node/.local/share/opencode`.
- Copying or syncing `~/.local/share/opencode/auth.json` to `~/.config/opencode/xdg-data/opencode/auth.json` and setting `XDG_DATA_HOME=/home/node/.config/opencode/xdg-data` in the OpenCode agent `envVars` only when the normal data-dir mount is unavailable. Re-sync this file after changing providers or refreshing OpenCode auth.

```bash
mkdir -p ~/.config/opencode/xdg-data/opencode && cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
```

## Agent Configuration

OpenCode agents are normal ProPR agent configs:

```json
{
  "id": "opencode-1",
  "type": "opencode",
  "alias": "opencode",
  "enabled": true,
  "dockerImage": "propr/agent-opencode:latest",
  "configPath": "/home/your-user/.config/opencode",
  "supportedModels": ["opencode-minimax-m3-free"],
  "defaultModel": "opencode-minimax-m3-free",
  "envVars": {}
}
```

The equivalent CLI command is:

```bash
propr agent add opencode \
  -t opencode \
  -m opencode-minimax-m3-free \
  -d opencode-minimax-m3-free \
  --docker-image propr/agent-opencode:latest \
  --config-path /home/your-user/.config/opencode
```

Use `opencode-minimax-m3-free` (ProPR's catalog ID, with the `opencode-` prefix) for the built-in free OpenCode model, or register another model from `opencode models` under the same prefix (for example `opencode-openai/gpt-5.5`). ProPR converts these IDs back to OpenCode's native `provider/model` syntax at execution time. The `envVars` block is required only when using copied `opencode auth login` credentials under the mounted config tree; provider-key env vars can be supplied there instead.

With the default `MODEL_LABEL_PATTERN=^llm-(.+)$`, the GitHub label `llm-opencode-minimax-m3-free` maps to ProPR model ID `opencode-minimax-m3-free`, which is converted to OpenCode's native `minimax/minimax-m3` form at execution time when an enabled OpenCode agent supports that model.

## Container Execution

At runtime, ProPR mounts the configured host config path into the agent container:

```text
<configPath>:/home/node/.config/opencode
```

If `HOST_OPENCODE_DATA_DIR` is set in the worker environment, ProPR also mounts that host directory into the OpenCode agent container at `/home/node/.local/share/opencode`. When `HOST_OPENCODE_DATA_DIR` is not set, ProPR infers the matching host data path for default config paths like `/home/your-user/.config/opencode` and mounts it when the directory exists. Without either data mount, file-based auth must live under the mounted config path with `XDG_DATA_HOME` pointed at that location, or credentials must be passed as provider env vars.

The OpenCode container receives:

- The checked-out worktree at `/home/node/workspace`.
- GitHub credentials through `GH_TOKEN` and `GITHUB_TOKEN`.
- `OPENCODE_CONFIG_DIR=/home/node/.config/opencode`.
- `XDG_CONFIG_HOME=/home/node/.config`.
- `XDG_DATA_HOME=/home/node/.local/share` by default, or the agent `envVars` override when file-based OpenCode auth is stored under the mounted config path.

The command is executed through `opencode-run --format json`, with `--model <model>` when ProPR selected a model. ProPR strips only the internal `opencode:` routing prefix before passing the model to OpenCode, so provider-qualified model IDs remain intact.

OpenCode runs are bounded by `OPENCODE_TIMEOUT_MS` (default `3600000`, one hour):

```bash
OPENCODE_TIMEOUT_MS=3600000
```

## Docker Images

The published OpenCode agent image is:

```text
propr/agent-opencode:latest
```

Versioned builds use the same image family, for example:

```text
propr/agent-opencode:<version>-<content-hash>
```

`scripts/build-images.sh` builds the image from `Dockerfile.opencode` and installs the `opencode-ai` npm package into the shared agent base image. `Dockerfile.opencode` pins the CLI version through its `CLI_VERSION` build argument (default `1.16.2`), so image builds are reproducible; pass a different `CLI_VERSION` to build against another OpenCode release.

## Operations

For Docker Compose development, the compose files mount:

```text
~/.config/opencode
~/.local/share/opencode
```

In development compose, the worker mounts these read-write (matching the Claude Code, Codex, Antigravity, and Mistral Vibe credential mounts) so the OpenCode agent containers can access credentials and refresh auth metadata at runtime. Read-only services like the analysis-worker and API mount them with `:ro`. The base production compose file does not mount agent credential directories by default; add them with a deployment-specific override file, or use the launcher.

The API does not refresh OpenCode auth files. Runtime auth refresh is limited to worker-spawned OpenCode agent containers, which receive the OpenCode data directory as a read-write bind mount.

For launcher-based production deployments, pass the host paths explicitly:

```bash
-e HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode
-e HOST_OPENCODE_DATA_DIR=/home/your-user/.local/share/opencode
```

`HOST_OPENCODE_DATA_DIR` supports normal `opencode auth login` credentials without copying `auth.json` into the config tree and is mounted read-write so the CLI can refresh auth metadata. Launcher values must be absolute host paths; `.env` parsing does not expand `~` or `$HOME`.

Before assigning work to OpenCode, verify:

```bash
propr agent list
opencode auth list
docker image ls propr/agent-opencode
```

Authentication failures usually mean the configured `configPath` does not point at the host's initialized OpenCode directory, `HOST_OPENCODE_DATA_DIR`/`XDG_DATA_HOME` is not pointed at mounted auth data, or the selected OpenCode/provider API key is missing or expired.
