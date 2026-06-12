---
sidebar_position: 1
---

# Setup

Most people should run ProPR from the prebuilt Docker images via `propr/launcher:latest`. You only need source setup if you are changing ProPR itself.

## Prerequisites For Every Path

- A GitHub App installed on the repositories ProPR should access, with these permissions: Contents (Read and write), Metadata (Read-only), Issues (Read and write), Pull Requests (Read and write), and optionally Actions (Read-only)
- Credentials for at least one coding agent (Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe), authenticated on the host before starting ProPR
- Docker with access to the Docker socket
- Disk space for data, logs, and repository workspaces

The launcher path requires a Linux host because it bind-mounts host paths and the Docker socket directly. On macOS or Windows (Docker Desktop), use the Compose-based [Source Development Setup](./setup-source.md) instead.

Choose the path that matches what you are doing:

## Local Setup

Use this when you want to run ProPR on your Linux laptop or workstation.

[Local Setup](./setup-local.md)

You will create a local runtime directory, add GitHub App credentials, mount your agent credentials, start `propr/launcher:latest`, and open the Web UI at `http://localhost:5173`. The API listens on port `4000`. Issue intake uses polling by default.

## Server Setup

Use this when ProPR should run on a shared machine or production host.

[Server Setup](./setup-server.md)

The flow is the same as local setup, but you use stable server paths, public URLs, TLS through a reverse proxy, and stricter credential access. Server setup also covers GitHub webhook intake as an alternative to polling.

## Source Development Setup

Use this only when you are changing ProPR code, validating docs, running tests, or building images.

[Source Development Setup](./setup-source.md)

This path uses Node.js 20+, a source checkout, and development Compose or direct service commands.

## After Setup

Once ProPR is running, configure it through either control surface — the Web UI or the [ProPR CLI](../features/propr-cli.md):

1. Open the Web UI (or run `npm install -g @propr/cli` and point it at the API with `propr remote` + `propr login`).
2. Add repositories (Web UI, or `propr repo add owner/repo`).
3. Configure AI Agents and default models (Web UI, or `propr agent add`).
4. Review labels and PR behavior.
5. Run a small test issue or Planner Studio draft (or `propr plan create "..." --wait`).

For day-to-day use, see [Daily Use](./usage.md).
