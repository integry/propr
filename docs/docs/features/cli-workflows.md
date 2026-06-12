---
sidebar_position: 11
---

# CLI Workflows

:::info Looking for the `propr` command?
This page covers the npm scripts and Docker commands used to develop and operate ProPR itself from a source checkout. The end-user command-line client (`@propr/cli`, command `propr`) — plans, issue implementation, tasks, repos, and settings from the terminal — is documented in [ProPR CLI](./propr-cli.md).
:::

Most day-to-day ProPR operation should happen in the Web UI and GitHub comments. The workflows on this page are for developers and operators who need to run services directly, validate docs, build images, inspect logs, or recover local environments.

## When To Use These Workflows

Use them for:

- Developing ProPR from source
- Running local validation commands
- Building or testing Docker images
- Starting direct daemon or worker processes during development
- Inspecting queues or logs during operations
- Running smoke tests before publishing images

You should not need them for routine repository, branch, label, or agent configuration. Those settings belong in the Web UI.

## Source Development

From a source checkout (Node.js 20+):

```bash
npm ci
npm run compose:up
```

`compose:up` runs the Docker Compose stack via `scripts/compose.sh`; `compose:dev`, `compose:down`, `compose:logs`, and `compose:build` cover the rest of the Compose lifecycle. An override file (`docker-compose.opencode.yml`) adds OpenCode support to the stack.

Use this path when changing ProPR code. For normal usage, run the prebuilt images as described in [Setup](../tutorials/setup.md).

## Validation

From the repository root:

```bash
npm run typecheck
npm run lint
npm run test:unit
```

When editing the documentation site, run its own typecheck and Docusaurus build from the `docs/` directory:

```bash
cd docs
npm run typecheck
npm run build
```

Use `npm run start` in the `docs/` directory to preview the docs site locally.

## Service Commands

Direct service commands are mainly for development (run `npm run build` first, or use the `:dev` variants which run from TypeScript with debug logging):

```bash
npm run daemon            # issue/comment intake (npm run daemon:dev for tsx + debug logs)
npm run worker            # task execution
npm run analysis-worker   # analysis jobs
npm run indexing-worker   # repository indexing
npm run dashboard         # API server (packages/api)
```

For deployed installs, prefer the launcher (`npm run start:prod` runs the published `propr/launcher` image) or your container orchestration layer.

## Image Workflows

Image workflows are useful when changing Dockerfiles or release packaging:

```bash
npm run images:build        # build all images (scripts/build-images.sh)
npm run images:build:push   # build and push to registries
npm run images:smoke        # smoke-test built images
```

The build script produces `app`, `ui`, `docs`, `agent-base`, the five agent images, and the launcher, and writes the launcher's pinned image manifest. Publishing requires registry login (Docker Hub `propr/`, GHCR `ghcr.io/proprdev/`) and should follow the release process.

## Maintenance Helpers

```bash
npm run db:migrate     # apply SQLite migrations
npm run config:repos   # list repository configurations
npm run fix-labels     # repair issue label state
```

## Operational Debugging

CLI debugging should be targeted and temporary. Examples include checking container logs (`npm run compose:logs` or `docker logs propr-worker`), inspecting Redis queue state, or verifying that mounted credential paths exist.

For ongoing operations, prefer the dashboard, task records, and [Maintenance And Troubleshooting](../operations/maintenance.md).
