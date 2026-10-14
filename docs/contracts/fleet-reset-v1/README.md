# Fleet managed reset proof boundary v1 — recovery only

**This does not complete ProPR #3111 or qualify Fleet PR #96.** The current guest
has no unified reset owner for the database, configuration, repository/worktree
and cache data, workers and queues, unpublished results, provider sessions,
tunnel/bootstrap material, and diagnostic logs. Neither an empty directory nor
an executor's `empty: true` assertion establishes those properties. This build
therefore cannot emit terminal proof or permit successor bootstrap. All public
capabilities remain disabled. Nothing is deployed or published.

This contract implements the authenticated, strictly bound, durable refusal and
recovery boundary. `capabilities.json` explicitly advertises `terminalProof:
false`, `destructiveEffects: false`, and `successorBootstrap: false`. **Fleet must
keep full reset unavailable with this capability set.** Do not reinterpret an
HTTP 200, valid MAC, fresh identity, or complete category list as reset success.
The only possible evidence state is `recovery_required`, with all categories
`unproven`. There is deliberately no generic executor/adapter callback that can
supply fabricated success booleans.

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
`PROPR_FLEET_RESET_SECRET` independently of the Fleet export/extension, customer,
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
  freshness. This build does not assert those properties.
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
control state. Detecting an unobserved external A→B→A rollback requires the future
native monotonic authority; this contract does not claim to implement that gate.

## Durable recovery without destructive retries

`reset.prove` exclusively creates an immutable operation record containing the
original proof request ID, exact binding and refusal evidence. It performs no
native destructive operation. A repeated proof call, including a fresh request
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
all nine required categories. Every bootstrap/isolation/fencing flag is false.

`verify.mjs` is a dependency-free reference for Fleet. `verifyRequest` requires
an expected binding, trusted contract pin and current Unix seconds.
`verifyReceipt` additionally requires the exact fresh request bytes. A valid
result is **recovery evidence only**. Fleet must enforce request/nonce uniqueness
in its own outbound custody and keep terminal reconciliation disabled. The
reference verifier deliberately rejects signed success, omitted categories,
unknown categories and partial statuses. Historical fixtures use a public key
and their own fixed verification clock; they must never pass live verification.

## Remaining native work

A terminal-capable version must implement and test a native lifecycle owner that:

1. Stops admission and drains/fences every worker, queue, provider login/session,
   tunnel/bootstrap flow, background writer, result publisher and diagnostic
   producer, retaining uncertainty after interrupted effects.
2. Erases or irrevocably invalidates each category through its actual owner,
   including out-of-process Redis and mounted provider/tunnel state. Filesystem
   naming conventions or a generic executor assertion are insufficient evidence.
3. Enforces monotonic generation and state-scope identity at *every* producer and
   consumer, prevents ABA and concurrent reads/effects, and independently proves
   fresh successor runtime/storage identities before releasing bootstrap.
4. Persists native category evidence and one-shot effect custody outside reset
   state so recovery can observe rather than repeat destructive effects.
5. Qualifies the exact selected runtime with Fleet PR #96 and adds per-category
   partial failure, queue/session/tunnel cross-generation refusal, and bootstrap
   barrier tests against real native owners.

Those changes require a new terminal-capable contract pin/version. This recovery
contract cannot be silently upgraded by adding a completion callback or setting
a capability boolean. Existing self-hosted exports, cleanup, reset and provider
flows are unchanged.

## Verification

```sh
npm run build -w @propr/shared
node scripts/generate-fleet-reset-fixtures.mjs
NODE_ENV=test npx tsx --test packages/core/test/fleetResetProof.test.ts
```

The suite covers dedicated auth and pin failures, strict canonical parsing,
expiry, replay, stale bindings, repeated recovery reads, observed authority ABA,
concurrent admissions/readers, corrupt/missing journals, every missing or
fabricated category, secret omission, real Unix HTTP requests, public refusal,
and agreement between both verifiers and the pinned fixture corpus. It does not
claim native deletion or successor isolation coverage. There are no UI changes
and no visual previews.
