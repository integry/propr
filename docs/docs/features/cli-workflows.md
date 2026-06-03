---
sidebar_position: 11
---

# CLI Workflows

Most day-to-day ProPR operation should happen in the Web UI and GitHub comments. CLI workflows are still useful for developers and operators who need to run services directly, validate docs, build images, inspect logs, or recover local environments.

## When To Use The CLI

Use CLI workflows for:

- Developing ProPR from source
- Running local validation commands
- Building or testing Docker images
- Starting direct daemon or worker processes during development
- Inspecting queues or logs during operations
- Running smoke tests before publishing images

You should not need CLI commands for routine repository, branch, label, or agent configuration. Those settings belong in the Web UI.

## Source Development

From a source checkout:

```bash
npm ci
npm run compose:up
```

Use this path when changing ProPR code. For normal usage, run the prebuilt images as described in [Setup](../tutorials/setup.md).

## Docs Validation

When editing the docs:

```bash
cd docs
npm run typecheck
npm run build
```

Use `npm run start` in the `docs/` directory when you want to preview the docs site locally.

## Service Commands

Direct service commands are mainly for development:

```bash
npm run daemon
npm run worker
```

For deployed installs, prefer the launcher or container orchestration layer.

## Image Workflows

Image workflows are useful when changing Dockerfiles or release packaging:

```bash
npm run images:build
npm run images:smoke
```

Publishing images requires registry login and should follow the release process.

## Operational Debugging

CLI debugging should be targeted and temporary. Examples include checking container logs, inspecting Redis queue state, or verifying that mounted credential paths exist.

For ongoing operations, prefer the dashboard, task records, and [Maintenance And Troubleshooting](../operations/maintenance.md).
