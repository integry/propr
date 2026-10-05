# MCP capability coverage and acceptance checklist

The executable catalog is `packages/api/mcp/tools.ts` and its `tools*.ts`
modules. `tools/list` filters capabilities by the authenticated grant and
current administrator permissions. All listed tools have implementations;
there is no generic REST or shell execution tool.

The catalog covers the supported backend workflows below, including non-secret
configuration. Live provider and chat-host acceptance are separate from this catalog.

## Product-operation mapping

| Product operation | MCP tool(s) or explicit boundary |
| --- | --- |
| Identity, instance, permissions, setup | `get_connection`, `get_setup_status` |
| Configured repositories and enabled agent models | `list_repositories`, `list_models` |
| Exact/fuzzy reference lookup | `resolve_reference`; ambiguous names return candidates |
| Cross-repository “what is happening now” | `get_current_activity`; running tasks, active goals, plans being generated, queued work and blockers waiting on a human, for every repository in the grant at once. Optional exact `repository`; `includeRoutine` keeps filtered Inbox noise; `activity` resource |
| “What has been done recently” | `get_recent_activity`; one merged newest-first timeline of terminal tasks, opened/merged pull requests, finished goals, published plans, reviews, ultrafix loops and blocking notifications. `sinceMinutes` or `since`/`until`, default 60 minutes and at most seven days; `activity/recent` resource |
| Task/PR work overview | `get_work_overview`; running, recent or all task summaries joined to bounded current PR head, review, checks, merge state, newest ProPR review and ultrafix state, using one aliased GraphQL call per repository |
| Draft list/read/create/update/delete | `list_plans`, `get_plan`, `create_plan`, `update_plan`, `delete_plan`; `list_plans` takes an optional `status` filter (`active`, any persisted plan status such as `draft`/`generating`/`refining`/`review`/`approved`/`executed`/`executing`/`pr_created`/`merged`/`failed`, or `all`, the default), applied in the query so `offset`/`limit` page the filtered set. `delete_plan` removes idle (`draft`/`review`/`approved`) and terminal (`failed`/`merged`) plans; its `expectedRevision` is an optional guard that is rejected with `STALE_REVISION` only when stale, and a plan that is generating, refining or executing is refused with `PLAN_NOT_DELETABLE`. `mcp_revision` (returned by `get_plan`) is an MCP-internal optimistic-concurrency token, not a user-facing number, and is not shown in the web UI |
| Plan revision history | `list_plan_revisions`, `get_plan_revision`, `restore_plan_revision`; every replaced plan is kept (up to 50 per plan), revisions expose their persisted cause (`generation`, `refinement`, `manual_edit`, `restore`, `rename` or `unknown`), and a restore requires the exact `expectedRevision` and is refused for published or busy plans |
| Generate/refine a plan | `generate_plan`, `refine_plan`; refinement output is schema-validated before replacement and an invalid result remains observable as `REFINEMENT_OUTPUT_INVALID` without destroying the prior plan |
| Propose what to work on next (web UI **Improve** tab) | `generate_repository_improvements`; same inputs and category validation as `POST /api/repos/improvements` (`categories` and/or `customPrompt`, optional `branch`, `referenceRepository`, `model`, `contextLevel`). Returns an `accepted` receipt immediately; generation runs in the background and `get_operation` reports `running`, then `completed` with `result.suggestions` (`{ title, description }`) and `estimatedDurationMs`/`actualDurationMs`/`isHistoricalEstimate`, or `failed` with `IMPROVEMENTS_OUTPUT_INVALID`. A generation that does not settle within 30 minutes is reported `unknown` with `IMPROVEMENTS_OUTCOME_UNAVAILABLE`. Nothing is written to GitHub |
| Publish GitHub issues | `publish_plan`; publication does not start implementation. A recoverable partial publication stays inspectable and requires a fresh receipt with `resume: true`, which adopts marked issues before creating missing ones |
| Selected issues, model, epic, bounded ultrafix and explicit auto-merge | `implement_plan`: epics default to sequential selected issues in publication order; `epicExecution: "parallel"` restores fan-out; `epicAdvanceOn: "merged"` (default) or `"terminal"` controls advancement. Sequential mode requires one model. |
| Plan scheduling | `pause_plan` holds the next queued issue; `resume_plan` starts the held queue head. `get_plan.epicQueue` and `get_operation.targetState.epicQueue` expose issues, cursor, head, status, advanceOn and blockedReason; closed/failed heads block merged-only queues until fixed and merged. Receipts remain accepted until queue completion. |
| Native goal capabilities/start/read/input | `get_goal_capabilities`, `create_goal`, `list_goals`, `get_goal`, `wait_goal`, `list_goal_inputs`, `list_goal_attention`, `get_agent_activity`, `send_goal_input`; `list_goals` takes an optional `repository` and a `state` filter (`active`/`completed`/`failed`/`all`), `get_goal` adds newest narration, task progress, checkpoint state, `pendingInput`, the open blockers in `goal.attention` and the pull requests the goal produced, `list_goal_attention` lists only goals waiting on the operator (repository-filtered and bounded), `wait_goal` waits at most 30 seconds per request for a confirmed lifecycle state or a new checkpoint on a durable per-goal cursor, and `send_goal_input` takes a `kind` (`instruction` or `question`) that distinguishes the request without changing the single durable goal input this backend persists |
| Goal controls/model changes | `pause_goal`, `resume_goal`, `cancel_goal`, `set_goal_model` |
| Start one-off work through a new GitHub issue | `create_task`, `get_task_submission`, `list_task_submissions`, `retry_task_submission`; ordinary issue execution without a plan or goal. Submission progress distinguishes issue creation, queueing, running and terminal task/PR state. `create_task` takes the same bounded `runUltrafix`/`ultrafixGoal`/`ultrafixMaxCycles` and `autoMerge` options as `implement_plan` (an omitted `ultrafixGoal` resolves to the instance `ultrafix_rating_goal` at call time), applied as the shared `ultrafix` and `auto-merge` issue labels |
| Task progress, narrated agent activity, history and bounded execution logs | `list_tasks`, `get_task`, `get_agent_activity`, `get_task_events`, `get_task_logs`; `list_tasks` takes an optional `repository` and the same `state` filter, and `get_task` adds recent events, newest narration, execution timing, `changesSummary` counts and its linked pull request |
| File changes and followup | `get_task_changes`, `send_task_followup` |
| Task/operation cancellation and receipts | `cancel_task`, `get_operation`, `list_operations`, `cancel_operation`; durable lifecycle, timestamps, artifacts, progress and sanitized structured failures. `list_operations` is a bounded receipt index with repository/tool/lifecycle/time filters; refresh one result with `get_operation` |
| Structured failure diagnosis | Every tool failure returns the shared `error` envelope: stable `code`, safe `message`, `stage`, `retryable`, `status`, optional bounded `details`, and optional sanitized `cause`. Mutations with uncertain external effects persist `OUTCOME_UNKNOWN` instead of claiming rollback or safe replay |
| Delete inactive task history | `delete_task`; bulk cleanup uses explicit individual handles |
| Pull request inventory across the grant | `list_pull_requests`; newest-first, with ProPR task/goal/plan correlation, `openedWithinMinutes`/`updatedWithinMinutes` recency filters, an optional newest comment and `propr.ultrafixActive`. Omit `repository` to cover the grant; `repositories/{owner}/{repo}/pulls` resource |
| Ordinary PR follow-up comment | `comment_on_pull_request`; optional `expectedHead`, natural-language message only. An omitted head is resolved by the server and every receipt reports `resolvedHead`/`headSource`. A message that starts a slash command is rejected with `USE_EXPLICIT_TOOL` |
| PR model routing by managed label | `set_pull_request_model`; converges the labels the repository already defines onto exactly one enabled agent model. No label is ever created |
| Starting or re-arming an ultrafix loop | `start_ultrafix`; requires `expectedHead` and rejects a moved head with `STALE_HEAD`. Posts the same `/ultrafix` command a hand-typed comment does, whose intake re-adds the `ultrafix` label and starts the loop. Optional `ultrafixGoal`/`ultrafixMaxCycles` default to the instance `ultrafix_rating_goal`/`ultrafix_max_cycles`. Listed under execute scope and additionally requires review scope; returns a durable receipt tracked like `run_ultrafix` |
| Stopping an ultrafix loop | `stop_ultrafix`; requires `expectedHead` because a moved head may contain a human fix the loop should still review. Removes the `ultrafix` label so the loop starts no further cycle. Listed under execute scope and additionally requires review scope; a cycle already running may still finish |
| PR read/review/fix/ultrafix | `get_pull_request`, `get_pull_request_discussion`, `review_pull_request`, `fix_review_findings`, `run_ultrafix`; the three append-only commands accept optional `expectedHead` and report `resolvedHead`/`headSource`, plus exact comment and F#/S# selection (merge blockers required, named suggestions optional), reviewed head, partial coverage and consumed records. `review_pull_request` takes an optional `model` alias or list of aliases; each is validated against enabled models, fans out one independent `/review <model>` per model at the same head, returns one `reviews` receipt per model and never changes the PR's model labels |
| Update branch (`/merge`) | `update_pull_request_branch`; `expectedHead` is required to avoid updating code the caller has not seen |
| Guarded PR merge | `merge_pull_request`; `expectedHead` is required to avoid merging code the caller has not seen |
| Preview/revert a PR commit | `get_pull_request_revert_preview`, `revert_pull_request_commit`; exact commit, comment and head |
| Published visual evidence | `list_visual_previews`, `get_visual_preview`; list exact task/PR preview metadata, then fetch bounded/downscaled image content. Videos remain metadata-only; `repositories/{owner}/{repo}/previews/{previewId}` resource |
| Comment image attachments | `get_comment_attachment`; fetch one `github.com/user-attachments` image embedded in an issue/PR comment (or description) through the caller's GitHub access as bounded/downscaled image content, independent of ProPR managed preview storage. Discover attachments from `get_pull_request_discussion` comment `attachments`. Videos remain metadata-only |
| Bundled product documentation | `list_docs`, `search_docs`, `get_doc`; stable paths, bounded section/chunk reads, normalized redacted content and `docs/{path}` resource. The MCP guide is `mcp/guide` |
| Configuration discovery | `find_setting`; structured UI/MCP/CLI/environment reachability, permissions, restart requirements and browser/environment-only boundaries |
| Indexed overview/tree/path/search/freshness | `get_repository_context` |
| Indexing launch/cancellation | `index_repository`, `stop_repository_indexing`; explicit repository/branch |
| Repository TODO CRUD/category CRUD | `list_todos`, `get_todo`, `create_todo`, `update_todo`, `delete_todo`, `list_todo_categories`, `create_todo_category`, `update_todo_category`, `delete_todo_category` |
| TODO category movement/order | `move_todo`; order fields on TODO/category update |
| Star/hidden repository preferences | `get_repository_preferences`, `update_repository_preferences` |
| Inbox notifications read/dismiss/clear | `list_notifications`, `get_notification`, `get_notification_unread_count`, `mark_notification_read`, `dismiss_notification`, `update_notifications`, `mark_all_notifications_read`, `clear_notifications`; without `repository` these cover system notifications and every repository in the grant; `notifications` and `notifications/{id}` resources |
| Notification preferences, categories and quiet hours | `get_notification_preferences`, `update_notification_preferences`, `set_notification_category_preferences` |
| Bounded plan/goal attachments and owned upload artifacts | `upload_attachment`, `get_artifact`, `get_attachment`; authenticated download links, no remote URL download |
| Execution/model settings | `get_execution_settings`, `update_execution_settings` |
| GitHub trigger users, blocklist and exempt bots | `get_trigger_access_configuration`, `update_trigger_access_configuration`; environment-owned values are read-only |
| Repository configuration | `get_repository_configuration`, `create_repository_configuration`, `update_repository_configuration`, `remove_repository_configuration` (branch/alias/enabled/CI followup/follow-up CI cancellation and its selected validation workflows/visual preview policy); instance permission and explicit repository grant required |
| Direct agent configuration | `get_agent_configuration`, `create_agent_configuration`, `update_agent_configuration`, `remove_agent_configuration`; actual types/models, alias, enablement, model labels/reasoning, CLI versions; new agents start disabled for secure login |
| Synthetic-agent composition | `create_synthetic_agent`, `update_synthetic_agent`, `remove_synthetic_agent`; pool models/members, strategy, priority and usage thresholds; existing reference/default guards |
| Advanced indexing policy | `get_indexing_configuration`, `update_indexing_configuration`; primary/fallback alias:model, prompt, enablement and runtime cooldown state |
| Provider policy | `get_provider_policy`, `update_provider_policy`, `get_provider_status`, `get_provider_usage`, `refresh_provider_usage`, `detect_provider_service`; Agent Tank integration mode (`disabled`/`bundled`/`external`) and, for external, the service origin; no credential entry |
| Execution/review/context | `get_execution_settings`, `update_execution_settings`; worker concurrency, analysis/planner models, review model/prompt/context enablement/model/budget, reasoning and bounded ultrafix defaults |
| Workflow labels and keywords | `get_`/`update_` tools for `followup_keywords`, `followup_ignore_keywords`, `primary_processing_labels`, `pr_label`, `ai_primary_tag` |
| Runtime package configuration/build | `get_runtime_configuration`, `update_runtime_configuration` |
| Instance membership administration | `list_instance_members`, `add_instance_member`, `set_instance_member_role`, `remove_instance_member`, `get_instance_role_audit`; existing last-admin guards |
| Shared repository chat history | `get_repository_chat`, `save_repository_chat_message`, `delete_repository_chat_message` |
| MCP access observability | Durable `mcp_access_log` row per tool call, resource read, prompt fetch and authentication failure; `GET /api/admin/mcp/logs` and `GET /api/admin/mcp/logs/stats`, both behind the existing `instance.manage_settings` permission; last-used and 24-hour request counts per connected app on `/mcp/apps`. Only names, identifiers, counts, sizes and outcomes are stored, and no MCP tool reads the log |
| GitHub credentials, provider login, agent secrets, push subscription | Browser settings/login links from connection/setup; never collect secrets through tools |
| Deployment/release | Existing operator CLI/scripts only. No corresponding deployment backend was found; no fictitious deployment tool is advertised. `deploy` is reserved and confers no operation by itself. |

