# Instance storage v1 — Connect contract (#2977 / propr-routing#200)

This contract is implemented by the **instance API**, under its existing authenticated
`/api` boundary. Connect selects an instance's already-established API origin (including
supported self-hosted origins), logs the user into that instance, and uses its existing
session or paired desktop bearer token. GitHub installation access alone grants no storage
permission. Every endpoint below requires an instance administrator with
`instance.manage_settings`; the server re-resolves instance authorization on each request.
There is no remote shell, arbitrary URL proxy, filesystem path parameter or host-root API.

Shared TypeScript schemas: `packages/shared/src/instanceStorage.ts`. Version is both in the
path and response. An offline instance, 404 from an older instance, 401/403, 503, null bytes,
unsupported category, or absent observation **must never render as zero storage**.

## Endpoints

Base: `/api/instance/storage/v1`. All mutations require `Content-Type: application/json`
and `X-ProPR-Storage: 1`. Browser requests therefore require a CORS preflight under the
route-scoped hosted Connect CORS policy described below (or the existing UI allowlist). Requests
with unknown JSON keys are rejected. Do not forward installation credentials as user auth.

| Method/path | Request | Response |
| --- | --- | --- |
| GET `/usage` | None | `StorageObservation` (200); initiates/coalesces bounded async refresh |
| GET `/policy` | None | `{version:1, instanceId, policy:{enabled,idleHours}}` |
| PUT `/policy` | `{instanceId, enabled:boolean, idleHours:integer}` | Same policy envelope; range 1–8760 hours |
| POST `/cleanup/preview` | `{instanceId, categories:StorageCategory[], taskIds?:string[]}` | `StorageCleanupPreview` |
| POST `/cleanup/execute` | `{instanceId, confirmation}` | `StorageCleanupResult` |
| GET `/cleanup/operations/:operationId?instanceId=…` | Exact identifiers | Result, scoped to the initiating principal |

Errors: 400 invalid selection; 401 unauthenticated; 403 not an administrator, missing
preflight header, or another principal's confirmation; 409 stale/consumed/expired
confirmation, wrong instance, or busy barrier; 503 unknown/unavailable storage authority.
No underlying filesystem or Git error text is returned.

Example (use the instance session, not a GitHub installation token):

```js
const base = '/api/instance/storage/v1';
const usage = await fetch(`${base}/usage`, { credentials: 'include' }).then(r => r.json());
const headers = { 'Content-Type': 'application/json', 'X-ProPR-Storage': '1' };
const preview = await fetch(`${base}/cleanup/preview`, {
  method: 'POST', credentials: 'include', headers,
  body: JSON.stringify({ instanceId: usage.instanceId, categories: ['repository_caches'] }),
}).then(r => r.json());
// Show impact, candidates, protected reasons, estimated bytes and explicit confirmation.
const result = await fetch(`${base}/cleanup/execute`, {
  method: 'POST', credentials: 'include', headers,
  body: JSON.stringify({ instanceId: usage.instanceId, confirmation: preview.confirmation }),
}).then(r => r.json());
```

Example private-data selection:
`{instanceId, categories:["task_history"], taskIds:["<selected-terminal-task-id>"]}`.
Do not combine this control with repository-cache cleanup in the UI. Up to ten explicitly
selected task IDs are accepted. No force option exists in this contract. Existing task
records/dependencies that cannot be deleted transactionally remain protected.

## UI notes for the paired Connect implementation

Render filesystem total/available capacity separately from observed ProPR-owned bytes.
`filesystems` uses observation-local opaque IDs and deduplicates devices; do not sum the
same shared host across instances. `ownedBytes` is the observed allocated bytes (512-byte
blocks), deduplicated by device/inode across all categories. With partial state it is a
lower bound, not an exact total. Hard links/shared Git objects are counted once per scan;
symlinks and nested mounts are skipped. Deletion estimates are upper bounds on reclaimed
space because other hard links can retain blocks. SQLite deletions do not promise a smaller
DB file. A scan is capped at 100,000 entries / five seconds and is refreshed at most once
per minute. The first response may be unknown with `scanning:true`; poll normally.

