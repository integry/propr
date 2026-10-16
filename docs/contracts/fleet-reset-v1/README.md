# Fleet managed reset proof boundary v1

The opt-in native implementation supports destructive reset, terminal receipts,
and successor bootstrap in provisioned disposable qualification environments.
It seals durable generation admission, waits for participant resource closure,
closes queue/session/tunnel owners, erases owned tenant categories, and creates
an empty successor. Terminal proof requires two stable observations, including
external service refusal and the exact durable successor control identity.
Missing or uncertain evidence remains fail-closed as `recovery_required`.

**Hosted enablement and public capabilities remain disabled.** This does not
qualify Fleet PR #96 or authorize live tenant resets. `capabilities.json`
advertises `terminalProof: false`, `destructiveEffects: false`, and
`successorBootstrap: false` for that enablement boundary; it also identifies
the implemented opt-in native adapters and disposable integration coverage.
Fleet must keep full reset unavailable with this capability set. An HTTP 200,
valid MAC, or requested fresh identity alone does not establish success.
Nothing is deployed or published.

## Transport and opt-in

POST canonical UTF-8 JSON to `/reset/v1/invoke` on the existing private Fleet Unix
HTTP listener. There is no TCP reset listener or forwarding route. The customer
listener, including tunnel ingress, returns 404. All responses use
`Cache-Control: no-store`. Only `Content-Type: application/json` is accepted;
content encoding, query parameters, unknown fields, duplicate JSON keys and
noncanonical representations are rejected. Maximum request size is 8192 bytes;
maximum response size is 16384 bytes. Refusals are generic 403 responses containing
only `{"error":"fleet_reset_unavailable"}`. No exception, path, provider payload,
customer secret, request MAC, or credential value is logged by this boundary.

Existing Fleet data authority must already be configured. Separately provision a
private `fleet-reset-control` directory beside `fleet-data-control` under the
existing storage control parent. Its `authority.json` has exactly:

```json
{
  "contract": "propr.fleet-reset.v1",
  "contractPin": "<schema.json SHA-256 from pin.json>",
  "audience": "fleet-reset-coordinator",
  "binding": "<the exact binding object described below>",
  "secretSha256": "<SHA-256 of the dedicated reset secret UTF-8 bytes>",
  "enabled": true
}
```

The directory must be owned by the process UID, mode 0700; files are mode 0600,
regular single-link files. Symlinks and substituted ancestry are refused. Supply
`PROPR_FLEET_RESET_SECRET` independently of the Fleet export, customer,
session and bootstrap keys. It must contain 32–4096 UTF-8 bytes without leading or
trailing whitespace. Neither root nor credential is auto-created. Absent reset
authority leaves the endpoint disabled. Configured invalid authority, missing
secret or wrong pin refuses API readiness. The directory is private control
state, not part of customer export or native repository cleanup.

Provision only synthetic/disposable qualification environments while capabilities
remain disabled. Do not point this boundary at live tenant reset work.

## Binding and authentication

`schema.json` contains exact JSON Schemas for requests and responses, the fixed
actions, protocol limits, MAC domains and cross-field rules. `pin.json` pins the
schema, fixtures, capabilities and independent verifier. Check all `SHA256SUMS`
entries against a trusted source pin before using a bundle. Schemas alone do not
check the succession arithmetic or MAC; use the verifier as well.

The envelope contains exactly `assertion` and `mac`. The assertion contains:

