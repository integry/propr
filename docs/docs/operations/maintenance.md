# Maintenance And Troubleshooting

Use this page after ProPR is already running.

## Updating

The canonical update flow is described in [Deployment](./deployment.md); the short version:

For launcher-based installs, pull the newer launcher image and restart the stack:

```bash
docker pull propr/launcher:latest
```

Stop the running launcher (Ctrl-C, or stop its container — it tears down the stack containers on shutdown), then start it again with your usual `docker run` command from [Production Deployment](./deployment.md). The launcher's manifest pins exact image versions, so the newer launcher pulls the newer service images and unified agent image.

For source-based Compose deployments:

```bash
git pull
npm ci
npm run compose:up
```

`npm run compose:up` runs `scripts/compose.sh up`, which rebuilds and restarts the stack from `docker-compose.yml` plus `docker-compose.dev.yml`. Use `npm run compose:build` to force a full image rebuild and `npm run compose:down` to stop the stack.

### Upgrading Safely

Service images and the unified agent image are pinned to the release version of the control plane that starts them: the CLI and launcher manifests pin exact image versions, so choosing the control-plane version chooses the whole stack version. `propr/launcher:latest` and a plain `npm update -g propr-cli` track the newest release; to pin, install an exact CLI version (`npm install -g propr-cli@<version>`) and update deliberately.

A safe upgrade, in order:

1. Take a [backup](#backups) — at minimum the SQLite database and `.env`.
2. Update the control plane and restart (the flows above); persistent state in `data/`, `repos/`, and the Redis volume is unaffected.
3. From a source checkout, apply pending [database migrations](#database-migrations) with `npm run db:migrate`.

After the upgrade, the API's public `/api/compatibility` endpoint reports the stack version and the API/UI compatibility contract — the hosted UI checks it before login and stops at a clear version-mismatch screen rather than running against an incompatible stack. `/api/status` includes the same metadata for authenticated diagnostics.

The unified agent image replaces the older per-agent image families. After confirming the upgraded worker is healthy, reclaim disk used by stale local agent images with `docker image ls 'propr/*agent*'` and remove only obsolete per-agent repositories that are no longer referenced by your running containers or configuration.

**Rollback:** re-pin the previous version (`npm install -g propr-cli@<previous>`, or the previous launcher image) and restart from the runtime directory. Treat database migrations as forward-only in practice: the Knex migrations define `down` steps, but no packaged command runs them — `npm run db:migrate` only applies `migrate:latest` — so the reliable way to roll back the database is restoring the SQLite backup taken in step 1.

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
- Per-LLM-call records are stored in the SQLite `llm_logs` table and shown on the LLM Log page; see [Metrics](./metrics.md).
- Set `LOG_LEVEL=debug` in `.env` for more verbose service logs.

## Backups

Back up:

- The SQLite database (`data/propr.sqlite`, including `-wal`/`-shm` files) — the primary application state. Copy it while the stack is stopped, or use `sqlite3 propr.sqlite ".backup backup.sqlite"` for a consistent snapshot of a live database (WAL mode is enabled)
- Production `.env` and the GitHub App private key (or the secret source that produces them)
- The `propr-redis-data` Docker volume if you want queue state and sessions to survive a restore
- Logs, if you need history

`repos/` is a working area: clones are re-created on demand and worktrees are per-task, so it needs no backup. Do not back up only `repos/` and `logs/` — they do not contain the application state. The runtime directory these paths live in is described in [Deployment → Runtime Directory Layout](./deployment.md#runtime-directory-layout).

## Repository And Worktree Cleanup

ProPR keeps Git state under `repos/`:

- `repos/clones/` — cached clones, one per monitored repository (`GIT_CLONES_BASE_PATH`)
- `repos/worktrees/` — per-task worktrees (`GIT_WORKTREES_BASE_PATH`)

Worktrees are removed automatically after each task finishes (controlled by `WORKTREE_RETENTION_STRATEGY`, default `always_delete`; failed-task worktrees may be retained briefly with a `.retention-info.json` marker for inspection). If disk usage grows from leftover state, stop the stack and delete stale entries under `repos/worktrees/`; cached clones can also be deleted and are re-created on the next task for that repository.

## Common Issues

Symptom-by-symptom diagnosis has moved to the dedicated [Troubleshooting](./troubleshooting.md) page. It covers the scenarios that used to live here — [Dashboard Shows Unauthorized](./troubleshooting.md#dashboard-shows-unauthorized), [Worker Not Processing Issues](./troubleshooting.md#worker-not-processing-issues), and [Metrics Not Updating](./troubleshooting.md#metrics-not-updating) — plus setup failures, agent run failures, stuck queues, and hosted UI tunnel problems.

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

## Teardown

To remove ProPR from a host completely:

1. **Stop the stack.** `propr stop` stops and removes the stack containers (use `--keep` only if you want them retained). For launcher installs, stop the launcher container — it stops and removes the stack containers on shutdown. For source Compose installs, run `npm run compose:down`.

2. **Remove the Redis volume.** Stopping the stack leaves queue state and sessions behind in a Docker volume:

   ```bash
   docker volume rm propr-redis-data     # CLI/launcher installs; the prefix follows PROPR_STACK (default: propr)
   ```

   For source Compose installs, `docker compose down --volumes` removes the compose-managed `redis_data` volume.

3. **Revoke hosted credentials** (relay mode and hosted UI tunnel only), before deleting `.env`. From the stack directory:

   ```bash
   propr relay list
   propr relay revoke <id>
   ```

   Relay tokens can also be managed from the ProPR Connect dashboard. If you used the hosted UI tunnel, deprovision the tunnel in ProPR Connect — `PROPR_UI_TUNNEL_TOKEN` is a live Cloudflare credential.

4. **Delete the runtime directory** — `data/`, `logs/`, `repos/`, plus `.env` and the GitHub App private key (own-App mode):

   ```bash
   rm -rf /srv/propr     # or your propr-deploy directory
   ```

5. **Uninstall the GitHub App.** Remove the ProPR GitHub App installation (the shared hosted App, or your own) from the organization or repositories in GitHub settings. If you registered a GitHub OAuth App only for this install's dashboard login, delete that too.

6. **Uninstall the CLI:**

   ```bash
   npm uninstall -g propr-cli    # use the same sudo convention as the install
   ```

Optionally reclaim disk from the pulled images: list them with `docker images 'propr/*'` and remove with `docker rmi`.
