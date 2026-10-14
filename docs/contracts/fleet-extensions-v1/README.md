# Private extension management v1

Pin the SHA-256 of the exact UTF-8 schema.json bytes using contractPin; verify
SHA256SUMS and canonical fixtures before integrating. This separately scoped
contract is additive on the provisioned Fleet Unix listener at POST
/extensions/v1/invoke. Never expose it through Express, Connect or a tunnel.
Fleet data v1/v2 pins, requests and canonical bytes are unchanged. No authority
or controls are provisioned by this change. Use the existing operator-owned
Fleet control root and secret. This repository does not establish downstream
readiness: Fleet/Routing must pass reciprocal suites against this exact pin.
capabilities.json advertises supported operations and the remaining gates.

All messages are canonical sorted-key UTF-8 JSON without whitespace; duplicate
keys, extra fields, unknown versions/actions and invalid pins are refused.
Assertions use the existing HMAC-SHA256 provisioned secret and bind the full
request digest, numeric GitHub actor, hosted/storage identities, all three
generations, action, operation ID, nonce and issue/expiry epoch seconds.
Profile selections bind the independent native extension instance identity,
profile UUID and exact revision inside the signed request digest. Never use a
Connect grant, repository access, username, bootstrap or implicit identity as
instance authority. Every admission, dispatch, status, recipient issuance and
consumption, mutation, validation and completion checks uncached durable admin
and instance.manage_settings plus the current Fleet generations/authority.
Native profile mutations use revision compare-and-swap and transaction checks.

## Write-only credentials

1. Independently provision Core's Ed25519 SPKI verification-key pin to the
   browser through an authenticated native/operator channel. The local
   FleetExtensionPlane.recipientVerificationKey() accessor returns only this
   public pin; no public endpoint is added. The signing identity is derived with
   domain separation from the existing native credential-custody root and
   extension instance identity. A root/instance rotation requires explicit
   authenticated re-pinning. Never accept a verification key delivered by the
   management relay. Choose a fresh mutation operation UUID and exact public create/update intent.
2. Issue recipient.issue with that intent, operation UUID, HTTPS server name and
   bearerToken field. The signed acquisition is a distinct operation.
3. Core returns only recipient UUID, algorithm, uncompressed SEC1 P-256 public
   key (base64url), exact binding, and an Ed25519 signature over the canonical
   recipientId/algorithm/publicKey/binding object. Use the shared browser WebCrypto producer
   encryptFleetExtensionSecret(recipient, token, { verificationKey,
   expectedBinding }) or implement its pinned protocol. Build expectedBinding
   from independently trusted native identity/generation information and the
   browser's exact acquisition assertion, actor, intent, field and operation;
   never blindly copy a relay's binding into trusted expectations. The producer
   verifies the signature with the independent pin and requires exact canonical
   equality with expectedBinding before encrypting. This prevents recipient key
   substitution and redirecting a token into an attacker-selected intent.
4. Generate a browser ephemeral P-256 pair. ECDH then HKDF-SHA256 uses UTF-8
   recipient UUID as salt and UTF-8 propr.fleet-extensions.v1 as info. AES-256-GCM
   uses a fresh 12-byte IV, 128-bit tag, canonical binding bytes as AAD. Encode
   printable ASCII token bytes in a zero-filled 4096-byte buffer. Send 4112-byte
   ciphertext including tag plus ephemeral public key, all unpadded base64url.
   Fixed padding hides plaintext length. Routing/Fleet relay ciphertext only.
5. Submit the exact intent with sealed recipients using the chosen mutation ID
   and a fresh signed assertion whose digest covers the entire request,
   including ciphertext. Core authenticates both acquisition and mutation,
   claims recipients synchronously before decrypting, then passes plaintext
   directly to native encrypted custody. Every recipient binds actor, identities,
   generations, profile/revision or create intent, action, server, field,
   acquisition assertion (including nonce/digest/time), mutation ID and expiry.

