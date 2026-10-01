# Production Deployment

Use this page when ProPR should run on a shared server. For a laptop install, start with [Local Setup](../tutorials/setup-local.md). For the initial server walkthrough, see [Server Setup](../tutorials/setup-server.md).

## Recommended Path

Use the prebuilt images, started by the ProPR CLI control plane (`propr init stack --root /srv/propr`, `propr check`, `propr start --no-tui`; Node.js 22+) or by the published launcher container. Both run the same orchestrator: it reads a pinned image manifest, pulls each image, creates a Docker network, and starts the ProPR service containers as siblings through the mounted Docker socket.

You need:

- A Linux `amd64` host that meets the [system requirements](../tutorials/setup.md#system-requirements)
- A maintained Docker Engine release. The ProPR user must be able to run `docker info` and read/write `/var/run/docker.sock` without an interactive `sudo` prompt. The engine must support Linux containers, user-defined networks, bind mounts, named volumes, restart policies, `--init`, and CPU, memory, and PID limits.
- A runtime directory such as `/srv/propr`
- GitHub backend access — your own GitHub App and private key (`HOST_GH_PRIVATE_KEY` bind-mounts it from any host path), or a shared App via the token relay; see [GitHub Authentication](./github-auth.md) for the three `GH_AUTH_MODE`s
- A provider account for at least one agent; reuse host credentials or log in directly after adding the agent in the Web UI
- Public URLs for the Web UI and OAuth callback
- TLS through your reverse proxy or ingress

Docker Compose is not part of the prebuilt production path. It is used for the source-development stack. ProPR does not enforce an exact Docker version; `propr check` validates the capabilities it needs before startup.

## Runtime Directory Layout

Create a stable directory that owns all persistent state:

```bash
sudo mkdir -p /srv/propr/{data,logs,repos}
sudo chown -R "$USER" /srv/propr
cd /srv/propr
```

For own-App installs, `propr github-app create` saves the private key here with
mode `0600`. Relay mode (`GH_AUTH_MODE=relay`) has no key file.

| Path | Contents |
|---|---|
| `.env` | Server configuration (secrets, URLs, paths) |
| `github-app-<id>-<suffix>.pem` | GitHub App private key — **only in own GitHub App mode**; relay mode (`GH_AUTH_MODE=relay`) stores no key file here |
| `data/` | SQLite database (`propr.sqlite` plus `-wal`/`-shm` files) |
| `logs/` | Log directory mounted into the service containers at `/usr/src/app/logs` |
| `repos/` | Mounted into the worker at `/usr/src/app/repos`. Cached clones and per-task worktrees live under `/tmp/git-processor` on the host by default (`GIT_CLONES_BASE_PATH`, `GIT_WORKTREES_BASE_PATH`) |

Redis data lives outside this directory, in the Docker volume `propr-redis-data`.

## Published Images

The launcher starts these images, pinned to the release version in its manifest:

| Image | Role |
|---|---|
| `propr/launcher` | Orchestrator that spawns the stack |
| `propr/app` | Server image; the start command selects the role (daemon, worker, analysis worker, indexing worker, API) |
| `propr/ui` | Web UI static bundle |
| `propr/docs` | Documentation site (started only with `DOCS_ENABLED=true`) |
| `propr/agent` | Unified Claude, Codex, Antigravity, OpenCode, and Vibe execution container |
| `redis:7-alpine` | Queue and cache state |

Images are published to Docker Hub under the `propr/` namespace. Docker Hub is the single public release registry; the namespace can be overridden with `DOCKERHUB_NS` for development or private distributions.

## Environment

Use `.env` for server-specific wiring. For an own-App install, create and install
the App with:

```bash
propr github-app create --root /srv/propr --public-url https://propr.example.com
# Add --no-browser over SSH; add --org your-org for organization ownership.
```

The command writes the App credentials, GitHub login settings and direct-webhook
configuration. It saves `HOST_GH_PRIVATE_KEY` as an absolute host path; the CLI
and launcher mount it read-only and set `GH_PRIVATE_KEY_PATH` themselves.
See [Create your own App](./github-auth.md#create-your-own-app) for permissions,
manual registration, SSH, and recovery instructions.

For **I already have one**, copy your existing App's PEM to
`/srv/propr/github-app.pem` and add its credentials to `/srv/propr/.env`:

```dotenv
GH_AUTH_MODE=app
PROPR_DEMO_MODE=false
GH_APP_ID=123456
GH_INSTALLATION_ID=987654
HOST_GH_PRIVATE_KEY=/srv/propr/github-app.pem
GH_WEBHOOK_SECRET=your-app-webhook-secret
GH_OAUTH_CLIENT_ID=your-app-client-id
GH_OAUTH_CLIENT_SECRET=your-app-client-secret
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
GITHUB_EVENT_INTAKE_MODE=direct_webhook
```

```bash
chmod 600 /srv/propr/github-app.pem /srv/propr/.env
```

Replace the example IDs, secrets, and public URL. Configure the same webhook
secret and callback URL in the App's settings, with the webhook at
`https://propr.example.com/webhook`. See
[Use an existing App](./github-auth.md#use-an-existing-app) for permissions and
settings to remove when switching from relay mode.

Set the remaining server wiring in `.env`:

```bash
FRONTEND_URL=https://propr.example.com
API_PUBLIC_URL=https://propr.example.com
SESSION_SECRET=generate-a-strong-secret-here
DB_FILENAME=./data/propr.sqlite
```

All `HOST_*_DIR` values and launcher path variables must be absolute host paths. `.env` parsing does not expand `~` or `$HOME`.

Manage repositories, labels, branches, and agents in the Web UI after startup. Direct-login agent accounts need no `HOST_*` path: CLI-started, native and Compose installs store them below `~/.propr/agent-credentials`, while the launcher container derives an isolated root below `PROPR_DATA_DIR`.

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

**Direct webhook** (`GITHUB_EVENT_INTAKE_MODE=direct_webhook`) delivers GitHub events
to your own public endpoint. Run `propr github-app create --public-url
https://propr.example.com` to configure it, then `propr start --restart`. The
command sets the webhook URL and the matching `GH_WEBHOOK_SECRET`; the API
refuses to start in this mode without a secret.

The API serves `POST /webhook` on port 4000. Expose it through your reverse proxy
without an interactive SSO gate. Webhook delivery has no periodic backstop, so a
missed or undelivered event relies on GitHub's redelivery.

> **Migration from `ENABLE_GITHUB_WEBHOOKS`:** the legacy boolean `ENABLE_GITHUB_WEBHOOKS` is **deprecated** and no longer selects an intake mode. If it is still present in your environment, the backend logs a deprecation warning at startup and otherwise ignores it. Remove it and set `GITHUB_EVENT_INTAKE_MODE` explicitly (`routing_websocket`, `polling`, or `direct_webhook`); when unset, intake resolves to `routing_websocket`. Note that event intake is independent of GitHub auth mode (`GH_AUTH_MODE`) — see [GitHub Authentication](./github-auth.md).

### Polling And GitHub API Rate Limits

Polling authenticates as the GitHub App installation, so every request draws from that installation's shared budget — **5,000 requests/hour** (up to 15,000 for large installations). The budget is shared across all monitored repositories and workers; there is no per-repository or per-user allocation.

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

ProPR's safeguards here are **reactive only**: it retries rate-limited requests with exponential backoff and logs a warning suggesting a longer interval, but it does not pause polling based on remaining budget, and it does not use conditional (ETag) requests — so every cycle costs against the budget even when nothing has changed.

To stay within limits:

- raise `POLLING_INTERVAL_MS` (the single biggest lever for many repositories);
- leave `GITHUB_USER_WHITELIST` empty unless you need applier verification, since it adds per-issue timeline calls;
- prefer an event-driven mode at scale — the default `routing_websocket` (or, with your own App, `direct_webhook`) replaces polling entirely, so the periodic listing cost disappears (the daemon makes API calls only when reacting to an event).

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

`propr check --verify` additionally verifies GitHub App access (minting an
installation token) and smoke-tests each agent image. Use
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
  -e PROPR_ENV_FILE="$PWD/.env" \
  -e PROPR_DATA_DIR="$PWD/data" \
  -e PROPR_LOGS_DIR="$PWD/logs" \
  -e PROPR_REPOS_DIR="$PWD/repos" \
  -e HOST_CLAUDE_DIR="$HOME/.claude" \
  -e HOST_CODEX_DIR="$HOME/.codex" \
  -e HOST_ANTIGRAVITY_DIR="$HOME/.gemini" \
  propr/launcher:latest
```

In own GitHub App mode, set `HOST_GH_PRIVATE_KEY` in `.env` to the key's absolute
host path; the launcher mounts it into the app containers (see
[Environment](#environment) above). Relay mode (`GH_AUTH_MODE=relay`) needs no key.

The path variables are passed as environment values; mounting them would not work because the launcher spawns sibling containers through the host Docker daemon, and every `-v` value it passes must resolve on the host.

The launcher starts these containers (stack prefix configurable with `PROPR_STACK`, default `propr`):

- `propr-redis`
- `propr-daemon`
- `propr-worker`
- `propr-analysis-worker`
- `propr-indexing-worker`
- `propr-api` — publishes `127.0.0.1:4000` by default (override with `API_PORT`)
- `propr-ui` — publishes `127.0.0.1:5173` by default (override with `UI_PORT`)
- `propr-docs` — only with `DOCS_ENABLED=true`; port 8080 (override with `DOCS_PORT`)

Redis is not published on the host unless `REDIS_EXTERNAL_PORT` is set.
The API and UI defaults are reachable directly from the Docker host but not
from its public network interfaces; the managed tunnel continues to reach the
API through the stack network and does not require an inbound port.

To opt into a different bind, set the Docker publish value explicitly in the
stack `.env`. Existing values are preserved during setup and upgrades, including
older bare-port defaults:

```bash
# Custom loopback ports remain host-only.
API_PORT=127.0.0.1:4400
UI_PORT=127.0.0.1:5174

# Bare ports intentionally publish on every host interface.
# API_PORT=4000
# UI_PORT=5173
```

:::warning[Secure non-loopback bindings]
A bare port or another non-loopback address can expose the service to external
clients. Only use one as an intentional opt-in; restrict access with a firewall
and put browser/API traffic behind a properly configured TLS reverse proxy. If
an existing stack contains bare `4000`/`5173` values that were not deliberate,
change them manually to the loopback forms above before restarting.
:::

## Reverse Proxy And TLS

Terminate TLS at your reverse proxy or ingress, then:

- Route the public site to the UI container (port 5173).
- Route `/api/*`, `/webhook`, and `/socket.io/` to the API container (port 4000). The Web UI uses WebSockets for live updates, so the proxy must support connection upgrades on `/socket.io/`.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto`, and set `PROPR_TRUSTED_PROXY_PEERS` to the API connection's **immediate socket peer**. Use `loopback` when nginx and the API both run directly on the host, or the ingress's exact IP/CIDR for another topology. The VPS tutorial's host-nginx/launcher path uses `uniquelocal` only together with `API_PORT=127.0.0.1:4000`: the loopback bind makes the Docker host bridge the only reachable private peer, and launcher validation rejects `uniquelocal` without that constraint. Never use `uniquelocal` with an all-interface API binding. Do not list public client or CDN egress ranges: this setting identifies the last proxy hop, not the browser.
- Set `FRONTEND_URL`, `API_PUBLIC_URL`, and `GH_OAUTH_CALLBACK_URL` to the public HTTPS origins, and configure the same callback URL in the GitHub OAuth App settings.

If the UI and API are served from different origins, the API's CORS configuration uses `FRONTEND_URL` and browser requests send session cookies cross-origin — keep both URLs consistent with the actual public origins.

The UI origin must also serve the PWA files as real files before any SPA fallback. In particular, preserve `/service-worker.js`, `/manifest.webmanifest`, `/pwa-shell-assets.json`, `/icons/*`, `/apple-touch-icon.png`, `/logo.png`, `/logo-loading.png`, `/media/logo-and-name.png`, and `/config.js`; do not rewrite them to `index.html`. Revalidate the worker and manifest, do not cache `config.js`, and reserve long-lived immutable caching for hashed `/assets/*`. The exact path/header contract and public-response checks are in [PWA, Web Push, and Badges → Reverse proxy and caching contract](./pwa-web-push.md#reverse-proxy-and-caching-contract).

Leave `PROPR_TRUSTED_PROXY_PEERS` unset when clients connect directly. In that fail-closed mode the API ignores forwarded client/protocol headers, preventing a direct client from choosing another quota bucket or claiming HTTPS. The legacy source-build `docker-compose.prod.yml` passes this variable through but does not choose a peer for an operator-managed proxy.

## Hosted UI Tunnel

Instead of (or in addition to) your own reverse proxy, a local stack can publish its API to the **hosted ProPR UI** at `https://app.propr.dev` through an optional Cloudflare Tunnel — you drive the locally-running stack from your browser with no public domain of your own and no inbound proxy to operate. The tunnel is off by default and leaves a normal localhost or reverse-proxy deployment untouched.

The full picture — architecture, provisioning, the `FRONTEND_URL` / `API_PUBLIC_URL` / `GH_OAUTH_CALLBACK_URL` configuration, verification, and troubleshooting — lives in [Hosted UI Tunnel](./hosted-ui-tunnel.md).

## After Startup

1. Open the Web UI.
2. Add repositories.
3. Configure AI Agents.
4. Check labels and PR settings.
5. Run one small test task.

## Backups

The SQLite database in `data/` is the primary application state; `.env`, the GitHub App private key, and any managed agent credential root complete a restorable set. The full backup checklist — including live-database snapshots and what to skip — is in [Maintenance → Backups](./maintenance.md#backups).

## Security

- Restrict access to the Docker socket. Any process that can reach `/var/run/docker.sock` has root-equivalent control of the host. The production API receives this socket to create authenticated agent-login containers, so protect dashboard access and treat the API as trusted control-plane code.
- Restrict the managed credential root and any reused host credential directories (`~/.claude`, `~/.codex`, `~/.gemini`, and so on). They contain provider login state and are mounted into worker and agent containers.
- Keep the GitHub App private key at mode `600`.
- Use a strong `SESSION_SECRET` and HTTPS-only public URLs.

## Updating

### CLI update path

Update the CLI package, then restart the stack. The CLI manifest pins exact
image versions; the new version pulls the matching service images and unified agent image:

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

Stop the running launcher (Ctrl-C, or stop its container — it stops and removes the stack containers on shutdown), then start it again with the same `docker run` command. The new launcher pulls the newer pinned service images and unified agent image on startup.

---

In both cases, persistent state in `data/`, `repos/`, and the Redis volume is unaffected.

For ongoing care — backups, troubleshooting, queue resets, and tuning — see [Maintenance And Troubleshooting](./maintenance.md).
