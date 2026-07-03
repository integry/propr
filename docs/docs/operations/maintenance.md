# Maintenance And Troubleshooting

Use this page after ProPR is already running.

## Updating

The canonical update flow is described in [Deployment](./deployment.md); the short version:

For launcher-based installs, pull the newer launcher image and restart the stack:

```bash
docker pull propr/launcher:latest
```

Stop the running launcher (Ctrl-C, or stop its container — it tears down the stack containers on shutdown), then start it again with your usual `docker run` command from [Production Deployment](./deployment.md). The launcher's manifest pins exact image versions, so the newer launcher pulls the newer service and agent images.

For source-based Compose deployments:

```bash
git pull
npm ci
npm run compose:up
```

`npm run compose:up` runs `scripts/compose.sh up`, which rebuilds and restarts the stack from `docker-compose.yml` plus `docker-compose.dev.yml`. Use `npm run compose:build` to force a full image rebuild and `npm run compose:down` to stop the stack.

## Database Migrations

The SQLite schema is managed with Knex migrations (`knexfile.ts`, migrations in `packages/core/src/db/migrations/`). After updating a source checkout, apply pending migrations:

```bash
npm run db:migrate
```

This runs `npx knex migrate:latest --knexfile ./knexfile.ts` against the database at `DB_FILENAME` (default `./data/propr.sqlite`).

## Resetting Queue State

If jobs are stuck in failed or processing states, reset the queue:

```bash
# Development (tsx, debug logging)
npm run daemon:reset:dev

# Against a production build
npm run daemon:reset
```

The reset clears all Redis queue data (waiting, active, completed, and failed jobs) and removes processing/done state labels from GitHub issues, so issues can be reprocessed from a clean state. `npm run worker:reset` and `npm run worker:reset:dev` perform the equivalent reset before starting a worker.

## Logs

Service processes log structured JSON to stdout. For launcher installs, the containers are named with the `propr-` prefix:

```bash
docker ps
docker logs -f propr-daemon
docker logs -f propr-worker
docker logs -f propr-api
```

Other locations:

- The host `logs/` directory (`PROPR_LOGS_DIR`) is mounted into the service containers at `/usr/src/app/logs`.
- Agent session logs are written under `/tmp/claude-logs` (mounted into worker, analysis, and API containers), and are surfaced per task in the Web UI task detail view and through the `/api/execution/...` endpoints.
- Per-LLM-call records are stored in the SQLite `llm_logs` table and shown on the LLM Log page; see [LLM Metrics](./llm-metrics.md).
- Set `LOG_LEVEL=debug` in `.env` for more verbose service logs.

## Backups

Deployment-time backup planning (what to persist and where it lives) is covered in [Deployment](./deployment.md); this section is the operational checklist.

Back up:

- The SQLite database (`data/propr.sqlite`, including `-wal`/`-shm` files; use `sqlite3 propr.sqlite ".backup backup.sqlite"` for a live snapshot)
- Production `.env` and the GitHub App private key (or their secret source)
- The `propr-redis-data` Docker volume if you want to preserve queue state and sessions
- Logs, if you need history

Do not back up only `repos/` and `logs/`. They do not contain the application state.

## Repository And Worktree Cleanup

ProPR keeps Git state under `repos/`:

- `repos/clones/` — cached clones, one per monitored repository (`GIT_CLONES_BASE_PATH`)
- `repos/worktrees/` — per-task worktrees (`GIT_WORKTREES_BASE_PATH`)

Worktrees are removed automatically after each task finishes (controlled by `WORKTREE_RETENTION_STRATEGY`, default `always_delete`; failed-task worktrees may be retained briefly with a `.retention-info.json` marker for inspection). If disk usage grows from leftover state, stop the stack and delete stale entries under `repos/worktrees/`; cached clones can also be deleted and are re-created on the next task for that repository.

## Common Issues

### Dashboard Shows Unauthorized

Check the GitHub OAuth App configuration: `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`, `GH_OAUTH_CALLBACK_URL` (must match the OAuth App's callback URL exactly), `SESSION_SECRET`, and `FRONTEND_URL`. Sessions are stored in Redis, so a Redis outage also invalidates logins.

### Worker Not Processing Issues

Check Redis, GitHub App permissions, worker logs, agent credentials, repository settings, labels, and enabled agents. The `/api/status` endpoint (shown in the Web UI header) reports daemon heartbeat, active worker count, Redis connectivity, GitHub App configuration, and per-agent health checks.

### Metrics Not Updating

Check that Redis is running, workers are processing jobs, task records are being written to SQLite, and the API container logs are clean. Dashboard statistics come from the SQLite task tables (`/api/stats/*`) and queue counts come from BullMQ in Redis (`/api/queue/stats`).

## Debugging

Start with:

```bash
docker ps
docker logs <container>
```

Use Redis inspection carefully on production systems. Avoid `KEYS '*'`; use scan-based queries instead:

```bash
# Launcher install
docker exec propr-redis redis-cli --scan --pattern 'bull:*'

# Source Compose install
docker compose exec redis redis-cli --scan --pattern 'bull:*'
```

## Security Checks

- Use strong secrets (`SESSION_SECRET`, `GH_WEBHOOK_SECRET`, `SYSTEM_TASK_SECRET`).
- Enable HTTPS in production.
- Restrict access to the Docker socket.
- Restrict mounted credential directories.
- Keep images updated.
- Test restore procedures.

## Tuning

Increase concurrency only when the bottleneck is clear. The relevant knobs:

- `WORKER_CONCURRENCY` — concurrent jobs per worker (code default `5`; the shipped `.env.example` sets `2`)
- `POLLING_INTERVAL_MS` (default `60000`) — issue polling frequency
- Agent timeouts: `CLAUDE_TIMEOUT_MS`, `CODEX_TIMEOUT_MS`, `ANTIGRAVITY_TIMEOUT_MS`, `OPENCODE_TIMEOUT_MS`, `VIBE_TIMEOUT_MS`

Watch queue depth, task duration, provider rate limits, disk usage, CPU, and memory. For provider capacity pressure, see the [Agent Tank](./agent-tank.md) usage sidebar.
