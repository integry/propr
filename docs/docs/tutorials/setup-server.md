---
sidebar_position: 3
---

# Server Setup

Use this path when ProPR should run on a shared host or production server.

:::tip[Starting from a bare VPS?]
If this is a fresh server, follow [Secure VPS Deployment](./setup-vps.md) instead — it covers OS hardening, the host firewall, localhost port binding, and TLS in addition to the ProPR-specific steps below.
:::

## What Changes From Local Setup

The Docker image flow is the same as [Local Setup](./setup-local.md). The differences are:

- Use a stable runtime directory such as `/srv/propr`.
- Set public URLs in `.env`.
- Put ProPR behind a reverse proxy or ingress.
- Configure TLS at the proxy layer.
- Optionally switch to an advanced intake mode (polling, or your own GitHub App webhook); the default hosted-App WebSocket routing needs no inbound endpoint.
- Restrict access to the Docker socket and credential directories.
- Back up data, logs, repositories, Redis, and SQLite state.

The server must be a Linux host; the launcher bind-mounts host paths and the Docker socket directly.

## Runtime Directory

```bash
sudo mkdir -p /srv/propr/{data,logs,repos}
sudo chown -R "$USER" /srv/propr
cd /srv/propr
```

If you run your own GitHub App (the advanced auth path — the default hosted ProPR App needs no key), place its private key there and restrict it:

```bash
chmod 600 your-app-private-key.pem
```

## Public URLs

Set the URLs in `.env` to your domain:

```bash
FRONTEND_URL=https://propr.example.com
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
```

The GitHub OAuth App callback URL must match.

## GitHub Event Intake

By default ProPR receives GitHub events through the hosted ProPR GitHub App over WebSocket routing (`GITHUB_EVENT_INTAKE_MODE=routing_websocket`). Events stream to ProPR over an **outbound** WebSocket, so a server needs **no inbound public URL** for intake, no GitHub App of its own, and no webhook secret — and delivery is near-immediate (low latency). `propr relay enroll` provisions the shared-App install and the routing/relay credentials. This is the recommended path for almost every server. Note that `GH_WEBHOOK_SECRET` is **not** used in routing mode — it applies only to the own-App webhook option below.

Two advanced intake modes are available when you have a specific reason to use them:

### Advanced: Polling

Set `GITHUB_EVENT_INTAKE_MODE=polling` to have ProPR pull labeled issues from the GitHub API on a fixed interval (`POLLING_INTERVAL_MS`, milliseconds; default `60000`). Polling needs no inbound endpoint either, but it adds latency (up to one interval) and consumes the installation's API budget continuously — see [Deployment](../operations/deployment.md#issue-intake-modes).

### Advanced: Your Own GitHub App Webhook

If you run your own GitHub App and want GitHub to deliver events directly to a public endpoint, set:

```bash
GITHUB_EVENT_INTAKE_MODE=direct_webhook
GH_WEBHOOK_SECRET=generate-a-strong-webhook-secret
```

`GH_WEBHOOK_SECRET` is mandatory **for this mode only**: the API refuses to start in `direct_webhook` mode without a secret, because unsigned webhook traffic would be rejected anyway. (It is ignored by the default routing mode.)

#### Scaffold the App with `propr github-app manifest`

Rather than assembling the App's permissions, webhook events, and secret by hand, generate them:

```bash
propr github-app manifest --public-url https://propr.example.com
```

