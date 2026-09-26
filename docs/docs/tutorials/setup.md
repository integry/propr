---
sidebar_position: 1
---

# Setup

ProPR runs from prebuilt Docker images, started by the ProPR CLI. The fastest path is the guided `propr setup` wizard — it scaffolds the runtime directory, verifies the host, configures GitHub access and issue intake, and starts the stack in one pass:

```bash
npm install -g propr-cli   # Node.js 22+
propr --version            # confirm the public CLI is on PATH
mkdir propr-deploy && cd propr-deploy
propr setup                # guided, re-runnable bootstrap
```

Keep the terminal interactive and complete GitHub and provider authorization yourself when setup pauses. When it finishes, verify the installation with `propr check` and `propr status`. `propr setup` is safe to re-run: it skips steps that are already satisfied and never overwrites existing configuration or data.

## System Requirements

**Linux x86_64 (`amd64`) is the native, recommended production path.** ProPR has also been exercised successfully on Apple Silicon macOS through Docker Desktop, which runs the published Linux `amd64` images under emulation. Native `arm64` images are not yet available.

| Area | Requirement |
| --- | --- |
| Host platform | Linux on `amd64` is native and recommended for production. On Apple Silicon macOS, the CLI and launcher work through Docker Desktop running the published Linux `amd64` agent and launcher images under emulation; native `arm64` images are not yet available. |
| Docker | A maintained Docker Engine release, with the CLI installed and the daemon reachable by the ProPR user. On Linux, that user must be able to run `docker info` and read/write `/var/run/docker.sock` without an interactive `sudo` prompt. On Apple Silicon, Docker Desktop must be running Linux containers and provide the default Docker socket to the CLI and launcher. Linux containers, user-defined bridge networks, bind mounts, named volumes, restart policies, `--init`, and container resource limits must be available. `propr check` verifies the CLI, daemon, socket, and image access before startup. |
| Node.js | Node.js 22+ and npm are required for the public CLI path. The `propr/launcher` container runs the same stack orchestrator without host Node.js. |
| Capacity | Reserve 2 vCPU, 4 GB RAM, and 20 GB of free disk for a single-task evaluation. Use 8 GB RAM or more for normal use, concurrent work, or large repositories, and allow extra disk for image updates, clones, worktrees, and logs. On a 4 GB host, start with `WORKER_CONCURRENCY=1`. The automatically selected agent CPU ceiling will not exceed detected host capacity. |
| Network and accounts | Outbound HTTPS and WebSocket access to Docker Hub, npm (for the CLI path), GitHub, the selected model providers, and ProPR Connect when using the shared App or managed tunnel. The default WebSocket intake path needs no inbound public port. The guided Connect default uses the GitHub CLI (`gh`) for browser login; alternatively authenticate first with `propr login <token>`. GitHub repository access and at least one coding-agent provider account are required. |

Docker Compose is required only for the [Source Development Setup](./setup-source.md). The prebuilt CLI and launcher paths talk directly to Docker Engine.

:::caution[Docker socket access]
Access to `/var/run/docker.sock` is root-equivalent control of the host. Limit it to trusted administrators and ProPR's trusted control-plane services, and protect the Web UI and API accordingly.
:::

## Which Page Should You Follow?

| Where you are running | Follow | Why |
| --- | --- | --- |
| Your Linux laptop or workstation | [Local Setup](./setup-local.md) | The shortest path: localhost URLs, no proxy, no public endpoint. |
| A shared or production Linux server | [Server Setup](./setup-server.md) | Adds stable paths, public URLs, TLS behind a reverse proxy, and the advanced intake options (polling, own-App webhook). |
| A brand-new Linux VPS | [Secure VPS Deployment](./setup-vps.md) | Start-to-finish host hardening plus the install: SSH lockdown, firewall, localhost port binding, TLS. [Advanced VPS Hardening](./setup-vps-hardening.md) optionally removes all public inbound traffic with a Cloudflare Tunnel and an SSO gate. |
| Apple Silicon Mac with Docker Desktop | [Local Setup](./setup-local.md) | Runs the published Linux `amd64` images under emulation for local evaluation; native `arm64` images are not yet available. |
| A source checkout, changing ProPR itself | [Source Development Setup](./setup-source.md) | Development Compose, direct service commands, tests, docs validation, and image builds. |

## Prerequisites For Every Path

