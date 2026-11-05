# API latency diagnostics

`PROPR_API_TIMING_SAMPLE_RATE` enables privacy-safe request attribution for a
fraction of API requests. It accepts a value from `0` to `1` and defaults to
`0` (disabled). A short diagnostic window can use `0.01`; use `1` only for a
bounded, low-traffic investigation.

Each `[api-performance]` record contains the static Express route template,
status, total time, shared middleware time, an event-loop scheduling probe and
aggregate stage durations. Relevant stages distinguish authentication,
authorization, bearer-cache access, GitHub fallback, session grant sync,
agent-health work, queue work and named SQL operations. Records never include
the request URL or query string, headers, credentials, bodies, SQL, or SQL
parameters. At most 24 stage names are retained per request.

## Issue #2355 measurements

The production baseline supplied with the issue is 18 sequential authenticated
GETs over three rounds. Its medians were 2,578–3,769 ms, including 2,584 ms for
the 11-byte generating-plan response; a same-credential loopback read was
2,085 ms. These values are the deployment baseline, not reproduced locally.

The focused regression fixtures record these before/after work counts:

| Fixture | Before | After |
| --- | ---: | ---: |
| 12 simultaneous expired-cache status reads, one configured agent | 12 health probes | 1 health probe |
| Task-list count presentation enrichments | 3 full-history enrichments | 0 enrichments |

The status result retains the existing five-second freshness window; concurrent
misses now share one in-flight snapshot, and the window begins when that
snapshot completes. The task page still performs its processing/completion and
critique enrichments; only the logically independent count avoids repeating
them. These are labeled fixtures and are not claims about production latency.
A deployment comparison should repeat the issue's exact credential, endpoints,
parameters, ordering and three-round method, with a temporary bounded timing
sample enabled to attribute any remaining delay.

## Issue #2390 bounded-fresh status

The follow-up production trace showed that a five-second single-flight cache
still made every consumer in an expired-cache burst wait for registry lifecycle
work and serial groups of agent probes. Status no longer calls
`AgentRegistry.ensureInitialized()`: that execution-lifecycle method can inspect
or prepare Docker images and does not belong on a diagnostic read path. Direct,
synthetic, and legacy probes now run together, as do Redis status reads, indexing,
summarization warnings, and agent health. Configuration, indexing, and warning
reads have a 250 ms diagnostic deadline; a timeout projects their existing
failure value (`unknown`, `disconnected`, or no warnings) and a later refresh
can recover.

Agent, indexing, and warning measurements use a five-second fresh window and a
30-second hard age. A stale read returns the last measured result while one
background refresh runs; after the hard age, a reader waits for that bounded
probe result instead of extending stale data indefinitely. Agent configuration
events clear the agent measurement immediately. Cache generations ensure a
refresh begun before invalidation cannot overwrite or be joined by the new
configuration identity.

Focused fixture evidence:

| Fixture | Work / latency assertion |
| --- | --- |
| 12 simultaneous stale-cache consumers | 1 refresh probe; all 12 return the prior measured status without waiting for its gate |
| Never-resolving health check | 0 registry initializations; disconnected result at the configured 25 ms probe timeout (asserted 10–200 ms locally) |
| Hard-expired cache with refresh in flight | 1 refresh probe; reader joins it and receives its 40 ms timeout result (asserted 10–200 ms locally) |
| Direct + synthetic health, direct + synthetic config, indexing, warnings | all 6 fixture operations start before the shared gate is released |
| Configuration invalidated during an old refresh | new identity is returned immediately; the late old generation cannot replace it |
| Persisted config newer than the live registry | old runtime receives 0 probes and the new identity is reported disconnected until registry synchronization |
| Unavailable direct-agent configuration read | returns `agents: []` and `claudeAuth: unknown` at the 25 ms fixture deadline |

These timings are deterministic fixture bounds, not production latency claims.
Promise timeouts cannot interrupt synchronous event-loop stalls, and the first
or hard-expired read can still wait for up to the 250 ms configuration deadline
plus the configured 1.5-second health-probe bound. Root must validate actual
latency and contention after deployment.

## Issue #2376 active-update contention

