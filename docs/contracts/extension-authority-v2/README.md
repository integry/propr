# Managed extension authority v2 (local contract only)

This is a new revision, not a reinterpretation of v1. Consume the exact `schema.json`
SHA-256 in `capabilities.json` and the source SHA-256 manifest in `source-pins.json`;
`SHA256SUMS` pins the entire handoff bundle. The native fourteen-action schema and
its qualified pin remain unchanged. All public, downstream and action readiness
flags remain false. No selected runtime is qualified. Fleet #104 and Routing's
reciprocal implementation are not completed by this Core change.

## Operator trust boundary

Provision `routing-extension-authority-v2.json` as canonical JSON (no newline) in
the existing private Fleet control root, with the exact `trust` schema. It contains
only an Ed25519 SPKI public key, key ID/epoch, authority epoch and producer source
SHA-256/revision epoch. Provision through an independently authenticated operator
channel. The request cannot select a key, URL, verifier or alternative authority.
Missing, malformed or changed trust fails closed. Rotation invalidates old proofs
for new admissions and exact retries; retain old pins separately for offline audit.
Never put Routing private keys in Core. The existing independently provisioned
`native-authority-key.pem` signs Core receipts. Fleet pins its public SPKI outside
this response. The Fleet HMAC authenticates transport only.

Apply both authority migrations on SQLite. The listener remains on its existing
private authenticated Unix socket, with the single fixed v2 path published by the
schema. Public HTTP and tunnel ingress refuse it. No discovery or browser roles.
The control directory and socket ownership/mode checks are the Unix peer boundary;
HMAC authenticates requests within that boundary. There is no portable SO_PEERCRED
API in this listener and no claim of separate per-process peer identity.

## One call per phase

Routing must sign exactly one canonical allow statement for each immutable
request, dispatch and completion phase, after checking all external coordinates
and epochs. It must not obtain duplicate fresh Core decisions. The Routing
statement embeds the exact Core request, including full immutable work, native
assertion/nonce/request digest, acquisition, scope and Core epoch. Its checked time
and exclusive expiry have zero skew. All external epochs are Routing assertions;
Core independently checks current durable local administrator authority and exact
native instance/placement/runtime/storage identity under SQLite's writer lock.

Call request once with metadata. Call dispatch once with the same work and the
unchanged native request in `native`. This is the narrowly versioned native
transport wrapper: the old `{assertion,request,mac}` endpoint does not acquire v2
authority. The native payload is used only by native dispatch; the authority ledger
and proof contain only its signed digest. Call completion once after dispatch has
a committed receipt. Status accepts fresh, single-use challenges and observes
native completion without executing it. Its anti-replay bookkeeping is durable.

Each phase first commits a create-only intent; request also claims operation, nonce and both trust identities. Rotating either
authority key/epoch fences pending operations, even with a newly signed phase. Dispatch reserves the existing native v1 tombstone namespace before doing
work. Admission, the native SQLite mutation, immutable Core decision, Routing
statement/signature digest, public trust configuration digest, combined decision,
result commitment and Ed25519 receipt then commit in one FULL-synchronous SQLite
transaction. Native store nested transactions share that same connection. The
final authority check, receipt and COMMIT run without an await under the configured
reset fence. No native filesystem journal claims v2 completion.

Recipient receipts additionally bind the target mutation operation and canonical
intent digest. Credential-bearing dispatch requires that exact acquisition; its
volatile recipients cannot come from a different acquisition or legacy operation.

The response is a bounded receipt, not native output: no profile bodies, skill
contents, ciphertext, tokens or raw results are copied into authority storage or
responses. `nativeResultDigest` commits to the complete canonical native response envelope; a consumer
that already holds a native result can compare it. This contract does not provide
a raw-result retrieval channel. In particular, a recipient's volatile material is
not reconstructible after restart. That limitation must remain a downstream
qualification gate; it cannot be treated as successful credential acquisition.

## Recovery and verification

A same-challenge, byte-identical request/dispatch/completion retry returns only the
retained signed receipt while its original authority/trust/time fences still hold.
Changed challenges cannot re-admit those phases. Status challenges cannot retry.
An intent without a receipt is incomplete forever; neither it nor a filesystem
fence authorizes redispatch. A rolled-back intent has admitted nothing. A committed
receipt reconstructs success even after a lost reply. Status reports the dispatch
receipt's result commitment, or incomplete; it never invents success from an
intent. Application-level remote/network side effects cannot be rolled back;
ambiguous calls are never retried. All native SQLite mutations roll back together.

Use `verifier.mjs` with the actual canonical response wire string, independently
retained request and Routing authorization, operator-pinned Routing trust, and
independently pinned Core SPKI. Persist consumed challenges before acting. Verifying
an historical receipt is not a new authorization to execute work. Completion/status
consumers must compare the dispatch decision and result commitments to their held
dispatch receipt. Expired retained evidence is audit material, not fresh authority.

The bounded append-only tables intentionally have no garbage collection. Exhaustion
fails closed; operators must not delete tombstones or roll back authority databases.
The persisted high-water clock rejects backwards time at transaction boundaries.
Whole-database restoration to an earlier snapshot is outside SQLite's local
anti-rollback guarantees and requires external operator fencing.

Generate/check fixtures with `npm run build -w @propr/shared` then
`node scripts/generate-extension-authority-v2-fixtures.mjs [--check]`. Fixtures use
public deterministic test keys only. `fault-transcript.txt` is asserted by the
real SQLite fault tests; it distinguishes lost commit acknowledgement from rollback.

`crash-transcript.txt` is independently asserted by child-process SIGKILL tests at
intent, nonce/tombstone, native mutation, decision insertion, result commit and reply
boundaries. Each restart runs SQLite integrity checks and verifies retained proofs.
