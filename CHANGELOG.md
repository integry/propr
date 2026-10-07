# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-run spend caps**: a run whose estimated cost reaches its cap is now
  stopped while it executes, and its partial work is published like a
  timed-out run's. The cap comes from a per-task `maxCostUsd` (task
  submissions, MCP `create_task`, `propr issue implement --max-cost`), then
  `limits.max_cost_usd` in `.propr/workflow.yml`, then the new instance setting
  `default_max_cost_usd` (Settings, `propr setting update`, MCP
  `update_execution_settings`; empty or 0 = no cap). It covers implementations,
  PR follow-ups, `/fix`, ultrafix cycles and reviews. A malformed or negative
  value is ignored with a warning instead of capping runs at $0. Retries share
  the task's budget. A capped run ends with the new terminal reason
  `cost_cap_exceeded`, records a `budget.exceeded` timeline event, sends an
  Inbox notification and comments on the issue or PR. Task details, the task
  history API and `propr task get --json` show the cap, the spend and the
  percentage used. `LLM_COST_THRESHOLD_USD` still only raises high-cost alerts.
  The unused `AgentTankConfig` type was removed from `@propr/shared`.
- **Pull request templates**: an optional `.propr/pr-template.md`, read from
  the base-branch commit like `.propr/workflow.yml`, shapes the title and
  description of the pull requests ProPR opens. Its sections are `title`,
  `summary`, `run`, `commits`, `files_changed`, `prompt`,
  `review_guidelines`, `commands` and `trailer`. A present section replaces
  ProPR's default content, a whitespace-only section removes it, and an
  absent section keeps it. Sections use `{{placeholder}}` substitution only.
  Untrusted values (issue title, agent summary, commit subjects) are sanitized
  and their HTML is escaped. Without the file, ProPR adds the repository's
  GitHub pull request template under its summary and run block. This fallback
  is a per-repository option, enabled by default
  (`propr repo toggle --no-github-pr-template`, `githubPrTemplateFallback`).
  Templates also apply to continuation pull requests opened during
  publication and publication recovery. `propr init` scaffolds a commented
  example and the new `propr repo validate` reports unknown sections and
  placeholders. A template that cannot be read or rendered never fails a run:
  ProPR logs it, records it on the task timeline and uses the default
  description, which is unchanged when no template exists.
- **Agent stall and degenerate-output watchdog**: a running implementation agent
  (Claude, Codex, Antigravity, OpenCode or Vibe) that produces no output for
  `AGENT_STALL_TIMEOUT_MS` (10 minutes), or emits
  `AGENT_DEGENERATE_OUTPUT_LIMIT` (50) consecutive whitespace-only text deltas,
  is now stopped instead of holding its worker slot and repository capacity
  until the 24-hour execution timeout. A tool call that starts without
  streaming output gets the longer `AGENT_TOOL_STALL_TIMEOUT_MS` (30 minutes);
  tools that keep printing never trip it. Partial work is published like a
  timed-out run's, the task ends with the new `terminalReason` `stalled` or
  `degenerate_output`, the trip is written to the task timeline, the Inbox and
  the issue/PR comment explain the stop, and `GET /api/llm-metrics` counts
  trips per rule (`watchdogTrips`). The thresholds are instance settings
  (Settings → Automation → Agent watchdog, `propr setting update
  agent_stall_timeout_ms <ms>`, MCP `update_execution_settings`) that apply to
  the next run without a restart; `0` disables a rule and the environment
  variables are the defaults.
