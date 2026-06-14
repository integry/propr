---
sidebar_position: 3
---

# Server Setup

Use this path when ProPR should run on a shared host or production server.

:::tip Starting from a bare VPS?
If this is a fresh server, follow [Secure VPS Deployment](./setup-vps.md) instead — it covers OS hardening, the host firewall, localhost port binding, and TLS in addition to the ProPR-specific steps below.
:::

## What Changes From Local Setup

The Docker image flow is the same as [Local Setup](./setup-local.md). The differences are:

- Use a stable runtime directory such as `/srv/propr`.
- Set public URLs in `.env`.
- Put ProPR behind a reverse proxy or ingress.
- Configure TLS at the proxy layer.
- Optionally switch issue intake from polling to GitHub webhooks.
- Restrict access to the Docker socket and credential directories.
- Back up data, logs, repositories, Redis, and SQLite state.

The server must be a Linux host; the launcher bind-mounts host paths and the Docker socket directly.

## Runtime Directory

```bash
sudo mkdir -p /srv/propr/{data,logs,repos}
sudo chown -R "$USER" /srv/propr
cd /srv/propr
```

Place the GitHub App private key there and restrict it:

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

## Configure GitHub Webhooks (Optional)

By default ProPR polls GitHub for labeled issues every 60 seconds (`POLLING_INTERVAL_MS`, milliseconds). On a server with a public endpoint, webhooks deliver events immediately instead.

Add to `.env`:

```bash
ENABLE_GITHUB_WEBHOOKS=true
GH_WEBHOOK_SECRET=generate-a-strong-webhook-secret
```

`GH_WEBHOOK_SECRET` is mandatory when webhooks are enabled: the API refuses to start if `ENABLE_GITHUB_WEBHOOKS=true` is set without a secret, because unsigned webhook traffic would be rejected anyway.

The webhook endpoint is `POST /webhook` on the API service (port `4000`). Route it through your reverse proxy, for example with nginx:

```nginx
location /webhook {
    proxy_pass http://127.0.0.1:4000/webhook;
}
```

In your GitHub App settings, set the webhook URL to `https://propr.example.com/webhook` and the webhook secret to the same `GH_WEBHOOK_SECRET` value.

If you cannot expose a public endpoint, the optional hosted GitHub App at propr.dev can handle webhook routing and event replays for your installation instead.

## Start The Stack

On the server, the CLI control plane is the simplest path (Node.js 22+):

```bash
sudo mkdir -p /srv/propr && sudo chown "$USER" /srv/propr && cd /srv/propr
propr init stack               # scaffold .env + data/ logs/ repos/
# configure GitHub auth in .env: own App (GH_APP_ID, GH_INSTALLATION_ID,
# HOST_GH_PRIVATE_KEY) or a shared App via `propr relay enroll`
propr check
propr start --no-tui
```

Configure GitHub auth in `.env` before `propr check` — either your own App
(`GH_APP_ID`, `GH_INSTALLATION_ID`, `HOST_GH_PRIVATE_KEY`) or a shared App via
`propr relay enroll`. See [GitHub Authentication](../operations/github-auth.md)
for the full walkthrough.

`propr status`, `propr stop`, and `propr start --restart` manage the running stack. Prefer a container-only host? Use the launcher below instead.

## Alternative: Start The Launcher

Use the same launcher command as local setup, but run it from `/srv/propr` or your chosen server directory. All `PROPR_*` and `HOST_*` paths must be absolute; the launcher does not expand `~`.

Authenticate Antigravity on the host first with `agy login`; the launcher mounts `HOST_ANTIGRAVITY_DIR="$HOME/.gemini"` for Antigravity agent runs. For OpenCode and Mistral Vibe credential preparation (including the required `/tmp/propr-vibe-prompts` directory), see [Local Setup](./setup-local.md#prepare-agent-credentials).

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
  -e HOST_VIBE_PROMPT_CACHE_DIR=/tmp/propr-vibe-prompts \
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
npm install -g @propr/cli
propr remote https://propr.example.com   # the API origin behind your proxy
propr login <personal-access-token>
propr repo add owner/repo
propr agent add my-claude -t claude -m opus48 -d opus48
propr remote-status
```

CLI authentication uses GitHub Bearer tokens and is enabled by default (`ENABLE_BEARER_AUTH=true`).

For ongoing server care, see [Maintenance And Troubleshooting](../operations/maintenance.md).
