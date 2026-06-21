---
sidebar_position: 1
---

# Setup

Most people should run ProPR from the prebuilt Docker images, started either by the ProPR CLI (`propr init stack` + `propr start`, recommended; Node.js 22+) or by the `propr/launcher:latest` container (no Node.js needed). You only need source setup if you are changing ProPR itself.

## Prerequisites For Every Path

- GitHub backend access: by default the shared, hosted ProPR GitHub App via the token relay (`propr relay enroll`) — no GitHub App of your own and no private key to manage. As an advanced option you can register your own GitHub App on the target repositories (permissions: Contents (Read and write), Metadata (Read-only), Issues (Read and write), Pull Requests (Read and write), optionally Actions (Read-only)). See [GitHub Authentication](../operations/github-auth.md)
- Credentials for at least one coding agent (Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe), authenticated on the host before starting ProPR
- Docker with access to the Docker socket
- Disk space for data, logs, and repository workspaces

The launcher path requires a Linux host because it bind-mounts host paths and the Docker socket directly. On macOS or Windows (Docker Desktop), use the Compose-based [Source Development Setup](./setup-source.md) instead.

Choose the path that matches what you are doing:

## Local Setup

Use this when you want to run ProPR on your Linux laptop or workstation.

[Local Setup](./setup-local.md)

You will install the CLI, scaffold a runtime directory with `propr init stack`, configure GitHub access, and start the stack with `propr start` (the launcher container remains as a no-Node.js alternative). The Web UI is at `http://localhost:5173`, the API on port `4000`. Issue intake uses the hosted ProPR GitHub App over WebSocket routing by default — no inbound public URL required.

## Server Setup

Use this when ProPR should run on a shared machine or production host.

[Server Setup](./setup-server.md)

The flow is the same as local setup, but you use stable server paths, public URLs, TLS through a reverse proxy, and stricter credential access. Server setup also covers the advanced intake options — polling, or your own GitHub App webhook — for installs that need them.

## Secure VPS Deployment

Use this when you are starting from a brand-new Linux VPS and want the host hardened as well as ProPR installed.

[Secure VPS Deployment](./setup-vps.md)

A start-to-finish walkthrough: admin user and SSH lockdown, automatic security updates, host firewall (including the Docker/UFW caveat), Docker and the CLI, binding service ports to localhost, TLS via nginx and Certbot, and the GitHub user whitelist.

For an optional layer that removes all public inbound traffic with a Cloudflare Tunnel and an SSO identity gate, continue with [Advanced VPS Hardening](./setup-vps-hardening.md).

## Source Development Setup

Use this only when you are changing ProPR code, validating docs, running tests, or building images.

[Source Development Setup](./setup-source.md)

This path uses Node.js 20+, a source checkout, and development Compose or direct service commands.

## After Setup

Once ProPR is running, configure it through either control surface — the Web UI or the [ProPR CLI](../features/propr-cli.md):

1. Open the Web UI (or run `npm install -g propr-cli` and point it at the API with `propr remote` + `propr login`).
2. Add repositories (Web UI, or `propr repo add owner/repo`).
3. Configure AI Agents and default models (Web UI, or `propr agent add`).
4. Review labels and PR behavior.
5. Run a small test issue or Planner Studio draft (or `propr plan create "..." --wait`).

For day-to-day use, see [Daily Use](./usage.md).