The category inventory is intentionally explicit:

| Category | Observation and manual deletion |
| --- | --- |
| `database_config` | SQLite DB/WAL/SHM and storage-control records; no database/config/.env wipe |
| `repository_caches` | Configured clone root; only registered, proven recoverable caches can be deleted |
| `worktrees` | Configured worktree root; retained as user work, no automatic/force deletion |
| `salvage` | Managed rescue bundles and retention records; protected |
| `task_history` | Explicit terminal-task records, DB execution details/logs and history through the task deletion domain; bytes are not separately attributable from SQLite |
| `logs_artifacts` | Unsupported aggregate: host stdout/container logs, agent artifacts and externally stored previews do not have one safely enumerable ownership root |
| `provider_credentials` | Unsupported bulk control: agent login mounts, operator environment credentials and external provider revocation need their existing provider-specific controls |

Connect should link existing credential management/disconnect controls separately and
explain their scope. This API never claims to erase all private data. Task deletion does
not delete worktrees, files, notifications, external GitHub issues/PRs, externally retained
logs, or third-party provider history. Credential bytes stored in SQLite are already in
`database_config`, never counted twice as another category.

An operation ID is the confirmation UUID. It expires after five minutes and is bound to
the instance, actor, exact candidate fingerprints and use clock. Execution consumes it
before side effects; replay returns 409. During execution the durable result has state
`interrupted`; after successful completion it is `completed`. A crashed execution is not
resumed or replayed automatically. Poll the result and obtain a new preview. There is no
promise of all-or-nothing deletion across repositories; per-candidate progress persists.
Audit records contain actor, selection, reasons and results, never repository contents,
filenames, remote authentication or arbitrary host paths.

## Safety and deployment contract

Automatic cleanup defaults to **disabled / 24 idle hours**. The durable policy is separate
from worktree retention environment flags. Existing instances get those defaults on first
use; missing/corrupt authority fails closed. Startup resets the conservative use clock.
The current implementation uses an instance-wide actual-use clock: activity in any
repository delays cleanup of all caches. It never infers use from filesystem timestamps.
Queue admission, complete worker jobs, clone preparation, worktree creation and repository
retrieval take durable read claims against the same cross-process filesystem barrier.
Deletion takes the exclusive barrier, rechecks queues and task/submission recovery state,
then revalidates Git and the preview. Claims have **no age-based lease stealing**.

All processes sharing clone/worktree roots must run the upgraded lifecycle implementation.
The barrier lives beside the configured clone root (`.<clone-root-name>-storage-lifecycle`),
so separate instances sharing that root also share its barrier. Instance policy, cache
registry, identity and audit remain in durable `DATA_DIR/storage-control`. Do not run mixed old/new workers against the
same cache roots. Stale gate/read claims after crashes require operator investigation;
they intentionally prevent cleanup and must not be removed merely because they are old.
The service does not automatically delete abandoned claims or change filesystem ownership
or permissions. The instance identity is a storage-domain UUID, not a GitHub installation ID.
Back it up with the durable configuration.

Only clones registered by successful managed clone preparation are candidates; unregistered
legacy directories have unknown ownership and remain untouched. Each preview considers a rotating batch of at
most ten registered clones (bounded to 10,000 registry entries). Automatic sweeps run at
most hourly after the idle threshold, so cleanup can lag that threshold by an hour. Active/queued/delayed/failed/recovering jobs anywhere in the
instance conservatively block cleanup. Attached or stale worktree registrations, shallow
repositories, alternate object stores, submodule stores, unknown/corrupt Git state,
symlinks/mounts, private tracked/staged/untracked/ignored files, assume-unchanged files,
stashes and salvage refs all block deletion. Fresh remote advertisement must prove every
local object reachable from a current published branch/tag. Missing remote tips locally,
authentication failure or an unavailable remote retain the cache. No hooks, credential
helpers or repository-controlled transports run during the proof.

