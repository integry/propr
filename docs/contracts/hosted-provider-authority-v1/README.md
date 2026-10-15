# Hosted provider authority foundation v1

This Core foundation starts from merged main `8aad09cbc947a0bf4929e244365ad134dc96c1b7`.
It **does not make hosted reset production-ready**. It enables no hosted, public,
reset, release or readiness gate, performs no provider operations and changes no
Fleet/Routing contract or pin. There is no startup, config-route, login-container,
agent, callback, task/goal, reset-composition or UI integration in this lane.

The exports in `packages/core/src/providerAuthority/index.ts` are the contracts
and producer state machine for later integrations. `AUTHORITY_SCHEMA` is canonical
JSON describing the closed input schemas and resource catalog;
`PROVIDER_CATALOG_REVISION` pins it. Unknown fields and noncanonical retained state
are refused. All boundary errors have the constant message
`provider_authority_unavailable`; adapter errors and validation diagnostics never
cross the boundary. Public observations and metadata seal commitments are
projections, not authenticated cross-boundary reset proof. Later proof composition
must authenticate these exact commitments and cannot accept serialized grants or
caller-supplied JSON as authority. Authority handles use JavaScript private fields so ordinary
inspection/serialization cannot expose the injected custody store.

## Trust and storage ports

`createHostedProviderAuthority(enrollment, ports)` requires an explicitly supplied
`HostedAuthorityStore`, clock, versioned keyed commitment port and independent
readback adapter. There is no default filesystem, app database, tenant-state,
environment-selected or in-memory hosted backend. The only in-memory store is in
test helpers. `createSelfHostedProviderAuthority()` returns a separate unqualified
mode with no hosted grant methods; it cannot satisfy the hosted constructor.

Composition owns the exhaustive, trusted creator enrollment. It is not public
request data. Every implementation capable of creating managed resources must be
enrolled before admission, with its exact implementation revision, provider,
agent/source kind and supported catalog resources. The constructor checks full
catalog resource coverage, no duplicate issuer/resource declarations, and exact
catalog revisions. Enrollment also pins the independent observer implementation
revision. Enrollment cannot be extended or revised in place. Different
creators may cover the same resource; **every one** must close. Changing a creator,
policy, owner or catalog requires a new exact successor enrollment. This contract
cannot discover an omitted out-of-band implementation; qualifying all creation
paths is an explicit follow-up integration obligation.

The store is a permissioned control-root authority outside erasable tenant/app
state, with linearizable reads, create-only initial compare, and atomic,
crash-durable compare-and-swap at an exact revision. New entries start at revision
0; successful updates advance exactly once. Failed comparisons have no effect.
There is no delete, TTL, lease stealing or tombstone removal API. The entire
aggregate changes in one CAS, including inventory high-water, claims and fences.
Adapters must preserve authority across process restart, tenant reset, ordinary
deletions and successor activation, and enforce permissions, retention, backup
and rollback protection. Missing/corrupt retained authority must fail closed;
composition must distinguish first provisioning from loss of an existing
control root. An adapter that silently re-creates a lost root is nonconforming.
The durability marker is a trusted adapter contract, not evidence of a storage
system's physical durability.

`test/helpers/providerAuthorityStoreConformance.ts` contains a reusable deterministic
conformance suite for later Fleet control-root adapters. Run it against separately
opened handles sharing one isolated backing root, then add backend-specific
process-kill/reboot, permissions, root-loss and anti-rollback tests. The fixture
store only proves kernel behavior and the adapter contract, not production
storage qualification.

`AuthorityClock` supplies integer milliseconds. Mutations durably retain the last
clock observation and refuse rollback. Lease TTL is positive and at most 30
seconds; expiry never closes a writer, revokes a resource, steals dispatch or
establishes inventory completeness. The versioned `AuthorityKeys` port must use a
dedicated MAC key, bind the supplied domain and exact canonical binding, and keep
the key private. Tokens/env values and provider session identifiers are stored
only as keyed commitments (including incarnation), never raw secret hashes.
Private locators may be retained only inside the injected permissioned store.
They are excluded from grants, observations and errors. The readback adapter may
have its own permissioned access to that same private custody; no public locator
resolution method exists. A private locator is custody, not deletion authority:
physical adapters must prove that the referenced object still has the exact
resource incarnation. A reused path or provider identifier cannot authorize an
effect against a replacement object.

## Managed resource catalog

| Provider | Distinct managed credential resources |
| --- | --- |
| Claude | `claude-home` (`.claude`); `claude-settings` (separate `.claude.json`) |
| Codex | `codex-home` (`.codex`) |
| Antigravity | `gemini-home` (`.gemini`) |
| OpenCode | `opencode-config` and separate `opencode-data` |
| Every provider | `tenant-env` and `tenant-api-key` |

Catalog entries contain symbolic resource keys, not secret values or tenant
paths. `classifyProviderCustody` treats arbitrary/manual host paths, inherited
process environment and shared operator credentials as **unowned-unqualified**.
They must never be promoted to tenant-owned deletion targets by a file scan or
because a provider happens to use them. Each provider has distinct session kinds:
launch reservation, provider login, provider session, resume, conversation,
retry/replacement and callback. These are not Routing app sessions or Fleet
runtime-access authorities.

## Producer lifecycle

Every reservation records the exact tenant, instance, predecessor generation,
state scope, runtime generation, host, owner/policy epochs, category, enrolled
creator implementation/catalog revisions, provider, agent/source kind,
operation/attempt and a fresh, non-reusable resource incarnation. No retained
record or incarnation is deleted. Per-root high-water sequences remain monotonic
through successor transfer. Reused provider identifiers produce distinct keyed
commitments for distinct incarnations.

