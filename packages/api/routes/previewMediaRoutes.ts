import { Octokit } from '@octokit/core';
import type { Request, Response } from 'express';
import { parsePublishedVisualPreviews } from '@propr/core';
import {
  handleGitHubRepositoryAccessError,
  resolveGitHubMetadataToken,
} from '../githubMetadataAuth.js';
import { previewMediaReader } from '../services/previewMediaProjection.js';

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

type Association = { kind: 'pull' | 'comment'; number: number };
type GitHubBody = { body?: unknown; body_html?: unknown };

interface PreviewMediaDependencies {
  reader?: Pick<typeof previewMediaReader, 'enabledRepositories'>;
  resolveToken?: typeof resolveGitHubMetadataToken;
  createOctokit?: (token: string) => Pick<Octokit, 'request'>;
  fetch?: typeof fetch;
}

class MediaResponseError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function parameter(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseRequest(req: Request, kind: Association['kind']): { repository: string; assetId: string; association: Association } | undefined {
  const owner = parameter(req.params.owner);
  const repo = parameter(req.params.repo);
  const assetId = parameter(req.params.assetId);
  const number = Number(parameter(req.params.number));
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)
    || ['.', '..'].includes(owner) || ['.', '..'].includes(repo)
    || !/^[A-Za-z0-9_-]+$/.test(assetId) || assetId.length > 128
    || !Number.isSafeInteger(number) || number < 1) return undefined;
  return { repository: `${owner}/${repo}`.toLowerCase(), assetId,
    association: { kind, number } };
}

function decodedHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|#38|#x26);/gi, '&');
}

/** Select only GitHub-rendered media carrying the already-authorized attachment identity. */
function signedMediaUrl(bodyHtml: unknown, assetId: string): URL | undefined {
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

function trustedFetchTarget(url: URL, first: boolean, assetId: string): boolean {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.href.length > 8192) return false;
  if (first && url.hostname === 'github.com') {
    return !url.search && url.pathname === `/user-attachments/assets/${assetId}`;
  }
  return SIGNED_MEDIA_HOSTS.has(url.hostname);
}

async function fetchMedia(
  initial: URL, assetId: string, token: string, fetcher: typeof fetch,
): Promise<globalThis.Response> {
  let current = initial;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!trustedFetchTarget(current, redirect === 0, assetId)) throw new MediaResponseError(502, 'Preview media source was rejected');
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
      throw new MediaResponseError(502, 'Preview media is temporarily unavailable');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch { /* Best-effort response disposal. */ }
    if (!location || redirect === MAX_REDIRECTS) throw new MediaResponseError(502, 'Preview media redirect was rejected');
    try { current = new URL(location, current); }
    catch { throw new MediaResponseError(502, 'Preview media redirect was rejected'); }
  }
  throw new MediaResponseError(502, 'Preview media redirect was rejected');
}

async function boundedBody(response: globalThis.Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new MediaResponseError(413, 'Preview media exceeds the serving limit');
  if (!response.body) throw new MediaResponseError(502, 'Preview media response was empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new MediaResponseError(413, 'Preview media exceeds the serving limit');
      chunks.push(value);
    }
  } finally {
    if (length > maximum) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
}

export function createPreviewMediaRoutes(dependencies: PreviewMediaDependencies = {}) {
  const reader = dependencies.reader ?? previewMediaReader;
  const resolveToken = dependencies.resolveToken ?? resolveGitHubMetadataToken;
  const createOctokit = dependencies.createOctokit ?? (token => new Octokit({ auth: token, request: { timeout: 10_000 } }));
  const fetcher = dependencies.fetch ?? fetch;

  const serve = (kind: Association['kind']) => async (req: Request, res: Response): Promise<void> => {
    if (!req.user?.id) { res.status(401).json({ error: 'Authentication required' }); return; }
    const parsed = parseRequest(req, kind);
    if (!parsed) { res.status(400).json({ error: 'Invalid preview media identity' }); return; }
    const [owner, repo] = parsed.repository.split('/');
    try {
      if (!(await reader.enabledRepositories([parsed.repository])).has(parsed.repository)) {
        res.status(404).json({ error: 'Preview media not found' }); return;
      }
      const token = await resolveToken(req);
      const github = createOctokit(token);
      const endpoint = kind === 'pull'
        ? 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
        : 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}';
      const identity = kind === 'pull'
        ? { pull_number: parsed.association.number }
        : { comment_id: parsed.association.number };
      const response = await github.request(endpoint, {
        owner, repo, ...identity, mediaType: { format: 'full' },
        request: { signal: AbortSignal.timeout(5_000) },
      }) as { data: GitHubBody };
      const published = parsePublishedVisualPreviews(response.data.body);
      const sourceUrl = `https://github.com/user-attachments/assets/${parsed.assetId}`;
      const preview = published.find(item => item.url === sourceUrl);
      if (!preview) { res.status(404).json({ error: 'Preview media not found' }); return; }

      const source = signedMediaUrl(response.data.body_html, parsed.assetId) ?? new URL(sourceUrl);
      const media = await fetchMedia(source, parsed.assetId, token, fetcher);
      if (!media.ok) {
        try { await media.body?.cancel(); } catch { /* Best-effort response disposal. */ }
        res.status(media.status === 404 ? 404 : 502).json({ error: media.status === 404
          ? 'Preview media is unavailable' : 'Preview media could not be loaded' });
        return;
      }
      const contentType = media.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
      if (!MEDIA_TYPES.has(contentType)
        || (preview.type === 'image') !== contentType.startsWith('image/')) {
        try { await media.body?.cancel(); } catch { /* Best-effort response disposal. */ }
        res.status(502).json({ error: 'Preview media returned an invalid content type' }); return;
      }
      const body = await boundedBody(media, contentType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES);
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        Vary: 'Authorization, Cookie',
        'X-Content-Type-Options': 'nosniff',
      });
      res.status(200).send(body);
    } catch (error) {
      if (await handleGitHubRepositoryAccessError(req, res, error)) return;
      if (error instanceof MediaResponseError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(502).json({ error: 'Preview media is temporarily unavailable' });
    }
  };

  return { getPullMedia: serve('pull'), getCommentMedia: serve('comment') };
}
