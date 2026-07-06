---
sidebar_position: 11
title: Troubleshooting
---

# Troubleshooting

This page is organized by symptom. Find what you are seeing, check the likely causes, run the listed commands, and apply the fix. For routine care — updates, backups, log locations, tuning — see [Maintenance](./maintenance.md).

## Where To Look First

Before digging into a specific symptom, these give you the fastest read on the system:

```bash
propr check              # verifies Docker, images, agents, and GitHub auth mode (--verify smoke-tests agents)
propr status             # local stack status, including tunnel reachability
propr remote-status      # backend health: daemon, workers, Redis, GitHub auth
propr queue              # queue statistics
```

The `/api/status` endpoint (shown in the Web UI header) reports daemon heartbeat, active worker count, Redis connectivity, GitHub App configuration, and per-agent health checks.

Logs, in order of usefulness:

```bash
docker ps
docker logs -f propr-daemon    # launcher installs prefix containers with propr-
docker logs -f propr-worker
docker logs -f propr-api
```

- The host `logs/` directory (`PROPR_LOGS_DIR`) is mounted into the service containers at `/usr/src/app/logs`.
- Agent session logs are written under `/tmp/claude-logs` and surfaced per task in the Web UI task detail view.
- Per-LLM-call records: `propr log list` (`--failed` for failures only), or the LLM Log page; see [Metrics](./metrics.md#the-llm-log-page).
- Set `LOG_LEVEL=debug` in `.env` for more verbose service logs.

## `propr check` Fails Or The Stack Will Not Start

**Symptom:** `propr check` (or bare `propr`, which runs the same environment checks) exits nonzero, or `propr start` / the launcher fails before the stack is up.

Likely causes, what to check, and fixes:

- **Docker is unavailable or the host is unsupported.** The stack bind-mounts host paths and the Docker socket directly, so it requires a Linux host with Docker — it does not work under Docker Desktop on macOS or Windows. Use the Compose-based [Source Development Setup](../tutorials/setup-source.md) there.
- **The CLI on PATH is not the one you installed.** Run `which propr && propr --version`. If `npm install -g` failed with `EACCES`, your global npm prefix is root-owned — prefix the command with `sudo`, and use the same convention every time you install or update (`npm prefix -g` shows which prefix is in effect). Mixing `sudo` and non-`sudo` installs can update a different copy of the CLI.
- **Missing or placeholder `.env` configuration.** `propr check` reports the detected [GitHub auth mode](./github-auth.md) (own App, relay, or demo) and flags missing or placeholder values. Re-running `propr setup` is safe at any time — it skips satisfied steps, never overwrites `.env` wholesale, and never deletes data.
- **Mixed private-key variables (own-App mode).** `HOST_GH_PRIVATE_KEY` is a host path for the CLI start path; `GH_PRIVATE_KEY_PATH` is the in-container path for the launcher. Set exactly one, matching how you start the stack — mixing them is a common migration mistake.
- **Relative or `~` paths in launcher variables.** All `PROPR_*` and `HOST_*` paths must be absolute; the launcher and `.env` parsing do not expand `~` or `$HOME`.
- **Agent credentials not detected or unreadable.** `propr init stack` auto-detects `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, and `~/.vibe`. Authenticate with each provider's CLI on the host first (for example `claude login`, `agy login`), and create the directories before starting — Docker creates missing mount directories as root-owned, which can cause write failures. Vibe additionally needs its prompt cache directory to exist: `mkdir -p "/tmp/propr-vibe-prompts-$(id -u)"`. `propr check --verify` smoke-tests each agent image and pinpoints the broken one.
- **Tunnel enabled without a token.** `propr check` fails when `PROPR_UI_TUNNEL_ENABLED` is set without `PROPR_UI_TUNNEL_TOKEN`. Run `propr tunnel setup` with the values from ProPR Connect, or remove the flag.
- **`direct_webhook` mode without a secret.** The API refuses to start in `GITHUB_EVENT_INTAKE_MODE=direct_webhook` without `GH_WEBHOOK_SECRET` (the secret is unused in the other intake modes).
- **`propr setup` exits immediately in CI or a pipe.** When stdin is not a terminal, setup cannot prompt. Scaffold non-interactively instead: `propr init stack`, edit `<root>/.env`, then `propr start --no-tui`.

## Dashboard Shows Unauthorized

**Symptom:** the Web UI login fails or every request comes back unauthorized.

Check the GitHub OAuth App configuration in `.env`: `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`, `GH_OAUTH_CALLBACK_URL` (must match the OAuth App's callback URL exactly), `SESSION_SECRET`, and `FRONTEND_URL`. Sessions are stored in Redis, so a Redis outage also invalidates logins — confirm the Redis container is up with `docker ps` and check Redis connectivity on `/api/status`.

If you use the hosted UI tunnel, the OAuth callback lives on the **proxy host** (`https://t-<id>.propr.dev/api/auth/github/callback`) and must be registered in the GitHub OAuth App; also note that enabling the tunnel on an already-running stack leaves the API with its pre-tunnel localhost URLs until you run `propr start --restart` (see [tunnel problems](#hosted-ui-tunnel-not-working) below).

After correcting `.env`, restart the stack (`propr start --restart`) so the API picks up the new values.

## Worker Not Processing Issues

**Symptom:** you add a processing label to an issue and no task ever appears.

Likely causes and what to check:

- **A stack component is down.** `/api/status` (or `propr remote-status`) reports daemon heartbeat, active worker count, Redis connectivity, GitHub App configuration, and per-agent health checks. Then read `docker logs propr-daemon` and `docker logs propr-worker`.
- **Repository or agent configuration.** Confirm the repository is monitored and enabled (`propr repo list`, `propr repo toggle owner/repo --enable`), the label you applied matches the configured processing labels (`PRIMARY_PROCESSING_LABELS`), and at least one agent is enabled with valid credentials.
- **The user is not allowed.** `GITHUB_USER_WHITELIST` and `GITHUB_USER_BLACKLIST` control who can trigger work; bot comments are ignored.
- **Intake latency or exhausted API budget (polling mode).** With `GITHUB_EVENT_INTAKE_MODE=polling`, detection waits up to one polling interval (`POLLING_INTERVAL_MS`, default 60 s). A large install can exhaust the GitHub App installation's hourly API budget, after which GitHub rejects requests until the window resets — ProPR retries with exponential backoff and logs a warning suggesting a longer interval. See [Polling And GitHub API Rate Limits](./deployment.md#polling-and-github-api-rate-limits).
- **Webhook not reaching the API (`direct_webhook` mode).** GitHub must deliver to `POST /webhook` on the API service (port 4000) through your reverse proxy, with the same `GH_WEBHOOK_SECRET` configured on both sides. Webhook delivery has no periodic backstop, so a missed event relies on GitHub's redelivery.

## A PR Comment Does Not Trigger Follow-Up Work

**Symptom:** you comment on a pull request and nothing happens.

Likely causes:

- **Natural comments need a trigger.** The PR must carry a processing label (for example `AI` or `propr`), or the comment must contain a trigger keyword from `PR_FOLLOWUP_TRIGGER_KEYWORDS` (for example `!propr`). Slash commands like `/review` and `/fix` are different: from an allowed author they run directly, with no processing label required.
- **The author is not allowed.** Bot comments are ignored, and `GITHUB_USER_WHITELIST` / `GITHUB_USER_BLACKLIST` control who can trigger work.
- **A job for the same PR is already running.** Comments posted meanwhile are batched and handled together once the active job finishes — wait for it rather than reposting.

See [PR Automation And Fine-Tuning](../features/pr-followup.md) for the full pickup rules.

## An Agent Run Failed

**Symptom:** a task shows failed in the Web UI, or the issue carries a `<trigger>-failed-*` state label (for example `AI-failed-post-processing` — the suffix names the phase that failed).

Where to look:

- **The task record.** Open the task detail view first: it shows the failure message, current state, selected agent and model, the exact prompt sent to the agent (View Prompt), execution log files (View Logs), the live execution event log, and per-file diffs. `propr task get <task-id>` shows the same details with run history from the CLI.
- **Agent session logs** under `/tmp/claude-logs`, surfaced per task in the task detail view.
- **The LLM Log page** (or `propr log list --failed`) for per-call status when the failure is a model call.

Then check credentials, branch settings, and agent configuration — the usual culprits for repeated failures. Transient git and GitHub failures retry automatically with exponential backoff, so a one-off network error often needs no action at all.

Recovery runs through the PR conversation:

- Add a clearer follow-up comment with stronger instructions.
- `/switch <model-id>` to change the PR's model going forward, or `/use <model-id>` for a one-off task with a different model.
- `/review` then `/fix`, or `/ultrafix` for an automated review-fix loop (remove the `ultrafix` PR label to stop it).
- Re-run with a smaller scope — see [Work Splitting](../features/work-splitting.md).
- Undo a bad commit with `propr task revert owner/repo <pr> <sha> <issue>`, which runs a signed system task (authorized via `SYSTEM_TASK_SECRET`) that resets the branch and force-pushes.

## Jobs Stuck In The Queue

**Symptom:** jobs sit in `processing` or `failed` and queue counts stop moving.

What to check:

```bash
propr queue                      # queue statistics
docker logs -f propr-worker      # is anything being picked up?
```

Queue counts come from BullMQ in Redis (`/api/queue/stats`), so also confirm Redis connectivity on `/api/status`. To inspect Redis directly, use scan-based queries — avoid `KEYS '*'` on production:

```bash
docker exec propr-redis redis-cli --scan --pattern 'bull:*'
```

**Fix:** reset the queue from a source checkout:

```bash
npm run daemon:reset       # against a production build
npm run daemon:reset:dev   # development (tsx, debug logging)
```

The reset clears all Redis queue data (waiting, active, completed, and failed jobs) and removes processing/done state labels from GitHub issues, so issues can be reprocessed from a clean state. `npm run worker:reset` and `npm run worker:reset:dev` perform the equivalent reset before starting a worker. See [Resetting Queue State](./maintenance.md#resetting-queue-state).

## Metrics Not Updating

**Symptom:** dashboard statistics or queue counts stop changing while work is clearly happening.

Check that Redis is running, workers are processing jobs, task records are being written to SQLite, and the API container logs are clean. Dashboard statistics come from the SQLite task tables (`/api/stats/*`) and queue counts come from BullMQ in Redis (`/api/queue/stats`).

## Hosted UI Tunnel Not Working

**Symptom:** the hosted UI at `app.propr.dev` cannot reach your stack, or `propr tunnel verify` fails.

Start with the verifier and read its checks:

```bash
propr tunnel verify
```

It runs four checks against the public proxy URL and exits nonzero if any fail:

- **The cloudflared sidecar container is running** — if not, the tunnel was never started or was stopped with `propr tunnel off`.
- **`GET <url>/api/status` returns an OK or auth-expected response** — the API is reachable through the tunnel. This is also how `propr status` probes tunnel reachability.
- **`GET <url>/` returns 404** — this is **expected**: propr-routing forwards only `/api/*` and `/socket.io/*`, so the root URL is intentionally not routed. A 404 at the root is not an error, and neither is a 404 on the legacy `/health` path.
- **`GET <url>/socket.io/` is reachable** — live updates are not blocked at Cloudflare ingress.

Likely causes and fixes:

- **No token configured.** Starting the tunnel always requires `PROPR_UI_TUNNEL_TOKEN`; `propr tunnel on` fails clearly without one. Run the `propr tunnel setup --token ... --url ... --start` command shown in ProPR Connect.
- **The core stack is not running.** `propr tunnel on` refuses to start the sidecar when the stack is down — cloudflared would point at an unavailable `api:4000` and look superficially healthy. Run `propr start` first (or pass `--force` deliberately).
- **Tunnel enabled on an already-running stack.** `propr tunnel on` starts only the sidecar; the API and workers keep the `API_PUBLIC_URL` / `FRONTEND_URL` they started with, so OAuth redirects, cookie security, and attachment links still point at localhost values. Run `propr start --restart`, or use `propr tunnel setup --start`, which recreates the stack with the hosted URLs applied.
- **The hosted UI stops at a version-mismatch screen.** The hosted UI calls the public `/api/compatibility` endpoint before login; a definitive contract mismatch blocks with a clear screen instead of running against incompatible endpoints. Upgrade the stack — see [Updating](./maintenance.md#updating).
- **Something else uses host port 4000.** Irrelevant to the tunnel: Cloudflare forwards to the Docker-internal `http://api:4000` and bypasses the published host port entirely, so the two cannot conflict.

For the full variable reference and enablement semantics, see [ProPR CLI → Hosted UI Tunnel](../features/propr-cli.md#hosted-ui-tunnel) and [Production Deployment → Hosted UI Tunnel](./deployment.md#hosted-ui-tunnel).