1. Config integrations call `prepareCredentialConfig`; login/run/migration writers
   call `reserveCredentialWriter`; login/run/probe/migration readers call
   `reserveCredentialUse`. These append before a read-write home can be mutated.
   Writers exclude other writers and readers of the same managed resource;
   readers may coexist. Expired/unknown writers continue to exclude admission.
2. Physical launch integrations call `reserveProviderLaunch` before starting any
   physical work. A reservation remains inventory even if launch never returns a
   provider session ID. A session grant does not substitute for credential writer
   custody: a login/run that can mutate a managed home must separately hold the
   matching writer authority for every affected catalog resource.
3. `claimDispatch` durably changes a reservation to dispatched exactly once and
   only then returns an immutable, process-local capability. The capability is
   bound to purpose, full reservation, identity, incarnation and deadline; copied,
   serialized, expired, foreign or renewed grants cannot authorize transitions.
   A physical adapter calls `consumeGrant` with its required purpose immediately
   before performing the effect. Redemption authenticates the local capability,
   checks the current fence/closure and deadline, and permits that effect only
   once. Issuance and session binding require durably acknowledged redemption.
   An attempt is burned before persistence; a false CAS or thrown/lost reply
   cannot authorize metadata completion or renewal, even if persistence committed.
   Renewal preserves both the attempted and confirmed redemption states.
   Consumers must execute the granted purpose within its scope. An ambiguous
   claim is burned: do not retry physical work because the acknowledgement was lost.
4. `commitCredentialConfig` / `commitIssuance` records committed issuance.
   `bindSessionId` binds the exact returned identifier by keyed commitment, with
   identical retries permitted and rebinding refused. No raw provider ID is
   projected or retained. Launch reservation and ID binding accept an optional
   stable private custody locator retained only in the control-root store; once
   bound it cannot be changed. Later adapters must retain the actual provider
   target in permissioned custody behind that locator, not in a public callback
   or app-state record. `finish` closes only that operation's writer/use lease;
   it does not prove provider resource revocation. `renew` replaces the lease and
   invalidates the old capability, and cannot revive an expired lease.
5. `unknownAfterCrash` explicitly persists ambiguity. Inventory also conservatively
   observes dispatched or expired open work as unknown. Restart reconstructs
   records, not process capabilities. A crashed producer cannot reacquire a burned
   dispatch grant. Mutations do not silently retry CAS failures or exceptions.
6. `closeIssuer` closes the exact enrolled issuer at an observed high-water. It
   permanently rejects later reservations, dispatch, issuance, binding and renewal
   for that issuer/epoch; positive finish remains possible. Inventory is
   exhaustive only when all enrolled issuers are closed. `observeInventory`
   returns a canonical metadata seal commitment only then, including for zero
   records. Scans, empty queries, missing callbacks, process exit, expiry, 404,
   VM absence and deletion supply neither completeness nor revocation evidence.

For a retry/replacement, `prepareResourceRetirement` appends deterministic intent
for the exact old incarnation. It blocks further issuance/renewal on that
incarnation. Exclusive retirement dispatch and independent readback must prove it
revoked and quiescent before a replacement reservation is admitted. Exactly one
replacement may reference it. Source kind `retry` requires that reference. A
whole-generation fence preserves an existing resource-retirement intent and
claim, including a lost reply; it never rewrites it to redispatch.

## Reset and transfer

`fenceReset` atomically appends deterministic intent, a permanent predecessor
admission tombstone and per-incarnation retirement intents. The successor names
an exact tenant/instance match, a different generation/runtime/owner epoch and
cannot reuse a historical generation/runtime identity. Conflicting intent is
refused; an identical intent can be observed repeatedly. Existing grants cannot
issue, bind or renew after fencing. Positive operation finish remains possible.

`claimResetDispatch` durably claims one effect and returns a short-scope immutable
capability containing its exact intent. A whole-generation reset requires sealed
inventory before dispatch; individual resource retirement uses the same kernel.
No provider is called by this module. Lost replies, restart, expiry or observer
failure never permit another dispatch. `observeResetRecord` can reconcile a lost
reply without dispatching. Only the injected independent adapter can submit
readback, with its pinned implementation revision, exact identity, full reservation binding, record,
incarnation and intent. Only `revoked-and-quiescent` evidence closes unresolved
leases. Negative/absence evidence returns `unproven`; a dispatch acknowledgement
cannot establish retirement. Readback proof must cover actual provider revocation
and physical writer/use quiescence, including outstanding short-scope work.

`retireReset` requires exhaustive issuer closure and independent positive readback
for every predecessor record. An empty inventory still needs the exhaustive
creator seal. `transferSuccessor` requires retired state and the exact previously
bound successor enrollment. It retains old records, high-water, transfer history
and predecessor tombstones. Reopen with the successor identity; old handles and
enrollment cannot admit work. `observePredecessorRefusal` can independently observe
a permanent tombstone even after successor activation. Ordinary deletion can
never remove this refusal in a conforming control-root adapter.

## Remaining qualification lanes

Follow-up lanes must integrate config issuance, login/writer custody, physical
launch/session admission (including retry and callback paths), task/goal
projections, Fleet locked-R2 authority and final composition/qualification. They
must supply durable control-root storage, keys, clock and real independent
provider/writer readback, prove exhaustive creator enrollment, and qualify all
crash/recovery boundaries across real processes. This foundation is independently
reviewable contracts and state-machine work only, not a release/deploy/readiness
claim.

Focused verification:

```sh
npx tsx --test packages/core/test/providerAuthority.test.ts
npm run typecheck -w @propr/core
```
