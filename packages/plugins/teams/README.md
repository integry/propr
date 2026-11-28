# Microsoft Teams

Posts short ProPR notifications to Microsoft Teams through a Workflows webhook (Adaptive Cards):
pull requests opened, merged or closed, review scores below or at/above a
threshold, Ultrafix outcomes, failed tasks and epic queues blocked or
completed. Messages link to the pull request, the issue and the task in ProPR.
They never contain code, logs, prompt text, tool output or credentials.

The full reference (events, message format, retries) is
[`docs/docs/plugins/teams.md`](../../../docs/docs/plugins/teams.md).

## Setup

1. In Teams, open the channel's **More options (…)** › **Workflows**, choose
   **Send webhook alerts to a channel** (or a flow with the *When a Teams
   webhook request is received* trigger and *Post card in a chat or channel*),
   set **Who can trigger the flow** to **Anyone**, save and copy the URL.
   Office 365 connector URLs (`…webhook.office.com`) were retired in May 2026
   and are refused.
2. In ProPR, open **Plugins**, choose **Microsoft Teams** and install it (permission:
   `events.read`).
3. Under **Connections**, paste the URL into **Default webhook URL**. It must be
   on `*.environment.api.powerplatform.com` under `/powerautomate/automations/direct/workflows/`, or `*.logic.azure.com` under `/workflows/`. ProPR stores it sealed and never shows it again; the
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
| `format.ts` | The Teams message format and how its error answers read. |
| `fixtures/messages.json` | Hand-written expected request bodies, one per event kind. |
| `fixtures/responses.json` | Teams answers: accepted, rate limited, refused. |
| `../_shared/notifications.ts`, `../_shared/chatDelivery.ts` | Wording, destinations and delivery shared with the other chat plugins. |
| `../test/chatNotifications.test.ts` | Handler tests against the fixtures. |

## Manual smoke test

CI cannot reach Microsoft Teams. Run this against a test channel.

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
      Microsoft Teams answers `429`, the delivery shows *retrying* with the next
      attempt after its `Retry-After`, and the message arrives once.
- [ ] The card renders in the Teams desktop and mobile clients, with the
      facts and one button per link. If the template posts nothing, open the
      flow's run history in Power Automate: ProPR only sees `202 Accepted`.
- [ ] Turn the workflow off (or delete it) and merge a pull request. The delivery
      is *failed* with the workflow's error code, and is not retried.
- [ ] Clear **Default webhook URL**. The next delivery is *failed* with *The
      Teams webhook URL of the default webhook is not set*.

Microsoft Teams answers a successful post with `202 Accepted`; a refusal such as `404 {"error": {"code": "WorkflowNotFound", …}}`
fails the delivery with `…HTTP 404 (WorkflowNotFound); it is not retried…`.

## Vendor documentation

Checked while implementing (November 2026):

- [Create an Incoming Webhook (Workflows; connector retirement)](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
- [Send Adaptive Cards using an incoming webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using)
- [Create incoming webhooks with Workflows for Microsoft Teams](https://support.microsoft.com/en-us/teams/apps-service/create-incoming-webhooks-with-workflows-for-microsoft-teams)
- [Microsoft Teams webhook trigger](https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook)
- [Limits: 28 KB messages; more than 4 requests a second are throttled](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