- A host that meets the [system requirements](#system-requirements)
- Node.js 22+ for the CLI path (the `propr/launcher:latest` container alternative needs no Node.js)
- GitHub access for the backend. By default `propr setup` enrolls the shared, hosted ProPR GitHub App through ProPR Connect; accepting the defaults handles login through the GitHub CLI (`gh`) and installation when needed. You can instead run `propr login <token>` first. Running your own GitHub App is the advanced alternative. See [GitHub Authentication](../operations/github-auth.md).
- A provider account for at least one coding agent (Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe) — reuse host credentials, run `propr agent login <agent>`, or add the agent and log in directly from the Web UI
- Disk space for data, logs, and repository workspaces

## Give this to your coding agent

Use this block when you want a coding agent to bootstrap ProPR on a host you control. Keep its terminal interactive so you can authorize external services yourself.

```text
Install ProPR safely on this host.

Follow the public setup docs, starting with System Requirements:
https://docs.propr.dev/docs/tutorials/setup#system-requirements

Before making changes, identify the host OS and architecture. Report whether it
is the native, recommended Linux amd64 production path or Apple Silicon macOS
using Docker Desktop to emulate the published Linux amd64 images. Native arm64
images are not available.

Verify Node.js 22+ and npm; Docker Engine and CLI; a reachable daemon; `docker
info`; daemon/socket access for the current user; Git; the documented CPU, RAM,
disk, and outbound network requirements; and any existing installation. On
Apple Silicon, verify that Docker Desktop is running Linux containers and makes
its default Docker socket available to the CLI and launcher.

Ask me to choose an absolute location for the ProPR data folder, the directory
containing `.env`, `data/`, `logs/`, and `repos/`. If that location already
exists, inspect it before changing anything, preserve all existing contents,
and verify its contents and permissions. If an existing-folder or prerequisite
check fails, stop and report the non-sensitive failure. Never delete,
reinitialize, overwrite, or broadly clean up existing configuration, data,
logs, repositories, Docker volumes, ports, firewall rules, or TLS.

Install the public CLI with `npm install -g propr-cli` and verify it with
`propr --version`. If the chosen folder is already initialized, run `propr
check` there and stop on failure. Then change into it and run interactive `propr
setup` (`--no-tui` only when the terminal cannot use the full-screen wizard).

Pause for me to complete all GitHub browser/device authorization, GitHub App
installation and repository-scope choices, ProPR Connect or plan choices, and
coding-provider login. Never request credentials, tokens, private keys, cookies,
device codes, or one-time authorization codes in prompts, chat, or logs.

Setup may offer the bundled ProPR Operator Agent Skill when it detects Codex,
Claude Code, Antigravity, OpenCode, or Vibe. Installation is opt-in. Explain the
choice and wait for my approval. The manual commands are `propr skill install
<target>`, `propr skill status`, and `propr skill remove <target>`. Foreign or
modified copies are preserved and refused by default. An AI agent using the
skill must never recursively delegate ProPR-orchestration work back into ProPR.

Finish by running `propr check` and `propr status` from the chosen folder. If
either fails, stop and report the exact non-sensitive command, output, and likely
cause. Redact all secrets and authorization material.
```

After setup, GitHub is the primary orchestration surface: create issues and PRs, normally trigger work with `AI`, and optionally choose one existing stable short model label when an override is intentional. PR comments and `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix` drive follow-up work. The CLI is useful for installation, host lifecycle, and observability, but it is not required for ordinary orchestration.

For the details behind the prompt, see [Local Setup](./setup-local.md) or [Server Setup](./setup-server.md), [GitHub Authentication](../operations/github-auth.md), [ProPR Connect](../operations/propr-connect.md), [Production Deployment](../operations/deployment.md), [Hosted UI Tunnel](../operations/hosted-ui-tunnel.md), [Security Overview](../concepts/security-overview.md), and [Troubleshooting](../operations/troubleshooting.md).

## After Setup

Once ProPR is running, configure it through either control surface — the Web UI or the [ProPR CLI](../features/propr-cli.md):

1. Open the Web UI (or point the CLI at the API with `propr remote` + `propr login`).
2. Add repositories (Web UI, or `propr repo add owner/repo`).
3. Configure AI Agents and default models (Web UI, or `propr agent add`).
4. Review labels and PR behavior.
5. Run a small test issue or Planner Studio draft (or `propr plan create "..." --wait`).

For day-to-day use, see [Daily Use](./usage.md). Before exposing ProPR beyond your own machine, harden the host and deployment: see [Secure VPS Deployment](./setup-vps.md) and [Advanced VPS Hardening](./setup-vps-hardening.md).
