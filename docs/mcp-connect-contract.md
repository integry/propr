# Core / Connect MCP contract: propr-connect-mcp/1

This is the instance side of the wire contract shared with the separately
maintained ProPR Connect routing service. The core implementation is complete;
the hosted gateway at `https://mcp.propr.dev` is not yet publicly available.

## Identities and endpoints

| Boundary | Contract |
| --- | --- |
| Public OAuth issuer | `https://mcp.propr.dev` (no trailing slash) |
| Public MCP resource | `https://mcp.propr.dev/mcp` |
| Direct MCP | `https://<instance>/api/mcp`, independently configured instance OAuth |
| Connect public keys | `/.well-known/jwks.json` on the trusted issuer |
| Instance registration | `POST /v1/mcp/instances/register` |
| Current validation | `POST /v1/mcp/delegations/validate` |
| Credential handoff creation | `POST /v1/mcp/credentials` |
| Credential redemption | `POST /v1/auth/instance-grants/redeem` |

Core explicitly opts in with `MCP_CONNECT_TRUST=true`. Its stable
`MCP_INSTANCE_ID` is a UUID or a 16–100 character identifier, independent of
hostnames and the existing `PROPR_INSTANCE_ID` tunnel routing identifier.
The installation is a positive JSON integer. The P-256 instance private key
and registration receipt live encrypted in `mcp_records`, protected by the
existing `MCP_ENCRYPTION_KEY`. Requests never create or rotate that key.

