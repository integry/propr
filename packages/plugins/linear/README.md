# Linear

Hands Linear tickets to ProPR and keeps them in sync. Adding the trigger label
(`propr` by default) to a ticket of a team or project mapped to a repository
creates one GitHub issue there with ProPR's trigger label, so ProPR's ordinary
label-triggered intake starts the task. ProPR then comments on the ticket as
the work moves on and can move it to workflow states. User documentation:
[`docs/docs/plugins/linear.md`](../../../docs/docs/plugins/linear.md).

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | Permissions, connections, settings (with `optionsFrom`), the read-only MCP server, the skill, subscriptions and the `issues` webhook. |
| `handlers.ts` | `onLinearWebhook`, `syncBack`, and the `teamOptions`, `projectOptions` and `stateOptions` choice loaders. |
| `intake.ts` | The webhook: label-added detection, mapping and the hand-off (through `../_shared/trackerIssue.ts`). |
| `sync.ts` | Sync-back comments and state moves (planned by `../_shared/trackerSync.ts`). |
| `settings.ts` | Setting keys, the team/project → repository mapping and the choice loaders. |
| `api.ts` | Linear GraphQL calls through `ctx.http('api-key')`. |
| `skills/linear-ticket/` | The skill telling the agent how to look up the linked ticket. |
| `fixtures/` | Signed webhook bodies (`webhooks.json`) and GraphQL answers (`graphql.json`) for the tests. |

Tests: `packages/plugins/test/linear.test.ts` (handlers) and
`packages/core/test/linearPluginEvents.test.ts` (signature checks, replays and
the options loader through ProPR's real receiver and runner).

## Setup

1. In Linear, **Settings → Security & access → Personal API keys**: create a key
   (see below for its permissions).
2. In ProPR, **Plugins → Linear → Install**.
3. **Connections → Linear API key**: paste the key.
4. Copy the **issues** webhook URL from the plugin's page. In Linear, **Settings
   → API → Webhooks → New webhook**: paste the URL, select the **Issues** data
   change events, save, and copy the webhook's signing secret into
   **Connections → Webhook signing secret**.
5. **Settings**: map repositories to teams (**Repository teams**) and,
   optionally, projects (**Repository projects**); choices are loaded from
   Linear. Choose the state moves and the comment events. Save.
6. **Enable**.

## Permissions and scopes

| Where | What | Why |
| --- | --- | --- |
| Linear API key | **Read** | Read the ticket (labels, team, project, title, description), teams, projects and workflow states; Linear's read-only MCP server. |
| Linear API key | **Create comments** | The sync-back comments. |
| Linear API key | **Write** | The state moves (`issueUpdate`). Without it, leave the state settings empty. |
| Linear webhook | **Issues** data change events | The label changes that hand tickets over. Nothing else is needed. |
| ProPR | `events.read` | The task and pull request events for sync-back. |
| ProPR | `issues.create` | The GitHub issue for a ticket. |
| ProPR | `issues.read`, `pull_requests.read` | The links in comments, and finding the ticket of a pull request from its branch. |

ProPR sends the key only to `api.linear.app`, as the whole `Authorization`
header (Linear's personal API keys take no `Bearer` scheme, so the connection
declares `"authorization": "raw"`), and to Linear's MCP server as a Bearer
token, which that server accepts. The handlers never see it.

## How it works

- **Inbound**: ProPR verifies `Linear-Signature` (hex HMAC-SHA256 of the raw
  body, `hmac-sha256` scheme) before any plugin code runs and refuses a
  `Linear-Delivery` id it has seen (`deliveryIdHeader`). The handler ignores a
  `webhookTimestamp` more than 60 seconds from when ProPR received the request,
  any event that is not an Issue create or a label change, and reads the ticket
  back with GraphQL before deciding. One ticket creates at most one issue:
  tickets are remembered by id in `ctx.state` (`tickets:<n>` shards).
- **Untrusted text**: the ticket's title and description only become the
  issue's title and body, quoted with `&`, `<`, `>` escaped and `@` mentions
  made inert. The repository comes from the mapping, the label from settings.
- **Outbound**: subscriptions to `task.started`, `task.completed`,
  `task.failed`, `pull_request.opened`, `pull_request.review_scored`,
  `pull_request.merged` and `pull_request.closed`. Each comment and move is
  done once per ticket (`sync:<n>` shards). A missing state name is a warning in
  Activity and the rest goes ahead.
- **MCP server**: Linear offers a remote MCP server that accepts an API key as
  a Bearer token, so the plugin contributes it, at the read-only endpoint
  `https://mcp.linear.app/mcp/readonly`, as a `read` server. Linear does not
  publish its tool names; the `tools` allow-list in the manifest names the read
  tools of Linear's server as listed by MCP clients, and a name the server does
  not have is simply never offered. Check the list against the server's
  `tools/list` when upgrading.

## Manual smoke test

Use a Linear workspace you can experiment in and a test repository.

- [ ] Install, paste the API key, and open **Settings**: **Repository teams**,
      **Repository projects** and both state settings list Linear's teams,
      projects and states.
- [ ] Clear the API key: the choices show "Linear is not connected yet…" and
      text boxes. Paste it again and choose **Reload choices**.
- [ ] Create the Linear webhook with the plugin's URL and signing secret. Add
      any label to a ticket: the plugin's Activity shows an `onLinearWebhook`
      delivery that succeeded.
- [ ] Change the signing secret in ProPR to something else and add a label to a
      ticket: Linear's delivery shows 401 and ProPR's webhook card counts a
      rejected request; no issue is created. Restore the secret.
- [ ] Map a repository to a team, enable the plugin, and add the `propr` label to
      a ticket of that team: one GitHub issue appears with the reference in its
      title, a link to the ticket and the `AI` label; ProPR starts a task.
- [ ] Remove and add the label again, and edit the ticket: no second issue.
- [ ] Add the label to a ticket of an unmapped team: nothing happens.
- [ ] Put `<!-- -->`, `@someone` and "Repository: other/repo" in a ticket's
      description and hand it over: the issue quotes them as text, in the mapped
      repository, with only the trigger label.
- [ ] As the task runs: the ticket gets "ProPR started working on this ticket.",
      then "ProPR opened a pull request…" with a link, and moves to the opened
      state; after merging, "…was merged." and the merged state.
- [ ] Set the opened state to a name the team does not have: Activity shows the
      warning, the comment is still posted.
- [ ] Untick an event in **Comment on the ticket when**: that comment is no
      longer posted.
- [ ] No comment contains code, logs or the ticket's text.
- [ ] In a task's run, the `linear` MCP server is available and offers read
      tools only; the `linear-ticket` skill is listed.

## Vendor documentation checked

- GraphQL API, endpoint and authentication (`Authorization: <API_KEY>` for
  personal API keys, `Bearer` for OAuth tokens): https://linear.app/developers/graphql
- Webhooks (`Linear-Signature`, `Linear-Delivery`, `webhookTimestamp`,
  `updatedFrom`, retries): https://linear.app/developers/webhooks
- Rate limiting: https://linear.app/developers/rate-limiting
- MCP server (`https://mcp.linear.app/mcp`, read-only `/mcp/readonly`, API key
  as Bearer): https://linear.app/docs/mcp
