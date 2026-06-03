---
sidebar_position: 6
---

# Claude Code Runtime Reference

This reference covers Claude Code runtime configuration, Docker isolation, debugging, and common failures. For the integration overview, see [Claude Code Integration](./claude-integration.md).

## Docker Isolation

Claude Code runs inside a Docker-backed environment so ProPR can control runtime dependencies, workspace mounts, credentials, and resource limits.

The Claude Code image includes:

- Node.js runtime
- Claude Code CLI
- Git and repository tooling
- Entrypoint scripts used by the worker
- Security and filesystem defaults

## Container Configuration

The worker launches a container with:

- The task worktree mounted as the workspace
- Claude Code configuration mounted from the host credential directory
- Environment variables for model and runtime settings
- Resource limits where configured
- Structured output capture

Credential mounts should be restricted to the paths required by the CLI.

## Configuration

Common settings:

```bash
# Claude Code Configuration
CLAUDE_DOCKER_IMAGE=propr/agent-claude:latest
CLAUDE_CONFIG_PATH=~/.claude
CLAUDE_MAX_TURNS=1000
CLAUDE_TIMEOUT_MS=300000
```

Image-based installs should use the published agent image unless you are building and testing changes locally.

## Timeouts And Max Turns

Timeouts prevent runaway jobs and make failures visible in task state. Max-turn limits protect against agent loops.

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

Check that Claude Code is authenticated on the host and that the expected config directory is mounted into the runtime container.

### Docker Permission Issues

Check that the deployment user can access Docker and that the launcher or worker can start sibling containers.

### Network Issues

If the runtime is network-restricted, confirm the configured policy still allows the provider access required by the CLI.

### Timeout Issues

Increase timeouts only after checking logs. A timeout may indicate a task that should be split, missing context, provider slowness, or a model loop.
