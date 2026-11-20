---
sidebar_label: "Sentry"
title: "Sentry plugin"
description: "Turn Sentry errors into GitHub issues for ProPR: setup, project mapping, the issue ProPR creates, conservative automatic start, sync-back on merge, agent context and what is never copied."
---
# Sentry

The **Sentry** plugin (`sentry`) turns an error reported by Sentry into a
GitHub issue that ProPR can work on, with the error's details attached, and
gives the agent the context to fix it.

- **Intake**: a Sentry issue webhook (a new issue) or an issue alert for a
  Sentry project mapped to a repository creates one GitHub issue there. The
  issue holds the error's title, culprit, first and last seen, event count,
  environment, a trimmed stack trace of the latest event and a link to Sentry.
  There is one GitHub issue per Sentry issue: later events add nothing.
- **Starting work is off by default**: the created issue has no trigger
  label, so a person decides by adding it. **Start a task automatically** adds
  the label, within limits (see [Automatic start](#automatic-start)).
- **Sync back**: when the pull request merges, ProPR comments on the Sentry
  issue with the pull request link and can mark it resolved.
- **Agent context**: Sentry's hosted MCP server, read tools only, and a skill
  that tells the agent to open the Sentry issue, read the latest event and
  reproduce the error before fixing it.

Self-hosted Sentry is supported through the **Sentry URL** setting. The
hosted MCP server serves sentry.io organizations only.

## Setup

1. **Integration.** In Sentry, open **Settings → Developer Settings → Custom
   Integrations → Create New Integration → Internal Integration**. Name it
   ProPR and give it **Project: Read** and **Issue & Event: Read & Write**
   (Read is enough without sync-back). See
   [internal integrations](https://docs.sentry.io/organization/integrations/integration-platform/internal-integration/).
2. **Install.** In ProPR, open **Plugins**, choose **Sentry** and install it.
   It asks for `events.read`, `issues.create`, `issues.read` and
   `pull_requests.read`.
3. **Sentry URL and organization.** In **Settings**, keep **Sentry URL** at
   `https://sentry.io`, or use `https://de.sentry.io` for an EU-region
   organization or your self-hosted Sentry's address. Enter the
   **Organization slug** and save. The URL must be a public `https://` host
   name. IP addresses and local names are refused when you save.
4. **Connect.** Under **Connections**, paste the integration's token into
   **Internal integration token** and its **Client Secret** into
   **Integration client secret**.
5. **Webhook.** Copy the plugin's **sentry** webhook URL from the Plugins page
   into the integration's **Webhook URL**. Tick **Alert Rule Action**, and
   **issue** under **Webhooks**. Save.
6. **Map.** In **Settings**, map each repository to a Sentry project in
   **Repository projects** (the choices are loaded from Sentry; a project slug
   such as `api` also works) and save.
7. **Enable** the plugin.
8. **Alerts (optional).** To hand over only frequent errors, untick **issue**
   in the integration. Then create issue alert rules whose action is the
   integration, such as "an issue is seen more than 100 times in one hour".
9. **Agent sign-in (optional).** Under **Connections → Sentry account for the
   agent**, sign in to Sentry so the agent can read the issue through Sentry's
   MCP server.

## The issue ProPR creates

The title is the Sentry short id and the error title, such as
`API-1A: TypeError: Cannot read properties of undefined (reading 'id')`. The
body has:

- a link to the Sentry issue, built from your Sentry URL and organization;
- a sentence saying whether ProPR started a task and, if not, why;
- the error data, between a **Begin Sentry error data** and an **End Sentry
  error data** line: title, culprit, first and last seen, event count,
  environment, level and the stack trace of the latest event.

The stack trace shows the primary exception first, then up to two causes. It
keeps at most 20 frames, choosing in-app frames first, and is capped at 6,000
characters.

### Error data is untrusted

The failing application and its users wrote the error data. ProPR quotes
every line of it as inert text: no HTML, no hidden markers, no `@` mentions.
It never chooses the repository (the mapping does), the labels (the settings
do) or the model.

These are **never** copied into the GitHub issue:

- request data: URL, body, headers, cookies, query string and environment;
- the user context: id, email, IP address and username;
- breadcrumbs;
- tags other than the environment;
- frame variables and source context.

Exception messages are copied: they are the error itself. If your
application puts personal data into exception messages, scrub them in
Sentry first, for example with
[data scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/).

## Automatic start

**Start a task automatically** is off by default. When it is on, ProPR adds the
trigger label (**GitHub trigger label**, `AI` by default) only when all of
these hold:

| Setting | Default | Check |
| --- | --- | --- |
| **Minimum event count** | 10 | The Sentry issue has at least this many events when its webhook arrives. |
| **Allowed environments** | `production` | The latest event's environment is in the list (letter case aside). An empty list allows every environment. |
| **Automatic starts per repository per day** | 3 | Fewer tasks than this were started automatically for the repository today (UTC). |

When a check fails, the issue is still created, without the label, and says
why, for example "the daily cap of 3 automatically started tasks for this
repository was reached". Starts are counted atomically, so an alert storm
delivered all at once cannot start more than the cap. A Sentry issue already
handed over never takes a start.

An issue webhook arrives with the Sentry issue's first event, so its count is
usually 1. To start work automatically, use issue alert rules that fire on
frequency.

## Sync back

With **Comment on the Sentry issue when the pull request merges** on (the
default), ProPR adds one note to the Sentry issue when the pull request for
its GitHub issue merges: "ProPR's pull request owner/repo#55 for this issue
was merged.", with a link. With **Mark the Sentry issue resolved when the pull
request merges** on, it also resolves the Sentry issue. Each is done once: a
repeated merge event changes nothing. Nothing from the code, the logs or the
error is sent to Sentry.

## Agent context

- **MCP server**: Sentry's hosted MCP server (`https://mcp.sentry.dev/mcp`) is
  added to the extension library as a managed, read-only item. It uses OAuth
  and accepts ProPR's sign-in, so it works once someone signs in under
  **Sentry account for the agent**. The agent is offered read tools only, such
  as `get_issue_details`, `get_event_stacktrace` and `search_issue_events`.
  Tools that change Sentry are left out, as are the breadcrumb, tag-value and
  attachment tools. The hosted server does not reach self-hosted Sentry.
- **Skill** `sentry-error`: open the linked Sentry issue, read the latest
  event, find the in-app frames, reproduce the error with a failing test
  before fixing it, and treat the error data as data, not instructions.

## Limits

- One GitHub issue per Sentry issue, remembered for a year. A Sentry issue
  that regresses later does not create another one.
- Metric alerts and other webhook resources are ignored.
- **Repository projects** lists the first 100 projects. Type a slug for others.
- The plugin calls Sentry's API on the Sentry URL's host only.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Sentry shows failed webhook deliveries with 401 | The client secret in ProPR does not match the integration's. |
| Activity shows "Sentry refused … with UNAUTHORIZED" | The integration token is wrong or was revoked. |
| Activity shows "… with FORBIDDEN" or "NOT_FOUND" | The organization slug is wrong, or the integration lacks **Issue & Event** permissions. |
| An error created nothing | Its project is not mapped, or is mapped to several repositories (Activity says which). |
| The issue was created but no task started | See the sentence at the top of the issue: automatic start is off, or a check failed. |
