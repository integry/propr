# Sentry

Turns Sentry errors into GitHub issues for ProPR. A Sentry issue or
issue-alert webhook for a Sentry project mapped to a repository creates one
GitHub issue there with the error's title, culprit, first and last seen,
event count, environment, a trimmed stack trace of the latest event and a
link to Sentry. Starting a task is off by default. When the pull request
merges, ProPR can comment on the Sentry issue and mark it resolved. User
documentation: [`docs/docs/plugins/sentry.md`](../../../docs/docs/plugins/sentry.md).

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | Permissions, connections, settings, the read-only MCP server, the skill, subscriptions and the `sentry` webhook. |
| `handlers.ts` | `onSentryWebhook`, `syncBack` and the `projectOptions` choice loader. |
| `intake.ts` | The webhook: which requests hand an error over, project mapping, de-duplication and issue creation. |
| `issueBody.ts` | The GitHub issue's title and body, with the error data in one delimited, quoted block. |
| `stacktrace.ts` | Stack-trace trimming: frame limit, in-app frames first, line and total length caps. |
| `autostart.ts` | The automatic start guards and the daily cap counter in `ctx.state`. |
| `sync.ts` | The note on merge and resolving (planned by `../_shared/trackerSync.ts`). |
| `settings.ts` | Setting keys and readers, the project → repository mapping and the choice loader. |
| `api.ts` | Sentry API calls through `ctx.http('auth-token')`. |
| `skills/sentry-error/` | The skill telling the agent to open the Sentry issue, read the latest event and reproduce before fixing. |
| `fixtures/` | Signed webhook bodies (`webhooks.json`) and API answers (`api.json`) with personal-data sentinels. |

