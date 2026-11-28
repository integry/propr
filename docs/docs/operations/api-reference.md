---
sidebar_label: "API reference"
title: "ProPR API reference and authentication"
description: "Explore ProPR HTTP API endpoints, authentication, the OpenAPI specification, and curl examples for scripts and integrations."
---

# API reference

The web UI, the desktop app and the CLI all talk to one HTTP API, served by the dashboard API process under `/api`. Use it for monitoring, custom dashboards and CI scripts.

- [Open the interactive reference](pathname:///openapi/index.html) (full screen)
- [Download the OpenAPI 3.1 spec](pathname:///openapi/propr-api.yaml) (`propr-api.yaml`), for code generators, Postman or Insomnia

The spec is generated from the API route registry, so it lists every route the server registers. The interactive reference ships with the docs, so it also works in the offline copy `propr docs` serves. The [`@propr/client`](#typescript-client) types come from the same schemas.

<iframe
  src="/openapi/index.html"
  title="ProPR dashboard API reference"
  width="100%"
  height="900"
  loading="lazy"
  style={{border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: '8px'}}
></iframe>

## Authentication

Unless an operation says otherwise, send one of these:

| Credential | How to send it | Notes |
| --- | --- | --- |
| Browser session | The session cookie set by `GET /api/auth/github` | Used by the web UI. |
| GitHub token | `Authorization: Bearer <token>` | Accepted while `ENABLE_BEARER_AUTH` is not `false`, which is the default. The token is checked against GitHub and cached for five minutes. Used by the CLI. |
| Instance token | `Authorization: Bearer propr_it_…` | Issued by [desktop pairing](./desktop-pairing.md). |
| MCP access token | `Authorization: Bearer …` on `/api/mcp` only | Issued by the [MCP OAuth flow](../features/mcp.md). Each tool checks its scope. |

The GitHub account behind the credential must be allowed on the instance (see [GitHub authentication](./github-auth.md)). Operations marked `x-propr-permission` also need that instance permission, for example `instance.manage_settings`. Admins hold every permission. A demo instance rejects every request that changes data.

Unauthenticated routes are listed with an empty `security` requirement. They cover health, compatibility, desktop discovery, the pairing bootstrap, the login redirects and the MCP OAuth endpoints (`/authorize`, `/token`, `/register`, `/revoke`).

## Errors

New routes return the common error envelope for every `4xx` and `5xx` response:

```json
{
  "code": "TASK_NOT_FOUND",
  "message": "No task with this id exists.",
  "hint": "List tasks with GET /api/tasks to find the id."
}
```

Most existing routes still return an older ad-hoc shape, `{ "error": "…" }`, sometimes with `code` and `message`. These operations are marked `x-legacy-error: true` and reference the `LegacyError` schema, so clients can tell which shape to expect. Their behaviour does not change until each route is migrated.

## Coverage

Routes that have no annotation yet are still in the spec, marked `x-undocumented: true`. `info.x-route-coverage` in the spec counts documented and undocumented routes. Undocumented routes are usable, but their request and response bodies are not described yet and may change between releases.

To document a route, contributors add an entry to `packages/api/openapi/routeDocs*.ts`, describe its bodies as zod schemas in `packages/api/openapi/schemas*.ts`, and run `npm run gen:openapi`. Pull request checks run `npm run gen:openapi:check`. It fails when the committed spec or the generated client types are stale, or when the spec is not valid OpenAPI 3.1.

## TypeScript client

[`@propr/client`](https://github.com/integry/propr/tree/main/packages/client#readme) is the REST and Socket.IO client the CLI and the desktop app use. It has typed methods for listing tasks, reading a task's events and creating task submissions, plus an authenticated `request()` for any other route. Its request and response types (`ProprApi.*`) are generated from this spec. `npm run check:client-contract` fails when the methods and the spec disagree.

```ts
import { ProprClient } from '@propr/client';

const client = new ProprClient({
  baseUrl: 'https://propr.example.com',
  authentication: { type: 'bearer', getAccessToken: () => process.env.GITHUB_TOKEN },
});

const { tasks } = await client.listTasks({ status: 'attention', limit: 20 });
```

## Pull request readiness

`GET /api/pull-requests/{number}/readiness?repository=owner/repo` answers "is this pull request ready to integrate, and if not, why" with one verdict and a coded reason per gate. The MCP tool `get_pull_request_readiness` and `propr pr readiness <number> [--json]` return the same result. The read has no side effects. It never writes to GitHub or Redis, never updates the branch or merges, and never arms or withdraws auto-merge. It runs as the ProPR GitHub App, so it sees the same signals as auto-merge: check runs, legacy commit statuses, the repository's non-blocking checks, mergeability, reviews, the latest ProPR AI review, Ultrafix state and active ProPR work. You need read access to the repository on GitHub, the check `get_pull_request_readiness` applies too; the App identity is used only after that check passes. Errors use the error envelope: `INVALID_INPUT` (400), `REPOSITORY_NOT_ACCESSIBLE` (404, you cannot read the repository on GitHub; nothing is evaluated), `PULL_REQUEST_NOT_FOUND` (404) and `GITHUB_UNAVAILABLE` (502, safe to retry).

The verdict is `merged` or `closed` when the PR state says so. Otherwise it is `blocked` if any gate has status `fail`, else `waiting` if any gate is `waiting`, else `unknown` if any gate is `unknown`, else `ready`. `blockingReasons` lists the reason codes of failed gates, and `waitingReasons` lists those of waiting or unknown gates. Each entry in `gates` has a `gate`, a `status` (`pass`, `waiting`, `fail`, `unknown` or `not_applicable`), a stable `reason` and an optional `detail`.

| Gate | Reason codes, by status |
| --- | --- |
| `open` | pass: `pull_request_open`. fail: `pull_request_merged`, `pull_request_closed` |
| `not_draft` | pass: `not_draft`. fail: `draft` |
| `checks` | pass: `checks_passing`, or `no_ci` once the head has had no CI for two minutes after ProPR first saw it. waiting: `waiting_for_ci` before that, and `checks_not_passing` while blocking checks still run. fail: `checks_not_passing` when a blocking check failed. unknown: `unavailable` |
| `mergeable` | pass: `mergeable`. fail: `merge_conflict`, `branch_behind_base`. `branch_protection_blocked` waits while checks or a required review are pending, and fails otherwise. unknown: `merge_state_unknown` |
| `human_review` | pass: `approved`, `no_changes_requested`. fail: `changes_requested`. waiting: `review_required`. unknown: `review_state_unavailable` |
| `ai_review` | pass: `goal_reached`. fail: `score_below_goal`. waiting: `review_stale_head`. `no_review` is not applicable, or waiting with the `ultrafix` label. unknown: `review_scores_unavailable` |
| `ultrafix` | pass: `ultrafix_succeeded`. fail: `ultrafix_failed`. waiting: `ultrafix_active`, `ultrafix_pending`. unknown: `ultrafix_state_unavailable`. not applicable: `ultrafix_not_requested` |
| `active_work` | pass: `no_active_work`. waiting: `propr_work_active`. unknown: `active_work_unavailable` |
| `policy` | The auto-merge policy reason. pass: `armed`. fail: `skipped_protected_path`, `skipped_disabled`, `skipped_empty_diff`. unknown: `skipped_policy_invalid`, `skipped_diff_unavailable`, `auto_merge_request_unavailable`, `pull_request_changed`. not applicable: `auto_merge_not_requested` |

`ai_review` never holds a PR that ProPR is not reviewing. Its goal is the Ultrafix cycle's goal, or the instance `ultrafix_rating_goal` for a plain `/review`. The policy is read, and can change the verdict, only when the PR or its linked issue carries the `auto-merge` label. `autoMerge` reports eligibility (`eligible`, `ineligible` or `transient`), its reason (`pr_label`, `linked_issue_label`, `no_auto_merge_label`, `epic_without_label`, `ultrafix_active`, `ultrafix_failed`, `ultrafix_not_succeeded`, `ultrafix_state_unavailable`, `linked_issue_unavailable`) and the policy reason.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$PROPR_URL/api/pull-requests/42/readiness?repository=acme/app"
```

## Idempotency and retries

Three key contracts exist, and they differ:

| Operation | Key | Format | Required |
| --- | --- | --- | --- |
| `POST /api/task-submissions` | `Idempotency-Key` header | Any string up to 255 characters | Yes; missing or longer is `400` |
| `POST /api/goals` | `Idempotency-Key` header | Any string up to 255 characters | Yes; missing or longer is `400` |
| `POST /api/automation-definitions/{id}/runs` | `Idempotency-Key` header | Any string up to 255 characters | No; without a key every call creates a run |
| Every [MCP](../features/mcp.md) mutation | `idempotencyKey` tool argument | 8–128 characters matching `[\w.-]` | Yes |

Keys are scoped to the calling user (an automation run key to its definition, an MCP key to the user and grant). The same key with the same body replays: a task submission returns the existing submission and resumes it if it stopped part way, a goal creation returns the goal it created (`200` instead of `201`), and an automation run returns the existing run with `created: false`. The same key with a different body is rejected with `409` (MCP: `IDEMPOTENCY_CONFLICT`). Automation run keys are not compared against the body.

An MCP receipt in state `unknown` with `OUTCOME_UNKNOWN` may have had its external effect. Inspect it before acting again. The MCP `create_task` tool does not reuse your MCP key as the REST key: it creates the submission with `Idempotency-Key: mcp-{operationId}`. The MCP `implement_plan` tool claims each plan issue once, so a new key that selects an issue another receipt already started is refused with `IMPLEMENTATION_ALREADY_REQUESTED` (`409`).

**Following a submission through replacement attempts.** ProPR replaces an issue task automatically when its run is lost with its worker (`infra_lost`, one replacement) or ends with a transient provider error (`provider_transient`, up to the **Provider failure replacements** setting, default 2). Only issue tasks are replaced; goal tasks never are, and neither are pull request follow-up, review or automation tasks (see [Troubleshooting](./troubleshooting.md)). A replacement is a new task with its own ID, so a submission has two task pointers:

- `firstTaskId`: the first execution. `taskId` is the same value, kept for compatibility.
- `latestTaskId`: the newest execution of the submission's issue, which is a replacement attempt or a label retry.

`GET /api/task/{taskId}/history` returns the lineage in `taskInfo`: `attemptNumber` (1 for the original run), `replacesTaskId` and `replacedByTaskId` for every stored task, and `attemptLineage` (each attempt's `taskId`, `attemptNumber`, `replacementCause`, `state` and `createdAt`, oldest first) only when there is more than one attempt. To follow work to its end, read `latestTaskId` again, or follow `replacedByTaskId` until it is null. When a failure was not replaced, the task history has an event whose `metadata.event` is `replacement.skipped` and whose `metadata.reason` gives the skip reason, such as `cap_reached`, `user_cancelled`, `issue_closed` or `goal_task`. Over MCP the same lineage is the `lineage` object of `get_task`; see [Idempotency and retries](https://github.com/integry/propr/blob/main/docs/mcp.md#idempotency-and-retries) in the MCP reference for the full list of skip reasons.

## Repository change events

`GET /api/repository-events?repository=owner/repo` reads a repository's durable change-event journal: pull request changes (`opened`, `head_changed`, `review_scored`, `ultrafix_started`, `ultrafix_ended`, `auto_merge_decision`, `merged`, `closed`), epic queue changes (`started`, `advanced`, `blocked`, `completed`), plan issue status changes (`status_changed`) and task lifecycle changes (`queued`, `started`, `completed`, `failed`, `cancelled`; `entityId` is the task id). See the [journal reference](../architecture/repository-event-journal.md#task) for each domain's payloads. `GET /api/repository-events/wait` takes the same parameters plus `timeoutSeconds` (default 15, max 30) and blocks until a matching event exists after the cursor. The MCP tools `list_repository_events` and `wait_repository_events` and `propr events list|wait` return the same results.

Parameters: `repository` (required), `afterCursor`, `fromStart=true`, `domains` and `types` (comma-separated), `pullRequest`, `planId` and `limit` (1–100, default 50). The list returns `{events, cursor, truncated}`; the wait returns `{outcome, events, cursor, truncated, waitedMs, timeoutSeconds}`, where `outcome` is `events` or `timeout`. A wait returns at once when matching events already exist; a timeout is an ordinary `200` with the cursor unchanged. Each event has `cursor`, `domain`, `type`, `repository`, `entityId`, `payload` (identifiers and small scalars only) and `occurredAt`, plus `pullRequest`, `issueNumber`, `planId` and `head` when they apply.

**Cursor contract.** The cursor is an opaque string bound to the repository. Delivery is at-least-once and ordered: resume with the cursor of the last event you processed and no event is missed. Without `afterCursor` a read starts at the current end of the journal, returning the current cursor and no history, unless `fromStart=true`; page through that history with the returned cursor while `truncated` is true (a cursor inside retained history expires when retention next prunes the repository). The journal keeps 30 days of events.

Errors use the error envelope; the `hint` says how to recover. `INVALID_INPUT` (400), `CURSOR_INVALID` (400, malformed or not issued here; a cursor from another ProPR instance's journal is rejected even when its position looks valid), `CURSOR_WRONG_REPOSITORY` (400), `CURSOR_EXPIRED` (410, older than the retained journal, so events may have been pruned; it is never reported as an empty result. Recover by first listing without `afterCursor` and saving that cursor, then re-reading the state, then resuming from the saved cursor), `WAIT_LIMIT` (429, too many open waits for you on this server, counted with MCP waits) and `REPOSITORY_NOT_ACCESSIBLE` (404, the repository is not configured here or you cannot read it on GitHub). Disconnecting releases a wait.

A coordinator loop waits for changes, then reads the state it cares about:

```bash
cursor=""
while :; do
  result=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "$PROPR_URL/api/repository-events/wait?repository=acme/app&pullRequest=42&timeoutSeconds=30${cursor:+&afterCursor=$cursor}")
  cursor=$(echo "$result" | jq -r .cursor)
  if [ "$(echo "$result" | jq -r .outcome)" = events ]; then
    curl -s -H "Authorization: Bearer $TOKEN" "$PROPR_URL/api/pull-requests/42/readiness?repository=acme/app" | jq .verdict
  fi
done
```

## Quick start with curl

```bash
export PROPR_URL=https://propr.example.com
export TOKEN=$(gh auth token)

# Version and compatibility (no credentials)
curl -s "$PROPR_URL/api/compatibility"

# Tasks that need attention
curl -s -H "Authorization: Bearer $TOKEN" "$PROPR_URL/api/tasks?status=attention&limit=20"

# Submit a task; repeating the request with the same key does not open a second issue
curl -s -X POST "$PROPR_URL/api/task-submissions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"repository":"acme/app","instruction":"Fix the login redirect loop"}'
```

For the aggregate dashboard and statistics endpoints, see [Metrics](./metrics.md).
