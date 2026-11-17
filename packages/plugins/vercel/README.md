# Vercel

Deploy a pull request to Vercel from a comment. `/deploy` (or `/deploy-vercel`)
on a pull request queues one follow-up task in which the agent creates a
**Vercel preview deployment** of the pull request's head commit through
Vercel's MCP server and replies with the URL and how to roll back. Production
only when an administrator allows it. The plugin is declarative: a manifest, a
skill and an automation template; no handlers. User documentation:
[`docs/docs/plugins/vercel.md`](../../../docs/docs/plugins/vercel.md).

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | Two OAuth connections, the read server `vercel` and the deploy server `vercel-write` (both Vercel's MCP server), the skill, the template, `/deploy` and `/deploy-vercel`, and the settings. |
| `skills/vercel-deploy/` | How to deploy this repository: detect the framework and the linked project, never create a project, reuse a deployment of the head commit only when it has the requested target, deploy a preview unless production is allowed and asked for, report the URL and how to roll back. |
| `automation-templates/deploy-preview-ready/` | "Deploy preview when review reaches the goal (Vercel)": a dry-run report of pull requests whose review reached the goal and that have no preview yet. It never deploys. |
| `fixtures/tools.json` | Vercel MCP tools from the categories a deploy needs, with read or write access, captured 2026-11-17. |

Tests: `packages/plugins/test/deployPlugins.test.ts` and
`packages/core/test/deployPlugins.test.ts` (see the Cloudflare README).

## What it contributes

- **`vercel` (read, applied automatically):** `https://mcp.vercel.com`, signed
  in as **Vercel account for reading**, tools `list_teams`, `get_team`,
  `list_projects`, `get_project`, `list_deployments`, `get_deployment`,
  `get_deployment_build_logs`, `list_deployment_events`, `get_runtime_logs`,
  `get_runtime_errors`, `web_fetch_vercel_url`, `search_vercel_documentation`.
- **`vercel-write` (write, never applied automatically):** the same server,
  signed in as **Vercel account for deploying**, tools `create_deployment`,
  `cancel_deployment`, `get_deployment`. Only a `/deploy` run gets it, and only
  when an administrator switched on "Allow this command to use write access"
  for the command and the commenter has write permission on the repository.
  Tools that create projects (`deploy_to_vercel`, `create_git_project`,
  `create_project`) or change settings, domains, protection or environment
  variables are not offered.
- **Skill `vercel-deploy`** and the **template**.
- **Commands** (`prompt`, pull requests only, `needsWrite`): `/deploy` (shared
  with other deployment plugins) and `/deploy-vercel`. The task's instruction
  states the team, the repository's default project and the **allowed
  target**: preview only, unless "Allow production deploys from commands" is
  on. `create_deployment` without `target` makes a preview; the agent sets
  `target: "production"` only when production is allowed and asked for.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Team ID or slug (`teamId`) | none | The team that owns the projects, passed as `teamId`. |
| Default project per repository (`projects`) | none | `owner/repo` → project name or `prj_…` id. Unmapped repositories use `.vercel/project.json` or the project Vercel links to the repository. |
| Allow production deploys from commands (`allowProductionDeploys`) | off | Off: `/deploy production` is refused with an explanation. |

## Permissions to grant (narrowest that allow preview deploys)

Vercel MCP acts with the signed-in user's own role; at sign-in, grant the
connection access to the team that owns the projects only.

| Connection | Account role |
| --- | --- |
| Vercel account for reading (`vercel-read`) | Pro Viewer or Enterprise Viewer on the team, or Project Viewer on the projects (Contributor on Enterprise). Pro Viewers cannot read logs; use Enterprise Viewer or a Developer when you want build and runtime logs. |
| Vercel account for deploying (`vercel-deploy`) | Developer on the team, or Project Developer on the projects, **without** the Full Production Deployment permission and without Create Project. That role creates preview deployments. Vercel reserves "Deploy to production from CLI, rollback and promote" for the Full Production Deployment permission, so a production request made as this account is expected to be refused by Vercel too (check it in the smoke test). Give Full Production Deployment only if you also turn on "Allow production deploys from commands". |

Use dedicated accounts made for ProPR rather than a person's account.

## Setup

1. In Vercel, add the dedicated accounts to the team with the roles above.
2. In ProPR, **Plugins → Vercel → Install**. It asks for no permissions.
3. **Connections → Vercel account for reading → Sign in**, sign in as the
   reading account and grant it the team. Then **Vercel account for
   deploying → Sign in** as the deploying account. ProPR registers itself with
   Vercel's sign-in automatically (client ID metadata document or dynamic
   registration); you do not create anything in Vercel.
