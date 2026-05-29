---
sidebar_position: 5
---

# OpenCode Integration

The OpenCode integration lets ProPR run OpenCode as an additional coding agent alongside Claude, Codex, and Gemini. It is implemented by the OpenCode agent class, the OpenCode Docker image, and the shared agent registry.

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

mkdir -p ~/.config/opencode ~/.config/opencode/xdg-data/opencode
opencode --version
opencode auth login
```

OpenCode's current config location is `~/.config/opencode`. Configure new agents with that path. Legacy deployments can keep using `~/.opencode` by saving the agent `configPath` as `~/.opencode`; the saved `configPath` is the single path mounted into the OpenCode agent container.

Operators must provide their own credentials. OpenCode Go is an optional OpenCode provider/model source, separate from the OpenCode CLI; users can authenticate OpenCode Go or configure any other provider supported by OpenCode.

OpenCode stores provider auth in `~/.local/share/opencode/auth.json`, while the ProPR agent runtime mounts only the configured OpenCode config directory. Deployments must make credentials available to the OpenCode agent container by either:

- Passing provider API keys as agent `envVars`.
- Copying or syncing `~/.local/share/opencode/auth.json` to `~/.config/opencode/xdg-data/opencode/auth.json` and setting `XDG_DATA_HOME=/home/node/.config/opencode/xdg-data` in the OpenCode agent `envVars`.

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
  "configPath": "~/.config/opencode",
  "supportedModels": ["opencode-go/kimi-k2.6"],
  "defaultModel": "opencode-go/kimi-k2.6",
  "envVars": {
    "XDG_DATA_HOME": "/home/node/.config/opencode/xdg-data"
  }
}
```

The equivalent CLI command is:

```bash
propr agent add opencode \
  -t opencode \
  -m opencode-go/kimi-k2.6 \
  -d opencode-go/kimi-k2.6 \
  --docker-image propr/agent-opencode:latest \
  --config-path ~/.config/opencode
```

Use `opencode-go/kimi-k2.6` for OpenCode Go Kimi, or replace it with another model ID from the provider configured in OpenCode. The `envVars` block is required only when using copied `opencode auth login` credentials under the mounted config tree; provider-key env vars can be supplied there instead.

With the default `MODEL_LABEL_PATTERN=^llm-(.+)$`, the GitHub label `llm-opencode-kimi-k26` maps to `opencode-go/kimi-k2.6` through ProPR's model catalog when an enabled OpenCode agent supports that model.

## Container Execution

At runtime, ProPR mounts the configured host config path into the agent container:

```text
<configPath>:/home/node/.config/opencode
```

It does not mount `~/.local/share/opencode` separately. File-based auth must therefore live under the mounted config path with `XDG_DATA_HOME` pointed at that location, or credentials must be passed as provider env vars.

The OpenCode container receives:

- The checked-out worktree at `/home/node/workspace`.
- GitHub credentials through `GH_TOKEN` and `GITHUB_TOKEN`.
- `OPENCODE_CONFIG_DIR=/home/node/.config/opencode`.
- `XDG_CONFIG_HOME=/home/node/.config`.
- `XDG_DATA_HOME=/home/node/.local/share` by default, or the agent `envVars` override when file-based OpenCode auth is stored under the mounted config path.

The command is executed through `opencode-run --format json`, with `--model <model>` when ProPR selected a model. ProPR strips only the internal `opencode:` routing prefix before passing the model to OpenCode, so provider-qualified model IDs remain intact.

## Docker Images

The published OpenCode agent image is:

```text
propr/agent-opencode:latest
```

Versioned builds use the same image family, for example:

```text
propr/agent-opencode:<version>-<content-hash>
```

`scripts/build-images.sh` builds the image from `Dockerfile.opencode` and installs the `opencode-ai` npm package into the shared agent base image.

## Operations

For Docker Compose development, the compose files mount both:

```text
~/.opencode
~/.config/opencode
```

These are config mounts only. They do not mount `~/.local/share/opencode`; use agent env vars or the `xdg-data` auth path described above for credentials.

For launcher-based production deployments, pass the host paths explicitly:

```bash
-e HOST_OPENCODE_LEGACY_DIR=$HOME/.opencode
-e HOST_OPENCODE_XDG_DIR=$HOME/.config/opencode
```

Pass `HOST_OPENCODE_LEGACY_DIR` only for agents whose saved `configPath` is `~/.opencode`.

Before assigning work to OpenCode, verify:

```bash
propr agent list
opencode auth list
docker image ls propr/agent-opencode
```

Authentication failures usually mean the configured `configPath` does not point at the host's initialized OpenCode directory, `XDG_DATA_HOME` is not pointed at the mounted auth data directory, or the selected OpenCode/provider API key is missing or expired.
