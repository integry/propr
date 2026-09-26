import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  parsePreviewStorageStatusV1, parsePreviewUploadV1, parsePreviewArtifactV1, validateRoutingUrl,
  parsePreviewUploadRequestV1, sanitizePreviewDisplayFilename, type PreviewAssetMetadataV1,
  type ManagedPreviewStorageStatus, type PreviewArtifactV1, type PreviewObjectV1,
  type PreviewFinalizeRequestV1, type PreviewStorageErrorCodeV1, type PreviewStorageStatusV1,
  type PreviewUploadRequestV1, type PreviewUploadV1,
} from '@propr/shared';

export interface PreviewStorageConnectContext {
  connected: boolean;
  connectAccount?: { installationId: number; hasPlusAccess: boolean };
}
export interface ManagedPreviewStorageClientV1Options {
  routingUrl: string;
  /** Explicit trusted HTTPS origin of the authenticated Connect viewer, independent of the relay. */
  trustedConnectOrigin: string;
  relayToken: string;
  getConnectContext: () => Promise<PreviewStorageConnectContext>;
  fetchImpl?: typeof fetch;
}
/** Fixed diagnostics only: raw fetch errors, response bodies, and URLs must never escape. */
export class PreviewStorageError extends Error {
  constructor(readonly code: PreviewStorageErrorCodeV1 | 'plus_required') {
    super(`Managed preview storage: ${code}`);
    this.name = 'PreviewStorageError';
  }
}
export type ManagedPreviewUploadResult =
  | { stored: true; artifact: PreviewArtifactV1 }
  | { stored: false; code: PreviewStorageErrorCodeV1 | 'plus_required' | 'disabled' };

const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;
type RemotePreviewStorageErrorCode = PreviewStorageErrorCodeV1 | 'plus_required';
const REMOTE_ERROR_CODES = new Set<RemotePreviewStorageErrorCode>([
  'quota_exceeded', 'object_too_large', 'content_type_not_allowed', 'object_mismatch', 'plus_required',
]);

export interface ManagedPreviewOriginalInput extends PreviewAssetMetadataV1 {
  /** Replayable staged regular file. Keep it available and unchanged until this call settles. */
  filePath: string;
  contentType: string;
}

function matchesMetadata(left: PreviewAssetMetadataV1, right: PreviewAssetMetadataV1): boolean {
  return left.taskId === right.taskId && left.repository === right.repository
    && left.pullRequestNumber === right.pullRequestNumber && left.displayFilename === right.displayFilename;
}

function matches(left: PreviewObjectV1, right: PreviewObjectV1): boolean {
  return left.sizeBytes === right.sizeBytes && left.contentType === right.contentType && left.sha256 === right.sha256;
}

function errorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function boundedErrorCode(response: Response): Promise<RemotePreviewStorageErrorCode | undefined> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ERROR_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ERROR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!errorRecord(value)) return undefined;
    // Connect emits { error: { code, message } }. The top-level form remains
    // accepted only for compatibility with older relay implementations.
    const code = errorRecord(value.error) ? value.error.code : value.code;
    return typeof code === 'string' && REMOTE_ERROR_CODES.has(code as RemotePreviewStorageErrorCode)
      ? code as RemotePreviewStorageErrorCode
      : undefined;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

async function prepareOriginal(file: FileHandle, input: ManagedPreviewOriginalInput, limits: PreviewStorageStatusV1) {
  const initial = await file.stat();
  if (!initial.isFile() || !initial.size) throw new PreviewStorageError('source_unavailable');
  if (initial.size > limits.maxObjectBytes) throw new PreviewStorageError('object_too_large');
  if (initial.size > limits.quotaBytes - limits.usedBytes - limits.reservedBytes) throw new PreviewStorageError('quota_exceeded');
  if (!limits.allowedContentTypes.includes(input.contentType)) throw new PreviewStorageError('content_type_not_allowed');
  const hash = createHash('sha256');
  let hashedBytes = 0;
  for await (const chunk of file.createReadStream({ start: 0, end: initial.size - 1, autoClose: false })) {
    hash.update(chunk);
    hashedBytes += chunk.length;
  }
  if (hashedBytes !== initial.size) throw new PreviewStorageError('object_mismatch');
  const original = parsePreviewUploadRequestV1({
    version: 1, taskId: input.taskId, repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    displayFilename: sanitizePreviewDisplayFilename(input.displayFilename),
    sizeBytes: initial.size, contentType: input.contentType, sha256: hash.digest('hex'),
  });
  if (!original) throw new PreviewStorageError('invalid_contract');
  return { initial, original };
}