The remaining capture had several unrelated, lightweight reads begin together
and finish together after roughly four seconds. The task-update subscriber also
started optional notification persistence on the API thread. The shared SQLite
configuration gives `better-sqlite3` a 30-second `busy_timeout`; because its
busy handler is synchronous, a background notification write racing a writer
in another process could stop the event loop even though WAL readers themselves
were available.

Notification projection and Web Push dispatch now use a dedicated connection
with `busy_timeout=0`. Projection contention is retried with asynchronous
backoff for the same bounded interval, so durable ordering/deduplication remains
in the projection layer while foreground requests keep using uncached,
user-scoped reads. The regression fixture holds SQLite's writer lock and checks
that an event-loop turn and two account-scoped reads complete before the
background write succeeds; it then verifies that a later foreground mutation is
visible rather than served from a cache.

The task analysis endpoint was intentionally left unchanged. A `404` means no
`llm_executions` row exists for that task; this is an expected first-visit state
before an execution is recorded, while a recorded execution whose analysis is
not ready returns `202`. Converting every missing execution to a success response
would also hide genuinely absent execution data.

The repeated task-list and repository-stat calls in the capture were separated
by a later live task event. The first pair is the Tasks-page mount snapshot and
the second pair is its freshness invalidation, rather than two overlapping
mount requests. Existing burst coalescing and reconnect recovery remain intact.

## September 29 staging read investigation

Authenticated sequential HTTPS measurements (three rounds) found warmed task
list/search reads around 200–235 ms, but `/api/dashboard/outcomes` took
3.08–4.09 seconds. A headless Chromium dashboard load also showed unrelated
reads completing together around seven seconds; both the outcomes feed and
narrative collect the completion projection on the API's synchronous SQLite
connection. The staging snapshot contains 14,436 tasks and 65,782 history rows,
with `task_history_task_id_timestamp_index` already present.

The completion projection now keeps task job/result JSON out of its entity
window sorts and retrieves those payloads after ranking. Against the same
read-only staging snapshot, the first paired 50-entity measurement fell from
2,374 ms to 1,080 ms; repository-scoped reads fell from 1,083 ms to 834 ms.
Returned objects were compared with deep equality, including every earlier
update. These are local query measurements, not deployed API timings.

Reproduce the current query against an offline snapshot with:

```sh
node --import tsx scripts/benchmark-dashboard-outcomes.ts --database=/path/to/snapshot.sqlite
```

Optional `--repository=owner/repo` and `--search=text` exercise filtered reads.
The benchmark opens SQLite read-only and prints only timings and row counts.

A second change shares the ranking between selected parents and earlier
updates, and searches compact parent titles once instead of repeating the
projection for each 500 candidates. Paired snapshot reads then measured:

| Read (50-entity limit) | Original | Optimized |
| --- | ---: | ---: |
| All repositories | 1,662 ms | 689 ms |
| `integry/propr` | 1,187 ms | 511 ms |
| Title search `dashboard` | 4,784 ms | 974 ms |
| No-match title search | 4,008 ms | 438 ms |

All four results matched the original projection by deep equality. The search
regression also places a Unicode title behind 505 unrelated parents and checks
that search uses two rankings regardless of candidate pages; an unfiltered read
uses one ranking for both parents and earlier updates.

The goal live-details consumer also used an unconditional five-second HTTP
interval despite consuming `task:live` websocket updates. It now uses the shared
refresh scheduler: connected clients reconcile every five minutes, disconnected
clients retain their fallback interval, hidden tabs defer reads, and reconnect
or visibility recovery triggers one coalesced read. Periodic reads cannot overlap
an outstanding snapshot. Lifecycle transitions still immediately replace an
active snapshot with complete terminal history, including when an older HTTP
read is pending. Focused UI tests exercise these request counts and the existing
HTTP/socket execution-ordering races.

Task-list counts now use history existence when no state filter is requested;
they still exclude tasks without history. A covering
`tasks(repository, task_type, task_id)` index replaces the narrower repository
index, retaining its prefix lookup without keeping redundant indexes. On the
snapshot, the original all-task count took 35–37 ms warm; the covering-index
existence query took 6.5–6.7 ms. State-filtered counts retain their latest-state
join. Complete task-list responses matched the prior implementation across
all, search, review, active, waiting, attention, repository and offset cases.
Migration tests verify covering-index selection and rollback.

