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

### Hosted UI Tunnel

For Plus installations using ProPR Connect, Connect can provision a hosted UI
tunnel. This lets the hosted Connect UI reach the local stack through an
outbound Cloudflare Tunnel, without opening inbound firewall ports for the API.

Run the command Connect shows from the stack directory:

```bash
propr tunnel setup --token <token> --url https://<instance>.proxy.propr.dev --start
```

`propr tunnel setup` writes these values to `.env`:

```bash
PROPR_UI_TUNNEL_TOKEN=<token>
PROPR_UI_TUNNEL_ENABLED=true
PROPR_INSTANCE_ID=<instance>
PROPR_UI_PUBLIC_API_URL=https://<instance>.proxy.propr.dev
```

Manual `.env` editing is only a fallback for hosts without the CLI; restart the
stack after changing these values.

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

**Polling** (`GITHUB_EVENT_INTAKE_MODE=polling`) suits installs that prefer to pull rather than maintain a streaming connection; it needs no inbound endpoint but adds latency and consumes the API budget continuously. The interval is `POLLING_INTERVAL_MS` (default `60000`).

**Direct webhook** (`GITHUB_EVENT_INTAKE_MODE=direct_webhook`) is for running your own GitHub App with GitHub delivering events to a public endpoint:

```bash
GITHUB_EVENT_INTAKE_MODE=direct_webhook
GH_WEBHOOK_SECRET=your-webhook-secret
```

The fastest way to provision an own App for this mode is `propr github-app manifest --public-url https://propr.example.com` (see [ProPR CLI](../features/propr-cli.md#own-github-app-direct-webhook-mode)). It writes `github-app-manifest.json` (which pre-fills the required repository permissions, subscribed webhook events, your `POST /webhook` URL, and a generated `GH_WEBHOOK_SECRET`) plus a matching `github-app.env` snippet. Submit the manifest at GitHub's *Register new GitHub App* page, then — once GitHub has created the App and you have installed it — fill in `GH_APP_ID`, `GH_INSTALLATION_ID`, and `HOST_GH_PRIVATE_KEY` (the values GitHub only assigns after the App exists; `HOST_GH_PRIVATE_KEY` matches what the generated `github-app.env` recommends — see the CLI vs Launcher key-path note above if you deploy via the launcher). The manifest only scaffolds configuration: direct webhook mode still requires a public `POST /webhook` route and installing the App on your account/org.

The API container serves the endpoint at `POST /webhook` (port 4000). Point your GitHub App's webhook URL at it through your reverse proxy, and set the same secret in the GitHub App settings. Direct webhook therefore requires your own GitHub App, a public URL, and `GH_WEBHOOK_SECRET`. The API refuses to start in `direct_webhook` mode without `GH_WEBHOOK_SECRET` (it is unused in the other modes — in particular, the default `routing_websocket` does not require it). Webhook delivery has no periodic backstop, so a missed or undelivered event relies on GitHub's redelivery. If you run `propr check` after generating the manifest but before filling in the App ID / installation id / private key, it flags the missing own-App values and repeats the `propr github-app manifest` next step.

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