4. **Settings**: the team, the default project per repository, and leave
   **Allow production deploys from commands** off unless you want it.
5. Optional: **Repositories**, limit the plugin to the repositories deployed
   with Vercel.
6. **Enable**. Then, under **Commands**, switch on **Allow this command to use
   write access** for `/deploy` and `/deploy-vercel`.
7. With another deployment plugin enabled, choose under **Commands** which
   plugin plain `/deploy` runs; `/deploy-vercel` always runs this one.

## Endpoint, authentication and tools

| What | Value | Source |
| --- | --- | --- |
| Server | `https://mcp.vercel.com`, Streamable HTTP | [Use Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp) |
| Authentication | OAuth sign-in. Vercel accepts clients that identify with a client ID metadata document (no review needed) and offers dynamic registration (`https://vercel.com/api/login/oauth/register` in its authorization server metadata, checked 2026-11-17) | [Use Vercel MCP: client identification with CIMD](https://vercel.com/docs/agent-resources/vercel-mcp#client-identification-with-cimd) |
| Tools | Listed by category | [Tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools), [Deployments](https://vercel.com/docs/agent-resources/vercel-mcp/tools/deployments), [Projects](https://vercel.com/docs/agent-resources/vercel-mcp/tools/projects), [Teams and Users](https://vercel.com/docs/agent-resources/vercel-mcp/tools/teams), [Documentation](https://vercel.com/docs/agent-resources/vercel-mcp/tools/documentation) |
| Preview vs production | `create_deployment`: "Use `requestBody.target: "production"` for production, or omit `target` for a preview" | [Deployments tools](https://vercel.com/docs/agent-resources/vercel-mcp/tools/deployments) |
| Roles | Developer, Project Developer, Viewer roles; Full Production Deployment permission | [Access roles](https://vercel.com/docs/rbac/access-roles) |
| Rollback | Instant Rollback to a previous production deployment; previews are not rollback targets | [Instant Rollback](https://vercel.com/docs/instant-rollback) |

When Vercel adds tools, compare its tools reference with `fixtures/tools.json`
and add a tool to a server only with the right capability.

## Manual smoke test

Run against a real Vercel team with a Git-connected project before a release:

- [ ] Install, sign in both connections, set the team and a project mapping,
      and enable. The extension library shows `vercel` (read, automatic apply
      on) and `vercel-write` (write, automatic apply off), both managed by the
      plugin, and the `vercel-deploy` skill.
- [ ] Start an ordinary task in the repository: the run lists `vercel`, not
      `vercel-write`.
- [ ] Comment `/deploy-vercel` before switching on write access: refused, no
      task starts. Switch it on and comment as someone without write
      permission: refused.
- [ ] Comment as a maintainer on a pull request whose head Vercel already
      deployed: the reply reports that deployment and no new one appears.
- [ ] Push a commit with Vercel's Git deployments paused (or on a project
      without them) and comment again: a new preview deployment of the head
      commit appears, the reply has its URL, and production is unchanged.
- [ ] Comment `/deploy production` with the production setting off: refused
      with the setting named; nothing deployed. Turn the setting on without
      giving the deploying account Full Production Deployment: Vercel refuses
      the production deployment and the reply reports it.
- [ ] Map a repository to a project that does not exist: nothing deployed and
      no project created.
- [ ] Sign out **Vercel account for deploying** and comment again: the run has
      no `vercel-write` (skipped, `oauth_not_connected`) and says so.
- [ ] Disable the plugin: the template is no longer offered under
      **Automations → New**.
