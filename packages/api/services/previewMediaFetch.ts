import { Octokit } from '@octokit/core';
import { parsePublishedVisualPreviews, type PublishedVisualPreview } from '@propr/core';
import { trustedGitHubAttachmentUrl } from '@propr/shared';
import type { previewMediaReader } from './previewMediaProjection.js';

const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MEDIA_TYPES = new Set([
  'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm',
]);
const SIGNED_MEDIA_HOSTS = new Set([
  'private-user-images.githubusercontent.com',
  'secured-user-images.githubusercontent.com',
  'user-images.githubusercontent.com',
  'github-production-user-asset-6210df.s3.amazonaws.com',
]);

export interface PreviewAssociation {
  kind: 'pull' | 'comment';
  repository: string;
  number: number;
}

export type PreviewMediaErrorCode =
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEWS_DISABLED'
  | 'PREVIEW_SOURCE_REJECTED'
  | 'PREVIEW_TOO_LARGE'
  | 'PREVIEW_INVALID_TYPE'
  | 'PREVIEW_UNAVAILABLE';

export class PreviewMediaError extends Error {
  constructor(
    readonly status: number,
    readonly code: PreviewMediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewMediaError';
  }
}

export type PublishedPreviewAsset = PublishedVisualPreview & { assetId: string };
type PreviewMediaReader = Pick<typeof previewMediaReader, 'enabledRepositories'>;
type PreviewOctokit = Pick<Octokit, 'request'>;
type GitHubBody = { body?: unknown; body_html?: unknown };

interface ListPublishedPreviewsOptions {
  association: PreviewAssociation;
  octokit: PreviewOctokit;
  reader: PreviewMediaReader;
}

interface LoadPublishedPreviewOptions extends ListPublishedPreviewsOptions {
  assetId: string;
  token: string;
  fetch: typeof globalThis.fetch;
  maxBytes?: number;
}

function decodedHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|#38|#x26);/gi, '&');
}

/** Select only GitHub-rendered media carrying the already-authorized attachment identity. */
export function signedMediaUrl(bodyHtml: unknown, assetId: string): URL | undefined {
  if (typeof bodyHtml !== 'string' || bodyHtml.length > 2_000_000) return undefined;
  const escapedAsset = assetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identity = new RegExp(`(?:/|-|%2[fF]|%2[dD])${escapedAsset}(?:[./]|%2[eE]|$)`, 'i');
  const attributes = bodyHtml.matchAll(/\b(?:src|href)=["']([^"']{1,8192})["']/gi);
  for (const match of attributes) {
    try {
      const candidate = new URL(decodedHtmlAttribute(match[1]));
      if (candidate.protocol === 'https:' && !candidate.port && !candidate.username && !candidate.password
        && SIGNED_MEDIA_HOSTS.has(candidate.hostname) && identity.test(candidate.pathname)) return candidate;
    } catch { /* Ignore malformed rendered attributes. */ }
  }
  return undefined;
}

export function trustedFetchTarget(url: URL, first: boolean, assetId: string): boolean {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.href.length > 8192) return false;
  if (first && url.hostname === 'github.com') {
    return !url.search && url.pathname === `/user-attachments/assets/${assetId}`;
  }
  return SIGNED_MEDIA_HOSTS.has(url.hostname);
}

