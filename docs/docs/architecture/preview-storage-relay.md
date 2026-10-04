---
title: Preview storage relay contract
---

# Preview storage relay contract

Implementation reference for the managed original storage used by
[Visual Previews](../features/visual-previews.md#managed-original-storage-plus). Users and operators do not need this
page to configure previews.

## Relay v1 Client Contract

The shared types and runtime parsers live in
`packages/shared/src/previewStorage/v1.ts`; the isolated transport lives in
`packages/core/src/services/previewStorage/v1.ts`. The relay implementation is
provided separately by `integry/propr-routing` and must implement this contract:

- `GET /v1/preview-storage/status` returns `PreviewStorageStatusV1`: `version: 1`,
  `installationId`, `enabled`, `quotaBytes`, `usedBytes`, `reservedBytes`,
  `maxObjectBytes`, `retentionDays`, `allowedContentTypes`, and `deleteSupported`.
  Byte counts are nonnegative safe integers; object size and retention are positive.
- `POST /v1/preview-artifacts/uploads` accepts `PreviewUploadRequestV1`: version,
  `taskId`, `repository` (owner/repository full name), optional positive integer
  `pullRequestNumber`, sanitized `displayFilename`, original `sizeBytes`,
  `contentType`, and lowercase hex `sha256`. Task IDs are nonempty opaque strings
  of at most 256 characters, without control characters or surrounding whitespace.
  Display filenames are portable basenames of at most 128 characters, sanitized by `sanitizePreviewDisplayFilename`.
  Installation authority comes exclusively from the relay token; callers never
  supply an installation ID in an upload request. Connect must authorize the
  repository/task/PR association for that installation, persist the metadata,
  atomically reserve quota, and bind the grant to all those constraints.
  It returns `PreviewUploadV1` with matching metadata and size/type/hash, `artifactId`,
  `objectKey`, and `put: { url, headers, expiresAt }`.
- The client accepts a replayable staged `filePath`, hashes it using streaming
  SHA-256, then sends it with a direct streaming HTTPS `PUT`. Keep the staged file
  unchanged and available until upload settles. Both passes use bounded buffers;
  neither requires a full-size `Uint8Array`/`Buffer`. The PUT is re-hashed before
  finalization to detect changed input. Node fetch uses `duplex: 'half'` and the
  exact returned object-store headers. The signed header map must include
  `Content-Type` exactly matching `contentType`, `Content-Length` exactly matching
  the decimal `sizeBytes`, and the mandatory create-only conditional
  `If-None-Match: *`. The closed signed-header allowlist rejects other conditional
  headers and values.
  Redirects are rejected, and the relay bearer
  credential is never forwarded to the object store.
- `POST /v1/preview-artifacts/:id/finalize` accepts version, object key,
  size/type/hash. The relay verifies the stored object before returning a
  `PreviewArtifactV1`: `version: 1`, `artifactId`, `state: 'ready'`, verified
  size/type/hash, all persisted task/repository/PR/filename metadata,
  `viewerUrl`, and `retentionExpiresAt`. The client checks these against the grant
  and request. Retention must be a parseable future timestamp. The artifact
  projection excludes object keys, upload URLs, and tokens.
  `viewerUrl` must be a stable authenticated HTTPS link on the exact configured
  trusted Connect origin, with no credentials, query string, or fragment. Connect
  must require viewer authentication and authorize repository access on every
  request; the URL itself grants no access.
- `DELETE /v1/preview-artifacts/:id` is used only when `deleteSupported` is true.
  It returns a successful HTTP status. No automatic mutation retries are made;
  the relay must expire abandoned upload reservations.

Relay calls use `PROPR_ROUTING_URL` and the existing `PROPR_GH_RELAY_TOKEN`
bearer credential. Viewer trust is configured separately by `PROPR_CONNECT_URL`
(default `https://connect.propr.dev`), passed to the client as
`trustedConnectOrigin`; it must be an HTTPS origin, not a URL with a path.
The trusted origin is never taken from a remote upload/finalize response. Known error codes (`quota_exceeded`,
`object_too_large`, `content_type_not_allowed`, `object_mismatch`) are parsed from a bounded JSON
error body before HTTP-status fallback, so the two HTTP 413 cases remain distinct. Raw response
messages, oversized/unknown bodies, and transport errors are discarded. Unknown versions or
malformed statuses fail closed. Future v2 support can be added alongside v1.

## Publication outcomes

`storeManagedVisualPreviewOriginals(evidence, { taskId, repository, pullRequestNumber? })`
returns one versioned result per input asset, in input order. Each result includes
`version: 1`, `assetIndex`, and `relativePath` (the index disambiguates duplicate
paths), plus either `{ stored: true, artifact: PreviewArtifactV1 }` or
`{ stored: false, code }`. Successful artifacts carry the trusted `viewerUrl` and
retention metadata, so the publisher can render links without uploading
again. Staged evidence retains its task ID for existing publication callers.

Failures are isolated per asset, including local file errors and unavailable or
disabled storage. Codes are a bounded union (`PreviewStorageErrorCodeV1`,
`plus_required`, or `disabled`); raw remote errors are discarded. A failed asset
does not discard successful results or stop later uploads or GitHub publication.
Only these codes may be used for fallback text. Never log or publish upload grants,
object keys, relay tokens, or raw remote response/error bodies.
