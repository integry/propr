import { githubInlineEligibility, VISUAL_PREVIEW_CONTENT_TYPES, type GitHubAttachmentCapacity } from '@propr/shared';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { publicPreviewText, originalUnavailableText } from './visualPreviewPublication.js';
import { storeManagedVisualPreviewOriginals, type ManagedVisualPreviewAssetResult } from './managedVisualPreviewStorage.js';
import {
  appendVisualPreviewSection,
  createPublishedVisualPreviewMetadata,
  isSupportedVisualPreviewUploadToken,
  isVisualPreviewCredentialError,
  markVisualPreviewOAuthCredentialReauthRequired,
  renderVisualPreviewSection,
  redactVisualPreviewPaths,
  resolveVisualPreviewUploadToken as resolveStoredVisualPreviewUploadToken,
  trustedGitHubAttachmentUrl,
  VisualPreviewCredentialError,
  VISUAL_PREVIEW_UPLOAD_TOKEN_ENV,
  type VisualPreviewEvidence
} from '@propr/core';

interface VisualPreviewAssetUploadOptions {
  capacity?: GitHubAttachmentCapacity;
  absolutePath: string;
  authToken: string;
  repositoryId: number;
}

export type VisualPreviewAssetUploader = (options: VisualPreviewAssetUploadOptions) => Promise<string>;

export { VISUAL_PREVIEW_UPLOAD_TOKEN_ENV };

export class VisualPreviewUploadAuthenticationError extends Error {
  readonly code = 'VISUAL_PREVIEW_AUTH_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'VisualPreviewUploadAuthenticationError';
  }
}

export function isVisualPreviewUploadAuthenticationError(error: unknown): boolean {
  return isVisualPreviewCredentialError(error) || error instanceof VisualPreviewUploadAuthenticationError || (
    error instanceof Error
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as { code: string }).code.startsWith('VISUAL_PREVIEW_AUTH_')
  );
}

/**
 * GitHub's user-attachment endpoint does not accept GitHub App installation
 * tokens. Keep this credential separate from the installation token used for
 * normal API requests and git operations.
 */
export async function resolveVisualPreviewUploadToken(
  environment?: NodeJS.ProcessEnv
): Promise<string> {
  if (!environment) return resolveStoredVisualPreviewUploadToken();
  const token = environment[VISUAL_PREVIEW_UPLOAD_TOKEN_ENV]?.trim();
  if (token && isSupportedVisualPreviewUploadToken(token)) return token;
  if (token) {
    throw new VisualPreviewCredentialError(
      'VISUAL_PREVIEW_AUTH_UNSUPPORTED',
      `${VISUAL_PREVIEW_UPLOAD_TOKEN_ENV} is not a GitHub OAuth or personal access token supported by attachment uploads.`,
    );
  }

  throw new VisualPreviewCredentialError(
    'VISUAL_PREVIEW_AUTH_MISSING',
    `${VISUAL_PREVIEW_UPLOAD_TOKEN_ENV} is not configured; GitHub attachment uploads require `
    + 'an OAuth token, classic personal access token, or fine-grained personal access token '
    + 'for a user with write access to the repository. GitHub App installation tokens cannot upload attachments.'
  );
}

