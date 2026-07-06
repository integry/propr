---
sidebar_position: 1
---

# Setup

ProPR runs from prebuilt Docker images, started by the ProPR CLI. The fastest path is the guided `propr setup` wizard — it scaffolds the runtime directory, verifies the host, configures GitHub access and issue intake, and starts the stack in one pass:

```bash
npm install -g propr-cli   # Node.js 22+
mkdir propr-deploy && cd propr-deploy
propr setup                # guided, re-runnable bootstrap
```

`propr setup` is safe to re-run: it skips steps that are already satisfied and never overwrites existing configuration or data.

## Which Page Should You Follow?

| Where you are running | Follow | Why |
| --- | --- | --- |
| Your Linux laptop or workstation | [Local Setup](./setup-local.md) | The shortest path: localhost URLs, no proxy, no public endpoint. |
| A shared or production Linux server | [Server Setup](./setup-server.md) | Adds stable paths, public URLs, TLS behind a reverse proxy, and the advanced intake options (polling, own-App webhook). |
| A brand-new Linux VPS | [Secure VPS Deployment](./setup-vps.md) | Start-to-finish host hardening plus the install: SSH lockdown, firewall, localhost port binding, TLS. [Advanced VPS Hardening](./setup-vps-hardening.md) optionally removes all public inbound traffic with a Cloudflare Tunnel and an SSO gate. |
| macOS or Windows (Docker Desktop) | [Source Development Setup](./setup-source.md) | The supported path on these platforms. The CLI and launcher need a Linux host because they bind-mount host paths and the Docker socket directly; the Compose-based source setup works under Docker Desktop. |
| A source checkout, changing ProPR itself | [Source Development Setup](./setup-source.md) | Development Compose, direct service commands, tests, docs validation, and image builds. |

## Prerequisites For Every Path

- A host with Docker and access to the Docker socket (Linux for the CLI and launcher paths; see the table above for macOS/Windows)
- Node.js 22+ for the CLI path (the `propr/launcher:latest` container alternative needs no Node.js)
- GitHub access for the backend. By default ProPR uses the shared, hosted ProPR GitHub App through the token relay — `propr setup` enrolls you when you pick **Token relay**, and running your own GitHub App is the advanced alternative. See [GitHub Authentication](../operations/github-auth.md).
- Credentials for at least one coding agent (Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe) — authenticate on the host before starting ProPR, or afterwards through the agent image with `propr agent login <agent>`
- Disk space for data, logs, and repository workspaces

## After Setup

Once ProPR is running, configure it through either control surface — the Web UI or the [ProPR CLI](../features/propr-cli.md):

1. Open the Web UI (or point the CLI at the API with `propr remote` + `propr login`).
2. Add repositories (Web UI, or `propr repo add owner/repo`).
3. Configure AI Agents and default models (Web UI, or `propr agent add`).
4. Review labels and PR behavior.
5. Run a small test issue or Planner Studio draft (or `propr plan create "..." --wait`).

For day-to-day use, see [Daily Use](./usage.md). Before exposing ProPR beyond your own machine, harden the host and deployment: see [Secure VPS Deployment](./setup-vps.md) and [Advanced VPS Hardening](./setup-vps-hardening.md).
