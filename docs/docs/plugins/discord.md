---
sidebar_label: "Discord"
title: "Discord plugin"
description: "Post ProPR notifications to Discord channels as embeds through channel webhooks: setup, events, destinations, message format and retries."
---
# Discord

The **Discord** plugin (`discord`) posts short ProPR notifications to Discord
channels as embeds, through [channel webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook).

It is an official [plugin](../features/plugins.md) built only on the plugin
interface: a manifest, one [handler](../features/plugins.md#handlers) and
[event subscriptions](../features/plugins.md#event-subscriptions). The Slack,
Discord and Microsoft Teams plugins share their event selection, wording and
delivery rules (`packages/plugins/_shared/`); only the message format differs.

## Setup

1. In Discord, open the channel's **Edit Channel** › **Integrations** ›
   **Webhooks**, choose **New Webhook**, name it (for example *ProPR*) and
   **Copy Webhook URL**: `https://discord.com/api/webhooks/<id>/<token>`. See
   [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).
2. In ProPR, open **Plugins**, choose **Discord** and install it. It asks for one
   permission, `events.read`.
3. Under **Connections**, paste the URL into **Default webhook URL**. ProPR
   stores it sealed and never shows it again. It is required to enable the
   plugin; the other webhook URLs are optional.
4. Optionally add webhooks of other channels as **Webhook URL 2** to **4** and
   map repositories to them in **Repository destinations**.
5. In **Settings**, keep or narrow **Events to post**, and set **ProPR address**
   so messages link to the task.
6. **Enable** the plugin.

### The webhook URL is a secret

Anyone with the URL can post to the channel, so ProPR treats it as a credential.
It is stored as a [webhook URL connection](../features/plugins.md#webhook-url-connections)
(a sealed `token` connection), never shown again, and never seen by the
plugin's handler: ProPR substitutes it when the request is sent and removes it
from the response, logs and error messages. A URL is accepted only on
`discord.com`, `discordapp.com`, `ptb.discord.com` and `canary.discord.com`, with a path under `/api/webhooks/` or `/api/v10/webhooks/`. Clearing the connection stops the plugin posting there.

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

A message is one [embed](https://docs.discord.com/developers/resources/message#embed-object):
its title (at most 256 characters) links to the pull request, or to the first
link; its colour follows the outcome; the facts are inline fields (at most 25);
its description holds the links. The user name is *ProPR* and
`allowed_mentions` is empty, so no message can ping anyone. Markdown characters
in values are escaped.

```json
{
  "username": "ProPR",
  "allowed_mentions": { "parse": [] },
  "embeds": [{
    "title": "Pull request #12 merged in acme/api",
    "url": "https://github.com/acme/api/pull/12",
    "color": 3046706,
    "fields": [],
    "description": "[Pull request #12](https://github.com/acme/api/pull/12) · [Issue #9](https://github.com/acme/api/issues/9)"
  }]
}
```

Discord answers `204 No Content`. Errors are JSON such as
`{"message": "Unknown Webhook", "code": 10015}`; the failure message repeats the
message and code.

## Delivery, retries and failures

Each selected event is one `POST` of JSON to its destination's webhook URL. The
delivery appears in the plugin's **Activity**.

- **Rate limits.** A `429` is retried after the service's `Retry-After`
  header (or, without it, the `retry_after` seconds in Discord's JSON body). The delivery shows *retrying* with the next attempt at that time.
- **Server errors and timeouts** (`408`, `425`, `5xx`, network failures) are
  retried on the dispatcher's schedule, or after `Retry-After` when given.
- **Refusals.** Any other non-2xx answer marks the delivery *failed* at once,
  with a message such as `Discord refused the message to the default webhook with
  HTTP 404 (…); it is not retried. Check its webhook URL and that the channel
  still exists`. The service's own short error code is included when it gives
  one; its URL never is.
- **Missing or refused URL.** The plugin cannot be enabled without the
  default webhook URL, and it cannot be cleared while the plugin is enabled.
  An unset webhook URL fails the delivery with `The Discord webhook URL of
  the default webhook is not set. Set it under Connections` (or the name of
  the optional webhook Repository destinations sends to). A stored URL that no longer passes the host check fails it
  too. After fixing the setting, use **Retry** on the failed delivery.

A retried message can be posted twice if the service accepted it but its answer
was lost; the services offer no idempotency key for webhook posts.
### Service limits

Discord rate-limits each webhook. A `429` carries `Retry-After` and a
JSON body whose `retry_after` is in seconds
([rate limits](https://docs.discord.com/developers/topics/rate-limits)). Repeated
`401`, `403` and `429` answers can get an IP address blocked for a while, and so
can retrying a webhook that answers `404`, which is why ProPR never retries a
refusal.

## Settings

| Setting | Description |
| --- | --- |
| **Events to post** (`events`) | The events above; all by default. |
| **Review threshold** (`reviewThreshold`) | 0 to 100. Empty: the review's goal, or 80. |
| **ProPR address** (`proprUrl`) | The address people open ProPR at. Messages link to the task when it is set. |
| **Repository destinations** (`repositoryDestinations`) | `owner/repo` → `webhook-2`, `webhook-3`, `webhook-4` or `none`. |

## Testing it

CI cannot reach Discord, so the handler is tested against hand-written
fixtures of the service's payload format and error answers
(`packages/plugins/discord/fixtures/`). The plugin's
[README](https://github.com/integry/propr/blob/main/packages/plugins/discord/README.md)
has a manual smoke-test checklist to run against a real channel.

## Vendor documentation

- [Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)
- [Embed object and limits](https://docs.discord.com/developers/resources/message#embed-object)
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
