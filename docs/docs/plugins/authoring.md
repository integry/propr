---
sidebar_label: "Writing a plugin"
title: "Writing an official plugin"
description: "How to add an official ProPR plugin: the scaffold, the manifest reference, MCP server contributions, handlers, events, webhooks, commands, settings, connections, permissions, limits, security and compatibility rules."
---
# Writing an official plugin

This guide is for contributors adding an official plugin to the ProPR
repository. An official plugin is a folder `packages/plugins/<id>/`: a
manifest that describes everything ProPR can show without running any code,
and optionally a `handlers.ts` whose exported functions ProPR calls with a
scoped context. [Plugins](../features/plugins.md) describes how an
administrator installs and runs them; [Plugin runtime](../architecture/plugin-runtime.md)
describes how ProPR runs handlers. The [catalog](./catalog.md) lists the
plugins that ship today.

## Quick start

```bash
npm run plugins:new -- acme-chat --name "Acme Chat" --category messaging
```

creates:

| Path | What it is |
| --- | --- |
| `packages/plugins/acme-chat/manifest.json` | A valid manifest: one setting, the `events.read` permission and a `pull_request.merged` subscription. |
| `packages/plugins/acme-chat/handlers.ts` | The example handler `onPullRequestMerged`: counts merges per repository in `ctx.state`, skips repeated deliveries and logs. |
| `packages/plugins/acme-chat/README.md` | A README template with Setup, Permissions, Settings, a smoke-test checklist and documentation links. |
| `packages/plugins/acme-chat/icon.svg` | A placeholder icon. |
| `packages/plugins/test/acme-chat.test.ts` | Tests of the example handler with the [plugin test kit](#testing). |
| `docs/docs/plugins/acme-chat.md` | The plugin's docs page, listed in the sidebar and the catalog. |

and registers the plugin in `packages/plugins/registry.json` after the other
official plugins, then regenerates the plugin docs. The result passes these
checks without edits; run them again after every change:

```bash
npm run plugins:check                                 # manifests, registry, assets
npm run lint -w @propr/plugins                        # import rules
npm run typecheck -w @propr/plugins                   # handlers and test kit
npx tsx --test packages/plugins/test/acme-chat.test.ts
npm run plugins:docs                                  # regenerate catalog and reference (CI runs --check)
```

`--category` is one of `messaging`, `issue-tracking`, `observability`,
`deployment`, `context` and `other`. Then replace the example: write the
manifest, the handlers and their tests, fill in the README and the docs page,
and run the smoke-test checklist against a real account of the service.

## The plugin folder

| File | Required | Purpose |
| --- | --- | --- |
| `manifest.json` | yes | Everything ProPR shows about the plugin, as data. See the [manifest reference](#manifest-reference). |
| `README.md` | yes | What the plugin does, setup, permissions and the smoke-test checklist. |
| icon | yes | An `.svg` or `.png` file named by `icon`. |
| `handlers.ts` | with handlers | Exported async functions `(input, ctx) => result`. Every exported function is a handler, so export nothing else; put helpers in other files of the folder. |
| skill folders | per skill | A folder with a `SKILL.md` whose front matter `name` matches `contributes.skills[].name`. |
| automation template folders | per template | `template.json` and `prompt.md`, in the shipped automation template format. |
| fixtures | no | Recorded service payloads for the tests (see the Linear and Jira plugins). |

Code several plugins share goes in `packages/plugins/_shared/`, which may use
SDK types only. Tests go in `packages/plugins/test/`.

## MCP server contributions

A plugin can add MCP servers to the [extension library](../features/agent-extensions.md)
as managed items: they appear while the plugin is enabled and disappear when
it is disabled or uninstalled. Both shapes reuse the library's item rules, so
a plugin can never declare a server the library itself would refuse.

**Remote servers** (`kind: "https"`) name an `https://` URL, the tools the
agent may call, a `capability` and an `authentication`. A `bearer` server
names a `token` connection and an `oauth` server an `oauth` connection; ProPR
injects the credential and the handler never sees it.

```json
{ "kind": "https", "name": "acme", "url": "https://mcp.acme.example.com/mcp", "tools": ["search"], "capability": "read", "authentication": "oauth", "connection": "workspace" }
```

**Package servers** (`kind: "package"`) run a pinned npm package inside the
task container, through the library's local package server path:

- **Pinning.** `version` is exact: no ranges (`^2.0.0`), no tags (`latest`).
  Raising it is a manifest change reviewed like any other.
- **Integrity.** `integrity` is the registry's `sha512-…` value for that exact
  version. ProPR never asks the registry for another one: installation and
  every launch verify the package against the recorded value. Copy it from
  `npm view <package>@<version> dist.integrity`, and run
  `npm run plugins:check -- --online` to compare every recorded value with the
  registry (CI does not, as it needs network access).
- **Secret variables.** `env` holds plain values only. A secret goes in
  `secretEnv`, which maps a variable name to one of the plugin's `token`
  connections; the value is filled in at launch and is missing (the server is
  skipped for that run, with `secret_not_configured`) until the administrator
  sets it.
- **The acknowledgement.** A package server's secret variables are readable by
  anything running in the task container, including the agent. Installing the
  plugin therefore asks the administrator to acknowledge each server's
  variables; the acknowledgement records the package, version and variable
  names. When an upgrade changes any of them, the server stays inactive until
  an administrator acknowledges again, and the plugin shows **Needs approval**.

Use `capability: "write"` for a server whose tools change anything. A write
server reaches a run only through a `needsWrite` [command](#commands) an
administrator allowed, never by default.

## Handlers

A handler is an exported async function of `handlers.ts`, declared with
`definePluginHandler` so its input is typed:

```ts
import { definePluginHandler, type PluginEventInput } from '@propr/shared';

export const onMerged = definePluginHandler<PluginEventInput>(async (input, ctx) => {
  ctx.log.info(`#${input.event.prNumber} merged`, { repository: input.event.repository });
});
```

It receives one input envelope, by `kind`: `event` (a
[subscription](#events-and-payloads)), `webhook` (an
[inbound webhook](#webhook-verification)), `command` (a `handler`
[command](#commands)), `setting_options` (an [`optionsFrom`](#settings)
setting) or `invoke`. It returns nothing or a small JSON result (16 KiB).
`ctx` is the only way it touches anything:

| `ctx` member | What it is |
| --- | --- |
| `ctx.pluginId` | The plugin id. |
| `ctx.settings` | The installation's validated settings, with defaults. |
| `ctx.repositories` | The repository limit (`owner/repo` list), or `null` for all. |
| `ctx.propr` | ProPR, limited to the granted [permissions](#permissions) and the repository limit. |
| `ctx.http(connection?)` | `fetch`-like HTTPS to `outboundHosts` only; with a connection name, ProPR injects the credential or signs the request. |
| `ctx.state` | A small JSON key-value store: `get`, `set`, `delete`, `keys`, and `update`, an atomic read-and-replace. |
| `ctx.log` | `debug`, `info`, `warn`, `error(message, fields?)`, redacted and shown under Activity. |
| `ctx.signal` | Aborted when the handler runs past its time limit. |

A refused call throws a `PluginSdkError` with a `code`. To control retries,
throw `new PluginDeliveryError(message, { retryAfterMs })` (for a service's
`Retry-After`, which `parsePluginRetryAfter` reads) or
`new PluginDeliveryError(message, { permanent: true })` for a failure retrying
cannot fix. The full surface, every operation's permission and every limit is
listed in the [SDK reference](#sdk-reference).

## Events and payloads

A subscription delivers a [repository journal event](../architecture/repository-event-journal.md)
to a handler. It needs the `events.read` permission. `filter` narrows it with
equality on event fields or `payload.<key>`:

```json
"subscriptions": [
  { "on": "pull_request.merged", "handler": "onMerged" },
  { "on": "task.completed", "handler": "onTask", "filter": { "payload.kind": ["implementation", "review"] } }
]
```

The handler gets `{ kind: 'event', event, deliveryId, attempt, manual? }`.
Payloads carry identifiers and short coded values only: never pull request
bodies, comments, prompts, logs or diffs.

{/* BEGIN GENERATED event-payloads: npm run plugins:docs */}

Generated from `PLUGIN_EVENT_PAYLOAD_FIELDS` and `PLUGIN_EVENT_ENVELOPE_FIELDS` in `packages/shared/src/pluginContract.ts`. A key ending in `?` may be absent. The contract test fails when a key is removed or retyped.

`input.event`, the journal event:

| Field | Type |
| --- | --- |
| `seq` | `number` |
| `repository` | `string` |
| `domain` | `string` |
| `type` | `string` |
| `entityId` | `string` |
| `prNumber` | `number \| null` |
| `issueNumber` | `number \| null` |
| `planId` | `string \| null` |
| `headSha` | `string \| null` |
| `payload` | `object` |
| `occurredAt` | `string` |

`input.event.payload`, by event:

| `on` | Payload fields |
| --- | --- |
| `pull_request.opened` | `baseRef: string \| null`, `draft: boolean` |
| `pull_request.head_changed` | `previousHeadSha: string \| null` |
| `pull_request.review_scored` | `score: number`, `goal: number \| null`, `goalReached: boolean \| null`, `source: string`, `cycle: number \| null`, `reviewerModel: string \| null` |
| `pull_request.ultrafix_started` | `goal: number`, `maxCycles: number`, `workEpoch: number` |
| `pull_request.ultrafix_ended` | `outcome: string`, `finalScore: number \| null`, `reason: string \| null`, `workEpoch: number` |
| `pull_request.auto_merge_decision` | `reason: string`, `arm: boolean`, `opportunity: string`, `prNumber: number`, `action?: string`, `matchedPaths?: string[]`, `method?: string`, `detail?: string`, `headSha?: string`, `baseRef?: string`, `policyPath?: string`, `baseSha?: string` |
| `pull_request.merged` | none |
| `pull_request.closed` | none |
| `epic_queue.started` | `issues: number[]`, `advanceOn: string`, `parallel: boolean` |
| `epic_queue.advanced` | `fromIssue: number`, `toIssue: number`, `cursor: number` |
| `epic_queue.blocked` | `headIssue: number \| null`, `blockedReason: string` |
| `epic_queue.completed` | `fromIssue?: number`, `cursor: number` |
| `plan_issue.status_changed` | `from: string \| null`, `to: string` |
| `task.queued` | `taskId: string`, `kind: string`, `issueNumber: number \| null`, `prNumber: number \| null`, `agent: string \| null`, `model: string \| null`, `attempts: number` |
| `task.started` | `taskId: string`, `kind: string`, `issueNumber: number \| null`, `prNumber: number \| null`, `agent: string \| null`, `model: string \| null`, `attempts: number` |
| `task.completed` | `taskId: string`, `kind: string`, `issueNumber: number \| null`, `prNumber: number \| null`, `agent: string \| null`, `model: string \| null`, `attempts: number`, `status: string`, `terminalReason: string \| null`, `durationMs: number \| null`, `pullRequest: string \| null`, `failureCategory: string \| null` |
| `task.failed` | `taskId: string`, `kind: string`, `issueNumber: number \| null`, `prNumber: number \| null`, `agent: string \| null`, `model: string \| null`, `attempts: number`, `status: string`, `terminalReason: string \| null`, `durationMs: number \| null`, `pullRequest: string \| null`, `failureCategory: string \| null` |
| `task.cancelled` | `taskId: string`, `kind: string`, `issueNumber: number \| null`, `prNumber: number \| null`, `agent: string \| null`, `model: string \| null`, `attempts: number`, `status: string`, `terminalReason: string \| null`, `durationMs: number \| null`, `pullRequest: string \| null`, `failureCategory: string \| null` |

{/* END GENERATED event-payloads: npm run plugins:docs */}

## Webhook verification

Each `contributes.webhooks` entry gets its own URL,
`POST /api/plugins/<installation key>/hooks/<name>`. ProPR verifies every
request before any plugin code runs, with a `signing_secret` connection:

| Scheme | What ProPR checks |
| --- | --- |
| `hmac-sha256` | `header` equals `prefix` and the HMAC-SHA256 of the raw body (`hex` or `base64`), as GitHub's `X-Hub-Signature-256: sha256=…`. |
| `slack-v0` | Slack's `X-Slack-Signature`: `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<body>`; the timestamp must be within 5 minutes. |
| `token-header` | `header` equals `prefix` and the secret itself, compared in constant time, as GitLab's `X-Gitlab-Token`. |

A request that fails gets 401 and runs nothing. A verified one is answered
with 202 at once and runs `handler` from the delivery queue, with the
verification headers, cookies and authorization removed. Name the sender's
delivery id header in `deliveryIdHeader` so replays are refused and the
handler gets a stable `deliveryId`. A `respond` function may answer a
challenge (Slack's `url_verification`) synchronously; it receives the request
only, never `ctx`. If the service uses a scheme ProPR does not have, add the
scheme to `@propr/shared` and the webhook route with its published test
vectors; never verify inside a handler. See
[Inbound webhooks](../features/plugins.md#inbound-webhooks).

## Commands

A command is `/<name>` on the first line of an issue or pull request comment
(`where`). A `prompt` command queues an ordinary one-shot task with `prompt` as
the instruction and the rest of the line appended as untrusted text; it may add
the plugin's own `skills` and `servers` to that run. A `handler` command calls
`handler` with `{ kind: 'command', command, args, repository, number, target, actor, commentId }`
and starts no task. Names never shadow a built-in command and are unique across
plugins unless every plugin offering one marks it `shared` and names its own
`specific` command. `needsWrite` lets a prompt command use the write servers it
names, only after an administrator allowed it and only for commenters with
write permission. See [Commands](../features/plugins.md#commands).

## Settings

`settings` is a JSON Schema subset: strings (optionally an `enum`, an
`https-url` limited to `hosts`), numbers, booleans, string lists and
repository maps. Values are validated when saved and reach handlers as
`ctx.settings`. Put secrets in [connections](#connections), never in settings.

`optionsFrom` names a handler that loads a setting's choices from the service
(a tracker's teams, a workflow's states):

```json
"team": { "type": "string", "label": "Team", "optionsFrom": "teamOptions" }
```

```ts
export const teamOptions = definePluginHandler<PluginSettingOptionsInput, PluginSettingOptions>(async (_input, ctx) => {
  const response = await ctx.http('api-key')('https://api.acme.example/teams');
  if (!response.ok) throw new Error('Set the API key under Connections, then reload the form.');
  const { teams } = await response.json<{ teams: { id: string; name: string }[] }>();
  return { options: teams.map(team => ({ value: team.id, label: team.name })) };
});
```

It runs when an administrator opens the form, whether or not the plugin is
enabled, with `ctx.http` and `ctx.state` but no `ctx.propr` permission. Its
error message is shown next to the field, so say what to do.

## Connections

| Type | Use it for |
| --- | --- |
| `token` | An API key or token. `authorization` chooses `Bearer` (default), `raw` or `basic`. With `secretUrl`, the secret is a URL such as an incoming webhook URL, sent to with `ctx.http('<name>')(PLUGIN_CONNECTION_URL, …)`. |
| `oauth` | A sign-in for a remote MCP server, through the extension OAuth flow. List the narrowest `scopes`. |
| `signing_secret` | A shared secret that verifies inbound webhooks and signs outbound requests (`signature` in `ctx.http`). |

Each needs a `label`, `help` that says exactly what to paste, and a `helpUrl`
where to get it. Secrets are stored sealed, are never shown again and never
reach a handler.

## Permissions

Request the fewest. `events.read` for subscriptions; read permissions before
write ones; `tasks.create` only when the plugin starts work. A command may use
only permissions the plugin requests. An upgrade that requests a new
permission keeps the old grant until an administrator approves it, so adding
one is a visible change. The list is in the
[manifest reference](#permissions-1).

## Delivery guarantees and limits

- **At least once.** A delivery can repeat; `deliveryId` is the same on every
  attempt, so a handler with side effects records what it has done (in
  `ctx.state`) or uses the service's idempotency key.
- **In order per repository.** One plugin receives one repository's events
  one at a time, in journal order.
- **Time.** 30 seconds per attempt; `ctx.signal` aborts at the limit.
- **Retries.** After 1 minute, 5 minutes, 30 minutes and 2 hours, then failed.
  `PluginDeliveryError` changes the delay or makes the failure permanent.
- **No history.** A plugin receives events from the moment it is enabled.
- **Never in the way.** A failing handler never fails or delays the task,
  review or merge that produced the event. Repeated failures mark the plugin
  Degraded, then pause its deliveries until an administrator resumes them.

Size limits are in the [SDK reference](#sdk-reference).
[Delivery guarantees and limits](../features/plugins.md#delivery-guarantees-and-limits)
has the details.

## Security rules

- **External text is untrusted.** Webhook bodies, ticket titles, comment
  arguments and service responses are data, never instructions: do not build
  prompts from them without delimiting them as untrusted, do not use them as
  URLs, hosts or paths, and keep them out of log messages (log lengths and ids
  instead). Validate what you parse; prefer allowlists.
- **No secrets in handlers.** Never put a credential in the manifest, a
  setting, state, a log line or a result. Use a connection and let `ctx.http`
  inject it; a secret URL is sent to with `PLUGIN_CONNECTION_URL`.
- **No core imports.** Handler code imports `@propr/shared`, Node built-ins
  and files of its own package only. A lint rule for `packages/plugins/**`
  enforces it (`npm run lint -w @propr/plugins`), which is what lets the same
  plugin run out of process later.
- **Narrowest scopes.** The fewest permissions, `outboundHosts` that name exact
  hosts, read-only MCP servers unless writes are the point, OAuth and API token
  scopes as narrow as the service allows, and setting `hosts` for URLs an
  administrator enters.
- **Verify before acting.** Inbound requests are verified by ProPR with a
  built-in scheme; a handler never verifies or trusts an unverified request.
- **Never interact with a running task.** Handlers observe and create new
  work; they do not steer tasks in progress.

## Testing

`packages/plugins/testing` exports `createTestPluginContext(options)`, a fake
`ctx` that applies the same permission, repository, host, HTTPS and state
checks as the real one:

```ts
import { createTestPluginContext } from '../testing/index.js';

const kit = createTestPluginContext({ grantedPermissions: manifest.permissions, outboundHosts: manifest.outboundHosts, settings: { team: 'ENG' } });
kit.respond('https://api.acme.example/', { json: { ok: true } });
await onMerged(input, kit.ctx);
kit.calls;    // ctx.propr calls that passed the checks
kit.requests; // ctx.http requests as sent
kit.state;    // the in-memory state
kit.logs;     // captured log lines
```

Pass the manifest's own permissions and hosts, as the scaffolded test does,
so a handler that needs more fails in the test rather than in production.
Record real service payloads as fixtures, and test repeated deliveries,
refused credentials and the repository limit.

## Worked example

A plugin that labels pull requests whose review scored below a threshold, and
removes the label once a later review reaches it. It needs to receive events
and change labels, and nothing else: no connection, no outbound host.

`packages/plugins/review-label/manifest.json`:

```json
{
  "manifestVersion": 1,
  "id": "review-label",
  "name": "Review label",
  "description": "Labels pull requests whose ProPR review scored below a threshold, and removes the label once a review reaches it.",
  "version": "1.0.0",
  "category": "other",
  "homepage": "https://github.com/integry/propr/tree/main/packages/plugins/review-label",
  "icon": "icon.svg",
  "permissions": ["events.read", "labels.write"],
  "settings": {
    "type": "object",
    "properties": {
      "threshold": { "type": "number", "label": "Threshold", "help": "Scores below this get the label.", "minimum": 0, "maximum": 100, "integer": true, "default": 80 },
      "label": { "type": "string", "label": "Label", "default": "needs-attention", "maxLength": 50 }
    },
    "required": []
  },
  "contributes": {
    "subscriptions": [{ "on": "pull_request.review_scored", "handler": "onReviewScored", "filter": { "payload.source": "review" } }]
  }
}
```

`packages/plugins/review-label/handlers.ts`:

```ts
import { definePluginHandler, type PluginEventInput, type ReviewScoredEventPayload } from '@propr/shared';

export const onReviewScored = definePluginHandler<PluginEventInput, { labelled: boolean }>(async ({ event }, ctx) => {
  if (event.prNumber === null) return { labelled: false };
  const { score } = event.payload as unknown as ReviewScoredEventPayload;
  const threshold = typeof ctx.settings.threshold === 'number' ? ctx.settings.threshold : 80;
  const label = typeof ctx.settings.label === 'string' && ctx.settings.label ? ctx.settings.label : 'needs-attention';
  // Adding or removing a label twice changes nothing, so a repeated delivery is harmless.
  if (score < threshold) await ctx.propr.addLabel(event.repository, event.prNumber, label);
  else await ctx.propr.removeLabel(event.repository, event.prNumber, label);
  return { labelled: score < threshold };
});
```

`packages/plugins/test/review-label.test.ts`:

```ts
const kit = createTestPluginContext({ grantedPermissions: manifest.permissions, settings: { threshold: 70, label: 'low-score' } });
assert.deepEqual(await onReviewScored(scored({ prNumber: 12, score: 55 }), kit.ctx), { labelled: true });
assert.deepEqual(await onReviewScored(scored({ prNumber: 12, score: 91 }), kit.ctx), { labelled: false });
assert.deepEqual(kit.calls, [
  { operation: 'addLabel', args: ['owner/repo', 12, 'low-score'] },
  { operation: 'removeLabel', args: ['owner/repo', 12, 'low-score'] },
]);
// Without labels.write the call is refused, as it would be in ProPR.
const readOnly = createTestPluginContext({ grantedPermissions: ['events.read'] });
await assert.rejects(onReviewScored(scored({ prNumber: 12, score: 10 }), readOnly.ctx), { code: 'permission_denied' });
```

The handler reads only the payload's `score`, a field the
[compatibility rules](#compatibility-rules) guarantee, and its settings have
defaults, so it works as soon as it is enabled. The filter keeps Ultrafix
cycle scores out; the plugin's repository limit decides which repositories it
labels.

## Before you open the pull request

- [ ] `npm run plugins:check`, `npm run lint -w @propr/plugins`,
      `npm run typecheck -w @propr/plugins` and the plugin's tests pass.
- [ ] `npm run plugins:docs` leaves no changes: the catalog, sidebar and
      reference are current.
- [ ] The README and the docs page describe setup, permissions, settings and
      what the plugin never sends.
- [ ] The smoke-test checklist was run against a real account, and the
      results are in the pull request description.
- [ ] Every new permission, outbound host, scope and package version is
      justified in the pull request.

## Compatibility rules

Plugins are written against three interfaces, and each changes in one
direction only. `packages/shared/src/pluginContract.ts` describes all three as
data; `packages/shared/test/pluginContract.test.ts` compares it with the
committed snapshot `packages/shared/test/contracts/plugin-contract.snapshot.json`
and fails on a breaking change. A fixture of an earlier interface
(`packages/shared/test/fixtures/plugin-contract/`) shows that each kind of
breaking change is caught.

1. **The manifest.** Additive changes (a new optional field, a new union
   variant, a new enum value, a looser limit) keep `manifestVersion`. A
   breaking change (removing or retyping a field, making a field required,
   adding a required field to an existing object, dropping an enum value)
   adds a new `manifestVersion`, and ProPR keeps reading the old version for
   at least one minor release: the old version stays in
   `PLUGIN_SUPPORTED_MANIFEST_VERSIONS` and the official manifests are
   migrated before it is dropped. The contract test fails on a breaking change
   that keeps the version, and on a new version that stops reading the old one.
2. **Event payloads are additive only within a domain.** A payload key is
   never removed, retyped or made optional; an event type is never removed.
   New keys and new event types are fine. The contract test snapshots every
   event type's payload keys and types, and fails on a removal or a type
   change.
3. **`ctx` operations are additive only.** `ctx` members, `ctx.propr`
   operations and the permission each needs, `ctx.state` methods, `ctx.log`
   levels, input envelope fields, error codes and the SDK module's runtime
   exports may be added, never removed or changed. The contract test snapshots
   that surface; type checks in `pluginContract.ts` keep the snapshot in step
   with the TypeScript types.

After an additive change, record it with `npm run plugins:contract:update`
(the test reports that the snapshot is out of date until you do). The script
refuses a breaking change; `--accept-breaking` exists for the rare reviewed
exception, such as removing a manifest version after its grace release.

## Manifest reference

{/* BEGIN GENERATED manifest-reference: npm run plugins:docs */}

