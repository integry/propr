# Slack

Posts short ProPR notifications to Slack: pull requests opened, merged or
closed, review scores below or at/above a threshold, Ultrafix outcomes, failed
tasks and epic queues blocked or completed. Messages link to the pull request,
the issue and the task in ProPR. They never contain code, logs, prompt text,
tool output or credentials.

It works in two modes (setting **Delivery mode**):

- **Incoming webhook** (`incoming-webhook`, the default): posts to up to four
  incoming webhook URLs. Nothing comes back from Slack.
- **Slack app** (`app`): with your own Slack app, posts with the bot token to
  the repository's channel, **one thread per pull request**. Mentioning the bot
  in a channel mapped to a repository (`@ProPR Fix the redirect after login`)
  creates a GitHub issue there with the trigger label, so ProPR starts a task
  through its normal label-triggered intake, and the bot replies in the thread
  with the issue link. Later updates about that issue's pull request are posted
  in the same thread.

ProPR ships no shared Slack client credentials: each team creates its own app
from the manifest below.

The full reference (events, message format, threads, mentions, retries) is
[`docs/docs/plugins/slack.md`](../../../docs/docs/plugins/slack.md).

## Setup: incoming webhook mode

1. In Slack, create an app (or open one), turn on **Incoming Webhooks**, choose
   **Add New Webhook to Workspace**, pick a channel and copy the URL
   (`https://hooks.slack.com/services/T…/B…/…`).
