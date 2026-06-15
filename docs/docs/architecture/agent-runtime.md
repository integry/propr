---
sidebar_position: 6
---

# Agent Runtime Reference

This is the canonical runtime reference for ProPR coding agents. It covers the shared Docker execution model used by Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe. For the higher-level integration contract, routing model, and worker responsibilities, see [Coding Agent Integration](./coding-agent-integration.md).

## Runtime Model

Every coding agent runs in a Docker container so ProPR can control runtime dependencies, workspace mounts, credential mounts, timeouts, logging, and resource boundaries. The agent implementation changes the CLI command, image, credential directory, and output parser, but the container shape is shared:

- A task worktree mounted at `/home/node/workspace`
- Agent credentials mounted from the configured host credential directory
- GitHub credentials passed through `GH_TOKEN` and `GITHUB_TOKEN`
- Agent, model, timeout, and task metadata passed as environment variables or CLI flags
- `--security-opt no-new-privileges`, `--cap-add CHOWN`, and Docker's default `bridge` network
- Structured stdout, stderr, exit code, duration, session ID, and token usage capture when the CLI exposes those fields

Most agent images build on the shared `propr/agent-base` image, which includes Node.js, Git and repository tooling, `scripts/init-firewall.sh`, a scoped `gh` wrapper, and entrypoint support used by the worker. Antigravity currently uses a Debian slim base because its installer requires glibc, but it keeps the same workspace, credential, GitHub token, entrypoint, and logging contract.

| Agent | Image | Dockerfile | Entrypoint | Container credential path |
| --- | --- | --- | --- | --- |
| Claude Code | `propr/agent-claude` | `Dockerfile.claude` | `scripts/claude-entrypoint.sh` | `/home/node/.claude` |
| Codex | `propr/agent-codex` | `Dockerfile.codex` | `scripts/codex-entrypoint.sh` | `/home/node/.codex` |
| Antigravity | `propr/agent-antigravity` | `Dockerfile.antigravity` | `scripts/antigravity-entrypoint.sh` | `/home/node/.gemini` |
| OpenCode | `propr/agent-opencode` | `Dockerfile.opencode` | `scripts/opencode-entrypoint.sh` | `/home/node/.config/opencode` |
| Mistral Vibe | `propr/agent-vibe` | `Dockerfile.vibe` | `scripts/vibe-entrypoint.sh` | `/home/node/.vibe` |

## Container Configuration

The worker launches the selected agent image with a prepared worktree, a generated container name, the configured credential mount, and any agent-level environment variables. Containers are removed after execution with `--rm`, run with stdin enabled, and use `/home/node/workspace` as the working directory.

Most entrypoints start as root so they can prepare runtime directories or fix container-local ownership, then drop to the `node` user before running the CLI. Entrypoints also mark Git directories as safe, install the `gh` wrapper when present, and emit diagnostics that are captured with the task logs.

Credential and launcher paths must be absolute host paths. Shell shortcuts such as `~` and `$HOME` are not expanded by the runtime configuration parser.

## Timeouts And Loop Limits

Timeouts prevent runaway jobs and make failures visible in task state. Defaults differ by agent:

| Agent | Timeout variable | Default | Loop variable | Default |
| --- | --- | ---: | --- | ---: |
| Claude Code | `CLAUDE_TIMEOUT_MS` | `300000` | `CLAUDE_MAX_TURNS` | `1000` |
| Codex | `CODEX_TIMEOUT_MS` | `3600000` | `CODEX_MAX_TURNS` | `1000` |
| Antigravity | `ANTIGRAVITY_TIMEOUT_MS` | `3600000` | Not used | N/A |
| OpenCode | `OPENCODE_TIMEOUT_MS` | `3600000` | Not used | N/A |
| Mistral Vibe | `VIBE_TIMEOUT_MS` | `3600000` | `VIBE_MAX_TURNS` | `1000` |

