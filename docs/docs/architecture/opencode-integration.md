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

mkdir -p ~/.config/opencode ~/.opencode
opencode --version
opencode auth login
```

OpenCode's current config location is `~/.config/opencode`. ProPR also supports the legacy `~/.opencode` path because older OpenCode installs and existing deployments may still use it.

Operators must provide their own credentials. OpenCode Go is optional; users can authenticate OpenCode Go or configure any other provider supported by OpenCode.

OpenCode stores provider auth in `~/.local/share/opencode/auth.json` and also loads provider keys from environment variables or a project `.env` file. ProPR deployments should make one of those credential sources available to the OpenCode agent container.

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
  "defaultModel": "opencode-go/kimi-k2.6"
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

Use `opencode-go/kimi-k2.6` for OpenCode Go Kimi, or replace it with another model ID from the provider configured in OpenCode.

## Container Execution

At runtime, ProPR mounts the configured host path into the agent container:

```text
<configPath>:/home/node/.config/opencode
```

The OpenCode container receives:

- The checked-out worktree at `/home/node/workspace`.
- GitHub credentials through `GH_TOKEN` and `GITHUB_TOKEN`.
- `OPENCODE_CONFIG_DIR=/home/node/.config/opencode`.
- `XDG_CONFIG_HOME=/home/node/.config`.
- `XDG_DATA_HOME=/home/node/.local/share`.

The command is executed through `opencode-run --format json`, with `--model <model>` when ProPR selected a model. ProPR strips only the internal `opencode:` routing prefix before passing the model to OpenCode, so provider-qualified model IDs remain intact.

## Docker Images

The published OpenCode agent image is:

```text
propr/agent-opencode:latest
```

Versioned builds use the same image family, for example:

```text
propr/agent-opencode:1.15.12-<content-hash>
```

`scripts/build-images.sh` builds the image from `Dockerfile.opencode` and installs the `opencode-ai` npm package into the shared agent base image.

## Operations

For Docker Compose development, the compose files mount both:

```text
~/.opencode
~/.config/opencode
```

For launcher-based production deployments, pass the host paths explicitly:

```bash
-e HOST_OPENCODE_LEGACY_DIR=$HOME/.opencode
-e HOST_OPENCODE_XDG_DIR=$HOME/.config/opencode
```

Before assigning work to OpenCode, verify:

```bash
propr agent list
opencode auth list
docker image ls propr/agent-opencode
```

Authentication failures usually mean the configured `configPath` does not point at the host's initialized OpenCode directory, or the selected OpenCode/provider API key is missing or expired.
