---
sidebar_position: 4
---

# Source Development Setup

Use this path only when you want to change ProPR code, run tests, validate docs, or build images.

## Prerequisites

- Node.js 20+
- Git 2.25+
- Docker
- Redis, if running services directly outside Docker Compose
- A ProPR source checkout

Before starting services, create the host directories that agent containers mount:

```bash
mkdir -p ~/.claude ~/.codex ~/.gemini ~/.vibe /tmp/propr-vibe-prompts
```

## Install Dependencies

```bash
npm ci
```

For docs work:

```bash
cd docs
npm run typecheck
npm run build
```

## Development Compose

For local platform development:

```bash
npm run compose:up
```

The development Compose stack includes Redis.

To enable the OpenCode agent, create `~/.opencode`, `~/.config/opencode`, and `~/.local/share/opencode`, then include the OpenCode override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.opencode.yml up -d
```

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

## Image Workflows

```bash
npm run images:build
npm run images:smoke
```

Use the normal prebuilt-image setup for actual end-user installs.

The [ProPR CLI](../features/propr-cli.md) works against the dev stack too — point it at the local API with `propr remote http://localhost:4000`.