- **Push salvage and rejection diagnosis**: when the final push of an
  implementation run, PR follow-up, `/fix`, ultrafix cycle or merge-conflict
  job fails, ProPR no longer loses the agent's commits with the worktree. It
  retries once with a refreshed installation token, then pushes the commits to
  `refs/propr/rescue/<taskId>--<timestamp>` on the same remote, then writes a git bundle to
  `<DATA_DIR>/rescue/` (`PUSH_RESCUE_BUNDLE_DIR`), and finally keeps the
  worktree, recorded in `<DATA_DIR>/rescue-worktrees/` (`PUSH_RESCUE_WORKTREE_RECORD_DIR`)
  outside the checkout. The rejection is classified as
  `push_protection` (with GitHub's unblock URL verbatim),
  `ruleset_or_branch_protection`, `non_fast_forward`, `auth`, `network` or
  `unknown`, and the class, the salvage rung and the exact recovery command are
  shown on the task timeline, in `propr task get` (`pushFailure` in `--json`)
  and in the GitHub failure comment. The daemon deletes rescue refs and bundles
  older than `PUSH_RESCUE_RETENTION_DAYS` (default 14), aging rescue refs from
  the creation time in their name; rescue refs are never
  treated as task branches.
- **Managed agent in Linux desktop previews**: the Preview Runtime Images
  workflow has separate `prepare-agent` and `publish-agent` operations. They
  build the existing linux/amd64-only managed agent image from the exact `main`
  commit, run a smoke test that is offline and uses no credentials, and record
  immutable candidate evidence. They publish only `propr/agent:<full-SHA>`, and
  only after the existing protected runtime-publication approval. Desktop Linux
  Preview `stage-draft` now requires a digest-pinned `runtime_agent_image` from
  the same commit. It checks that image's architecture and source labels before
  packaging and embeds it in each package's launcher manifest, in
  `linux-preview.json` (schema 2) and in the checksums. A preview no longer
  ships the unpublished version-tagged agent. A digest-pinned agent now gets its
  local `propr/agent:latest` tag correctly. arm64 packages remain available, but
  the managed agent, and so agent tasks, are amd64 only.
  Image archive checksums are computed in fixed 8 MiB chunks instead of reading
  the whole archive into memory, which failed `prepare-agent` on the ~2.4 GB
  agent `docker save` archive with `File size ... is greater than 2 GiB`.
- **Complete bundled third-party notices**: `scripts/generate-notices.sh` now
  refuses to run without the root dependency tree installed at the
  `package-lock.json` pins, and refuses to replace `THIRD_PARTY_LICENSES.md`
  unless the result has the full `@anthropic-ai/claude-code` and
  `@anthropic-ai/sdk` license texts and a production inventory covering every
  direct dependency. Previously a clean checkout silently baked a notice without
  them into images. The preview app/UI and agent builds now run
  `npm ci --ignore-scripts` before building images.
- **Bounded goal waits**: MCP `wait_goal` and `propr goal wait <id>` wait, with
  a finite deadline, for a confirmed goal state (`completed`, `failed`,
  `cancelled`, `paused`, `terminal`) or a newly published `checkpoint` instead
  of polling. Waits read a durable, monotonic per-goal event journal that the
  database appends with each goal or checkpoint write, so a requested pause or
  cancellation, a finished child task or an idle agent never matches, and an
  opaque cursor lets a retry or reconnect resume without missing or repeating a
  transition. MCP requests block at most 30 seconds and return `timed_out` as an
  ordinary result; the CLI chains them until `--timeout` and exits `2` on
  timeout. A wait resumed past a finished goal's final event returns
  `unreachable` at once, and a wait over the per-user limit fails with
  `wait_limit`. Cancelling a wait, a disconnect or Ctrl-C never affects the goal.
- **Goal blockers**: goals that need you — a confirmed pause, or an explicit
  provider question or approval — now appear as durable, evidence-backed
  blockers in the goal console, the goal list, the dashboard's attention list,
  `get_goal` (`goal.attention`), the new MCP `list_goal_attention`,
  `get_current_activity` and `propr goal attention`. Each names its prompt or
  reason, when it was observed and the supported action that resolves it.
  A lone Codex App Server question is answered with the next goal input; approvals
  are reported but never approved by ProPR. Claude and Antigravity expose no
  structured question or approval signal, so only pauses are reported for them.
  `pendingInput.waitingForOperator` is now true for any open blocker, with
  `reason` set to `provider_question` or `provider_approval` alongside the
  existing `paused_awaiting_resume_or_input`.

- **Sequential MCP epics**: `implement_plan` now queues exactly the selected
  issues in publication order for `useEpic: true`, starts one model on the head,
  and advances durably after merge. Optional `epicAdvanceOn: "terminal"` also
  advances on closed/failed issues; the default records a `blockedReason` until
  a blocked head is fixed and merged. Pause/resume holds and releases the next
  issue, and worker reconciliation repairs missed advancement and dispatch.
  Results and plan/operation reads expose queue progress; receipts stay
  accepted until completion. `epicExecution: "parallel"` restores fan-out and
  multi-model comparisons, and still labels the epic PR once every issue is done.
  A head closed with its unmerged PR resumes when that PR is reopened and merged. Existing idempotency hashes are preserved. UI, CLI
  and API **Implement Epic** and non-epic auto-merge requests feed the same
  queue with `terminal` advancement, so a failed issue still continues the
  plan. Plans already running at upgrade have no queue; restart them from
  their next pending issue.
- **Review fix selection**: `/fix all` requests every pending merge blocker and
  optional suggestion. Review comments include a copyable `/fix F# S#` command
  containing their published records for editing an explicit selection.
- **Analytics timeframe**: one selector in the Analytics header scopes the
  activity, task status, repository and model sections to the last 24 hours,
  7 days, 30 days (default), 90 days, 12 months or all time. The choice is kept
  in the URL as `?period=`. `GET /api/stats/tasks`, `/api/stats/repositories`
  and `/api/stats/overview` accept the same optional `period` parameter and
  behave as before without it.
- **Analytics layout**: the page is one console instead of four cards: a
  totals band (tasks, success rate, tokens, spend) over a split pane with
  daily activity bars and repository performance on the left, and the
  per-model table (tasks, tokens, cost), task status and token consumption
  (input against output, spend per million tokens) on the right. Past days'
  activity bars are neutral slate and only today's is teal; the chart's scale
  carries a midline, and every day that has room is labelled under its bar
  (weekday over day for a week). Repository rows open the Tasks list filtered
  to that repository, a failure count opens its failed tasks, and model rows
  open the LLM log for that model. The toolbar shows the repository scope as a locked
  `All Repos`. `GET /api/stats/overview` adds `model_usage`, a per-model list
  of tasks, tokens and cost, and `usage.input_tokens` / `usage.output_tokens`.

### Fixed

- **Ultrafix recovers from red CI**: a loop paused on failing CI is no longer
  left stranded when a CI-failure follow-up, `/fix` or push retires its
  deferred review. Green `check_run` and `check_suite` events and polling
  reconciliation now wake it and schedule its next review under a new work
  epoch. The cycle limit, the goal and the `ultrafix` label still apply. A
  re-arm on a head that is still red keeps that head's single "waiting for CI"
  notice and its CI wait timeout. `check_suite` is now a supported webhook
  event. Check runs and suites whose payload lists no PRs are matched to open
  PRs by commit. That lookup is cached per commit for 60 seconds, so a push
  with many jobs costs one GitHub call. Because of the lookup, events GitHub
  sends without PR numbers, notably for fork PRs, now reach their PRs: an
  opted-in failed-CI follow-up can now fire for them, as it already could for
  `status` events. The retry sweep runs only in the API server.
- **Ultrafix no longer stalls on non-blocking checks**: Ultrafix review
  readiness now honours the repository's `nonBlockingChecks` patterns, so a
  failing or still-pending check such as `Validate unsigned *` no longer defers
  the next `/review` forever. Matching legacy commit statuses are excluded too,
  and `areAllChecksPassing` (Epic queue advance, auto-merge) applies the same
  per-context exclusion. When blocking CI defers a review, ProPR posts one PR
  comment naming the blocking checks; if CI has not settled within
  `ultrafix_ci_wait_timeout_ms` (default 2 hours, also
  `ULTRAFIX_CI_WAIT_TIMEOUT_MS`), the loop stops with "Ultrafix stopped" and the
  reason "CI did not settle". `start_ultrafix`/`run_ultrafix` operation receipts
  report the deferral and its blocking checks instead of `COMMAND_NOT_PICKED_UP`.

## [0.9.0] - 2026-09-29

Release preparation covering v0.8.15 through base commit `c2de30509`. This section
records delivered source changes; it does not announce published packages, images,
desktop installers or a release tag. See the [coverage audit](docs/release-0.9.0-audit.md).

### Added

- **Goals and native execution**: launch long-running objectives with Codex or
  Claude Code, follow their progress and artifacts, and send corrective inputs.
  Pause/resume/cancel controls and capability-aware input delivery preserve work
  across execution boundaries. Goal timelines show operator corrections verbatim.
- **New Task**: launch a single instruction against a repository without planning
  a multi-issue project. Repository and to-do shortcuts prefill the request; the
  resulting issue, task and pull request remain traceable.
- **Plan revision history**: inspect saved plan snapshots and restore a prior
  version. Refinement retains the complete plan; file-based generation validates
  every issue before accepting output, with guarded syntax repair when needed.
- **Inbox, PWA and Web Push**: install the web app, opt into browser notifications,
  choose personal categories and quiet hours, and suppress repository notifications
  without stopping automation. Inbox opens the relevant task, plan or goal and
  supports paging and synchronized dismissal.
- **Authenticated MCP**: administrators enable the server and bound its scopes;
  users consent to repositories and manage connected apps. Operator tools cover
  current/recent activity, goals and corrective inputs, plans, tasks, PRs and
  review control. Status filters and a payload-free administrative access log
  make activity easier to inspect. One-off MCP tasks support explicit Ultrafix
  and auto-merge options with the corresponding scopes.
- **Desktop application**: browser-approved pairing, saved accounts and instances,
  local setup, connection diagnostics, native menus and notifications, and separate
  application/runtime version displays. Linux/macOS packaging and Linux preview
  verification are present; distribution remains subject to the documented release
  gates, and Windows package validation remains paused.
- **Visual previews**: repository capture settings, GitHub attachments, optional
  Plus managed originals, task/goal galleries and zoomable image viewing. Private
  PR images use authenticated media access in web and desktop.
- **Synthetic pools**: virtual models route among direct agent/model members using
  priority tiers, usage limits, scheduling and failover.

### Changed

- **Navigation and dashboard**: The primary creation action follows the page: New Task by default,
  New Plan in Plans/Planner Studio and New Goal in Goals. Quick add to-do offers
  Add another after saving. Work and system navigation are grouped;
  Goals, repository settings and connected apps have revised layouts. The dashboard
  shows Needs attention, Happening now, Completed and Historical stats, with a
  repository filter, activity summaries and documentation-derived usage tips.
  Broader reporting lives in Analytics.
- **Live activity**: push-driven refresh, hidden-tab reconciliation, append-based
  logs, cached/coalesced reads and bounded output reduce polling and rendering work.
- **Review commands**: `/fix F20 S3 S5` can select findings and optional suggestions
  together; unknown or malformed identifiers reject the whole selection. `F#` and
  `S#` sequences persist independently per PR. Suggestions remain optional and do
  not extend Ultrafix or change score gates. Multiline instructions are preserved.
- **CI cancellation**: an opt-in repository setting cancels only explicitly selected
  workflows on the exact PR head being replaced. Interrupted/no-change follow-ups
  retain restart obligations; closed PR cleanup uses the same opt-in policy.
  Per-repository non-blocking check patterns keep selected checks from delaying
  ProPR automation while preserving their visible GitHub results.
- **Agent models**: Claude Opus 5.5 and Sonnet 5.5 join the catalog; Opus 5.5 is the
  default Claude model. Older models remain selectable behind the legacy fold.
  Claude Code is bundled at 2.1.284; agent configuration, runtime authentication
  and Agent Tank integration have been refreshed.
- **Voice briefings**: experimental and off by default; enable per account,
  instance and device in Settings.
- **Security and operations**: durable instance roles, scoped repository access,
  guarded agent runtimes and desktop network/credential boundaries; improved
  health signals, rootless CI worker routing and change-aware validation.

### Fixed

- Bounded SQLite lock retries and explicit transaction replay rules protect
  concurrent workers and goal heartbeat writes.
- Durable task reconciliation, worktree cleanup before lock release, follow-up
  retries, fork PR handling and merged-PR completion avoid lost or repeated work.
- Plan prompt autosave, full-plan refinement, title preservation and partial
  generation rejection prevent silent loss of planning content.
- Private preview diagnostics, notification cleanup, live logs, partial indexing
  retries, model-aware review concurrency and alias-aware usage pricing.

## [0.8.15] - 2026-08-15

ProPR 0.8.15 is the first public release.

### Added

- **Expanded coding-agent support**: added Antigravity Gemini 3.7 Flash High,
  Medium, and Low models with a pinned packaged CLI and strict no-fallback
  verification, plus an opt-in bundled ProPR orchestration skill for supported
  coding agents.
- **Connect Plus experience**: eligible Community Connect accounts can see and
  dismiss a privacy-safe capacity banner, and start the Connect Plus purchase
  path while preserving their authorized GitHub installation and billing choice.

### Changed

- **Validated public setup path**: documented Apple Silicon Docker Desktop,
  ProPR data-folder handoff, and safe CLI installation and management of the
  bundled Agent Skill.

### Fixed

- **Task stopping**: `propr task stop` sends one URL-encoded request to the
  supported task `/stop` endpoint and never uses the obsolete `/cancel` route.
- **Release hardening**: incorporated setup, migration, authentication, CLI
  validation, and Agent Tank reliability fixes validated for the public package.

## [0.8.14] - 2026-08-14

### Changed

- **Configurable live-E2E timeout**: model tasks can override the live-E2E
  timeout while retaining a bounded default when no override is configured.
- **Safe coding-agent installation guidance**: added a copyable,
  non-destructive setup prompt with human authorization gates and documented
  Node.js 22 and 24 as the validated CLI runtimes.
- **Packaged production defaults**: generated stacks set an explicit
  production runtime, publish API and UI ports on loopback by default, and
  wire browser-visible frontend and CORS origins.

### Fixed

- **Interrupted setup recovery**: fresh and migrated stacks without a durable
  administrator can safely resume `propr setup` after pre-authentication
  interruption.
- **CLI task stop compatibility**: `propr task stop` uses the canonical
  singular endpoint while the API continues accepting `cancel` as a
  compatibility alias.
- **CLI task deletion compatibility**: `propr task delete` uses the canonical
  endpoint while the API continues accepting the singular compatibility alias.
- **Hosted UI tunnel isolation**: tunnel authority is scoped per browser tab,
  popup OAuth uses the active managed tunnel, logout and navigation preserve
  the active flow, and copied, raw, or foreign authority is rejected.

### Security

- **UI dependency refresh**: updated the transitive `nanoid` resolution to
  3.3.18, addressing GHSA-2v37-7h3g-55p8 without upgrading `postcss`.

## [0.8.13] - 2026-08-13

### Fixed

- **Setup root persistence**: fresh `propr setup` runs retain the normalized
  stack root across later configuration saves, so rootless CLI commands target
  the configured stack from any working directory.

## [0.8.12] - 2026-08-12

### Changed

- **Guided setup defaults**: clean installs now use ProPR Connect and the
  default ProPR GitHub App, including guided GitHub login and App installation.

### Fixed

- **Local UI API routing**: production UI containers receive the browser-visible
  API origin, so local `/api/*` requests reach the backend instead of the static
  UI server.
- **Setup failure handling**: missing authentication, invalid intake settings,
  and unhealthy backend startup stop setup before dependent configuration or UI
  launch.
- **Connect authentication boundaries**: local login is limited to exact
  loopback callbacks while managed tunnels, custom OAuth Apps, and explicit
  operator modes retain their supported behavior.

## [0.8.11] - 2026-08-12

### Changed

- **Supported install contract**: release documentation now states the tested
  Linux `amd64` baseline, practical host sizing, Docker requirements, and
  Docker Hub as the canonical distribution registry.

### Fixed

- **Planner issue dispatch**: routing selectors are applied before the `AI`
  trigger label, preventing one planned issue from starting both on `main` and
  on its generated epic branch.
- **CLI read reliability**: transient transport failures on idempotent API
  reads retry briefly without retrying mutations or HTTP error responses.

## [0.8.10] - 2026-08-12

### Fixed

- **Resumable image publication**: partial Docker Hub releases preserve the
  first commit-scoped artifact and complete missing immutable tags safely even
  when a later rebuild produces a different digest.
- **Ultrafix deferred actions**: API continuation sweeps initialize the issue
  queue before checking conflicts or enqueueing the next review/fix action.
- **Source Compose compatibility**: backend development and legacy production
  images use Node 22, matching ProPR's declared runtime requirement.

## [0.8.9] - 2026-08-12

### Changed

- **Adaptive agent resources**: default container CPU limits now scale to the
  detected host capacity while preserving explicit operator overrides.

### Fixed

- **First-run repository activation**: repositories selected in setup or
  Settings load without a legacy config repository, reload live, and filter
  routed events before processing begins.
- **Retryable issue failures**: failed or zero-change interrupted agent runs no
  longer create empty pull requests or receive a misleading done label.
- **Review container reliability**: retries and concurrent review commands use
  unique Docker container names while preserving task ownership labels.
- **Release retries**: Docker Hub publication and npm artifact reconciliation
  are deterministic and safely resumable after partial workflow failures.

## [0.8.8] - 2026-08-11

### Added

- **Managed Connect login**: hosted tunnel instances can authenticate through
  the shared ProPR GitHub App without requiring users to create a separate
  OAuth App, while preserving verified GitHub identity and redirect state.
- **Guided agent validation**: setup prepares safe credential mounts, checks
  selected agents from the worker image, and prints exact login/recovery
  commands when an agent is not ready.

### Changed

- **Issue-driven Ultrafix**: an exact `ultrafix` label on a source issue now
  starts Ultrafix automatically on its generated implementation PR.

### Fixed

- **Agent and E2E reliability**: bundled runtimes remain executable,
  Antigravity initializes disposable state correctly, model-task failures are
  surfaced, and configured task coverage is tracked deterministically.
- **Review correctness**: emphasized scores are accepted and incomplete diff
  coverage fails closed instead of producing an overconfident review.
- **Safe runtime paths and logs**: model IDs cannot escape generated worktree
  paths, credentials are redacted from worktree diagnostics, and setup rejects
  unsafe agent credential mount paths before creating directories.
- **Deployment defaults**: Compose Redis ports remain bound to loopback rather
  than being exposed on public interfaces.
- **Release validation**: workspace dependencies are built before package
  typechecks, and agent runner code satisfies the release's zero-warning gate.

## [0.8.7] - 2026-08-09

### Added

- **Release validation**: pull requests and nightly runs now exercise the
  complete server/UI suite on Node.js 22 with isolated Redis, while release
  metadata discovery automatically includes publishable `@propr/*` workspaces.
- **Per-agent Web login**: adding Claude, Codex, Antigravity, or OpenCode can
  now create and authenticate an isolated account directly, without entering a
  host path. Managed credentials live below ProPR's credential root and allow
  multiple accounts from the same provider; existing host config remains an
  explicit alternative.
- **Review and PR decomposition workflows**: `/split` can create an authorized,
  idempotent PR-splitting operation, while model-aware context scouting enriches
  reviews within a configurable context budget and can be disabled per instance.
- **Instance administration**: explicit administrator roles separate privileged
  instance management from ordinary authenticated access.
- **Documentation**: security overview (trust boundaries, isolation, network
  surface, user-whitelist gating), evaluator FAQ, glossary, consolidated
  configuration reference (shipped vs code defaults), and a symptom-organized
  troubleshooting guide; intro gains a "First 15 Minutes" panel and the
  hosted-UI-tunnel docs are canonicalized to the deployment guide.

### Changed

- **Notification API contract (0.8.6)**: Push eligibility is opt-in at both the
  user-preference and producer-assignment layers; object-form recipients now
  require an explicit `pushEnabled` boolean. Synthesized preference entries use
  `updatedAt: null`, while persisted entries retain an ISO-8601 timestamp.
  Downstream `@propr/shared` consumers should handle the nullable timestamp when
  adopting the new notification API. No notification UI or production event
  producer existed in this repository to migrate.
- **Focused AI reviews**: reviews now evaluate the stated PR scope, keep
  suggestions separate from `/fix`, assign durable incremental finding IDs,
  explain blockers and suggestions in human-readable sections, and acknowledge
  implementation strengths without inflating the score.
- **Scope-safe Ultrafix cycles**: follow-up reviews and fixes retain the original
  PR objective, consume only current actionable findings, and preserve command
  ownership when comments are batched or superseded.

### Fixed

- **Fail-closed runtime safety**: webhook and merge checks require verified
  signals, configuration writes reconcile post-commit failures, and planner
  cancellation/live progress are isolated by generation run ID.
- **Task lifecycle ownership**: revision-ordered socket updates, fenced Docker
  execution and teardown, stale-task reconciliation, and reliable PR-comment
  finalization prevent older work from overwriting or terminating newer work.
- **Ultrafix orchestration**: CI readiness is action-aware (failed checks may be
  fixed, while reviews wait for a settled exact head); manual commands cancel
  superseded automatic jobs; fresh-loop startup, label teardown, terminal side
  effects, and deferred work are protected by renewable ownership and epochs.
- **Release and agent reliability**: nightly model coverage is deterministically
  bounded, immutable artifacts are preflighted, production image smoke coverage
  is restored, failed unified-agent image builds recover cleanly, and remote
  downloads plus Antigravity release artifacts are verified and pinned.
- **Event delivery and CI reporting**: routing WebSocket health requires an
  application heartbeat, direct webhook traffic is rate-limited, and CI creates
  a fresh failure comment only when a check actually fails.
- **Web UI**: dead `/agents` link in the no-models helper (now `/ai-agents`)
  plus a catch-all 404 route; "Planner Studio" tab title; Agent Tank banner
  reframed to rate-limit capacity; human-readable API error messages;
  actionable empty states; contextual docs links from Settings.
- **Docs/config drift**: `.env.example` tunnel hostnames updated to
  `t-<id>.propr.dev`; Node.js 22+ requirement stated consistently; stale
  OpenCode `CLI_VERSION` and `WORKER_CONCURRENCY` default corrected.
- **Agent login reliability**: normalize managed credential ownership, remove
  stack-scoped orphan login containers on startup, pull missing agent images,
  preserve split terminal escape sequences, accept agent aliases consistently,
  renew active sessions, and harden dialog lifecycle and keyboard behavior.

### Security

- The production API now mounts the Docker socket to create short-lived,
  authenticated agent-login containers. Docker-socket access is root-equivalent
  host access; deployment and security documentation now call out this trust
  boundary explicitly.
- OAuth state is validated, strong session secrets are mandatory, WebSocket
  subscriptions are authenticated, public API and webhook routes are
  rate-limited, and direct API runs bind to loopback by default.
- Untrusted input parsing and repository filesystem paths are bounded and
  contained; subprocesses execute without a shell; failed uploads are cleaned
  up; agent containers receive explicit resource limits; and local CLI state is
  created with private permissions.
- CodeQL and dependency-review gates now run in CI, preview checkouts are pinned,
  vulnerable transitive dependencies were refreshed, and a security policy was
  added.

## [0.8.5] - 2026-06-30

### Added

- **Hosted UI tunnel (ProPR Connect)**: optional CLI-managed `cloudflared`
  sidecar that exposes a local stack to the hosted UI at `app.propr.dev` through
  a per-instance `https://t-<id>.propr.dev` proxy. Includes shared tunnel
  constants, `propr tunnel on|off|verify`, tunnel diagnostics in `propr status`
  (and `--json`), runtime-configurable UI API base URL, and `.env.example`
  guidance. The tunnel only routes `/api/*` and `/socket.io/*`; the proxy root
  intentionally returns 404. See the hosted UI tunnel docs for setup.
- **`/api/compatibility` endpoint**: a new, intentionally unauthenticated API
  route that returns non-sensitive build metadata (`version`,
  `apiCompatibility`, `uiCompatibility`) so the hosted UI can detect an
  incompatible local stack before login. It exposes no user or repository data;
  operators evaluating their unauthenticated API surface should note that the
  exact release version is now readable pre-auth.

### Changed

- **Explicit routing delivery acknowledgements**: the routing WebSocket intake
  service now ACKs each forwarded GitHub delivery with an authoritative
  `status` (`accepted`, `blocked`, or `ignored`), plus an optional `reason`
  (e.g. `unsupported_event`, `user_not_allowed`, `limit_reached`) and `billing`
  metadata. The webhook dispatcher may return a disposition to drive this;
  returning nothing is treated as a plain `accepted`. ProPR remains the only
  source of truth for repo/user policy; the relay forwards every eligible-looking
  trigger and records the result. See the ProPR Connect docs for the delivery
  acknowledgement contract.
- `propr check --json` remains machine-readable but now reports the additional
  check rows introduced by the grouped check output, including CLI version and
  configured agent validation rows.
- `propr start` now verifies ProPR-published service image freshness and may
  pull a stale local tag before starting; use `PROPR_SKIP_REMOTE_IMAGE_CHECK=1`
  to skip registry probes in offline or latency-sensitive environments.
- **CORS scheme hardening**: the shared CORS origin validator now only trusts
  `http:`/`https:` origins on its cookie-domain and localhost branches, so an
  unusual scheme (e.g. `file:`, `chrome-extension:`) on a cookie-domain
  subdomain or on `localhost`/`127.0.0.1` is no longer allowed. `http:` is
  deliberately still accepted for cookie-domain subdomains so existing
  `http://<sub>.<cookie-domain>` PR-preview environments keep working — the
  tunnel work does not change that. Local development and explicit `FRONTEND_URL`
  origins are unaffected.
- **Enqueue failures now propagate from `processDetectedIssue`**: a failure to
  add an issue to the work queue is re-thrown instead of being swallowed, so the
  routing intake path withholds the ACK and the delivery is redelivered. All
  callers handle this: the polling loop catches it per-repository and continues
  to the next cycle, and the direct-webhook handler awaits the processor before
  ACKing so a throw returns HTTP 500 (GitHub then redelivers).

## [0.8.3] - 2026-06-16

### Added

- **OpenCode agent**: first-class support for the OpenCode CLI runtime — Docker
  image and entrypoint, runtime adapter, agent registry registration, frontend
  configuration, ProPR CLI command, model-alias and GitHub-label resolution,
  live-details/task-stream parsing, and dynamic model discovery.
- **Vibe (Mistral) agent**: new Mistral-backed agent with API-key configuration,
  shared-agent registry entry, runtime adapter, and Vibe branding.
- **CLI control plane**: manage the local Docker stack and relay GitHub tokens
  from the `@propr/cli` package; CLI-driven setup is now the primary path.
- **User whitelist gating**: dashboard/CLI access and issue-label triggers can be
  restricted to a configured set of users.
- **Background GitHub session refresh**: expired GitHub session tokens are now
  refreshed in the background (resolves the logout redirect loop).
- **Summarization fallback**: configurable fallback model with quota-aware retry
  so repository indexing survives provider rate limits and outages.
- **Claude Fable 5** model support.
- **Offline full-text documentation search**.
- Extensive documentation: Web UI Guide, Agent Tank usage-tracking guide,
  Secure VPS Deployment tutorial (with optional Cloudflare Zero Trust layer),
  Repository Best Practices guide, CLI control-plane docs, and a rebuilt docs
  home page.

### Changed

- **Renamed the Gemini agent integration to Antigravity** across runtime, Docker
  images, entrypoints, credentials, parsers, model IDs, and documentation; added
  support for the Antigravity CLI runtime.
- Modernized the header system-status menu and compacted the Settings page into
  horizontal rows with numeric inputs.
- Cleaned up dashboard stats tables and humanized model names.
- Codex planner now caps and budgets prompt/context size using the usable input
  window, with priority-based context packing and reduced metadata overhead.
- Epic chains now require a child PR merge before starting the next issue.
- Docker Hub metadata is synced on release (non-blocking).
- Documentation defaults to Claude Opus 4.8 in examples and gives the CLI equal
  footing in setup tutorials.

### Fixed

- Summarization: stop prompt-too-long failures masquerading as parse errors;
  improve fallback parsing and reliability; scope batch limits by model.
- Indexing: recover from partial summarization failures without a full reindex;
  dedupe prioritized jobs; refresh summarization config between batches; cap
  repository summary batch size/file count; skip generated capture artifacts.
- Pricing: correct OpenRouter slugs for `gemini-3.1-pro`, `nemotron-3-ultra`, and
  native `opencode-go/*` models.
- Antigravity: deliver prompts via stdin to avoid `E2BIG`, use CLI display names
  for `--model`, estimate implementation tokens from the full transcript, and
  fix token usage / log filtering.
- Vibe: numerous runtime fixes for live-log streaming, transcript parsing,
  credential loading, container permissions, and token/cost reporting.
- TaskWatcher: fix `EMFILE` error by switching to polling.
- Metrics: stop infinite task-analysis recursion in the analysis processor.
- Fix default GitHub bot username and use the ProPR app bot for system commits.

[Unreleased]: https://github.com/integry/propr/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/integry/propr/compare/v0.8.15...v0.9.0
[0.8.15]: https://github.com/integry/propr/compare/v0.8.14...v0.8.15
[0.8.14]: https://github.com/integry/propr/compare/v0.8.13...v0.8.14
[0.8.13]: https://github.com/integry/propr/releases/tag/v0.8.13
[0.8.12]: https://github.com/integry/propr/releases/tag/v0.8.12
[0.8.11]: https://github.com/integry/propr/releases/tag/v0.8.11
[0.8.10]: https://github.com/integry/propr/releases/tag/v0.8.10
[0.8.9]: https://github.com/integry/propr/releases/tag/v0.8.9
[0.8.8]: https://github.com/integry/propr/releases/tag/v0.8.8
[0.8.7]: https://github.com/integry/propr/releases/tag/v0.8.7
[0.8.5]: https://github.com/integry/propr/releases/tag/v0.8.5
[0.8.3]: https://github.com/integry/propr/releases/tag/v0.8.3
[0.8.2]: https://github.com/integry/propr/releases/tag/v0.8.2
