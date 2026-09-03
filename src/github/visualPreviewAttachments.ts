import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import {
  appendVisualPreviewSection,
  isSupportedVisualPreviewUploadToken,
  isVisualPreviewCredentialError,
  markVisualPreviewOAuthCredentialReauthRequired,
  redactSecrets,
  renderVisualPreviewSection,
  resolveVisualPreviewUploadToken as resolveStoredVisualPreviewUploadToken,
  VisualPreviewCredentialError,
  VISUAL_PREVIEW_UPLOAD_TOKEN_ENV,
  type VisualPreviewEvidence
} from '@propr/core';

interface AttachmentCommandOptions {
  args: string[];
  authToken: string;
  cwd: string;
}

export type AttachmentCommandRunner = (options: AttachmentCommandOptions) => Promise<{ stdout: string }>;

interface VisualPreviewAssetUploadOptions {
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

const runAttachmentCommand: AttachmentCommandRunner = async ({ args, authToken, cwd }) => {
  try {
    const result = await execa('gh', args, {
      cwd,
      env: {
        ...process.env,
        GH_TOKEN: authToken,
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1'
      },
      reject: true,
      timeout: 60_000
    });
    return { stdout: result.stdout };
  } catch (error) {
    const commandError = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
    const detail = commandError.code === 'ENOENT'
      ? 'gh executable was not found in PATH'
      : typeof commandError.stderr === 'string' && commandError.stderr.trim()
        ? redactSecrets(commandError.stderr.trim()).replace(/\s+/g, ' ').slice(0, 1000)
        : '';
    const message = `GitHub CLI could not upload visual preview attachments${detail ? `: ${detail}` : ''}`;
    const authFailure = /unsupported authentication type|bad credentials|authentication failed|http 401|requires authentication|not logged in/i.test(detail);
    if (authFailure) {
      try {
        await markVisualPreviewOAuthCredentialReauthRequired('github_rejected_token');
      } catch {
        // Preserve the original upload error. The Settings status can recover
        // once database access is restored.
      }
    }
    const wrappedError = (authFailure
      ? new VisualPreviewUploadAuthenticationError(message)
      : new Error(message)) as Error & { stdout?: string };
    const stdout = commandError.stdout;
    if (typeof stdout === 'string') wrappedError.stdout = stdout;
    throw wrappedError;
  }
};

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

async function responseErrorDetail(response: Response): Promise<string> {
  const rawBody = redactSecrets((await response.text()).trim()).replace(/\s+/g, ' ').slice(0, 1000);
  if (!rawBody) return '';
  try {
    const parsed = JSON.parse(rawBody) as { message?: unknown; errors?: unknown };
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((error): error is string => typeof error === 'string').join('; ')
      : '';
    return [message, errors].filter(Boolean).join('; ');
  } catch {
    return rawBody;
  }
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
}) => {
  const contentType = CONTENT_TYPE_BY_EXTENSION[path.extname(absolutePath).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported visual preview attachment type: ${path.basename(absolutePath)}`);

  const body = await readFile(absolutePath);
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
  } catch (error) {
    throw new Error(`GitHub could not upload ${path.basename(absolutePath)}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const detail = await responseErrorDetail(response);
    const suffix = detail ? `: ${detail}` : '';
    const message = response.status === 404
      ? `GitHub could not upload ${path.basename(absolutePath)} because the token owner does not have write access to the repository${suffix}`
      : `GitHub could not upload ${path.basename(absolutePath)} (HTTP ${response.status})${suffix}`;
    if (response.status === 401) await markRejectedUploadCredential();
    if ([401, 403, 404].includes(response.status)) throw new VisualPreviewUploadAuthenticationError(message);
    throw new Error(message);
  }

  const payload = await response.json() as { url?: unknown };
  if (typeof payload.url !== 'string' || !payload.url.startsWith('https://github.com/user-attachments/')) {
    throw new Error('GitHub uploaded a visual preview but did not return a valid attachment URL');
  }
  return payload.url;
};

