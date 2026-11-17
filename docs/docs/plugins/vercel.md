---
sidebar_label: "Vercel"
title: "Vercel plugin"
description: "Deploy a pull request as a Vercel preview from a /deploy comment, through Vercel's MCP server: setup, the account roles to grant, production deploys, rollbacks and a smoke test."
---
# Vercel

The **Vercel** plugin (`vercel`) deploys a pull request to Vercel when someone
comments `/deploy` (or `/deploy-vercel`) on it. ProPR queues one follow-up
task; the agent creates a **preview deployment** of the pull request's head
commit with Vercel's MCP server and replies on the pull request with the URL
and how to roll back. The plugin is declarative: it has no handlers. The agent
performs the deploy, so the same write-authorization rules apply as to any
write server.

- **Read server** `vercel`: `https://mcp.vercel.com`, signed in as **Vercel
  account for reading**, with read tools only (teams, projects, deployments,
  build and runtime logs, documentation). Applied automatically to runs in the
  plugin's repositories.
- **Write server** `vercel-write`: the same server, signed in as **Vercel
  account for deploying**, with `create_deployment`, `cancel_deployment` and
  `get_deployment`. Never applied automatically; only a `/deploy` run allowed
  to use write access gets it, for that one run. No tool that creates a
  project or changes settings, domains, protection or environment variables is
  offered.
- **Skill** `vercel-deploy`: detect the framework and the linked project, never
  create a project, reuse a deployment Vercel's Git connection already made of
  the head commit, deploy a preview unless production is allowed and asked for,
  report the URL and how to roll back.
- **Commands** `/deploy` (shared with other deployment plugins) and
  `/deploy-vercel`, on pull requests.
- **Automation template** "Deploy preview when review reaches the goal
  (Vercel)": a dry-run report, offered while the plugin is enabled.

`create_deployment` without a `target` creates a preview; the agent sets
`target: "production"` only when production is allowed and the command asks
for it.

## Write access and who can run it

`/deploy` and `/deploy-vercel` need write access. Each runs only when an
administrator switched on **Allow this command to use write access** for it
under the plugin's **Commands** (off at install) and the commenter has write,
maintain or admin permission on the repository. Otherwise ProPR replies with
which of the two is missing and starts nothing. See
[Plugin Commands](../features/pr-commands.md#plugin-commands).

## Production deploys

**Allow production deploys from commands** is off by default. While it is off,
the task's instruction states "Allowed target: preview only", and
`/deploy production` is refused with a reply naming the setting. Deploys spend
your Vercel team's resources; keep previews as the default.

## Account roles to grant

Vercel MCP acts with the signed-in user's role. Use dedicated accounts, and at
sign-in grant each connection the team that owns the projects only.

| Connection | Role |
| --- | --- |
| Vercel account for reading | Pro Viewer or Enterprise Viewer, or Project Viewer on the projects. Pro Viewers cannot read logs. |
| Vercel account for deploying | Developer, or Project Developer, without the **Full Production Deployment** and **Create Project** permissions: it creates preview deployments. Add Full Production Deployment only if you also turn on production deploys. |

## Setup

1. In Vercel, add the dedicated accounts with the roles above.
2. In ProPR, **Plugins → Vercel → Install** (no permissions asked).
3. **Connections**: **Sign in** both connections, each as its account. ProPR
   registers itself with Vercel's sign-in automatically.
4. **Settings**: **Team ID or slug**, **Default project per repository**
   (`owner/repo` → project name or id; unmapped repositories use
   `.vercel/project.json` or the project Vercel links to the repository), and
   **Allow production deploys from commands** (off).
5. Optional: limit the plugin to the repositories deployed with Vercel.
6. **Enable**, then switch on write access for `/deploy` and `/deploy-vercel`
   under **Commands**.

With another deployment plugin enabled (such as [Cloudflare](./cloudflare.md)),
choose under **Commands** which plugin plain `/deploy` runs; `/deploy-vercel`
always runs this plugin.

## Rolling back

- A **preview** never receives production traffic: nothing needs rolling back.
  A build still running can be cancelled.
- **Production:** **Instant Rollback** on the project's production deployment
  tile, or **Deployments → ⋮ → Instant Rollback**.

## Sources

- [Use Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp): endpoint, OAuth, client ID metadata documents
- [Tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools), [Deployments tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools/deployments), [Projects tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools/projects)
- [Access roles](https://vercel.com/docs/rbac/access-roles), [Instant Rollback](https://vercel.com/docs/instant-rollback)

The plugin's README (`packages/plugins/vercel/README.md`) has the manual
smoke-test checklist. Netlify has no plugin; see
[No Netlify plugin](./cloudflare.md#no-netlify-plugin).