/** Isolated v1 transport; no billing decisions, no cached entitlement, no automatic mutation retries. */
export class ManagedPreviewStorageClientV1 {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: ManagedPreviewStorageClientV1Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async relay(endpoint: string, method = 'GET', body?: unknown): Promise<Response> {
    try {
      if (validateRoutingUrl(this.options.routingUrl) || !this.options.relayToken) throw new PreviewStorageError('unavailable');
      const base = new URL(this.options.routingUrl);
      if (base.username || base.password) throw new PreviewStorageError('unavailable');
      base.protocol = base.protocol === 'wss:' ? 'https:' : base.protocol === 'ws:' ? 'http:' : base.protocol;
      return await this.fetchImpl(new URL(endpoint, base), {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.options.relayToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new PreviewStorageError('unavailable'); }
  }

  async getStatus(): Promise<ManagedPreviewStorageStatus> {
    const unavailable: ManagedPreviewStorageStatus = { version: 1, state: 'unavailable', enabled: false, effective: null };
    try {
      const context = await this.options.getConnectContext();
      if (!context.connected || !context.connectAccount) return unavailable;
      if (!context.connectAccount.hasPlusAccess) return { ...unavailable, state: 'plus_required' };
      const response = await this.relay('/v1/preview-storage/status');
      if (!response.ok) return unavailable;
      const effective = parsePreviewStorageStatusV1(await response.json());
      if (!effective || effective.installationId !== context.connectAccount.installationId) return unavailable;
      return { version: 1, enabled: effective.enabled, state: effective.enabled ? 'enabled' : 'disabled', effective };
    } catch { return unavailable; }
  }

  private async checkResponse(response: Response, fallback: PreviewStorageErrorCodeV1): Promise<void> {
    if (response.ok) return;
    // Parse only a bounded allowlisted code. Messages and unknown fields are discarded.
    const code = await boundedErrorCode(response);
    if (code) throw new PreviewStorageError(code);
    if (response.status === 413) throw new PreviewStorageError('object_too_large');
    throw new PreviewStorageError(fallback);
  }

  private async finalizeUpload(original: PreviewUploadRequestV1, upload: PreviewUploadV1): Promise<PreviewArtifactV1> {
    const finalize: PreviewFinalizeRequestV1 = {
      version: 1, objectKey: upload.objectKey, sizeBytes: original.sizeBytes,
      contentType: original.contentType, sha256: original.sha256,
    };
    const finalized = await this.relay(`/v1/preview-artifacts/${upload.artifactId}/finalize`, 'POST', finalize);
    await this.checkResponse(finalized, 'finalize_failed');
    const artifact = parsePreviewArtifactV1(await finalized.json(), this.options.trustedConnectOrigin);
    if (!artifact || artifact.artifactId !== upload.artifactId
      || !matches(original, artifact) || !matchesMetadata(original, artifact)
      || Date.parse(artifact.retentionExpiresAt) <= Date.now()) throw new PreviewStorageError('object_mismatch');
    return artifact;
  }

  /** Hash and replay one open file with bounded buffers; verify the PUT stream again before finalize. */
  async uploadOriginal(input: ManagedPreviewOriginalInput): Promise<ManagedPreviewUploadResult> {
    let file: FileHandle | undefined;
    try {
      const status = await this.getStatus();
      if (status.state !== 'enabled') return { stored: false, code: status.state };
      if (!status.effective) throw new PreviewStorageError('invalid_contract');
      try { file = await open(input.filePath, 'r'); }
      catch { throw new PreviewStorageError('source_unavailable'); }
      const { initial, original } = await prepareOriginal(file, input, status.effective);
      const response = await this.relay('/v1/preview-artifacts/uploads', 'POST', original);
      await this.checkResponse(response, 'upload_failed');
      const upload = parsePreviewUploadV1(await response.json());
      if (!upload) throw new PreviewStorageError('invalid_contract');
      if (!matches(original, upload) || !matchesMetadata(original, upload) || Date.parse(upload.put.expiresAt) <= Date.now()) throw new PreviewStorageError('object_mismatch');
      let put: Response;
      let verified = false;
      const source = file.createReadStream({ start: 0, end: original.sizeBytes - 1, autoClose: false });
      const body = Readable.from((async function* () {
        const sentHash = createHash('sha256');
        let sentBytes = 0;
        for await (const chunk of source) {
          sentHash.update(chunk);
          sentBytes += chunk.length;
          yield chunk;
        }
        if (sentBytes !== original.sizeBytes || sentHash.digest('hex') !== original.sha256) {
          throw new PreviewStorageError('object_mismatch');
        }
        verified = true;
      })(), { objectMode: false, highWaterMark: 64 * 1024 });
      try {
        // Node fetch requires duplex for a streaming body. Only the signed headers go to storage.
        const init: RequestInit & { duplex: 'half' } = {
          method: 'PUT', headers: upload.put.headers,
          body: Readable.toWeb(body, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
          }) as ReadableStream<Uint8Array>,
          duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(120_000),
        };
        put = await this.fetchImpl(upload.put.url, init);
      } catch { throw new PreviewStorageError('upload_failed'); }
      finally {
        body.destroy();
        // Explicitly destroying an ended file stream would close the shared descriptor before stat.
        if (!source.readableEnded) source.destroy();
      }
      // Never read or propagate an object-store error body (it can echo a signed request).
      if (!put.ok) throw new PreviewStorageError(put.status === 413 ? 'object_too_large' : 'upload_failed');
      const current = await file.stat();
      if (!verified || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs
        || current.ctimeMs !== initial.ctimeMs) throw new PreviewStorageError('object_mismatch');
      const artifact = await this.finalizeUpload(original, upload);
      return { stored: true, artifact };
    } catch (error) {
      return { stored: false, code: error instanceof PreviewStorageError ? error.code : 'invalid_contract' };
    } finally { await file?.close().catch(() => {}); }
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    try {
      const status = await this.getStatus();
      if (!status.enabled) throw new PreviewStorageError('unavailable');
      if (!status.effective?.deleteSupported) throw new PreviewStorageError('delete_unsupported');
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(artifactId)) throw new PreviewStorageError('invalid_contract');
      await this.checkResponse(await this.relay(`/v1/preview-artifacts/${artifactId}`, 'DELETE'), 'delete_failed');
    } catch (error) {
      throw new PreviewStorageError(error instanceof PreviewStorageError ? error.code : 'delete_failed');
    }
  }
}
