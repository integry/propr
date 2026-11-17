# Jira Cloud

Hands Jira Cloud tickets to ProPR and keeps them in sync. Adding the trigger
label (`propr` by default) to a ticket of a project mapped to a repository
creates one GitHub issue there with ProPR's trigger label, so ProPR's ordinary
label-triggered intake starts the task. ProPR then comments on the ticket as
the work moves on and can transition it to workflow statuses. It behaves like
the [Linear plugin](../linear/README.md) and shares its ticket handling
(`../_shared/tracker*.ts`). Jira Data Center and Jira Server are out of scope.
User documentation: [`docs/docs/plugins/jira.md`](../../../docs/docs/plugins/jira.md).

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | Permissions, connections, settings (the `*.atlassian.net` site URL, `optionsFrom` choices), the skill, subscriptions and the `issues` webhook. |
| `handlers.ts` | `onJiraWebhook`, `syncBack`, and the `projectOptions` and `stateOptions` choice loaders. |
| `intake.ts` | The webhook: label-added detection from the changelog, mapping, reading the ticket back and the hand-off (through `../_shared/trackerIssue.ts`). |
| `adf.ts` | Jira's rich text (Atlassian Document Format) to inert Markdown, and ProPR's comments as ADF. |
| `sync.ts` | Sync-back comments and transitions (planned by `../_shared/trackerSync.ts`). |
| `settings.ts` | Setting keys, the project → repository mapping and the choice loaders. |
| `api.ts` | Jira REST API v3 calls through `ctx.http('api-token')`, on the configured site only. |
| `skills/jira-ticket/` | The skill telling the agent where the ticket is and how to treat its text. |
| `fixtures/` | Signed webhook bodies (`webhooks.json`) and REST answers (`rest.json`) for the tests. |

