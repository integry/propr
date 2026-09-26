/** Connect managed preview storage v1. Relay credentials and upload URLs stay server-side. */
export const PREVIEW_STORAGE_V1_DEFAULTS = {
  quotaBytes: 25 * 1024 ** 3,
  maxObjectBytes: 500 * 1024 ** 2,
  retentionDays: 90,
} as const;

export interface PreviewStorageStatusV1 {
  version: 1;
  installationId: number;
  enabled: boolean;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  maxObjectBytes: number;
  retentionDays: number;
  allowedContentTypes: string[];
  deleteSupported: boolean;
}

export type ManagedPreviewStorageState = 'enabled' | 'plus_required' | 'disabled' | 'unavailable';
/** Allowlisted projection for settings; never includes relay payloads or credentials. */
export interface ManagedPreviewStorageStatus {
  version: 1;
  state: ManagedPreviewStorageState;
  enabled: boolean;
  effective: PreviewStorageStatusV1 | null;
}

export interface PreviewObjectV1 {
  sizeBytes: number;
  contentType: string;
  /** Lower-case hexadecimal SHA-256 of the exact original bytes. */
  sha256: string;
}
/** Installation authority is derived only from the relay token, never caller metadata. */
export interface PreviewAssetMetadataV1 {
  taskId: string;
  repository: string;
  pullRequestNumber?: number;
  displayFilename: string;
}
export interface PreviewUploadRequestV1 extends PreviewObjectV1, PreviewAssetMetadataV1 {
  version: 1;
}
export interface PreviewUploadV1 extends PreviewUploadRequestV1 {
  artifactId: string;
  objectKey: string;
  put: { url: string; headers: Record<string, string>; expiresAt: string };
}
export interface PreviewFinalizeRequestV1 extends PreviewObjectV1 {
  version: 1;
  objectKey: string;
}
/** Safe finalized projection for publishers/APIs; contains no object-store credentials or keys. */
export interface PreviewArtifactV1 extends PreviewUploadRequestV1 {
  artifactId: string;
  state: 'ready';
  viewerUrl: string;
  retentionExpiresAt: string;
}
export type PreviewStorageErrorCodeV1 =
  | 'quota_exceeded' | 'object_too_large' | 'content_type_not_allowed'
  | 'object_mismatch' | 'invalid_contract' | 'unavailable' | 'upload_failed'
  | 'source_unavailable' | 'finalize_failed' | 'delete_failed' | 'delete_unsupported';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function contentType(value: unknown): value is string {
  return typeof value === 'string' && /^(image|video)\/[a-z0-9.+-]{1,80}$/.test(value);
}
export function parsePreviewStorageStatusV1(value: unknown): PreviewStorageStatusV1 | undefined {
  if (!record(value) || value.version !== 1 || !integer(value.installationId, 1)
    || typeof value.enabled !== 'boolean' || !integer(value.quotaBytes)
    || !integer(value.usedBytes) || !integer(value.reservedBytes)
    || !integer(value.maxObjectBytes, 1) || !integer(value.retentionDays, 1)
    || typeof value.deleteSupported !== 'boolean'
    || !Array.isArray(value.allowedContentTypes) || value.allowedContentTypes.length > 64
    || !value.allowedContentTypes.every(contentType)) return undefined;
  return {
    version: 1, installationId: value.installationId, enabled: value.enabled,
    quotaBytes: value.quotaBytes, usedBytes: value.usedBytes, reservedBytes: value.reservedBytes,
    maxObjectBytes: value.maxObjectBytes, retentionDays: value.retentionDays,
    allowedContentTypes: [...value.allowedContentTypes], deleteSupported: value.deleteSupported,
  };
}
function object(value: Record<string, unknown>): PreviewObjectV1 | undefined {
  if (!integer(value.sizeBytes, 1) || !contentType(value.contentType)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return undefined;
  return { sizeBytes: value.sizeBytes, contentType: value.contentType, sha256: value.sha256 };
}
/** Portable basename, bounded and safe for display; callers still escape their output format. */
export function sanitizePreviewDisplayFilename(value: string): string {
  return (value.replaceAll('\\', '/').split('/').pop() ?? '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 128).replace(/^[. ]+|[. ]+$/g, '') || 'original';
}
function assetMetadata(value: Record<string, unknown>): PreviewAssetMetadataV1 | undefined {
  if (typeof value.taskId !== 'string' || !value.taskId.length || value.taskId.length > 256
    || value.taskId.trim() !== value.taskId || /[\x00-\x1f\x7f]/.test(value.taskId)
    || typeof value.repository !== 'string' || value.repository.length > 256
    || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(value.repository)
    || ['.', '..'].includes(value.repository.split('/')[1])
    || (value.pullRequestNumber !== undefined && !integer(value.pullRequestNumber, 1))
    || typeof value.displayFilename !== 'string'
    || value.displayFilename !== sanitizePreviewDisplayFilename(value.displayFilename)) return undefined;
  return {
    taskId: value.taskId, repository: value.repository, displayFilename: value.displayFilename,
    ...(value.pullRequestNumber === undefined ? {} : { pullRequestNumber: value.pullRequestNumber as number }),
  };
}
export function parsePreviewUploadRequestV1(value: unknown): PreviewUploadRequestV1 | undefined {
  if (!record(value) || value.version !== 1) return undefined;
  const original = object(value);
  const metadata = assetMetadata(value);
  return original && metadata ? { version: 1, ...original, ...metadata } : undefined;
}
function artifactIdentity(value: Record<string, unknown>): boolean {
  return value.version === 1 && typeof value.artifactId === 'string'
    && /^[a-zA-Z0-9_-]{1,128}$/.test(value.artifactId);
}
function identity(value: Record<string, unknown>): boolean {
  return artifactIdentity(value)
    && typeof value.objectKey === 'string' && value.objectKey.length > 0 && value.objectKey.length <= 1024
    && !/[\x00-\x1f\x7f]/.test(value.objectKey);
}
export function parsePreviewUploadV1(value: unknown): PreviewUploadV1 | undefined {
  if (!record(value) || !identity(value) || !record(value.put)) return undefined;
  const original = parsePreviewUploadRequestV1(value);
  const put = value.put;
  if (!original || typeof put.url !== 'string' || !record(put.headers)
    || typeof put.expiresAt !== 'string' || !Number.isFinite(Date.parse(put.expiresAt))) return undefined;
  try {
    const url = new URL(put.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
  } catch { return undefined; }
  const headers: Record<string, string> = {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(put.headers)) {
    const normalizedKey = key.toLowerCase();
    // Only object-store signed headers. In particular, never forward relay Authorization or cookies.
    // R2 create-only grants sign this exact conditional header and value.
    const allowedHeader = /^(content-type|content-length|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+)$/i.test(key)
      || (normalizedKey === 'if-none-match' && value === '*');
    if (!allowedHeader || typeof value !== 'string' || /[\r\n]/.test(value) || normalizedKey in normalized) return undefined;
    normalized[normalizedKey] = value;
    headers[key] = value;
  }
  if (normalized['content-type'] !== original.contentType
    || normalized['content-length'] !== String(original.sizeBytes)
    || normalized['if-none-match'] !== '*') return undefined;
  return {
    ...original, artifactId: value.artifactId as string, objectKey: value.objectKey as string,
    put: { url: put.url, headers, expiresAt: put.expiresAt },
  };
}
export function parsePreviewArtifactV1(value: unknown, trustedConnectOrigin: string): PreviewArtifactV1 | undefined {
  if (!record(value) || !artifactIdentity(value) || value.state !== 'ready'
    || typeof value.viewerUrl !== 'string' || value.viewerUrl.length > 2048
    || typeof value.retentionExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.retentionExpiresAt))) return undefined;
  try {
    const trusted = new URL(trustedConnectOrigin);
    const viewer = new URL(value.viewerUrl);
    // Stable authenticated links have no bearer/query token, fragment, or embedded credentials.
    if (trusted.protocol !== 'https:' || trusted.username || trusted.password
      || trusted.pathname !== '/' || trusted.search || trusted.hash
      || viewer.protocol !== 'https:' || viewer.origin !== trusted.origin
      || viewer.username || viewer.password || viewer.search || viewer.hash
      || /[\s\\]/.test(value.viewerUrl)) return undefined;
  } catch { return undefined; }
  const original = parsePreviewUploadRequestV1(value);
  return original ? {
    ...original, artifactId: value.artifactId as string, state: 'ready',
    viewerUrl: value.viewerUrl, retentionExpiresAt: value.retentionExpiresAt,
  } : undefined;
}
export function parseManagedPreviewStorageStatus(value: unknown): ManagedPreviewStorageStatus | undefined {
  if (!record(value) || value.version !== 1
    || !['enabled', 'plus_required', 'disabled', 'unavailable'].includes(value.state as string)
    || value.enabled !== (value.state === 'enabled')) return undefined;
  const effective = value.effective === null ? null : parsePreviewStorageStatusV1(value.effective);
  if (effective === undefined || (value.enabled && !effective?.enabled)
    || (value.state === 'disabled' && (!effective || effective.enabled))) return undefined;
  return { version: 1, state: value.state as ManagedPreviewStorageState, enabled: value.enabled as boolean, effective };
}