## Settings reachability

The generated [Where Each Setting Lives](./docs/operations/settings-locations.md)
page is the single source of truth for UI, MCP, CLI, and environment locations.
MCP clients can query the same structured catalog with `find_setting`, including
settings that are intentionally browser-only or environment-only.

## Implementation checklist

- [x] Official maintained SDK and published protocol/package verification.
- [x] Both protocol eras on the same URL with one real tool implementation.
- [x] Separate MCP authentication before GitHub-bearer middleware.
- [x] Standalone direct OAuth, durable encrypted grants, S256 PKCE, code
  consumption, refresh rotation/reuse revocation, metadata, public CIMD/DCR.
- [x] Exact redirect validation and explicit callback/loopback limitation.
- [x] Browser consent with requested-scope subset and repository selection, CSRF protection, connected
  apps and revocation; Chromium desktop/mobile behavior and image evidence.
- [x] Opt-in signed Connect delegation, audience/instance/installation/user
  binding, persistent key/proof registration, per-request online validation and
  proof-bound server-to-server GitHub credentials against the actual routing contract.
- [x] Scope, configured-repository, current GitHub and instance access checks;
  owner checks for plans/goals/TODOs/artifacts and private native goal tasks.
- [x] Revision counter invalidated by all draft writers through a SQLite trigger.
- [x] Durable mutation keys, atomic duplicate exclusion, restart-readable
  receipts, bounded polling, explicit uncertain external outcomes.
