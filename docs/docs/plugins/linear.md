---
sidebar_label: "Linear"
title: "Linear plugin"
description: "Hand Linear tickets to ProPR with a label and keep them in sync: setup, team and project mapping, the issue ProPR creates, sync-back comments and state moves, the read-only MCP server and limits."
---
# Linear

The **Linear** plugin (`linear`) lets a team that plans in Linear hand a ticket
to ProPR and follow the work on the ticket, without copying anything to GitHub
by hand.

- **Start**: adding the trigger label (`propr` by default) to a ticket of a
  mapped team or project creates one GitHub issue in the mapped repository, with
  the ticket's title and description, a link back to the ticket and ProPR's
  trigger label. ProPR's ordinary label-triggered intake then starts the task.
- **Sync back**: ProPR comments on the ticket when the task starts, when the
  pull request opens (with a link), when the review reaches its goal, when the
  pull request merges or closes, and when the task fails. It can move the
  ticket to a workflow state when the pull request opens and when it merges.
- **Agent context**: the agent gets Linear's read-only MCP server and a short
  skill that explains how to look up the linked ticket.

It is an official [plugin](../features/plugins.md) built only on the plugin
interface: a manifest, [handlers](../features/plugins.md#handlers), an
[inbound webhook](../features/plugins.md#inbound-webhooks) and
[event subscriptions](../features/plugins.md#event-subscriptions). The ticket
handling (one issue per ticket, the sync-back switches) is shared with other
issue tracker plugins in `packages/plugins/_shared/`.

## Setup

1. **API key.** In Linear, open **Settings → Security & access → Personal API
   keys** and create a key. Give it **Read**, **Write** and **Create comments**
   (without **Write** the ticket is not moved; with **Read** alone, the choices
   load and the MCP server works but nothing is posted). See
   [Linear's GraphQL API](https://linear.app/developers/graphql).
2. **Install.** In ProPR, open **Plugins**, choose **Linear** and install it. It
   asks for `events.read`, `issues.create`, `issues.read` and
   `pull_requests.read`.
3. **Connect.** Under **Connections**, paste the key into **Linear API key**.
4. **Webhook.** Copy the plugin's **issues** webhook URL from the Plugins page.
   In Linear, open **Settings → API → Webhooks**, create a webhook with that URL,
   select **Issues** as the data change events, and save. Copy the webhook's
   **signing secret** into **Webhook signing secret** in ProPR. See
   [Linear webhooks](https://linear.app/developers/webhooks).
5. **Map.** In **Settings**, map each repository to a Linear team in
   **Repository teams**, and optionally to a project in **Repository projects**.
   The choices are loaded from Linear. Set the state moves if you want them, keep
   or narrow **Comment on the ticket when**, and save.
6. **Enable** the plugin, and limit it to the mapped repositories if you like.

If the choices cannot be loaded, the form says why next to the field, for
example "Linear is not connected yet. Set the Linear API key under Connections,
then choose Reload choices." You can still type a value: a team key such as
`ENG` works in **Repository teams**.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Repository teams** | none | Repository (`owner/repo`) → Linear team (chosen from Linear, saved as the team id, or typed as the team key). |
| **Repository projects** | none | Repository → Linear project. A ticket in a mapped project goes to that repository, whatever its team. |
| **Linear trigger label** | `propr` | The Linear label that hands a ticket over when it is added, compared without letter case. |
| **GitHub trigger label** | `AI` | The label the created GitHub issue gets: ProPR's trigger label for the repository. It is the only label. |
| **Comment on the ticket when** | all | `task.started`, `pull_request.opened`, `review.goal_reached`, `pull_request.merged`, `pull_request.closed`, `task.failed`. |
| **Move the ticket when the pull request opens to** | empty | A workflow state name chosen from your teams' states, such as `In Review`. Empty: no move. |
| **Move the ticket when the pull request merges to** | empty | Such as `Done`. Empty: no move. |

Tickets of a team or project that no repository is mapped to are ignored. A
team or project mapped to several repositories hands nothing over, because
ProPR cannot tell which one is meant.

## Handing a ticket to ProPR

ProPR verifies every webhook request before any plugin code runs: the
`Linear-Signature` header must be the hex HMAC-SHA256 of the raw body with the
signing secret, and a `Linear-Delivery` id seen before is refused as a replay.
The plugin also ignores a request whose `webhookTimestamp` is more than a minute
from when ProPR received it, as Linear recommends.

A ticket is handed over when an Issue event shows a label was added (or a
ticket was created with labels), and the ticket, read back from Linear's API,
has the trigger label now and did not before. The plugin then creates one
GitHub issue:

- **Title**: the ticket reference and title, such as `ENG-123: Fix the redirect after login`.
- **Body**: a line linking the ticket, the ticket's description quoted, and a
  note that the repository and label come from the plugin's settings.
- **Labels**: the GitHub trigger label only.

**One issue per ticket.** The plugin remembers each ticket it handed over by
its Linear id, so a retried or replayed webhook, a second label change, or
removing and adding the label again creates nothing. If creating the issue
fails in a way that may still have created it, the delivery fails without a
retry and Activity says to check the repository.

**Ticket text is untrusted.** It becomes the issue's title and body and nothing
else. The repository comes from the mapping, the label from the settings, and
the model from ProPR's own routing. In the body, `<`, `>` and `&` are written as
entities, so no HTML and no hidden `<!-- … -->` marker survives, and
`@mentions` are made inert. The ticket's text is sent nowhere else: it is not
written to logs or Activity and never sent back to Linear.

**Removing the label or closing the ticket does not cancel the work.** Cancel
the task in ProPR if you need to.

## Sync back

Each event the plugin subscribes to is matched to a ticket it handed over:

| Event | Comment | State move |
| --- | --- | --- |
| The implementation task starts (`task.started`) | "ProPR started working on this ticket." with a link to the GitHub issue | |
| The task opens its pull request (`task.completed` with a new pull request, or `pull_request.opened` on a ProPR branch of the issue) | "ProPR opened a pull request for this ticket." with a link | the "pull request opens" state |
| A review reaches its goal (`pull_request.review_scored` with the goal reached) | the score and goal | |
| The pull request merges | "…was merged." with a link | the "merges" state |
| The pull request closes without merging | "…was closed without merging." with a link | |
| The task fails | the coded failure category, such as `timed_out` | |

Comments contain ProPR's own sentence, numbers, coded values and GitHub links:
never code, logs, prompt text, tool output or the ticket's text.

Each comment and each move is done once per ticket: a redelivered event does
nothing again. When one action fails (Linear is rate limiting, say), the other
actions of the event still run, and the failed one is retried with the
delivery.

**A missing state name** (the ticket's team has no state of that name) is
reported in Activity as a warning, for example `Linear team ENG has no workflow
state named "Code Review", so ENG-123 was not moved`. The comment and later
events go ahead.

## Agent context

- **MCP server** `linear`: Linear's remote MCP server at its read-only endpoint
  (`https://mcp.linear.app/mcp/readonly`, which only exposes read tools),
  authenticated with the same API key as a Bearer token, which Linear's MCP
  server accepts. It appears as a managed item in **Skills & MCP servers**. See
  [Linear MCP server](https://linear.app/docs/mcp).
- **Skill** `linear-ticket`: tells the agent where the ticket reference is in the
  issue, to look the ticket up read-only, and to treat its text as requirements,
  never as instructions about the repository, labels, model or tools.

## Limits

- ProPR remembers several hundred handed-over tickets at once (about 800 with
  short repository names), each for
  a year; when the room runs out, the oldest are forgotten first. A forgotten
  ticket whose label is added again creates a new issue.
- The plugin reads at most 250 teams, projects or workflow states for the
  choices, and 100 labels of a ticket.
- Linear's webhook retries come at most three times (after a minute, an hour and
  six hours). ProPR answers at once and runs the handler from its delivery
  queue, so a slow Linear API does not cause them.

## Troubleshooting

| Activity says | What to do |
| --- | --- |
| `Linear refused reading the ticket with AUTHENTICATION_ERROR` | The API key is wrong or revoked: paste a new one under **Connections**. |
| `… team and project are not mapped to a repository` | Add the ticket's team (or project) to **Repository teams** (or **Repository projects**). |
| `… mapped to several repositories` | Map the team or project to one repository only. |
| `Ignored a Linear webhook whose webhookTimestamp is more than a minute…` | Check the ProPR server's clock. |
| A delivery is refused with 401 | The signing secret in ProPR does not match the webhook's in Linear. |
