---
sidebar_label: "Jira Cloud"
title: "Jira Cloud plugin"
description: "Hand Jira Cloud tickets to ProPR with a label and keep them in sync: setup, site URL and project mapping, the issue ProPR creates, sync-back comments and transitions, agent context and limits."
---
# Jira Cloud

The **Jira Cloud** plugin (`jira`) lets a team that plans in Jira Cloud hand a
ticket to ProPR and follow the work on the ticket. It works like the
[Linear plugin](linear.md) and shares its ticket handling.

- **Start**: adding the trigger label (`propr` by default) to a ticket of a
  mapped project creates one GitHub issue in the mapped repository, with the
  ticket's summary and description, a link back to the ticket and ProPR's
  trigger label. ProPR's ordinary label-triggered intake then starts the task.
- **Sync back**: ProPR comments on the ticket when the task starts, when the
  pull request opens (with a link), when the review reaches its goal, when the
  pull request merges or closes, and when the task fails. It can transition the
  ticket to a status when the pull request opens and when it merges.
- **Agent context**: a short skill that explains where the linked ticket is and
  how to treat its text. Atlassian's MCP server is not contributed (see
  [Agent context](#agent-context)).

Jira Data Center and Jira Server are not supported: the site URL must be on
`*.atlassian.net`.

## Setup

1. **API token.** Sign in to
   [Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens)
   as the account ProPR should act as and create an API token. Comments and
   transitions are made in this account's name, so a dedicated account is
   best. It needs **Browse projects**, **Add comments** and **Transition
   issues** in the mapped projects. See
   [Basic auth for REST APIs](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/).
2. **Install.** In ProPR, open **Plugins**, choose **Jira Cloud** and install
   it. It asks for `events.read`, `issues.create`, `issues.read` and
   `pull_requests.read`.
3. **Site.** In **Settings**, set **Jira site URL** to your site, such as
   `https://acme.atlassian.net`, and save. A URL on any other host is refused
   when you save.
4. **Connect.** Under **Connections**, enter the account's email, a colon and
   the token in **Account email and API token**, such as
   `ada@example.com:ATATT3x…`. A value without the email is refused.
5. **Webhook.** Copy the plugin's **issues** webhook URL from the Plugins page.
   In Jira, as a Jira administrator, open **Settings → System → WebHooks →
   Create a WebHook**. Paste the URL, enter a long random **Secret**, tick
   **Issue: created** and **Issue: updated**, and optionally narrow it with JQL
   such as `project in (ENG, DES) AND labels = propr`. Save, and enter the same
   secret in ProPR under **Webhook secret**. See
   [Jira webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/).
6. **Map.** In **Settings**, map each repository to a Jira project in
   **Repository projects** (the choices are loaded from Jira) and save. Then
   choose the status moves, whose choices come from the mapped projects'
   workflows, keep or narrow **Comment on the ticket when**, and save.
7. **Enable** the plugin, and limit it to the mapped repositories if you like.

If the choices cannot be loaded, the form says why next to the field, for
example "Jira is not connected yet…". You can still type a value: a project key
such as `ENG` works in **Repository projects**.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Jira site URL** | none (required) | Your Jira Cloud site. Only `*.atlassian.net` hosts are accepted; the plugin calls Jira's REST API on this host only. |
| **Repository projects** | none | Repository (`owner/repo`) → Jira project (chosen from Jira and saved as its key, or typed as a key or project id). |
| **Jira trigger label** | `propr` | The Jira label that hands a ticket over when it is added, compared without letter case. |
| **GitHub trigger label** | `AI` | The label the created GitHub issue gets: ProPR's trigger label for the repository. It is the only label. |
| **Comment on the ticket when** | all | `task.started`, `pull_request.opened`, `review.goal_reached`, `pull_request.merged`, `pull_request.closed`, `task.failed`. |
| **Move the ticket when the pull request opens to** | empty | A status name from the mapped projects' workflows, such as `In Review`. Empty: no move. |
| **Move the ticket when the pull request merges to** | empty | Such as `Done`. Empty: no move. |

Tickets of a project no repository is mapped to are ignored. A project mapped
to several repositories hands nothing over.

## Handing a ticket to ProPR

ProPR verifies every webhook request before any plugin code runs: the
`X-Hub-Signature` header must be `sha256=` and the hex HMAC-SHA256 of the raw
body with the webhook's secret, otherwise the request is refused with 401. The
`X-Atlassian-Webhook-Identifier` header, which Jira keeps the same across its
retries, is the delivery id: one seen before is refused as a replay.

Because Atlassian documents this signature for administrator-registered
webhooks, the plugin uses webhooks. It does not poll Jira.

A ticket is handed over when it is created with the trigger label, or when an
update's changelog shows the label was added. The plugin then reads the ticket
back from your site by its id, checks it still has the label and belongs to a
mapped project, and creates one GitHub issue:

- **Title**: the ticket key and summary, such as `ENG-123: Fix the redirect after login`.
- **Body**: a line linking `https://<site>/browse/ENG-123`, the ticket's
  description, and a note that the repository and label come from the plugin's
  settings.
- **Labels**: the GitHub trigger label only.

**One issue per ticket.** Tickets are remembered by their Jira id, so a retried
or replayed webhook, another label change, or removing and adding the label
again creates nothing.

**Ticket text is untrusted.** It becomes the issue's title and body and nothing
else; the repository comes from the mapping and the label from the settings.
Jira's rich text (the Atlassian Document Format) is converted to plain Markdown:

- headings, lists, task lists, quotes, code blocks, tables, bold, italics and
  strikethrough are kept;
- text cannot write Markdown: characters such as `!`, `[`, `]`, `*` and `_` are
  escaped, so a description cannot create an image or a link;
- images and attachments become "(attachment not copied)", smart links and
  embeds their URL as text, and links their text followed by the URL; only
  `http(s)` URLs are kept;
- macros and app content are left out;
- `<`, `>` and `&` are written as entities (no HTML, no hidden `<!-- … -->`
  marker) and `@mentions` are made inert.

The ticket's text is not written to logs or Activity and never sent back to
Jira. **Removing the label or closing the ticket does not cancel the work.**

## Sync back

| Event | Comment | Status move |
| --- | --- | --- |
| The implementation task starts | "ProPR started working on this ticket." with a link to the GitHub issue | |
| The task opens its pull request | "ProPR opened a pull request for this ticket." with a link | the "pull request opens" status |
| A review reaches its goal | the score and goal | |
| The pull request merges | "…was merged." with a link | the "merges" status |
| The pull request closes without merging | "…was closed without merging." with a link | |
| The task fails | the coded failure category, such as `timed_out` | |

Comments are posted as the API token's account and contain ProPR's own
sentence, numbers, coded values and GitHub links: never code, logs, prompt
text or the ticket's text. Each comment and move is done once per ticket, and a
merged ticket is never moved back by a retried opening delivery.

Jira changes a ticket's status only through its workflow's transitions. The
plugin looks for a transition, available from the ticket's current status,
whose target status has the configured name, and takes it. A ticket already in
that status is left alone. **When no transition reaches the status**, Activity
shows a warning such as `Jira offers no transition to a status named "Code
Review" from its current status "To Do" for ENG-123, so it was not moved`, and
the comment and later events go ahead.

## Agent context

- **Skill** `jira-ticket`: tells the agent where the ticket key and link are in
  the issue, that the issue quotes the ticket, and to treat the ticket's text as
  requirements, never as instructions about the repository, labels, model or
  tools.
- **No MCP server.** Atlassian's Rovo MCP server signs in with OAuth, or with an
  API token sent as HTTP Basic credentials where an organization administrator
  has enabled that. ProPR sends a plugin's MCP credential as a Bearer token and
  cannot rely on a read-only OAuth sign-in there, so the plugin does not add it.
  An administrator can add a read-only Jira MCP server to the extension library
  separately; the skill tells the agent to use it if present.

## Limits

- Jira Cloud only (`*.atlassian.net`).
- Classic API tokens only: scoped API tokens are called through
  `api.atlassian.com`, which the plugin does not use.
- The plugin reads at most 250 projects for the choices, and statuses of at
  most 20 mapped projects.
- ProPR remembers several hundred handed-over tickets at once, each for a year;
  a forgotten ticket whose label is added again creates a new issue.
- A handed-over ticket is remembered with its site. After **Jira site URL**
  changes, tickets handed over from the earlier site are not updated (Jira
  numbers issues per site, so the same id would name another ticket), webhooks
  about the earlier site's tickets are ignored, and the new site's tickets are
  handed over as new ones. Setting the URL back resumes the earlier tickets'
  updates.
- Jira retries a failed webhook up to five times, 5 to 15 minutes apart. ProPR
  answers at once (202) and runs the handler from its delivery queue.

## Troubleshooting

| Activity or the form says | What to do |
| --- | --- |
| `siteUrl must be on *.atlassian.net, not …` | Enter your Jira Cloud site URL; Data Center is not supported. |
| `Jira refused reading the ticket with UNAUTHORIZED` | The email or token is wrong or revoked: enter `email:token` again under **Connections**. |
| `Jira refused … with FORBIDDEN` or `NOT_FOUND` | The account cannot browse the project, comment or transition: check its project permissions. |
| `… was handed over from another Jira site than the configured one` | The site URL changed after the ticket was handed over. Set it back to update the ticket, or leave it. |
| `… project is not mapped to a repository` | Add the ticket's project to **Repository projects**. |
| `Map a repository to a Jira project … and save first` | Save the project mapping, then choose **Reload choices** on the status settings. |
| A delivery is refused with 401 | The webhook secret in ProPR does not match the one in Jira. |