- [x] Fixed tool schemas, annotations, bounded results and credential redaction.
- [x] Resources and mutation-free workflow prompts; durable text/voice handles.
- [x] Cross-repository activity digest and recent-activity timeline, with the
  Inbox noise filter applied inside the bounded scan.
- [x] Repository-optional goal/task listing with a lifecycle filter, one-call
  goal and task detail, and the persisted operator-input history behind it.
- [x] Pull request inventory with ProPR correlation, newest-first discussion,
  ordinary follow-up comments, managed model-label routing and clearing the
  ultrafix circuit breaker.
- [x] Durable MCP access log with its bounded retention sweep, the
  permission-guarded admin read/stats API, and per-app last-used activity.
- [x] Direct/Connect operator docs, wire contract, rollback and capability mapping.

## Verification checklist and known limits

- [x] OAuth HTTP token exchange, invalid PKCE/resource/redirect, replay,
  concurrent refresh reuse, revocation and encrypted storage tests.
- [x] Both official SDK clients discover tools/resources/prompts, invoke real
  SQLite draft creation/revision/publication and observe worker-state fixtures.
- [x] Both SDK eras invoke real implementation/followup handlers with GitHub
  and queue fixtures; concurrent starts enqueue once; explicit auto-merge
  false clears the label. Guarded PR review/fix/ultrafix/update/merge transitions.
