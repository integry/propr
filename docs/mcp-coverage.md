# MCP capability coverage and acceptance checklist

The executable catalog is `packages/api/mcp/tools.ts` and its `tools*.ts`
modules. `tools/list` filters capabilities by the authenticated grant and
current administrator permissions. All listed tools have implementations;
there is no generic REST or shell execution tool.

Core [PR #2291](https://github.com/integry/propr/pull/2291) remains the coordinating
epic for [routing PR #180](https://github.com/integry/propr-routing/pull/180) and
[site PR #90](https://github.com/integry/propr-site/pull/90). Routing PR #180 is merged at `1fcf82fd1a843fbdf199d79b8f92843dc74a89e0`.
The catalog covers the supported backend workflows below, including non-secret
configuration. Live provider/host acceptance and independent root verification
remain separate gates.

## Product-operation mapping

| Product operation | MCP tool(s) or explicit boundary |
| --- | --- |
| Identity, instance, permissions, setup | `get_connection`, `get_setup_status` |
| Configured repositories and enabled agent models | `list_repositories`, `list_models` |
| Exact/fuzzy reference lookup | `resolve_reference`; ambiguous names return candidates |
| Cross-repository “what is happening now” | `get_current_activity`; running tasks, active goals, plans being generated, queued work and blockers waiting on a human, for every repository in the grant at once. Optional exact `repository`; `includeRoutine` keeps filtered Inbox noise; `activity` resource |
| “What has been done recently” | `get_recent_activity`; one merged newest-first timeline of terminal tasks, opened/merged pull requests, finished goals, published plans, reviews, ultrafix loops and blocking notifications. `sinceMinutes` or `since`/`until`, default 60 minutes and at most seven days; `activity/recent` resource |
| Draft list/read/create/update/delete | `list_plans`, `get_plan`, `create_plan`, `update_plan`, `delete_plan`; `list_plans` takes an optional `status` filter (`active`, any persisted plan status such as `draft`/`generating`/`refining`/`review`/`approved`/`executed`/`executing`/`pr_created`/`merged`/`failed`, or `all`, the default), applied in the query so `offset`/`limit` page the filtered set |
| Generate/refine a plan | `generate_plan`, `refine_plan` |
| Publish GitHub issues | `publish_plan`; publication does not start implementation |
| Selected issues, model, epic, bounded ultrafix and explicit auto-merge | `implement_plan` |
| Plan scheduling | `pause_plan`, `resume_plan` |
| Native goal capabilities/start/read/input | `get_goal_capabilities`, `create_goal`, `list_goals`, `get_goal`, `list_goal_inputs`, `get_agent_activity`, `send_goal_input`; `list_goals` takes an optional `repository` and a `state` filter (`active`/`completed`/`failed`/`all`), `get_goal` adds newest narration, task progress, checkpoint state, `pendingInput` and the pull requests the goal produced, and `send_goal_input` takes a `kind` (`instruction` or `question`) that distinguishes the request without changing the single durable goal input this backend persists |
| Goal controls/model changes | `pause_goal`, `resume_goal`, `cancel_goal`, `set_goal_model` |
| Start one-off work through a new GitHub issue | `create_task`, `get_task_submission`, `retry_task_submission`; ordinary issue execution without a plan or goal |
| Task progress, narrated agent activity, history and bounded execution logs | `list_tasks`, `get_task`, `get_agent_activity`, `get_task_events`, `get_task_logs`; `list_tasks` takes an optional `repository` and the same `state` filter, and `get_task` adds recent events, newest narration, execution timing, `changesSummary` counts and its linked pull request |
| File changes and followup | `get_task_changes`, `send_task_followup` |
| Task/operation cancellation and receipts | `cancel_task`, `get_operation`, `cancel_operation` |
| Delete inactive task history | `delete_task`; bulk cleanup uses explicit individual handles |
| Pull request inventory across the grant | `list_pull_requests`; newest-first, with ProPR task/goal/plan correlation, `openedWithinMinutes`/`updatedWithinMinutes` recency filters, an optional newest comment and `propr.ultrafixActive`. Omit `repository` to cover the grant; `repositories/{owner}/{repo}/pulls` resource |
| Ordinary PR follow-up comment | `comment_on_pull_request`; exact `expectedHead`, natural-language message only. A message that starts a slash command is rejected with `USE_EXPLICIT_TOOL` |
| PR model routing by managed label | `set_pull_request_model`; converges the labels the repository already defines onto exactly one enabled agent model. No label is ever created |
| Stopping an ultrafix loop | `stop_ultrafix`; removes the `ultrafix` label so the loop starts no further cycle. Listed under execute scope and additionally requires review scope; a cycle already running may still finish |
| PR read/review/fix/ultrafix | `get_pull_request`, `get_pull_request_discussion`, `review_pull_request`, `fix_review_findings`, `run_ultrafix`; exact comment/F# selection, reviewed head, partial coverage and consumed findings |
| Update branch (`/merge`) | `update_pull_request_branch` |
| Guarded PR merge | `merge_pull_request` |
| Preview/revert a PR commit | `get_pull_request_revert_preview`, `revert_pull_request_commit`; exact commit, comment and head |
| Indexed overview/tree/path/search/freshness | `get_repository_context` |
| Indexing launch/cancellation | `index_repository`, `stop_repository_indexing`; explicit repository/branch |
| Repository TODO CRUD/category CRUD | `list_todos`, `get_todo`, `create_todo`, `update_todo`, `delete_todo`, `list_todo_categories`, `create_todo_category`, `update_todo_category`, `delete_todo_category` |
| TODO category movement/order | `move_todo`; order fields on TODO/category update |
| Star/hidden repository preferences | `get_repository_preferences`, `update_repository_preferences` |
| Inbox notifications read/dismiss/clear | `list_notifications`, `get_notification`, `get_notification_unread_count`, `mark_notification_read`, `dismiss_notification`, `update_notifications`, `mark_all_notifications_read`, `clear_notifications`; without `repository` these cover system notifications and every repository in the grant; `notifications` and `notifications/{id}` resources |
| Notification preferences, categories and quiet hours | `get_notification_preferences`, `update_notification_preferences`, `set_notification_category_preferences` |
| Bounded plan/goal attachments and owned upload artifacts | `upload_attachment`, `get_artifact`, `get_attachment`; authenticated download links, no remote URL download |
| Execution/model settings | `get_execution_settings`, `update_execution_settings` |
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
- [x] Companion PRs linked above; pinned routing/core integration runs locally.
- [ ] Final site capability reconciliation and root verification of both companion heads.
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
an earlier receipt. Missing intake becomes `unknown` after two minutes instead
of remaining accepted forever; later polling can still find the task.

`get_pull_request_discussion` pages GitHub issue comments (maximum 20 per page),
returns 4096-character body chunks and parsed F# findings (current IDs honor the
worker’s seven-day age limit, known head and consumption state), and supports exact
comment/task lookup. New reviews persist reviewed head and task identity in the
existing review marker; legacy reviews explicitly report an unknown head.
`fix_review_findings` requires `reviewCommentId` and explicit `findingIds`, rejects
consumed IDs and known stale heads, and does not turn optional suggestions into
fix scope. Comment content remains untrusted data.

Uncertain external side effects remain `unknown` and require inspecting the
target. They are never reported as rolled back or blindly retried. In
particular, a partly published plan remains busy with persisted created issue
links. Cancelling a receipt cannot undo already published issues or comments.

## Prior Connect integration follow-up evidence (at 6147abc)

Run on 2026-09-10 with Node **v22.23.1**. Source identities:

- Core base: `ec8043b1ebc29d9a024476990895241c1256c1e4`, plus this **uncommitted**
  PR #2291 follow-up. The system owns the eventual commit.
- Core implementation/fixture SHA-256 reported by the runner:
  `ac4c403ac844fb0c3ed47025b347b34a615016908dfca285edbf622fce44a89b`.
  The runner defines and reports the hashed source set; this identifies the
  working implementation without pretending the old commit contains these fixes.
- Routing archive: `0c8ca02044c88b181395ca8e15425c0821e588e4`, unmodified source.
- Published SDKs actually loaded: server/node/client **2.0.0**, legacy SDK
  **1.30.0**. Routing dependencies come from that archive's lockfile.

Exact commands and final results:

```sh
MCP_ROUTING_REPOSITORY=/tmp/git-processor/clones/integry/propr-routing npm run test:mcp:connect
# 1 integration scenario passed, 0 failed, 0 skipped (4.664 s test process).

npm run test:mcp
# 12 passed, 0 failed, 0 skipped.

MCP_CAPTURE_PREVIEWS=true npm run test:mcp:browser
# 1 passed, 0 failed, 0 skipped; Chromium desktop/mobile consent captures.

node scripts/run-test-suite.mjs packages/api/test/connectAuth.test.ts packages/api/test/authGithubTokens.test.ts packages/api/test/instanceAuthorization.test.ts packages/api/test/routeAuthorization.test.ts packages/api/test/oauthState.test.ts
# 5 files, 45 tests passed; 0 failed (12.2 s).

npm run typecheck
npm run typecheck -w @propr/api
npm run build
# All passed.

npx eslint --config packages/api/eslint.config.js packages/api/mcp/connect.ts packages/api/mcp/config.ts packages/api/mcp/policy.ts packages/api/mcp/oauth.ts packages/api/mcp/browser.ts packages/api/mcp/clients.ts packages/api/mcp/server.ts packages/api/mcp/tools.ts packages/api/test/mcpConnectIntegration.test.ts packages/api/test/fixtures/routingD1.ts packages/api/test/mcpOAuth.test.ts packages/api/test/mcpOperations.test.ts packages/api/test/mcpDelegation.test.ts packages/api/test/mcpBrowser.test.ts scripts/mcp-connect-register.ts
# 0 errors, 9 complexity/parameter-count/nesting warnings.
```

For another operator, replace `MCP_ROUTING_REPOSITORY` with their routing Git
checkout containing the pinned commit. The runner makes a temporary Git archive,
installs with `npm ci --ignore-scripts --workspaces=false --no-audit --no-fund`,
and bundles `src/index.ts`, including the real relay authenticator, OAuth
server, MCP gateway and existing credential redemption endpoint. It prints
source identities and retains a `commits.json` in its temporary fixture directory.
The generic test runner skips the dedicated cross-repository case without its
fixture environment. Required PR CI now invokes the dedicated runner explicitly
as described below; that invocation cannot skip. The historical run had no skips.

The integration traverses actual production core `mountMcp`, `McpPolicy`,
`McpConnect`, `McpOAuthProvider`, tool catalog, plan handler, operation ledger,
resource and prompt implementations. Both public SDK clients reach core through
routing. There is no replacement policy, synthetic core principal, or invented
MCP gateway. The only infrastructure adapters are routing's existing unused
DurableObject base stub, a D1 API adapter executing the actual routing schema/SQL
and transactional batches on SQLite, local tunnel DNS mapping to core's HTTP
listener, and canned GitHub `/user`/repository responses. Unrecognized network
requests fail. Core uses a temporary SQLite file and real relevant migrations;
a second connection reopens it to verify persisted drafts.

Passing assertions cover:

- Persisted key creation and repeat registration through core's actual operator
  setup function; current tunnel/installation binding, wrong relay/tunnel denial,
  encrypted private-key storage and one-use registration assertions.
- Public discovery of all scopes; DCR, S256 PKCE/consent, bad verifier and code
  replay rejection; granted subsets and no GitHub credentials in public tokens.
- Both SDK eras: tool/resource/prompt discovery, actual `get_connection`,
  `create_plan`, duplicate mutation receipts, plan resource reads and prompts;
  two persisted core draft mutations, no provider work or GitHub publication.
- Exact claim types/audience/resource/key binding, online validation on each
  invocation, proof hash/audience/freshness, `pia_mcp_` issuance and real atomic
  redemption; encrypted core storage, consumed-code denial and renewal of a
  stale stored GitHub credential after browser consent.
- Wrong signed instance/installation/key/scope/repository, wrong proof key/hash,
  untrusted resource hint, malformed/discrepant validation responses, online
  service outage, tunnel outage, version mismatch, core malformed-JSON response
  marking, and both SDKs' real notification/transport behavior.
- Current local membership removal, Connect membership removal, public and
  direct-to-core revocation denial, and non-revival after membership restoration,
  tunnel deletion/restoration or registration key replacement/restoration.
- Separate direct tests preserve independent OAuth/GitHub refresh, reject CIMD
  malformed arrays/preferences, support plural/legacy/omitted public-method
  metadata, and reject assertions, code-scope overrides and refresh escalation.
  The browser test selects read-only access and rejects forged consent escalation.

The first paired run exposed an additional real incompatibility: empty legacy
202 notifications lacked a content type and became an incompatible body stream
at the gateway. Core now marks them JSON; the final paired test passes unchanged
routing code. No routing implementation change is needed for this pinned gate.
The exact documentation follow-up for root to dispatch is recorded at the end
of [the contract](mcp-connect-contract.md).

This evidence is local integration, not Cloudflare runtime/deployment, real
GitHub login, live host OAuth, real provider/Docker execution, or complete chat
coverage. Routing's own Workers-runtime suite and root's independent full-chat
coverage review remain complementary gates. Site PR #90 still needs capability
reconciliation. Attempts to refresh current companion PR metadata with
`gh pr view 180 --repo integry/propr-routing --json number,state,headRefOid,url`
and the corresponding site PR #90 command returned **HTTP 401**; the linked PRs
and pinned routing commit came from the supplied request and local Git objects.
No production configuration was altered; no provider credits were spent; no
real target was merged; no new companion task, PR, commit or deployment was made.

## Full-chat follow-up verification and required CI

The public core repository's required `Build & Lint Check` → `Validate Changes`
job builds shared/core/CLI dependencies, installs Playwright Chromium, and runs
`test:mcp` and `test:mcp:browser`. These self-contained checks cover core OAuth,
policy/security, both SDK eras, workflow persistence, cancellation and command
identity, concurrency, and real TLS browser consent/revocation. Any failure
fails the existing required job; missing Chromium is a failure, not a skip.
They require no private checkout, extra token, or permission change.

**Core CI is not paired gateway coverage.** Actual cross-repository paired CI
belongs in the **private** routing repository (companion
[routing issue #186](https://github.com/integry/propr-routing/issues/186), delegated
separately by root). Its existing `GITHUB_TOKEN` can check out routing and the
public core commit. The private job must check out the exact core candidate SHA,
pass its routing candidate's full SHA as `MCP_ROUTING_REVISION`, and run core's
unchanged actual Worker/core harness with `MCP_ROUTING_REPOSITORY` pointing to
that authorized checkout. Do not upload its private source archive/bundle to
core or vendor routing implementation into this public repository.

Before merging either companion change, root must require passing **private
paired evidence for both exact candidate commits**, plus core's required checks
and hosted CodeQL on the system-generated core commit. A local paired pass or
core-only CI pass does not satisfy that private CI gate. This task does not
implement or claim completion of the separately delegated routing workflow.

Manual verification defaults to routing's merged implementation at
`1fcf82fd1a843fbdf199d79b8f92843dc74a89e0`. An explicit full lowercase 40-character
`MCP_ROUTING_REVISION` overrides it; abbreviations, refs, revision expressions,
missing objects and non-commit objects are rejected before extraction/install.
The harness verifies exact commit identity, disables Git replacement objects,
archives that commit locally, installs its own dependency lockfile and reports
`routingHead`, its lockfile SHA-256, `coreHead`, the core implementation digest
and SDK versions. The archive is temporary private runtime data, never a public
artifact. To refresh manual verification, fetch an authorized routing checkout,
select the reviewed full SHA, run the paired command and record both identities
and its result. Update the default pin only after merged routing evidence is
reviewed; private candidate CI must always pass its candidate explicitly.

For local paired verification:

```sh
npm run test:prepare
npm run test:mcp
MCP_ROUTING_REPOSITORY=/path/to/propr-routing npm run test:mcp:connect
npx playwright install --with-deps chromium
npm run test:mcp:browser
npm run build
npm run typecheck -w @propr/api
```

The new concurrency regression pauses an MCP adapter after loading its snapshot,
lets a second repository/agent mutation persist, then resumes the first and
verifies a conflict plus preservation of the second edit. Workflow regressions
keep the original task completed while the new task advances, exercise queue
uncertainty/failure, and persist posted reviews/F# findings before selecting and
observing a fix. No live agent credits, merges, deployments or permission changes
are part of these tests. Root still owns independent verification and merge.

Historical local verification of the preceding follow-up (2026-09-10): 13 MCP tests,
the paired Connect scenario and Chromium consent test passed without skips;
288 fast unit tests and eight related configuration/review/authorization test
files passed. Full build, API typecheck, changed-code ESLint and workflow
`actionlint` passed. The previous CI correction at `420aad1bf` and Connect
implementation at `6147abc9b` are the base of this worktree. The CodeQL workflow is unchanged; its hosted result must be checked on the system’s
resulting commit (the CodeQL CLI is not installed in this implementation image).


## Cancellation and security follow-up (2026-09-11)

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

These edits start from core `c6b5ee96a6bce023b8d680ff937b534dc08b7330` and preserve
its queued review/fix/ultrafix command-identity regressions. Hosted alert #126
inspection returned HTTP 403 (`Resource not accessible by integration`) in this
implementation environment, and the CodeQL CLI is unavailable. Consequently no
hosted CodeQL pass is claimed: inspect the normal CodeQL workflow and alerts
#126/#127 on the resulting system-generated commit before merge. No commit,
merge, deployment, added credential, or companion task was created here.


Local validation of this working tree: 14 MCP tests, two browser/security tests,
26 planner lifecycle/abort/proxy-limit tests, dependency builds, full TypeScript
build, API typecheck, changed-file ESLint and workflow actionlint passed without
skips. The actual paired harness passed both with the default merged routing
SHA and with explicit `MCP_ROUTING_REVISION=0c8ca02044c88b181395ca8e15425c0821e588e4`
(the previously reviewed routing PR head), demonstrating candidate selection.
These are local results on uncommitted core changes; the paired runner reports
the base `coreHead` plus an implementation digest. They are not hosted CI results
for the future system-generated commit.


## Operator surface reconciliation (2026-09-25)

The rows above were re-read against `packages/api/mcp/` on the epic branch rather
than against any earlier specification: every tool name, argument, resource URI
and prompt named here exists in `tools.ts`, `toolsActivity.ts`,
`toolsPullRequests.ts`, `goalTaskDetail.ts`, `pullRequestInventory.ts`,
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
  starts a slash command with `USE_EXPLICIT_TOOL`, so scope and head
  preconditions are always checked by the dedicated command tool.
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

Local validation of this working tree:

```sh
npm run test:mcp
# 99 tests passed, 0 failed, 0 skipped (including the new end-to-end
# packages/api/test/mcpOperatorSurface.test.ts).

npm run typecheck -w @propr/api
npm run build
# Both passed.

npx eslint --config packages/api/eslint.config.js packages/api/test/mcpOperatorSurface.test.ts
# 0 errors, 0 warnings.
```

The new regression drives the real tool catalog, schemas, authorization,
persistence and access recording against in-memory SQLite with the repository's
existing migrations. The GitHub API, the configured repository list and the
agent registry are the only fixtures: no live GitHub, no provider credits, no
real merge, and no production configuration was changed. These are local
results, not hosted CI results for the resulting commit.
