# Desktop pairing protocol

Packaged desktop clients authenticate to one ProPR instance with an opaque
instance token. They never receive or persist a GitHub access or refresh token.
Protocol version 1 is designed for the Electron main process (or another trusted
native process); renderer code must communicate with it through a narrow IPC
bridge and must not read the device secret or instance token.

## Discovery

Before login, call `GET /api/desktop/discovery`. The v1 response is deliberately
limited to the exact product, release/API/UI compatibility, canonical managed
endpoint, random public installation identity, and authentication capabilities:

```json
{
  "schemaVersion": 1,
  "product": "ProPR",
  "version": "0.8.15",
  "apiCompatibility": "2026-06-27",
  "uiCompatibility": "2026-06-27",
  "canonicalEndpoint": "https://t-abc123.propr.dev",
  "publicInstanceIdentity": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "desktopAuthentication": {
    "protocolVersion": 1,
    "browserPairing": true,
    "instanceBearerTokens": true,
    "socketIoBearerAuthentication": true
  }
}
```

Consumers must parse the entire document as the exact v1 contract before using
any field. The version is canonical SemVer; both compatibility values are
canonical `YYYY-MM-DD` versions; the identity is an exact lowercase UUIDv4; and
the endpoint is either `null` during restart/configuration or the bare canonical
`https://t-<id>.propr.dev` origin. Every capability key is required and every
capability value is a JSON boolean. Missing, extra, coerced, malformed, or
non-canonical fields are incompatible discovery, never partial readiness.

The public identity is not a credential. It is randomly created in the stack's
private durable `data/` directory and is shared by the host CLI and root-running
API container. The directory remains owned by the host caller with mode `0700`.
The single-link regular identity file may be owned by that host caller or by the
root API container account; it is never group/world writable, and a root-owned
file remains host-readable. Creation writes and fsyncs a private same-directory
temporary, publishes without replacing a concurrent winner, and fsyncs the
directory. Normal restarts, upgrades, and tunnel rotation preserve the value;
replacing the durable data directory creates a new identity.

Discovery is rate limited per trusted network address. A `false` capability
means the deployment (for example, public demo mode) must not be paired. The
legacy `GET /api/compatibility` metadata is not a substitute for the v1 endpoint
and identity contract.

## Pairing sequence

1. The trusted desktop process sends `POST /api/desktop/pairings` with
   `{"clientName":"Alice's MacBook"}`. `clientName` is printable text from 1
   through 80 characters.
2. A `201` response contains `pairingId`, `deviceSecret`, `approvalUrl`,
   `expiresAt`, and `interval` (seconds). Both identifiers have at least 128 bits
   of entropy; the device secret has 256 bits. Store the secret only in trusted
   process memory and open the exact `approvalUrl` in the system browser. Do not
   append a redirect or origin supplied by the renderer.
3. The browser entry validates the unexpired request, initiates the instance's
   normal GitHub login when necessary, and redirects to the fixed ProPR approval
   page. The approval page shows the client name and requires an explicit click.
   `POST /api/desktop/pairings/{pairingId}/approve` accepts only an authenticated
   browser session and the exact configured `FRONTEND_URL` origin. GitHub bearer
   and instance-token principals cannot approve a pairing.
4. No more often than `interval`, the trusted process sends
   `POST /api/desktop/pairings/{pairingId}/poll` with
   `{"deviceSecret":"..."}`. The secret is in the JSON body, never a URL or
   header that an intermediary normally logs. A pending request returns `202`
   with `{"status":"pending","interval":5}`.
5. The first valid poll after approval returns `200` with
   `{"status":"complete","token":"propr_it_...","tokenType":"Bearer","expiresAt":null}`.
   The polling grant is consumed in the same transaction that creates the token;
   subsequent polls return `409 PAIRING_ALREADY_CONSUMED`. If the success response
   is lost, begin a new pairing rather than retrying for the credential.

Pairings expire after ten minutes. An unknown ID or wrong secret returns the
same `404 PAIRING_NOT_FOUND`; an expired request returns `410 PAIRING_EXPIRED`.
Start and poll routes have separate IP quotas. Clients must honor HTTP `429` and
`Retry-After` and must stop at `expiresAt`.

## Using and storing the token

Send the returned token as `Authorization: Bearer propr_it_...` on normal REST
requests. For Socket.IO, set that same header on the Engine.IO WebSocket
handshake (Electron/Node clients can use `extraHeaders`). The socket identity is
revalidated periodically, so token revocation, expiry, role changes, permission
changes, or whitelist removal disconnect an established client.

Store the token in an operating-system credential facility such as macOS
Keychain, Windows Credential Manager, or Linux Secret Service. Never put it in
`localStorage`, IndexedDB, renderer state, a pairing URL, logs, crash reports, or
analytics. Keep the instance origin with the credential and refuse to send it to
another origin. Treat TLS certificate failures as terminal; HTTP is accepted
only for loopback development.

The server stores SHA-256 token and device-secret hashes, never plaintext. Token
rows retain the owner GitHub ID/profile snapshot, creation and last-use times,
optional expiry, and revocation metadata. Authorization still resolves the
owner's current instance role and permissions on each request. Set
`PROPR_DESKTOP_TOKEN_TTL_DAYS` to an integer from 1 through 3650 to issue expiring
tokens; when unset, tokens remain valid until revoked. Expired pairing rows are
cleaned hourly after a short retention period used for stable client errors.

## Token management

Both routes require any accepted authentication method and operate only on the
authenticated user's tokens:

- `GET /api/desktop/tokens` returns `{ "tokens": [...] }` with `id`, `name`,
  `tokenHint`, `createdAt`, `lastUsedAt`, `expiresAt`, and `revokedAt`. It never
  returns a hash or token.
- `DELETE /api/desktop/tokens/{tokenId}` returns `204` after revoking an active
  owned token. Unknown, already-revoked, and other users' IDs all return
  `404 TOKEN_NOT_FOUND`.

Pairing start, approval, token issuance, and revocation write audit rows and
structured logs containing IDs and the display name only. Device secrets,
instance tokens, token hashes, and GitHub tokens are excluded.