Context previews likewise use pushed draft completion events instead of a
five-second connected poll. A pending preview has a 30-second connected safety
read so a lost publication cannot stall an interactive operation for minutes;
the five-second interval remains only when disconnected. Snapshot reads are
serialized by the shared scheduler and stop doing network work when the preview
settles. The regression holds a connected preview open for 20 seconds with just
its initial read, then disconnects and verifies recovery through one fallback.

### Browser and integration validation

Headless Chromium loaded the hosted UI twice, routing only dashboard outcomes
and narrative reads to a loopback, read-only snapshot harness. Both runs used
the same database and disabled narrative model generation; other reads retained
the staging backend. The original queries rendered the Completed feed at
5,777 ms and the optimized queries at 2,137 ms, with no page errors. This measures
the query changes inside the real UI; it is not a post-deployment measurement.

The remaining frequent network timers have narrower purposes: submission
creation waits, runtime-package operations, and GitHub preview publication
without a corresponding push event. Dashboard/task refreshes already use push,
visible-tab disconnected fallback, and five-minute recovery reads. Elapsed-time
and animation timers do not issue network calls. Analytics panels retain their
five-minute refreshes. Removing recovery reads entirely would risk stale data
when a best-effort publication is missed.

Validation used a clean checkout because an extra ignored local workspace made
`npm ci` fail in the original directory. The clean checkout passed server/UI
typechecks, the production UI build, 64 focused API tests and 226 dashboard,
goal and live-update UI tests; context-preview tests were run separately after
the additional polling change.

## Completion reads off the API thread

After the initial rollout, three authenticated staging rounds measured outcomes
at a 1.12-second median (previously 3.20 seconds), while the dashboard's outcomes
request fell from about 7.00 to 2.78 seconds. Unrelated reads still waited behind
the synchronous projection during dashboard startup.

File-backed SQLite APIs now execute completion projections in a dedicated,
read-only worker, shared by the feed and narrative. Identical concurrent reads
share only their in-flight result; subsequent reads query the current database.
There is no response TTL. The service bounds distinct queued requests at 32,
terminates a worker after a 30-second request deadline, rejects outstanding
requests on failure/shutdown, and starts a replacement on a later request.
In-memory and non-better-sqlite3 fixtures retain their supplied connection.

On the staging snapshot, simultaneous 50-entity feed and 8-entity narrative reads
took 1,240 ms on the API thread and 1,222 ms in the worker with identical results.
A foreground timer plus `SELECT 1` probe completed at 1,241 ms before and 11 ms
after: this isolates request responsiveness rather than claiming the projection
itself became faster. Tests cover repository/search parity, Unicode titles,
visibility of subsequent writes, bounded queued work, query-error recovery,
shutdown, deadline failure, and read-only startup against a missing file.

Add `--worker` to `scripts/benchmark-dashboard-outcomes.ts` to reproduce the
worker path; each iteration also reports when a 10 ms foreground timer fires.
The compiled JavaScript worker was separately smoke-tested against the snapshot.

## Incremental outcomes and expansion-only history (#2621)

The file-backed SQLite API starts a separate projection worker. The normal
summary and narrative completion reads use `dashboard_outcome_v1_entities`;
history reads use `dashboard_outcome_v1_runs`. These tables contain rendering
fields, ordering keys and revisions, never job/result JSON. The old reader is
retained as the parity oracle and for clients using the legacy contract.

### Contracts and authorization

- Summary: `GET /api/dashboard/outcomes?repository=all&limit=50&view=summary`,
  or the same URL without `view`, with
  `Accept: application/vnd.propr.outcome-summaries+json` (the new UI uses this).
  Items retain their existing visible IDs/fields and total `eventCount`, add
  `entityId` and `revision`, and **omit** `earlierUpdates`.
- History: `GET /api/dashboard/outcomes?view=history&repository=owner/repo&entityId=...&revision=...&limit=20`.
  `items` contains earlier outcomes only. `nextCursor` is null at the end;
  otherwise pass it as `cursor`. The maximum page size is 50. A concrete
  repository is required, including when expanding a row in the all-repo feed.
- Status: `GET /api/dashboard/outcomes?view=status` exposes version, readiness,
  backfill cursor, seeded state, processed tasks, pending task count, oldest
  pending age (`lagMs`, second precision), failure count and last error.
