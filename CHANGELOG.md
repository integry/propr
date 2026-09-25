# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cancel CI while follow-up implementation is in progress**: a new per-repository
  option (Repositories → Automation, off by default, also available through
  `POST /api/config/repos`) cancels the queued and running GitHub Actions
  validation of the exact pull request head a follow-up is about to replace, once
  that follow-up is authorized and actually implementing. Eligibility is never
  inferred: only the workflows an operator selected next to the option — by file
  name, path, display name or numeric workflow ID, matched exactly — are ever
  cancelled, so a workflow that deploys under a name like `Build` or `CI` keeps
  running, and an empty selection leaves the decision to the documented
  environment fallback, which the settings screen discloses. A selection that
  cannot be read at all is not an empty one: nothing is cancelled for that
  repository until it can be read again. Instances
  configured outside the Web UI can set `CANCEL_CI_FOLLOWUP_WORKFLOWS` as a
  fallback for repositories with no selection of their own. Runs of other pull
  requests and other revisions are never touched. Each run is recorded before its
  cancel request is sent, so a crash or a lost response cannot leave CI cancelled
  without a restart obligation, and neither a denied retry nor a refused restart
  discards an obligation: a refused or repeatedly failing restart keeps its runs
  recorded until the restart is confirmed, the pull request closes or the head is
  obsolete. Starting, sweeping, restoring and releasing one pull
  request all run under a shared database lease, so workers cannot interleave and
  no run is cancelled after its restart began. A replacement commit gets its
  normal CI; a run that ends without one has its cancelled checks restarted for
  the still-current head, including after a worker restart. Requires the GitHub
  App installation to have Actions "Read and write"; without it the option is
  inert and logged.
- **Claude Opus 5.5**: added to the Claude model catalog (`llm-claude-opus55`, 1M
  context) and made the default Claude model and the target of the plain `opus`
  alias. The bundled Claude Code CLI moves to 2.1.280, which is the first release
  that serves Opus 5.5. Claude agents still defaulting to Opus 5 are migrated to
  Opus 5.5 on startup; deliberate picks in other tiers are left alone.
- **Per-repository notifications**: Repositories → Settings now has a
  **Notifications** toggle that stops Inbox and push notifications for plan, task,
  review, pull request, and indexing activity in that repository while automation
  keeps running. The setting is on by default, shared by every branch entry of the
  repository, and available through `POST /api/config/repos`, the MCP
  `update_repository_configuration` tool, and `propr repo add|toggle
  --no-notifications`. System-health notifications are unaffected, and existing
  notifications stay in the Inbox.

### Changed

- **Rebuilt dashboard**: the home page now answers "what needs my attention right
  now" in five sections — a summary strip of four clickable counts, **Needs
  attention**, **Happening now**, **Recent outcomes**, and **Historical stats** —
  with live work taking the main column. A single repository filter applies to every
  section and is kept in the URL, ordering stays stable while tasks run, and a
  dropped socket keeps the last known rows on screen under a
  "Reconnecting · Last updated …" line. Unavailable data renders as "—" rather than
  as zero, and cost is labelled **Recorded spend**. The Repository Breakdown, Top
  Models, activity and status-distribution charts moved to a new **Analytics**
  page (`/analytics`).

  The page is laid out as a split-pane console following the Studio guidelines
  rather than as cards on a tinted background. No section draws its own box: the
  two columns are separated by one continuous vertical rule that runs the full
  height of the canvas, sub-sections are separated by edge-to-edge horizontal
  rules, and every pane header shares one height so the rules in the two columns
  land on the same pixel. The summary counts sit in a 40px sub-toolbar anchored
  above the panes. Repository slugs and issue/PR references are monospace code
  chips that always name their entity type (`Issue #118`, `PR #2481`); a
  recorded quality score uses the fixed-width pill (`[ ● 9 ]`) with the
  out-of-ten scale announced rather than printed; each attention item carries a
  single fixed-width verb (`Open`, `Review`) so the action column has one left
  edge; and colour is reserved for work in progress, blockers and failures —
  completed and merged work is neutral, and the historical chart greys out every
  settled day.

- **Voice Briefings are opt-in everywhere**: the experimental feature is now off by
  default in the browser, the installed PWA, and the desktop app. Enable
  **Voice briefings · Experimental** in Settings (under *Integrations* for
  administrators, in personal settings for members) to show the launcher. While it is
  off, no voice entry point renders, no `/api/voice/*` request is issued, and no
  speech or microphone API is touched. Browser and PWA users who used Voice Briefings
  before this release must opt in once per account, instance, and device; existing
  desktop opt-ins are preserved.
- **Claude Opus 5 and Opus 4.8 are legacy models**: both now sit behind the
  *Show legacy models* fold on Coding Agents, leaving Opus 5.5, Fable 5.1, and
  Sonnet 5 in the Claude agent's current list, and neither is offered as a
  recommended model for plan generation or PR review. They remain fully
  selectable, and agents already configured with them keep running them.

### Fixed

- **"database is locked" errors**: a query that raced another process for
  SQLite's write lock failed the whole operation — a running goal could die on a
  heartbeat update. Every query on the shared database now waits on an
  asynchronous timer and retries with jittered backoff while the lock is held,
  including statements inside transactions. Transactions open with
  `BEGIN IMMEDIATE`, so the race for the write lock is settled by a replayable
  statement before the transaction callback runs; a callback itself is replayed
  only when the caller declares it safe with `replayableTransaction()`, because a
  rollback undoes its SQL and not its other effects. Retrying is bounded by a
  wall-clock budget that caps the backoff, the driver's own blocking wait and any
  retry nested inside a retried transaction, so a query can still not take longer
  than SQLite's own `busy_timeout`. Each attempt blocks for at most its share of
  that budget, so a lock held for the full timeout is retried rather than
  spending the budget on one blocked attempt. Tune with `SQLITE_RETRY_MAX_ATTEMPTS`,
  `SQLITE_RETRY_BASE_DELAY_MS`, `SQLITE_RETRY_MAX_DELAY_MS`,
  `SQLITE_RETRY_MAX_TOTAL_MS`, `SQLITE_RETRY_IMMEDIATE_TRANSACTIONS=0`, and
  `SQLITE_RETRY_TRANSACTIONS=1`.

- **Cost for alias-configured agents**: an agent whose model is stored as an alias
  (`fable`, `fable51`, `opus55`, ...) priced its runs against OpenRouter's generic
  rates instead of the provider's published API rates, because the pricing lookup
  only matched canonical model IDs. The lookup now resolves aliases first, so a
  Fable 5 or Fable 5.1 run is costed at the Fable rates ($10/$50 per MTok, with
  Fable 5.1's $0.25/MTok cache reads) however the model was named.

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