async function validateAttachmentFile(absolutePath: string, capacity?: GitHubAttachmentCapacity): Promise<number> {
  const contentType = VISUAL_PREVIEW_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported visual preview attachment type: ${path.basename(absolutePath)}`);
  let size: number;
  try { size = (await stat(absolutePath)).size; }
  catch { throw new Error('Visual preview source is unavailable'); }
  const eligibility = githubInlineEligibility(contentType, size, capacity);
  if (!eligibility.eligible) {
    if (eligibility.reason === 'size-limit-exceeded') throw new Error(`Visual preview exceeds the GitHub attachment limit of ${eligibility.limitBytes / (1024 * 1024)} MiB`);
    throw new Error(`Invalid visual preview attachment: ${eligibility.reason}`);
  }
  return eligibility.limitBytes;
}

async function markRejectedUploadCredential(): Promise<void> {
  try {
    await markVisualPreviewOAuthCredentialReauthRequired('github_rejected_token');
  } catch {
    // Preserve the original upload error. The Settings status can recover
    // once database access is restored.
  }
}

export const uploadVisualPreviewAsset: VisualPreviewAssetUploader = async ({
  absolutePath,
  authToken,
  repositoryId,
  capacity,
}) => {
  const contentType = VISUAL_PREVIEW_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported visual preview attachment type: ${path.basename(absolutePath)}`);

  const limit = await validateAttachmentFile(absolutePath, capacity);
  let body: Buffer;
  try { body = await readFile(absolutePath); }
  catch { throw new Error('Visual preview source is unavailable'); }
  if (body.byteLength > limit) throw new Error('Visual preview grew beyond the GitHub attachment limit');
  const uploadUrl = new URL('https://uploads.github.com/user-attachments/assets');
  uploadUrl.searchParams.set('name', path.basename(absolutePath));
  uploadUrl.searchParams.set('content_type', contentType);
  uploadUrl.searchParams.set('repository_id', String(repositoryId));

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${authToken}`,
        'Content-Length': String(body.byteLength),
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'ProPR',
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error('GitHub visual preview upload is unavailable');
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Discard best-effort: cancellation failure must not expose or replace the upload error.
    }
    const message = response.status === 404
      ? `GitHub could not upload ${path.basename(absolutePath)} because the token owner does not have write access to the repository`
      : `GitHub could not upload ${path.basename(absolutePath)} (HTTP ${response.status})`;
    if (response.status === 401) await markRejectedUploadCredential();
    if ([401, 403, 404].includes(response.status)) throw new VisualPreviewUploadAuthenticationError(message);
    throw new Error(message);
  }

  const payload = await response.json() as { url?: unknown };
  const attachmentUrl = trustedGitHubAttachmentUrl(payload.url);
  if (!attachmentUrl) {
    throw new Error('GitHub uploaded a visual preview but did not return a valid attachment URL');
  }
  return attachmentUrl;
};

interface BaseVisualPreviewPublicationOptions {
  taskId?: string;
  pullRequestNumber: number;
  owner: string;
  repo: string;
  body: string;
  evidence: VisualPreviewEvidence;
  /** Optional injection used by callers with an already-resolved upload credential. */
  authToken?: string;
  worktreePath: string;
  uploadAsset?: VisualPreviewAssetUploader;
  storeOriginals?: typeof storeManagedVisualPreviewOriginals;
  trustedConnectOrigin?: string;
}

async function storeOriginalsSafely(options: BaseVisualPreviewPublicationOptions): Promise<ManagedVisualPreviewAssetResult[]> {
  try {
    return await (options.storeOriginals ?? storeManagedVisualPreviewOriginals)(options.evidence, {
      taskId: options.taskId ?? options.evidence.taskId ?? '',
      repository: `${options.owner}/${options.repo}`,
      pullRequestNumber: options.pullRequestNumber,
    });
  } catch {
    // Optional original storage must never interrupt GitHub attachment publication.
    return [];
  }
}

function assertUploadedBodyHasNoLocalPaths(body: unknown, evidence: VisualPreviewEvidence): asserts body is string {
  if (typeof body !== 'string') {
    throw new Error('GitHub uploaded visual previews but did not return the published body');
  }
  const leakedPath = evidence.assets.find(asset => body.includes(asset.absolutePath)
    || body.includes(asset.absolutePath.replaceAll(' ', '%20')));
  if (leakedPath || redactVisualPreviewPaths(body) !== body) {
    throw new Error('GitHub did not replace a local visual preview path with an uploaded attachment URL');
  }
}

function assertUploadedBodyContainsUrls(body: string, uploadedUrls: readonly string[]): void {
  const missingUrl = uploadedUrls.find(url => !body.includes(url));
  if (missingUrl) throw new Error('GitHub published a visual preview comment without every uploaded attachment URL');
}

async function resolveRepositoryId(options: BaseVisualPreviewPublicationOptions & { octokit: PublishPullRequestVisualPreviewOptions['octokit'] }): Promise<number> {
  const response = await options.octokit.request<{ data: { id?: unknown } }>('GET /repos/{owner}/{repo}', {
    owner: options.owner,
    repo: options.repo,
  });
  const repositoryId = response.data.id;
  if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('Could not determine which GitHub repository should own the visual preview attachments');
  }
  return repositoryId;
}

interface InlineCandidate {
  assetIndex: number;
  limitBytes: number;
}

/** Revalidate all staged files before any GitHub request, then select only compliant inline media. */
async function resolveInlineCandidates(evidence: VisualPreviewEvidence): Promise<InlineCandidate[]> {
  const candidates: InlineCandidate[] = [];
  for (const [assetIndex, asset] of evidence.assets.entries()) {
    const contentType = VISUAL_PREVIEW_CONTENT_TYPES[path.extname(asset.absolutePath).toLowerCase()];
    if (!contentType) throw new Error(`Unsupported visual preview attachment type: ${path.basename(asset.absolutePath)}`);
    const eligibility = githubInlineEligibility(contentType, (await stat(asset.absolutePath)).size, evidence.githubAttachmentCapacity);
    if (eligibility.eligible) candidates.push({ assetIndex, limitBytes: eligibility.limitBytes });
    else if (eligibility.reason !== 'size-limit-exceeded') throw new Error(`Invalid visual preview attachment: ${eligibility.reason}`);
  }
  return candidates;
}

function trustedConnectOrigin(options: BaseVisualPreviewPublicationOptions): string {
  return options.trustedConnectOrigin ?? (process.env.PROPR_CONNECT_URL ?? 'https://connect.propr.dev').trim();
}

function publishedBody(
  options: BaseVisualPreviewPublicationOptions,
  originals: readonly ManagedVisualPreviewAssetResult[],
  inlineCandidates: readonly InlineCandidate[],
  uploads: { uploadedUrls: ReadonlyMap<number, string>; uploadFailures: ReadonlyMap<number, unknown> },
): string {
  const { uploadedUrls, uploadFailures } = uploads;
  const candidates = new Set(inlineCandidates.map(candidate => candidate.assetIndex));
  const originalsByIndex = new Map(originals.map(result => [result.assetIndex, result]));
  const metadata = createPublishedVisualPreviewMetadata(options.evidence, {
    taskId: options.taskId ?? options.evidence.taskId ?? '',
    repository: `${options.owner}/${options.repo}`,
    pullRequestNumber: options.pullRequestNumber,
    trustedConnectOrigin: trustedConnectOrigin(options),
    assets: options.evidence.assets.map((asset, assetIndex) => {
      const original = originalsByIndex.get(assetIndex);
      const failure = uploadFailures.get(assetIndex);
      return {
        assetIndex,
        relativePath: asset.relativePath,
        ...(uploadedUrls.get(assetIndex) ? { githubAttachmentUrl: uploadedUrls.get(assetIndex) } : {}),
        ...(original?.stored && original.version === 1 && original.relativePath === asset.relativePath
          && Date.parse(original.artifact.retentionExpiresAt) > Date.now()
          ? { managedOriginal: original.artifact }
          : {}),
        ...(!candidates.has(assetIndex)
          ? { unavailableReason: 'github-inline-limit' as const }
          : failure
            ? { unavailableReason: isVisualPreviewUploadAuthenticationError(failure)
              ? 'github-authentication-failed' as const
              : 'github-inline-failed' as const }
            : {}),
      };
    }),
  });
  const publicEvidence = {
    ...options.evidence,
    assets: options.evidence.assets.map((asset, assetIndex) => {
      const original = originalsByIndex.get(assetIndex);
      const published = metadata.assets.find(item => item.assetIndex === assetIndex);
      const notes = asset.description ? [asset.description] : [];
      if (published?.managedViewerUrl && original?.stored) {
        notes.push(`Connect sign-in required. Original retained until ${new Date(original.artifact.retentionExpiresAt).toISOString()}.`);
      } else if (original || options.evidence.originalCapacity?.source === 'managed-storage') {
        notes.push(originalUnavailableText(original));
      }
      if (!uploadedUrls.has(assetIndex)) {
        notes.push('Inline preview unavailable: GitHub size limits or upload failure. No preview files were committed.');
      }
      return {
        ...asset,
        title: publicPreviewText(asset.title, options.evidence),
        description: notes.length ? publicPreviewText(notes.join('\n\n'), options.evidence) : undefined,
      };
    }),
    toolSuggestions: options.evidence.toolSuggestions.map(suggestion => ({
      name: publicPreviewText(suggestion.name, options.evidence),
      reason: publicPreviewText(suggestion.reason, options.evidence),
    })),
  };
  return appendVisualPreviewSection(
    publicPreviewText(options.body, options.evidence),
    renderVisualPreviewSection(publicEvidence, { published: metadata }),
  );
}

async function uploadInlineCandidates(
  options: BaseVisualPreviewPublicationOptions & { octokit: PublishPullRequestVisualPreviewOptions['octokit'] },
  inlineCandidates: readonly InlineCandidate[],
): Promise<{ uploadedUrls: Map<number, string>; uploadFailures: Map<number, unknown> }> {
  const uploadedUrls = new Map<number, string>();
  const uploadFailures = new Map<number, unknown>();
  if (inlineCandidates.length === 0) return { uploadedUrls, uploadFailures };
  let authToken: string;
  let repositoryId: number;
  try {
    [authToken, repositoryId] = await Promise.all([
      options.authToken ? Promise.resolve(options.authToken) : resolveVisualPreviewUploadToken(),
      resolveRepositoryId(options),
    ]);
  } catch (error) {
    for (const { assetIndex } of inlineCandidates) uploadFailures.set(assetIndex, error);
    return { uploadedUrls, uploadFailures };
  }
  const uploader = options.uploadAsset ?? uploadVisualPreviewAsset;
  for (const { assetIndex } of inlineCandidates) {
    const asset = options.evidence.assets[assetIndex];
    try {
      const uploadedUrl = await uploader({
        absolutePath: asset.absolutePath,
        authToken,
        repositoryId,
        ...(options.evidence.githubAttachmentCapacity ? { capacity: options.evidence.githubAttachmentCapacity } : {}),
      });
      const trustedUrl = trustedGitHubAttachmentUrl(uploadedUrl);
      if (!trustedUrl) throw new Error('GitHub did not return a valid visual preview attachment URL');
      uploadedUrls.set(assetIndex, trustedUrl);
    } catch (error) {
      uploadFailures.set(assetIndex, error);
    }
  }
  return { uploadedUrls, uploadFailures };
}

export interface PublishPullRequestVisualPreviewOptions extends BaseVisualPreviewPublicationOptions {
  pullRequestNumber: number;
  octokit: {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
  };
}

export async function publishPullRequestVisualPreviews(options: PublishPullRequestVisualPreviewOptions): Promise<void> {
  if (options.evidence.assets.length === 0) return;
  const originals = await storeOriginalsSafely(options);
  const inlineCandidates = await resolveInlineCandidates(options.evidence);
  const uploads = await uploadInlineCandidates(options, inlineCandidates);
  const body = publishedBody(options, originals, inlineCandidates, uploads);
  const response = await options.octokit.request<{ data: { body?: string } }>('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: options.owner,
    repo: options.repo,
    pull_number: options.pullRequestNumber,
    body,
  });
  assertUploadedBodyHasNoLocalPaths(response.data.body, options.evidence);
  assertUploadedBodyContainsUrls(response.data.body!, [...uploads.uploadedUrls.values()]);
}

export interface PublishPullRequestCommentVisualPreviewOptions extends BaseVisualPreviewPublicationOptions {
  pullRequestNumber: number;
  octokit: {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
  };
  startingCommentId: number;
}

export interface PublishedVisualPreviewComment {
  html_url: string;
  body: string;
}

export async function publishPullRequestCommentVisualPreviews(
  options: PublishPullRequestCommentVisualPreviewOptions
): Promise<PublishedVisualPreviewComment> {
  if (options.evidence.assets.length === 0) {
    throw new Error('Cannot publish an attachment comment without preview assets');
  }
  const originals = await storeOriginalsSafely(options);
  const inlineCandidates = await resolveInlineCandidates(options.evidence);
  const uploads = await uploadInlineCandidates(options, inlineCandidates);
  const body = publishedBody(options, originals, inlineCandidates, uploads);
  const updatedStartingComment = await options.octokit.request<{ data: { html_url: string; body?: string } }>(
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
    {
      owner: options.owner,
      repo: options.repo,
      comment_id: options.startingCommentId,
      body,
    }
  );
  assertUploadedBodyHasNoLocalPaths(updatedStartingComment.data.body, options.evidence);
  assertUploadedBodyContainsUrls(updatedStartingComment.data.body, [...uploads.uploadedUrls.values()]);

  return {
    html_url: updatedStartingComment.data.html_url,
    body: updatedStartingComment.data.body,
  };
}