interface BaseVisualPreviewPublicationOptions {
  owner: string;
  repo: string;
  body: string;
  evidence: VisualPreviewEvidence;
  /** Optional injection used by callers with an already-resolved upload credential. */
  authToken?: string;
  worktreePath: string;
  runCommand?: AttachmentCommandRunner;
  uploadAsset?: VisualPreviewAssetUploader;
}

function attachmentArguments(evidence: VisualPreviewEvidence): string[] {
  return evidence.assets.flatMap(asset => ['--attach', asset.absolutePath]);
}

function bodyWithLocalPreviews(options: BaseVisualPreviewPublicationOptions): string {
  const section = renderVisualPreviewSection(options.evidence, {
    useLocalPaths: true
  });
  return appendVisualPreviewSection(options.body, section);
}

function bodyWithUploadedPreviews(options: BaseVisualPreviewPublicationOptions, uploadedUrls: readonly string[]): string {
  if (uploadedUrls.length !== options.evidence.assets.length) {
    throw new Error('GitHub did not return an attachment URL for every visual preview');
  }
  const evidence = {
    ...options.evidence,
    assets: options.evidence.assets.map((asset, index) => ({
      ...asset,
      absolutePath: uploadedUrls[index],
    })),
  };
  return appendVisualPreviewSection(options.body, renderVisualPreviewSection(evidence, { useLocalPaths: true }));
}

function assertUploadedBodyHasNoLocalPaths(body: unknown, evidence: VisualPreviewEvidence): asserts body is string {
  if (typeof body !== 'string') {
    throw new Error('GitHub uploaded visual previews but did not return the published body');
  }
  const leakedPath = evidence.assets.find(asset => body.includes(asset.absolutePath)
    || body.includes(asset.absolutePath.replaceAll(' ', '%20')));
  if (leakedPath) {
    throw new Error('GitHub did not replace a local visual preview path with an uploaded attachment URL');
  }
}

function assertUploadedBodyContainsUrls(body: string, uploadedUrls: readonly string[]): void {
  const missingUrl = uploadedUrls.find(url => !body.includes(url));
  if (missingUrl) throw new Error('GitHub published a visual preview comment without every uploaded attachment URL');
}

async function resolveRepositoryId(options: PublishPullRequestCommentVisualPreviewOptions): Promise<number> {
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

export interface PublishPullRequestVisualPreviewOptions extends BaseVisualPreviewPublicationOptions {
  pullRequestNumber: number;
  octokit: {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
  };
}

export async function publishPullRequestVisualPreviews(options: PublishPullRequestVisualPreviewOptions): Promise<void> {
  if (options.evidence.assets.length === 0) return;
  const runner = options.runCommand || runAttachmentCommand;
  await runner({
    args: [
      'pr', 'edit', String(options.pullRequestNumber),
      '--repo', `${options.owner}/${options.repo}`,
      '--body', bodyWithLocalPreviews(options),
      ...attachmentArguments(options.evidence)
    ],
    authToken: options.authToken ?? await resolveVisualPreviewUploadToken(),
    cwd: options.worktreePath
  });
  const response = await options.octokit.request<{ data: { body?: string } }>('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: options.owner,
    repo: options.repo,
    pull_number: options.pullRequestNumber
  });
  assertUploadedBodyHasNoLocalPaths(response.data.body, options.evidence);
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
  const authToken = options.authToken ?? await resolveVisualPreviewUploadToken();
  const repositoryId = await resolveRepositoryId(options);
  const uploader = options.uploadAsset ?? uploadVisualPreviewAsset;
  const uploadedUrls: string[] = [];
  for (const asset of options.evidence.assets) {
    uploadedUrls.push(await uploader({
      absolutePath: asset.absolutePath,
      authToken,
      repositoryId,
    }));
  }

  const body = bodyWithUploadedPreviews(options, uploadedUrls);
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
  assertUploadedBodyContainsUrls(updatedStartingComment.data.body, uploadedUrls);

  return {
    html_url: updatedStartingComment.data.html_url,
    body: updatedStartingComment.data.body,
  };
}