Under the same barrier a candidate is moved to an isolated quarantine inside its clone
filesystem, audited again and removed only on an identical fingerprint. Interruptions or
path changes retain the quarantine. Neither quarantine nor worktree metadata is age-pruned.
Legacy fetch-error recloning, force worktree removal, branch reset/deletion and age-only
worktree/bundle pruning no longer bypass these protections. Worktree cleanup retains and
non-forcibly detaches completed checkouts to release the branch for subsequent tasks.

**Backup distinction:** fleet backups cover the database and durable configuration, not
repository working copies. Refetching cannot recover uncommitted work or unpublished
commits. Local private-data deletion does not purge the fleet's 60-day retained backups or
external services. Backup expiration and provider revocation are separate operations.


## Hosted Connect browser integration (#2979)

For a canonical hosted `API_PUBLIC_URL=https://t-<instance>.propr.dev`, Express
permits the **exact** configured `PROPR_CONNECT_URL` (default
`https://connect.propr.dev`) on `GET /api/auth/user` and only the method/path pairs
in the table above. The Connect URL uses the same bare-HTTPS-origin validator as
the existing instance login bridge; this exception additionally requires an HTTPS
`*.propr.dev` origin without a nondefault port so it shares the hosted instance's
site. Configuration is trusted server configuration, never a request Host header
or a caller-supplied destination. A custom cross-site Connect URL gets no exception.

Mutation preflights allow only `Content-Type` and `X-ProPR-Storage`; read
preflights allow no additional headers. Authorization, desktop markers, unrelated
REST routes, Socket.IO, preview origins, suffix lookalikes, HTTP, arbitrary ports,
and opaque `null` origins receive no new permission. Successful OPTIONS responses
only report browser transport policy: they do not create sessions, authenticate a
principal, authorize a mutation, or issue cleanup confirmations. Every actual
storage request still resolves the instance administrator and
`instance.manage_settings`; JSON and `X-ProPR-Storage: 1` remain mandatory for
mutations. Confirmations remain instance/actor-bound and single-use.

The existing login bridge creates the host-only, Secure, HttpOnly, SameSite=Lax
cookie on the instance. Connect sends `credentials: "include"` and checks
`/api/auth/user` against its selected account before each storage operation, as
routing#202 already does. CORS is not authentication and grants no installation
credential access. No adapter protocol change is needed for this integration.
A wrong account must cause Connect to clear displayed authority and refuse the
storage operation; signing in to Connect alone does not replace an instance session.

This does **not** fix cross-site self-hosted cookie restrictions. Noncanonical or
customer API origins receive no additional CORS allowance, and third-party cookie
restrictions can still prevent an instance session from reaching the server.
Connect must show unknown/unavailable usage and disabled mutation controls on
these failures, never zero usage or successful cleanup. Do not work around this by
setting `COOKIE_DOMAIN=.propr.dev`, changing SameSite, allowing arbitrary origins,
or forwarding an installation token.

Regression coverage: `packages/api/test/hostedConnectStorage.test.ts` exercises
production CORS, login callback, session middleware, authorization, and storage
handlers with temporary SQLite/storage and HTTPS Chromium host mappings. Redis
transport and the external grant redeemer are isolated fixtures; instance API
responses are not intercepted. Run with:

```sh
node --import tsx --experimental-test-module-mocks --test packages/api/test/hostedConnectStorage.test.ts
```

UI acceptance was exercised against routing#202 head
`e928c87a8632feef63c072c00dfcb7b70e942fa6`. To repeat it, build that frontend with
`VITE_API_BASE_URL='' npm run frontend:build` in a separate routing checkout, then
set `CONNECT_STORAGE_FRONTEND_DIST` to its absolute `apps/frontend/dist` directory
when running that command. The fixture serves the real frontend and a local
Connect account/tunnel inventory; storage reads, policy changes, preview and
execution reach the real isolated instance API. Chromium (`CHROMIUM_PATH` may
select it) and OpenSSL are required. No live relay, account, or customer storage
is used. The browser checks default OFF/24h, explicit opt-in, confirmation,
unsupported-origin behavior, and generates focused transient preview evidence.
