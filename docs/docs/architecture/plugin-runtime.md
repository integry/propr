---
sidebar_label: "Plugin Runtime"
title: "Plugin runtime: handlers and their context"
description: "How plugin handlers run: the handler SDK, runPluginHandler, the event dispatcher (cursors, ordering, retries, lease, health), the scoped ctx.propr client, outbound HTTP through the endpoint policy, installation state, logging and redaction, and the import rule."
---

# Plugin runtime

A [plugin](../features/plugins.md) can ship code: a `handlers.ts` in its folder
that exports named async functions. This page describes how ProPR runs them and
what they can reach. The feature page covers [writing a handler](../features/plugins.md#handlers).

Official plugins are trusted code and their handlers run **in-process**, but only
through a narrow interface: input goes in, and every effect goes out through
`ctx`. A handler imports nothing from ProPR except the SDK types in
`@propr/shared`, so the same plugin could later run in another process with `ctx`
proxied to ProPR.

Handlers *observe and create new work*. A handler can read a pull request, open
an issue or start a task, but it never interacts with a task that is running.
Ordinary task runs stay one-shot.

## Components

| Part | Where | What it does |
| --- | --- | --- |
| SDK types | `packages/shared/src/pluginSdk.ts` | `PluginContext`, the input envelopes, `PluginSdkError`, the limits and the operation → permission table. |
| Handler loading | `packages/plugins/src/index.ts` (`loadPluginHandlers`) | Resolves a plugin's `handlers.ts` (compiled to `dist/plugins/<id>/handlers.js` in builds) and returns its exported functions. |
| Runner | `packages/core/src/plugins/pluginHandlerRunner.ts` | `runPluginHandler(installation, handlerName, input, options)`. |
| Context | `packages/core/src/plugins/pluginContext.ts` | Builds `ctx` for one invocation, captures and redacts its log. |
| `ctx.propr` | `pluginProprClient.ts` (checks) on `pluginProprBackend.ts` (GitHub, event journal, task queue) | The scoped ProPR client. |
| `ctx.http` | `pluginHttp.ts` on `extensions/endpointPolicy.ts` | Outbound HTTPS. |
| `ctx.state` | `pluginStateStore.ts`, table `plugin_state` | Installation-scoped key-value store. |
| Test kit | `packages/plugins/testing` | A fake `ctx` for plugin unit tests. |
| Event dispatcher | `packages/core/src/plugins/pluginDispatcher.ts`, started by the daemon (`src/daemon/pluginEventDispatch.ts`) | Reads the journal per installation and repository, runs subscribed handlers, retries, holds the lease. |
| Delivery records | `packages/core/src/plugins/pluginDeliveries.ts`, tables `plugin_dispatch`, `plugin_delivery_cursors`, `plugin_deliveries` | Activity records, health, Retry, Resume, retention, the Degraded notification. |
| Activity API | `packages/api/routes/pluginActivityRoutes.ts` | `GET …/:pluginId/activity`, `POST …/activity/:id/retry`, `POST …/:pluginId/resume`. |
| Webhook verification and keys | `packages/core/src/plugins/pluginWebhooks.ts`, table `plugin_webhook_keys` | The verification schemes, the installation key, its lookup and regeneration, the rejected-request count. |
| Webhook receiver | `packages/core/src/plugins/pluginWebhookReceiver.ts` | One inbound request: lookup, verification, the `respond` function, de-duplication, enqueue. |
| Webhook delivery runner | `packages/core/src/plugins/pluginWebhookRunner.ts`, started by the API (`packages/api/server.ts`) | Runs queued webhook deliveries in memory, with the event retry schedule, and records them in `plugin_deliveries`. |
| Webhook routes | `packages/api/routes/pluginWebhookRoutes.ts` | `POST /api/plugins/:installationKey/hooks/:webhookName` (public), `GET …/:pluginId/webhooks`, `POST …/:pluginId/webhooks/regenerate`. |

## Invocation

```ts
runPluginHandler(installation, handlerName, input, options): Promise<PluginHandlerRun>
```

`installation` is a plugin id (the installation is read from
`plugin_installations` and the manifest from the registry) or an installation
already loaded (`{ pluginId, manifest, record }`). The runner:

1. Refuses a plugin that is not in the registry, not installed or not enabled, a
   handler name that is not an identifier, and a name the module does not export
   as a function.
2. Builds `ctx` from the current manifest and the installation record.
3. Calls `handler(input, ctx)` and waits at most `PLUGIN_HANDLER_TIMEOUT_MS`
   (30 seconds). When the time runs out, `ctx.signal` is aborted.
4. Returns `{ outcome, timedOut, durationMs, error, logs, result? }`.

The runner **never throws**. A thrown error, a timeout, a missing handler and a
result that is not JSON or is larger than 16 KiB are all `outcome: 'failed'`
with a message. The message, the log lines and the result are redacted.

When the run ends, whether it succeeded, failed or timed out, `ctx` stops working
for anything the handler left running. A late call to `ctx.propr`, `ctx.http` or
`ctx.state` throws `unavailable`, and late log lines are dropped. A handler that
ignores `ctx.signal` can keep its own timers alive, but it can no longer act
through ProPR.

The [event dispatcher](#event-dispatcher) calls the runner with
`PluginEventInput`, and the [webhook delivery runner](#inbound-webhooks) calls
it with `PluginWebhookInput`. A later issue calls it from commands
(`PluginCommandInput`).
`PluginInvokeInput` carries a JSON payload for direct calls and tests.

## Event dispatcher

`PluginDispatcher` delivers [journal events](./repository-event-journal.md) to
the handlers a plugin names in `contributes.subscriptions`. The daemon starts
one at boot and stops it on shutdown; the hourly maintenance sweep that prunes
the journal also prunes delivery records. The feature page lists the
[events, payloads and guarantees](../features/plugins.md#event-subscriptions).

### Reading the journal

The dispatcher only reads the journal. An append notifies it in the same
process (`subscribeRepositoryEventAppends`): a pass starts within 200 ms, and
a steady stream of appends never pushes that pass back. It also polls every 5
seconds for appends from other processes. Nothing that appends an event waits for a
delivery, so a handler can never fail or delay the step that produced the
event.

Each pass looks at every enabled installation whose current manifest has
subscriptions and that holds `events.read`. For each one:

1. `plugin_dispatch` holds `start_seq`, the journal's highest `seq` when the
   plugin was installed or last enabled. Only later events are delivered. An
   installation without a row (or with a row of an earlier installation)
   starts at the journal's end. That row is written only in a transaction
   that confirms the installation is still the one the pass read, and
   enabled: a pass that read it before an uninstall, reinstall or disable
   skips it and never writes over the replacement's start.
2. The repositories to visit are those with events after `start_seq`, those
   with unfinished deliveries, and those whose journal floor moved past
   `start_seq` and past what their cursor last recorded (so a repository that
   retention emptied is still visited), minus those outside the repository
   limit. Repository names are case-insensitive: every spelling of a name is
   one repository, keyed by its lower-case form. Each has a cursor in
   `plugin_delivery_cursors`: the last `seq` whose deliveries are final.
3. For each repository, the events after the cursor, in any spelling, are
   read in `seq` order (50 per pass). Each event goes to every subscription whose `on` and
   `filter` match it, in manifest order. A delivery gets a record in
   `plugin_deliveries` the first time it is seen, keyed by its delivery id
   `evt-<seq>-<handler>`.
4. When every delivery of an event is final (succeeded or failed), the cursor
   moves past it. A delivery waiting for a retry stops that repository until the
   retry is due; other repositories and other plugins go on. Installations are
   delivered side by side.

Before the events, failed deliveries an administrator retried get their one
extra attempt. A retry is marked `manual` until that attempt is final, so one
a crashed worker left `running` gets its attempt again from the next lease
holder, with the same delivery id. The handler's input of that attempt has
`manual: true`.

### Attempts and retries

An attempt marks the record `running`, increments `attempt`, and calls
`runPluginHandler` with `{ kind: 'event', event, deliveryId, attempt }` and the
30 second limit. Before each attempt the dispatcher renews its lease and reads
the installation again: an installation that is paused, disabled, enabled
again since the pass began, or no longer granted `events.read` ends the pass,
and so does an event outside the current repository limit (a manual retry of
one is marked failed instead). The handler gets the installation as it is now.
An attempt that pauses the installation ends the pass too. The runner never throws. The outcome, duration, redacted error
and redacted log lines (at most 100 lines and 64 KiB) are written to the record.
A failed attempt becomes `retrying` with `next_attempt_at` 1 minute, 5 minutes,
30 minutes and 2 hours later (`PLUGIN_DELIVERY_RETRY_DELAYS_MS`); the fifth
failure is final (`failed`). A manual retry gets one attempt.

A handler can say more about a failure by throwing a `PluginDeliveryError`
(`@propr/shared`). With `retryAfterMs` (for example a service's `Retry-After`,
read with `parsePluginRetryAfter`), the next attempt is due after that delay
instead of the scheduled one, bounded to between 1 second and 6 hours
(`PLUGIN_RETRY_AFTER_LIMITS_MS`). The attempt still counts towards the five.
With `permanent: true`, the delivery is `failed` at once. The runner reads both
from the error (by its name, so a handler bundling its own SDK copy is
understood) into `PluginHandlerRun.retryAfterMs` and `permanent`. Webhook and
command deliveries apply them the same way.

### Lease

Several daemons may run against one database. Only one delivers to a given
installation: the holder of its lease, `lease_owner` and `lease_expires_at` on
the `plugin_dispatch` row. ProPR runs on SQLite only, so the lease is this row
with an expiry, not a database lock. A dispatcher takes the lease with one
conditional `UPDATE` (free, expired or already its own) and renews it before
every attempt. The lease lasts 2 minutes, longer than an attempt can run. On
shutdown the dispatcher hands its leases back.

The outcome of an attempt is written only while the dispatcher still holds the
lease. A dispatcher that stalled past its lease writes nothing; the new holder
finds the record still `running` and delivers it again with the same delivery
id. This is why delivery is at least once.

### Gaps

Retention deletes journal events after 30 days and records each repository's
floor (`getRepositoryEventFloor`). When a cursor is below the floor, events may
have gone undelivered: the dispatcher records one `gap` record (status
`skipped`, from the cursor to the floor) and goes on with the events that are
left. `floor_seq` on the cursor keeps it from recording the same gap twice.
Unfinished deliveries of events that are no longer in the journal become
`skipped`. Unexpired events below the floor are still delivered.

### Health

`plugin_dispatch` also counts consecutive failed attempts. A success resets the
count and clears Degraded. At 3 (`PLUGIN_DEGRADED_AFTER_FAILURES`) the
installation becomes Degraded: `degraded_at` is set, and every durable
administrator gets one `system_failure` Inbox notification (component
`plugins.dispatcher`, deduplicated by installation and the time it became
Degraded). The notification owed is queued in `degraded_notice` (a JSON list)
in the same write that sets `degraded_at`, behind any notification of an
earlier transition not sent yet, and each is removed only once it was created;
when sending fails, or the worker stops first, later passes send it again (at
most once a minute after a failure), paused installations included. At `PROPR_PLUGIN_PAUSE_AFTER_FAILURES` (default 10, at least 3)
`paused_at` is set and the dispatcher skips the installation. Resume clears
both, resets the count and makes waiting retries due.

Installing a plugin, or enabling it again, restarts its dispatch state at the
journal's end; deliveries left unfinished are marked failed. A pass writes a
cursor or a delivery record only in a transaction that confirms it still holds
the lease of the installation and start it read, so a pass that started before
a restart writes nothing of the earlier start. Marking a delivery `running`
before its handler starts is one of those writes, and renews the lease in the
same transaction: a worker that lost the lease while suspended before an
attempt never starts the handler. Uninstalling
deletes the dispatch state, the cursors and the records.

### What is stored

A delivery record holds the plugin id, delivery id, kind, repository, event
`seq` and `<domain>.<type>`, handler, status, attempt, times, duration, the
timeout flag, and the latest attempt's redacted error and log lines. It never
holds the event payload, the handler's result or a credential. Records are
kept for 14 days (`PLUGIN_DELIVERY_RETENTION_DAYS`); pending and retrying
records are kept until they finish. A final record is also kept while its
event is still in the journal and ahead of the repository's cursor (another
handler of the event is retrying, or deliveries are paused), so reading the
event again does not run a handler that already succeeded or failed for good.

## Inbound webhooks

A plugin declares webhooks in `contributes.webhooks`. Each one is served at

```text
POST /api/plugins/<installation key>/hooks/<name>
```

### Installation key

`plugin_webhook_keys` has one row per installation. It holds the key (32 random
bytes, base64url, 43 characters), its SHA-256 (`key_hash`, unique, which
requests are looked up by), the `installed_at` of the installation it belongs
to, who created it and when, and the count, time and reason of the last
rejected request. The row is created the first time the Plugins page reads the
URLs. **Regenerate** replaces it in one transaction with an audit entry
(`regenerate_webhook_key`), so the old key matches nothing from then on.
Uninstalling deletes the row. A row from an earlier installation never matches,
because `installed_at` must equal the current installation's.

A request resolves to a webhook only when all of these hold: the key's hash is
in the table, the installation exists, is enabled and is the one the key
belongs to, the plugin is in the registry, and its manifest declares the
webhook name. Anything else gets 404 before a secret is read or plugin code is
loaded.

### Request path

The route is registered in `packages/api/server.ts` next to `POST /webhook`,
before the JSON parser and the session middleware:

1. The webhook rate limiter (`createWebhookRequestRateLimiter`, the one
   `/webhook` uses), on top of the general `/api` limiter.
2. `express.raw` for any content type, up to `PLUGIN_WEBHOOK_LIMITS.bodyBytes`
   (256 KiB). A larger body gets 413 and is neither echoed nor logged. The body
   is read exactly as transmitted, never inflated: a sender signs the bytes it
   sends, compressed or not, so the parser is called with `Content-Encoding`
   set aside and the header is put back for the receiver.
3. `PluginWebhookReceiver.receive`:
   1. Resolve the key and name, as described above (404).
   2. Open the webhook's `signing_secret` connection and run
      `verifyPluginWebhook`. A failure gets 401 and is counted on the key row
      (`recordPluginWebhookRejection`). It is logged as
      `{ pluginId, webhook, reason }`, never with the body or a header.
   3. Decode the verified body (`decodePluginWebhookBody`): a single
      `Content-Encoding` of `gzip`, `x-gzip`, `deflate` or `br`, inflated to at
      most `PLUGIN_WEBHOOK_LIMITS.bodyBytes`. Beyond that 413; another encoding
      415; a corrupt body 400. Nothing is decompressed before verification, and
      a refused body takes no delivery id.
   4. Derive the delivery id: `whk-<webhook>:<value of deliveryIdHeader>`, or
      `whk-<webhook>/<random UUID>` when the webhook declares no header or the
      request does not send it. A webhook name contains neither `:` nor `/`, so
      the character after the name ends it: webhook `a` with id `b-c` and
      webhook `a-b` with id `c` get different ids. A malformed value gets 400.
      The value is stored in `delivery_id` and shown in Activity, so the
      manifest schema refuses `authorization` and `proxy-authorization` (and the
      webhook's verification headers) as `deliveryIdHeader`, and
      `senderDeliveryId` never reads them either.
   5. `PluginWebhookRunner.reserve` inserts the `plugin_deliveries` row (kind
      `webhook`, `event_type` `webhook.<name>`, empty repository, `event_seq` 0,
      status `pending`, `webhook_owner` this runner) before any plugin code
      runs. The unique `(plugin_id, delivery_id)` index turns a replay into a
      409, so a replay never reaches the `respond` function either. A `failed`
      webhook row with the same delivery id is deleted first, in the same
      transaction: its request was not kept, so the sender's redelivery is the
      only way to deliver it. The new row has a new id, so a runner still
      holding the old one (another process whose heartbeat lapsed) finds no
      record and drops it. Rows that are `pending`, `running`, `retrying` or
      `succeeded` still make the request a 409. When 1,000 deliveries are
      already held or reserved, the answer is 503.
   6. If the webhook has `respond`, call it (see below). A response is sent as
      it is and the request ends there. A 2xx answer to a request with the
      sender's delivery id marks the row succeeded (handler: the respond
      function), so the id stays taken; otherwise the row is deleted
      (`release`), and a failed respond function's request may be sent again.
      If the write marking the answer reports an error, the row is read back:
      when the answer committed, it is sent. Otherwise, or when the row cannot
      be read, the request fails with 500 and the row is deleted, whether it
      is still pending or holds that unsent answer, so the sender may send it
      again.
   7. Refuse with 503 while the installation's event deliveries are paused,
      releasing the row so the sender's retry is not a replay.
   8. `start` hands the delivery to the runner, and the answer is 202.

| Scheme | Computation | Notes |
| --- | --- | --- |
| `hmac-sha256` | `prefix + enc(HMAC-SHA256(secret, rawBody))`, `enc` hex (case-insensitive) or base64 | The digest is decoded and compared with `timingSafeEqual`. A repeated header is treated as missing. |
| `slack-v0` | `"v0=" + hex(HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody))` | `X-Slack-Request-Timestamp` must be within `PLUGIN_WEBHOOK_LIMITS.timestampToleranceSeconds` (300) of now, in either direction. |
| `token-header` | `header == prefix + secret` | The SHA-256 digests of both sides are compared with `timingSafeEqual`, so neither the length nor the content leaks through timing. |

The test vectors are GitHub's documented delivery (`It's a Secret to
Everybody`, `Hello, World!`), RFC 4231 test case 2 (`Jefe`), and Slack's
documented slash command request. They are in
`packages/core/test/pluginWebhooks.test.ts`.

### The `respond` function

`respond` names a function exported from `handlers.ts`, of type
`PluginWebhookResponder`. The receiver loads the handlers module and calls the
function with `Reflect.apply`, passing exactly one argument: the frozen request
`{ webhook, headers, body, receivedAt }`, whose headers are frozen too. No
`ctx` is built for it. It therefore cannot reach ProPR, outbound HTTP, state
or the log, and the tests check that a function that reaches for a second
argument fails.

A returned thenable is refused, so the function must be synchronous. The
response is checked: a 2xx status, `text/plain` or `application/json`, and a
string body of at most `PLUGIN_WEBHOOK_LIMITS.responseBytes` (4 KiB). A refusal
or a throw gets 500. Nothing of the error is logged (not even its name),
because it could quote the request.

### Webhook delivery runner

Request bodies must never be stored, so webhook deliveries do not go through
the journal or Redis. `PluginWebhookRunner` holds each accepted delivery (the
request body, the filtered headers and the target installation) in the API
process's memory, keyed by its `plugin_deliveries` id. It then:

1. Re-reads the installation before each attempt. A disabled, uninstalled or
   reinstalled plugin fails the delivery (`Not delivered: the plugin was
   disabled`). A record another writer already finished is dropped. Enabling
   the plugin again runs `restartPluginDispatch`, which marks every unfinished
   delivery failed, and that includes webhook deliveries.
2. Marks the record `running` only when it is still in the status it was read
   in, runs the handler with `{ kind: 'webhook', …, deliveryId, attempt }`, and
   records the outcome only while the record is still that attempt.
3. Retries on `PLUGIN_DELIVERY_RETRY_DELAYS_MS` (1 min, 5 min, 30 min, 2 h).
   After the last delay the delivery is failed and its memory is released.

The handler's headers are the request's minus the verification headers,
`authorization`, `proxy-authorization`, `cookie`, `host`, `connection`,
`content-length`, `transfer-encoding` and `content-encoding` (the handler gets
the decoded body).

Each runner has an owner name (`webhooks-<pid>-<uuid>`) and a heartbeat row in
`plugin_webhook_runners`, renewed every 30 seconds; each delivery record names
its owner in `webhook_owner`. When the API starts, and with every heartbeat,
`recover()` marks failed the unfinished webhook deliveries whose owner has
stopped: its heartbeat is older than 2 minutes, or the record has no owner.
They read *ProPR stopped before the delivery finished, and webhook requests are
not kept*. This is one `UPDATE`, so another API process starting while one is
alive never fails that process's pending or retrying deliveries.

A runner keeps a request in memory until the database write that moves its
delivery on has succeeded. A failed write is retried after 1 s, 5 s, 30 s and
then every minute. If the handler had already run, only the outcome is
written again; the handler does not run a second time. A reservation (a
refused or answered request) stays counted until its record is deleted or
marked answered. Each heartbeat also marks failed any of the runner's own
unfinished records that it no longer holds. `stop()` (on SIGTERM) lets attempts under
way finish and fails the deliveries still waiting. A failed webhook delivery
cannot be retried from Activity (`retryPluginDelivery` only accepts event
deliveries), because the request is gone. The sender's redelivery with the
same delivery id replaces it instead (see `reserve` above).

Webhook attempts do not update `plugin_dispatch` health. The dispatcher's
failure count, Degraded state and pause track event deliveries only. A paused
installation refuses new webhook requests with 503.

**What is stored.** The key row (the key, its hash and the rejection count) and
the delivery record (the ids, the webhook and handler names, status, timing,
and the level and time of each log line). A handler may log or throw any part
of the request, which the credential redaction does not recognize, so a
webhook attempt keeps no handler log message or field and no error text: the
error is *The webhook handler failed* or *The webhook handler timed out*
(`webhookDiagnostics`). The body, the signature and
token headers, and the other request headers are never written to the database
or a log. The sentinel tests in `pluginWebhooks.test.ts` and
`packages/api/test/pluginWebhookRoutes.test.ts` dump every table and capture
every logger and console line to check this.

## `ctx.propr`: the scoped client

Each operation needs one permission:

| Operation | Permission |
| --- | --- |
| `getPullRequest(repository, number)` | `pull_requests.read` |
| `getIssue(repository, number)` | `issues.read` |
| `getTask(taskId)` | `tasks.read` |
| `listEvents({ repository, afterSeq?, domains?, limit? })` | `events.read` |
| `createIssue(repository, { title, body?, labels? })` | `issues.create` |
| `createTask(repository, issueNumber)` | `tasks.create` |
| `commentOnPullRequest(repository, number, body)` | `pull_requests.comment` |
| `commentOnIssue(repository, number, body)` | `issues.comment` |
| `addLabel(repository, number, label)` / `removeLabel(…)` | `labels.write` |

Every call is checked before it reaches the backend:

- **Grant.** The permission must be both granted to the installation and asked
  for by the current manifest. A permission an upgrade added is unusable until
  an administrator approves it, and one an upgrade dropped is unusable at once.
- **Repository limit.** The repository must be in the installation's
  repository limit (compared case-insensitively), unless the plugin is enabled
  for all repositories. A task's repository is known only after the task is
  read, so `getTask` reads it and refuses to return a task outside the limit.
- **Input.** `owner/repo` names, positive numbers, and bounded titles (256),
  bodies (64 KiB), labels (50 characters, at most 20) and event pages (at most
  100).
- **Target kind.** GitHub's issue routes serve pull requests too, so the method
  name alone does not establish what a number refers to. `getIssue` and
  `commentOnIssue` read the number first and refuse a pull request;
  `commentOnPullRequest` refuses an issue (`not_found`, nothing is posted). An
  `issues.comment` grant cannot comment on a pull request, nor the reverse.
- **Installation.** The permissions and the repository limit are first those
  of the installation the run started with. Every call then requires that
  installation to still be installed and enabled, and to still grant the
  call's permission on the repository it names, as an administrator last set
  them; the default backend checks the same again right before it sends each
  GitHub request or adds a task job, after the App client or the queue is
  ready. `getTask` names no repository until the task is read, so it checks
  the task's repository against the current limit then, before returning it. A handler that resumes after its plugin was uninstalled, or
  uninstalled and reinstalled, gets `unavailable` ("The plugin is no longer
  installed"); after it was disabled, `unavailable` ("The plugin is
  disabled"); after its repository limit was changed to exclude the
  repository, `repository_not_allowed`; after a grant was revoked,
  `permission_denied`. In each case it creates no issue, comment, label or
  task. An administrative change does not wait for a GitHub request that
  passed this check and is already being sent.

A refused call throws `PluginSdkError` with code `permission_denied`,
`repository_not_allowed`, `invalid_input`, `not_found` or `unavailable`. It is
logged as a `warn` line in the run's log and in the server log. A backend failure reaches
the handler as `unavailable` without the backend's details, which could name
other repositories or carry tokens.

### Attribution

Every call, allowed or refused, is appended to `plugin_audit` with actor
`plugin:<id>` and detail
`{ handler, operation, permission, callId, repository?, number?, taskId?, reason? }`.
The action is `handler_call` for a completed call and `handler_refused` for a
refused or failed one. A mutation (`createIssue`, `createTask`, the comment and
label operations) is first recorded as `handler_attempt`, after its checks and
before it is dispatched. If that record cannot be written, the call is refused
as `unavailable` and nothing reaches GitHub or the task queue. Once the attempt
is recorded, a failure to record the outcome is logged on the server and does
not fail the call, because the mutation may already have happened. The attempt
and its outcome share a `callId`. The calls appear in the plugin's audit trail
(`GET /api/instance/plugins/v1/{id}`) with the management actions.

Text a plugin writes to GitHub (issue bodies and comments) ends with an
HTML comment, `<!-- propr-plugin:<id> -->`, so the writer is visible on the
issue itself. A task the plugin creates is queued with `requestedBy:
"plugin:<id>"` in its job data. The task keeps that value in its stored job
data, and its first task event, the `pending` entry of `task_history` that
`get_task_events` returns, carries `{ "requestedBy": "plugin:<id>" }` as
metadata.

## `ctx.http`: outbound HTTP

`ctx.http(connection?)` returns a `fetch`-like function:
`(url, { method?, headers?, body? | json?, signature? }) => Promise<{ status, ok, url, headers, text(), json() }>`.

| Check | Refusal |
| --- | --- |
| `https:` only, default port, no credentials in the URL | `insecure_url`, `host_not_allowed`, `invalid_input` |
| The hostname must be exactly one of the manifest's `outboundHosts`, or the host of a URL setting the manifest names in `outboundHostsFromSettings`, as this run's settings have it; IP literals and local names (`localhost`, `*.local`, cloud metadata) never are | `host_not_allowed`, `private_address` |
| Every resolved address must be public: the extension endpoint policy's address check (private, loopback, link-local, CGNAT, documentation and fake-IP ranges are refused) | `private_address` |
| Methods `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`; headers ProPR sets (`Host`, `Content-Length`, hop-by-hop, `Proxy-*`) cannot be supplied | `invalid_input` |
| Request bodies up to 256 KiB, responses up to 1 MiB, 10 seconds per request | `invalid_input`, `response_too_large`, `http_failed` |

As with extension MCP servers, ProPR dials the address it checked, keeping the
original hostname for TLS and the `Host` header. Redirects are not followed, and
no proxy environment, cookies or decompression apply. The handler gets the
redirect response itself.

**Hosts from settings.** A plugin whose endpoints are entered by an
administrator (such as [outbound webhooks](../plugins/webhooks.md)) names its
URL settings (string settings of `format: "https-url"`) in
`outboundHostsFromSettings`. Saving a URL there requires `https://`, the default
port, a host name (no IP address), no credentials or fragment and no local name.
A new or changed URL's host must also resolve to public addresses only, which
the plugin store checks before the settings are written. On each request
`ctx.http` allows exactly those hosts, from the settings the run started with,
and checks their addresses again.

**Secret URLs.** A `token` connection with `secretUrl` holds a URL, such as a
chat service's incoming webhook URL (`pluginSecretUrlSchema` in
`packages/shared/src/plugins.ts`). The plugin store refuses a value that is not
an `https://` URL on one of the connection's `hosts` (an exact name, or `*.` and
a name for its subdomains) under one of its `pathPrefixes`. `ctx.http` with such
a connection accepts only `PLUGIN_CONNECTION_URL` as the URL (anything else is
`invalid_input`): it reads the secret first, checks it again as above
(`host_not_allowed`), then applies every check in the table except the
`outboundHosts` one. No header is added and a `signature` is refused. The full
URL and its path and query are credentials of the run: they are scrubbed from
the response like any secret, and the response's `url` is the placeholder.

**Credentials.** With a connection name, the connection must be a `token` or
`signing_secret` connection of the plugin and must be set. Its sealed secret is
opened only when the request is sent. A `token` secret is injected as
`Authorization: Bearer <secret>`. With a `signing_secret`, every request must
carry `signature: { header, prefix?, timestampHeader? }`, and ProPR sets
`header` to `prefix` and the lower-case hex HMAC-SHA256, keyed with the secret,
of the body bytes as sent. With `timestampHeader` (a header the request sets),
the signed bytes are that header's value, `.` and the body. A signature without
a signing connection, a signing connection without a signature, or a signature
header the handler set itself is `invalid_input`. An `oauth` connection
authenticates the plugin's MCP servers and cannot be used by `ctx.http`
(`connection_unavailable`). The handler never receives the secret: it is not
part of `ctx`, and the secret (plain, JSON-escaped, base64, base64url, hex,
URL-encoded and as the full header value) is replaced with `[REDACTED]` in the
response headers and body before the handler sees them. The hex spelling is
matched in any letter case (`Buffer.from(hex, 'hex')` decodes `AB`, `ab` and
`aB` alike); every other spelling is matched exactly, so a value that merely
differs from the secret in case is not touched. Each of these spellings
is also replaced where some of its characters are percent-escaped, with
lowercase or uppercase hex digits (`%2f` as well as `%2F`, or an escaped
letter), since `decodeURIComponent` recovers all of them. A JSON body is also
checked after decoding, so an escape such as `\u0041` or `\"` cannot spell the
secret back; when a decoded string held it, `text()` and `json()` return the
body re-serialized with the secret replaced. A string that holds the secret
only after it is decoded again, such as a JSON document serialized inside a
JSON string or a value URL-encoded twice, is replaced with `[REDACTED]` whole.
A response header or body whose text still holds the secret once its JSON and
percent escapes (`%2f`, `%u002f`) are decoded, once or repeatedly and in any
order, is replaced with `[REDACTED]` entirely. This covers a JSON-valued header
(also inside a longer or joined value), `\uXXXX` escapes in an HTML script,
nested serialized JSON and a percent escape inside a JSON escape. Text still
decoding after 32 rounds, or decoding to more than 8 different texts in one
round, counts as holding it. A response header whose name holds the secret in any of these
spellings is dropped. Header names arrive lowercased, so they are compared
case-insensitively. A
careless upstream that echoes the `Authorization` header cannot hand the secret
back.

**Installation binding.** The secret is read from the installation the run
belongs to, in one transaction with it, and every authenticated request checks
again before it is sent that this installation is still installed and enabled.
A run that resumes after its plugin was uninstalled, or uninstalled and
reinstalled with a new connection of the same name, gets `unavailable` and
sends nothing; it never receives the replacement installation's secret. A run
that resumes after its plugin was disabled gets `unavailable` ("The plugin is
disabled") and sends nothing either. An unauthenticated `ctx.http()` request
carries nothing of the installation and is not bound to its enabled state.

**Run lifetime.** The run's signal reaches the request: it is checked again
after the DNS lookup and after the credential is read, and no request starts
once the run has ended (`unavailable`). A request in flight when the run ends
is cancelled. The default `ctx.propr` backend applies the same rule to its
GitHub requests and queued tasks.

Each request decision is a line in the run's log: `debug` when sent, `warn` when
refused. The line names only the hostname, never the path or query.

## `ctx.state`

A JSON key-value store scoped to the installation, for cursors and mappings
such as "this pull request maps to that chat thread":

```ts
await ctx.state.set(`thread:${repository}#${number}`, { channel, ts });
const thread = await ctx.state.get<{ channel: string; ts: string }>(`thread:${repository}#${number}`);
await ctx.state.delete(key); await ctx.state.keys('thread:');
```

| Limit | Value |
| --- | --- |
| Keys | 256 per installation; 1 to 200 printable characters without spaces |
| Value | 16 KiB of serialized JSON; plain objects, arrays, text, finite numbers, booleans, `null` |
| Total | 256 KiB per installation |

A write that would exceed a limit throws `state_limit` and changes nothing.
Rewriting a key replaces its size rather than adding to it, so an existing key
can be updated at the key limit. Values live in `plugin_state`
(`plugin_id`, `state_key`, `value`, `bytes`, `updated_at`; migration
`20261114180000_plugin_state.js`) and are deleted when the plugin is
uninstalled. A write runs in a transaction that first requires the
installation the run started with (the same `installed_at`) to still exist
and holds it until commit; uninstall deletes the installation row before the
state rows. A handler still running across an uninstall therefore cannot
recreate state, nor hand it to a later installation with the same id: its
write either commits first and is deleted with the rest, or throws
`unavailable`. Disabling keeps them. The uninstall's audit entry records how many
keys were deleted. Native exports keep the table, since it holds no
credentials.

## `ctx.log` and redaction

`ctx.log.debug|info|warn|error(message, fields?)` appends
`{ level, message, fields?, at }` to the run's log, which is returned to the
caller. Messages are cut at 2,000 characters, fields must be JSON of at most
4 KiB, and a run keeps at most 200 lines, followed by one "log limit reached"
line. Every message, field, error message and result is scrubbed of the
connection credentials used in the run as a response is (every spelling, also
percent-escaped in either case, and a string that still decodes to one is
replaced whole), then passes the extension output redaction. That redaction
removes those credentials again, plus the general secret patterns (GitHub,
cloud and API tokens, `Authorization` values and secret-like assignments) and
headers such as `authorization` and `cookie`.

Messages (2,000 characters) and error messages (1,000) are cut only after the
final redaction when the run ends, which uses every credential the run
acquired. A credential that straddles the limit is replaced whole instead of
being left one character short. A credential too long to be matched whole before the cut has
its visible start withheld.

## Import rule

The root `eslint.config.js` has an override for `packages/plugins/**`, which
covers handlers, the registry and the test kit. Its `no-restricted-imports` and
`no-restricted-syntax` rules refuse:

- `@propr/*` packages other than `@propr/shared`, and `propr-ui`;
- relative paths into another ProPR package (`../../core/…`, `../../api/…`,
  `../../shared/…`, …) or the root sources (`../../../src/…`);
- dynamic `import()` of any of these.

Node built-ins and files inside the plugins package are allowed. Run it with
`npm run lint -w @propr/plugins`. `packages/core/test/pluginHandlerLint.test.ts`
checks that a fixture plugin importing core fails.

## Testing plugins

`packages/plugins/testing` exports `createTestPluginContext(options)`. It
returns a fake `ctx` together with what the handler did:

```ts
import { createTestPluginContext } from '../testing/index.js';
import { recordEvent } from '../example-pack/handlers.js';

const kit = createTestPluginContext({ grantedPermissions: ['events.read', 'tasks.read'], outboundHosts: ['api.example.com'] });
kit.respond('https://api.example.com/v1/', { json: { ok: true } });
await recordEvent(input, kit.ctx);
kit.calls;    // ctx.propr calls that passed the checks: [{ operation, args }]
kit.requests; // ctx.http requests: [{ url, init, connection }]
kit.state;    // Map of the in-memory state
kit.logs;     // captured log lines
```

The fake applies the same permission, repository-limit, `https`, outbound-host
and state-limit checks as the real context, so a handler test fails the way
production would. `outboundHostsFromSettings` adds the hosts of those URL
settings in `settings`, and `secrets` (signing secrets by connection name)
makes a request with a `signature` signed as the real `ctx.http` signs it, with
the signature header in `kit.requests[i].init.headers`. That includes `getTask`, which refuses a task from a
repository outside the limit once the answer is read. `ctx.propr` calls nobody
answered resolve with minimal placeholders. A placeholder task belongs to the
first repository in the limit. An HTTP request with no scripted response throws `http_failed`.