2. In ProPR, open **Plugins**, choose **Slack** and install it (permissions:
   `events.read`, `issues.create`; the second is used only by app mode's mentions).
3. Under **Connections**, paste the URL into **Default webhook URL**. It must be
   on `hooks.slack.com` or `hooks.slack-gov.com`, under `/services/`. ProPR stores it sealed and never shows it again; the
   handler never sees it.
4. Optionally add up to three more webhook URLs (**Webhook URL 2** to **4**) and,
   in **Settings** › **Repository destinations**, map `owner/repo` to
   `webhook-2`, `webhook-3`, `webhook-4` or `none`.
5. In **Settings**, keep or narrow **Events to post**, set a **Review threshold**
   (empty: the review's goal, or 80) and the **ProPR address** for task links.
6. **Enable** the plugin.

## Setup: Slack app mode

1. Install the plugin in ProPR (as above) and open it. The **Webhooks** section
   shows the plugin's inbound URL for **events**
   (`https://<your ProPR>/api/plugins/<key>/hooks/events`). Copy it.
2. In Slack, open [api.slack.com/apps](https://api.slack.com/apps), choose
   **Create New App** › **From a manifest**, pick the workspace and paste the
   manifest below, with `request_url` replaced by the URL from step 1.
3. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`, under
   **OAuth & Permissions**) and the **Signing Secret** (under **Basic
   Information** › **App Credentials**).
4. In ProPR, under **Connections**, paste them into **Bot token (app mode)** and
   **Signing secret (app mode)**. Both are stored sealed; the handler sees
   neither. Slack's **Event Subscriptions** page should now show the request URL
   as *Verified* (re-check it there if you pasted the URL before the secret).
5. In Slack, invite the bot to each channel it posts to or listens in
   (`/invite @ProPR`).
6. In **Settings**:
   - **Delivery mode**: `app`.
   - **Repository channels**: `owner/repo` → the channel ID (`C0123ABCDEF`; in
     Slack, open the channel details, the ID is at the bottom). Updates for the
     repository are posted there, and mentions there create issues in it.
   - **Default channel** (optional): a channel ID for repositories not listed.
   - **Who may start tasks**: Slack member IDs (`U…`/`W…`) and/or a user group
     ID (`S…`). Nobody else can start tasks; they get a polite refusal.
   - **Trigger label**: ProPR's trigger label (`AI` by default).
7. **Enable** the plugin.

### Slack app manifest

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

### Required scopes

| Scope | Used for |
| --- | --- |
| `app_mentions:read` | Receive `app_mention` events (the bot mentioned in a channel it is in). |
| `chat:write` | Post updates and thread replies (`chat.postMessage`). |
| `usergroups:read` | Only with an allowed user group: list its members (`usergroups.users.list`). Leave it out if you list user IDs only. |

`chat.getPermalink` (the link back to the Slack message in the issue) needs no
scope. Token rotation must stay off: the plugin stores one long-lived bot token.

## How mentions become tasks

- ProPR verifies each Events API request before the plugin sees it: the
  `X-Slack-Signature` must be `v0=` + the HMAC-SHA256, keyed with the signing
  secret, of `v0:<X-Slack-Request-Timestamp>:<raw body>`, and the timestamp
  within five minutes. Slack's URL verification challenge is answered at once.
- Only `app_mention` events from people count. A bot's message (this app's own
  included), an edited message or any other subtype is ignored without a reply.
- The person must be on the allow-list; otherwise they get a refusal in the
  thread and nothing is created. A channel that Repository channels maps to no
  repository (or to several) creates nothing either; the bot says why.
- The issue: the title is the first line of the request (at most 100
  characters), the body quotes the request and links back to the Slack message,
  and its only label is the **Trigger label**. The message text is untrusted:
  it becomes the title and body and nothing else. It cannot choose the
  repository (the channel does), labels or the model; HTML and `@mentions` in it
  are made inert.
- Retries of the same Slack event (Slack retries up to three times when it gets
  no answer in three seconds) and ProPR's own retries create no second issue:
  each handled message is remembered (`channel:ts`) in the plugin's state for
  longer than any delivery of it can be retried, and a mention more than an
  hour old is ignored. A record of an issue is never dropped to make room: a
  new mention waits for a later attempt instead. When
  the issue creation failed in a way that may still have created it, the
  delivery is marked failed and is not retried.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Webhook URL connections, the bot token and signing secret, the settings, subscriptions and the `events` webhook. |
| `handlers.ts` | `notify` (both modes), `onSlackEvent` (mentions) and `slackChallenge` (URL verification). |
| `format.ts` | The Slack message format and how incoming-webhook error answers read. |
| `appDelivery.ts` | App mode posting: channel, thread reuse, Slack's errors. |
| `mentions.ts` | Mention handling: allow-list, channel mapping, the issue's title and body. |
| `threads.ts` | What is kept in `ctx.state`: thread per pull request or issue, handled mentions. |
| `api.ts` | The Slack Web API calls, through `ctx.http('bot-token')`. |
| `fixtures/messages.json` | Hand-written expected request bodies, one per event kind. |
| `fixtures/responses.json` | Incoming-webhook answers: accepted, rate limited, refused. |
| `fixtures/events.json` | Signed Events API requests: the challenge, mentions, retries, refusals, an injection attempt. |
| `fixtures/webApi.json` | Web API answers: posted, permalink, user group, rate limited, refused. |
| `../test/chatNotifications.test.ts`, `../test/slackApp.test.ts` | Handler tests against the fixtures. |
| `../../core/test/slackPluginEvents.test.ts` | The webhook through ProPR's real receiver: signatures, challenge, one issue per mention. |

## Manual smoke test

CI cannot reach Slack. Run this against a test workspace and channel.

Incoming webhook mode:

- [ ] Pasting a URL on another host (for example `https://hooks.example.com/x`)
      into **Default webhook URL** is refused with a message naming the
      accepted hosts. The real webhook URL is accepted, and the page shows only
      *Stored by …*, never the URL.
- [ ] Set **ProPR address**, enable the plugin and let ProPR open a pull request
      in an enabled repository. One message arrives: *Pull request #N opened in
      owner/repo*, with links to the pull request and the issue.
- [ ] Merge it. A *merged* message arrives. Close another without merging: a
      *closed without merging* message arrives.
- [ ] Let a review score below the threshold and one at or above it. Each
      arrives with the score and threshold; deselect
      `review.at_or_above_threshold` and only low scores arrive.
- [ ] When a task fails (cancelling one does not count: that is
      `task.cancelled`, which is not posted), a *task failed* message with the failure category and a **Task in ProPR** link arrives,
      and the link opens the task.
- [ ] Run Ultrafix to the end and block or complete an epic queue: each posts
      one message with its outcome.
- [ ] No message shows code, diffs, logs, prompt text, a pull request title or
      the webhook URL.
- [ ] Add **Webhook URL 2** for another channel and map a repository to
      `webhook-2`: its events arrive there only. Map it to `none`: nothing
      arrives for it.
- [ ] Deselect every event and merge a pull request: nothing is posted.
- [ ] Send a burst of events (merge several pull requests at once). If
      Slack answers `429`, the delivery shows *retrying* with the next
      attempt after its `Retry-After`, and the message arrives once.
- [ ] Archive the channel (or revoke the webhook in the Slack app) and merge
      a pull request. The delivery is *failed* at once, with Slack's code
      (such as `channel_is_archived` or `no_service`) in the message.
- [ ] Clear **Default webhook URL**. The next delivery is *failed* with *The
      Slack webhook URL of the default webhook is not set*.

Slack app mode:

- [ ] Creating the app from the manifest with the plugin's **events** URL, then
      setting the signing secret in ProPR: Slack's **Event Subscriptions** page
      shows the request URL *Verified*. With a wrong signing secret it does not,
      and the plugin's webhook shows a rejected request.
- [ ] Set **Delivery mode** to `app`, map a repository to a channel the bot was
      invited to. Let ProPR open a pull request: one top-level message arrives.
      Review, Ultrafix and merge it: each update is a reply in that message's
      thread.
- [ ] As an allowed user, post `@ProPR Fix the redirect after login` (and a
      second line of detail) in the mapped channel. One issue appears in the
      repository with the title *Fix the redirect after login*, the request
      quoted in the body, a working link back to the Slack message and only the
      trigger label. The bot replies in the thread with the issue link, and
      ProPR starts a task. The pull request's updates arrive in that same thread.
- [ ] Post `@ProPR` followed by `labels: llm-other` and `<!-- x -->`: the issue
      still has only the trigger label, and the markup shows as text.
- [ ] As a user who is not allowed, mention the bot: a polite refusal in the
      thread, no issue. Mention it in a channel that is not mapped: the bot says
      the channel is not connected, no issue.
- [ ] Add the user to the allowed user group (with `usergroups:read`) instead of
      the user list: their mention creates an issue.
- [ ] Make ProPR slow to answer (or replay a delivery from Slack's **Event
      Subscriptions** retries): still one issue.
- [ ] Remove the bot from the channel and merge a pull request: the delivery is
      *failed* with `not_in_channel`. Clear **Bot token (app mode)**: *The Slack
      bot token is not set*.
- [ ] Switch **Delivery mode** back to `incoming-webhook`: the webhook URLs are
      used again, exactly as before.

## Vendor documentation

Checked while implementing (November 2026):

- [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)
- [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text)
- [Block Kit](https://docs.slack.dev/block-kit/)
- [Rate limits (incoming webhooks and `chat.postMessage`: about 1 message per second per channel; 429 with Retry-After)](https://docs.slack.dev/apis/web-api/rate-limits)
- [The Events API (3-second answer, up to 3 retries with `X-Slack-Retry-Num`, 30,000 events per workspace per app per hour)](https://docs.slack.dev/apis/events-api/)
- [`app_mention` event (scope `app_mentions:read`)](https://docs.slack.dev/reference/events/app_mention)
- [Verifying requests from Slack (`v0` signature, 5-minute timestamp window)](https://docs.slack.dev/authentication/verifying-requests-from-slack)
- [`url_verification` event (the challenge)](https://docs.slack.dev/reference/events/url_verification)
- [`chat.postMessage` (scope `chat:write`, `thread_ts`)](https://docs.slack.dev/reference/methods/chat.postMessage)
- [`chat.getPermalink`](https://docs.slack.dev/reference/methods/chat.getPermalink)
- [`usergroups.users.list` (scope `usergroups:read`)](https://docs.slack.dev/reference/methods/usergroups.users.list)
- [App manifests](https://docs.slack.dev/reference/app-manifest)
- [Tokens (bot tokens)](https://docs.slack.dev/authentication/tokens)