Tests: `packages/plugins/test/sentry.test.ts` (handlers) and
`packages/core/test/sentryPluginEvents.test.ts` (signature checks, replays
and the Sentry URL policy through ProPR's real receiver and runner).

## Setup

1. In Sentry, **Settings → Developer Settings → Custom Integrations → Create
   New Integration → Internal Integration**. Name it "ProPR" and give it the
   permissions below.
2. In ProPR, **Plugins → Sentry → Install**.
3. **Settings**: set **Sentry URL** (`https://sentry.io`, `https://de.sentry.io`
   for an EU-region organization, or your self-hosted Sentry's address) and
   **Organization slug**, and save.
4. **Connections**: paste the integration's token into **Internal integration
   token** and its **Client Secret** into **Integration client secret**.
5. Copy the **sentry** webhook URL from the plugin's page into the
   integration's **Webhook URL**, tick **Alert Rule Action** and, under
   **Webhooks**, **issue**. Save the integration.
6. **Settings**: map repositories to Sentry projects (**Repository projects**;
   choices are loaded from Sentry). Leave **Start a task automatically** off
   to begin with. Save.
7. **Enable**.
8. Optional: in Sentry, create an issue alert rule for the project with the
   action "Send a notification via ProPR" (the integration), such as "an issue
   is seen more than 100 times in one hour", so frequent errors reach ProPR
   with a high event count.
9. Optional: **Connections → Sentry account for the agent → Sign in**, so the
   agent can read the Sentry issue through Sentry's MCP server.

## Permissions and scopes

| Where | What | Why |
| --- | --- | --- |
| Sentry integration | **Project: Read** | The project choices in the settings form. |
| Sentry integration | **Issue & Event: Read** | Read the issue and its latest event. |
| Sentry integration | **Issue & Event: Write** | The note on merge and resolving the issue. Without sync-back, Read is enough. |
| Sentry integration | Webhooks: **issue**; **Alert Rule Action** | The two kinds of request that hand errors over. |
| ProPR | `events.read` | The task and pull request events for sync-back. |
| ProPR | `issues.create` | The GitHub issue for a Sentry issue. |
| ProPR | `issues.read`, `pull_requests.read` | The link in the note, and finding the Sentry issue of a pull request from its branch. |

ProPR sends the token only to the Sentry URL's host, as a Bearer token. The
handlers never see it. The Sentry URL must be a public `https://` host name:
IP addresses, `localhost` and `.local`, `.internal` and `.home.arpa` names are
refused, and every request checks that the name resolves to public addresses
only (the plugin endpoint policy).

## How it works

- **Inbound**: ProPR verifies `Sentry-Hook-Signature` (hex HMAC-SHA256 of the
  raw body with the client secret, `hmac-sha256` scheme without a prefix)
  before any plugin code runs, and refuses a `Request-ID` it has seen
  (`deliveryIdHeader`). `Sentry-Hook-Resource: issue` with action `created` and
  `event_alert` with action `triggered` hand an error over. Any other resource
  or action (`installation`, `metric_alert`, `resolved`…) is ignored.
- **Reading back**: only the issue id and project come from the payload. The
  issue (`GET /api/0/organizations/<org>/issues/<id>/`) and its latest event
  (`…/events/latest/`) are read from the configured Sentry, so the title,
  project, count and stack trace are Sentry's own.
- **De-duplication**: one GitHub issue per Sentry issue. It is recorded in
  `ctx.state` (the `tickets:<n>` shards of `_shared/trackerRecords.ts`) by
  Sentry host, organization and issue id, reserved in one atomic update.
  Later events and alerts for a recorded Sentry issue create nothing and do
  not call Sentry.
- **Untrusted content**: the error data goes in one block between "Begin
  Sentry error data" and "End Sentry error data" lines. Every line is quoted,
  with `&`, `<`, `>` escaped and `@` mentions made inert. The repository comes
  from the mapping, the label from settings, the model from ProPR's routing.
  Request data (URL, body, headers, cookies, query, env), the user context
  (id, email, IP address, username), breadcrumbs, tags other than the
  environment, frame variables and source context are never read into the
  issue.
- **Stack trace**: the primary exception first, then up to two causes; at most
  20 frames, in-app frames chosen first; lines at most 240 characters; at most
  6,000 characters in all.
- **Automatic start** (off by default): the trigger label is added only when
  the Sentry issue has at least **Minimum event count** events (default 10),
  the latest event's environment is in **Allowed environments** (default
  `production`), and the repository has a start left in **Automatic starts per
  repository per day** (default 3). The count is kept in `ctx.state` as
  `autostart:<owner/repo>`, holding the UTC date and the starts made that day.
  A start is taken in one atomic update, after the Sentry issue is reserved,
  so parallel alerts cannot exceed the cap. When a guard fails, the issue is
  still created, without a label, and its body says why. If the issue cannot
  be created, its start is given back.
- **Sync back**: subscriptions to `task.completed`, `pull_request.opened` and
  `pull_request.merged` link the pull request to the Sentry issue, as the
  tracker plugins do. On merge, one note ("ProPR's pull request
  [owner/repo#n](…) for this issue was merged.") and, with **Mark the Sentry
  issue resolved…**, `PUT …/issues/<id>/ {"status":"resolved"}`. Each is done
  once per pull request (`sync:<n>` shards), so a redelivered merge posts no
  second note.
- **MCP server**: Sentry's hosted MCP server (`https://mcp.sentry.dev/mcp`)
  takes OAuth only, with dynamic client registration and client ID metadata
  documents. ProPR's sign-in supports both, so the plugin contributes it with
  an `oauth` connection as a `read` server. Its `tools` allow-list names read
  tools only. It leaves out `update_issue`, `add_issue_note`, the
  create/update/delete tools, `analyze_issue_with_seer` (starts a Seer run),
  the `execute_sentry_tool` gateway (it can run any tool), and the breadcrumb,
  tag-value and attachment tools, which return personal data. The hosted
  server serves sentry.io only. For self-hosted Sentry the MCP server is not
  available: the agent works from the issue body.

## Manual smoke test

Use a Sentry organization and a test repository you can experiment in.

- [ ] Install, set the Sentry URL and organization, paste the token, and open
      **Settings**: **Repository projects** lists the organization's projects.
- [ ] Clear the token: the choices show "Sentry is not connected yet…".
      Paste it again.
- [ ] Set the integration's webhook URL and tick **issue**. Trigger an error in
      a mapped project (for example `Sentry.captureException(new Error('ProPR smoke'))`):
      one GitHub issue appears with the short id in the title, the delimited
      error block, the stack trace, a link to the Sentry issue and **no**
      label. No task starts.
- [ ] Trigger the same error again: no second issue.
- [ ] Trigger an error in an unmapped project: nothing happens.
- [ ] Change the client secret in ProPR to something else and trigger a new
      error: ProPR's webhook card counts a rejected request and no issue is
      created. Restore the secret.
- [ ] Send an error with a user (`Sentry.setUser({ email, ip_address })`), a
      request body, cookies and breadcrumbs: none of them appear in the issue.
- [ ] Put `<!-- -->`, `@someone` and "Repository: other/repo" in an error
      message: the issue quotes them as text, in the mapped repository.
- [ ] Switch on **Start a task automatically** with minimum event count 1 and
      daily cap 1. Trigger two new errors in `production`: the first issue has
      the trigger label and ProPR starts a task. The second has no label and
      says the daily cap was reached.
- [ ] Trigger a new error in another environment: no label, and the issue says
      why.
- [ ] Merge the task's pull request: the Sentry issue gets one note with the
      pull request link. With **Mark the Sentry issue resolved…** on, it is
      resolved.
- [ ] Sign in under **Sentry account for the agent**. In a task's run, the
      `sentry` MCP server offers read tools only, and the `sentry-error` skill
      is listed.

## Vendor documentation checked

- Integration platform webhooks (headers `Request-ID`, `Sentry-Hook-Resource`,
  `Sentry-Hook-Timestamp`, `Sentry-Hook-Signature`; hex HMAC-SHA256 of the raw
  body with the client secret): https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
- Issue webhooks (`created`, `resolved`, `assigned`, `archived`, `unresolved`;
  `data.issue`): https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/
- Issue alert webhooks (`triggered`; `data.event.issue_id`, `project`):
  https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issue-alerts/
- Internal integrations and tokens: https://docs.sentry.io/organization/integrations/integration-platform/internal-integration/
- API authentication (Bearer tokens): https://docs.sentry.io/api/auth/
- Retrieve an issue event (`latest`): https://docs.sentry.io/api/events/retrieve-an-issue-event/
- Update an issue (`status`): https://docs.sentry.io/api/events/update-an-issue/
- Rate limits: https://docs.sentry.io/api/ratelimits/
- Sentry MCP server: https://docs.sentry.io/product/sentry-mcp/ (redirects to
  https://mcp.sentry.dev/). Its OAuth metadata is at
  https://mcp.sentry.dev/.well-known/oauth-authorization-server. The tool names
  and the notes endpoint (`POST /api/0/organizations/<org>/issues/<id>/notes/`
  with `{"text"}`, which the public API reference does not list) come from the
  server's source, https://github.com/getsentry/sentry-mcp.