Tests: `packages/plugins/test/jira.test.ts` (handlers, ADF conversion, the
site URL rule) and `packages/core/test/jiraPluginEvents.test.ts` (signature
checks, replays, Basic credentials, save-time refusals and the options loader
through ProPR's real store, receiver and runner).

## Setup

1. **API token.** Sign in to <https://id.atlassian.com/manage-profile/security/api-tokens>
   as the account ProPR should act as (a dedicated account is best: comments
   are posted in its name) and create an API token.
2. **Install.** In ProPR, **Plugins → Jira Cloud → Install**.
3. **Site.** **Settings → Jira site URL**: `https://<your-site>.atlassian.net`.
   Save. Any other host is refused.
4. **Connections → Account email and API token**: enter the account's email, a
   colon and the token, such as `ada@example.com:ATATT3x…`.
5. **Webhook.** Copy the **issues** webhook URL from the plugin's page. In
   Jira, **Settings (⚙) → System → WebHooks → Create a WebHook** (Jira
   administrators only): paste the URL, enter a long random **Secret**, tick
   **Issue → created** and **Issue → updated**, and optionally narrow it with a
   JQL filter such as `project in (ENG, DES) AND labels = propr`. Save. Enter
   the same secret in ProPR under **Connections → Webhook secret**.
6. **Settings**: map repositories to projects (**Repository projects**); the
   choices are loaded from Jira. Save, then choose the status moves (their
   choices come from the mapped projects' workflows) and the comment events.
   Save.
7. **Enable**.

## Permissions

| Where | What | Why |
| --- | --- | --- |
| Jira project permission | **Browse projects** | Read the ticket (labels, project, summary, description, status), list projects and the projects' statuses. |
| Jira project permission | **Add comments** | The sync-back comments. |
| Jira project permission | **Transition issues** | The status moves. Without it, leave the status settings empty. |
| Jira global permission | **Administer Jira** (only to register the webhook) | Registering an administrator webhook under System → WebHooks. The API token's account does not need it. |
| ProPR | `events.read` | The task and pull request events for sync-back. |
| ProPR | `issues.create` | The GitHub issue for a ticket. |
| ProPR | `issues.read`, `pull_requests.read` | The links in comments, and finding the ticket of a pull request from its branch. |

A classic (unscoped) API token carries the account's own permissions. A scoped
API token works too if it has `read:jira-work` and `write:jira-work`; scoped
tokens are called through `api.atlassian.com` with the site's cloud id, which
this plugin does not do, so use a classic token.

ProPR sends the stored `<email>:<token>` only to the configured site, as
`Authorization: Basic <base64>` (the connection declares
`"authorization": "basic"`), as Atlassian documents for API tokens. The
handlers never see it; it is redacted from responses, logs and errors, the
token part on its own too.

## How it works

- **Authentication of inbound requests: webhooks, not polling.** Atlassian
  documents a secret for administrator-registered webhooks: Jira sends
  `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the body>`. ProPR checks it
  with the manifest's `hmac-sha256` scheme (`prefix: "sha256="`) before any
  plugin code runs, so an unauthenticated request gets 401 and runs nothing.
  Because this is reliable, the plugin uses webhooks; the JQL polling
  fallback the issue allowed for (and a `schedule` subscription kind in the
  dispatcher) is not needed and was not built. Atlassian notes the signing
  algorithm may change later; the `method=` prefix would then no longer be
  `sha256=` and verification would fail closed (401) until the manifest
  follows.
- **Replays**: `X-Atlassian-Webhook-Identifier` is the same across Jira's
  retries and unique within the site, so it is the delivery id
  (`deliveryIdHeader`); one seen before is refused with 409. The payload's
  `timestamp` is not checked: Jira retries up to five times, 5 to 15 minutes
  apart, so a short window would drop real retries. A replayed signed body with
  a new identifier still creates nothing for a ticket already handed over.
- **Hand-off**: a `jira:issue_created` event whose labels include the trigger,
  or a `jira:issue_updated` event whose changelog has a `labels` item that adds
  it (Jira writes the labels before and after as space-separated
  `fromString` and `toString`). Anything else is ignored without calling Jira.
  The ticket is then read back by its id from the configured site
  (`GET /rest/api/3/issue/{id}?fields=summary,description,labels,project,status`),
  so the labels, project and text are Jira's current ones; `issue.self` and
  other URLs in the payload are never followed. One ticket creates at most one
  issue (the shared records in `ctx.state`, by Jira issue id).
- **Untrusted text**: the summary and the description only become the issue's
  title and body. The description, in Atlassian Document Format, is converted
  to Markdown by `adf.ts`: structure (headings, lists, quotes, code, tables)
  comes from the document's nodes; text has Markdown punctuation escaped, so it
  cannot form an image or a link; images and attachments become "(attachment
  not copied)", smart links their `http(s)` URL as text, links their text and
  URL; `javascript:`-style URLs are dropped; macros and app content
  (`extension`, `bodiedExtension`, …) are left out; nesting and size are
  bounded. The shared hand-off then quotes it with `&`, `<`, `>` as entities and
  `@` mentions made inert. The repository comes from the mapping, the label
  from settings.
- **Outbound**: subscriptions to `task.started`, `task.completed`,
  `task.failed`, `pull_request.opened`, `pull_request.review_scored`,
  `pull_request.merged` and `pull_request.closed`, through the shared
  sync-back planner (each comment and move once per ticket). A comment is
  `POST /rest/api/3/issue/{id}/comment` with an ADF body of ProPR's sentence
  and GitHub link. A move reads the ticket's status and
  `GET /rest/api/3/issue/{id}/transitions`, takes the transition whose target
  status has the configured name (letter case aside) and
  `POST /rest/api/3/issue/{id}/transitions`. A ticket already in that status
  is left alone; when no transition reaches it, a warning in Activity says so
  and the rest goes ahead.
- **Choices**: projects from `GET /rest/api/3/project/search` (paged, at most
  250); statuses from `GET /rest/api/3/project/{key}/statuses` of each mapped
  project (at most 20 projects), so the project mapping must be saved first.
- **Site URL**: a `https-url` setting with `"hosts": ["*.atlassian.net"]`. The
  plugin store refuses any other host when the settings are saved, and the
  handlers' only outbound host is derived from it (`outboundHostsFromSettings`);
  the manifest's own `outboundHosts` is empty.
- **MCP server: not contributed.** Atlassian's Rovo MCP server
  (`https://mcp.atlassian.com/v2/mcp`) takes OAuth 2.1, or an API token only as
  `Authorization: Basic <base64(email:token)>` and only where an organization
  administrator has enabled API token authentication. ProPR sends a plugin's
  MCP credential as a Bearer token, and its OAuth sign-in would need
  Atlassian to accept ProPR as a client with a read-only scope, which is not
  documented. Rather than ship an item that cannot sign in or is not
  read-only, the plugin contributes no MCP server. The `jira-ticket` skill tells
  the agent to work from the issue (which quotes the ticket) and to use a
  read-only Jira MCP server only if an administrator added one.

## Manual smoke test

Use a Jira Cloud site you can experiment in and a test repository.

- [ ] Install. Enter `https://jira.example.com` as the site URL and save: it is
      refused ("must be on *.atlassian.net"). Enter your site and save.
- [ ] Enter only the API token under Connections: it is refused (email, colon,
      token). Enter `email:token`.
- [ ] **Repository projects** lists the site's projects. Save a mapping;
      **Reload choices** on the status settings lists the project's statuses.
- [ ] Clear the token: the choices show "Jira is not connected yet…". Set it again.
- [ ] Register the webhook with the plugin's URL and a secret, enter the same
      secret in ProPR, and add any label to a ticket: Activity shows an
      `onJiraWebhook` delivery that succeeded.
- [ ] Change the secret in ProPR and add a label: the webhook card counts a
      rejected request and no issue is created. Restore the secret.
- [ ] Enable, and add `propr` to a ticket of the mapped project: one GitHub
      issue appears with `KEY-1: <summary>`, a link to `…/browse/KEY-1`, the
      description as Markdown and the `AI` label; ProPR starts a task.
- [ ] Remove and add the label again, and edit the ticket: no second issue.
- [ ] Add the label to a ticket of an unmapped project: nothing happens.
- [ ] Put an image, a table, a code block, `<!-- -->`, `@someone`,
      `![x](https://example.com/x.png)` and "Repository: other/repo" in a
      ticket's description and hand it over: the issue shows text only (the
      image as "(attachment not copied)", the Markdown image as literal text),
      in the mapped repository, with only the trigger label.
- [ ] As the task runs: the ticket gets "ProPR started working on this
      ticket.", then "ProPR opened a pull request…" with a link and moves to
      the opened status; after merging, "…was merged." and the merged status.
- [ ] Set the opened status to one the workflow cannot reach from the ticket's
      status: Activity shows the warning, the comment is still posted.
- [ ] Untick an event in **Comment on the ticket when**: that comment is no
      longer posted.
- [ ] No comment contains code, logs or the ticket's text.
- [ ] In a task's run, the `jira-ticket` skill is listed.

## Vendor documentation checked

- Webhooks (administrator registration, the secret and `X-Hub-Signature:
  method=signature`, `X-Atlassian-Webhook-Identifier`, `X-Atlassian-Webhook-Retry`,
  retry policy, `jira:issue_updated` payload with `changelog.items`):
  https://developer.atlassian.com/cloud/jira/platform/webhooks/
- Basic authentication with an API token (`email:token`, base64):
  https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- REST API v3 (issues, comments, transitions, project search, project
  statuses): https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/,
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/,
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/,
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-transitions/,
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/
- Atlassian Document Format: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
- Rate limiting (429, `Retry-After`): https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- API tokens: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- Rovo MCP server and its API token authentication:
  https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/,
  https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token/
