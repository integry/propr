# Discord

Posts short ProPR notifications to Discord through channel webhooks (embeds):
pull requests opened, merged or closed, review scores below or at/above a
threshold, Ultrafix outcomes, failed tasks and epic queues blocked or
completed. Messages link to the pull request, the issue and the task in ProPR.
They never contain code, logs, prompt text, tool output or credentials.

The full reference (events, message format, retries) is
[`docs/docs/plugins/discord.md`](../../../docs/docs/plugins/discord.md).

## Setup

1. In Discord, open the channel's **Edit Channel** › **Integrations** ›
   **Webhooks**, choose **New Webhook** and **Copy Webhook URL**
   (`https://discord.com/api/webhooks/<id>/<token>`).
2. In ProPR, open **Plugins**, choose **Discord** and install it (permission:
   `events.read`).
3. Under **Connections**, paste the URL into **Default webhook URL**. It must be
   on `discord.com`, `discordapp.com`, `ptb.discord.com` or `canary.discord.com`, under `/api/webhooks/` or `/api/v10/webhooks/`. ProPR stores it sealed and never shows it again; the
   handler never sees it.
4. Optionally add up to three more webhook URLs (**Webhook URL 2** to **4**) and,
   in **Settings** › **Repository destinations**, map `owner/repo` to
   `webhook-2`, `webhook-3`, `webhook-4` or `none`.
5. In **Settings**, keep or narrow **Events to post**, set a **Review threshold**
   (empty: the review's goal, or 80) and the **ProPR address** for task links.
6. **Enable** the plugin.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Four webhook URL connections (`token` with `secretUrl`), the settings and the subscriptions. |
| `handlers.ts` | `notify`: posts one message per selected event to its destination. |
| `format.ts` | The Discord message format and how its error answers read. |
| `fixtures/messages.json` | Hand-written expected request bodies, one per event kind. |
| `fixtures/responses.json` | Discord answers: accepted, rate limited, refused. |
| `../_shared/notifications.ts`, `../_shared/chatDelivery.ts` | Wording, destinations and delivery shared with the other chat plugins. |
| `../test/chatNotifications.test.ts` | Handler tests against the fixtures. |

## Manual smoke test

CI cannot reach Discord. Run this against a test channel.

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
      Discord answers `429`, the delivery shows *retrying* with the next
      attempt after its `Retry-After`, and the message arrives once.
- [ ] No message pings anyone: `@everyone` is never in a message and
      `allowed_mentions` is empty.
- [ ] Delete the webhook in Discord and merge a pull request. The delivery is
      *failed* at once with `Unknown Webhook, code 10015`, and is not retried.
- [ ] Clear **Default webhook URL**. The next delivery is *failed* with *The
      Discord webhook URL of the default webhook is not set*.

Discord answers a successful post with `204 No Content`; a refusal such as `404 {"message": "Unknown Webhook", "code": 10015}`
fails the delivery with `…HTTP 404 (Unknown Webhook, code 10015); it is not retried…`.

## Vendor documentation

Checked while implementing (November 2026):

- [Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)
- [Embed object and embed limits](https://docs.discord.com/developers/resources/message#embed-object)
- [Rate limits (429 body retry_after in seconds, Retry-After header, invalid request limit)](https://docs.discord.com/developers/topics/rate-limits)
- [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