When tuning these values, consider repository size, task complexity, provider rate limits, worker concurrency, and host CPU and memory. Increase timeouts only after checking task and worker logs; a timeout may indicate missing context, provider slowness, a task that should be split, or an agent loop.

## Security Boundary

The runtime should preserve these boundaries:

- Keep git finalization outside the agent.
- Mount only the workspace and required credential directories.
- Avoid broad host filesystem mounts.
- Keep credential directories scoped to the deployment user.
- Monitor container CPU, memory, and duration.
- Treat `--dangerously-*` CLI flags as acceptable only because Docker is the outer isolation boundary.

### Network Egress

Agent images ship `scripts/init-firewall.sh`, an optional egress-restriction script. All current agent entrypoints skip it because applying those rules requires running the container with Docker's `--privileged` flag.

Containers run on Docker's default bridge network with `--security-opt no-new-privileges` and `--cap-add CHOWN`, so outbound network access is unrestricted by default. Treat the firewall script as available hardening for deployments that can run privileged containers, not as an active control in the default runtime.

Provider connectivity failures usually come from the host network, DNS, proxy settings, provider availability, or an external firewall, not from a ProPR-applied network policy. If you enable the firewall script in a privileged deployment, confirm its allowlist covers GitHub and the provider endpoints required by every enabled agent image.

## Monitoring And Debugging

Useful signals:

- Task logs in the Web UI
- Worker logs with correlation IDs
- Container exit code
- Agent stdout and stderr
- Session or conversation IDs when available
- Duration, timeout state, token usage, and usage-limit state

For direct Docker inspection:

```bash
docker ps
docker logs <container>
docker inspect <container>
```

## Common Issues

### Authentication Issues

Check that the CLI is authenticated on the host and that the expected host credential directory is mounted into the container path for that agent. For example, Claude Code expects the host Claude directory mounted at `/home/node/.claude`, while Codex expects the Codex directory mounted at `/home/node/.codex`.

### Docker Permission Issues

Check that the deployment user can access Docker and that the launcher or worker can start sibling containers. If a container can start but cannot edit the worktree, inspect bind-mount ownership and the entrypoint diagnostics.

### Network Issues

Egress is unrestricted by default because the shipped firewall script is skipped by every entrypoint. Check the host network, DNS, proxy configuration, external firewall rules, and provider status before looking for a ProPR container firewall rule.

### Timeout Issues

Check worker logs, task logs, provider latency, and model routing before increasing timeout values. Persistent timeouts often mean the prompt is too broad, context is missing, or the provider is slow or rate limited.

## Agent-Specific Configuration

### Claude Code

Claude Code uses `Dockerfile.claude`, `scripts/claude-entrypoint.sh`, and the `propr/agent-claude` image. The host credential directory is configured with `CLAUDE_CONFIG_PATH` or the agent config path and is mounted at `/home/node/.claude`.

Common settings:

```bash
CLAUDE_DOCKER_IMAGE=propr/agent-claude:latest
CLAUDE_CONFIG_PATH=/home/your-user/.claude
CLAUDE_MAX_TURNS=1000
CLAUDE_TIMEOUT_MS=300000
```

The entrypoint checks for `/home/node/.claude/.credentials.json`, creates expected Claude subdirectories such as `todos`, `projects`, `shell-snapshots`, and `statsig`, and prepares `/home/node/.claude/projects/home-node-workspace` for the mounted workspace.

For implementation tasks, the worker invokes Claude Code with the prompt on stdin:

```bash
claude -p - [--model <id>] --max-turns N --output-format stream-json --verbose --dangerously-skip-permissions
```

`--max-turns` comes from `CLAUDE_MAX_TURNS`. The worker captures Claude's stream JSON output, session ID, conversation log, and token usage when available.

### Codex

Codex uses `Dockerfile.codex`, `scripts/codex-entrypoint.sh`, and the `propr/agent-codex` image. The host credential directory is configured with the agent config path, commonly from `HOST_CODEX_DIR`, and is mounted at `/home/node/.codex`.

Common settings:

```bash
HOST_CODEX_DIR=/home/your-user/.codex
CODEX_TIMEOUT_MS=3600000
CODEX_MAX_TURNS=1000
```

The entrypoint checks for `/home/node/.codex/config.toml`, prepares `sessions` and `rules`, and avoids recursively changing bind-mounted workspace ownership. Codex runs as:

```bash
codex exec --json --dangerously-bypass-approvals-and-sandbox --config features.multi_agent=false --skip-git-repo-check --cd /home/node/workspace -
```

When a model is selected, ProPR adds `--model <id>`. Codex emits NDJSON events that ProPR parses into logs, result text, session metadata, and token usage.

### Antigravity

Antigravity uses `Dockerfile.antigravity`, `scripts/antigravity-entrypoint.sh`, and the `propr/agent-antigravity` image. The runtime resolves `ANTIGRAVITY_CONFIG_PATH` or the agent config path and mounts the selected host directory at `/home/node/.gemini`. If the configured path ends in `.antigravity` and a sibling `.gemini` directory exists, ProPR uses that `.gemini` directory for credentials.

Common settings:

```bash
HOST_ANTIGRAVITY_DIR=/home/your-user/.gemini
ANTIGRAVITY_CONFIG_PATH=/home/your-user/.gemini
ANTIGRAVITY_TIMEOUT_MS=3600000
```

The entrypoint prepares Antigravity runtime directories under the mounted config path and looks for auth, OAuth, credential, or token files. The agent CLI is `agy`; ProPR passes the selected model with `--model <id>` after translating ProPR model IDs into Antigravity CLI model IDs.

### OpenCode

OpenCode uses `Dockerfile.opencode`, `scripts/opencode-entrypoint.sh`, and the `propr/agent-opencode` image. The primary config mount is commonly `HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode`, mounted at `/home/node/.config/opencode`.

Common settings:

```bash
HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode
HOST_OPENCODE_LEGACY_DIR=/home/your-user/.opencode
HOST_OPENCODE_DATA_DIR=/home/your-user/.local/share/opencode
OPENCODE_TIMEOUT_MS=3600000
OPENCODE_DOCKER_IMAGE=propr/agent-opencode:latest
```

The entrypoint also supports legacy config through `/home/node/.opencode`, sets `OPENCODE_CONFIG_DIR=/home/node/.config/opencode`, and prepares XDG data and state directories. When `HOST_OPENCODE_DATA_DIR` is set, ProPR mounts it for OpenCode auth data; otherwise it can infer the data path from the XDG config path.

OpenCode runs in JSON mode through the OpenCode adapter. ProPR passes the selected model with `--model <id>` and parses OpenCode responses back into the shared agent result shape.

### Mistral Vibe

Mistral Vibe uses `Dockerfile.vibe`, `scripts/vibe-entrypoint.sh`, and the `propr/agent-vibe` image. The host config directory is configured with `VIBE_CONFIG_PATH` or the agent config path, commonly from `HOST_VIBE_DIR`, and is mounted at `/home/node/.vibe` when usable.

Common settings:

```bash
HOST_VIBE_DIR=/home/your-user/.vibe
VIBE_CONFIG_PATH=/home/your-user/.vibe
VIBE_TIMEOUT_MS=3600000
VIBE_MAX_TURNS=1000
VIBE_ANALYSIS_TIMEOUT_MS=1800000
MISTRAL_API_KEY=...
```

Vibe can use either a valid Vibe config directory or `MISTRAL_API_KEY`. The entrypoint copies config into a per-run runtime home, sets `HOME` and `VIBE_HOME` to that runtime directory, loads `.env` defaults from the Vibe home, and sets `VIBE_ACTIVE_MODEL` when ProPR selects a model.

Implementation prompts are written to a temporary prompt file and passed through the Vibe prompt-file runner so the prompt does not need to appear directly in process arguments. Analysis runs can use read-only config mode and a shorter `VIBE_ANALYSIS_TIMEOUT_MS`.
