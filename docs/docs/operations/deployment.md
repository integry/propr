# Production Deployment

Use this page when ProPR should run on a shared server. For a laptop install, start with [Local Setup](../tutorials/setup-local.md). For the initial server walkthrough, see [Server Setup](../tutorials/setup-server.md).

## Recommended Path

Use the prebuilt images, started by the ProPR CLI control plane (`propr init stack --root /srv/propr`, `propr check`, `propr start --no-tui`; Node.js 22+) or by the published launcher container. Both run the same orchestrator: it reads a pinned image manifest, pulls each image, creates a Docker network, and starts the ProPR service containers as siblings through the mounted Docker socket.

You need:

- Docker
- A runtime directory such as `/srv/propr`
- GitHub backend access — your own GitHub App and private key (`HOST_GH_PRIVATE_KEY` bind-mounts it from any host path), or a shared App via the token relay; see [GitHub Authentication](./github-auth.md) for the three `GH_AUTH_MODE`s
- Agent credentials for at least one agent (for example Claude Code state in `~/.claude`, Codex state in `~/.codex`, or Antigravity CLI state in `~/.gemini`)
- Public URLs for the Web UI and OAuth callback
- TLS through your reverse proxy or ingress

## Runtime Directory Layout

Create a stable directory that owns all persistent state:

```bash
sudo mkdir -p /srv/propr/{data,logs,repos}
sudo chown -R "$USER" /srv/propr
cd /srv/propr
```

**Own GitHub App mode only:** once you have copied the App private key into this
directory, restrict its permissions. Relay mode (`GH_AUTH_MODE=relay`) has no key
file, so skip this command:

```bash
chmod 600 your-app-private-key.pem
```

| Path | Contents |
|---|---|
| `.env` | Server configuration (secrets, URLs, paths) |
| `your-app-private-key.pem` | GitHub App private key — **only in own GitHub App mode**; relay mode (`GH_AUTH_MODE=relay`) stores no key file here |
| `data/` | SQLite database (`propr.sqlite` plus `-wal`/`-shm` files) |
| `logs/` | Log directory mounted into the service containers at `/usr/src/app/logs` |
| `repos/` | Git working area: `clones/` (cached repository clones) and `worktrees/` (per-task worktrees) |

Redis data lives in the Docker volume `propr-redis-data`, not in this directory.

## Published Images

The launcher starts these images, pinned to the release version in its manifest:

| Image | Role |
|---|---|
| `propr/launcher` | Orchestrator that spawns the stack |
| `propr/app` | Server image; the start command selects the role (daemon, worker, analysis worker, indexing worker, API) |
| `propr/ui` | Web UI static bundle |
| `propr/docs` | Documentation site (started only with `DOCS_ENABLED=true`) |
| `propr/agent-claude` | Claude Code execution container |
| `propr/agent-codex` | Codex execution container |
| `propr/agent-antigravity` | Antigravity execution container |
| `propr/agent-opencode` | OpenCode execution container |
| `propr/agent-vibe` | Mistral Vibe execution container |
| `redis:7-alpine` | Queue and cache state |

Images are published to Docker Hub under the `propr/` namespace and mirrored to GHCR under `ghcr.io/proprdev/*` (the namespace is set by `GHCR_NS` in `scripts/build-images.sh`).

## Environment

Use `.env` for server-specific wiring. The GitHub App private-key variable
depends on whether you start the stack with the **CLI** or the **launcher**:

| Variable | When to use | Value |
|---|---|---|
| `HOST_GH_PRIVATE_KEY` | **CLI** (`propr start`) | Absolute **host** path to the `.pem` file — the CLI bind-mounts it into the container |
| `GH_PRIVATE_KEY_PATH` | **Launcher** (`docker run propr/launcher`) | Path **inside the launcher container** (typically `/app/config/...` via a `-v` mount) |

Do not mix them — the CLI cannot resolve a container-internal path, and the
launcher cannot resolve a host path it has not mounted itself.