export async function fetchMedia(
  initial: URL, assetId: string, token: string, fetcher: typeof globalThis.fetch,
): Promise<globalThis.Response> {
  let current = initial;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!trustedFetchTarget(current, redirect === 0, assetId)) {
      throw new PreviewMediaError(502, 'PREVIEW_SOURCE_REJECTED', 'Preview media source was rejected');
    }
    let response: globalThis.Response;
    try {
      response = await fetcher(current, {
        redirect: 'manual',
        headers: {
          Accept: 'image/*,video/*;q=0.9',
          'User-Agent': 'ProPR',
          ...(current.hostname === 'github.com' ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PreviewMediaError(502, 'PREVIEW_UNAVAILABLE', 'Preview media is temporarily unavailable');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch { /* Best-effort response disposal. */ }
    if (!location || redirect === MAX_REDIRECTS) {
      throw new PreviewMediaError(502, 'PREVIEW_SOURCE_REJECTED', 'Preview media redirect was rejected');
    }
    try { current = new URL(location, current); }
    catch { throw new PreviewMediaError(502, 'PREVIEW_SOURCE_REJECTED', 'Preview media redirect was rejected'); }
  }
  throw new PreviewMediaError(502, 'PREVIEW_SOURCE_REJECTED', 'Preview media redirect was rejected');
}

export async function boundedBody(response: globalThis.Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new PreviewMediaError(413, 'PREVIEW_TOO_LARGE', 'Preview media exceeds the serving limit');
  }
  if (!response.body) throw new PreviewMediaError(502, 'PREVIEW_UNAVAILABLE', 'Preview media response was empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        throw new PreviewMediaError(413, 'PREVIEW_TOO_LARGE', 'Preview media exceeds the serving limit');
      }
      chunks.push(value);
    }
  } finally {
    if (length > maximum) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
}

function publishedAsset(preview: PublishedVisualPreview): PublishedPreviewAsset | undefined {
  const url = trustedGitHubAttachmentUrl(preview.url);
  if (!url) return undefined;
  const assetId = new URL(url).pathname.split('/').at(-1);
  return assetId ? { ...preview, url, assetId } : undefined;
}

async function readPublishedPreviews({ association, octokit, reader }: ListPublishedPreviewsOptions): Promise<{
  previews: PublishedPreviewAsset[];
  bodyHtml: unknown;
}> {
  const repository = association.repository.trim().toLowerCase();
  if (!(await reader.enabledRepositories([repository])).has(repository)) {
    throw new PreviewMediaError(404, 'PREVIEWS_DISABLED', 'Preview media not found');
  }
  const [owner, repo] = repository.split('/');
  const endpoint = association.kind === 'pull'
    ? 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
    : 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}';
  const identity = association.kind === 'pull'
    ? { pull_number: association.number }
    : { comment_id: association.number };
  const response = await octokit.request(endpoint, {
    owner, repo, ...identity, mediaType: { format: 'full' },
    request: { signal: AbortSignal.timeout(5_000) },
  }) as { data: GitHubBody };
  return {
    previews: parsePublishedVisualPreviews(response.data.body).flatMap(preview => publishedAsset(preview) ?? []),
    bodyHtml: response.data.body_html,
  };
}

export async function listPublishedPreviews(options: ListPublishedPreviewsOptions): Promise<PublishedPreviewAsset[]> {
  return (await readPublishedPreviews(options)).previews;
}

function servingLimit(contentType: string, maxBytes: number | undefined): number {
  const defaultLimit = contentType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes < 0) return defaultLimit;
  return Math.min(defaultLimit, Math.floor(maxBytes));
}

export async function loadPublishedPreview({
  association, assetId, token, octokit, fetch: fetcher, reader, maxBytes,
}: LoadPublishedPreviewOptions): Promise<{ preview: PublishedVisualPreview; contentType: string; body: Buffer }> {
  const { previews, bodyHtml } = await readPublishedPreviews({ association, octokit, reader });
  const published = previews.find(item => item.assetId === assetId);
  if (!published) throw new PreviewMediaError(404, 'PREVIEW_NOT_FOUND', 'Preview media not found');

  const source = signedMediaUrl(bodyHtml, assetId) ?? new URL(published.url);
  const media = await fetchMedia(source, assetId, token, fetcher);
  if (!media.ok) {
    try { await media.body?.cancel(); } catch { /* Best-effort response disposal. */ }
    throw media.status === 404
      ? new PreviewMediaError(404, 'PREVIEW_NOT_FOUND', 'Preview media is unavailable')
      : new PreviewMediaError(502, 'PREVIEW_UNAVAILABLE', 'Preview media could not be loaded');
  }
  const contentType = media.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (!MEDIA_TYPES.has(contentType) || (published.type === 'image') !== contentType.startsWith('image/')) {
    try { await media.body?.cancel(); } catch { /* Best-effort response disposal. */ }
    throw new PreviewMediaError(502, 'PREVIEW_INVALID_TYPE', 'Preview media returned an invalid content type');
  }
  const body = await boundedBody(media, servingLimit(contentType, maxBytes));
  const preview: PublishedVisualPreview = {
    type: published.type,
    title: published.title,
    ...(published.description === undefined ? {} : { description: published.description }),
    url: published.url,
  };
  return { preview, contentType, body };
}