Recipients expire with the acquisition assertion (maximum 60 seconds). Keys
exist only in process memory; consumption, invalid authenticated consumption,
expiry, issuance failure and shutdown erase private buffers. Restart discards every recipient;
keys are never persisted, exported, backed up or returned. Runtime restart also
fences old assertions. JavaScript/crypto runtimes may retain temporary internal
copies until garbage collection; process dumps and memory snapshots are outside
the supported custody boundary and must not be collected. No request bodies,
plaintext, ciphertext, crypto/native errors or public key exchanges are logged
or journaled. Only signed assertion metadata and outcome state are journaled
outside customer exports. Stored credentials use existing encrypted
ExtensionProfileStore custody; native same-origin administration remains usable.

A durable nonce/operation claim precedes dispatch. Status returns outcome
metadata only and revalidates the original actor/audience and both assertions.
Expired outcomes are unavailable. A fenced outcome means uncertain or refused;
never automatically retry a mutation. Re-read the exact current revision with a
new authorized operation. Lost replies cannot reuse an operation or recipient.
The private namespace retains tombstones, with a 4096-extension-operation hard cap and shared 16384-entry namespace cap; an
operator must migrate to a new placement/runtime and private namespace when
exhausted. Do not recycle tombstones under the same authority. At most 64
recipients and 8 encrypted fields per mutation are supported. Requests (the entire canonical envelope) and completed responses are each capped
at 256 KiB, using the shared `FLEET_EXTENSION_LIMITS` constants in Core and the
private listener. Remote profile repository scopes have at most 64 entries of
200 characters each; native same-origin input behavior is preserved.

The maximum create/update envelope fits independently of the transport cap:
URLs contribute at most 8 × 2,048 × 6 = 98,304 JSON bytes, the profile name at
most 100 × 6 = 600 (including worst-case JSON escaping), tool names at most
8 × 64 × 128 = 65,536, agent scopes 64 × 100 = 6,400, repository scopes
64 × 200 = 12,800, server names 8 × 48 = 384, bundle IDs 8 × 36 = 288,
and eight sealed fields at most 8 × (5,483 + 87 + 16 + 36) = 44,976.
These total 229,288 bytes; JSON keys/punctuation, fixed values, selection and
assertion metadata together consume less than 16 KiB, leaving the envelope
below 256 KiB. Restricted identifier alphabets cannot require JSON escaping.
Recipient acquisition embeds the same bounded input without ciphertext and
also fits.

Public responses include stored skill-bundle descriptors and historical metadata,
whose sizes cannot be inferred from the input's bundle IDs. Create, update and
disable therefore preflight the exact completed response inside the save
transaction before committing; an oversized projection rolls back both the
profile head and revision. The response serializer uses the same size check
at completion. Oversized lists/history are refused, not partly returned. All errors are generic fleet_extensions_unavailable.

## Skills and runs

Only an exact GitHub commit and relative skill directory are accepted. Core's
native GitHub client fetches commit/tree/blobs; no credentials or private bytes
are supplied by Routing. Tree/file/byte bounds, link/mode rejection and native
skill path/content protections apply. Upload is explicitly unsupported.
Immutable provenance and digest are returned; requirements remain declarations
and cannot implicitly install endpoints, credentials or capabilities. Native
run staging remains read-only. selection.validate checks exact current revision,
agent/repository/runtime scope and native endpoint/catalog policies. It returns
no execution grant; later native runs must independently authorize and select
the exact revision. Another run without a selection receives no extensions.
profile.validate returns only safe reachability markers; upstream response data
and error details never cross this boundary. Catalog validation truthfully
returns not_validated as in the native API.

Run `npm run build -w @propr/shared`, then
`node scripts/generate-fleet-extension-fixtures.mjs` to reproduce this bundle.
Run the Fleet extension, Fleet data, native extension and API private-listener
suites before pinning. Contract changes require a new version and explicit
migration; do not amend a deployed immutable pin.