This writes `github-app-manifest.json` and `github-app.env` into the current directory. The manifest pre-fills the repository permissions, subscribed webhook events, the `POST /webhook` URL, and a freshly generated `GH_WEBHOOK_SECRET`; submit it at GitHub's *Register new GitHub App* page. The `.env` snippet carries the same secret plus the `GH_AUTH_MODE=app` / `GITHUB_EVENT_INTAKE_MODE=direct_webhook` settings — append it to your stack `.env`. After GitHub creates the App and you install it, fill in the values GitHub only assigns once the App exists: `GH_APP_ID`, `GH_INSTALLATION_ID`, and `HOST_GH_PRIVATE_KEY` (download the App's private key and point this at its absolute host path). See [ProPR CLI](../features/propr-cli.md#own-github-app-direct-webhook-mode) for all flags. Running `propr check` between generating the manifest and filling in those values flags exactly what is still missing and repeats the command.

The guided `propr setup` wizard (below) can run this step for you: when you pick custom GitHub App auth and `direct_webhook` intake, it offers to write the same two files into the stack root, reusing `API_PUBLIC_URL`/`FRONTEND_URL` from `.env` for the public URL (or asking when neither is set) and leaving an existing manifest untouched unless you confirm a regenerate.

The manifest only scaffolds configuration — direct webhook mode still requires the public `POST /webhook` route below and installing the App on your account/org.

The webhook endpoint is `POST /webhook` on the API service (port `4000`). Route it through your reverse proxy, for example with nginx. Use an exact-match `location = /webhook` so the proxy does not also forward prefix siblings such as `/webhookadmin` or `/webhook-test` to the API:

```nginx
location = /webhook {
    proxy_pass http://127.0.0.1:4000/webhook;
}
```

In your GitHub App settings, set the webhook URL to `https://propr.example.com/webhook` and the webhook secret to the same `GH_WEBHOOK_SECRET` value.

## Start The Stack

On the server, the CLI control plane is the simplest path (Node.js 22+). The guided `propr setup` wizard is the recommended bootstrap — it scaffolds the runtime directory, helps you pick a [GitHub auth mode](../operations/github-auth.md) and issue intake (including the polling-vs-webhook choice covered above), and starts the stack:

```bash
sudo mkdir -p /srv/propr && sudo chown -R "$USER":"$USER" /srv/propr && cd /srv/propr
propr setup --root /srv/propr  # guided, re-runnable bootstrap
```

Over SSH, run `propr setup --no-tui` if your terminal lacks raw-mode support; setup then prompts line-by-line. Choosing **Token relay** at the auth step enrolls the shared App automatically (logging you in if needed, then writing the relay/routing credentials to `.env`), so no separate `propr relay enroll` is needed. Setup is **safe to re-run** — it skips already-satisfied steps and never overwrites `.env` or deletes data — so you can re-run it after editing public URLs or switching intake mode.

### Manual / Advanced Flow

To control each step yourself (useful for scripted provisioning and CI), run the underlying commands directly:

```bash
sudo mkdir -p /srv/propr && sudo chown -R "$USER":"$USER" /srv/propr && cd /srv/propr
propr init stack               # scaffold .env + data/ logs/ repos/
# configure GitHub auth in .env: shared App via `propr relay enroll` (default),
# or your own App (GH_APP_ID, GH_INSTALLATION_ID, HOST_GH_PRIVATE_KEY)
propr check
propr start --no-tui
```

Configure GitHub auth in `.env` before `propr check` — by default the shared,
hosted App via `propr relay enroll` (no private key), or your own App
(`GH_APP_ID`, `GH_INSTALLATION_ID`, `HOST_GH_PRIVATE_KEY`) as an advanced
option. See [GitHub Authentication](../operations/github-auth.md) for the full
walkthrough.

`propr status`, `propr stop`, and `propr start --restart` manage the running stack. Prefer a container-only host? Use the launcher below instead.

## Alternative: Start The Launcher

Use the same launcher command as local setup, but run it from `/srv/propr` or your chosen server directory. All `PROPR_*` and `HOST_*` paths must be absolute; the launcher does not expand `~`.

Authenticate Antigravity on the host first with `agy login`; the launcher mounts `HOST_ANTIGRAVITY_DIR="$HOME/.gemini"` for Antigravity agent runs. For OpenCode and Mistral Vibe credential preparation (including the host prompt cache directory, `/tmp/propr-vibe-prompts-$(id -u)` by default), see [Local Setup](./setup-local.md#prepare-agent-credentials).

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
  -e HOST_OPENCODE_XDG_DIR="$HOME/.config/opencode" \
  -e HOST_OPENCODE_DATA_DIR="$HOME/.local/share/opencode" \
  -e HOST_VIBE_DIR="$HOME/.vibe" \
  -e HOST_VIBE_PROMPT_CACHE_DIR="/tmp/propr-vibe-prompts-$(id -u)" \
  -e VIBE_PROMPT_CACHE_DIR=/tmp/propr-vibe-prompts \
  propr/launcher:latest
```

Omit the OpenCode and Vibe lines if you do not enable those agents. To update later, run `docker pull propr/launcher:latest` and re-run the same command.

## Finish In The Web UI

After the stack is reachable:

1. Add repositories.
2. Configure AI Agents.
3. Review label and PR settings.
4. Run one small test task.

Each step works from the Web UI or from the [ProPR CLI](../features/propr-cli.md) against the public API URL — useful for scripted provisioning:

```bash
npm install -g propr-cli
propr remote https://propr.example.com   # the API origin behind your proxy
propr login <personal-access-token>
propr repo add owner/repo
propr agent add my-claude -t claude -m opus48 -d opus48
propr remote-status
```

CLI authentication uses GitHub Bearer tokens and is enabled by default (`ENABLE_BEARER_AUTH=true`).

Before opening the server to traffic, harden the host and deployment: [Secure VPS Deployment](./setup-vps.md) covers OS hardening, the host firewall, localhost port binding, and TLS, and [Advanced VPS Hardening](./setup-vps-hardening.md) removes public inbound traffic entirely with a Cloudflare Tunnel and an SSO gate. For ongoing server care, see [Maintenance And Troubleshooting](../operations/maintenance.md).
