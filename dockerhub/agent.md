# ProPR Agent

Unified execution image for all coding agents supported by ProPR: Claude Code,
Codex, Antigravity, OpenCode, and Mistral Vibe.

```bash
docker pull propr/agent:latest
```

ProPR selects the CLI at runtime with `PROPR_AGENT_TYPE` and mounts that
agent's credentials and task worktree. Version-specific bundle tags contain a
complete CLI version matrix, so every agent instance can switch to the same
image without another pull.

The common Debian runtime is an internal Dockerfile stage, not a separately
published image. Custom installation-level packages create one derivative of
the selected bundle. The base includes `build-essential` for native extension
builds, so it is intentionally larger than the previous Alpine-based images.

The published agent image is currently `linux/amd64`. It runs on Apple Silicon
Docker Desktop through amd64 emulation.

Source: https://github.com/integry/propr
