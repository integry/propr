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

## Direct Local Services

Direct service commands are mostly useful for debugging:

```bash
npm run daemon
npm run worker
```

If you run services directly, start Redis yourself first.

## Image Workflows

```bash
npm run images:build
npm run images:smoke
```

Use the normal prebuilt-image setup for actual end-user installs.