- `contract`, `contractPin`, `audience` as above.
- `binding`: `resetOperationId` (lowercase UUID), `resetRequestDigest` (the Fleet
  reset request's SHA-256), `resetAction: "instance.reset"`, `instanceId`,
  `predecessor`, `successor`, and `runtimeBuildDigest` (SHA-256).
- Both identities contain exactly `generation` (nonnegative safe integer),
  `stateScope`, `runtimeId` and `storageId` (lowercase UUIDs). Successor generation
  must equal predecessor generation plus one; its scope is exactly
  `reset:<resetOperationId>`. Both scopes, runtime IDs and storage IDs must differ.
  These are *requested bindings*, not evidence of actual runtime or storage
  freshness. Native terminal proof independently checks successor storage and
  control identity before allowing bootstrap.
- `action`: `reset.prove` or `reset.receipt` only.
- `requestId`: fresh lowercase UUID for each request, including observations.
- `nonce`: 32 random bytes as 64 lowercase hex characters, never reused.
- `issuedAt`, `expiresAt`: nonnegative safe integer Unix seconds. Lifetime must be
  positive and at most 30 seconds; no future issuance or expiry grace is allowed.

Canonical JSON sorts object keys lexicographically, retains array order, uses
JSON escaping, and has no whitespace or trailing newline. Request MAC is
HMAC-SHA256 with the dedicated secret over the UTF-8 concatenation of
`propr.fleet-reset.v1.request\n` and the canonical assertion. Receipt MAC uses the
separate `propr.fleet-reset.v1.receipt\n` domain and canonical receipt. Both use
lowercase hex and constant-time digest comparison. Never reuse these keys for
other audiences.

All request binding fields must equal the locally provisioned authority. The
process never adopts a changed authority: an observed replacement permanently
fences that process, even if the original bytes return. Operators must never
recycle an instance's generation/scope/runtime/storage identities or roll back
control state. The native generation fence persists admission and effect custody outside
tenant state; it does not make external control-storage rollback safe.

## Durable recovery without destructive retries

`reset.prove` exclusively creates an immutable operation record containing the
original proof request ID and exact binding. With provisioned native ownership
and adapters it dispatches the native reset once; without native coverage it
returns recovery evidence without destructive effects. A repeated proof call, including a fresh request
ID for the same reset operation, is rejected. Nonce and request tombstones are
created exclusively and fsynced before operation admission. An interrupted write
burns admission; no tombstones or uncertain records are automatically repaired,
removed or retried. Storage is bounded at 16,384 control entries and the existing
64 KiB private-file limit. Exhaustion requires operator recovery.

`reset.receipt` requires a new authenticated request but reads the same durable
record. It can be repeated after a lost response or process restart without
reissuing `reset.prove`. Reads are serialized against local admissions; exclusive
filesystem creation arbitrates concurrent processes. Missing, corrupt, unsafe or
mismatched records produce `interrupted_or_corrupt` recovery evidence, never an
empty-state claim. Receipts are freshly authenticated and expire with the
observation request; their `evidenceDigest` remains stable for the durable proof.
The receipt echoes the full binding, observing action/request ID, SHA-256 of the
exact envelope bytes, original proof request ID (or null for uncertainty), and
all nine required categories. Recovery evidence leaves bootstrap/isolation/
fencing flags false. Native completion marks every category erased and permits
bootstrap only after stable successor isolation proof.

`verify.mjs` is a dependency-free reference for Fleet. `verifyRequest` requires
an expected binding, trusted contract pin and current Unix seconds.
`verifyReceipt` additionally requires the exact fresh request bytes. A valid
result can be recovery evidence or a complete native receipt. Fleet must enforce
request/nonce uniqueness in its own outbound custody and keep hosted reset
enablement disabled. The reference verifier accepts strictly bound terminal
evidence with `stable_native_proof` and an observation digest; it rejects omitted
or unknown categories, inconsistent flags and partial terminal statuses. Historical fixtures use a public key
and their own fixed verification clock; they must never pass live verification.

## Native opt-in and qualification

Native startup additionally requires provisioned `native.json`, the durable
generation identity, `PROPR_FLEET_RESET_RUNTIME_ROOT`, explicitly owned tenant
paths, and a dedicated `PROPR_FLEET_RESET_SERVICE_SECRET`. The configured queue,
session and tunnel/bootstrap adapters require external generation revocation
and observations. Local deletion alone cannot certify remote closure.

Durable effect intents and participant leases survive outside tenant state.
Graceful participant shutdown releases its lease only after closure succeeds;
failed closure or a quiescence timeout prevents terminal proof. Receipt
reconciliation observes effects without retrying uncertain destructive calls.
Successor observation opens existing control storage without provisioning it,
and validates the exact identity and staged or activated binding state.
Fleet owns VM/process replacement outside this application boundary.

Disposable tests exercise the real Unix listener, filesystem and SQLite with
injectable external service boundaries. Hosted qualification of the exact
runtime and production external services remains separate. Existing self-hosted
behavior stays unchanged unless explicitly configured for native reset.

## Verification

```sh
npm run build -w @propr/shared
node scripts/generate-fleet-reset-fixtures.mjs
NODE_ENV=test npx tsx --test packages/core/test/fleetResetProof.test.ts packages/core/test/fleetNativeReset.test.ts
```

The suite covers dedicated auth and pin failures, strict canonical parsing,
expiry, replay, stale bindings, repeated recovery reads, observed authority ABA,
concurrent admissions/readers, corrupt/missing journals, every missing or
fabricated category, secret omission, real Unix HTTP requests, public refusal,
and agreement between both verifiers and the pinned fixture corpus. Native
coverage includes destructive-effect interruptions, graceful participant
replacement, delayed quiescence, successor control loss/corruption, and
successor bootstrap isolation. There are no UI changes or visual previews.
