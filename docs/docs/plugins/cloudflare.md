---
sidebar_label: "Cloudflare"
title: "Cloudflare plugin"
description: "Deploy a pull request as a Cloudflare Pages or Workers preview from a /deploy comment, through Cloudflare's API MCP server: setup, the API token permissions to grant, production deploys, rollbacks and a smoke test."
---
# Cloudflare

The **Cloudflare** plugin (`cloudflare`) deploys a pull request to Cloudflare
when someone comments `/deploy` (or `/deploy-cloudflare`) on it. ProPR queues
one follow-up task; the agent deploys the pull request's branch as a
**preview** with Cloudflare's API MCP server and replies on the pull request
with the URL and how to roll back. The plugin is declarative: it has no
handlers. The agent performs the deploy, so the same write-authorization rules
apply as to any write server.

- **Read server** `cloudflare`: Cloudflare's API MCP server,
  `https://mcp.cloudflare.com/mcp`, with a **read-only API token**. Applied
  automatically to runs in the plugin's repositories.
- **Write server** `cloudflare-write`: the same server with a **deploy API
  token**. Never applied automatically; only a `/deploy` run allowed to use
  write access gets it, for that one run.
- **Skill** `cloudflare-deploy`: detect a Pages project or a Worker and the
  framework, never create a project, deploy a preview unless production is
  allowed and asked for, report the URL and how to roll back.
- **Commands** `/deploy` (shared with other deployment plugins) and
  `/deploy-cloudflare`, on pull requests.
- **Automation template** "Deploy preview when review reaches the goal
  (Cloudflare)": a dry-run report, offered while the plugin is enabled.

## How a preview is made

| Project | What `/deploy` does |
| --- | --- |
| Pages project connected to Git | Creates a deployment of the pull request's branch (Pages' "create deployment" endpoint with `branch`); Cloudflare builds it as a preview. |
| Worker with Workers Builds | A push to a non-production branch already builds a Preview: the agent finds the build of the head commit and reports its Preview URL. |
| Direct Upload Pages project, or a Worker deployed with Wrangler only | Nothing is deployed: that needs Wrangler on a build machine. The reply says the project needs a Git connection or Workers Builds. |

Cloudflare builds **production** from the project's production branch only.
Even with production allowed, the agent never deploys a pull request branch to
production; it replies that production follows the merge.

## Write access and who can run it

`/deploy` and `/deploy-cloudflare` need write access. Each runs only when:

1. an administrator switched on **Allow this command to use write access** for
   it under the plugin's **Commands** (off at install), and
2. the commenter has write, maintain or admin permission on the repository.

Otherwise ProPR replies with which of the two is missing and starts nothing.
See [Plugin Commands](../features/pr-commands.md#plugin-commands).

## Production deploys

**Allow production deploys from commands** is off by default. While it is off,
the task's instruction states "Allowed target: preview only", and
`/deploy production` is refused with a reply naming the setting. Deploys spend
your Cloudflare account's resources; keep previews as the default.

## Permissions to grant

Create two **account API tokens**, each limited to one account and without
Client IP Address Filtering (Cloudflare's MCP server does not support it):

| Connection | Permissions |
| --- | --- |
| Read-only API token | Account Settings Read, Cloudflare Pages Read, Workers Scripts Read, Workers CI Read |
| Deploy API token | Account Settings Read, Cloudflare Pages Edit, Workers Scripts Read, Workers CI Read |

Cloudflare Pages Edit is the narrowest permission that creates a Pages
deployment. The read server's `execute` tool can call any endpoint, but
Cloudflare refuses every change made with the read-only token.

## Setup

1. In Cloudflare, create the two tokens.
2. In ProPR, **Plugins → Cloudflare → Install** (no permissions asked).
3. **Connections**: set both tokens.
4. **Settings**: **Account ID**, **Default project per repository** (`owner/repo`
   → Pages project or Worker name; unmapped repositories use the `name` in
   their Wrangler configuration), and **Allow production deploys from
   commands** (off).
5. Optional: limit the plugin to the repositories deployed with Cloudflare.
6. **Enable**, then switch on write access for `/deploy` and
   `/deploy-cloudflare` under **Commands**.

With another deployment plugin enabled (such as [Vercel](./vercel.md)), choose
under **Commands** which plugin plain `/deploy` runs. Without a choice, `/deploy`
replies naming `/deploy-cloudflare` and the other plugin's command;
`/deploy-cloudflare` always runs this plugin.

## Rolling back

- A **preview** never receives production traffic: nothing needs rolling back.
  Delete it from the project's **Deployments** list if you want it gone.
- **Pages production:** **Deployments → … → Rollback to this deployment** on a
  previous production deployment.
- **Worker production:** **Deployments → … → Rollback**, or `wrangler rollback`.

## Sources

- [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) and the [cloudflare/mcp README](https://github.com/cloudflare/mcp): endpoint, tools (`docs`, `search`, `execute`, `whoami`), API token authentication
- [Create Pages deployment](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/), [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

The plugin's README (`packages/plugins/cloudflare/README.md`) has the manual
smoke-test checklist.

## No Netlify plugin

Netlify publishes an official MCP server (the `@netlify/mcp` npm package and a
remote server at `https://mcp.netlify.com/mcp`), but it cannot make a preview
deploy. Its only deploy operation, `deploy-site`, builds the project and
publishes it: the remote server describes it as making the deploy "what
visitors see", and the npm package's variant uploads a local folder to the
site's builds endpoint. There is no draft or preview deploy operation, and
Netlify's documentation does not list the server's tool names (checked in
`@netlify/mcp` 1.22.1 on 2026-11-17). A plugin that keeps preview as the
default is not possible with it, so none ships; Netlify's own Deploy Previews
for pull requests still work.
