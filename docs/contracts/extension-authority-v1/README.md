# Native extension authority proof v1

This additive contract is available only at POST /extensions/authority/v1/prove
on the existing authenticated private Unix listener. It adds no extension action
and does not change the qualified fourteen-action contract or its pin. Public
and tunnel ingress explicitly refuse the path. Capability readiness remains false:
Routing and Fleet must independently pin this bundle and qualify it reciprocally.
No hosted capability, deployment or release is enabled.

Pin SHA-256 of the exact schema.json bytes and verify SHA256SUMS. source-pins.json
pins the exact implementation sources, including the unchanged qualified contract.
Messages use sorted-key UTF-8 canonical JSON, no whitespace or duplicate keys.
The request HMAC uses the existing private transport secret, but response evidence
uses a separate Core-owned Ed25519 key. Neither secret nor private key is returned.
8192-byte request/response caps apply. Refusals are always
`extension_authority_unavailable`; responses use Cache-Control: no-store.
Bodies, challenges, credentials, signing failures and customer content are not logged.

## Independent key provisioning and rotation

A native operator must generate an Ed25519 PKCS#8 private key directly on Core,
placing it in `native-authority-key.pem` in the existing private Fleet control
root, owned by the Core process account with mode 0600 and no links. This is a
fixed operator path, never a request field. Provisioning does not happen implicitly.
Export only the public SPKI (base64url, unpadded) through an independently
authenticated native/operator channel. The internal
`ExtensionAuthorityProofPlane.verificationKey()` accessor exports that public value;
there is no key endpoint. Do not reuse a transport secret or a relay-controlled key.
Missing, invalid or inaccessible key material fails closed.

Pin that public key separately from the contract/source pins in both consumers.
Never obtain or replace a trusted pin from a proof, Fleet relay, browser request,
or an error response. Rotation requires native generation of a replacement key,
explicit operator authorization of the new public pin, and independent consumer
requalification. Old pins fail signature verification immediately; no fallback,
automatic trust-on-first-use or overlapping-key acceptance is implemented. A key
change during an awaited proof check refuses that proof. Retain replay tombstones
and operation records through rotation. Do not copy the synthetic fixture key into
production. The fixture uses a deliberately public deterministic seed.

## Consumer protocol

Construct expectations from the complete opaque original work, exact actor,
qualified extension contract/scope/pin, native extension and hosted/storage/runtime/
placement identities and all generations, exact extension request/action digest,
operation ID and optional acquisition operation ID. The work digest is SHA-256 of
the consumer's complete original work commitment, not a selective projection.
Core attests to this opaque commitment; it does not receive or interpret its content.
Never submit profile bodies, ciphertext, credentials, recipient exchange fields,
commands, paths, or asserted roles/permissions to this endpoint.

1. Request phase: use a fresh cryptographically random 256-bit independent challenge,
   null authorityEpoch, and an interval of at most 30 seconds. No future-issued or
   expired requests are accepted; expiry is exclusive, without clock-skew allowance.
   Core returns its current durable epoch. Retain that epoch with the work.
2. Dispatch phase: same commitment, returned epoch, a new challenge and short
   interval. Core permits this phase only once and only before an existing native
   extension operation tombstone. Send the unchanged qualified extension request
   through its original boundary. A proof does not itself perform a mutation.
3. Status phase: same commitment/epoch and a new challenge. A native fenced or
   completed journal must match the exact actor, request, action, ID and tuple.
   A fenced/ambiguous operation is never permission to redispatch.
4. Completion phase: same commitment/epoch, new challenge. The native journal must
   be completed; current native authority and all generations must still match.
   Only one completion proof is admitted. Authority loss/re-grant, generation
   substitution, expiry or ambiguous completion refuses proof, even if a native
   operation has already happened. Status remains available with fresh challenges
   when authority and the original epoch remain valid.

If an acquisition ID applies, keep it identical across all four phases. Core also
requires a completed native recipient.issue journal for the exact actor and native
tuple, distinct from the mutation ID. The qualified recipient contract remains
responsible for verifying the acquisition-to-mutation recipient binding; this proof
contains no recipient exchanges. Consumers must independently verify that binding.

Verify the complete response with verifier.mjs and an independently held expected
request and public pin. `verifyProof(response, expected, publicPin, nowMs, consumed)`
requires a replay set. Durably persist consumption before taking action and preserve
it across consumer restarts. The CLI accepts response JSON, expected request JSON,
public pin file, and explicit current epoch milliseconds; it verifies a single proof
and prints only `verified` or a generic error. It is a fixture/reference verifier,
not a replacement for a consumer's durable replay ledger. Canonical fixtures cover
all phases. No proof substitutes for independent Connect account, subscription,
installation or passkey evidence: `connectAuthorityVerified` is always false.
Native-only authority is insufficient to enable a Connect workflow; Connect-only
authority is insufficient for a native proof.

## Durability and race boundary

SQLite triggers advance a global monotonic epoch on every membership INSERT,
UPDATE or DELETE, including direct SQL and same-actor ABA. The epoch lives outside
membership rows, survives deletion/restart, and rolls back atomically with failed
membership transactions. Unrelated membership changes conservatively invalidate
outstanding work too. Current native permissions are derived from the durable role
(admin grants instance.manage_settings). Changes to role/source change the epoch.
A future persisted permission policy or changed role-to-permission mapping MUST
advance the epoch and install equivalent triggers as part of its migration.
Overflow refuses mutation, never wraps. Missing epoch tables refuse proof.

The initial uncached durable decision is compared with the final decision after
awaited authorization and connection acquisition. The final native filesystem reads,
SQLite BEGIN IMMEDIATE authority/epoch observation, Ed25519 signing and socket reply
are synchronous: no awaited boundary can interleave a membership change or in-process
generation change with emission. Native control ancestry and file identities are
re-observed, and runtime publication must equal independently observed storage/runtime/
placement authority. SQLite holds the writer barrier through final emission. Configured native reset
fences also hold their cross-process generation barrier through emission. Proof
admission commits use synchronous=FULL, restoring the application's connection
policy afterwards, so replay records and the observed epoch are flushed together.
Like any signed observation this is point-in-time evidence, not a lease preventing
later revocation: each subsequent phase requires another independently challenged proof.

Authenticated challenge tombstones are durable before phase admission and never
recycled automatically (16384 cap). Phase commitments are durable (4096 cap), so
lost replies are ambiguous and cannot be retried with a new challenge as new work.
An operator must preserve these ledgers across restart; deleting/resetting the
underlying customer database requires new instance identity and independent repinning.
Original extension operation/status tombstones are read only and remain untouched.
This implementation requires native SQLite; unsupported drivers fail closed.