- [x] Both SDK eras exercise persisted goal lifecycle, TODO/category movement,
  deletion replay, notifications, settings, preferences and attachment chunks.
- [x] Real ES256/JWKS tests plus the pinned actual Worker/core integration check
  online validation, proof/key/instance/installation/repository restrictions,
  encrypted credential handoff and membership/revocation denial.
- [x] SQLite file reopen and concurrent durable dedup test.
- [x] One end-to-end operator-surface regression drives the real catalog through
  `get_current_activity` → `get_goal`/`get_task` → `list_pull_requests` →
  `get_pull_request_discussion` → `comment_on_pull_request` →
  `set_pull_request_model` → `stop_ultrafix`, then asserts the access log
  recorded every invocation, including a scope denial and a forbidden-repository
  denial, and reads that session back through the admin log API
  (`packages/api/test/mcpOperatorSurface.test.ts`, wired into `test:mcp`).
- [x] Browser consent/revocation test, CSRF denial and mobile overflow check.
- [ ] A live end-to-end agent run through generation → publication →
  implementation → followup → review/fix → guarded merge. Local tests do not
  provision Docker agents, spend provider credits or merge real PRs.
- [ ] Live GitHub login, ChatGPT/Claude OAuth and host voice sessions.
- [x] Paired Connect gateway/core integration runs locally against an authorized routing checkout.
- [ ] Live tunnel unavailability/version mismatch/cancellation/streaming
  verification against the deployed gateway. The expected mapping is in
  `mcp-connect-contract.md`; the gateway is not part of this checkout.

