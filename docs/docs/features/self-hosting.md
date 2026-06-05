---
sidebar_position: 8
---

# Self-Hosted Operation

ProPR is meant to run under your control, using your repositories and your agent credentials. Most installs should use the published Docker images. Source checkout is mainly for teams modifying ProPR itself.

## Published Images

The normal setup path uses prebuilt images started by the launcher:

- ProPR API, daemon, worker, and UI containers
- Redis for queues and transient state
- Agent execution images
- Persistent host directories for data, logs, repositories, and credentials

This works for both local workstation setup and remote server deployment.

See [Setup](../tutorials/setup.md) for the local image-based flow.

## Own Credentials

You supply the GitHub App credentials and agent credentials. ProPR does not require a hosted ProPR account for the core self-hosted workflow.

Typical host credential directories:

- Claude: `~/.claude`
- Codex: `~/.codex`
- Antigravity: `~/.antigravity`

The launcher mounts those directories into the relevant containers when you pass the matching `HOST_*` environment variables.

## Local Or Server

Local setup is useful for trying ProPR, testing configuration, or running it for a personal workspace. Server setup uses the same images but usually adds:

- A stable runtime directory such as `/srv/propr`
- A public domain
- TLS at a reverse proxy or ingress
- Longer-lived persistent storage
- More careful credential and Docker socket access controls

## Source Development

Run from source when you want to:

- Change ProPR code
- Build local images
- Run tests
- Validate the documentation site
- Develop new agent integrations

For that path, install Node.js 20+, use `npm ci`, and run the development Compose stack or direct service commands as needed.