The [operator registration command](mcp.md#connect-instance-registration)
reuses `GH_INSTALLATION_ID`, `PROPR_GH_RELAY_TOKEN`, enabled tunnel
configuration, and the registry UUID written by `propr tunnel setup` to
`PROPR_INSTANCE_ID` (or explicit `MCP_CONNECT_TUNNEL_ID`). Registration checks
the current tunnel belongs to the relay credential's installation. A local
receipt pins issuer, installation, instance, tunnel, key thumbprint and contract.
Changed configuration fails closed until the operator registers it explicitly.
Registration retries reuse the persisted key. Restoring a different instance ID
never silently overwrites the identity.

## One-use instance proof

Every instance POST uses the **existing** `Authorization: Bearer prt_…` relay
credential and an ES256 `instance_assertion`. There is no separate introspection
secret. The header is `alg=ES256`, `typ=propr-instance-assertion+jwt`.

Common assertion claims:

```json
{
  "iss": "urn:propr:instance:12345678-1234-4321-abcd-123456789012:mcp",
  "sub": "12345678-1234-4321-abcd-123456789012",
  "aud": "https://mcp.propr.dev/v1/mcp/delegations/validate",
  "installation_id": 1,
  "iat": 1789074000,
  "exp": 1789074060,
  "jti": "fresh-uuid-for-each-post",
  "delegation_sha256": "lowercase-hex-sha256-of-the-exact-compact-delegation"
}
```

`aud` is the exact POST URL, lifetime is at most 60 seconds, clock tolerance is
5 seconds. Connect atomically rejects assertion `jti` reuse. Core generates a
new proof for validation, issuance and redemption separately.

Registration sends `instance_id`, `tunnel_id`, a **public-only** P-256
`public_jwk`, `contract_version="propr-connect-mcp/1"`, ordered
`protocol_versions=["2026-07-28","2025-11-25"]`, and `instance_assertion`.
Its assertion binds `tunnel_id`, RFC 7638 SHA-256 `key_thumbprint`,
`contract_version`, and the identical ordered `protocol_versions` array
instead of `delegation_sha256`. Changing a registry instance/key/tunnel or
deleting a tunnel permanently revokes old Connect grants through routing's SQL
triggers. Restoring the old target cannot revive them; fresh consent is required.
Connector secret rotation for the same tunnel does not rotate instance identity.
Do not clone an instance private key into unrelated stacks.

## Delegation accepted by core

Gateway header: `alg=ES256`, active `kid`, `typ=propr-mcp-delegation+jwt`.
The signed claims use this exact shape:

```json
{
  "iss": "https://mcp.propr.dev",
  "aud": "urn:propr:instance:12345678-1234-4321-abcd-123456789012:mcp",
  "sub": "777",
  "installation_id": 1,
  "instance_id": "12345678-1234-4321-abcd-123456789012",
  "instance_key_thumbprint": "RFC7638-thumbprint",
  "grant_id": "grant-uuid",
  "scopes": ["read", "plan"],
  "repositories": ["acme/repository"],
  "resource": "https://mcp.propr.dev/mcp",
  "contract_version": "propr-connect-mcp/1",
  "iat": 1789074000,
  "exp": 1789074060,
  "jti": "fresh-request-uuid"
}
```

Core verifies the configured issuer/JWKS, exact scalar audience, type, algorithm,
key ID, local persisted key thumbprint, installation, instance, public resource,
positive numeric subject string, integer time bounds and lifetime. Repositories
are nonempty, sorted, unique lowercase exact `owner/name` strings (at most 100,
200 characters each, 4096 serialized characters). Scopes are a bounded array
from `read plan publish execute review merge deploy manage`, including `read`.
The `X-ProPR-MCP-Resource` hint, when present, must equal the verified claim.
Neither headers nor client arguments choose the destination or authority.

Before every MCP HTTP invocation, including a delegation replayed directly to
the instance, core sends `{delegation, instance_assertion}` to
`/v1/mcp/delegations/validate`. Success must be `{active:true,...claims}` with
**every signed claim unchanged**. Network failures, non-success responses,
malformed JSON or discrepancies deny access. No active-result cache or offline
grace exists. Connect checks its current grant, membership, entitlement,
registry/key/tunnel binding and restrictions. Core then applies current local
allowlist, durable membership (or configured bootstrap administrator), role,
configured repositories, GitHub access and resource ownership. Connect does not
implicitly create local members or grant administrator permissions.

Revocation prevents a new invocation validated after revocation commits. It does
not undo accepted requests, committed effects or already-open streams. MCP
mutation idempotency is core's durable operation key, never delegation `jti`.

## GitHub credential handoff

If core lacks a stored GitHub credential, it POSTs the delegation and a fresh
proof to `/v1/mcp/credentials`. It requires
`{code:"pia_mcp_…",expires_in:60,redemption_endpoint:<exact expected URL>}`.
It redeems with `{code,delegation,instance_assertion}` using a **new** proof
bound to the redemption URL and exact delegation hash, plus the same relay
credential. Routing checks grant and delegation `jti`, atomically consumes the
code, and decrypts the existing instance-login payload. The response is
`{github_user_id,username,avatar_url,access_token}`; its subject must match the
delegation. Core also verifies the GitHub `/user` identity before accepting the
principal. Credentials remain encrypted server-side; no credential or handoff
code passes through the public client's OAuth or MCP traffic.

Existing stored GitHub credentials and coordinated rotating-token refresh are
reused. Connect's handoff omits expiry/refresh metadata; a GitHub 401 can fetch a
fresh handoff after renewed browser consent, with a compare-and-set to avoid
overwriting concurrent credential refreshes. Ordinary `pia_` browser login and
direct instance OAuth retain their independent behavior.

## Responses, errors and client consent

All instance MCP responses carry
`X-ProPR-MCP-Contract: propr-connect-mcp/1`, including parser errors and empty
legacy notifications. Empty 202 notifications include `application/json` so the
actual gateway accepts HTTP clients representing an empty body as a stream.
SDK JSON/SSE transport remains unchanged. Delegated `get_connection` and
`get_setup_status` report the public resource and Connect connected-app link.

| Condition | Behavior |
| --- | --- |
| Public token revoked/expired | Gateway 401 with public resource discovery |
| Core trust/key/credential setup rejected with 401 | Gateway 502 `mcp_instance_trust_required`; no private OAuth challenge forwarded |
| Online check unavailable/malformed | Core 503 `CONNECT_UNAVAILABLE`, `Retry-After: 3` |
| Current validation/local membership denies | Core 403 `ACCESS_REVOKED` |
| Signed contract unsupported | Core 409 `INSTANCE_VERSION_MISMATCH` |
| Registry/protocol unsupported | Gateway 409 `mcp_version_mismatch` |
| Tunnel fetch fails | Gateway 503 `mcp_tunnel_offline`; mutation outcome may be uncertain |
| Tool scope/repository/precondition denied | Core MCP error; no OAuth step-up loop |

The gateway makes one upstream request, strips cookies and private OAuth
challenges, and preserves allowed protocol headers/streaming. It never retries
mutations. The full allowlists and gateway errors remain specified in the pinned
routing contract. Direct OAuth still advertises and verifies its own resource.

Both OAuth consent flows are bounded by the original requested scopes. Direct
consent now displays explicit optional scope checkboxes, unchecked by default,
and keeps read selected. Forged escalation, malformed selections and refresh
escalation are rejected. CIMD plural supported methods are intersected with
`none`; valid singular legacy preference never overrides public PKCE support.
Malformed array entries/preferences fail validation. An omitted legacy CIMD method defaults to public `none`. DCR still requires `none`. Token requests reject client assertions and attempted authorization-code scope overrides before consuming a code.

## Executable cross-repository evidence

With an authorized checkout of the routing service, run
`MCP_ROUTING_REPOSITORY=/path/to/routing-checkout npm run test:mcp:connect`.
Optionally set `MCP_ROUTING_REVISION` to a full lowercase commit SHA to test a
routing candidate; otherwise the runner uses its pinned default revision.
The runner verifies and archives that exact Git commit into a temporary directory, installs
its lockfile, bundles its **actual Worker entry point** and runs core's actual
HTTP/auth/tool implementation. It reports both source identities and SDK
versions. No routing source or policy is rewritten.

Core required CI runs self-contained core MCP tests; paired gateway coverage
runs with the routing service, not in core CI. Never copy or publish routing
source/archives into core. See [Verification in CI](mcp-coverage.md#verification-in-ci).