Only secure setup boundaries remain browser/operator-only: GitHub/provider login,
agent secrets and environment variables, credential mount paths, custom agent
images/install sources, push subscriptions, and OAuth consent expansion. These
configure credentials, host execution or grant boundaries rather than ordinary
model/workflow preferences. Agent creation uses managed credential paths (Vibe
uses its supported fixed default path); the tool cannot choose a host path.
Creation does not authenticate or enable an agent. Repository addition outside
the current explicit grant returns `browser_required`, `changed: false`, and a
browser continuation; no repository or grant is silently added. Membership
administration retains its existing instance permission and last-admin guards.
Raw Docker streaming logs are not exposed; bounded persisted execution events
are available through `get_task_logs`. Deployment has no supported backend here.

Repository, direct-agent and synthetic-agent adapters include a revision of the
snapshot they read. The existing shared persistence lock checks that revision
before writing. A concurrent REST or MCP change produces a conflict; retry with
a fresh read and new operation key. No unrelated changes are overwritten. Indexing receipts track their actual indexing
queue job through completion and expose repository context freshness; they do not
pretend the indexing job is an implementation task.

Follow-up receipts retain `sourceTaskId` separately from the new durable
`jobId`/`continuation.taskId`. States distinguish `posted`, `queued`, `running`,
`completed`, `failed`, and `unknown`. A queue acknowledgement failure keeps the
posted comment/job handles and reports uncertainty, never success. Polling can
resolve an uncertain submission when its task appears. PR command receipts link
to tasks by their exact triggering comment in persisted job data, expose posted
review result IDs/URLs, and report the resulting current PR head. Ultrafix polls
the associated work epoch through loop completion; a newer loop cannot satisfy
an earlier receipt. A PR command receipt whose comment no worker has picked up
within ten minutes reports `unknown` with a `COMMAND_NOT_PICKED_UP` failure
instead of remaining accepted forever; a later poll that finds the task still
adopts it.

`get_pull_request_discussion` pages GitHub issue comments (maximum 20 per page),
returns 4096-character body chunks and parsed F# findings and S# suggestions
(`currentFindingIds` and `currentSuggestionIds` honor the worker’s seven-day age
limit, known head and consumption state; `selectableFindingIds` and
`selectableSuggestionIds` drop the head condition, as `/fix` does), and supports exact
comment/task lookup. A comment embedding GitHub user attachments lists them under
`attachments` (`index`, `attachmentId`, `type`, untrusted `alt`, `fetchable`);
`get_comment_attachment` returns the image itself. New reviews persist reviewed head and task identity in the
existing review marker; legacy reviews explicitly report an unknown head.
`fix_review_findings` requires `reviewCommentId` and at least one identifier
across `findingIds` (merge blockers) and `suggestionIds` (non-blocking
follow-ups), which may be mixed freely; it rejects consumed, unknown, malformed
or mismatched identifiers by name. A review of an older head is re-anchored onto
the current head rather than rejected: records whose cited files were all
deleted since the review, with no surviving file gaining lines the code could
have moved into, are reported in `skipped` and left out, the rest are
posted and listed in `applied`, and `reviewedHead`/`resolvedHead`/`reanchored`
report the move. A caller-supplied `expectedHead` still fails with `STALE_HEAD`
on a mismatch. A suggestion is
in fix scope only because it was named, and naming one never relaxes a merge
blocker. Comment content remains untrusted data.