- Requests without the summary opt-in retain embedded history. Old desktop/UI
  clients continue working; new clients also understand legacy responses from
  older servers or an explicit fallback. Responses are non-cacheable and vary
  by Accept header.

All variants use the existing authenticated dashboard route and instance-access
boundary. History additionally looks up `(entityId, repository)` on **every**
request. IDs do not grant access. Cursors bind the schema version, entity,
repository, entity revision and complete ordering boundary. Each history page
uses a database snapshot. A changed revision returns HTTP 409
`OUTCOME_HISTORY_STALE`; the UI drops those pages, refreshes the summary and
restarts the expanded history. Invalid/foreign cursors return 400, repository
mismatches return 404, and an incomplete projection returns 503
`OUTCOMES_NOT_READY`, never a partial/empty successful feed.

### Capture, backfill and recovery

Installation creates only the private versioned catalog, indexes and triggers
in a short transaction; startup neither seeds all tasks nor rebuilds histories.
The existing source task-history lookup index remains in use. This catalog
intentionally does not add names to `knex_migrations`: older running Node
services can continue validating the shared migration catalog.

Triggers capture relevant INSERT/UPDATE/DELETE operations on `tasks` and
`task_history` in the **same transaction as the source write**. The dirty table
coalesces work by task, with a fresh token for every mutation. The source-write
review covered worker creation/transitions (`workerStateManager`,
`workerStateTransition`), persisted restart/recovery (`persistedTaskStateStore`,
`taskSubmissionRetry`), goal attempts and synthetic routing, late completed
metadata (`ultrafixContinuationMeta`), task payload/final-result changes, import
jobs, and the transactional task/history deletion in `taskRoutes`. All SQL
writers enter the same capture mechanism, including bulk imports and history
retention; no lifecycle publisher needs to remember a second projection write.

The worker seeds task IDs in 100-task keyset batches, then processes one dirty
task at a time. Expensive per-task reconstruction occurs in a read snapshot.
During backfill it compares that task's projected completions against the old
reader in the **same snapshot**. A short write transaction checks the dirty
token and rebuild generation before replacing that task's runs and reconciling
both its old and new entity summaries. A concurrent source write leaves a new
token queued; a concurrent rebuild invalidates the old calculation. Duplicate
workers/delivery cannot double-count. Unchanged rendering data keeps its entity
revision. Readiness is committed only after seeding and catch-up finish with an
empty queue under the writer lock. A failed parity check leaves the projection
unready and records the failure.

A transactional outbox records affected repository invalidations. The API
publishes them on the existing activity channel **after projection commit** and
acknowledges the outbox only after publication succeeds. It uses the existing
completion activity subscription; an initial readiness transition also wakes
clients, including an empty database. Lost delivery/reconnect still uses the
existing dashboard reconciliation scheduler. The projection worker checks its
durable queue every 250 ms while idle; no new browser polling loop was added.
Collapsed entities never request history. Expanded pages remain local to the
mounted row and are keyed by repository/entity/revision and authenticated API
scope; concurrent identical requests use the existing shared-read mechanism.

Retention deliberately follows the old reader: removing a task removes its
outcomes; removing history can remove completions or merge surviving run
boundaries. The next projection reflects those surviving sources rather than
keeping archival outcomes. Restarting a task alone does not erase completed
runs. PR resolution, title fallback, Unicode substring matching, timestamp/task/
completion ordering, skipped-work and goal-task exclusions, and run-local recap
and review-score rules are unchanged.

### Rollout, rebuild and rollback

1. Start with `DASHBOARD_OUTCOME_PROJECTION=shadow`. The worker builds and checks
   the projection while feed/narrative clients continue using legacy reads.
2. Monitor the status variant until `ready` is true and `pending`/`lagMs` settle.
   Compare a consistent SQLite backup with `--verify --projected` below. The
   serving process continues capturing/catching up concurrent writes.
3. Remove the variable and restart the API to enable summaries for opted-in
   clients and projected narrative completions. Legacy clients retain their
   existing contract. With the variable unset on first installation, summary
   clients get explicit 503 readiness responses until backfill completes.
4. Roll back with `DASHBOARD_OUTCOME_PROJECTION=legacy` and restart. This disables
   the projection worker and uses the old reader for feed/narrative; source
   capture remains installed so re-enabling can catch up. Older binaries can
   also run with the private tables/triggers present. Do not drop source data
   or edit the shared migration ledger.

