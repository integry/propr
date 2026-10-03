# Authenticated MCP

ProPR exposes `/api/mcp` through the official TypeScript MCP SDK. It serves
the **2026-07-28 stateless protocol and 2025-11-25 Streamable HTTP** on the
same URL using `createMcpHandler({ legacy: 'stateless' })` and one catalog.
There is no session-global selected instance. MCP authentication is separate
from the existing GitHub-bearer API middleware.

## Enable through Settings

Administrators can open **Settings → Integrations → MCP Server**, confirm enablement
and choose a scope ceiling. With `MCP_ENABLED` unset, this UI-managed path derives
an HTTPS origin from `MCP_PUBLIC_ORIGIN`, `API_PUBLIC_URL` or the GitHub callback,
and derives its encryption key from `MCP_ENCRYPTION_KEY` or the existing credential,
system-task or session secret chain. It persists an instance identity. Preserve
these secrets across restarts. A changed key turns MCP off (**Reconnect required**)
until an administrator revokes all connections; clients then reconnect.
`MCP_ENABLED=false` forces MCP off; `true` selects the explicit environment-managed
setup below. See the [illustrated connection guide](docs/features/mcp.md).

## Direct instance setup

Configure an ordinary working ProPR instance, including GitHub browser OAuth,
its existing session secret, Redis, agents and repository access. Then set:

```dotenv
MCP_ENABLED=true
MCP_PUBLIC_ORIGIN=https://your-instance.example
MCP_INSTANCE_ID=your-stable-instance-identifier
MCP_ENCRYPTION_KEY=<32 random bytes, base64 encoded>
```

Generate the encryption key with `openssl rand -base64 32`. Store it in the
instance secret manager; do not paste it into chat. Preserve the instance ID
and key across restarts. Missing/invalid required configuration fails startup
with an explicit diagnostic. MCP is disabled by default and cannot be enabled
in demo mode. Normal API rate limits remain in effect; OAuth endpoints also
use the SDK's rate limits. No default key or administrator session is created.

The reverse proxy must route `/api/mcp`, `/.well-known/*`, `/authorize`,
`/token`, `/register`, `/revoke`, `/mcp/*` and the existing `/api/auth/*` routes
to this API. Preserve the MCP protocol and parameter headers. Do not cache
private responses or buffer streaming output. The canonical public origin
must match the externally visible API origin; frontend UI links continue to
use `FRONTEND_URL`. Set the existing `GH_OAUTH_CALLBACK_URL` to the instance's
GitHub callback `/api/auth/github/callback`, and register that exact URL in
the GitHub OAuth application. This GitHub callback is distinct from the
chat client's OAuth callback.

Discovery endpoints:

* `/.well-known/oauth-protected-resource/api/mcp`
* `/.well-known/oauth-authorization-server`

Use the exact `https://your-instance.example/api/mcp` as the OAuth `resource`
in authorization, code exchange and refresh. Public clients use
authorization-code + S256 PKCE. Codes last 60 seconds and are consumed
transactionally. Access tokens last 15 minutes. Refresh tokens rotate;
reuse revokes the entire 30-day grant, including newly rotated access tokens.
GitHub credentials are separately encrypted server-side and never returned
to clients. Instance membership, allowlist and repository access are checked
again for every call. The connected-app page is `/mcp/apps`. Consent shows each requested permission with optional scopes unchecked initially. Keep them unchecked for read-only access; select a requested subset when needed. Consent and refresh cannot add unrequested permissions.

## Start a one-off task

Call `create_task` with execute scope, an enabled `repository`, an `instruction`
(up to 50,000 characters), and a stable `idempotencyKey`. This creates a GitHub
issue and starts the ordinary issue implementation workflow immediately, without
a plan or goal. Repository write access is required. Optional `agentAlias` and
`model` select supported routing; otherwise instance defaults apply.

Optional automation matches `implement_plan`. `runUltrafix` (review scope) runs
the review/fix loop on the resulting pull request as soon as it opens, bounded by
`ultrafixGoal` (1-10, default 9) and `ultrafixMaxCycles` (1-10, default 3); both
bounds apply only when `runUltrafix` is true. `autoMerge` (merge scope) merges
the pull request once it is ready. Both opt-ins are applied as the shared
`ultrafix` and `auto-merge` issue labels, so removing a label stops the
automation exactly as it does for planned work.

```json
{
  "repository": "owner/repo",
  "instruction": "Fix the invoice date format",
  "runUltrafix": true,
  "ultrafixGoal": 9,
  "ultrafixMaxCycles": 3,
  "idempotencyKey": "invoice-date-fix-001"
}
```

The receipt includes `submissionId`, `submissionState`, the GitHub issue URL
when known, and `taskId` once associated. Acceptance or queueing is not task
completion. Poll `get_operation` using its suggested delay, or read
`get_task_submission` with `repository` and `submissionId`. Once a task is
associated, the ordinary task progress, logs and cancellation tools apply.

