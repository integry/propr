---
sidebar_label: "Maintenance And Troubleshooting"
title: "Maintain, update, back up, and remove ProPR"
description: "Update your stack, check logs and storage, tune operations, and follow the teardown guide to remove ProPR artifacts."
---
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

Restart all service containers in the same upgrade: while versions are mixed, a [storage lifecycle gate](#the-storage-lifecycle-gate) created by an older service carries no holder record and is removed after 10 minutes regardless of whether that service is still inside its operation.

After the upgrade, the API's public `/api/compatibility` endpoint reports the stack version and the API/UI compatibility contract — the hosted UI checks it before login and stops at a clear version-mismatch screen rather than running against an incompatible stack. `/api/status` includes the same metadata for authenticated diagnostics.

The unified agent image replaces the older per-agent image families. After confirming the upgraded worker is healthy, reclaim disk used by stale local agent images with `docker image ls 'propr/*agent*'` and remove only obsolete per-agent repositories that are no longer referenced by your running containers or configuration.

If installation-wide runtime packages are enabled, verify their derived images after the upgrade or any base-image replacement:

```bash
propr runtime packages verify
```

This check is read-only and uses the same current base-image configuration as agent execution. It exits nonzero for stale lineage, missing derived images or packages, pinned-version mismatches, incorrect ProPR labels/final users, and desired-versus-active drift. Repair an unhealthy profile with `propr runtime packages apply --wait`, then verify again. Use `--json` for structured per-image diagnostics. A disabled/empty profile succeeds explicitly without starting a check container.

### Refreshing agent image package pins

`Dockerfile.agent` pins its Debian packages with `*_VERSION_PREFIX` build args and verifies the GitHub CLI apt keyring against `GITHUBCLI_KEYRING_SHA256`. Two external events can break the base-stage build (which surfaces as a failed local build fallback when the registry image is unavailable):

- Debian moves a package beyond a pinned prefix. The build fails with `No apt version found for <package> with prefix <prefix>`. Refresh the affected `*_VERSION_PREFIX` args from the current `node:22-bookworm-slim` archive (`docker run --rm node:22-bookworm-slim sh -c 'apt-get update -qq && apt-cache madison <package>'`) and rebuild.
- GitHub rotates the CLI keyring. The `sha256sum -c` step fails. Re-download `https://cli.github.com/packages/githubcli-archive-keyring.gpg`, verify it out of band, and update `GITHUBCLI_KEYRING_SHA256`.

Only `gh` has a latest-version fallback (its repo drops old releases); every other pin fails the build hard, so treat a failing agent-image build in CI as a signal to refresh pins rather than a transient error.

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
- Agent session logs are written under `/tmp/claude-logs` on the host (shared with the worker containers and the agent containers they start), and are surfaced per task in the Web UI task detail view and through the `/api/execution/...` endpoints.
- Per-LLM-call records are stored in the SQLite `llm_logs` table and shown on the LLM Log page; see [Metrics](./metrics.md).
- Set `LOG_LEVEL=debug` in `.env` for more verbose service logs.

## Backups

Back up:

- The SQLite database (`data/propr.sqlite`, including `-wal`/`-shm` files) — the primary application state. Copy it while the stack is stopped, or use `sqlite3 propr.sqlite ".backup backup.sqlite"` for a consistent snapshot of a live database (WAL mode is enabled)
- Production `.env` and the GitHub App private key (or the secret source that produces them)
- ProPR's managed agent credential root if you use direct login (`~/.propr/agent-credentials` for CLI-started, native and Compose installs, or `PROPR_DATA_DIR/agent-credentials` for the launcher container)
- The `propr-redis-data` Docker volume if you want queue state and sessions to survive a restore
- Logs, if you need history

Git clones and worktrees (under `/tmp/git-processor` by default) can contain unpublished commits, stashes, ignored/private files and recovery state. Include these directories, their Git registrations, and salvage records/bundles in a recoverable backup; a remote clone alone is insufficient. Do not back up only `repos/` and `logs/` — they do not contain the application state. The runtime directory these paths live in is described in [Deployment → Runtime Directory Layout](./deployment.md#runtime-directory-layout).

## Repository And Worktree Cleanup

ProPR keeps Git state under `/tmp/git-processor` on the host. The launcher mounts that path at the same location in every service container, so agent containers can bind-mount worktrees by their host path:

- `/tmp/git-processor/clones/` — cached clones, one per monitored repository (`GIT_CLONES_BASE_PATH`)
- `/tmp/git-processor/worktrees/` — per-task worktrees (`GIT_WORKTREES_BASE_PATH`)

Each task and follow-up gets its own worktree, usually with its own `node_modules` and build output (often 1–2 GB). When a job finishes, ProPR removes its worktree (checkout and registration, with `git worktree remove`) only if nothing in it would be lost:

- no uncommitted, staged or untracked files (ignored files such as `node_modules` and build output don't count);
- `HEAD` is contained in a local branch, remote-tracking ref or tag;
- no tracked entries flagged assume-unchanged or skip-worktree; no merge, rebase, cherry-pick/revert sequence or bisect in progress, the worktree isn't locked and has no submodules;
- it isn't kept by push salvage.

Sparse checkouts and indexes using skip-worktree or assume-unchanged are never automatically disposable (`hidden_index_entries`).

Branches are never deleted. Any worktree that fails a check is kept, with its HEAD detached so the branch is free for the next job. With `WORKTREE_RETENTION_STRATEGY=keep_on_failure` or `keep_for_hours`, failed jobs keep their worktree even when it passes the checks; `always_keep` turns automatic removal off entirely.

The daemon also sweeps the worktree root at startup and every `WORKTREE_SWEEP_INTERVAL_MS` (default 1 hour). This clears worktrees left by attempts killed before cleanup, and those created before this behavior existed. It removes a worktree only when it passes the same checks and also: Git has seen no activity in it for `WORKTREE_RETENTION_HOURS` (default 24); no unfinished or unreconciled goal or unreleased follow-up handoff refers to it, and no task in its repository has a nonterminal or unknown durable state; and no running container mounts it. If Docker can't be queried, the sweep removes nothing. Completed, reconciled goals cannot resume or reuse their saved checkout; paused and unreconciled goals remain protected.

To clear the backlog sooner after deployment, lower `WORKTREE_RETENTION_HOURS` (for example, to `2`) and restart the daemon. A clean checkout held without a mounted container or a live durable task/goal/handoff reference is protected only by its idle age. Keep the threshold above the longest such host-side wait, including long CI waits in external or unrecorded flows.

Both workers and the daemon need the Docker CLI on PATH and access to the Docker socket. Startup emits `Worktree reclamation disabled: Docker unavailable` if the probe fails; each cleanup still refreshes liveness. Service mounts of the shared root are exempt only for containers labelled `propr.service` or `com.docker.compose.service` with `daemon`, `worker`, `indexing-worker` or `api`, independently of their command. Only deployment services should carry those labels.

The daemon needs access to the Docker socket, the clone/worktree roots at their host paths, and the same `PUSH_RESCUE_WORKTREE_RECORD_DIR` as workers. The supplied Compose and packaged launcher mount `/var/run/docker.sock` and `/tmp/git-processor` for the daemon; custom root paths need equivalent mounts. An unreadable worktree root logs a skipped-sweep warning.

Job-end removal also retains any checkout named by an unreleased follow-up handoff, including committed work awaiting publication.

### The storage lifecycle gate

Storage changes on a host are serialized by one lock shared by all service containers: the directory `<clone root>/../.clones-storage-lifecycle/gate` (by default `/tmp/git-processor/.clones-storage-lifecycle/gate`). It is held briefly: a job, an indexing scan or a retrieval holds it only while it is admitted and while its claim is released, and runs under a reader claim in between, while the gate is free; the daemon's cleanup and sweeps and registry updates hold it for the whole operation. So the holder named in a wait warning is usually a brief admission or a cleanup in progress, not a running job.

The holder's record (container id, pid, process start time) sits inside the gate as `owner-<token>`, with a token unique to that acquisition. The record is in place before the directory becomes the gate: the holder prepares `gate-<token>` beside it with the record inside and renames that directory onto `gate`, a rename that fails while the gate exists and replaces it only while it is empty. A process waiting for the gate reads the record once the wait exceeds 5 seconds and then probes the holder every 5 seconds; when the holder is gone (its container restarted or was removed, or its pid no longer exists in the same container) the waiter removes the holder's record under its own name and renames its own prepared gate onto the emptied directory, so a crashed process cannot freeze the others. Because the record is removed by name and only an empty directory can be replaced, a waiter whose probe or inspection answers late cannot remove or take over the gate of a process that has reclaimed and retaken it in the meantime. Only the services' Docker containers can be probed: on a host running the services natively (a development install), a holder is never provably gone, so an owned gate left by a crash there is not reclaimed automatically and needs the manual unblock below.

A gate with no owner record is treated as abandoned after 10 minutes. Such a gate was left either by a holder that died while releasing it, or by a service from a ProPR version older than the record. During a mixed-version upgrade this is a bounded trade-off: the older service's gate is removed 10 minutes after it was created even if that service is still inside its operation, which is far longer than any gated operation runs (the API's cleanup has a 60-second deadline). Finish the upgrade of all service containers before relying on the gate across versions.

Waits are logged every minute as `Still waiting for the storage lifecycle gate after Ns (held by <container> pid <pid>)`, and a reclaim as `Removed an abandoned storage lifecycle gate`. Jobs that sit in `active` without a log line and no such warnings point at an older ProPR version or a native install; removing the stale `gate` directory by hand unblocks it. A leftover `gate-<token>` directory beside it belongs to a process that died before taking the gate and can be removed as well.

### Stuck follow-ups settle themselves

A follow-up handoff held for an operator blocks new follow-ups on its pull request. Holds that can no longer publish anything are settled automatically. ProPR then posts a short note on the pull request, and the held attempt's worktree stays on disk.

- **Same task, after a failure.** The task's automatic retry takes over its own failed attempt. This applies once the attempt has given up its branch, for example after a rejected push was salvaged to a rescue ref.
- **Ended attempt, new comment.** A new comment releases a hold whose attempt has ended when the attempt was cancelled, or its worktree left or lost the branch (`worktree_not_on_branch`, `worktree_missing`, `worktree_restore_failed`), or newer commits overtook it (`head_advanced_externally`, `recorded_commit_mismatch`). A cancelled request's comments are withdrawn, never run.
- **Background pass.** Such holds older than `FOLLOWUP_HOLD_AUTO_RELEASE_HOURS` (default 24) are released even without a new comment. A hold kept only because its worktree was deleted is retried instead, and recovery rebuilds the worktree from the branch.

Holds that need a decision stay for an operator: an unconfirmed usage-limit retry, fork publication, and pull request binding mismatches.

**Unpublished commits survive a release, and are never inherited.** A release only frees the branch. When the held worktree still holds commits that never reached the pull request (typically after `head_advanced_externally` or `recorded_commit_mismatch`, or a cancelled attempt that had committed), the worktree is detached in place with those commits checked out. The clone's local branch is then restarted from the pull request head, because a reused branch keeps commits it is ahead by and the next job would otherwise inherit and publish the released work. The commits stay reachable from the detached checkout, which the idle sweep keeps because its HEAD is not stored in Git, and from a backup ref `refs/propr/superseded/<branch>/<time>-<short sha>` in the clone. To find them: `GET /api/admin/followup-handoffs` names the retained worktree path while the hold stands; afterwards `git -C <clone> worktree list` shows the checkout as `(detached HEAD)`, `git -C <worktree> log --oneline origin/<branch>..HEAD` lists the unpublished commits, and `git -C <clone> for-each-ref refs/propr/superseded/<branch>/` lists the backups. If the folder itself was deleted, its registration is detached at the last commit instead: `git -C <clone> worktree list --porcelain` still names it, and the backup ref keeps the commit. If the branch cannot be restarted (the remote branch is gone, the fetch failed, or a worktree still has the branch checked out), the hold stands and a new comment is blocked as `predecessor_awaiting_operator`; repair the cause and release the hold, or let the next pass retry.

**A retry waiting as `predecessor_branch_still_held`.** The automatic retry of a failed follow-up takes over its own failed attempt only once no worktree registration holds the branch and the branch could be restarted from the pull request head. Until then the retry waits in place and the record stays `active` with the reason `publication_failed`; nothing but the retry's next attempt re-examines it. To resolve it: `git -C <clone> worktree list --porcelain` names the registration still on `refs/heads/<branch>`; detach it (`git -C <worktree> checkout --detach`, or `git -C <clone> worktree remove --force <path>` once its unpublished commits are saved) and let the retry run, or `release` the handoff through `GET /api/admin/followup-handoffs`'s actions. A retry that has exhausted its attempts leaves the record for a new comment, which releases it like any ended attempt.

A worktree that recovery rebuilt after a host cleanup deleted it is recorded with the status reason `worktree_lost`. Commits the attempt made survive in the rebuilt checkout and are published; uncommitted edits are gone, so a success the agent had reported is no longer trusted and the request returns to the queue, also when the worker restarts between the rebuild and that return.

Sweep diagnostics report the number of nonterminal tasks, the number of blocked repositories, and a sample of at most 20 tasks once per sweep. To reconcile a blocked repository, inspect the sampled tasks and their latest history, confirm that no job, goal, container or recovery obligation is active, then cancel or finish orphaned tasks through normal task controls. Do not infer termination from age alone or delete history to bypass protection. Callers that omit a retention strategy honor `WORKTREE_RETENTION_STRATEGY`, including `always_keep`.

Removal detaches HEAD before deleting the checkout, freeing the task branch even when ignored build output takes minutes to remove. If a fresh reference or mount appears after detach, the checkout is kept detached and a warning records that outcome. A failed or interrupted removal can leave a partial checkout. Its diagnostic lives outside the checkout under the shared storage lifecycle directory's `worktree-removals/` and appears in storage inventory as requiring inspection. Inspect permissions and Git registrations before operator recovery; deletion-only status or a missing `.git` file never authorizes forced removal.

The instance storage API provides supported dry-run and execute controls. Both require an authenticated instance administrator and, for POST, JSON plus `X-ProPR-Storage: 1`. Use your established instance API session:

1. Read `GET /api/instance/storage/v1/capabilities` to obtain `instanceId`.
2. Read `GET /api/instance/storage/v1/policy` and `GET /api/instance/storage/v1/usage`. Usage includes the latest bounded generated-payload inspection, reclaimable bytes, protected candidates, coverage gaps and last cleanup result. These observations may be stale or partial; unknown usage is not zero.
3. Dry-run with `POST /api/instance/storage/v1/cleanup/preview`, body `{"instanceId":"…","categories":["worktrees"]}`. This does not delete data or enable policy.
4. After separately reviewed policy enablement (`PUT /api/instance/storage/v1/policy`, body `{"instanceId":"…","enabled":true,"idleHours":24}`), repeat the preview and review candidates. Execute its short-lived confirmation with `POST /api/instance/storage/v1/cleanup/execute`, body `{"instanceId":"…","confirmation":"…"}`. Read `GET /api/instance/storage/v1/cleanup/operations/<confirmation>?instanceId=…` for its durable result. Confirmation is consumed before effects and cannot be replayed.

Generated cleanup is opt-in, with a minimum **24 hours since actual last use** even for manual execution. The instance-wide durable use clock is deliberately conservative: any protected task/repository/read/queue activity resets it. Active readers, queued/failed/recovering tasks, unknown queue/database authority, and abandoned lifecycle claims prevent cleanup. Pressure never weakens these rules. Policy remains disabled by default; implementation does not enable it or clean live storage.

Eligible payloads must be created empty by a trusted producer through `GeneratedPayloadStorage.generate`, with explicit regeneration semantics and a complete content fingerprint stored outside the checkout. Only `node_modules`, `.propr/cache`, `.propr/build`, and `.propr/test-cache` are allowlisted. Existing directories cannot be adopted. Producers must generate only refetchable/public or reproducible output, never copy secrets/customer inputs into these directories. Ordinary agent installs and historical worktrees remain protected because their origin is unknown.

For newly provisioned managed worktrees, a supported optional producer is:

```bash
npx tsx scripts/generate-worktree-dependencies.ts /tmp/git-processor/worktrees/<owner>/<repo>/<task>
```

This refuses existing `node_modules`, requires an npm v2/v3 lockfile with integrity-pinned public registry dependencies, and runs `npm ci` with scripts and bin links disabled. It does not enable policy or mark an active task completed. Task lifecycle completion later marks generated records eligible; failed and salvage-retained runs remain protected. This producer is intentionally narrower than ordinary package installation.

Each preview rotates through at most ten records, with bounded enumeration, a 100,000-entry/512 MiB payload proof budget and five-second filesystem proof window; API operations also have a 60-second deadline. Large or unreadable payloads remain protected. Fresh content, tracked-file, Git integrity, inode, link and mount proofs are required at execution. Only exact proven generated files are unlinked; empty payload roots and all Git/customer files remain. Partial interruption retains the record and fails closed on a subsequent changed fingerprint; obtain a fresh preview rather than replaying a confirmation. This generated-payload API preserves whole worktrees; the separate finished-job cleanup and idle sweep follow the retention checks above.

Worker admission reserves 2 GiB free space plus 1 GiB per admitted task by default (including durable outstanding reservations). Configure `WORKTREE_ADMISSION_RESERVE_BYTES` and `WORKTREE_TASK_BUDGET_BYTES` for your workload. Insufficient/unknown capacity rejects new worker admission without deleting files. These are admission estimates, **not filesystem quotas**: provision filesystem/container write quotas for a hard ceiling on arbitrary task writes. Unregistered/oversized payloads, abandoned claims, non-Linux hosts and unrestricted task writers remain explicit coverage gaps; increase disk capacity or investigate protected data through supported recovery/backup procedures.

## Rejected Pushes And The Salvage Ladder

When the final push from a worktree fails — implementation runs, PR follow-ups, `/fix`, ultrafix cycles and merge-conflict jobs — ProPR does not discard the agent's commits with the worktree. It tries, in order:

1. **Retry** the push once with a freshly refreshed installation token (tokens are short-lived and can expire during long runs).
2. **Rescue ref:** push the same commits to `refs/propr/rescue/<taskId>--<timestamp>` on the same remote (the UTC creation time, for example `20261006T120000Z`, is part of the name). This works for non-fast-forward rejections and transient branch-level failures because the ref is new; it does not help when push protection rejects the commits themselves.
3. **Bundle:** write a git bundle to `PUSH_RESCUE_BUNDLE_DIR` (default `<DATA_DIR>/rescue/<owner>/<repo>/<taskId>.bundle`).
4. **Keep the worktree:** override `WORKTREE_RETENTION_STRATEGY` for that task, detach its HEAD (so the branch is free for the next job) and record the retention in `PUSH_RESCUE_WORKTREE_RECORD_DIR`, outside the checkout (an informational `.retention-info.json` with `"reason": "push_salvage"` is also written into the worktree).

The rung that succeeded is recorded on the task timeline, and the task fails with the push diagnosis — the rejection class, GitHub's unblock URL for push protection, and the exact recovery command — in the task detail view, `propr task get <task-id>` (`pushFailure` in `--json`) and the GitHub failure comment. See [Troubleshooting → A Push Was Rejected](./troubleshooting.md#a-push-was-rejected) for recovering each kind.

**Retention.** The daemon deletes rescue refs created more than `PUSH_RESCUE_RETENTION_DAYS` (default 14) days ago — measured from the timestamp in the ref name, not from the commit dates — from every monitored repository, together with bundles of the same age, every `PUSH_RESCUE_SWEEP_INTERVAL_MS` (default 6 hours) and once at startup. Set the retention to `0` to keep them until you delete them yourself. Retained worktrees stay protected while their salvage record has no cleanup deadline or its `scheduledCleanup` is in the future. Their protection is recorded through a record in `PUSH_RESCUE_WORKTREE_RECORD_DIR` (default `<DATA_DIR>/rescue-worktrees`); the `.retention-info.json` written into the worktree is informational and does not by itself keep a worktree. To delete one rescue ref by hand:

```bash
git push origin --delete refs/propr/rescue/<taskId>--<timestamp>
```

Rescue refs live outside `refs/heads`, so GitHub never lists them as branches, normal clones do not fetch them, and ProPR ignores pushes to them for branch discovery and merge-conflict detection.

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

   Launcher-container agent credentials are already below `data/`. For a
   CLI-started, native, or Compose install that used direct agent login, separately remove
   `~/.propr/agent-credentials` after backing up or revoking those provider
   accounts; do not remove the rest of `~/.propr` unless you also intend to
   discard other CLI state.

5. **Uninstall the GitHub App.** Remove the ProPR GitHub App installation (the shared hosted App, or your own) from the organization or repositories in GitHub settings. If you registered a GitHub OAuth App only for this install's dashboard login, delete that too.

6. **Uninstall the CLI:**

   ```bash
   npm uninstall -g propr-cli    # use the same sudo convention as the install
   ```

Optionally reclaim disk from the pulled images: list them with `docker images 'propr/*'` and remove with `docker rmi`.
