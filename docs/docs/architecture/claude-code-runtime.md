---
sidebar_position: 6
---

# Claude Code Runtime Reference

This reference covers Claude Code runtime configuration, Docker isolation, debugging, and common failures. For the shared integration overview, see [Coding Agent Integration](./coding-agent-integration.md).

## Docker Isolation

Claude Code runs inside a Docker container so ProPR can control runtime dependencies, workspace mounts, credentials, and resource limits.

The Claude Code image (`Dockerfile.claude`) builds on the shared `propr/agent-base` image (`node:20-alpine`), which ships:

- Node.js runtime
- Git and repository tooling
- `scripts/init-firewall.sh` (optional network hardening, see below)
- A `gh` wrapper for scoped GitHub CLI access
- Entrypoint scripts used by the worker

## Container Configuration

The worker launches each container with:

- The task worktree mounted at `/home/node/workspace`
- Claude Code configuration mounted at `/home/node/.claude` from the host credential directory
- Environment variables for model and runtime settings
- `--security-opt no-new-privileges`, `--cap-add CHOWN`, and the default `--network bridge`
- Structured output capture

Inside the container, the entrypoint invokes the CLI as:

```bash
claude -p - [--model <id>] --max-turns N --output-format stream-json --verbose --dangerously-skip-permissions
```

The prompt is passed on stdin, and `--max-turns` comes from `CLAUDE_MAX_TURNS`. Credential mounts should be restricted to the paths required by the CLI.

## Configuration

Common settings:

```bash
# Claude Code Configuration
CLAUDE_DOCKER_IMAGE=propr/agent-claude:latest
CLAUDE_CONFIG_PATH=/home/your-user/.claude
CLAUDE_MAX_TURNS=1000
CLAUDE_TIMEOUT_MS=300000
```

`CLAUDE_CONFIG_PATH` must be an absolute path; `~` and `$HOME` are not expanded. Image-based installs should use the published agent image unless you are building and testing changes locally.

## Timeouts And Max Turns

Timeouts (`CLAUDE_TIMEOUT_MS`, default `300000`) prevent runaway jobs and make failures visible in task state. The max-turn limit (`CLAUDE_MAX_TURNS`, code default `1000`) protects against agent loops.

When tuning these values, consider:

- Repository size
- Expected task complexity
- Provider rate limits
- Worker concurrency
- Host CPU and memory

## Security Considerations

The runtime should preserve these boundaries:

- Keep git finalization outside the agent.
- Mount only the workspace and required credential directories.
- Avoid broad host filesystem mounts.
- Keep credential directories scoped to the deployment user.
- Monitor container resource usage.

### Network Egress

The agent images ship `scripts/init-firewall.sh`, an egress-restriction script. All agent entrypoints (Claude, Codex, Antigravity, Vibe, OpenCode) currently **skip** it because applying the rules would require running the container with the `--privileged` Docker flag. Containers run on the default bridge network with `--security-opt no-new-privileges` and `--cap-add CHOWN`, so **outbound network access is unrestricted by default**. Treat the firewall script as available hardening for deployments that can run privileged containers, not as an active control.

## Monitoring And Debugging

Useful signals:

- Task logs in the Web UI
- Worker logs with correlation IDs
- Container exit code
- Agent stdout and stderr
- Duration and timeout state

For direct Docker inspection:

```bash
docker ps
docker logs <container>
docker inspect <container>
```

## Common Issues

### Authentication Issues

Check that Claude Code is authenticated on the host and that the expected config directory is mounted into the runtime container (host `HOST_CLAUDE_DIR` → container `/home/node/.claude`).

### Docker Permission Issues

Check that the deployment user can access Docker and that the launcher or worker can start sibling containers.

### Network Issues

Egress is unrestricted by default (the shipped firewall script is skipped by every entrypoint because it requires `--privileged`). Provider connectivity failures therefore usually come from the host network, DNS, or an external proxy/firewall — not from a ProPR-applied policy. If you have enabled the firewall script in a privileged deployment, confirm its allowlist covers the provider endpoints the CLI needs.

### Timeout Issues

Increase timeouts only after checking logs. A timeout may indicate a task that should be split, missing context, provider slowness, or a model loop.
