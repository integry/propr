---
sidebar_position: 10
title: Configuration Reference
---

ProPR reads its configuration from the `.env` file in the stack root — the directory you run `propr` from. `propr setup`, `propr relay enroll`, and `propr tunnel setup` write most of these values for you; this page is the reference for reading or hand-editing the file. Where the value shipped in `.env.example` differs from the fallback the code uses when a variable is unset, both are shown.

Deep dives live elsewhere: [Production Deployment](./deployment.md), [GitHub Authentication](./github-auth.md), [Worker Runtime](../architecture/worker-runtime.md), and [Agent Tank](./agent-tank.md).

## Core & GitHub Auth

The backend authenticates to GitHub in one of three modes — `demo`, `relay`, or `app` — inferred from the environment (precedence: demo → relay → app). See [GitHub Authentication](./github-auth.md) for how to choose.

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `GH_AUTH_MODE` | Unset (mode is inferred) | Forces the auth mode: `app`, `relay`, or `demo`. Relay is inferred automatically when `PROPR_GH_RELAY_URL` + `PROPR_GH_RELAY_TOKEN` are set. | Rarely — only to override inference. |
| `PROPR_GH_RELAY_URL` | Hosted relay `https://webhook.propr.dev/v1` when unset | Token relay URL, including the version prefix (`https://`; `http` only for localhost). | Self-hosted relay only. |
| `PROPR_GH_RELAY_TOKEN` | Unset | Durable relay credential issued for your install. `propr relay enroll` writes it. | Relay mode. |
| `GH_INSTALLATION_ID` | Unset | Which GitHub App installation ProPR acts on. | Relay and app modes. |
| `GH_APP_ID` | Unset | Your own GitHub App's numeric id. | App mode (own GitHub App). |
| `GH_PRIVATE_KEY_PATH` | Unset | Path to your App's private key (`.pem`). | App mode. |
| `HOST_GH_PRIVATE_KEY` | Unset | Absolute host path to the `.pem`. The CLI/launcher bind-mounts it read-only into the app containers and overrides `GH_PRIVATE_KEY_PATH`, so the key can live anywhere on the host. No `~`. | App mode via the `propr` CLI or launcher. |
| `GH_OAUTH_CLIENT_ID` / `GH_OAUTH_CLIENT_SECRET` | Placeholders | GitHub OAuth App credentials for Web UI login. | Always, for UI login. |
| `GH_OAUTH_CALLBACK_URL` | Derived: `<API host>/api/auth/github/callback` | OAuth callback served by the API. Leave commented so tunnel-mode derivation wins; an active localhost value is used as-is even in tunnel mode. Register the URL — derived or explicit — in your GitHub OAuth App. | Override only. |
| `SESSION_SECRET` | Placeholder | Signs browser session cookies. | Always. |
| `ENABLE_BEARER_AUTH` | `true` (any value except `false` enables it) | Bearer token auth for the CLI. Set `false` to allow session login only. | Optional. |
| `PROPR_DEMO_MODE` | `false` | `true`/`1` allows read-only access without GitHub OAuth and blocks all mutating API requests. Use a curated config/database for public demos. | Demo deployments. |
| `DASHBOARD_API_PORT` | `4000` | Host port the dashboard API is published on. | Optional. |
| `FRONTEND_URL` | `http://localhost:5173` when unset | Browser origin for CORS and auth redirects. In hosted UI tunnel mode it is derived as `https://app.propr.dev` — leave it commented so derivation wins. | Custom origin only. |
| `API_PUBLIC_URL` | `http://localhost:4000` when unset | Public URL the API is reached at (auth redirects, attachment links, cookie security). Derived to the `t-<id>.propr.dev` host in tunnel mode. | Custom deployments; derived in tunnel mode. |
| `COOKIE_DOMAIN` | Unset | Session cookie domain. Leave unset — including for tunnel proxy sessions, which run host-only on a single `t-<id>.propr.dev` host. | Custom multi-subdomain deployments only. |
| `AUTH_REDIRECT_ALLOWED_HOSTS` | Unset | Comma-separated extra redirect hosts for auth preview flows. Entries are exact-match unless prefixed with `.` or `*.` for trusted parent domains. | Preview auth flows. |
| `LOG_LEVEL` | `info` | Log verbosity across services. | Optional. |
| `NODE_ENV` | `development` | Node environment; use `production` on servers. | Optional. |
| `DB_FILENAME` | `./data/propr.sqlite` | Path to the SQLite database file (created if it doesn't exist). | Optional. |

## Event Intake

How ProPR receives GitHub events, plus what it watches for once they arrive. Allowed intake modes: `routing_websocket` (default), `polling`, `direct_webhook`. New installs use the hosted ProPR GitHub App over the routing WebSocket; polling and direct webhook are advanced opt-ins, and direct webhook requires your own GitHub App plus a public `/webhook` URL.

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `GITHUB_EVENT_INTAKE_MODE` | `routing_websocket` | Selects the intake path: `routing_websocket`, `polling`, or `direct_webhook`. Unset also means `routing_websocket`. | Set explicitly to keep polling/webhook behavior on installs that run their own GitHub App. |
| `PROPR_ROUTING_URL` | Hosted `wss://webhook.propr.dev` when unset | Routing WebSocket origin (`wss://`; `ws://` only for localhost). | Self-hosted relay only. |
| `PROPR_ROUTING_WS_PING_INTERVAL_MS` | `300000` (5 minutes) | Transport keepalive interval. Lower it only if a network path closes otherwise-healthy WebSockets. | Optional. |
| `PROPR_ROUTING_WS_PONG_TIMEOUT_MS` | `30000` (30 seconds) | Maximum wait for a transport pong before the stale socket is terminated and reconnected. | Optional. |
| `POLLING_INTERVAL_MS` | `60000` | Poll period when pulling events from the GitHub API. | Polling mode only. |
| `GH_WEBHOOK_SECRET` | Unset | Shared secret GitHub signs webhook deliveries with. | Direct webhook mode. |
| `GITHUB_REPOS_TO_MONITOR` | Placeholder (`owner/repo1,owner/repo2`) | Comma-separated repositories the daemon watches. | Always. |
| `CONFIG_REPO` | Example config repo URL | Git repository for dynamic repository management; when set, processing labels and repo config load from it. | Optional. |
| `PRIMARY_PROCESSING_LABELS` | Shipped `AI,propr` / code falls back to `AI` | Issue labels that trigger processing. | Optional. |
| `PR_LABEL` | `propr` | Label applied to PRs ProPR creates. | Optional. |
| `GITHUB_BOT_USERNAME` | Placeholder / code falls back to `propr-dev[bot]` | The bot identity, used to filter its own comments out of triggers. | Optional. |
| `GITHUB_USER_WHITELIST` / `GITHUB_USER_BLACKLIST` | Empty | Comma-separated allow/deny lists for who can trigger processing. | Optional. |
| `PROPR_ADMIN_USERS` | Empty | Comma-separated authenticated GitHub usernames allowed to change installation-level agent runtime packages. Empty denies changes unless `PROPR_AGENT_RUNTIME_ADMIN_ANY_USER=true` is set. | Optional. |
| `PROPR_AGENT_RUNTIME_ADMIN_ANY_USER` | `false` | Explicit opt-in that lets any authenticated ProPR user change installation-level agent runtime packages when `PROPR_ADMIN_USERS` is empty. | Optional. |
| `PR_FOLLOWUP_TRIGGER_KEYWORDS` | `!propr` | Keywords in PR comments that trigger follow-up work. See [PR Follow-up](../features/pr-followup.md). | Optional. |
| `LABEL_APPLIER_TIMELINE_MAX_PAGES` | `5` | With a whitelist set, polling resolves who applied the trigger label from the issue timeline (page 1 + the most recent N pages). Raise it if long-lived issues are skipped with "Could not determine label applier". | Optional. |

## Agents & Timeouts

Unified image selection, per-agent credential paths, and execution limits. `ANTIGRAVITY_TIMEOUT_MS` and `CLAUDE_MAX_TURNS` are the two places the shipped value and the code fallback diverge most — deleting the line does not restore the shipped behavior.

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `AGENT_DOCKER_IMAGE` | `propr/agent:latest` | Optional unified image override used when no agents are configured. | Optional. |
| `CLAUDE_CONFIG_PATH` | Empty | Absolute path to your `~/.claude` directory. `~` and `${HOME}` are **not** expanded in `.env` files or Docker bind mounts. | Running Claude Code. |
| `CLAUDE_MAX_TURNS` | Shipped `10` / code falls back to `1000` if unset | Maximum agent turns per Claude run. | Optional. |
| `CLAUDE_TIMEOUT_MS` | `300000` | Claude run timeout. | Optional. |
| `CODEX_TIMEOUT_MS` | `3600000` | Codex run timeout. | Optional. |
| `ANTIGRAVITY_TIMEOUT_MS` | Shipped `300000` / code falls back to `3600000` if unset | Antigravity run timeout. | Optional. |
| `OPENCODE_TIMEOUT_MS` | `3600000` | OpenCode run timeout. | Optional. |
| `VIBE_MAX_TURNS` | `1000` | Maximum agent turns per Vibe run. | Optional. |
| `VIBE_TIMEOUT_MS` | `3600000` | Vibe run timeout. | Optional. |
| `VIBE_CONFIG_PATH` | Unset | Absolute path to your `~/.vibe` directory (no `~`). | Running a Vibe agent. |
| `MISTRAL_API_KEY` | Unset | Vibe credentials fallback when `VIBE_CONFIG_PATH` does not provide them. | Vibe without config-dir credentials. |
| `HOST_CLAUDE_DIR` / `HOST_CODEX_DIR` / `HOST_ANTIGRAVITY_DIR` / `HOST_VIBE_DIR` | Unset | Production launcher only — absolute host paths for mounting agent credential directories into containers. Omit a variable to skip that agent's mount. Antigravity is Gemini-based, so its directory is `~/.gemini`. | Launcher deployments. |
| `HOST_OPENCODE_XDG_DIR` | Unset | Host path to the OpenCode XDG config directory (`~/.config/opencode`). | OpenCode via docker/launcher. |
| `HOST_OPENCODE_DATA_DIR` | Unset | Host path to OpenCode auth data (`~/.local/share/opencode`), so `opencode auth login` credentials reach spawned agent containers. | OpenCode via launcher. |
| `VIBE_PROMPT_CACHE_DIR` / `HOST_VIBE_PROMPT_CACHE_DIR` | Container `/tmp/propr-vibe-prompts`; host `/tmp/propr-vibe-prompts-<uid>` | Vibe Docker-outside-Docker writes prompt files to a host-visible directory so spawned containers can bind-mount them. Set both only to override the locations. | Optional. |

## Workers & Queue

Queue and worker behavior; see [Worker Runtime](../architecture/worker-runtime.md) for how jobs flow through it.

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | Redis connection for the job queue. | Optional. |
| `GITHUB_ISSUE_QUEUE_NAME` | `github-issue-processor` | Name of the issue-processing queue. | Optional. |
| `WORKER_CONCURRENCY` | Shipped `2` / code falls back to `5` if unset | Jobs a worker processes in parallel. | Optional. |
| `COMMENT_BATCH_DELAY_MS` | `3000` | Delay for batching GitHub comment updates. | Optional. |
| `SUMMARIZATION_FALLBACK_PROMOTE_THRESHOLD` | `3` | Promotes the summarization fallback to primary after this many primary quota failures for the same agent/model. | Optional. |
| `SUMMARIZATION_QUOTA_COOLDOWN_MS` | `3600000` (1 hour) | Pauses normal summarization jobs for a repository/branch after both primary and fallback paths fail. | Optional. |
| `SYSTEM_TASK_SECRET` | Empty | Signs system task requests (for example revert operations). Generate with `openssl rand -hex 32`. | System tasks (reverts). |
| `SYSTEM_TASK_TOKEN_MAX_AGE_MS` | `7200000` (2 hours) | Maximum age for signed system task tokens. Increase if jobs expire due to queue backlog or worker downtime. | Optional. |
| `GIT_CLONES_BASE_PATH` | `/tmp/git-processor/clones` | Where workers keep repository clones. | Optional. |
| `GIT_WORKTREES_BASE_PATH` | `/tmp/git-processor/worktrees` | Where workers create per-job worktrees. | Optional. |
| `GIT_DEFAULT_BRANCH` | `main` | Default base branch for PRs. Per-repo overrides use `GIT_DEFAULT_BRANCH_<OWNER>_<REPO>` — see [Branch Configuration](../features/branch-config.md). | Optional. |
| `GIT_SHALLOW_CLONE_DEPTH` | Empty (full clones) | Depth for shallow clones; leave empty to clone full history. | Optional. |

## Hosted UI Tunnel

Optional: expose a local stack's API to the hosted control plane at `https://app.propr.dev` through a Cloudflare Tunnel. Setup is CLI-first — [ProPR Connect](./propr-connect.md) shows a one-time `propr tunnel setup --token ... --url ... --start` command that writes these values and restarts the stack. The tunnel publishes only `/api/*` and `/socket.io/*` on the API container; the UI bundle is served by `app.propr.dev`. `FRONTEND_URL`, `API_PUBLIC_URL`, and `GH_OAUTH_CALLBACK_URL` are derived automatically in tunnel mode (see [Core & GitHub Auth](#core--github-auth)).

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `PROPR_UI_TUNNEL_TOKEN` | Unset | Cloudflare Tunnel token; setting it enables the tunnel on the next `propr start` (unless you ran `propr tunnel off`). This is a **live credential** — anyone with it can route traffic through your tunnel. Keep it in `.env` only; never commit, log, or share it. | Tunnel mode. |
| `PROPR_UI_TUNNEL_ENABLED` | Unset | `true`/`1` explicitly enables the tunnel. A token is still required — `propr check` fails without one. Redundant when a token is set. | Optional. |
| `PROPR_INSTANCE_ID` | Unset | This stack's instance id — a valid DNS label (letters, digits, hyphens; 1–63 chars). Derives the public URL `https://t-<id>.propr.dev`. | Tunnel mode, unless an explicit URL is set. |
| `PROPR_UI_PUBLIC_API_URL` | Derived from `PROPR_INSTANCE_ID` | Explicit public API URL the hosted UI talks to; overrides the derived one. | Override only. |
| `PROPR_CLOUDFLARED_IMAGE` | `cloudflare/cloudflared:2024.12.2` (pinned) | The cloudflared sidecar image. | Override only. |

## Agent Tank & Metrics

These two variables are read from code but are not in `.env.example` — Agent Tank is normally connected through the Web UI or `propr agent-tank`, which save the URL as a backend setting. See [Agent Tank](./agent-tank.md).

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `AGENT_TANK_URL` | Code falls back to `http://0.0.0.0:3456` when no saved setting exists | Fallback Agent Tank service URL used when no URL is saved in settings. Empty or `false` disables usage tracking for LLM calls. | Only when configuring Agent Tank via env instead of the UI/CLI. |
| `ANALYSIS_AGENT_TANK_TIMEOUT_MS` | `2000` | Timeout for the Agent Tank status fetch wrapped around each LLM call. | Optional. |

## Advanced

| Variable | Default (shipped / code) | What it does | Required when |
|---|---|---|---|
| `ENABLE_GITHUB_WEBHOOKS` | Deprecated | No longer selects the intake mode; use `GITHUB_EVENT_INTAKE_MODE` instead. Present only so existing `.env` files are recognized — a deprecation warning is logged when it is set. | Never — remove it. |
| `STAGING_ENV_FILE` | Placeholder | Path to a staging `.env` that provides base configuration for PR preview environments. Consumed by `docker-compose.yml` and `scripts/deploy-pr.sh`; the PR Preview workflow maps repository variables onto it. | Contributor PR preview deploys only. |
| `STAGING_DB_PATH` | Placeholder | Optional staging database file for seeding PR preview environments. | Contributor PR preview deploys only. |
