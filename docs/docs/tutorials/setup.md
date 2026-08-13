---
sidebar_position: 1
---

# Setup

ProPR runs from prebuilt Docker images, started by the ProPR CLI. The fastest path is the guided `propr setup` wizard — it scaffolds the runtime directory, verifies the host, configures GitHub access and issue intake, and starts the stack in one pass:

```bash
npm install -g propr-cli   # Node.js 22 or 24
mkdir propr-deploy && cd propr-deploy
propr setup                # guided, re-runnable bootstrap
```

`propr setup` is safe to re-run: it skips steps that are already satisfied and never overwrites existing configuration or data.

## System Requirements

The published prebuilt stack is release-qualified on **Linux x86_64 (`amd64`)**. The v0.8.10 end-to-end release run used Ubuntu 26.04, Docker Engine 29.1.3, 2 vCPU, 4 GB RAM, and a 40 GB provisioned disk (38 GiB usable). Those values record the tested baseline; Docker 29 and a 40 GB disk are not enforced minimums.

| Area | Requirement |
| --- | --- |
| Host platform | Linux on `amd64` for the CLI and launcher paths. The current agent and launcher images are published for `linux/amd64`. The Docker Desktop source path is documented for macOS and Windows, but it is outside the current release qualification. |
| Docker | A maintained Docker Engine release, with the CLI installed and the daemon reachable by the ProPR user. That user must be able to run `docker info` and read/write `/var/run/docker.sock` without an interactive `sudo` prompt. Linux containers, user-defined bridge networks, bind mounts, named volumes, restart policies, `--init`, and container resource limits must be available. `propr check` verifies the CLI, daemon, socket, and image access before startup. |
| Node.js | Node.js 22 or 24 and npm are the validated public CLI paths; the published `propr-cli` package keeps its engine minimum at Node.js `>=22`. The `propr/launcher` container runs the same stack orchestrator without host Node.js. |
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
| macOS or Windows (Docker Desktop) | [Source Development Setup](./setup-source.md) | The documented evaluation path on these platforms. The CLI and launcher need a Linux host because they bind-mount host paths and the Docker socket directly; this Compose-based path is outside the current release qualification. |
| A source checkout, changing ProPR itself | [Source Development Setup](./setup-source.md) | Development Compose, direct service commands, tests, docs validation, and image builds. |

## Prerequisites For Every Path