```bash
GH_APP_ID=your-github-app-id
GH_INSTALLATION_ID=your-installation-id

# Pick ONE of the following, depending on your start method:
HOST_GH_PRIVATE_KEY=/srv/propr/your-app-private-key.pem          # CLI
# GH_PRIVATE_KEY_PATH=/app/config/your-app-private-key.pem       # Launcher

FRONTEND_URL=https://propr.example.com
GH_OAUTH_CLIENT_ID=your_github_oauth_client_id
GH_OAUTH_CLIENT_SECRET=your_github_oauth_client_secret
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
SESSION_SECRET=generate-a-strong-secret-here

DB_FILENAME=/app/data/propr.sqlite
GIT_CLONES_BASE_PATH=/app/repos/clones
GIT_WORKTREES_BASE_PATH=/app/repos/worktrees
```

All `HOST_*_DIR` values and launcher path variables must be absolute host paths. `.env` parsing does not expand `~` or `$HOME`.

Manage repositories, labels, branches, and agents in the Web UI after startup.

For Antigravity agents, install the CLI on the host and authenticate before launching the stack:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy login
```

Use `HOST_ANTIGRAVITY_DIR="$HOME/.gemini"` so the launcher can mount the authenticated CLI state into Antigravity worker runs. For OpenCode and Vibe agents, see the `HOST_OPENCODE_*` and `HOST_VIBE_*` variables documented in `.env.example`.

## Issue Intake Modes

Intake runs in exactly **one** of three modes, selected by `GITHUB_EVENT_INTAKE_MODE`. The default is `routing_websocket`; `polling` and `direct_webhook` are advanced opt-ins.

| | `routing_websocket` (default) | `polling` (advanced) | `direct_webhook` (advanced) |
|---|---|---|---|
| How events arrive | streamed over an outbound WebSocket from the hosted ProPR App | pulled from the GitHub API each cycle | delivered by GitHub to your own public `POST /webhook` |
| Latency | near-immediate | up to one interval (~60s) | near-immediate |
| Inbound network | none required | none required | public `POST /webhook` endpoint |
| GitHub App | shared, hosted ProPR App (no private key) | shared App or your own | your own App |
| Webhook secret | not used | not used | `GH_WEBHOOK_SECRET` required |
| GitHub API usage | low — event-driven | higher — periodic, scales with repos and open PRs | low — event-driven |
| Main caveat | none for typical installs | consumes the API budget continuously (see below) | must expose an endpoint; blocked by SSO/Access gates unless `/webhook` is exempted |

Most installs should stay on `routing_websocket`: it needs no inbound public URL, no GitHub App of your own, and no private key, and it delivers events with the lowest latency. Pick **Token relay** in `propr setup` (or run `propr relay enroll` standalone) to provision the shared-App install and routing/relay credentials. In every mode, deterministic job IDs and a state-label check prevent the same issue from being processed twice when it is seen more than once (see [Daemon](../architecture/daemon.md)).

The hosted bridge behind token relay and routing WebSocket intake is described
in [ProPR Connect](./propr-connect.md).

**Polling** (`GITHUB_EVENT_INTAKE_MODE=polling`) suits installs that prefer to pull rather than maintain a streaming connection; it needs no inbound endpoint but adds latency and consumes the API budget continuously. The interval is `POLLING_INTERVAL_MS` (default `60000`).

**Direct webhook** (`GITHUB_EVENT_INTAKE_MODE=direct_webhook`) is for running your own GitHub App with GitHub delivering events to a public endpoint:

```bash
GITHUB_EVENT_INTAKE_MODE=direct_webhook
GH_WEBHOOK_SECRET=your-webhook-secret
```

The API container serves the endpoint at `POST /webhook` (port 4000). Point your GitHub App's webhook URL at it through your reverse proxy, and set the same secret in the GitHub App settings. Direct webhook therefore requires your own GitHub App, a public URL, and `GH_WEBHOOK_SECRET`. The API refuses to start in `direct_webhook` mode without `GH_WEBHOOK_SECRET` (it is unused in the other modes — in particular, the default `routing_websocket` does not require it). Webhook delivery has no periodic backstop, so a missed or undelivered event relies on GitHub's redelivery.

> **Migration from `ENABLE_GITHUB_WEBHOOKS`:** the legacy boolean `ENABLE_GITHUB_WEBHOOKS` is **deprecated** and no longer selects an intake mode. If it is still present in your environment, the backend logs a deprecation warning at startup and otherwise ignores it. Remove it and set `GITHUB_EVENT_INTAKE_MODE` explicitly (`routing_websocket`, `polling`, or `direct_webhook`); when unset, intake resolves to `routing_websocket`. Note that event intake is independent of GitHub auth mode (`GH_AUTH_MODE`) — see [GitHub Authentication](./github-auth.md).

### Polling And GitHub API Rate Limits

Polling authenticates as the GitHub App installation, so every request draws from that installation's shared budget — **5,000 requests/hour** (up to 15,000 for large installations). The budget is shared across all monitored repositories and workers, not allocated per repository or per user.

A polling cycle's request count grows with:

- the number of monitored repositories (each is polled independently);
- the number of primary processing labels (one issue-listing call per label per repository);
- the number of open pull requests, when PR comment polling is enabled (the default) — each open PR costs a couple of calls per cycle to read its comments;
- the number of matched issues when `GITHUB_USER_WHITELIST` is set — ProPR reads each matched issue's timeline (up to `LABEL_APPLIER_TIMELINE_MAX_PAGES`, default 5) to confirm who applied the label.

As a rough per-hour estimate, ignoring whitelist timeline reads:

```
requests/hour ≈ (3600000 / POLLING_INTERVAL_MS) × repos × (labels + open_PRs × 2)
```

For example, 20 repositories, 2 processing labels, and ~5 open PRs each, at the default 60-second interval:

```
(3600000 / 60000) × 20 × (2 + 5 × 2)
= 60 × 20 × 12
= 14,400 requests/hour
```

That already exceeds the standard 5,000/hour budget and approaches the 15,000 large-installation ceiling. At small scale (a few repositories) the default interval stays well within budget, but a large install — many repositories, many open PRs, a user whitelist, or a shortened interval — can exhaust the hourly budget, after which GitHub rejects requests until the window resets.

ProPR's safeguards here are **reactive, not proactive**: it retries rate-limited requests with exponential backoff and logs a warning suggesting a longer interval, but it does not pause polling based on remaining budget, and it does not use conditional (ETag) requests — so every cycle costs against the budget even when nothing has changed.

To stay within limits:

- raise `POLLING_INTERVAL_MS` (the single biggest lever for many repositories);
- leave `GITHUB_USER_WHITELIST` empty unless you need applier verification, since it adds per-issue timeline calls;
- prefer an event-driven mode at scale — the default `routing_websocket` (or, with your own App, `direct_webhook`) replaces polling entirely, so the periodic listing cost disappears (the daemon makes API calls only when reacting to an event, not on a fixed interval).

## Start The Stack

### Option A — CLI (Recommended)

The ProPR CLI (`propr-cli`, Node.js 22+) is the recommended control plane. It
reads `.env`, pulls images, creates the Docker network, and starts service
containers — the same orchestration the launcher performs, but managed from the
host rather than from inside a container.

```bash
cd /srv/propr
propr check              # validates Docker, images, agent credentials, and GitHub auth mode
propr start --no-tui     # pull images and start the stack (non-interactive)
```

`propr check --verify` additionally smoke-tests each agent image. Use
`propr start` (without `--no-tui`) for the interactive dashboard.
`propr status`, `propr stop`, and `propr remote-status` manage the running
stack.

### Option B — Launcher Container

If you prefer not to install Node.js on the host, the published launcher
container provides the same orchestration:

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/.env:/app/.env:ro" \
  -v "$PWD/your-app-private-key.pem:/app/config/your-app-private-key.pem:ro" \
  -e PROPR_ENV_FILE="$PWD/.env" \
  -e PROPR_DATA_DIR="$PWD/data" \
  -e PROPR_LOGS_DIR="$PWD/logs" \
  -e PROPR_REPOS_DIR="$PWD/repos" \
  -e HOST_CLAUDE_DIR="$HOME/.claude" \
  -e HOST_CODEX_DIR="$HOME/.codex" \
  -e HOST_ANTIGRAVITY_DIR="$HOME/.gemini" \
  propr/launcher:latest
```

