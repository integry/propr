---
sidebar_label: "Microsoft Teams"
title: "Microsoft Teams plugin"
description: "Post ProPR notifications to Microsoft Teams channels or chats as Adaptive Cards through a Workflows webhook: setup, events, destinations, message format and retries."
---
# Microsoft Teams

The **Microsoft Teams** plugin (`teams`) posts short ProPR notifications to a
Teams channel or chat as [Adaptive Cards](https://learn.microsoft.com/en-us/adaptive-cards/),
through a webhook of the Teams **Workflows** app (Power Automate's *When a Teams
webhook request is received* trigger).

Office 365 connectors, including connector-based incoming webhooks
(`…webhook.office.com` URLs), were retired in May 2026. Microsoft's replacement is
the Workflows app, and its URLs are the ones this plugin accepts
([Create an Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)).

It is an official [plugin](../features/plugins.md) built only on the plugin
interface: a manifest, one [handler](../features/plugins.md#handlers) and
[event subscriptions](../features/plugins.md#event-subscriptions). The Slack,
Discord and Microsoft Teams plugins share their event selection, wording and
delivery rules (`packages/plugins/_shared/`); only the message format differs.

## Setup

1. In Teams, open the channel's **More options (…)** › **Workflows**, pick the
   template **Send webhook alerts to a channel** (or build a flow with the
   *When a Teams webhook request is received* trigger and a *Post card in a chat
   or channel* action), set **Who can trigger the flow** to **Anyone**, choose
   the team and channel, and save. Copy the webhook URL. It looks like
   `https://<environment>.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/…?…&sig=…`.
   See [Create incoming webhooks with Workflows for Microsoft Teams](https://support.microsoft.com/en-us/teams/apps-service/create-incoming-webhooks-with-workflows-for-microsoft-teams).
2. In ProPR, open **Plugins**, choose **Microsoft Teams** and install it. It asks
   for one permission, `events.read`.
3. Under **Connections**, paste the URL into **Default webhook URL**. ProPR
   stores it sealed and never shows it again. It is required to enable the
   plugin; the other webhook URLs are optional.
4. Optionally add workflows of other channels as **Webhook URL 2** to **4** and
   map repositories to them in **Repository destinations**.
5. In **Settings**, keep or narrow **Events to post**, and set **ProPR address**
   so the card links to the task.
6. **Enable** the plugin.

### The webhook URL is a secret

Anyone with the URL can post to the channel, so ProPR treats it as a credential.
It is stored as a [webhook URL connection](../features/plugins.md#webhook-url-connections)
(a sealed `token` connection), never shown again, and never seen by the
plugin's handler: ProPR substitutes it when the request is sent and removes it
from the response, logs and error messages. A URL is accepted only on
any `*.environment.api.powerplatform.com` host with a path under `/powerautomate/automations/direct/workflows/` (Workflows), and any `*.logic.azure.com` host with a path under `/workflows/` (Azure Logic Apps HTTP triggers; Power Automate stopped accepting its old `logic.azure.com` trigger URLs). Clearing the connection stops the plugin posting there.

## What is posted

| Choice in **Events to post** | Posted when |
| --- | --- |
| `pull_request.opened` | ProPR opens a pull request. |
| `review.below_threshold` | A review scores below the **Review threshold**. |
| `review.at_or_above_threshold` | A review scores at or above the **Review threshold**. |
| `pull_request.ultrafix_ended` | An Ultrafix run ends, with its outcome (`goal_reached`, `cycles_exhausted`, `style_findings_only`, `stopped` or `failed`) and final score. |
| `pull_request.merged` | A pull request is merged. |
| `pull_request.closed` | A pull request is closed without merging. |
| `task.failed` | A task fails, with its coded failure category, agent, model, attempts and duration. |
| `epic_queue.blocked` | An epic queue is blocked, with the issue it is blocked at. |
| `epic_queue.completed` | An epic queue completes. |

All nine are selected by default. The review threshold is the **Review
threshold** setting; when it is empty, the review's own goal is used, or 80 when
the review has none. A score equal to the threshold is "at or above".

Messages are short: one title line, a few facts and links to the pull
request, the issue and, when **ProPR address** is set, the task in the ProPR UI.
They are built only from numbers, identifiers, coded states (such as
`timed_out` or `goal_reached`) and links made from the repository name. They
never contain code, diffs, logs, prompt text, agent or tool output, pull
request or issue titles, free-text reasons (such as the Ultrafix reason or why
an epic queue is blocked) or credentials. A test sends every event with
sentinel values in each of those places and checks that none reaches a
message, a log line or a result (`packages/plugins/test/chatNotifications.test.ts`).

### Destinations

Each plugin has four webhook URL connections: **Default webhook URL**
(`default-webhook`) and **Webhook URL 2** to **4** (`webhook-2` to `webhook-4`).
Every event goes to the default webhook unless **Repository destinations**
names another one for its repository:

| Repository (`owner/repo`) | Destination |
| --- | --- |
| `acme/web` | `webhook-2` |
| `acme/sandbox` | `none` |

Repository names are compared without letter case. `none` posts nothing for
that repository. A destination that is not one of `default-webhook`,
`webhook-2`, `webhook-3`, `webhook-4` or `none` fails the delivery with a
message naming the repository. To limit the plugin to some repositories
altogether, use the plugin's repository limit on the Plugins page.

## Message format

A message is a `message` with one Adaptive Card attachment
(`application/vnd.microsoft.card.adaptive`, card version 1.2): a bold title
`TextBlock` coloured by outcome, a `FactSet` of the facts and an
`Action.OpenUrl` button per link, as the
[Workflows webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using#send-adaptive-cards-using-an-incoming-webhook)
expects.

```json
{
  "type": "message",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "contentUrl": null,
    "content": {
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.2",
      "body": [{ "type": "TextBlock", "text": "Pull request #12 merged in acme/api", "weight": "Bolder", "size": "Medium", "wrap": true, "color": "good" }],
      "actions": [
        { "type": "Action.OpenUrl", "title": "Pull request #12", "url": "https://github.com/acme/api/pull/12" },
        { "type": "Action.OpenUrl", "title": "Issue #9", "url": "https://github.com/acme/api/issues/9" }
      ]
    }
  }]
}
```

The workflow answers `202 Accepted` once it has the request; whether the card
was then posted shows in the workflow's run history in Power Automate, not in
ProPR. Errors are JSON such as `{"error": {"code": "WorkflowNotFound", …}}`; the
failure message repeats the code.

## Delivery, retries and failures

Each selected event is one `POST` of JSON to its destination's webhook URL. The
delivery appears in the plugin's **Activity**.

- **Rate limits.** A `429` is retried after the service's `Retry-After`
  header. The delivery shows *retrying* with the next attempt at that time.
- **Server errors and timeouts** (`408`, `425`, `5xx`, network failures) are
  retried on the dispatcher's schedule, or after `Retry-After` when given.
- **Refusals.** Any other non-2xx answer marks the delivery *failed* at once,
  with a message such as `Teams refused the message to the default webhook with
  HTTP 404 (…); it is not retried. Check its webhook URL and that the channel
  still exists`. The service's own short error code is included when it gives
  one; its URL never is.
- **Missing or refused URL.** The plugin cannot be enabled without the
  default webhook URL, and it cannot be cleared while the plugin is enabled.
  An unset webhook URL fails the delivery with `The Teams webhook URL of
  the default webhook is not set. Set it under Connections` (or the name of
  the optional webhook Repository destinations sends to). A stored URL that no longer passes the host check fails it
  too. After fixing the setting, use **Retry** on the failed delivery.

A retried message can be posted twice if the service accepted it but its answer
was lost; the services offer no idempotency key for webhook posts.
### Service limits

Teams messages are limited to 28 KB (a ProPR card is under 2 KB). More
than four requests a second to a webhook are throttled with `429`.

## Settings

| Setting | Description |
| --- | --- |
| **Events to post** (`events`) | The events above; all by default. |
| **Review threshold** (`reviewThreshold`) | 0 to 100. Empty: the review's goal, or 80. |
| **ProPR address** (`proprUrl`) | The address people open ProPR at. Messages link to the task when it is set. |
| **Repository destinations** (`repositoryDestinations`) | `owner/repo` → `webhook-2`, `webhook-3`, `webhook-4` or `none`. |

## Testing it

CI cannot reach Microsoft Teams, so the handler is tested against hand-written
fixtures of the service's payload format and error answers
(`packages/plugins/teams/fixtures/`). The plugin's
[README](https://github.com/integry/propr/blob/main/packages/plugins/teams/README.md)
has a manual smoke-test checklist to run against a real channel.

## Vendor documentation

- [Create an Incoming Webhook (Workflows)](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
- [Send Adaptive Cards using an incoming webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using)
- [Create incoming webhooks with Workflows for Microsoft Teams](https://support.microsoft.com/en-us/teams/apps-service/create-incoming-webhooks-with-workflows-for-microsoft-teams)
- [Microsoft Teams webhook trigger](https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook)
- [Adaptive Cards](https://learn.microsoft.com/en-us/adaptive-cards/)
