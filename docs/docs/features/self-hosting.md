---
sidebar_position: 8
---

# Self-Hosted Operation

ProPR is meant to run under your control, using your repositories and your agent credentials. Most installs should use the published Docker images. Source checkout is mainly for teams modifying ProPR itself.

## Published Images

Images are published to Docker Hub under the `propr/` namespace and to GHCR under `ghcr.io/proprdev/` (GHCR uses a flat namespace, for example `ghcr.io/proprdev/propr-app`):

| Image | Purpose |
|---|---|
| `propr/launcher` | Single-command launcher that pulls and runs the whole stack |
| `propr/app` | API, daemon, worker, analysis worker, and indexing worker (one image, different commands) |
| `propr/ui` | Web UI |
| `propr/docs` | This documentation site (optional) |
| `propr/agent-base` | Shared base for agent images |
| `propr/agent-claude` | Claude Code agent runtime |
| `propr/agent-codex` | Codex agent runtime |
| `propr/agent-antigravity` | Antigravity agent runtime |
| `propr/agent-opencode` | OpenCode agent runtime |
| `propr/agent-vibe` | Mistral Vibe agent runtime |

Redis runs from the upstream `redis:7-alpine` image.

## Launcher Flow

The recommended setup is one `docker run` of `propr/launcher`. The launcher mounts your `.env`, the GitHub App private key, the Docker socket, and your data/logs/repos directories, then pulls the pinned image set and starts sibling containers on the host Docker daemon:

- `propr-redis` (queue and transient state)
- `propr-daemon` (issue and comment intake)
- `propr-worker` (task execution)
- `propr-analysis-worker` and `propr-indexing-worker`
- `propr-api` (dashboard API, webhook receiver)
- `propr-ui` (Web UI), and optionally `propr-docs`

Local directory layout next to your `.env`: the GitHub App `<key>.pem`, plus `data/` (SQLite database), `logs/`, and `repos/` (clones and worktrees). This works for both local workstation setup and remote server deployment.

See [Setup](../tutorials/setup.md) for the full flow, including the required GitHub App permissions (Contents R/W, Issues R/W, Pull Requests R/W, Metadata R, Actions R optional).

## Own Credentials

You supply the GitHub App credentials and agent credentials. ProPR does not require a hosted ProPR account for the core self-hosted workflow.

The launcher mounts host credential directories into the worker and API containers (and from there into spawned agent containers) when you set the matching `HOST_*` variables. All values must be absolute paths:

| Agent | Variable | Typical host path |
|---|---|---|
| Claude Code | `HOST_CLAUDE_DIR` | `~/.claude` |
| Codex | `HOST_CODEX_DIR` | `~/.codex` |
| Antigravity | `HOST_ANTIGRAVITY_DIR` | `~/.gemini` |
| OpenCode | `HOST_OPENCODE_XDG_DIR` | `~/.config/opencode` |
| OpenCode (login data) | `HOST_OPENCODE_DATA_DIR` | `~/.local/share/opencode` |
| Mistral Vibe | `HOST_VIBE_DIR` | `~/.vibe` |

Omit a variable to skip mounts for that agent. Notes:

- For Antigravity, install the CLI, run `agy login` on the host, and pass `HOST_ANTIGRAVITY_DIR` pointing at `~/.gemini` (Antigravity stores its login state there).
- For OpenCode, also set `HOST_OPENCODE_DATA_DIR` so credentials from `opencode auth login` are visible to spawned agent containers.
- For Vibe with the launcher, also set `VIBE_PROMPT_CACHE_DIR` and `HOST_VIBE_PROMPT_CACHE_DIR` (both pointing at the same host path, for example `/tmp/propr-vibe-prompts`) so prompt files can be bind-mounted into agent containers. Vibe can also authenticate via `MISTRAL_API_KEY` instead of a mounted `~/.vibe`.

## Local Or Server

Local setup is useful for trying ProPR, testing configuration, or running it for a personal workspace. Server setup uses the same images but usually adds:

- A stable runtime directory such as `/srv/propr`
- A public domain
- TLS at a reverse proxy or ingress
- Longer-lived persistent storage
- More careful credential and Docker socket access controls

See [Server Setup](../tutorials/setup-server.md). For webhook intake without exposing a public endpoint, ProPR also works with polling (default), or with the optional hosted GitHub App at propr.dev that routes webhooks to your install.

## Source Development

Run from source when you want to:

- Change ProPR code
- Build local images
- Run tests
- Validate the documentation site
- Develop new agent integrations

For that path, install Node.js 20+, run `npm ci`, and use the development Compose stack or direct service commands — see [CLI Workflows](./cli-workflows.md) and [Source Setup](../tutorials/setup-source.md).