- A host that meets the [system requirements](#system-requirements)
- Node.js 22 or 24 for the CLI path (the `propr/launcher:latest` container alternative needs no Node.js)
- GitHub access for the backend. By default `propr setup` enrolls the shared, hosted ProPR GitHub App through ProPR Connect; accepting the defaults handles login through the GitHub CLI (`gh`) and installation when needed. You can instead run `propr login <token>` first. Running your own GitHub App is the advanced alternative. See [GitHub Authentication](../operations/github-auth.md).
- A provider account for at least one coding agent (Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe) — reuse host credentials, run `propr agent login <agent>`, or add the agent and log in directly from the Web UI
- Disk space for data, logs, and repository workspaces

## Give This To Your Coding Agent

Use this block when you want a coding agent to bootstrap ProPR on a host you control. Fill in the placeholders first, and keep the terminal interactive so you can authorize external services yourself.

```text
Install ProPR safely on this host.

Placeholders:
- Stack root: <STACK_ROOT, absolute path only, for example /srv/propr or
  $HOME/propr-deploy resolved before running commands>
- GitHub account/repository to connect: <GITHUB_ACCOUNT_OR_OWNER/REPO>
- Selected coding agent: <claude|codex|antigravity|opencode|vibe>
- ProPR Connect/shared GitHub App: <yes|no>
- Managed app.propr.dev tunnel: <yes|no, only if my plan includes it and my account is entitled>

Follow the public ProPR docs, starting with System Requirements:
https://docs.propr.dev/docs/tutorials/setup#system-requirements

Before installing, verify and report: Linux amd64, CPU/RAM/disk capacity,
outbound HTTPS/WebSocket access to Docker Hub/npm/GitHub/selected provider
and ProPR Connect if selected, Docker Engine + CLI, direct read/write access
to /var/run/docker.sock without interactive sudo, Node.js 22 or 24, npm, Git,
and authenticated GitHub CLI access (`gh auth status`). Resolve <STACK_ROOT>
to an absolute path before using it in quoted command arguments.

Install the current public CLI with `npm install -g propr-cli`, then run
`propr --version`. If this is an existing stack root, run
`propr check --root "<STACK_ROOT>"` first and report failures. On a fresh root,
continue to the guided setup after host prerequisites pass.

Run `propr setup --root "<STACK_ROOT>"` in an interactive terminal. Use
`--no-tui` only for SSH or limited terminals that cannot run the full-screen
wizard. Accept only choices I have authorized.

Pause and ask me to complete any GitHub device/browser authorization, GitHub
App installation or repository-scope decision, ProPR Connect/plan choice, or
coding-agent provider login. Do not ask me to paste credentials, tokens, private
keys, cookies, or one-time codes into chat or logs.

Preserve existing host data. Do not delete, reinitialize, or overwrite an
existing stack, .env, Docker volume, repository checkout, logs, or data
directory. Do not change explicit port bindings, publish fresh direct UI/API
ports publicly, install an unrequested GitHub App scope, or weaken firewall/TLS
settings. Fresh direct ports should remain loopback-only.

Verify with:
- `propr check --root "<STACK_ROOT>"`
- `propr status --root "<STACK_ROOT>"`
- loopback UI/API access, normally http://127.0.0.1:5173 and
  http://127.0.0.1:4000/api/status
- before backend-client checks, preserve the current CLI remote configuration
  (`propr config list`), switch to a temporary verification profile, point it at
  this stack's discovered API URL (normally `propr config profile use
  setup-verify` then `propr remote http://127.0.0.1:4000`), and run
  `propr login` interactively if the profile is not already authenticated
- configured repository visibility against that temporary profile with
  `propr repo list` and `propr repo status`
- configured agent visibility against that temporary profile with
  `propr agent list`
- restore the previous active CLI remote profile/configuration after these
  backend-client checks
- `propr tunnel verify` only when the managed app.propr.dev tunnel was selected,
  entitled, configured, and enabled

If anything fails, report the exact non-sensitive command, output, and likely
cause, then stop. Redact all credentials, tokens, one-time codes, cookies,
private-key material, and sensitive URLs from commands and output while
preserving the useful diagnostic text. Do not apply destructive recovery or
broad cleanup without my explicit approval.
```

For the details behind the prompt, see [Local Setup](./setup-local.md) or [Server Setup](./setup-server.md), [GitHub Authentication](../operations/github-auth.md), [ProPR Connect](../operations/propr-connect.md), [Production Deployment](../operations/deployment.md), [Hosted UI Tunnel](../operations/hosted-ui-tunnel.md), [Security Overview](../concepts/security-overview.md), and [Troubleshooting](../operations/troubleshooting.md).

## After Setup

Once ProPR is running, configure it through either control surface — the Web UI or the [ProPR CLI](../features/propr-cli.md):

1. Open the Web UI (or point the CLI at the API with `propr remote` + `propr login`).
2. Add repositories (Web UI, or `propr repo add owner/repo`).
3. Configure AI Agents and default models (Web UI, or `propr agent add`).
4. Review labels and PR behavior.
5. Run a small test issue or Planner Studio draft (or `propr plan create "..." --wait`).

For day-to-day use, see [Daily Use](./usage.md). Before exposing ProPR beyond your own machine, harden the host and deployment: see [Secure VPS Deployment](./setup-vps.md) and [Advanced VPS Hardening](./setup-vps-hardening.md).
