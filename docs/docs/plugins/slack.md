---
sidebar_label: "Slack"
title: "Slack plugin"
description: "Post ProPR notifications to Slack channels through incoming webhooks: setup, events, destinations, message format and retries."
---
# Slack

The **Slack** plugin (`slack`) posts short ProPR notifications to Slack
channels through [incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
It only sends: nothing comes back from Slack in this mode. (A Slack app mode
with threads and mentions is planned; the manifest and settings leave room for
it.)

It is an official [plugin](../features/plugins.md) built only on the plugin
interface: a manifest, one [handler](../features/plugins.md#handlers) and
[event subscriptions](../features/plugins.md#event-subscriptions). The Slack,
Discord and Microsoft Teams plugins share their event selection, wording and
delivery rules (`packages/plugins/_shared/`); only the message format differs.

## Setup

1. In Slack, create an app for your workspace (or open an existing one), turn
   on **Incoming Webhooks**, choose **Add New Webhook to Workspace** and pick the
   channel. Copy the webhook URL: `https://hooks.slack.com/services/T…/B…/…`.
   See [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
2. In ProPR, open **Plugins**, choose **Slack** and install it. It asks for one
   permission, `events.read`.
3. Under **Connections**, paste the URL into **Default webhook URL**. ProPR
   accepts only `https://hooks.slack.com/services/…` (or
   `https://hooks.slack-gov.com/services/…` for GovSlack), stores it sealed and
   never shows it again.
4. Optionally add more webhooks (one per channel) as **Webhook URL 2** to **4**
   and map repositories to them in **Repository destinations**.
5. In **Settings**, keep or narrow **Events to post**, and set **ProPR address**
   (such as `https://propr.example.com`) so messages link to the task.
6. **Enable** the plugin.

### The webhook URL is a secret

Anyone with the URL can post to the channel, so ProPR treats it as a credential.
It is stored as a [webhook URL connection](../features/plugins.md#webhook-url-connections)
(a sealed `token` connection), never shown again, and never seen by the
plugin's handler: ProPR substitutes it when the request is sent and removes it
from the response, logs and error messages. A URL is accepted only on
`hooks.slack.com` and `hooks.slack-gov.com` (GovSlack), with a path under `/services/`. Clearing the connection stops the plugin posting there.

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

A message is a `text` fallback (shown in notifications) and
[Block Kit](https://docs.slack.dev/block-kit/) blocks: a `section` with the
title, a `section` of fields for the facts (at most 10) and a `context` line of
links in Slack's `<url|label>` form. `&`, `<` and `>` are escaped as Slack's
[formatting rules](https://docs.slack.dev/messaging/formatting-message-text)
require. Incoming webhooks cannot change the channel, user name or icon; those
come from the Slack app.

```json
{
  "text": "Pull request #12 merged in acme/api",
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": ":white_check_mark: *Pull request #12 merged in acme/api*" } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "<https://github.com/acme/api/pull/12|Pull request #12>  ·  <https://github.com/acme/api/issues/9|Issue #9>" }] }
  ]
}
```

Slack answers `200` with the body `ok`. Errors come with a plain-text code,
such as `invalid_payload`, `no_service`, `channel_not_found`,
`channel_is_archived` or `action_prohibited`, which the failure message
repeats.

## Delivery, retries and failures

Each selected event is one `POST` of JSON to its destination's webhook URL. The
delivery appears in the plugin's **Activity**.

- **Rate limits.** A `429` is retried after the service's `Retry-After`
  header. The delivery shows *retrying* with the next attempt at that time.
- **Server errors and timeouts** (`408`, `425`, `5xx`, network failures) are
  retried on the dispatcher's schedule, or after `Retry-After` when given.
- **Refusals.** Any other non-2xx answer marks the delivery *failed* at once,
  with a message such as `Slack refused the message to the default webhook with
  HTTP 404 (…); it is not retried. Check its webhook URL and that the channel
  still exists`. The service's own short error code is included when it gives
  one; its URL never is.
- **Missing or refused URL.** An unset webhook URL fails the delivery with `The
  Slack webhook URL of the default webhook is not set. Set it under
  Connections`. A stored URL that no longer passes the host check fails it
  too. After fixing the setting, use **Retry** on the failed delivery.

A retried message can be posted twice if the service accepted it but its answer
was lost; the services offer no idempotency key for webhook posts.
### Service limits

Slack allows about one incoming-webhook message per second per channel, with
short bursts, and answers `429` with `Retry-After` beyond that
([rate limits](https://docs.slack.dev/apis/web-api/rate-limits)).

## Settings

| Setting | Description |
| --- | --- |
| **Events to post** (`events`) | The events above; all by default. |
| **Review threshold** (`reviewThreshold`) | 0 to 100. Empty: the review's goal, or 80. |
| **ProPR address** (`proprUrl`) | The address people open ProPR at. Messages link to the task when it is set. |
| **Repository destinations** (`repositoryDestinations`) | `owner/repo` → `webhook-2`, `webhook-3`, `webhook-4` or `none`. |

## Testing it

CI cannot reach Slack, so the handler is tested against hand-written
fixtures of the service's payload format and error answers
(`packages/plugins/slack/fixtures/`). The plugin's
[README](https://github.com/integry/propr/blob/main/packages/plugins/slack/README.md)
has a manual smoke-test checklist to run against a real channel.

## Vendor documentation

- [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)
- [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text)
- [Block Kit](https://docs.slack.dev/block-kit/)
- [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)
