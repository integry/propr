import type { Octokit } from '@octokit/core';
import {
  boundedBody,
  fetchMedia,
  PreviewMediaError,
  signedMediaUrl,
} from './previewMediaFetch.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const MAX_ALT_LENGTH = 200;
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']);
const ATTACHMENT_URL = /https:\/\/github\.com\/user-attachments\/assets\/([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_\-/?#])/g;

export type CommentAttachmentType = 'image' | 'video' | 'unknown';

/** One GitHub user attachment referenced by a comment body. Alt text is untrusted prose. */
export interface CommentAttachment {
  index: number;
  attachmentId: string;
  type: CommentAttachmentType;
  alt: string;
  url: string;
}

export interface CommentAttachmentSource {
  repository: string;
  /** Issue or pull request number the comment must belong to. */
  number: number;
  /** Omit to read the issue or pull request description itself. */
  commentId?: number;
}

type AttachmentOctokit = Pick<Octokit, 'request'>;
type GitHubBody = { body?: unknown; body_html?: unknown; html_url?: unknown; issue_url?: unknown };

interface LoadCommentAttachmentOptions {
  source: CommentAttachmentSource;
  attachmentIndex?: number;
  attachmentId?: string;
  token: string;
  octokit: AttachmentOctokit;
  fetch: typeof globalThis.fetch;
  maxBytes?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Classify an attachment by how the Markdown/HTML embeds it; a bare link stays unknown until fetched. */
function attachmentType(body: string, url: string): { type: CommentAttachmentType; alt: string } {
  const escaped = escapeRegExp(url);
  const markdown = new RegExp(`!\\[([^\\]\\n]{0,1000})\\]\\(\\s*<?${escaped}(?![A-Za-z0-9_-])`).exec(body);
  if (markdown) return { type: 'image', alt: markdown[1].trim().slice(0, MAX_ALT_LENGTH) };
  const img = new RegExp(`<img\\b[^>]{0,2000}?\\bsrc=["']${escaped}["'][^>]{0,2000}>`, 'i').exec(body);
  if (img) {
    const alt = /\balt=["']([^"']{0,1000})["']/i.exec(img[0])?.[1] ?? '';
    return { type: 'image', alt: alt.trim().slice(0, MAX_ALT_LENGTH) };
  }
  if (new RegExp(`<(?:video|source)\\b[^>]{0,2000}?\\bsrc=["']${escaped}["']`, 'i').test(body)) return { type: 'video', alt: '' };
  return { type: 'unknown', alt: '' };
}

/** GitHub user attachments in first-appearance order; other URLs are never discovered. */
export function parseCommentAttachments(body: unknown, limit = MAX_ATTACHMENTS): CommentAttachment[] {
  if (typeof body !== 'string' || body.length > 2_000_000 || limit < 1) return [];
  const attachments: CommentAttachment[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(ATTACHMENT_URL)) {
    const attachmentId = match[1];
    if (seen.has(attachmentId)) continue;
    seen.add(attachmentId);
    const url = `https://github.com/user-attachments/assets/${attachmentId}`;
    attachments.push({ index: attachments.length, attachmentId, url, ...attachmentType(body, url) });
    if (attachments.length >= limit) break;
  }
  return attachments;
}

async function readSource(source: CommentAttachmentSource, octokit: AttachmentOctokit): Promise<GitHubBody> {
  const [owner, repo] = source.repository.split('/');
  const options = { owner, repo, mediaType: { format: 'full' }, request: { signal: AbortSignal.timeout(5_000) } };
  if (source.commentId === undefined) {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...options, issue_number: source.number });
    return data as GitHubBody;
  }
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...options, comment_id: source.commentId });
  // A comment ID is repository-wide. Bind it to the requested issue or pull request as well.
  if (typeof (data as GitHubBody).issue_url !== 'string' || !String((data as GitHubBody).issue_url).endsWith(`/issues/${source.number}`)) {
    throw new PreviewMediaError(404, 'ATTACHMENT_NOT_FOUND', 'Comment does not belong to this issue or pull request');
  }
  return data as GitHubBody;
}

function discussionUrl(source: CommentAttachmentSource, htmlUrl: unknown): string {
  if (typeof htmlUrl === 'string') {
    try {
      const parsed = new URL(htmlUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith(`/${source.repository}/`)) return parsed.href;
    } catch { /* Fall back to the issue URL. */ }
  }
  return `https://github.com/${source.repository}/issues/${source.number}`;
}

async function discard(response: globalThis.Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Best-effort response disposal. */ }
}

/** List the user attachments embedded in one issue/PR description or comment. */
export async function listCommentAttachments({ source, octokit }: { source: CommentAttachmentSource; octokit: AttachmentOctokit }): Promise<{
  attachments: CommentAttachment[];
  htmlUrl: string;
}> {
  const data = await readSource(source, octokit);
  return { attachments: parseCommentAttachments(data.body), htmlUrl: discussionUrl(source, data.html_url) };
}

/**
 * Fetch one image attachment through the caller's GitHub credential. Only the
 * pinned GitHub attachment URL and its signed redirect hosts are followed, so
 * this works without ProPR managed storage. Videos are never downloaded.
 */
export async function loadCommentAttachment({
  source, attachmentIndex, attachmentId, token, octokit, fetch: fetcher, maxBytes,
}: LoadCommentAttachmentOptions): Promise<{ attachment: CommentAttachment; contentType: string; body: Buffer; htmlUrl: string }> {
  const data = await readSource(source, octokit);
  const attachments = parseCommentAttachments(data.body);
  const attachment = attachmentId !== undefined
    ? attachments.find(item => item.attachmentId === attachmentId)
    : attachments[attachmentIndex ?? 0];
  if (!attachment) throw new PreviewMediaError(404, 'ATTACHMENT_NOT_FOUND', 'Comment attachment not found');
  const htmlUrl = discussionUrl(source, data.html_url);
  const videoOnly = () => new PreviewMediaError(422, 'PREVIEW_NOT_RENDERABLE', `Video attachments are metadata-only in MCP. Open the comment: ${htmlUrl}`);
  if (attachment.type === 'video') throw videoOnly();

  const target = signedMediaUrl(data.body_html, attachment.attachmentId) ?? new URL(attachment.url);
  const media = await fetchMedia(target, attachment.attachmentId, token, fetcher);
  if (!media.ok) {
    await discard(media);
    throw media.status === 404
      ? new PreviewMediaError(404, 'ATTACHMENT_NOT_FOUND', 'Comment attachment is unavailable')
      : new PreviewMediaError(502, 'PREVIEW_UNAVAILABLE', 'Comment attachment could not be loaded');
  }
  const contentType = media.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (contentType.startsWith('video/')) {
    await discard(media);
    throw videoOnly();
  }
  if (!IMAGE_TYPES.has(contentType)) {
    await discard(media);
    throw new PreviewMediaError(422, 'PREVIEW_NOT_RENDERABLE', 'Comment attachment is not a supported image. Open the comment on GitHub.');
  }
  const limit = maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes < 0
    ? MAX_IMAGE_BYTES : Math.min(MAX_IMAGE_BYTES, Math.floor(maxBytes));
  const body = await boundedBody(media, limit);
  return { attachment: { ...attachment, type: 'image' }, contentType, body, htmlUrl };
}
