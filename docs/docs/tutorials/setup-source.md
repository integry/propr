---
sidebar_position: 6
---

# Source Development Setup

This path runs ProPR from a source checkout with Docker Compose. It serves two audiences:

- **Contributors** changing ProPR code, running tests, validating docs, or building images.
- **macOS and Windows evaluators** sent here by the [setup chooser](./setup.md): the CLI and launcher paths need a Linux host because they bind-mount host paths and the Docker socket directly, so under Docker Desktop this Compose-based stack is the supported way to run ProPR.

## Prerequisites

- Node.js 22+
- Git 2.25+
- Docker (Docker Desktop works here)
- Redis, only if running services directly outside Docker Compose
- A ProPR source checkout

## 1. Install Dependencies

From the repository root:

```bash
npm ci
```

## 2. Create Host Directories

Create the credential and cache directories that agent containers mount, before the first start — Docker otherwise creates missing mount sources as root-owned, which causes write failures:

```bash
mkdir -p ~/.claude ~/.codex ~/.gemini ~/.vibe "/tmp/propr-vibe-prompts-$(id -u)"
```

Log in to each agent you plan to run (for example `claude login` for Claude Code, `agy login` for Antigravity) so its credential directory holds real auth state.

## 3. Configure `.env`

The Compose stack reads its configuration from `.env` in the repository root. Start from the shipped template:

```bash
cp .env.example .env
```

Then configure GitHub access. By default ProPR uses the shared, hosted ProPR GitHub App through the token relay — `propr relay enroll` writes the relay/routing credentials into the stack `.env` (run it from the repository root, or pass `--root <dir>` if another ProPR stack is configured on this machine) — and running your own GitHub App is the advanced alternative. See [GitHub Authentication](../operations/github-auth.md) for both modes and the [Configuration Reference](../operations/configuration-reference.md) for every variable.

## 4. Start The Development Compose Stack

```bash
npm run compose:up    # docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

The development Compose stack includes Redis. To enable the OpenCode agent, create `~/.config/opencode` and `~/.local/share/opencode`, then include the OpenCode override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.opencode.yml up -d
```

## 5. Verify It Works

Open `http://localhost:5173` (override with `UI_PORT`), sign in with GitHub, and confirm the dashboard loads; the API answers on port `4000` (`API_PORT`). Tail the services if anything looks off:

```bash
npm run compose:logs
```

Then add a repository and enable an agent in the Web UI, or point the [ProPR CLI](../features/propr-cli.md) at the dev stack with `propr remote http://localhost:4000`. `npm run compose:down` stops the stack.

## Direct Local Services

Direct service commands are mostly useful for debugging.

`npm run daemon` and `npm run worker` execute the compiled output in `dist/`, so build first:

```bash
npm run build
npm run daemon
npm run worker
```

Alternatively, run the TypeScript sources directly with `tsx`:

```bash
npm run daemon:dev
npm run worker:dev
```

If you run services directly, start Redis yourself first.

## Docs Work

```bash
cd docs
npm run typecheck
npm run build
```

## Image Workflows

```bash
npm run images:build
npm run images:smoke
```

Use the normal prebuilt-image setup for actual end-user installs.
