# Private volatile extension result delivery v1

This immutable outer wire contract layers on the unchanged signed
`propr.extension-authority.v2` receipt. Only POST on the existing private Unix
`/extensions/authority/v2/invoke` path emits it. Express and tunnel ingress refuse
that path. No negotiation or public route is added. Consumers must explicitly
adopt this outer contract; the authority receipt is still independently verified.

The canonical UTF-8 response has exactly `contract`, `receipt`, `delivery`.
`delivery` is either `{ "state": "unavailable" }` or
`{ "state": "available", "action": <retained action>, "native": <complete native envelope> }`.
The native envelope is the existing fleet-extensions v1 completed result; its
canonical SHA256 equals the signed receipt's `nativeResultDigest`. The outer
response is at most 288 KiB, its native envelope at most 256 KiB. All fourteen
public result schemas are closed, with bounded strings, arrays and counts.
No credential, ciphertext, private field, skill contents or diagnostic slot exists.

Only the first successfully committed dispatch can deliver. Request, completion,
status, incomplete operations and exact retries never deliver native results.
An exact retry retains the original receipt and explicitly says unavailable.
Delivery absence is not mutation failure. The outer availability indicator is not
signed authority: dropping a result can only remove delivery, never authorize work.

The SQLite mutation, digest and v2 receipt commit together before any response
bytes or recipient material leave the call. The raw result is call-local and is
never saved to the authority ledger or filesystem journal. Commit ambiguity,
socket close, write failure and shutdown do not cause redispatch or rollback of
committed work. A terminal intent without a receipt remains incomplete under v2.
Native mutation storage still stores its normal profiles and encrypted credentials;
it is not an authority/result cache. No response or native error is logged.

For a lost public projection, Routing may authorize a new independent read.
A lost recipient is never reconstructed. A distinct acquisition can mint a new
recipient for the identical immutable mutation operation and intent. The old
recipient expires normally (or is destroyed at shutdown), is unavailable to the
caller, and cannot authorize another mutation. Neither a fenced native journal
entry nor a retained acquisition receipt proves that recipient bytes were delivered.

Run `verifyDelivery(raw, expected, native, routing, trust, coreSPKI,
recipientSPKI, nowMs, consumed)` from `verifier.mjs` on Node 24, without dependencies.
Pass the received Uint8Array/Buffer bytes, or a string decoded with fatal UTF-8
validation; never decode with replacement characters or reserialize parsed JSON.
Keep the expected authority request, native request, Routing authorization, trust,
and both SPKI pins independently; never select them from the response. `consumed`
is the caller's challenge set; persist consumption before acting. Retry reconciliation
must compare the retained receipt and must never repeat the original action.
The verifier checks both v2 signatures and the separate recipient Ed25519 signature.
Browser encryption must still verify its independently expected recipient binding.
All work/scope/authority/placement/runtime/storage epochs are bound through exact
receipt request equality; recipient assertion, audience, instance, mutation intent,
server and field additionally match the retained acquisition request.

`schema.json`, deterministic synthetic fixtures, standalone verifier and generated
binding parser are pinned by SHA256SUMS. Source pins bind the implementation and
tests; regenerate with `node scripts/generate-extension-result-delivery-fixtures.mjs`
after building shared, and use `--check` for reproducibility. The binding parser is
generated from the same shared validation function used before producer commit.
The copied authority verifier/schema retain the v2 interpretation and pin.

All public, downstream, action and selected-runtime flags remain false. This bundle
is producer implementation evidence only. It does not qualify Routing, Fleet #104,
browser UI, selected runtimes or deployment. No release or readiness is enabled.
