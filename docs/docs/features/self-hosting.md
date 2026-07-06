---
sidebar_position: 8
---

# Self-Hosted Operation

ProPR is meant to run under your control, using your repositories and your agent credentials. Most installs should use the published Docker images. Source checkout is mainly for teams modifying ProPR itself.

## What Stays On Your Infrastructure

Everything that touches your code runs where you deployed it:

- Repository clones and per-task worktrees
- Agent execution containers and their prompts, logs, and generated patches
- The SQLite application database and Redis queue state
- GitHub App credentials and agent credentials

You supply the GitHub App credentials and agent credentials. ProPR does not require a hosted ProPR account for the core self-hosted workflow. The supported agents, their Docker images, and the `HOST_*` credential-mount variables are documented in [Agents and Models](./agents-and-models.md#supported-agents).

## How A Deployment Looks

The recommended setup is the published image set, orchestrated either by the ProPR CLI control plane or by one `docker run` of the launcher container. Both pull a pinned image set and start the service containers — Redis, daemon, worker, analysis and indexing workers, API, and Web UI — as siblings on the host Docker daemon, with your `.env`, data, logs, and repos directories mounted in. The image list and orchestration details live in [Production Deployment](../operations/deployment.md#published-images).

Local directory layout next to your `.env`: the GitHub App `<key>.pem` (own-App mode only), plus `data/` (SQLite database), `logs/`, and `repos/` (clones and worktrees). This works for both local workstation setup and remote server deployment. See [Setup](../tutorials/setup.md) for the full flow, including the required GitHub App permissions (Contents R/W, Issues R/W, Pull Requests R/W, Metadata R, Actions R optional).

## Local Or Server

Local setup is useful for trying ProPR, testing configuration, or running it for a personal workspace. Server setup uses the same images but usually adds:

- A stable runtime directory such as `/srv/propr`
- A public domain
- TLS at a reverse proxy or ingress
- Longer-lived persistent storage
- More careful credential and Docker socket access controls

See [Server Setup](../tutorials/setup-server.md) for the walkthrough and [Production Deployment](../operations/deployment.md) for the reference. By default ProPR receives GitHub events over a routing WebSocket from the hosted ProPR App at propr.dev — no inbound public endpoint required. Polling and running your own GitHub App with a direct webhook remain available as advanced intake options selected by `GITHUB_EVENT_INTAKE_MODE`.

The hosted bridge for the shared ProPR GitHub App, relay tokens, routing
WebSocket, and optional hosted UI tunnel is documented in
[ProPR Connect](../operations/propr-connect.md).

## Source Development

Run from source when you want to:

- Change ProPR code
- Build local images
- Run tests
- Validate the documentation site
- Develop new agent integrations

For that path, install Node.js 20+, run `npm ci`, and use the development Compose stack or direct service commands — see [CLI Workflows](./cli-workflows.md) and [Source Setup](../tutorials/setup-source.md).
