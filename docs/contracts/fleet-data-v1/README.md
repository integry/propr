# Fleet guest data plane v1 (historical, native actions disabled)

**Compatibility boundary:** the current listener rejects every v1 action, including status, cancel and artifact streaming. This contract contains only native data actions; no reviewed infrastructure-only action needs to remain enabled. Its published schema, fixtures and checksums remain unchanged as historical artifacts. The descriptions below document the previous implementation, not current authorization behavior. Fleet must migrate to [actor-bound v2](../fleet-data-v2/README.md); Routing account ownership is insufficient to authorize these actions. Old v1 journals remain private recovery evidence and cannot be queried, confirmed or redeemed with a v2 grant.


This contract is an infrastructure bridge for a separately authorized Fleet executor. It is not a Connect or customer API. Routing must authorize the account, passkey and exact operation before Fleet signs a grant. Native instance administration remains unchanged; no user or session is created or impersonated. This work does not enable Hosted UI controls, deploy an instance, or complete Fleet #80 / Routing #231.

## Pin and transport

Pin `schema.json` by SHA-256 (`419b435424c9273bb2b39097277595e323f160a30ed3fb48cbe066e9b5d7c655`). `SHA256SUMS` also pins `fixtures.json`; each of its seven canonical request fixtures has its own byte hash and a MAC using an explicitly public test key. Regenerate with `node scripts/generate-fleet-data-fixtures.mjs` after building `@propr/shared`. Fixtures use historical timestamps and must not be accepted as live grants. Shared TypeScript types and canonical serialization live in `packages/shared/src/fleetData.ts`.

The API process optionally creates a **separate Unix domain HTTP socket**, never a TCP listener. Fleet Ansible can POST canonical JSON to `/v1/invoke` using its Unix-socket HTTP client. There is no proxy from the customer Express application to this listener. The customer listener explicitly returns 404 for `/v1/invoke`, including requests arriving through the existing customer tunnel. Cookies, bearer secrets, initial-admin IDs and local instance-admin roles do not grant access to the socket's operation handler.

The fixed management directory is `fleet-data-control` beside `storage-control` in the configured data directory. It must already exist, owned by the API process UID, mode 0700, with real directory ancestors. Fleet provisioning (outside this change) must place a mode-0600, single-link regular `authority.json` there:

```json
{"hostedInstanceId":"HOSTED-ID","placementGeneration":"PLACEMENT-ID","scope":"hosted_customer_data","secretSha256":"SHA256-OF-CURRENT-PROPR_FLEET_CONTROL_SECRET"}
```

Both identifiers are ASCII `[A-Za-z0-9_-]{1,100}`. The secret is the already-provisioned `PROPR_FLEET_CONTROL_SECRET`, at least 32 characters with no surrounding whitespace. Its raw value is never written to this directory. Missing authority leaves the listener disabled. Once authority is configured, listener startup is a prerequisite for API readiness: failure (including an old live generation socket during a rolling overlap) logs a startup error and exits nonzero before the customer HTTP listener opens. The process supervisor must restart the new process after the old listener exits. Live sockets are never unlinked or taken over; only proven stale sockets are removed with an inode check. Corrupt, unsafe or mismatched authority refuses service; no credentials or ACLs are provisioned automatically. Replacing the authority file to revoke or change placement takes effect during work and redemption. Secret rotation requires matching authority and environment; restarting establishes a new runtime generation.

At startup the API writes private `runtime.json` with the pin and all identity fields; Fleet reads it over its existing local management access, never through an unauthenticated HTTP discovery API. The socket is `data-<runtimeGeneration>.sock` in the same directory, mode 0600. A new process generation atomically replaces the runtime record and invalidates old-process work. Stale generation sockets do not confer authority. Fleet should wait for the advertised socket to be ready. Keep this management namespace out of backup purge and repository cleanup rules; nothing here is registered as a cleanup candidate or included in the customer SQLite export.

## Signed envelope

Send only `Content-Type: application/json`, no content encoding, at most 8192 bytes. The body is exactly the canonical JSON envelope, without whitespace or trailing newline:

```text
{assertion: {...}, request: {...}, mac: LOWERCASE_HEX_HMAC}
```

Canonical JSON sorts object keys lexicographically, retains array order, uses JSON string escaping and UTF-8, and has no insignificant whitespace. Numeric assertion fields are safe integers. The strict byte comparison rejects duplicate keys; all unknown fields, unsupported actions, paths, URLs and arbitrary categories are refused.

The assertion contains exactly:

- `contract`: `propr.fleet-data.v1`; `contractPin`: the schema SHA-256 above.
- `hostedInstanceId`, `storageInstanceId`, `runtimeGeneration`, `placementGeneration`, `scope`: exactly the current runtime record. Scope is always `hosted_customer_data`; native storage and runtime IDs are lowercase UUIDs.
- `action`: exactly the request action.
- `requestDigest`: lowercase SHA-256 of the canonical request object.
- `operationId`: a fresh lowercase UUID, including for status, cancellation and streaming requests.
- `issuedAt`, `expiresAt`: integer Unix seconds, positive lifetime at most 60 seconds. Expired grants are refused. Issuance permits at most five seconds of future skew and 65 seconds of past skew.
- `nonce`: 32 cryptographically random bytes encoded as 64 lowercase hex characters, unique across all actions for this tenant.

`mac` is lowercase HMAC-SHA256 over the canonical assertion, keyed by the Fleet control secret's UTF-8 bytes. Verification uses constant-time digest comparison. A grant is consumed at admission. The admitted operation lives for at most five minutes, independently of the short admission assertion window; ongoing work still revalidates current identity, runtime publication, secret and operation expiry. Each later status/cancel/stream request needs its own fresh assertion. No customer principal is consulted, so local user demotion has no effect on valid infrastructure authority.