An online rebuild invalidates cursors and makes projected reads unavailable
until ready. In shadow mode it can run behind the legacy reader:

```sh
npx tsx scripts/benchmark-dashboard-outcomes.ts --database=/path/to/propr.sqlite --rebuild --enqueue-only
npx tsx scripts/benchmark-dashboard-outcomes.ts --database=/path/to/propr.sqlite --status
```

`--enqueue-only` resets only derived tables and the durable backfill checkpoint;
source records are untouched. The running projection worker resumes the bounded
backfill. Without that flag, `--rebuild` also drains the backfill in the command
process (use this on an offline snapshot). Worker crashes/restarts resume their
checkpoint and dirty tokens. The rebuild generation prevents pre-rebuild work
from replacing newer results.

### Reproduction and evidence

```sh
# Assertions: oracle parity, fully paginated history, metadata, identity,
# retention, cursor/repository isolation, source rollback, concurrent writes,
# resumable backfill, rebuild, worker restart and serving SQL traces.
npx tsx scripts/benchmark-dashboard-outcomes.ts --self-test

# 50 entities, 20 then 200 runs/entity; 30 warm samples plus the first read,
# query plans, concurrent feed/narrative input reads and incremental write cost.
npx tsx scripts/benchmark-dashboard-outcomes.ts --synthetic

# A writable OFFLINE backup: build projection, compare both readers in a
# snapshot, print 30 warm samples, first read, payload sizes and query plans.
npx tsx scripts/benchmark-dashboard-outcomes.ts --database=/tmp/outcomes.sqlite --rebuild --projected --verify
# Measure connection-first-read behavior separately from rebuilding:
npx tsx scripts/benchmark-dashboard-outcomes.ts --database=/tmp/outcomes.sqlite --projected

# Production browser bundle with the existing dashboard fixture:
npm run build --workspace propr-ui
npm run preview --workspace propr-ui -- --host 127.0.0.1 --port 4173
# In another terminal; --capture is optional and writes transient evidence.
npx tsx scripts/benchmark-dashboard-outcomes.ts --browser-test --url=http://127.0.0.1:4173 --capture
```

The browser harness checks one startup summary and zero history requests,
expansion-only loading, local retry, pagination, reopening without a new read,
new completions while expanded, collapsed push/reconnect, stale-cursor recovery,
and ignoring an in-flight history result after switching repository. It captures
the loading and first-page/load-more states using Playwright Chromium.

The synthetic fixture includes 64 KiB of unused job payload per task. Query
plans select `dashboard_outcome_v1_feed`, `dashboard_outcome_v1_repository` and
`dashboard_outcome_v1_history`; the serving SQL trace contains no `tasks` or
`task_history` reads and no history windows. Search alone scans compact titles
with JavaScript Unicode case folding.

These local fixtures are **not** the staging snapshot/hardware or an authenticated
remote end-to-end measurement. First-read samples do not evict the OS cache,
and the synthetic fixture has just been built in memory. Reader measurements
exclude HTTP queueing, network/transfer, model generation and browser rendering.
Staging acceptance still requires at least 30 authenticated handler and client
samples, cold behavior separately, and committed-completion visibility lag under
normal load. Record Server-Timing, client TTFB/transfer and browser render time
separately; do not report network latency as SQL time. Incremental projection
cost can grow with the changed task's history; the serving pages do not.

Local synthetic results (2026-09-29, 30 warm reads and 30 incremental writes per
fixture; milliseconds, same container):

| Runs | Summary p95 | History p95 | Concurrent 50 + 8 p95 | Source commit p95 | Projection apply p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.76 | 0.96 | 1.57 | 0.27 | 13.23 |
| 10,000 | 0.74 | 0.83 | 1.01 | 0.14 | 38.94 |

First summary/history reads after fixture construction were 0.77/0.86 ms and
0.39/0.48 ms respectively; these are **warm-memory first reads, not cold disk**.
Serialized summary responses were 19,147 and 19,247 bytes. The earlier-update
pages were 5,105 bytes (19 available updates) and 5,663 bytes (20 updates plus a
cursor). Backfills took 0.54 and 2.50 seconds. Projection-apply cost measures a
synchronously drained dirty task in the harness; it excludes the background
queue wait and must not be reported as staging visibility lag.
