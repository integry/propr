---
sidebar_position: 5
---

# Claude Code Integration

This page is kept for compatibility with existing links to `/docs/architecture/claude-integration`.

The architecture overview for all coding agents now lives at [Coding Agent Integration](./coding-agent-integration.md). Start there for the shared contract used by Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe.

For Claude-specific runtime settings, Docker details, CLI flags, errors, and debugging, see [Agent Runtime Reference: Claude Code](./agent-runtime.md#claude-code).

## What Moved

Claude Code is one implementation of ProPR's generic coding-agent architecture. The shared flow is:

- ProPR routes a job to an enabled agent and model.
- The worker prepares a branch and isolated worktree.
- The selected agent runs in its Docker image with the required credential mount.
- The agent edits files inside the workspace.
- The worker parses the result, commits changes, pushes, creates or updates a pull request, and records state.

The Claude-specific pieces are still `Dockerfile.claude`, `scripts/claude-entrypoint.sh`, the host `HOST_CLAUDE_DIR` credential mount, and the Claude model IDs configured for your deployment.

## Related Pages

- [Coding Agent Integration](./coding-agent-integration.md)
- [Agent Routing](../features/agent-routing.md)
- [Isolated And Safe Execution](../features/execution-safety.md)
- [Worker Architecture](./worker.md)
- [Agent Runtime Reference: Claude Code](./agent-runtime.md#claude-code)
- [OpenCode Integration](./opencode-integration.md)
