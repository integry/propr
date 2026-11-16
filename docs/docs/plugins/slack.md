---
sidebar_label: "Slack"
title: "Slack plugin"
description: "Post ProPR notifications to Slack through incoming webhooks or your own Slack app (one thread per pull request), and start tasks by mentioning the bot: setup, app manifest, events, threads, mentions, message format and retries."
---
# Slack

The **Slack** plugin (`slack`) posts short ProPR notifications to Slack. It has
two modes, chosen with the **Delivery mode** setting:

- **Incoming webhook** (`incoming-webhook`, the default): posts to channels
  through [incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
  It only sends: nothing comes back from Slack.
- **Slack app** (`app`): with your own Slack app, posts with its bot token,
  grouping the updates about one pull request in one thread. Mentioning the bot
  in a channel mapped to a repository creates a GitHub issue that starts a task
  (see [Slack app mode](#slack-app-mode)).

It is an official [plugin](../features/plugins.md) built only on the plugin
interface: a manifest, one [handler](../features/plugins.md#handlers) and
[event subscriptions](../features/plugins.md#event-subscriptions). The Slack,
Discord and Microsoft Teams plugins share their event selection, wording and
delivery rules (`packages/plugins/_shared/`); only the message format differs.

## Setup: incoming webhook mode

1. In Slack, create an app for your workspace (or open an existing one), turn
   on **Incoming Webhooks**, choose **Add New Webhook to Workspace** and pick the
   channel. Copy the webhook URL: `https://hooks.slack.com/services/T…/B…/…`.
   See [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
2. In ProPR, open **Plugins**, choose **Slack** and install it. It asks for two
   permissions: `events.read`, and `issues.create`, which only app mode's
   mentions use.
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

## Slack app mode

With its own Slack app, a team gets one thread per pull request and can start
work by mentioning the bot. ProPR ships no shared Slack client credentials:
each team creates its app from the manifest below, and ProPR stores that app's
bot token and signing secret.

### Setup

1. Install the plugin and open it. Copy the URL of the **events** webhook from
   its **Webhooks** section (`https://<your ProPR>/api/plugins/<key>/hooks/events`,
   see [inbound webhooks](../features/plugins.md#inbound-webhooks)).
2. On [api.slack.com/apps](https://api.slack.com/apps) choose **Create New App**
   › **From a manifest**, pick the workspace and paste the manifest, with
   `request_url` set to that URL.
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`)
   and the **Signing Secret** (**Basic Information** › **App Credentials**).
4. In ProPR, under **Connections**, paste them into **Bot token (app mode)**
   (`bot-token`) and **Signing secret (app mode)** (`signing-secret`). Both are
   sealed. The bot token is sent only to `slack.com`, as `Authorization: Bearer`;
   the signing secret only verifies requests. The handler sees neither.
5. Invite the bot to each channel (`/invite @ProPR`).
6. In **Settings**, set **Delivery mode** to `app`, map repositories to channel
   IDs in **Repository channels**, optionally set a **Default channel**, list
   who may start tasks and check the **Trigger label**. Enable the plugin.

```yaml
_metadata:
  major_version: 2
  minor_version: 1
display_information:
  name: ProPR
  description: ProPR notifications in one thread per pull request; mention the bot to start a task.
features:
  bot_user:
    display_name: ProPR
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - usergroups:read
settings:
  event_subscriptions:
    request_url: https://propr.example.com/api/plugins/<key>/hooks/events
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

| Bot scope | Used for |
| --- | --- |
| `app_mentions:read` | The `app_mention` event: the bot mentioned in a channel it is in. |
| `chat:write` | Posting updates and thread replies with `chat.postMessage`. |
| `usergroups:read` | Only with **Who may start tasks: Slack user group ID**: `usergroups.users.list`. |

`chat.getPermalink`, used for the link back to the Slack message, needs no
scope. Keep token rotation off. App mode talks to `slack.com` only (GovSlack
workspaces can use incoming-webhook mode).

### Verification

ProPR verifies every request to the **events** webhook before any plugin code
runs, with the `slack-v0` [scheme](../features/plugins.md#inbound-webhooks):
`X-Slack-Signature` must be `v0=` followed by the hex HMAC-SHA256, keyed with
the signing secret, of `v0:<X-Slack-Request-Timestamp>:<raw body>`, and the
timestamp within five minutes of ProPR's clock. A request that fails is
refused with `401` and counted on the plugin page. Slack's
[`url_verification`](https://docs.slack.dev/reference/events/url_verification)
challenge is answered at once with the `challenge` value as plain text, by the
plugin's `slackChallenge` respond function. Other events are acknowledged
immediately and handled from ProPR's delivery queue, so Slack always gets its
answer within its three seconds.

### Threads

In app mode each selected event is posted with `chat.postMessage` to the
repository's channel (its **Repository channels** entry, otherwise the
**Default channel**; with neither, the delivery fails with *No Slack channel is
set for owner/repo*). The first message about a pull request starts its thread;
every later event about that pull request is a reply in it. The plugin keeps
the mapping in its state (`ctx.state`): `thread:<owner/repo>#<pr>` → channel and
thread timestamp. An issue created from a mention maps to the mention's thread,
and its pull request then reuses that thread. Events without a pull request
(a failed task) use the issue's thread when there is one. The newest 150
mappings are kept; older pull requests start a new thread. If the thread's
first message was deleted (`thread_not_found`), a new thread is started.

**Repository destinations** keeps one meaning in app mode: `none` posts nothing
for the repository. The message format is the same in both modes.

### Mentions start tasks

A mention such as

```text
@ProPR Fix the redirect after login
Users land on /home instead of the page they asked for.
```

in a channel mapped to `acme/api`, from an allowed person, creates one GitHub
issue in `acme/api`:

- **Title**: the first line, at most 100 characters (`Fix the redirect after login`).
- **Body**: the request quoted as written, a link back to the Slack message and
  a note that it came from Slack. ProPR appends its plugin attribution marker.
- **Labels**: only the **Trigger label** (`AI` by default), so ProPR starts a
  task through the normal [label-triggered intake](../tutorials/usage.md). Creating an issue,
  rather than a task directly, keeps one intake path: the same model routing,
  limits and reviews apply.

The bot replies in the thread with the issue link, and the issue's pull
request is then posted in the same thread.

Nothing is created when:

| Case | What happens |
| --- | --- |
| The person is not in **Who may start tasks** (user IDs, or members of the user group) | A polite refusal in the thread. With neither setting, nobody may start tasks. |
| The channel is not in **Repository channels**, or is mapped to several repositories | The bot replies that the channel is not connected (or is ambiguous). |
| The message is from a bot (this app's own included), edited, or has another subtype | Ignored; no reply. |
| The mention has no text | The bot replies with an example. |
| The plugin is not enabled for the repository | The bot says the issue could not be created; the delivery fails. |

**The message text is untrusted.** It becomes the issue's title and body and
nothing else: the repository comes from the channel, the label from the
settings, and the model from ProPR's own routing. Slack markup is turned into
plain text, then `&`, `<` and `>` are written as entities (no HTML, and no
hidden `<!-- … -->` marker ProPR could read) and `@mentions` are broken so
nobody on GitHub is notified. Words such as `labels: llm-…`, `/model …` or
`repo: other/repo` in a request are just text in the issue body.

**Retries.** Slack retries an event it got no answer for up to three times
(`X-Slack-Retry-Num`), and ProPR retries a failed delivery. Each handled
message is remembered by `channel:ts`, so neither creates a second issue; a
reply that failed after the issue was created is posted on the next attempt.
A mention is only taken in within an hour of being posted, and a message that
created (or may have created) an issue is remembered for longer than any
delivery of it can still be retried, so a late retry cannot create a second
issue either. If too many recent mentions are remembered to take in another,
the new mention waits for a later attempt rather than forget one of them.
If creating the issue failed in a way that may still have created it (a lost
answer), the delivery is marked failed and not retried, so a request creates
at most one issue.

Replies and updates never repeat the request text. The issue is the only place
it goes.

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
In app mode, `chat.postMessage` errors come as HTTP 200 with `{"ok": false,
"error": "…"}`: `ratelimited` (or HTTP 429 with `Retry-After`) and Slack's
server errors (`internal_error`, `fatal_error`, `service_unavailable`,
`request_timeout`) are retried; any other code, such as `not_in_channel`,
`channel_not_found`, `invalid_auth` or `missing_scope`, fails the delivery at
once with the code in the message. An unset bot token fails it with *The Slack
bot token is not set*.

### Service limits

Slack allows about one incoming-webhook or `chat.postMessage` message per
second per channel, with short bursts, and answers `429` with `Retry-After`
beyond that ([rate limits](https://docs.slack.dev/apis/web-api/rate-limits)).
The Events API sends at most 30,000 events per workspace per app per hour and
expects an answer within three seconds
([Events API](https://docs.slack.dev/apis/events-api/)).

## Settings

| Setting | Description |
| --- | --- |
| **Events to post** (`events`) | The events above; all by default. |
| **Review threshold** (`reviewThreshold`) | 0 to 100. Empty: the review's goal, or 80. |
| **ProPR address** (`proprUrl`) | The address people open ProPR at. Messages link to the task when it is set. |
| **Repository destinations** (`repositoryDestinations`) | `owner/repo` → `webhook-2`, `webhook-3`, `webhook-4` or `none`. In app mode only `none` applies. |
| **Delivery mode** (`mode`) | `incoming-webhook` (default) or `app`. |
| **Repository channels (app mode)** (`repositoryChannels`) | `owner/repo` → Slack channel ID (`C0123ABCDEF`). Updates go there; mentions there create issues in that repository. |
| **Default channel (app mode)** (`defaultChannel`) | Channel ID for repositories not listed. Mentions in it start nothing unless it is also mapped. |
| **Who may start tasks: Slack user IDs** (`allowedUsers`) | Member IDs (`U…`, `W…`) whose mentions create issues. |
| **Who may start tasks: Slack user group ID** (`allowedUserGroup`) | A user group (`S…`) whose members may also start tasks; needs `usergroups:read`. |
| **Trigger label** (`triggerLabel`) | The only label of issues created from Slack; ProPR's trigger label (`AI` by default). |

## Testing it

CI cannot reach Slack, so the handlers are tested against hand-written
fixtures of the service's payload format and answers
(`packages/plugins/slack/fixtures/`): signed Events API requests (the
challenge, mentions, a retried event, refusals and an injection attempt) and
Web API answers. `packages/plugins/test/slackApp.test.ts` covers mentions,
threads, retries and a sentinel check that no Slack message carries code,
logs, prompt text, tool output, credentials or the request text;
`packages/core/test/slackPluginEvents.test.ts` sends the signed fixtures
through ProPR's real webhook receiver. The plugin's
[README](https://github.com/integry/propr/blob/main/packages/plugins/slack/README.md)
has a manual smoke-test checklist to run against a real channel.

## Vendor documentation

- [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)
- [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text)
- [Block Kit](https://docs.slack.dev/block-kit/)
- [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)
- [The Events API](https://docs.slack.dev/apis/events-api/)
- [`app_mention`](https://docs.slack.dev/reference/events/app_mention) and [`url_verification`](https://docs.slack.dev/reference/events/url_verification)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack)
- [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage), [`chat.getPermalink`](https://docs.slack.dev/reference/methods/chat.getPermalink), [`usergroups.users.list`](https://docs.slack.dev/reference/methods/usergroups.users.list)
- [App manifests](https://docs.slack.dev/reference/app-manifest)
- [Tokens](https://docs.slack.dev/authentication/tokens)