If submission fails or issue creation is uncertain, use `retry_task_submission`
with the same `repository` and `submissionId` and a new mutation
`idempotencyKey`. It reconciles or dispatches the existing submission safely.
Repeating `create_task` with its original key returns its durable receipt;
using a different key starts a separate request. MCP direct task submission
currently accepts text instructions; file uploads remain available in the UI.

## Client compatibility and verified upstream details

Verified against published npm packages on 2026-09-10:
`@modelcontextprotocol/server`, `node`, `client` 2.0.0 and
`@modelcontextprotocol/sdk` 1.30.0. v2 provides both protocol eras; its OAuth
helpers cover Resource Servers. The maintained v1 SDK supplies Authorization
Server routing and validation, with a durable ProPR provider. The lockfile
records the exact installed package versions.

Sources: [July specification](https://modelcontextprotocol.io/specification/2026-07-28),
[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

CIMD metadata uses a public HTTPS URL, bounded 32 KiB JSON, five-second
timeout, no redirects and DNS-pinned public addresses. DCR remains available.
Only public PKCE clients (`none`) are supported. New CIMD documents with
`token_endpoint_auth_methods_supported` are intersected with `none`; a legacy
`private_key_jwt` preference does not override that supported intersection. Empty, non-string or whitespace-containing method names/preferences are rejected, as are unsupported grant/response-type arrays. DCR still binds the singular method to `none`.

Use the exact callback displayed by the host; never register wildcard
callbacks. [ChatGPT's official authentication guide](https://developers.openai.com/plugins/build/auth)
currently documents callback-ID-specific
`https://chatgpt.com/connector/oauth/{callback_id}` and the stable
`https://chatgpt.com/connector_platform_oauth_redirect` for compatible issuer
identification modes. Its management page supplies the actual URL and CIMD
document. ProPR advertises issuer-response identification and includes `iss`
matching the metadata issuer (including its trailing slash) on success/denial.

[Claude's authentication reference](https://claude.com/docs/connectors/building/authentication)
documents `https://claude.ai/api/mcp/auth_callback` for hosted surfaces.
Native Claude Code uses loopback callbacks. **Verified compatibility
limitation:** ProPR enforces exact callback matching including loopback
ports, whereas the SDK/Claude CIMD flow supports RFC 8252 ephemeral-port
matching. Use DCR registering the actual callback or a fixed-port registered
client for native hosts. The [Claude Code guide](https://code.claude.com/docs/en/mcp)
documents `--callback-port` and HTTP transport setup. Hosted Claude CIMD does
not need the loopback exception. No live ChatGPT/Claude OAuth session has
been exercised by the local fixture tests.

## Connect instance registration

Connect lets public clients reach an instance through the hosted ProPR Connect
gateway at `https://mcp.propr.dev`. That hosted gateway is not yet publicly
available; this section describes the instance side, which is implemented.
Connect trust requires the environment-managed setup (`MCP_ENABLED=true`).
Direct OAuth works independently of Connect trust. Hosted access uses the
[implemented Connect contract](mcp-connect-contract.md).

1. Complete the existing operator/browser relay and `propr tunnel setup` flow.
   Keep its `GH_INSTALLATION_ID`, `PROPR_GH_RELAY_URL`, `PROPR_GH_RELAY_TOKEN`,
   `PROPR_UI_TUNNEL_ENABLED=true`, `PROPR_UI_TUNNEL_TOKEN` and `PROPR_INSTANCE_ID`.
   The last value is the **tunnel registry UUID**, not the stable MCP identity.
   An operator configuring a tunnel outside that flow can set
   `MCP_CONNECT_TUNNEL_ID` to the active registry `tunnel_id` shown by Connect.
   This is not Cloudflare's separate `cf_tunnel_id`.
2. Configure the direct setup variables above in the same instance environment.
   For a new instance, generate `MCP_INSTANCE_ID` once with
   `node -e 'console.log(require("node:crypto").randomUUID())'`.
   Preserve it separately from the tunnel ID. Keep `MCP_ENCRYPTION_KEY` in the
   operator secret manager and point `DB_FILENAME` at the running API's durable
   SQLite database. Use the actual API public origin for `MCP_PUBLIC_ORIGIN`.
3. Explicitly opt in:

   ```dotenv
   MCP_CONNECT_TRUST=true
   MCP_CONNECT_ISSUER=https://mcp.propr.dev
   ```

   Issuer defaults to that canonical origin when trust is enabled. JWKS,
   public resource, validation and handoff URLs are derived from it. The old
   `MCP_CONNECT_INTROSPECTION_*`, `MCP_CONNECT_INSTALLATION_ID` and configurable
   JWKS URL belong to the incompatible proposal and are no longer used.
4. After the ordinary instance database migrations, run from the core checkout
   with the **same environment and database** as the API:

   ```sh
   DOTENV_CONFIG_PATH=/path/to/instance/.env npm run mcp:connect:register
   ```

   In a built installation the equivalent entry point is
   `DOTENV_CONFIG_PATH=/path/to/instance/.env node dist/scripts/mcp-connect-register.js`.
   This operator command generates a P-256 key once, persists it encrypted in
   SQLite before making a network request, signs registration, and stores the
   verified registration receipt. It prints only the public instance/resource
   identifiers. It never asks an operator to construct or paste JWTs. Retry the
   command after a network failure; it reuses the same identity. A changed
   `MCP_INSTANCE_ID` cannot overwrite an existing identity.
5. Restart the API with the matching configuration. Add each intended user
   through the existing Access settings and configure the allowed repositories.
   Connect membership alone does not create local access. Once the hosted
   gateway is available, connect a public client to `https://mcp.propr.dev/mcp`, then explicitly select its installation,
   requested permissions and repositories in the Connect browser consent flow.
   GitHub credential handoff happens server-to-server on the first request.

Secrets belong only in operator/browser setup, never chat inputs or public
OAuth client traffic. Keep SQLite and its encryption key together across
upgrades and backups. Losing either requires explicit operator recovery and
fresh consent; do not reset a key automatically. Reprovisioning a tunnel or
changing the registered key/instance invalidates old grants permanently. Update
the tunnel configuration, rerun registration and obtain fresh consent. Rotating
a connector secret for the same tunnel leaves the MCP identity unchanged.

The existing managed tunnel routes `/api/*`, which covers delegated MCP. It does
not automatically expose direct `/.well-known`, `/authorize`, `/mcp/consent`, etc.
To offer **direct OAuth through a domain**, use the complete reverse-proxy routes
listed in direct setup; public Connect clients use Connect's discovery/consent.

## Tools and ordinary workflows

The [capability matrix](mcp-coverage.md) maps supported operations to tools.
`tools/list` is authoritative for the current user's scopes and instance
permissions. Scope families are `read`, `plan`, `publish`, `execute`, `review`,
`merge`, `deploy`, `manage`; scopes never grant extra GitHub or instance access.
Repository restrictions are explicit lists. Administrative tools additionally
require the existing `instance.manage_settings`, `instance.manage_agents`,
`instance.manage_runtime` or `instance.manage_members` permission. Goal and plan ownership is preserved.
Ordinary repository task history follows the existing shared repository model;
native goal tasks remain private and can only be mutated through goal controls.

Start with `get_connection`, `list_repositories`, `list_models` and
`resolve_reference`. Resolve ambiguity before mutating. `create_plan` creates
a draft; `publish_plan` creates GitHub issues with the non-executing
`propr-planned` label. `implement_plan` requires selected issue numbers and
models and uses the existing implementation handler. Auto-merge defaults off
and additionally requires merge scope. `create_goal` explicitly starts work.

`create_goal` accepts the same creation contract as the goal API and web UI;
`get_goal_capabilities` returns it as `creation` beside the supported agents
and models. `launchStrategy` is `direct` or `orchestrate`. `maxParallelTasks`
is an integer from 1 to 32 and defaults to 1 over MCP (the API and UI leave it
unset when omitted). `checkpointIntervalMinutes` is 5–120 (default 15) and is
rejected for orchestrated goals. `ultrafix: true` asks the goal agent to run
Ultrafix before delivery; omitted or `false` keeps it disabled. Ultrafix never
merges, never expands repository access and does not change the final
draft-PR delivery; `create_goal` still needs `execute` scope and repository
access, and merging still requires `merge_pull_request` with merge scope. An
unsupported agent/model, an invalid strategy/cadence combination or an
inaccessible repository is rejected before any work starts.
`/merge` means updating a PR branch; `merge_pull_request` separately requires
the exact head and satisfied checks/reviews/branch protection.

Every mutation needs an 8–128 character `idempotencyKey`. Keep it unchanged
across retries of the same action, and repeat the same arguments exactly.
Omitting an optional argument and supplying it are different payloads. Reusing a key with different arguments
returns `IDEMPOTENCY_CONFLICT`. Receipts survive restarts; `get_operation`
returns accepted/completed/failed/running/unknown plus available target state.
An interrupted or uncertain external operation is not blindly replayed.
Inspect the target before using a new key. Publication marks a draft busy
before issuing GitHub requests; partial publication remains inspectable in
`plan_issues` and the draft, with marker comments identifying the operation.
A publication cut off by a server restart leaves its draft claimed as `active`.
The publishing attempt renews that claim before each issue and aborts an issue
request that outlives the renewal by one minute, so `publish_plan` with
`resume: true` and a new key takes the claim over once it has gone unrenewed
for two minutes, adopting marked issues before creating missing ones. An
earlier resume fails with `PRECONDITION_FAILED` and `details.claimLapsesAt`.
Automatic recovery of uncertain external effects is not implemented.

## Errors

Every tool failure uses one structured `error` envelope. `code` is the stable,
machine-readable reason; `message` is a safe operator explanation; `stage`
identifies where the failure occurred; `retryable` says whether repeating the
same request can reasonably succeed without changing its inputs; and `status`
is the corresponding HTTP-style status. `details` contains bounded diagnostic
state such as a failed merge precondition or current pull-request snapshot.
`cause`, when present, is the sanitized lower-level `{ code, message }` that
caused the higher-level workflow error.

`stage` is one of `validation`, `authorization`, `precondition`, `github`,
`transport`, `database`, `queue`, `workflow`, `internal`, or `null` when no
more precise boundary is known. A retryable error is not an instruction to
retry immediately: respect `retryAfterSeconds`, re-read any mutable target and
reuse the original `idempotencyKey` only for the exact same action and inputs.
A non-retryable error usually needs changed input, authorization, configuration
or target state.

For mutations, a connection or server failure can happen after an external
side effect. Such a receipt is `unknown` with `error.code: "OUTCOME_UNKNOWN"`
and a sanitized `cause` describing the original failure. It is deliberately
not retryable: inspect the receipt's artifacts and the target in GitHub or
ProPR before deciding whether a new action is safe. A failure raised while a
mutation is still reading (for example the pull request or merge-state read
before a merge) issued no write, so it is reported with its ordinary code and
`retryable` flag instead.

Stable codes introduced by the observable operator surface are:

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | Arguments failed schema or semantic validation. |
| `GITHUB_*`: `GITHUB_AUTH_FAILED`, `GITHUB_FORBIDDEN`, `GITHUB_NOT_FOUND`, `GITHUB_RATE_LIMITED`, `GITHUB_REJECTED`, `GITHUB_UNAVAILABLE`, `GITHUB_RESPONSE_INVALID` | GitHub rejected, denied, could not find, throttled or could not serve the request, or returned a response the tool could not act on. |
| `UPSTREAM_*`: `UPSTREAM_TIMEOUT`, `UPSTREAM_UNREACHABLE` | A non-GitHub upstream timed out or could not be reached. |
| `DATABASE_BUSY` | SQLite is temporarily busy; retry after the indicated delay. |
| `PLAN_INVALID` | A plan is incomplete or malformed and cannot be published. |
| `PUBLISH_FAILED` | Publication failed before any issue was created; the plan claim was released. `details.currentRevision` is the revision to pass when retrying. |
| `PUBLISH_PARTIAL` | Some publication effect may exist; inspect the saved publication state and resume explicitly. |
| `PULL_REQUEST_ALREADY_MERGED`, `PULL_REQUEST_CLOSED`, `PULL_REQUEST_DRAFT` | The pull-request lifecycle does not permit the requested action. |
| `CHECKS_FAILING`, `CHECKS_PENDING`, `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, `BRANCH_BEHIND_BASE`, `MERGE_CONFLICT`, `BRANCH_PROTECTION_BLOCKED`, `MERGE_STATE_UNKNOWN`, `MERGE_REJECTED` | A specific guarded-merge precondition or GitHub merge decision blocked the merge. |
| `COMMAND_NOT_PICKED_UP` | Event intake did not associate the posted command with a worker before the bounded deadline. |
| `ULTRAFIX_CYCLE_FAILED` | A tracked ultrafix cycle ended in failure. |
| `REFINEMENT_OUTPUT_INVALID` | Planner refinement ended without a valid replacement plan. |
| `DOCS_UNAVAILABLE`, `DOC_NOT_FOUND` | Bundled documentation is unavailable or the stable path does not exist. |
| `PREVIEW_NOT_FOUND`, `PREVIEW_NOT_RENDERABLE`, `PREVIEW_TOO_LARGE` | Preview evidence is absent, is metadata-only/invalid, or cannot fit the MCP response bound. |
| `SETTING_ENVIRONMENT_MANAGED` | A setting is controlled by deployment environment and is read-only through MCP. |
| `CONFIRMATION_REQUIRED` | The requested configuration change needs its explicit safety confirmation flag. |

## Did it actually happen? Following a receipt

Every mutation returns an `operationId`. Follow it with `get_operation` until
its `lifecycle.state` is terminal. Lifecycle states are `accepted` (durably
recorded), `running` (backend work observed), `completed`, `failed`,
`cancelled`, and `unknown` (the outcome cannot yet be proved). Tool-specific
top-level states such as `queued` or `posted` add context but do not mean the
work completed.

The lifecycle includes `acceptedAt`, `startedAt` and `finishedAt` timestamps,
plus stable `artifacts` such as submission, task, comment and pull-request
identities. Its `progress` is tool-specific. For `run_ultrafix`, progress names
the goal, maximum cycles, current `cycle`, phase, last score, per-cycle review
and fix task IDs, and terminal outcome (`goal_reached`, `cycles_exhausted`,
`stopped` or `failed`). The lifecycle summary distinguishes reaching the goal
from merely exhausting the allowed cycles.

If the handle is no longer in the conversation, use `list_operations`. It is a
bounded, newest-first receipt index and does not itself refresh backend
trackers. For example, “what did I start in the last hour?” is:

```json
{ "sinceMinutes": 60, "limit": 20 }
```

To find one kind of work, add an exact tool filter:

```json
{ "sinceMinutes": 60, "tool": "run_ultrafix", "limit": 20 }
```

Each result includes `refreshWith: "get_operation"`; call that tool with the
selected `operationId` when current backend progress is needed.

Poll at the returned interval (normally three seconds); never unboundedly
poll in one request. `cancel_operation`, `cancel_goal` and `cancel_task`
distinguish a cancellation request from a stopped backend. A completed
external effect cannot be cancelled. PR command receipts identify the
GitHub comment while normal configured event intake starts the work.

Uploads are limited to 192 KiB per call and allowed file types. Plan uploads
use existing attachment processing; goal uploads are delivered as goal input
and also require execute scope. Read owned upload artifacts in 48 KiB chunks.
`get_attachment` also reads existing browser-uploaded plan/goal files (up to
the native 10 MiB limit) in 48 KiB chunks. Owned MCP uploads have authenticated
browser download links under `/mcp/artifacts/{id}`. Task changes default to a
file summary; request `detail: "diff"` with an exact path for 16 KiB chunks.
No tool downloads arbitrary remote URLs. Secret entry and browser push/login
flows stay in the browser. Tool responses are bounded at 256 KiB and redact
credential fields and recognizable token strings.

`list_plans` takes an optional `status` filter alongside `offset`/`limit`:
`active` (every plan that has not merged or failed), any persisted plan status
(`draft`, `generating`, `refining`, `review`, `approved`, `executed`,
`executing`, `pr_created`, `merged`, `failed`) or `all`, the default. The filter
runs in the query, so `offset` and `limit` page the filtered set.

List tools return bounded summaries rather than requiring one read per item.
Task and goal entries include a concise title/summary, agent and model, linked
pull request state, lifecycle timestamps, elapsed milliseconds, and a failure
reason when applicable. Plan entries aggregate issue progress, agent/model
assignments, and pull requests; TODO entries include their category and linked
plan. Full objectives, prompts, and TODO bodies remain available from the
corresponding `get_*` tool without inflating large list pages.

`get_agent_activity` reads exactly one authorized `goalId` or `taskId`. It
defaults to the 20 most recent entries and returns newest-first, timestamped
pages with `nextOffset` for older narration. Each entry is whitespace-normalized
and capped at 500 characters. The feed includes assistant progress commentary
and a separate current-focus value when available; raw provider reasoning, raw
protocol envelopes, tool inputs, and tool results are excluded.
`includeReasoningSummaries: true` opts in to Codex app-server reasoning summaries.

## Operating an instance from a chat client

This is the flow the operator surface is built for: find out what is happening,
drill into one piece of work, act on its pull request, and check afterwards what
the connected app actually did. Every tool and argument below is the shipped
one; `tools/list` remains authoritative for the current grant.

**1. What is happening right now.** `get_current_activity` covers every
repository in the grant at once — omit `repository` unless you want one:

```json
{ "limit": 10, "includeRoutine": false }
```

It answers with `asOf`, the `repositories` it actually read, and five sections:
`runningTasks`, `activeGoals`, `plansInProgress`, `queued` and `blockers`. Each
section carries `count`, `items` and `truncated`. Blockers are the work waiting
on a human: failed tasks, a goal paused with no result, and blocking Inbox
cards. Routine notification noise is filtered out; `includeRoutine: true` keeps
it. A repository the credential can no longer read is skipped, and
`repositoriesTruncated` reports that the fan-out hit its 20-repository bound.

When the question is specifically about implementation work and the pull
requests it produced, `get_work_overview` is the shorter starting point. It
joins each task to current head, review, checks, mergeability, newest ProPR
review and ultrafix state with one bounded GraphQL request per repository:

```json
{ "state": "active", "limit": 20, "includeChecks": true }
```

Use `state: "recent"` with `sinceMinutes`, or `state: "all"`, when completed
work belongs in the answer. `githubLookups` reports the requested/completed
enrichment count and whether the bounded lookup was truncated.

For what already finished, `get_recent_activity` merges one newest-first
timeline — terminal tasks, opened and merged pull requests, finished goals,
published plans, reviews, ultrafix loops and blocking notifications:

```json
{ "sinceMinutes": 120, "limit": 30 }
```

Use `since`/`until` instead of `sinceMinutes` for an exact window; the maximum
window is seven days. Follow `nextOffset` for older entries. `scanTruncated`
means the scan budget ran out, not that nothing else happened.

**2. Drill into the goal or task behind an item.** Both listings now take an
optional `repository` and a `state` filter (`active`, `completed`, `failed`,
`all`), so `list_goals` with `{ "state": "active" }` is a grant-wide question.
One read then gives the depth:

```json
{ "repository": "acme/web", "goalId": "0d6e1f7c-1a2b-4c3d-8e9f-0a1b2c3d4e5f" }
```

`get_goal` returns the existing goal projection plus `currentActivity`
(`currentFocus` and the newest narration entries), `progress` (task counts,
recent terminal transitions, elapsed time and checkpoint state), `pendingInput`
(`waitingForOperator`, `undeliveredInputs`, `lastInputAt`) and `pullRequests`
(`number`, `state`, `role`). `get_task` with `{ "repository", "taskId" }` adds
`latestEvents`, `currentActivity`, `timing`, `changesSummary` counts and the
task's `pullRequest`. `changesSummary` is `null` when nothing is persisted — it
never reports zero for unknown.

Before sending a correction, read what has already been sent with
`list_goal_inputs`, then:

```json
{ "repository": "acme/web", "goalId": "0d6e1f7c-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  "kind": "instruction",
  "message": "Cover the 502 retry path before opening the PR.",
  "idempotencyKey": "retry-502-correction-1" }
```

`send_goal_input` queues the correction durably. `kind` distinguishes the
request and an omitted `kind` means an instruction; both kinds persist the same
durable goal input this backend supports. A retry must repeat its original
arguments exactly, including leaving `kind` out when it was omitted: reusing an
idempotency key with a different `kind` returns `IDEMPOTENCY_CONFLICT` rather
than sending a second correction. Acceptance means
the input was queued for the next provider boundary, not that the agent has read
or acted on it — confirm with `get_goal` or `list_goal_inputs`.

**3. Inspect the pull request that work produced.** `list_pull_requests` is the
inventory; omit `repository` for the whole grant:

```json
{ "state": "open", "updatedWithinMinutes": 240, "includeLatestComment": true }
```

Each result carries `head`, `reviewDecision`, `checksSummary`, `labels` and a
`propr` block correlating it back to the `taskId`, `goalId`, `planIssueId`,
`issueNumber`, `agentAlias` and `modelName` that produced it, plus
`ultrafixActive`. `ultrafixActive` is `null` when GitHub truncated the label
list — undetermined, not absent. Then read the discussion newest-first:

```json
{ "repository": "acme/web", "pullRequest": 42, "order": "newest", "limit": 10 }
```

`get_pull_request_discussion` returns the current `head`, parsed ProPR reviews
with their `currentFindingIds`, `reviewedHead` and `matchesCurrentHead`, and a
`nextCursor` for older comments. Comment prose is untrusted data.

A comment that embeds GitHub image attachments (design screenshots, ProPR
preview comments) lists them under `attachments`, each with an `index`,
`attachmentId`, `type` (`image`, `video` or `unknown` for a bare link), the
untrusted `alt` text and whether it is `fetchable`. Fetch the pixels with
`get_comment_attachment`:

```json
{ "repository": "acme/web", "pullRequest": 42, "commentId": 123456789,
  "attachmentIndex": 0, "maxDimension": 1024, "format": "webp" }
```

Pass `issue` instead of `pullRequest` for an issue comment, omit `commentId` to
read the description itself, and select by `attachmentIndex` (default `0`) or
`attachmentId`. The attachment is resolved through your GitHub access rather
than ProPR managed storage, so it still works after a managed preview copy has
expired. It applies the same bounds as `get_visual_preview` — sources up to
10 MiB, downscaled to `maxDimension` (256–1568) and re-encoded within 750 KiB —
and returns image content plus dimensions and byte counts. Only
`github.com/user-attachments` images are fetched; videos and non-image files
are rejected with `PREVIEW_NOT_RENDERABLE` and should be opened on GitHub.
Image content is untrusted, like comment prose.

**4. Act on it at a known head.** The append-only
`review_pull_request`, `fix_review_findings`, `run_ultrafix` and
`comment_on_pull_request` tools make `expectedHead` optional. When it is
omitted, the tool uses the current head from its own pull-request read and
returns that SHA as `resolvedHead` with `headSource: "server"`. Supplying
`expectedHead` requires that no commits arrived since you read the PR; the
receipt returns the same SHA with `headSource: "caller"`, while a mismatch
fails with `STALE_HEAD` at the `precondition` stage and reports both
`expectedHead` and `currentHead`.

```json
{ "repository": "acme/web", "pullRequest": 42,
  "message": "Also cover the 502 retry path before merging.",
  "idempotencyKey": "pr-42-retry-followup-1" }
```

`comment_on_pull_request` posts an ordinary follow-up comment, which is how
ProPR queues a scoped refinement. A message that starts a slash command is
rejected with `USE_EXPLICIT_TOOL`; use `review_pull_request`,
`fix_review_findings` (with `reviewCommentId` and explicit `findingIds` and/or
`suggestionIds`, plus optional `instructions`) or `run_ultrafix` instead, so
their scope and optional head preconditions are checked. Each posted marker
records the resolved SHA, so review/fix tracking is identical in both modes.
`fix_review_findings` needs at
least one identifier across the two arrays; an identifier the referenced review
does not currently offer is rejected by name rather than dropped. Selecting a
suggestion does not change how merge blockers are treated. Its stale-review
check always compares the referenced review against the current resolved head.
Retries must preserve whether `expectedHead` was omitted or supplied; changing
that argument while reusing an idempotency key returns `IDEMPOTENCY_CONFLICT`.

The state-changing `merge_pull_request`, `update_pull_request_branch`,
`stop_ultrafix`, `set_pull_request_model` and `revert_pull_request_commit`
tools still require `expectedHead`. The pin prevents them from acting on unseen
code; for `stop_ultrafix`, a moved head may contain a human fix the loop should
still review.

`set_pull_request_model` routes the PR to exactly one enabled model by
converging the managed `llm-*` labels the repository already defines:

```json
{ "repository": "acme/web", "pullRequest": 42,
  "expectedHead": "6f1c0a1d1e2f3a4b5c6d7e8f90a1b2c3d4e5f607",
  "model": "claude-opus-5",
  "idempotencyKey": "pr-42-route-opus-1" }
```

It never creates a label: an undefined one fails with `MODEL_LABEL_MISSING`, and
a label list too long to read completely fails with
`MODEL_LABEL_LOOKUP_INCOMPLETE` rather than claiming the label is absent.
Concurrent routings of one pull request are serialized; a routing that loses
that serialization to another before writing fails with
`MODEL_LABEL_LEASE_LOST` instead of adding a second label. Read the pull
request labels again before retrying.

`stop_ultrafix` clears the ultrafix circuit breaker by removing the `ultrafix`
label, so the loop starts no further cycle. It is listed under execute scope,
additionally requires review scope, and requires
`expectedHead` plus `idempotencyKey`. Its receipt reports `wasActive` and
`circuitBreaker: "cleared"` and says plainly that a cycle already running may
still finish — inspect the pull request to confirm.

**5. Follow a one-off task.** After `create_task`, keep both the returned
`operationId` and `submissionId`. The submission view explains the handoff from
GitHub issue creation to worker execution:

```json
{ "repository": "acme/web", "submissionId": "9ab36d7e-11c5-4f83-8dd4-986f9a2237c1" }
```

`get_task_submission.progress.stage` advances through `submitted`,
`issue_created`, `queued`, `running` and a terminal `completed`, `failed` or
`cancelled` stage. Its progress includes the issue, associated task, pull
request and a concise next action. Follow the mutation itself with
`get_operation`; only its terminal lifecycle proves the launch receipt's
backend outcome.

**6. Look at the result.** Preview evidence is discovered from one exact task
or pull request:

```json
{ "repository": "acme/web", "pullRequest": 42 }
```

Call `list_visual_previews`, then pass an image result's `previewId` to
`get_visual_preview` with an optional `maxDimension` and `format`. The latter
returns bounded image content plus dimensions and byte counts. Video previews
are metadata-only in MCP and should be opened on the linked GitHub pull request.
An empty list with `previewsEnabled: false` means preview publication is not
enabled for that repository, not that an image fetch failed. When the managed
original of a published preview has expired, fetch the image embedded in the
preview comment with `get_comment_attachment` instead.

**7. Ask ProPR about itself.** Use `search_docs` for product behavior and
operator procedures, then pass the stable result `path` and optional `section`
to `get_doc`. Use `list_docs` to browse pages; this guide is `mcp/guide`.

```json
{ "query": "ultrafix progress", "limit": 5 }
```

For configuration reachability, `find_setting` answers where a setting lives,
whether MCP can read or change it, required permissions/scopes, and whether a
restart is needed:

```json
{ "query": "bot whitelist" }
```

**8. Read the MCP log.** Every one of the calls above left exactly one row in
the durable MCP access log, including the denials. An administrator with the
`instance.manage_settings` instance permission reads them:

```sh
# Authenticated as an administrator, with the same session the web UI uses.
curl -s "$API/api/admin/mcp/logs?clientId=$CLIENT&limit=50"
curl -s "$API/api/admin/mcp/logs?outcome=denied&since=2026-09-24T00:00:00Z"
curl -s "$API/api/admin/mcp/logs/stats"
```

Rows are newest-first and filterable by `ownerId`, `clientId`, `repository`,
`name`, `kind` (`tool`, `resource`, `prompt`, `auth`), `outcome` (`success`,
`denied`, `error`), `since` and `until`, with `page`/`limit` up to 200. Each row
carries the surface and name, the grant and client identity, the repository,
scope, `readOnly`, status, outcome, error code, duration, result size and the
durable `operationId` of a mutation. It carries no tool arguments, message
bodies or result payloads. `/logs/stats` summarizes a window of at most the
30-day retention period into outcome counts, top tools, clients, repositories
and error codes, and p50/p95 durations. The connected-apps page at `/mcp/apps`
shows the same activity per app as a last-used time and a 24-hour request count.

## Resources, prompts, text and voice

Resource URIs use `propr://instances/{instance_id}/`: `connection`,
`repositories`, `models`, `notifications`, `notifications/{id}`, `activity`,
`activity/recent`, `plans/{id}`,
`goals/{id}`, `tasks/{id}`, `changes/{task_id}`, `repositories/{owner}/{repo}`,
`repositories/{owner}/{repo}/pulls`,
`repositories/{owner}/{repo}/pulls/{number}`, `submissions/{id}`,
`repositories/{owner}/{repo}/previews/{previewId}`, `docs/{path}`,
`artifacts/{id}` and `{plans|goals}/{parent_id}/attachments/{id}`. `activity` and `activity/recent`
read `get_current_activity` and `get_recent_activity` with their defaults.
Reads invoke the same tool guards. Links never confer access. Tools provide
the same essential data without relying on a host's resource UI.

Prompts are `plan_change`, `implement_plan`, `start_goal`, `check_progress`,
`review_and_improve_pr`, `diagnose_failure`, `prepare_handoff` and
`operator_briefing`, which walks the read-only digest → drill-in flow above.
Retrieval only
returns instructions, never mutates product state. Natural-language content
and repository data are not authorization.

Examples for text or a host's supported voice interface:

* “Find my reliability plan in acme/web-app and tell me what is still running.”
* “Draft a plan to improve retry handling. Let me review it before publishing.”
* “Publish that exact revision, then implement issues 31 and 32 with this model.”
* “Start a direct goal to investigate flaky tests; pause it after the first findings.”
* “Review PR 44, fix the findings, then show me the current checks before merging.”

Hosts differ in voice/MCP availability. This server does not claim that every
host or voice mode supports MCP. Durable IDs and concise summaries make
continuation possible without process/session conversation memory.

## Verification, rollout and rollback

Run `npm run test:mcp` for local OAuth, both SDK eras, signed delegation,
operation, activity digest, goal/task depth, pull request surface and access log
tests, including the end-to-end operator-surface regression in
`packages/api/test/mcpOperatorSurface.test.ts`, which drives one session from
`get_current_activity` through the goal, task and pull request behind it to the
access rows it leaves. The combined observable-surface regression in
`packages/api/test/mcpObservableSurface.test.ts` follows a one-off task and
ultrafix receipt through completion, exercises overview, merge/publication
failures, docs, settings and previews, and checks documented tool names against
the admin catalog. `npm run test:mcp:browser` additionally needs Playwright and
Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`). Set
`MCP_CAPTURE_PREVIEWS=true` only when capturing changed UI evidence.

Recorded local results (2026-09-10):

| Check | Result |
| --- | --- |
| `npm run test:mcp` | 11 tests passed, zero failures/skips |
| `MCP_CAPTURE_PREVIEWS=true npm run test:mcp:browser` | 1 passed; Chromium desktop and 390px mobile consent/revocation |
| First targeted backend regression batch | 9 files, 85 tests passed |
| Shared-handler regression batch | 7 files, 61 tests passed (some overlap with the first batch) |
| `npm run typecheck`, `npm run typecheck -w @propr/api`, `npm run build` | Passed |
| ESLint on MCP, its tests and affected API/shared handlers | Zero errors; 11 complexity/parameter-count/nesting warnings |

The first regression batch covered authentication/token refresh, redirects,
Connect, goals, notifications, rate limits, instance/route authorization and
planner background lifecycle. The second covered token refresh, goals, task
cancellation, planner operation guards, implementation triggers and revert
guards. Run selected files through `node scripts/run-test-suite.mjs <files>`
for isolated databases and the repository's standard test environment.

The local integration fixtures exercise both official SDK clients and the
real SQLite migrations, draft creation/update/publication, implementation
label orchestration and queueing, followup, review/fix/ultrafix and guarded
merge, goal lifecycle, TODOs, notifications, settings and attachment upload/read.
GitHub, queue transport and agent capability boundaries are fixtures;
task-history transitions at the worker boundary are simulated. Concurrent
implementation requests are asserted to enqueue once. Existing backend
regression suites also exercise the shared handlers and authorization.
This is not a verified live end-to-end agent implementation/review/merge, live
GitHub OAuth, Connect tunnel, or hosted-client voice session. See the checklist
for remaining cross-repository and operator acceptance work.

Back up SQLite and the encryption key before enabling. The migrations add
`mcp_records`, `mcp_operations`, `mcp_access_log`, and a revision
counter/trigger on task drafts. Access rows are pruned to a 30-day window and a
200,000-row ceiling by an opportunistic sweep, so the table stays bounded
without a background timer; anything older is answered from backups.
Disabling `MCP_ENABLED` and restarting removes MCP/OAuth routes while preserving
grants for a later rollback. Revoke grants first when access must not resume.
Do not delete receipt rows while clients may retry: they are deduplication
evidence. Full migration rollback removes MCP storage and the trigger; export
needed audit/receipt evidence before that destructive operator action.
Issue execution claims live in `mcp_records` and prevent a new idempotency key
from launching an already requested issue again. Following an uncertain
partial publication/implementation, an operator must reconcile the receipt,
GitHub markers, issue labels and queue state before explicitly recovering it.
No deployment, auto-merge activation or production migration was performed.

