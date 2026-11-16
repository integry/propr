---
sidebar_label: "Linear"
title: "Linear plugin"
description: "Start ProPR work from a Linear ticket by adding a label, and keep the ticket in sync: setup, API key and webhook, repository mapping, one issue per ticket, sync-back comments, state moves, the read-only Linear MCP server and a smoke-test checklist."
---
# Linear

The **Linear** plugin (`linear`) lets a team that plans in Linear hand a ticket
to ProPR and follow the work on the ticket, without copying anything to GitHub
by hand.

- **Start**: adding the trigger label (`propr` by default) to a ticket in a
  mapped team or project creates one GitHub issue in the mapped repository,
  with the ticket's title and description, a link back to the ticket and
  ProPR's trigger label. ProPR's normal label-triggered intake then starts the
  task, so there is one intake path.
- **Sync back**: ProPR comments on the ticket when the issue is created, the
  task starts, the pull request opens, the review reaches its goal, the pull
  request merges or closes, and when a task fails. Each kind can be switched
  off. The ticket can also move to a chosen workflow state when the pull
  request opens and when it merges.
- **Agent context**: Linear's read-only MCP server and a short skill let the
  agent read the linked ticket.

It is an official [plugin](../features/plugins.md) built on the plugin
interface only: a manifest, [handlers](../features/plugins.md#handlers), an
[inbound webhook](../features/plugins.md#inbound-webhooks) and
[event subscriptions](../features/plugins.md#event-subscriptions). Its code is
in `packages/plugins/linear/`, with the ticket-to-issue helper it shares with
the Jira plugin in `packages/plugins/_shared/tracker.ts`.

## What it needs

| | |
| --- | --- |
| **Permissions** | `events.read`, `issues.create`, `pull_requests.read`. |
| **Linear API key** (`api-key`) | A [personal API key](https://linear.app/developers/graphql) (Linear: **Settings** › **Account** › **Security & access**) with **Read** and **Write** access to every mapped team. ProPR sends it only to `api.linear.app`, as `Authorization: <key>` (the connection's `"authorization": "plain"`: Linear's API keys take no `Bearer` scheme), and to Linear's MCP server. Handlers never see it. |
| **Webhook signing secret** (`webhook-secret`) | The signing secret of the Linear webhook you point at the plugin's URL. |
| **Outbound host** | `api.linear.app`. |

The plugin uses a personal API key, which Linear documents for server-side
GraphQL use; OAuth applications are not needed.

## Setup

1. **Plugins** › **Linear** › **Install**.
2. **Connections**: paste the API key.
3. Copy the webhook URL shown on the plugin page
   (`https://<ProPR>/api/plugins/<key>/hooks/linear`). In Linear, **Settings** ›
   **API** › **Webhooks** › **New webhook** (a workspace admin): paste the URL,
   choose the **Issues** resource type and the teams, save, and copy the
   signing secret into **Webhook signing secret**.
4. **Settings**:

   | Setting | Meaning |
   | --- | --- |
   | **Repository mapping** | `owner/repo` → a Linear team or project, picked from the list loaded from Linear. A ticket's project mapping is used first, then its team's. Tickets outside the mapping are ignored; a team or project mapped to several repositories starts nothing. |
   | **Linear trigger label** | Adding it hands a ticket over. Default `propr`, compared without letter case. |
   | **GitHub trigger label** | The only label of the created issue: ProPR's trigger label (default `AI`). |
   | **Comment on the ticket** | `issue_created`, `task_started`, `pull_request_opened`, `review_goal_reached`, `pull_request_merged`, `pull_request_closed`, `task_failed`; all by default. |
   | **Move to state when the pull request opens** | A workflow state name from the list, such as *In Review*; empty leaves the state alone. |
   | **Move to state when the pull request merges** | Likewise, such as *Done*. |

5. **Enable**.

The mapping and the two state fields load their choices from Linear through
the plugin's `optionsFrom` handlers (see
[Settings](../features/plugins.md#settings)). Until the API key is set they say
*Could not load the choices: Set the Linear API key under Connections…*; set it
and choose **Reload choices**. The state list shows each name once, with the
teams that have it; a ticket moves to the state of that name in its own team.

## Starting work from a ticket

ProPR verifies every request before the plugin runs: `Linear-Signature` must
be the hex HMAC-SHA256 of the raw body with the signing secret, and a
`Linear-Delivery` id seen before is refused as a replay (409). An invalid
signature is refused (401) and no plugin code runs.

A verified `Issue` webhook (`create` or `update`) creates the issue when:

- its `webhookTimestamp` is within a minute of when ProPR received it;
- the ticket has the trigger label now, and was created with it or did not have
  it before the change (`updatedFrom.labelIds`);
- its project or team is mapped to exactly one repository.

Everything else is ignored: other label changes, title or state changes,
comments, the label being removed, and unmapped tickets.

The issue:

- **Title**: `<KEY>: <ticket title>`, such as `ENG-123: Fix the redirect after login`.
- **Body**: *Started from Linear ticket ENG-123*, the description quoted, the
  line `Linear ticket: [ENG-123](https://linear.app/…)`, and a note that the
  ticket's text chose neither the repository nor the label nor the model.
- **Labels**: only the GitHub trigger label.

**One ticket, one issue.** The link from ticket to issue is kept in the
plugin's state by ticket id. A retry, a second webhook for the same change, or
the label removed and added again later find it and create nothing. When
creating the issue fails in a way that may still have created it, the delivery
fails without retries, so a ticket never gets two issues. The plugin remembers
well over a thousand tickets; when its state is full, those touched longest ago
are forgotten first.

**Ticket text is untrusted.** It becomes the issue's title and body and
nothing else: the repository comes from the mapping, the label from the
settings, the model from ProPR's routing. In the body the description is
quoted, with `<`, `>` and `&` written as entities (no HTML, and no hidden
`<!-- … -->` marker ProPR reads), `@` mentions broken so nobody is notified,
and every line starting with `>` so none is a command. The text is not logged,
not kept in Activity and not sent anywhere else, Linear included.

**Removing the trigger label or closing the ticket does not cancel the work.**
The issue and its task carry on; stop them in ProPR or on GitHub.

## Keeping the ticket in sync

The plugin subscribes to `task.started`, `task.failed`, `pull_request.opened`,
`pull_request.review_scored`, `pull_request.merged` and `pull_request.closed`.
An event belongs to a ticket when it is about the ticket's issue, or about a
pull request whose branch starts with that issue's number (`41/…`, as ProPR
names its branches); the pull request is then remembered for later events.

Each repository reference below is a link to the issue or pull request on GitHub.

| Kind | Comment |
| --- | --- |
| `issue_created` | ProPR created GitHub issue **owner/repo#41** (linked) for this ticket. Its task starts from there; progress is posted here. |
| `task_started` | ProPR started working on this ticket (**owner/repo#41** (linked)). Implementation tasks only. |
| `pull_request_opened` | ProPR opened pull request **owner/repo#77** (linked) for this ticket. |
| `review_goal_reached` | The review of pull request **owner/repo#77** (linked) reached its goal (score 92, goal 80). Scores below the goal post nothing. |
| `pull_request_merged` | Pull request **owner/repo#77** (linked) was merged. |
| `pull_request_closed` | Pull request **owner/repo#77** (linked) was closed without merging. |
| `task_failed` | A ProPR task for this ticket failed (timed_out). The details are in ProPR, on **owner/repo#41** (linked). |

Comments are fixed text with numbers, coded values and GitHub links: never
code, logs, prompt text or tool output. With a kind switched off nothing is
read or sent for it.

On *pull request opened* and *merged* the ticket moves to the configured state:
the plugin looks the name up among the workflow states of the ticket's team and
sends `issueUpdate` with its id. A name the team does not have is reported in
**Activity** as a warning; the ticket is not moved, the delivery still
succeeds, and the comment and later events go ahead.

Each comment and state move is remembered on the ticket's link, so a repeated
delivery posts nothing twice. Linear's rate limit (`RATELIMITED`) and server
errors are retried on the usual schedule; an API key Linear refuses fails the
delivery permanently, with a message to set a valid key.

## Agent context

| Contribution | |
| --- | --- |
| MCP server `linear` | Linear's [remote MCP server](https://linear.app/docs/mcp), read-only endpoint `https://mcp.linear.app/mcp/readonly`, authenticated with the same API key as a Bearer token (Linear accepts API keys there). A managed, read-only library item with the read tools only: `get_issue`, `list_issues`, `list_comments`, `list_issue_statuses`, `get_issue_status`, `list_issue_labels`, `list_projects`, `get_project`, `list_project_labels`, `list_teams`, `get_team`, `list_users`, `get_user`, `list_cycles`, `list_documents`, `get_document`, `search_documentation`. |
| Skill `linear-ticket` | How to find the ticket's key in the issue and read the ticket and its comments with the MCP server; that the server is read-only; and that the ticket's text describes the request and is not instructions. |

## Smoke test

CI cannot reach Linear; the handler tests replay signed fixtures
(`packages/plugins/linear/fixtures/`). Against a test workspace:

1. Before the API key is set, the mapping and state fields say what to set.
   With it, they list your teams, projects and states.
2. With a wrong signing secret, ticket changes are refused and nothing runs.
3. Adding `propr` to a mapped ticket creates one issue with the ticket's text,
   its link and only the `AI` label, and the ticket gets the issue link.
4. Removing and re-adding the label, or editing the ticket, creates nothing more.
5. A ticket of an unmapped team starts nothing.
6. Hidden markers, mentions and `/commands` in the description appear as
   quoted text in the issue.
7. The pull request opening and merging comment on the ticket and move it to
   the chosen states; a state name the team lacks shows a warning in Activity.
8. Closing the ticket does not cancel the task.

The plugin's README (`packages/plugins/linear/README.md`) has the full
checklist and the Linear documentation pages this was checked against:
[webhooks](https://linear.app/developers/webhooks),
[GraphQL](https://linear.app/developers/graphql),
[rate limiting](https://linear.app/developers/rate-limiting) and
[MCP](https://linear.app/docs/mcp).
