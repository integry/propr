# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Hosted UI tunnel (ProPR Connect)**: optional CLI-managed `cloudflared`
  sidecar that exposes a local stack to the hosted UI at `app.propr.dev` through
  a per-instance `https://<id>.proxy.propr.dev` proxy. Includes shared tunnel
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

[0.8.3]: https://github.com/integry/propr/releases/tag/v0.8.3
[0.8.2]: https://github.com/integry/propr/releases/tag/v0.8.2