## Fixed actions

| Action | Exact request fields besides `action` | Result |
| --- | --- | --- |
| `database.export` | none | Native customer-database export status; initially `running` |
| `repositories.list` | none | Bounded native inventory, explicitly partial |
| `repositories.cleanup.preview` | none | Native preview of repository caches only, including confirmation, expiry and protections |
| `repositories.cleanup.execute` | `previewOperationId`, `confirmation` | Native cleanup result for that exact Fleet preview |
| `operation.status` | `targetOperationId` | Durable target operation envelope; polls native export completion |
| `operation.cancel` | `targetOperationId` | Cancels an export or invalidates a pending cleanup preview |
| `artifact.stream` | `targetOperationId` | Single-use SQLite response for a completed export |

Every response envelope has `contract`, `operationId`, `actor: "fleet"`, `state`, `expiresAt` (epoch **milliseconds**) and optional `result`. Result types are the existing native `DatabaseExportStatus`, `RepositoryStorageInventory`, `StorageCleanupPreview` and `StorageCleanupResult`, or the target operation envelope. The native export ID inside its metadata is not the Fleet operation ID: always target the outer Fleet ID. Only repository caches may be selected; there is no force mode or caller-selected storage category. Cleanup confirmation is bound to the preview's signed grant, Fleet operation, native fingerprint and all current generations. Execution durably consumes an additional confirmation claim bound to the execution grant before invoking the native service with actor exactly `fleet`.

Cancellation cannot interrupt an already active cleanup execution or un-fence uncertain work. The normal native deadlines and lifecycle barriers still apply. It cannot roll back a completed deletion. An expired or old-generation operation cannot be redeemed or queried through a fresh generation grant; its ledger remains for private operator investigation.

## Durability, failures and streaming

The private append-only per-operation journal is the result outbox. Record hashes detect corruption; a background monitor persists export completion even without a Fleet status poll. Exclusive nonce and operation creation plus file/directory fsync precede a single durable dispatch decision. Admission and target locks prevent concurrent local dispatch; exclusive filesystem creation prevents duplicate admission across processes. Repeating the same operation or nonce always fails, including after losing a reply. Use a new signed status operation to recover a result in the same generation. There is no automatic replay.

On restart an `accepted` record proves dispatch never happened and becomes `failed`. A nonterminal export, cleanup execution or stream past the durable dispatch boundary becomes `fenced`; it is never destructively repeated. Read-only interrupted operations become failed. Terminal records remain as durable evidence but old generations are not customer-readable. Torn, corrupt, oversized or substituted files fail closed. Fencing preserves uncertainty; it is not a claim that a side effect did or did not happen. No on-wire unfence/reset/purge action exists.

Admission stops at 16,384 management entries (including nonce tombstones), with each journal capped at 64 KiB and each saved result at 24,000 bytes. Tombstones are deliberately not recycled automatically. Capacity exhaustion needs separately reviewed Fleet/operator maintenance, not a new cleanup permission. Response JSON is bounded at 32 KiB. Refusals return only `403 {"error":"fleet_data_unavailable"}`; public TCP returns 404. No exception messages, SQL, Git stderr, host paths, environment or assertions are returned.

Exports use the exact `DatabaseExports` online-backup worker, sanitizer and leases used by native instance admins, including the 512 MiB limit, integrity/foreign-key checks, private modes, source/ancestor/link checks, deadlines and ENOSPC handling. This is a customer export, not a Fleet operational backup. Customer ciphertext survives; infrastructure decryption keys and provider credentials do not. Native metadata reports the actual schema/migration, hash and byte size.

Poll export status until completed, then request `artifact.stream`. It returns `application/vnd.sqlite3` with exact `Content-Length`. The listener pipes 64 KiB chunks with backpressure and revalidates authority at least every 4 MiB or 250 ms, including while the reader is stalled. It enforces the native size limit and a size-derived transfer deadline of `30,000 + ceil(sizeBytes / (4 * 1024 * 1024) * 1000)` milliseconds, capped at 158 seconds for the 512 MiB artifact cap. The reviewed throughput floor is 4 MiB/s; operation expiry remains an independent fence. Fleet clients must allow this transfer budget rather than imposing a fixed 60-second timeout that could burn a valid one-use redemption. It never buffers the snapshot in memory. The durable target state becomes `streaming` before opening the native single-use file. Success records `consumed`; errors/disconnection record `fenced`. A final post-consume authorization check can conservatively record `fenced` even after all bytes have completed, so transport completion does not guarantee a `consumed` journal outcome. Private staging is disposed only after that consumer outcome is known. Process death leaves native lease recovery to expire staging safely. HTTP completion means transport delivery, not proof that Fleet durably stored the file; Fleet must verify the reported hash and size before packaging it. A lost delivery acknowledgement never permits another download.

Fleet owns off-site packaging, retention/purge and reset. Routing owns account authorization, passkeys and private redemption UI. None is implemented or enabled here.

## Validation

`NODE_ENV=test npx tsx --test packages/core/test/fleetDataPlane.test.ts` exercises the Unix listener, real WAL export worker, real safely-refetchable Git cleanup, signed field/nonce/replay matrix, public and forwarded listener refusal, concurrency, recovery, cancellation, credential rotation, generation revocation, filesystem substitution and canonical fixtures. Run the existing database-export, instance-storage and native route suites alongside it. Those suites cover deeper worker and Git defenses without maintaining a second sanitizer or cleanup implementation.