Uncertain external side effects remain `unknown` and require inspecting the
target. They are never reported as rolled back or blindly retried. In
particular, a partly published plan remains busy with persisted created issue
links. Cancelling a receipt cannot undo already published issues or comments.

## Verification in CI

The public core repository's required `Build & Lint Check` → `Validate Changes`
job builds shared/core/CLI dependencies, installs Playwright Chromium, and runs
`test:mcp` and `test:mcp:browser`. These self-contained checks cover core OAuth,
policy/security, both SDK eras, workflow persistence, cancellation and command
identity, concurrency, and real TLS browser consent/revocation. Any failure
fails the existing required job; missing Chromium is a failure, not a skip.
They require no private checkout, extra token, or permission change.

Paired gateway coverage runs against the separately maintained Connect routing service and is not
part of core CI.

For local paired verification:

```sh
npm run test:prepare
npm run test:mcp
MCP_ROUTING_REPOSITORY=/path/to/routing-checkout npm run test:mcp:connect  # requires an authorized routing checkout
npx playwright install --with-deps chromium
npm run test:mcp:browser
npm run build
npm run typecheck -w @propr/api
```

The concurrency regression pauses an MCP adapter after loading its snapshot,
lets a second repository/agent mutation persist, then resumes the first and
verifies a conflict plus preservation of the second edit. Workflow regressions
keep the original task completed while the new task advances, exercise queue
uncertainty/failure, and persist posted reviews/F# findings before selecting and
observing a fix. No live agent credits, merges, deployments or permission changes
are part of these tests.

## Cancellation and security behavior

Cancellation receipts remain `accepted` while the goal only has
`desired_state='cancelled'`, the task only has an abort signal, or a planner abort
has reset the draft without background exit. Confirmed stop resolves the receipt
to `completed` with `result.cancellation='confirmed'` and
`result.targetOutcome='cancelled'`. If the target completed or failed first, the
receipt resolves with `cancellation='not_applied'` and that actual `targetOutcome`.
This describes resolution of the cancellation request, not successful execution
of the target. Terminal outcomes are persisted for idempotent replay.

Plan generation/refinement cancellation is bound to the start response's `runId`;
a conditional abort cannot cancel a replacement run. Background exit writes a
minimal durable `planner_stop` record in `mcp_records` (run/draft IDs and stop
time only), surviving draft edits and restart. An unavailable stop record never
means a confirmed stop. Legacy planner receipts without a run identity require
inspection rather than risking cancellation of a replacement. Existing goal/task
cancellation receipts still resolve from their persisted targets; older
`cancel_operation` receipts also reauthorize their source repository when their
own repository field is absent.

The `/authorize` limiter is constructed directly in the Express middleware list,
with shared quota/header/proxy-key options. The previous two factory returns hid
the middleware construction from CodeQL's routing model. Its
[ExpressRateLimit model](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/MissingRateLimiting.qll)
recognizes the package constructor and maps that node into routing order. No
query is disabled or dismissed; runtime rejection still precedes body parsing
and client lookup. The existing Secure-cookie TLS browser fixture is preserved.

## Operator surface limits

Every tool name, argument, resource URI and prompt named above exists in `tools.ts`,
`toolsActivity.ts`, `toolsPullRequests.ts`, `goalTaskDetail.ts`, `pullRequestInventory.ts`,
`accessLog.ts` and `server.ts`. `docs/mcp.md` carries the operator walkthrough.

What this surface deliberately does **not** claim:

- **Bounded scans, not exhaustive ones.** The digest fans out over at most 20
  configured repositories in the grant, resolves live narration for at most 10
  goals, and the recent-activity timeline merges at most 500 collected rows
  within a window of at most seven days. `repositoriesTruncated`, a section's
  `truncated`, and `scanTruncated` say a scan stopped early; they never mean the
  remainder is empty. The inventory scans at most four GraphQL pages of 50 pull
  requests per repository and attaches the newest comment to at most 10 results.
- **A repository the credential lost access to is skipped, not failed.** The
  cross-repository fan-outs drop a repository that answers 403, exactly as
  `list_repositories` does. Naming that repository explicitly is denied with
  `REPOSITORY_FORBIDDEN`, and the denial is recorded.
- **Narration and change counts are evidence, not guarantees.** Agent narration
  is best-effort context: an unresolvable live session reports no entries rather
  than failing the read. `changesSummary` is `null` when no file-change data is
  persisted for that task; it never reports zero for unknown. Raw provider
  reasoning, tool inputs and tool results stay excluded.
- **Delivering a correction is not the agent acting on it.** `send_goal_input`
  accepts a correction into the durable goal-input queue; `kind` only
  distinguishes the request, because this backend persists exactly one operator
  input kind. Reusing an idempotency key with a different `kind` is an
  `IDEMPOTENCY_CONFLICT`, not a second correction. Confirm with `get_goal` or `list_goal_inputs`; `pendingInput` reports
  undelivered corrections so a second one is not sent blindly.
- **Cancellation acceptance is still not proof of stopping.** The existing
  cancellation receipts are unchanged: `accepted` means the request was
  recorded, and only a confirmed stop resolves it.
- **Clearing the ultrafix circuit breaker does not abort an in-flight cycle.**
  `stop_ultrafix` removes the `ultrafix` label so the loop starts no further
  cycle, requires review scope, and says so in its own message. A cycle already
  running may still finish, and inspecting the pull request is the only proof.
  `propr.ultrafixActive` is `null`, not `false`, when the label list GitHub
  returned was truncated: the breaker is undetermined, not absent.
- **Model routing uses labels the repository already defines.** A model with no
  managed label fails with `MODEL_LABEL_MISSING`; an incomplete label read fails
  with `MODEL_LABEL_LOOKUP_INCOMPLETE` rather than claiming absence. No label is
  created, and adding the new label precedes removing superseded ones so routing
  is never dropped.
- **Pull request titles, labels and comment prose remain untrusted data.**
  `comment_on_pull_request` posts ordinary prose only and rejects a message that
  starts a slash command with `USE_EXPLICIT_TOOL`, so scope and optional head
  preconditions are checked by the dedicated command tool. Append-only PR
  commands resolve an omitted head from their single PR read, return
  `resolvedHead`/`headSource`, and put that resolved SHA in their marker.
- **The access log deliberately stores no argument or payload content.** One row
  per tool call, resource read, prompt fetch and authentication failure records
  the surface, the name, the grant and client identity, the repository, scope,
  status, outcome, error code, duration, result size and durable operation
  handle. Tool arguments, message bodies, plan/goal text, comment prose,
  credentials and result payloads never reach the table. A write that fails is
  swallowed, so logging can never change a result, a status code or a response
  body — which also means the log is operational observability, not a
  tamper-proof audit store. Rows are pruned to a 30-day window and a 200,000-row
  ceiling by an opportunistic sweep.
- **The log is an operator surface only.** No MCP tool reads it. It is served by
  `GET /api/admin/mcp/logs` and `GET /api/admin/mcp/logs/stats`, both behind the
  existing `instance.manage_settings` instance permission, and summarized per
  connected app on `/mcp/apps` as a last-used time and a 24-hour request count.
  In the web UI it is the **MCP Log** page (`/mcp-logs`), under the sidebar's
  **Logs** group next to **LLM Log**; the entry and the page require the same
  `instance.manage_settings` permission. See `docs/docs/features/web-ui.md`.

## Observable surface verification

The regression at `packages/api/test/mcpObservableSurface.test.ts` covers the
receipt/error, work overview, plan recovery, docs, preview and
configuration-discovery surface using the production catalog, policy, schemas,
operation ledger, docs index and SQLite migrations. GitHub, queue/dispatch,
Redis compatibility and preview-media fetches are the external fixtures. It
also extracts every backticked `^[a-z_]+$` token in `docs/mcp.md` and requires it
to be an admin-visible catalog tool or a named non-tool token.