The manifest schema is `pluginManifestSchema` in `packages/shared/src/plugins.ts`. This reference is generated from it (`npm run plugins:docs`), and CI fails when it is out of date. Paths use `.` between properties, `[]` for list entries, `<key>` for map values and `{type=token}` for one variant of a union. Unknown fields are refused everywhere. The same schema is published as JSON Schema at [`/schemas/plugin-manifest.v1.schema.json`](pathname:///schemas/plugin-manifest.v1.schema.json) for editor validation; it describes the field shapes, not the cross-checks (connection references, command rules) that `npm run plugins:check` adds.

Current `manifestVersion`: `1`. Versions ProPR reads: `1`.

### Top-level fields

| Field | Type and rules | Description |
| --- | --- | --- |
| `manifestVersion` | `1`; **required** | The manifest format version. See [Compatibility rules](#compatibility-rules). |
| `id` | `string`; **required**; at most 48 characters; matches `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` | Unique plugin id, equal to the folder name `packages/plugins/<id>/`. Some names (`src`, `dist`, `test`, `testing`, `node_modules`, `propr`) are reserved. |
| `name` | `string`; **required**; not empty; at most 80 characters | Name shown in the catalog and on the Plugins page. |
| `description` | `string`; **required**; not empty; at most 500 characters | What the plugin does, shown in the catalog. Its first sentence is the one-line summary of the docs catalog. |
| `version` | `string`; **required** | Semantic version of the plugin, such as `1.2.0`. Raise it with every change an administrator should notice. |
| `category` | `string`; **required**; one of `messaging`, `issue-tracking`, `observability`, `deployment`, `context`, `other` | Catalog category. |
| `homepage` | `string`; **required**; at most 2048 characters; an https:// URL | An `https://` URL with more information, usually the plugin folder on GitHub. |
| `icon` | `string`; **required**; at most 256 characters; matches `^(?!\/)[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$`; matches `\.(svg\|png)$` | Path of an `.svg` or `.png` file inside the plugin folder. |
| `permissions` | `string[]`; default `[]`; at most 11 entries; each one of `events.read`, `tasks.read`, `tasks.create`, `issues.read`, `issues.create`, `issues.comment`, `pull_requests.read`, `pull_requests.comment`, `labels.write`, `repositories.read`, `notifications.send` | What the handlers may do through `ctx.propr`, from a closed list. Ask for the fewest: the administrator approves each one, and an upgrade that asks for more waits for approval. |
| `connections` | `object[]`; default `[]`; at most 16 entries | Named credentials the administrator provides. Handlers never read them; ProPR injects them. |
| `settings` | `object`; default `{"type":"object","properties":{},"required":[]}` | The settings form, as a JSON Schema subset. Values are validated on save and passed to handlers as `ctx.settings`. |
| `outboundHosts` | `string[]`; default `[]`; at most 32 entries; each at most 253 characters | Host names the handlers may call with `ctx.http`, such as `api.example.com`. No scheme, port, path, wildcard or IP address. |
| `outboundHostsFromSettings` | `string[]`; default `[]`; at most 64 entries; each matches `^[A-Za-z][A-Za-z0-9_]{0,47}$` | Keys of `https-url` settings whose host the handlers may also call, as the administrator saved it. |
| `contributes` | `object` | What the plugin adds to ProPR. |

### Connections

| Field | Type and rules | Description |
| --- | --- | --- |
| `connections[]{type=oauth}.type` | `"oauth"`; **required** | Connection type: `oauth` (a sign-in), `token` (a pasted secret) or `signing_secret` (a shared secret that verifies inbound webhooks and signs outbound requests). |
| `connections[]{type=oauth}.name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Name the manifest and `ctx.http(<name>)` use. Unique within the plugin. |
| `connections[]{type=oauth}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field on the Plugins page. |
| `connections[]{type=oauth}.help` | `string`; **required**; not empty; at most 500 characters | What to paste or sign in with, shown under the field. |
| `connections[]{type=oauth}.helpUrl` | `string`; **required**; at most 2048 characters; an https:// URL | Where the administrator obtains the credential. |
| `connections[]{type=oauth}.registrations` | `string[]`; default `["metadata_document","dynamic","preregistered"]`; at least 1 entry; at most 3 entries; each one of `metadata_document`, `dynamic`, `preregistered` | OAuth client registration methods allowed, in the order the sign-in tries them. |
| `connections[]{type=oauth}.scopes` | `string[]`; at most 32 entries; each matches `^[\x21\x23-\x5b\x5d-\x7e]{1,256}$` | OAuth scopes to request. Ask for the narrowest scopes the plugin needs. |
| `connections[]{type=token}.type` | `"token"`; **required** | Connection type: `oauth` (a sign-in), `token` (a pasted secret) or `signing_secret` (a shared secret that verifies inbound webhooks and signs outbound requests). |
| `connections[]{type=token}.name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Name the manifest and `ctx.http(<name>)` use. Unique within the plugin. |
| `connections[]{type=token}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field on the Plugins page. |
| `connections[]{type=token}.help` | `string`; **required**; not empty; at most 500 characters | What to paste or sign in with, shown under the field. |
| `connections[]{type=token}.helpUrl` | `string`; **required**; at most 2048 characters; an https:// URL | Where the administrator obtains the credential. |
| `connections[]{type=token}.secretUrl` | `object` | The secret is a URL (an incoming webhook URL) instead of a token. Handlers send to it with `PLUGIN_CONNECTION_URL` and never learn it. |
| `connections[]{type=token}.secretUrl.hosts` | `string[]`; **required**; at least 1 entry; at most 8 entries; each at most 253 characters | Hosts the URL must be on: host names, or `*.` and a name for any name under it. |
| `connections[]{type=token}.secretUrl.pathPrefixes` | `string[]`; at least 1 entry; at most 8 entries; each at most 200 characters; each matches `^\/[A-Za-z0-9_.~/-]*$` | Paths the URL must start with, such as `/services/`. |
| `connections[]{type=token}.authorization` | `string`; one of `bearer`, `raw`, `basic` | How `ctx.http` sends the token: `bearer` (`Authorization: Bearer <token>`, the default), `raw` (`Authorization: <token>`) or `basic` (the token is entered as `<user>:<secret>`). MCP servers always receive it as Bearer. |
| `connections[]{type=signing_secret}.type` | `"signing_secret"`; **required** | Connection type: `oauth` (a sign-in), `token` (a pasted secret) or `signing_secret` (a shared secret that verifies inbound webhooks and signs outbound requests). |
| `connections[]{type=signing_secret}.name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Name the manifest and `ctx.http(<name>)` use. Unique within the plugin. |
| `connections[]{type=signing_secret}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field on the Plugins page. |
| `connections[]{type=signing_secret}.help` | `string`; **required**; not empty; at most 500 characters | What to paste or sign in with, shown under the field. |
| `connections[]{type=signing_secret}.helpUrl` | `string`; **required**; at most 2048 characters; an https:// URL | Where the administrator obtains the credential. |

### Settings

| Field | Type and rules | Description |
| --- | --- | --- |
| `settings.type` | `"object"`; **required** | Always `object`. |
| `settings.properties` | `map`; **required** | The settings by key. |
| `settings.properties.<key>` | `object` | One setting. The key is letters, digits and `_`, starting with a letter. |
| `settings.properties.<key>{type=string}.type` | `"string"`; **required** | Setting type: `string`, `number`, `boolean`, `array` (a string list) or `object` (a repository map). |
| `settings.properties.<key>{type=string}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field. |
| `settings.properties.<key>{type=string}.help` | `string`; not empty; at most 500 characters | Help text under the field. |
| `settings.properties.<key>{type=string}.default` | `string`; at most 500 characters | Value used until the administrator saves another. Must satisfy the setting's own rules. |
| `settings.properties.<key>{type=string}.enum` | `string[]`; at least 1 entry; at most 64 entries; each not empty; each at most 100 characters | The allowed values: the field becomes a select. |
| `settings.properties.<key>{type=string}.maxLength` | `integer`; at most 500 | Longest value accepted. |
| `settings.properties.<key>{type=string}.format` | `string`; one of `https-url` | `https-url`: an `https://` URL on a public host name, never an IP address or a local name. |
| `settings.properties.<key>{type=string}.hosts` | `string[]`; at least 1 entry; at most 8 entries; each at most 253 characters | With `format: https-url`: the hosts the URL must be on, such as `*.atlassian.net`. |
| `settings.properties.<key>{type=string}.optionsFrom` | `string`; matches `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` | An exported handler that lists the choices from the service (input kind `setting_options`). Cannot be combined with `enum` or `format`. |
| `settings.properties.<key>{type=number}.type` | `"number"`; **required** | Setting type: `string`, `number`, `boolean`, `array` (a string list) or `object` (a repository map). |
| `settings.properties.<key>{type=number}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field. |
| `settings.properties.<key>{type=number}.help` | `string`; not empty; at most 500 characters | Help text under the field. |
| `settings.properties.<key>{type=number}.default` | `number` | Value used until the administrator saves another. Must satisfy the setting's own rules. |
| `settings.properties.<key>{type=number}.minimum` | `number` | Smallest value accepted. |
| `settings.properties.<key>{type=number}.maximum` | `number` | Largest value accepted. |
| `settings.properties.<key>{type=number}.integer` | `boolean` | Accept whole numbers only. |
| `settings.properties.<key>{type=boolean}.type` | `"boolean"`; **required** | Setting type: `string`, `number`, `boolean`, `array` (a string list) or `object` (a repository map). |
| `settings.properties.<key>{type=boolean}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field. |
| `settings.properties.<key>{type=boolean}.help` | `string`; not empty; at most 500 characters | Help text under the field. |
| `settings.properties.<key>{type=boolean}.default` | `boolean` | Value used until the administrator saves another. Must satisfy the setting's own rules. |
| `settings.properties.<key>{type=array}.type` | `"array"`; **required** | Setting type: `string`, `number`, `boolean`, `array` (a string list) or `object` (a repository map). |
| `settings.properties.<key>{type=array}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field. |
| `settings.properties.<key>{type=array}.help` | `string`; not empty; at most 500 characters | Help text under the field. |
| `settings.properties.<key>{type=array}.items` | `object`; **required** | The entries: always strings. |
| `settings.properties.<key>{type=array}.items.type` | `"string"`; **required** | Always `string`. |
| `settings.properties.<key>{type=array}.items.enum` | `string[]`; at least 1 entry; at most 64 entries; each not empty; each at most 100 characters | Every entry is one of these values: the field becomes a set of checkboxes. |
| `settings.properties.<key>{type=array}.default` | `string[]`; at most 256 entries; each at most 500 characters | Value used until the administrator saves another. Must satisfy the setting's own rules. |
| `settings.properties.<key>{type=array}.maxItems` | `integer`; at most 256 | Most entries accepted. |
| `settings.properties.<key>{type=object}.type` | `"object"`; **required** | Setting type: `string`, `number`, `boolean`, `array` (a string list) or `object` (a repository map). |
| `settings.properties.<key>{type=object}.label` | `string`; **required**; not empty; at most 100 characters | Label of the field. |
| `settings.properties.<key>{type=object}.help` | `string`; not empty; at most 500 characters | Help text under the field. |
| `settings.properties.<key>{type=object}.format` | `"repository-map"`; **required** | Always `repository-map`: one value per repository, keyed by `owner/repo`. |
| `settings.properties.<key>{type=object}.additionalProperties` | `object`; **required** | The value of each repository. |
| `settings.properties.<key>{type=object}.additionalProperties.type` | `"string"`; **required** | Always `string`. |
| `settings.properties.<key>{type=object}.optionsFrom` | `string`; matches `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` | An exported handler that lists the choices from the service (input kind `setting_options`). Cannot be combined with `enum` or `format`. |
| `settings.properties.<key>{type=object}.default` | `map` | Value used until the administrator saves another. Must satisfy the setting's own rules. |
| `settings.properties.<key>{type=object}.default.<key>` | `string`; at most 500 characters | Default value of one repository (`owner/repo`). |
| `settings.required` | `string[]`; default `[]`; each matches `^[A-Za-z][A-Za-z0-9_]{0,47}$` | Keys of settings that must have a value before the plugin can be enabled. |

### MCP servers

| Field | Type and rules | Description |
| --- | --- | --- |
| `contributes.mcpServers` | `object[]`; default `[]`; at most 16 entries | MCP servers added to the extension library as managed items while the plugin is enabled. |
| `contributes.mcpServers[]{kind=https}.kind` | `"https"`; **required** | `https`: a remote server; `package`: a local server from a pinned npm package. |
| `contributes.mcpServers[]{kind=https}.name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Server name, unique within the plugin. Commands name it in `servers`. |
| `contributes.mcpServers[]{kind=https}.url` | `string`; **required**; at most 2048 characters; an https:// URL | The `https://` endpoint. |
| `contributes.mcpServers[]{kind=https}.tools` | `string[]`; **required**; at most 64 entries; each matches `^[A-Za-z0-9_.-]{1,128}$` | The tools the agent may call: an allowlist. |
| `contributes.mcpServers[]{kind=https}.capability` | `string`; **required**; one of `read`, `write` | `read` or `write`. A write server reaches a run only with explicit write authorization. |
| `contributes.mcpServers[]{kind=https}.authentication` | `string`; **required**; one of `none`, `bearer`, `oauth` | `none`, `bearer` (with a `token` connection) or `oauth` (with an `oauth` connection). |
| `contributes.mcpServers[]{kind=https}.connection` | `string`; matches `^[a-z][a-z0-9_-]{0,47}$` | The connection that authenticates the server; required unless `authentication` is `none`. |
| `contributes.mcpServers[]{kind=package}.name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Server name, unique within the plugin. Commands name it in `servers`. |
| `contributes.mcpServers[]{kind=package}.tools` | `string[]`; **required**; at most 64 entries; each matches `^[A-Za-z0-9_.-]{1,128}$` | The tools the agent may call: an allowlist. |
| `contributes.mcpServers[]{kind=package}.capability` | `string`; **required**; one of `read`, `write` | `read` or `write`. A write server reaches a run only with explicit write authorization. |
| `contributes.mcpServers[]{kind=package}.kind` | `"package"`; **required** | `https`: a remote server; `package`: a local server from a pinned npm package. |
| `contributes.mcpServers[]{kind=package}.ecosystem` | `string`; **required**; one of `npm` | Package ecosystem: `npm`. |
| `contributes.mcpServers[]{kind=package}.package` | `string`; **required**; at most 214 characters | The npm package name. |
| `contributes.mcpServers[]{kind=package}.version` | `string`; **required**; at most 256 characters | An exact version: no ranges (`^2.0.0`) and no tags (`latest`). |
| `contributes.mcpServers[]{kind=package}.integrity` | `string`; **required** | The `sha512-…` integrity value of that version, as the npm registry reports it. Installation and every launch verify it. |
| `contributes.mcpServers[]{kind=package}.bin` | `string`; matches `^[A-Za-z0-9@._-]{1,128}$` | The package binary to run, when the package has several. |
| `contributes.mcpServers[]{kind=package}.args` | `string[]`; default `[]`; at most 64 entries; each at most 2048 characters; each matches `^[^\x00\r\n]*$` | Fixed arguments. |
| `contributes.mcpServers[]{kind=package}.env` | `object[]`; default `[]`; at most 32 entries | Plain environment variables. Never put a secret here. |
| `contributes.mcpServers[]{kind=package}.env[].name` | `string`; **required**; matches `^[A-Z_][A-Z0-9_]{0,99}$` | Variable name. |
| `contributes.mcpServers[]{kind=package}.env[].value` | `string`; **required**; at most 4096 characters; matches `^[^\x00\r\n]*$` | Variable value. |
| `contributes.mcpServers[]{kind=package}.secretEnv` | `object[]`; default `[]`; at most 16 entries | Secret variables, each filled from a `token` connection. The administrator acknowledges at install that they are readable inside the task container. |
| `contributes.mcpServers[]{kind=package}.secretEnv[].name` | `string`; **required**; matches `^[A-Z_][A-Z0-9_]{0,99}$` | Variable name. |
| `contributes.mcpServers[]{kind=package}.secretEnv[].connection` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | The `token` connection whose value it receives. |

### Skills and automation templates

| Field | Type and rules | Description |
| --- | --- | --- |
| `contributes.skills` | `object[]`; default `[]`; at most 16 entries | Skill bundles added to the extension library. |
| `contributes.skills[].name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Skill name; its `SKILL.md` front matter must use the same name. |
| `contributes.skills[].path` | `string`; **required**; at most 256 characters; matches `^(?!\/)[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$` | The skill folder inside the plugin folder. |
| `contributes.automationTemplates` | `object[]`; default `[]`; at most 16 entries | Automation templates added to the template catalog. |
| `contributes.automationTemplates[].id` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Template id, equal to the `id` of its `template.json`. |
| `contributes.automationTemplates[].path` | `string`; **required**; at most 256 characters; matches `^(?!\/)[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$` | The template folder (`template.json` and `prompt.md`) inside the plugin folder. |

### Commands

| Field | Type and rules | Description |
| --- | --- | --- |
| `contributes.commands` | `object[]`; default `[]`; at most 32 entries | Slash commands for issue and pull request comments. |
| `contributes.commands[].name` | `string`; **required**; matches `^[a-z][a-z0-9-]{0,31}$` | Used as `/<name>`. Never a built-in command, and unique across plugins unless shared. |
| `contributes.commands[].description` | `string`; **required**; not empty; at most 200 characters | Shown in command help and on the Plugins page. |
| `contributes.commands[].where` | `string[]`; **required**; at least 1 entry; at most 2 entries; each one of `pull_request`, `issue` | Where the command works: `pull_request`, `issue` or both. |
| `contributes.commands[].kind` | `string`; **required**; one of `prompt`, `handler` | `prompt`: queues a one-shot task with `prompt`; `handler`: calls `handler` with the comment context. |
| `contributes.commands[].prompt` | `string`; not empty; at most 4000 characters | The instruction of a `prompt` command. The rest of the command line is appended as untrusted text. |
| `contributes.commands[].handler` | `string`; matches `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` | The exported handler a `handler` command calls. |
| `contributes.commands[].skills` | `string[]`; default `[]`; at most 16 entries; each matches `^[a-z][a-z0-9_-]{0,47}$` | This plugin's skills a `prompt` command adds to its run. |
| `contributes.commands[].servers` | `string[]`; default `[]`; at most 16 entries; each matches `^[a-z][a-z0-9_-]{0,47}$` | This plugin's MCP servers a `prompt` command adds to its run. |
| `contributes.commands[].needsWrite` | `boolean`; default `false` | The command may use the write servers it names: it runs only when an administrator allowed it and the commenter has write permission. |
| `contributes.commands[].shared` | `boolean`; default `false` | A name several plugins may offer, such as `/deploy`. |
| `contributes.commands[].specific` | `string[]`; default `[]`; at most 32 entries; each matches `^[a-z][a-z0-9-]{0,31}$` | Of a shared command: this plugin's own commands that perform the same operation. |
| `contributes.commands[].permissions` | `string[]`; default `[]`; at most 11 entries; each one of `events.read`, `tasks.read`, `tasks.create`, `issues.read`, `issues.create`, `issues.comment`, `pull_requests.read`, `pull_requests.comment`, `labels.write`, `repositories.read`, `notifications.send` | Permissions the command uses; each must be one the plugin requests. |

### Event subscriptions

| Field | Type and rules | Description |
| --- | --- | --- |
| `contributes.subscriptions` | `object[]`; default `[]`; at most 64 entries | Repository events delivered to handlers. Needs `events.read`. |
| `contributes.subscriptions[].on` | `string`; **required** | The event, `<domain>.<type>`, such as `pull_request.merged`. See [Events and payloads](#events-and-payloads). |
| `contributes.subscriptions[].handler` | `string`; **required**; matches `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` | The exported handler that receives it. |
| `contributes.subscriptions[].filter` | `map` | Only events whose fields all match: an event field (`repository`, `entityId`, `prNumber`, `issueNumber`, `planId`, `headSha`) or `payload.<key>`. |
| `contributes.subscriptions[].filter.<key>` | `string \| number \| boolean \| null \| (string \| number \| boolean \| null)[]` | The value to match, or a list of values that each match. |

### Webhooks

| Field | Type and rules | Description |
| --- | --- | --- |
| `contributes.webhooks` | `object[]`; at most 16 entries | Inbound webhooks, each with its own URL. |
| `contributes.webhooks[].name` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | Webhook name, the last segment of its URL. |
| `contributes.webhooks[].description` | `string`; **required**; not empty; at most 200 characters | Shown next to its URL on the Plugins page. |
| `contributes.webhooks[].handler` | `string`; **required**; matches `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` | The exported handler that receives verified requests. |
| `contributes.webhooks[].verification` | `object`; **required** | How ProPR verifies each request before any plugin code runs. |
| `contributes.webhooks[].verification{scheme=hmac-sha256}.scheme` | `"hmac-sha256"`; **required** | `hmac-sha256`, `slack-v0` or `token-header`. See [Webhook verification](#webhook-verification). |
| `contributes.webhooks[].verification{scheme=hmac-sha256}.header` | `string`; **required**; matches `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$` | The header carrying the signature or token. |
| `contributes.webhooks[].verification{scheme=hmac-sha256}.prefix` | `string`; not empty; at most 32 characters; matches `^[\x20-\x7e]+$` | Text before the signature or token, such as `sha256=` or `Bearer `. |
| `contributes.webhooks[].verification{scheme=hmac-sha256}.encoding` | `string`; default `"hex"`; one of `hex`, `base64` | Encoding of the HMAC: `hex` or `base64`. |
| `contributes.webhooks[].verification{scheme=hmac-sha256}.connection` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | The `signing_secret` connection holding the secret. |
| `contributes.webhooks[].verification{scheme=slack-v0}.scheme` | `"slack-v0"`; **required** | `hmac-sha256`, `slack-v0` or `token-header`. See [Webhook verification](#webhook-verification). |
| `contributes.webhooks[].verification{scheme=slack-v0}.connection` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | The `signing_secret` connection holding the secret. |
| `contributes.webhooks[].verification{scheme=token-header}.scheme` | `"token-header"`; **required** | `hmac-sha256`, `slack-v0` or `token-header`. See [Webhook verification](#webhook-verification). |
| `contributes.webhooks[].verification{scheme=token-header}.header` | `string`; **required**; matches `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$` | The header carrying the signature or token. |
| `contributes.webhooks[].verification{scheme=token-header}.prefix` | `string`; not empty; at most 32 characters; matches `^[\x20-\x7e]+$` | Text before the signature or token, such as `sha256=` or `Bearer `. |
| `contributes.webhooks[].verification{scheme=token-header}.connection` | `string`; **required**; matches `^[a-z][a-z0-9_-]{0,47}$` | The `signing_secret` connection holding the secret. |
| `contributes.webhooks[].deliveryIdHeader` | `string`; matches `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$` | The header carrying the sender's delivery id, used to refuse replays and as `deliveryId`. |
| `contributes.webhooks[].respond` | `string`; matches `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` | An exported function that may answer the request at once (a challenge echo). It receives the request only, never `ctx`. |

### Permissions

| Permission | What it allows |
| --- | --- |
| `events.read` | Receive ProPR task, pull request and automation events |
| `tasks.read` | Read tasks and their status |
| `tasks.create` | Start tasks |
| `issues.read` | Read issues of the repositories it is enabled for |
| `issues.create` | Create issues |
| `issues.comment` | Comment on issues |
| `pull_requests.read` | Read pull requests |
| `pull_requests.comment` | Comment on pull requests |
| `labels.write` | Add and remove labels on issues and pull requests |
| `repositories.read` | List repositories ProPR manages |
| `notifications.send` | Send ProPR notifications |

### Manifest limits

Most entries per list (`PLUGIN_LIMITS`); `text` is the longest free text such as a `help`.

| Limit | Value |
| --- | --- |
| `permissions` | 11 |
| `connections` | 16 |
| `settings` | 64 |
| `outboundHosts` | 32 |
| `mcpServers` | 16 |
| `skills` | 16 |
| `automationTemplates` | 16 |
| `commands` | 32 |
| `subscriptions` | 64 |
| `webhooks` | 16 |
| `enumValues` | 64 |
| `listItems` | 256 |
| `text` | 500 |

{/* END GENERATED manifest-reference: npm run plugins:docs */}

## SDK reference

{/* BEGIN GENERATED sdk-surface: npm run plugins:docs */}

Generated from `packages/shared/src/pluginSdk.ts` and `pluginContract.ts`. Every item is part of the compatibility contract: it is only ever added to.

`ctx` members: `pluginId`, `settings`, `repositories`, `propr`, `http`, `state`, `log`, `signal`. `ctx.state` methods: `get`, `set`, `delete`, `update`, `keys`. `ctx.log` levels: `debug`, `info`, `warn`, `error`.

| Operation | Permission |
| --- | --- |
| `ctx.propr.getPullRequest` | `pull_requests.read` |
| `ctx.propr.getIssue` | `issues.read` |
| `ctx.propr.getTask` | `tasks.read` |
| `ctx.propr.listEvents` | `events.read` |
| `ctx.propr.createIssue` | `issues.create` |
| `ctx.propr.createTask` | `tasks.create` |
| `ctx.propr.commentOnPullRequest` | `pull_requests.comment` |
| `ctx.propr.commentOnIssue` | `issues.comment` |
| `ctx.propr.addLabel` | `labels.write` |
| `ctx.propr.removeLabel` | `labels.write` |

Handler inputs (a `?` marks an optional field):

| `kind` | Fields |
| --- | --- |
| `event` | `kind`, `event`, `deliveryId`, `attempt`, `manual?` |
| `webhook` | `kind`, `webhook`, `headers`, `body`, `receivedAt`, `deliveryId`, `attempt` |
| `command` | `kind`, `command`, `args`, `repository`, `number`, `target`, `actor`, `commentId`, `deliveryId`, `attempt` |
| `invoke` | `kind`, `payload` |
| `setting_options` | `kind`, `setting` |

`PluginSdkError` codes: `permission_denied`, `repository_not_allowed`, `not_found`, `invalid_input`, `host_not_allowed`, `insecure_url`, `private_address`, `connection_unavailable`, `response_too_large`, `http_failed`, `state_limit`, `unavailable`.

Runtime exports of the SDK module: `PLUGIN_HANDLER_TIMEOUT_MS`, `PLUGIN_HTTP_LIMITS`, `PLUGIN_LOG_LIMITS`, `PLUGIN_PROPR_LIMITS`, `PLUGIN_PROPR_OPERATIONS`, `PLUGIN_RETRY_AFTER_LIMITS_MS`, `PLUGIN_SDK_ERROR_CODES`, `PLUGIN_SETTING_OPTIONS_LIMITS`, `PLUGIN_STATE_LIMITS`, `PLUGIN_WEBHOOK_LIMITS`, `PluginDeliveryError`, `PluginSdkError`, `clampPluginRetryAfter`, `definePluginHandler`, `definePluginWebhookResponder`, `parsePluginRetryAfter`, `parsePluginSettingOptions`.

Limits:

| Limit | Value |
| --- | --- |
| Handler run time | 30 s |
| `ctx.state` | 256 keys of at most 200 characters; 16 KiB per value; 256 KiB in all |
| `ctx.http` | requests 256 KiB, responses 1024 KiB, 10 s, 64 headers |
| `ctx.log` | 200 lines per run, 2000 characters per message, 4 KiB of fields |
| `ctx.propr` text | titles 256 characters, bodies 65536, 20 labels of 50, 100 events per `listEvents` |
| Inbound webhooks | bodies 256 KiB, `respond` answers 4 KiB, delivery ids 200 characters, Slack timestamps within 300 s |
| `optionsFrom` choices | 250 options, values 500 characters, labels 200 |
| `PluginDeliveryError` `retryAfterMs` | 1 s to 6 h |

{/* END GENERATED sdk-surface: npm run plugins:docs */}

## Not yet supported

Third-party plugins are not supported yet: every plugin is an official one,
reviewed and shipped in this repository. In particular there is no

- installing a plugin from outside the repository (a URL, a package or an
  upload);
- out-of-process or container runtime for handlers: official handlers run in
  the ProPR process;
- plugin signing or publisher verification;
- public plugin catalog or marketplace.

The handler interface was designed so that an out-of-process runtime can be
added without changing manifests: a handler receives a JSON input and reaches
everything through `ctx`, whose operations are plain asynchronous calls with
JSON arguments and results, and plugin code imports nothing from ProPR but the
SDK types. Moving a handler into another process changes how ProPR calls it,
not what the plugin declares or how it is written.
