# Cloudflare

Deploy a pull request to Cloudflare from a comment. `/deploy` (or
`/deploy-cloudflare`) on a pull request queues one follow-up task in which the
agent deploys the pull request's branch as a **Cloudflare Pages or Workers
preview** through Cloudflare's API MCP server and replies with the URL and how
to roll back. Production only when an administrator allows it. The plugin is
declarative: a manifest, a skill and an automation template; no handlers.
User documentation:
[`docs/docs/plugins/cloudflare.md`](../../../docs/docs/plugins/cloudflare.md).

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | Two API token connections, the read server `cloudflare` and the deploy server `cloudflare-write` (both Cloudflare's API MCP server), the skill, the template, `/deploy` and `/deploy-cloudflare`, and the settings. |
| `skills/cloudflare-deploy/` | How to deploy this repository type: detect Pages or Worker and the framework, never create a project, deploy a preview unless production is allowed and asked for, report the URL and how to roll back. |
| `automation-templates/deploy-preview-ready/` | "Deploy preview when review reaches the goal (Cloudflare)": a dry-run report of pull requests whose review reached the goal. It cannot check for an existing preview (the read server cannot read deployments) and never deploys. |
| `fixtures/tools.json` | The tools of Cloudflare's API MCP server as its README lists them, with their access, captured 2026-11-17. |

Tests: `packages/plugins/test/deployPlugins.test.ts` (manifest, allow-lists
against the fixture, the instruction `/deploy` queues for each setting, the
skill and the template) and `packages/core/test/deployPlugins.test.ts`
(install, connect and enable give both items, only the read item auto-applied; `/deploy` write authorization; two deployment plugins sharing
`/deploy`; the template offered only while enabled).

## What it contributes

- **`cloudflare` (read, applied automatically):** `https://mcp.cloudflare.com/mcp`
  with the **read-only API token**, tools `docs`, `search` and `whoami` only.
  None of them can call an arbitrary endpoint, so the server stays read-only
  whatever token is pasted into the field: by its tools, not by the token.
  `execute`, which calls any endpoint, is offered by the write server only.
- **`cloudflare-write` (write, never applied automatically):** the same server
  with the **deploy API token**, tools `search`, `execute`, `whoami`. The agent
  makes every API call of a deploy through it, the reads (project, production
  branch, connected repository, the new deployment, Workers Builds) as well
  as the deploy call. Only a
  `/deploy` run gets it, and only when an administrator switched on
  "Allow this command to use write access" for the command and the commenter
  has write permission on the repository. The run uses its single-use grant;
  a retry or later follow-up gets neither server.
- **Skill `cloudflare-deploy`** and the **template**.
- **Commands** (`prompt`, pull requests only, `needsWrite`): `/deploy` (shared
  with other deployment plugins) and `/deploy-cloudflare`. The task's
  instruction states the account id, the repository's default project and the
  **allowed target**: preview only, unless "Allow production deploys from
  commands" is on.

How a preview is made: a **Git-connected Pages project** gets a deployment of
the pull request's branch through Pages' "create deployment" endpoint (with
`branch`), which Cloudflare builds as a preview. The agent reads the
project's production branch first and deploys nothing when the pull request's
head branch is the production branch, since that deployment would be
production. Because Pages builds a branch name and not a commit, the agent
also deploys nothing when the project's connected repository is not the pull
request's head repository (every pull request from a fork) or cannot be
read, and after deploying it reports the deployment as this pull request's
preview only when Cloudflare's recorded commit is the head commit. A **Worker
with Workers Builds** already builds a Preview of each push to a
non-production branch; the agent reports the build of exactly the head
commit. Projects without a Git connection (Direct Upload, or a
Worker deployed with Wrangler only) are not deployed: that needs Wrangler on a
build machine, which the agent does not run. Cloudflare builds production from
the production branch only, so the agent never deploys a pull request branch
to production, even when production is allowed; it says that production
follows the merge.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Account ID (`accountId`) | none | The account the projects are in, passed as `account_id`. |
| Default project per repository (`projects`) | none | `owner/repo` → Pages project or Worker name. Unmapped repositories use the `name` in their Wrangler configuration. |
| Allow production deploys from commands (`allowProductionDeploys`) | off | Off: `/deploy production` is refused with an explanation. |

## Permissions to grant (narrowest that allow preview deploys)

Create two **account API tokens** (Manage account → Account API tokens), each
limited to the one account, without Client IP Address Filtering (Cloudflare's
MCP server does not support it):

| Token | Permissions |
| --- | --- |
| Read-only API token (`read-token`) | Account Settings Read |
| Deploy API token (`deploy-token`) | Account Settings Read, Cloudflare Pages Edit, Workers Scripts Read, Workers CI Read |

Cloudflare Pages Edit is the narrowest permission that creates a Pages
deployment ("Pages Write" on the endpoint). It also allows changing Pages
projects; the skill tells the agent never to, and only a `/deploy` run allowed
to use write access holds this token. Do not add Workers Scripts Edit: the
plugin never uploads Worker code. Account Settings Read lets the server detect
the account id from an account token.

## Setup

1. In Cloudflare, create the two tokens above.
2. In ProPR, **Plugins → Cloudflare → Install**. It asks for no permissions.
3. **Connections**: set **Read-only API token** and **Deploy API token**.
4. **Settings**: the account id, the default project per repository, and leave
   **Allow production deploys from commands** off unless you want it.
5. Optional: **Repositories**, limit the plugin to the repositories deployed
   with Cloudflare.
6. **Enable**. Then, under **Commands**, switch on **Allow this command to use
   write access** for `/deploy` and `/deploy-cloudflare`. Until you do, both
   reply that an administrator has not allowed them.
7. With another deployment plugin enabled, choose under **Commands** which
   plugin plain `/deploy` runs; `/deploy-cloudflare` always runs this one.

## Endpoint, authentication and tools

| What | Value | Source |
| --- | --- | --- |
| Server | `https://mcp.cloudflare.com/mcp`, Cloudflare's API MCP server (Streamable HTTP) | [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) |
| Authentication | A Cloudflare API token as a Bearer token; user and account tokens are supported (OAuth is the alternative Cloudflare documents for interactive clients) | [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/), [cloudflare/mcp README](https://github.com/cloudflare/mcp) |
| Tools | `docs`, `search`, `execute`, `whoami` (the read server offers `docs`, `search`, `whoami`) | [cloudflare/mcp README](https://github.com/cloudflare/mcp) |
| Pages deployment | `POST /accounts/{account_id}/pages/projects/{project_name}/deployments` with `branch`; needs Pages Write | [Create deployment](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/) |
| Workers previews | Workers Builds builds non-production branches as Previews | [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) |
| Token permissions | Cloudflare Pages Read/Edit, Workers Scripts Read/Edit, Account Settings Read, Workers CI Read | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) |
| Rollback | Pages: Rollback to this deployment (production deployments only); Workers: Deployments → Rollback or `wrangler rollback` | [Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/), [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) |

Cloudflare's product-specific servers (documentation, containers, browser and
others) cannot deploy. Its earlier Workers Builds and Bindings servers are no
longer listed.

## Manual smoke test

Run against a real Cloudflare account with a Git-connected Pages project
before a release:

- [ ] Install, set both tokens, the account id and a project mapping, and
      enable. The extension library shows `cloudflare` (read, automatic apply
      on) and `cloudflare-write` (write, automatic apply off), both managed by
      the plugin, and the `cloudflare-deploy` skill.
- [ ] Start an ordinary task in the repository: the run lists `cloudflare`
      with only `docs`, `search` and `whoami`, and not `cloudflare-write`.
- [ ] Comment `/deploy-cloudflare` on a pull request before switching on
      write access: ProPR replies that an administrator has not allowed it,
      and no task starts.
- [ ] Switch on write access for the command. Comment as someone without
      write permission: refused, nothing starts.
- [ ] Comment as a maintainer: one follow-up task starts with
      `cloudflare-write` and the skill; the reply has a `*.pages.dev` preview
      URL for the head commit, and the project's production deployment is
      unchanged.
- [ ] Comment `/deploy-cloudflare` on a pull request from a fork whose
      branch name also exists in the connected repository: nothing is
      deployed, and the reply says the project is connected to a different
      repository.
- [ ] Comment `/deploy production` with the production setting off: the reply
      refuses and names the setting; no deployment is created.
- [ ] Map a repository to a project that does not exist: nothing is
      deployed, and no project is created (check the account's projects).
- [ ] Remove the deploy token's Cloudflare Pages Edit permission: the reply
      reports the permission error; nothing else is tried.
- [ ] Disable the plugin: the template is no longer offered under
      **Automations → New**.
