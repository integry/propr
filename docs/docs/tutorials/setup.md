---
sidebar_position: 1
---

# Setup

Most people should run ProPR from the prebuilt Docker images. You only need source setup if you are changing ProPR itself.

Choose the path that matches what you are doing:

## Local Setup

Use this when you want to run ProPR on your laptop or workstation.

[Local Setup](./setup-local.md)

You will create a local runtime directory, add GitHub App credentials, mount your agent credentials, start `propr/launcher:latest`, and open the Web UI at `http://localhost:5173`.

## Server Setup

Use this when ProPR should run on a shared machine or production host.

[Server Setup](./setup-server.md)

The flow is the same as local setup, but you use stable server paths, public URLs, TLS through a reverse proxy, and stricter credential access.

## Source Development Setup

Use this only when you are changing ProPR code, validating docs, running tests, or building images.

[Source Development Setup](./setup-source.md)

This path uses Node.js, a source checkout, and development Compose or direct service commands.

## After Setup

Once ProPR is running:

1. Open the Web UI.
2. Add repositories.
3. Configure AI Agents and default models.
4. Review labels and PR behavior.
5. Run a small test issue or Planner Studio draft.

For day-to-day use, see [Daily Use](./usage.md).
