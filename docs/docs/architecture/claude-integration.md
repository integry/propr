---
sidebar_position: 5
---

# Claude Code Integration

The Claude Code integration runs Anthropic's Claude Code CLI inside ProPR's worker flow. It is one agent implementation within the broader agent-routing system. The same runtime pattern — a Docker image built on `propr/agent-base`, an entrypoint script, and a host credential mount — also covers Codex (`Dockerfile.codex`, `HOST_CODEX_DIR`), Antigravity (`Dockerfile.antigravity`, `HOST_ANTIGRAVITY_DIR`), OpenCode (`Dockerfile.opencode`, `HOST_OPENCODE_*` directories), and Mistral Vibe (`Dockerfile.vibe`, `HOST_VIBE_DIR`).

This page covers the integration shape. Runtime settings, Docker details, errors, and debugging live in [Claude Code Runtime Reference](./claude-code-runtime.md).

## Overview

ProPR uses Claude Code to:

- Analyze GitHub issues and PR comments
- Search and understand codebases
- Implement requested changes
- Produce file modifications inside the prepared workspace

ProPR still owns git and GitHub finalization. Claude Code edits files; the worker commits, pushes, creates pull requests, and updates task state.

## Architecture

<div className="propr-flow" aria-label="Claude Code integration architecture">
  <div className="propr-flow__row">
    <div className="propr-flow__node">
      <span className="propr-flow__title">Worker</span>
      <span className="propr-flow__detail">Builds prompt and repository context</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Claude Code CLI</span>
      <span className="propr-flow__detail">Runs the selected Claude model</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Docker Container</span>
      <span className="propr-flow__detail">Runs Claude Code in an isolated workspace</span>
    </div>
  </div>
</div>

The agent image is built from `Dockerfile.claude` on the shared `propr/agent-base` image, and the container is started through `scripts/claude-entrypoint.sh`. Codex, Antigravity, OpenCode, and Mistral Vibe follow the same structure with their own Dockerfiles and entrypoints.

## Authentication

Claude Code expects a host login state, usually under `~/.claude`. For image-based installs, the launcher mounts that directory into the relevant containers when `HOST_CLAUDE_DIR` is set.

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

This prepares the host Claude Code configuration used by ProPR's default Claude Code setup. The other agents use the same approach with their own host directories: `HOST_CODEX_DIR` (`~/.codex`), `HOST_ANTIGRAVITY_DIR` (`~/.gemini`, auth via `agy login`), the `HOST_OPENCODE_*` directories, and `HOST_VIBE_DIR` (`~/.vibe`).

## Prompt Shape

The worker prepares a prompt that keeps Claude Code focused on implementation:

- Issue, plan, or PR follow-up instructions
- Relevant comments and review feedback
- Repository and branch context
- Constraints around scope and expected behavior
- Direction to modify files rather than perform git operations

The exact prompt can vary by job type, but the boundary is stable: Claude Code implements; ProPR finalizes.

## Model Selection

Claude models are listed through ProPR's shared agent and model configuration (`packages/shared/src/modelDefinitions.ts`). The active list is managed in code and shown in AI Agents in the Web UI.

Labels and slash commands use the configured model IDs, for example:

```text
llm-claude-fable
llm-claude-sonnet46
llm-claude-opus46
```

Check AI Agents in your deployment for the exact model IDs available.

## Output Handling

The integration captures:

- Standard output
- Standard error
- Exit code
- Duration
- Parsed implementation summary where available

The worker then inspects the workspace for file changes and proceeds through normal finalization.

## Related Pages

- [Agent Routing](../features/agent-routing.md)
- [Isolated And Safe Execution](../features/execution-safety.md)
- [Worker Architecture](./worker.md)
- [Claude Code Runtime Reference](./claude-code-runtime.md)
- [OpenCode Integration](./opencode-integration.md)