The private-key mount (`-v ...your-app-private-key.pem...`) is needed **only in
own GitHub App mode**, where it pairs with `GH_PRIVATE_KEY_PATH=/app/config/...`
in `.env`. In relay mode (`GH_AUTH_MODE=relay`) there is no key file — omit that
line. Do not also set `HOST_GH_PRIVATE_KEY` here: that variable is for the CLI
start path, and the two key variables must not be mixed (see
[Environment](#environment) above).

The path variables are passed as environment values, not mounts, because the launcher spawns sibling containers through the host Docker daemon — every `-v` value it passes must resolve on the host.

The launcher starts these containers (stack prefix configurable with `PROPR_STACK`, default `propr`):

- `propr-redis`
- `propr-daemon`
- `propr-worker`
- `propr-analysis-worker`
- `propr-indexing-worker`
- `propr-api` — publishes port 4000 (override with `API_PORT`)
- `propr-ui` — publishes port 5173 (override with `UI_PORT`)
- `propr-docs` — only with `DOCS_ENABLED=true`; port 8080 (override with `DOCS_PORT`)

Redis is not published on the host unless `REDIS_EXTERNAL_PORT` is set.

## Reverse Proxy And TLS

Terminate TLS at your reverse proxy or ingress, then:

- Route the public site to the UI container (port 5173).
- Route `/api/*`, `/webhook`, and `/socket.io/` to the API container (port 4000). The Web UI uses WebSockets for live updates, so the proxy must support connection upgrades on `/socket.io/`.
- Set `FRONTEND_URL` and `GH_OAUTH_CALLBACK_URL` to the public HTTPS origins, and configure the same callback URL in the GitHub OAuth App settings.

If the UI and API are served from different origins, the API's CORS configuration uses `FRONTEND_URL` and browser requests send session cookies cross-origin — keep both URLs consistent with the actual public origins.

## Hosted UI Tunnel

Instead of (or in addition to) your own reverse proxy, a local stack can publish itself to the **hosted ProPR UI** at `https://app.propr.dev` so you can drive a locally-running stack from the managed control plane in your browser — no public domain of your own and no inbound proxy to operate.

This works through an optional **Cloudflare Tunnel**: a managed sidecar running the official `cloudflare/cloudflared` image, started and stopped with [`propr tunnel on|off`](../features/propr-cli.md#hosted-ui-tunnel) (or persisted via `.env` so `propr start` brings it up). It is **off by default** and does not affect a normal localhost or reverse-proxy deployment.

For the higher-level role of the hosted bridge, including the difference between
`connect.propr.dev`, `webhook.propr.dev`, `app.propr.dev`, and
`<id>.proxy.propr.dev`, see [ProPR Connect](./propr-connect.md).

### Architecture

Two distinct public hosts are in play, and they are **not** the same origin:

- `https://app.propr.dev` — the **hosted UI**, and the origin the **browser is loaded from**. It is a single static bundle that serves every connected stack. Because one bundle serves many stacks, the API base URL is not baked in at build time; the browser reads it at runtime from `window.__PROPR_CONFIG__.apiBaseUrl`. This is the **browser origin**, so it is the origin the API must allow through CORS, and the origin the API redirects back to after login.

  How `window.__PROPR_CONFIG__` is populated depends on **who serves the bundle**. When you **self-host** the UI bundle (the `propr/ui` container), its entrypoint rewrites the static `config.js` from `PROPR_UI_PUBLIC_API_URL` at container start, so one container targets one stack. The **vendor-hosted** `app.propr.dev` serves the same bundle to many stacks, so it cannot be rewritten per container. Instead, ProPR Connect opens the hosted UI with a validated `?tunnel=<id>.proxy.propr.dev` deep link, and the UI remembers that selected per-instance API origin through login/OAuth redirects. If the bundle loads on the hosted UI origin (`app.propr.dev`) with no tunnel deep link, no remembered tunnel, and no runtime config, the UI shows a “Connect a ProPR stack” state instead of falling through to broken same-origin API calls. Localhost and self-hosted same-origin deployments serve the API from the same origin, so they are exempt from that hosted-only guard.
- `https://<PROPR_INSTANCE_ID>.proxy.propr.dev` — the **per-instance proxy host** for one stack, and the host the browser sends **API, Socket.IO, OAuth-callback, and session-cookie** traffic to. Each enabled stack is published under this hostname through its Cloudflare Tunnel, and the hosted UI discovers and reaches your stack through the shared `.proxy.propr.dev` suffix — no domain of your own to own or register. The tunnel fronts the **API** here (the API container on port 4000); propr-routing forwards only `/api/*` and `/socket.io/*` on the proxy host, so the root URL returns 404 and `/webhook` is **not** routed through the tunnel. The UI itself is served by `app.propr.dev`, not through the tunnel.
- `http://api:4000` — **internal only**. This is the service-to-service address other stack containers use to reach the API inside the Docker network, and it is also **where Cloudflare forwards the tunnel** — the tunnel ingress points at the Docker-internal `http://api:4000`, **not** at host port 4000. Because routing is internal to the Docker network, the published host port is irrelevant to the tunnel and the two cannot conflict; you do not need host port 4000 free for the tunnel to work. The tunnel publishes the API publicly at the proxy host; the internal `http://api:4000` name is unchanged and is never what the browser uses.

So the browser origin (`app.propr.dev`) and the API host (`<id>.proxy.propr.dev`) **differ**. They work together because both sit under the shared `propr.dev` registrable domain, which makes them *same-site* (though cross-origin): the API allows the `app.propr.dev` origin via CORS (`FRONTEND_URL`), the host-only session cookie set on the proxy host is sent with the UI's same-site API calls, and the OAuth callback lands on the proxy host. See [Configuration](#configuration-v1) below for the exact `FRONTEND_URL` / `API_PUBLIC_URL` / `GH_OAUTH_CALLBACK_URL` values.

**`.proxy.propr.dev` is not `api.propr.dev`.** The per-instance `<id>.proxy.propr.dev` host is the public front door to *your own local stack* through the tunnel. The central ProPR services live on different hosts — the hosted UI at `app.propr.dev`, and the routing / GitHub-token relay at `webhook.propr.dev` (see [GitHub Authentication](./github-auth.md)). Those are vendor-run APIs shared by all installs; `.proxy.propr.dev` addresses only your stack.

The browser uses the **same API base** for both REST calls and the Socket.IO connection, so they always target one origin — the per-instance proxy host when the tunnel is on, or same-origin localhost otherwise. Through the tunnel, propr-routing forwards only `/api/*` and `/socket.io/*` (the two paths the browser uses); WebSocket upgrades must be allowed on `/socket.io/`. (`/webhook` is a server-to-server endpoint used only by `direct_webhook` mode behind your own reverse proxy — it is never called by the browser and is not routed through the tunnel.)

Before the hosted UI starts its normal auth/session checks, it calls the public
`/api/compatibility` endpoint on the selected API origin. The endpoint returns
the local stack version plus the API/UI compatibility contract. If the hosted UI
does not support that local API contract, it stops at a clear version-mismatch
screen instead of running against incompatible endpoints or Socket.IO events.
`/api/status` also includes the same metadata for authenticated diagnostics.

Only a **definitive** mismatch (the API reports a contract the UI knows it is too
old or too new for) hard-blocks. A v1 **rollout exception** applies when the
metadata is simply *absent* — an older API that predates `/api/compatibility`
(returns 404) or returns no contract: the UI logs a console warning and continues
rather than blocking, so an otherwise-working stack that has not been upgraded to
publish metadata yet is not trapped mid-upgrade. This soft-warning fallback is
temporary; once publishing the compatibility contract is a baseline expectation,
missing metadata is intended to become a hard block like any other mismatch.

### Configuration (v1)

ProPR Connect shows a one-time connector token and tunnel URL. Use the CLI setup command from Connect to write the stack `.env` values without editing the file by hand:

```bash
propr tunnel setup --token <connector-token> --url https://abc123.proxy.propr.dev --start
```

For older CLI versions or manual recovery, set these in the stack `.env`. Replace `abc123` with your instance id (a valid DNS label):

```bash
# --- Hosted UI tunnel (v1, optional) ---
# PROPR_UI_TUNNEL_TOKEN is a LIVE Cloudflare credential — do not commit, log, or share it.
PROPR_UI_TUNNEL_TOKEN=your_cloudflare_tunnel_token   # Cloudflare Tunnel token; required to start. Setting it makes the tunnel start on the next `propr start`
PROPR_UI_TUNNEL_ENABLED=true                         # explicit tunnel enablement; the CLI also records this in its config
PROPR_INSTANCE_ID=abc123                             # this stack's instance id; valid DNS label (letters, digits, hyphens; 1-63 chars). Derives https://abc123.proxy.propr.dev
PROPR_UI_PUBLIC_API_URL=https://abc123.proxy.propr.dev # explicit public API URL the hosted UI talks to

# Optional override:
# PROPR_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2024.12.2 # cloudflared image; overrides the manifest-pinned default

# Browser vs API origins (see Architecture above). `propr tunnel setup` writes
# these so stale localhost values from a previous local setup do not win.
#   - FRONTEND_URL is the browser origin: the hosted UI at app.propr.dev. It is
#     the CORS allow-origin and the post-login redirect target.
#   - API_PUBLIC_URL is the proxy host: where the browser actually reaches the
#     API, Socket.IO, and the OAuth callback.
FRONTEND_URL=https://app.propr.dev
API_PUBLIC_URL=https://abc123.proxy.propr.dev

# OAuth callback lives on the API (the proxy host), NOT on app.propr.dev. This
# exact URL must be registered in your GitHub OAuth App.
GH_OAUTH_CALLBACK_URL=https://abc123.proxy.propr.dev/api/auth/github/callback

# COOKIE_DOMAIN: leave UNSET for v1 (keep the line commented out — an empty
# `COOKIE_DOMAIN=` is not guaranteed to be treated as absent). The session
# cookie is then host-only on the proxy host — correct because app.propr.dev and
# <id>.proxy.propr.dev share the propr.dev registrable domain (same-site).
# COOKIE_DOMAIN=
```

`PROPR_INSTANCE_ID` derives the public URL `https://<id>.proxy.propr.dev` automatically, so `PROPR_UI_PUBLIC_API_URL` is only needed to override it. The browser origin and the API host are **different** hosts, so set them accordingly:

- `FRONTEND_URL` is the **browser origin** — the hosted UI at `https://app.propr.dev`. The API allows this origin through CORS and redirects to it after login. In tunnel mode it is derived to `https://app.propr.dev` when left unset, and `propr tunnel setup` writes it explicitly so older localhost values do not override the tunnel.
- `API_PUBLIC_URL` is the **proxy host** (`https://<id>.proxy.propr.dev`) — where the browser actually reaches the API and Socket.IO, and what governs the secure session cookie. In tunnel mode it is derived from the instance id when left unset, and `propr tunnel setup` writes it explicitly.
- `GH_OAUTH_CALLBACK_URL` must point at the API on the **proxy host** (`https://<id>.proxy.propr.dev/api/auth/github/callback`). In tunnel mode it is derived when left unset, and `propr tunnel setup` writes it explicitly so older localhost callback values do not override the tunnel. Register the same URL in your GitHub OAuth App.

Leave `COOKIE_DOMAIN` unset: the session cookie is host-only on the single `<id>.proxy.propr.dev` host, which is correct because that host and `app.propr.dev` are same-site under `propr.dev`. Scoping the cookie across the shared `.proxy.propr.dev` suffix is not supported for v1.

Then start the sidecar and verify it:

```bash
propr tunnel on
propr tunnel verify   # checks the sidecar + public /api/status, /, /socket.io/
```

`propr tunnel verify` confirms the cloudflared container is running and that the public proxy answers as expected: `GET <url>/api/status` returns an OK/auth-expected response, `GET <url>/` returns **404** (the root is intentionally not routed), and `GET <url>/socket.io/` is reachable. `propr status` likewise probes `<url>/api/status` for tunnel reachability — the root `/` and the legacy `/health` path are not routed through the tunnel.

**Enablement.** Setting `PROPR_UI_TUNNEL_TOKEN` enables the tunnel by default, so the next `propr start` (or a restart) brings up the sidecar — you do not strictly need `propr tunnel on` first. `propr tunnel on|off` records an explicit choice that **overrides** the token-derived default and is honored by later starts; `propr tunnel on` additionally starts the sidecar immediately on an already-running stack, and `propr tunnel off` stops it while leaving the token in place. `PROPR_UI_TUNNEL_ENABLED=true` is an explicit alternative, but a token is still required — `propr check` fails if the tunnel is enabled without `PROPR_UI_TUNNEL_TOKEN`. See [ProPR CLI → Hosted UI Tunnel](../features/propr-cli.md#hosted-ui-tunnel) for the full toggle semantics.

:::note[Connect provisioning]
ProPR Connect provisions the Cloudflare Tunnel token and instance id for Plus installations and shows the one-time `propr tunnel setup --token ... --url ... --start` command. The raw `.env` values remain visible as a fallback for older CLI versions or manual recovery, but new installs should prefer the generated CLI command so the stack is restarted with the hosted URLs immediately.
:::

## After Startup

1. Open the Web UI.
2. Add repositories.
3. Configure AI Agents.
4. Check labels and PR settings.
5. Run one small test task.

## Backups

Back up:

- `.env` and the GitHub App private key (or the secret source that produces them)
- `data/` — the SQLite database is the primary application state; copy it while the stack is stopped, or use `sqlite3 propr.sqlite ".backup backup.sqlite"` for a consistent snapshot of a live database (WAL mode is enabled)
- The `propr-redis-data` Docker volume if you want queue state and sessions to survive a restore
- `logs/` if you need log history

`repos/` is a working area: clones are re-created on demand and worktrees are per-task. It does not need backups, and `repos/` plus `logs/` alone do not contain the application state.

## Security

- Restrict access to the Docker socket. Any process that can reach `/var/run/docker.sock` controls the host's Docker daemon; limit shell access on the server accordingly.
- Restrict the mounted credential directories (`~/.claude`, `~/.codex`, `~/.gemini`, and so on). They contain provider login state and are mounted into worker and agent containers.
- Keep the GitHub App private key at mode `600`.
- Use a strong `SESSION_SECRET` and HTTPS-only public URLs.

## Updating

### CLI update path

Update the CLI package, then restart the stack. The CLI manifest pins exact
image versions; the new version pulls the matching service and agent images:

```bash
sudo npm update -g propr-cli
which propr && propr --version   # confirm the updated CLI is the one on PATH
cd /srv/propr                # run --restart from the stack runtime directory
propr start --restart        # pulls updated images and recreates containers
```

`propr start --restart` resolves the stack relative to the current working
directory (or an explicit `--root`), so `cd` into the runtime directory first to
avoid restarting against the wrong path.

Run the update with the **same method you installed `propr-cli` with**. `sudo`
matches a root-owned global install (the default for a system `apt`/NodeSource
Node). If your global prefix is user-owned — for example an `nvm`-managed Node or
a custom `npm config set prefix` under your home directory — omit `sudo`, since
running it as root can update a different install or leave root-owned files in a
user-owned prefix. `npm prefix -g` shows which prefix is in effect.

### Launcher update path

Pull the newer launcher image:

```bash
docker pull propr/launcher:latest
```

Stop the running launcher (Ctrl-C, or stop its container — it stops and removes the stack containers on shutdown), then start it again with the same `docker run` command. The new launcher pulls the newer pinned service and agent images on startup.

---

In both cases, persistent state in `data/`, `repos/`, and the Redis volume is unaffected.

For ongoing care — backups, troubleshooting, queue resets, and tuning — see [Maintenance And Troubleshooting](./maintenance.md).
