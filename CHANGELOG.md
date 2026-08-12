# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.8.11]: https://github.com/integry/propr/releases/tag/v0.8.11
[0.8.10]: https://github.com/integry/propr/releases/tag/v0.8.10
[0.8.9]: https://github.com/integry/propr/releases/tag/v0.8.9
[0.8.8]: https://github.com/integry/propr/releases/tag/v0.8.8
[0.8.7]: https://github.com/integry/propr/releases/tag/v0.8.7
[0.8.5]: https://github.com/integry/propr/releases/tag/v0.8.5
[0.8.3]: https://github.com/integry/propr/releases/tag/v0.8.3
[0.8.2]: https://github.com/integry/propr/releases/tag/v0.8.2
