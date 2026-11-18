---
sidebar_label: "Outbound webhooks"
title: "Outbound webhooks plugin"
description: "Send ProPR events as signed JSON to any HTTPS endpoint: setup, the versioned envelope, the signature and delivery behaviour."
---
# Outbound webhooks

The **Outbound webhooks** plugin (`webhooks`) sends ProPR events as signed JSON
`POST` requests to HTTPS endpoints you choose. Use it to connect services that
have no plugin of their own: an internal dashboard, an automation platform, a
chat bot you run yourself.

It is an official [plugin](../features/plugins.md) built only on the plugin
interface: a manifest, one [handler](../features/plugins.md#handlers) and
[event subscriptions](../features/plugins.md#event-subscriptions).

## Setup

1. Open **Plugins**, choose **Outbound webhooks** and install it. It asks for one
   permission, `events.read`.
2. In **Settings**, enter **Target 1 URL**, for example
   `https://hooks.example.com/propr`. Targets 2 and 3 are optional.
3. For each target, choose its **events** (all of them by default) and,
   optionally, its **repositories** (`owner/repo`; empty means every repository
   the plugin is enabled for).
4. Under **Connections**, set **Target 1 signing secret**, and one for each
   other target you use. Use a random value of at least 32 characters, for
   example `openssl rand -hex 32`, and configure the same value on the
   receiving endpoint. A target without a secret receives nothing. Target 1's
   secret is required to enable the plugin.
5. Optionally limit the plugin to some repositories, then **Enable** it.

Deliveries start with the next event. Earlier events are not replayed. Each
delivery appears in the plugin's **Activity** list with its status, attempts and
error.

### Allowed endpoints

Target URLs are entered by an administrator, so the plugin's
[outbound hosts](../features/plugins.md#outbound-http-and-secrets) are derived
from them: its manifest declares
`"outboundHostsFromSettings": ["target1Url", "target2Url", "target3Url"]` and
`ctx.http` reaches only the hosts of the URLs saved there.

- **When saving**, a target URL must be `https://`, on the default port, with a
  host name (not an IP address), without a user name, password or `#fragment`,
  and not a local name (`localhost`, `*.local`, `*.internal` and similar). The
  host must also resolve to public addresses only. Plain HTTP, private,
  loopback, link-local and reserved addresses are refused with a message on the
  field.
- **On every request**, the host must be one derived from the saved settings and
  must still resolve to public addresses only. The checked address is the one
  dialled, and redirects are not followed.

## Events

| Event | Sent when |
| --- | --- |
| `pull_request.opened` | A pull request was opened |
| `pull_request.review_scored` | A review was scored |
| `pull_request.ultrafix_ended` | An Ultrafix loop ended |
| `pull_request.merged` | A pull request was merged |
| `pull_request.closed` | A pull request was closed without merging |
| `task.queued`, `task.started` | A task was queued, or started running |
| `task.completed`, `task.failed`, `task.cancelled` | A task finished |
| `epic_queue.blocked` | An epic queue's head issue is blocked |
| `epic_queue.completed` | An epic queue finished |

Each event is sent once to each target whose events include it and whose
repository filter, if any, includes the event's repository (compared without
letter case).

## The request

```http
POST /propr HTTP/1.1
Host: hooks.example.com
Content-Type: application/json
User-Agent: ProPR-Webhooks/1
X-ProPR-Event: pull_request.merged
X-ProPR-Delivery: evt-4211-deliver.target-1
X-ProPR-Timestamp: 1763294400
X-ProPR-Envelope-Version: 1
X-ProPR-Signature: sha256=0cd0e98a705d1a6619a32f0aac9963a02f059fe3d1b09630b3587b82036003dc
```

| Header | Value |
| --- | --- |
| `X-ProPR-Event` | The event name, as in the table above. |
| `X-ProPR-Delivery` | The delivery id: the same on every attempt of this event to this target. Use it to ignore repeats. |
| `X-ProPR-Timestamp` | When this attempt was sent, in Unix seconds. |
| `X-ProPR-Envelope-Version` | The envelope version, `1`. |
| `X-ProPR-Signature` | `sha256=` and the signature (below). |

Answer with any `2xx` status. The response body is not read.

## The envelope

The body is one JSON object, **version 1**. Version 1 only grows by adding
fields, so ignore fields you do not know. A change that removes or changes a
field gets a new version (and a new `X-ProPR-Envelope-Version`).

```json
{
  "version": 1,
  "id": "evt-4211-deliver.target-1",
  "event": "pull_request.merged",
  "occurredAt": "2025-11-16T12:00:00.000Z",
  "sequence": 4211,
  "repository": { "fullName": "acme/api", "url": "https://github.com/acme/api" },
  "pullRequest": { "number": 12, "url": "https://github.com/acme/api/pull/12", "headSha": null, "state": "merged" },
  "issue": null,
  "task": null,
  "review": null,
  "ultrafix": null,
  "epicQueue": null
}
```

| Field | Type | Description |
| --- | --- | --- |
| `version` | number | `1`. |
| `id` | string | The delivery id, equal to `X-ProPR-Delivery`. |
| `event` | string | The event name. |
| `occurredAt` | string | When the event happened (ISO 8601, UTC). |
| `sequence` | number | The event's position in ProPR's event journal. It only grows, so it orders the events of one ProPR instance. |
| `repository` | object | `fullName` (`owner/repo`) and `url` (the GitHub repository page). |
| `pullRequest` | object or null | The pull request, when the event concerns one (below). |
| `issue` | object or null | The issue, when the event concerns one: `number` and `url`. |
| `task` | object or null | On `task.*` events (below). |
| `review` | object or null | On `pull_request.review_scored` (below). |
| `ultrafix` | object or null | On `pull_request.ultrafix_ended` (below). |
| `epicQueue` | object or null | On `epic_queue.*` events (below). |

**`pullRequest`**: `number`, `url`, `headSha` (the head commit, when the event
names one, otherwise `null`) and, on `pull_request.*` events, `state`: `open`
(on `opened`), `merged`, `closed` or `null` (other events). On
`pull_request.opened` it also has `draft` (boolean) and `baseRef` (the base
branch).

**`task`**: `id`, `kind` (`implementation`, `follow-up`, `review`,
`merge-conflict` or `automation`), `state` (`queued`, `started`, `completed`,
`failed` or `cancelled`), `agent`, `model` and `attempts`. When the task has
finished it also has `terminalReason` (a code such as `timed_out`),
`failureCategory` (a code, on `failed`), `durationMs` and `pullRequestOutcome`
(`opened`, `updated` or `null`).

**`review`**: `score`, `goal`, `goalReached`, `source` (`review` or
`ultrafix`), `cycle` and `reviewerModel`.

**`ultrafix`**: `outcome` (`goal_reached`, `cycles_exhausted`,
`style_findings_only`, `stopped` or `failed`), `finalScore` and `workEpoch`.

**`epicQueue`**: `id` (the epic queue run), `planId`, `state` (`blocked` or
`completed`), `headIssue` (the blocked issue, on `blocked`), `fromIssue` and
`cursor` (on `completed`).

A value that is unknown or does not apply is `null`.

### What is never sent

The envelope is built from the fields listed above and nothing else. It
contains identifiers, links, states and scores only. It never contains code,
diffs, logs, prompt text, comments, tool output, pull request or issue text,
free-text reasons, settings or credentials. Text fields carry short codes only
(no spaces). A value that is not a code, such as a sentence, is sent as `null`.

## Verifying a delivery

The signature is the HMAC-SHA256, keyed with the target's signing secret, of
the bytes `<X-ProPR-Timestamp>.<body>`: the timestamp header's value, a `.` and
the raw request body, exactly as received. It is sent as lower-case hex after
`sha256=`.

To verify a delivery:

1. Read the raw body before parsing it.
2. Compute `sha256=` + hex(HMAC-SHA256(secret, timestamp + "." + body)).
3. Compare it with `X-ProPR-Signature` in constant time.
4. Refuse the request when the timestamp is more than 5 minutes from your clock,
   so a captured request cannot be replayed later.
5. Ignore a delivery id you have already handled.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyProprWebhook(secret, headers, rawBody) {
  const timestamp = headers['x-propr-timestamp'];
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const received = String(headers['x-propr-signature'] ?? '');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
  return fresh && received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
```

```python
import hashlib, hmac, time

def verify_propr_webhook(secret: str, headers: dict, raw_body: bytes) -> bool:
    timestamp = headers["x-propr-timestamp"]
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    fresh = abs(time.time() - int(timestamp)) <= 300
    return fresh and hmac.compare_digest(headers.get("x-propr-signature", ""), "sha256=" + digest)
```

### Test vector

This vector is checked by the plugin's tests. The body is one line, with no
trailing newline. (It is too old to pass the 5-minute freshness check, so skip
that check when you test with it.)

```text test-vector
Secret: whsec_test_0123456789abcdef0123456789abcdef
X-ProPR-Timestamp: 1763294400
Body: {"version":1,"id":"evt-4211-deliver.target-1","event":"pull_request.merged","occurredAt":"2025-11-16T12:00:00.000Z","sequence":4211,"repository":{"fullName":"acme/api","url":"https://github.com/acme/api"},"pullRequest":{"number":12,"url":"https://github.com/acme/api/pull/12","headSha":null,"state":"merged"},"issue":null,"task":null,"review":null,"ultrafix":null,"epicQueue":null}
X-ProPR-Signature: sha256=0cd0e98a705d1a6619a32f0aac9963a02f059fe3d1b09630b3587b82036003dc
```

ProPR computes the signature itself, through `ctx.http` with the target's
`signing_secret` connection. The plugin's handler never sees the secret.

## Delivery and retries

Deliveries follow the [plugin delivery rules](../features/plugins.md#delivery-guarantees-and-limits):
at least once, in order per repository, and 30 seconds per attempt (each request
has 10 seconds).

| The target answers | What happens |
| --- | --- |
| `2xx` | Delivered. |
| `429`, `408`, `425` or `5xx`, or the request fails or times out | Retried. With a `Retry-After` header (seconds or an HTTP date), the next attempt waits that long (at least 1 second, at most 6 hours). Without one, it waits 1 minute, 5 minutes, 30 minutes and 2 hours. After the fifth attempt the delivery is marked failed. |
| Any other status (`3xx`, `4xx`), or the target is refused (its host is no longer allowed, or the signing secret is not set) | Marked failed at once, with a message such as `Target 1 (hooks.example.com) refused the delivery with HTTP 410; it is not retried`. |

When an event goes to several targets and only some fail, a retry sends it only
to the targets that do not have it yet, with the same delivery id. If one
target refused the delivery for good, the delivery is marked failed with that
target's message once the others have it; automatic retries do not ask that
target again. **Retry** in Activity (after you fix the target) sends it again
to every target that does not have it, including one that refused it, and
skips the targets that already have it. Which targets have it is kept as
each target answers, so an attempt cut off by the handler's time limit is not
sent again to the targets that accepted before it. It is kept for 14 days, as
long as Activity offers **Retry**.

## Limits

- Three targets.
- Each request body is at most 256 KiB. Envelopes are far smaller.
- The event's repository must be inside the plugin's repository limit.
