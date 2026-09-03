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

interface BaseVisualPreviewPublicationOptions {
  owner: string;
  repo: string;
  body: string;
  evidence: VisualPreviewEvidence;
  /** Optional injection used by callers with an already-resolved upload credential. */
  authToken?: string;
  worktreePath: string;
  runCommand?: AttachmentCommandRunner;
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

function parseCommentId(url: string): number | null {
  const match = url.match(/#issuecomment-(\d+)\b/);
  return match ? Number(match[1]) : null;
}

export async function publishPullRequestCommentVisualPreviews(
  options: PublishPullRequestCommentVisualPreviewOptions
): Promise<PublishedVisualPreviewComment> {
  if (options.evidence.assets.length === 0) {
    throw new Error('Cannot publish an attachment comment without preview assets');
  }
  const runner = options.runCommand || runAttachmentCommand;
  let publishedCommentId: number | null = null;
  try {
    const result = await runner({
      args: [
        'pr', 'comment', String(options.pullRequestNumber),
        '--repo', `${options.owner}/${options.repo}`,
        '--body', bodyWithLocalPreviews(options),
        ...attachmentArguments(options.evidence)
      ],
      authToken: options.authToken ?? await resolveVisualPreviewUploadToken(),
      cwd: options.worktreePath
    });
    const commentUrl = result.stdout.trim().split('\n').find(line => line.includes('#issuecomment-')) || result.stdout.trim();
    if (!commentUrl) throw new Error('GitHub CLI uploaded previews but did not return a comment URL');
    publishedCommentId = parseCommentId(commentUrl);
    if (!publishedCommentId) throw new Error('GitHub CLI uploaded previews but did not return a comment ID');

    const response = await options.octokit.request<{ data: { body?: string } }>('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: options.owner,
      repo: options.repo,
      comment_id: publishedCommentId
    });
    assertUploadedBodyHasNoLocalPaths(response.data.body, options.evidence);

    const updatedStartingComment = await options.octokit.request<{ data: { html_url: string; body?: string } }>(
      'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
      {
        owner: options.owner,
        repo: options.repo,
        comment_id: options.startingCommentId,
        body: response.data.body
      }
    );

    try {
      await options.octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: options.owner,
        repo: options.repo,
        comment_id: publishedCommentId
      });
    } catch {
      // The bot-owned completion comment is already updated. Leaving the
      // temporary uploader comment is preferable to losing the preview.
    }

    return {
      html_url: updatedStartingComment.data.html_url,
      body: updatedStartingComment.data.body || response.data.body
    };
  } catch (error) {
    publishedCommentId ||= parseCommentId(typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : '');
    if (publishedCommentId) {
      try {
        await options.octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner: options.owner,
          repo: options.repo,
          comment_id: publishedCommentId
        });
      } catch {
        // Best-effort cleanup; the caller replaces the work comment with a
        // text-only explanation that contains no local filesystem paths.
      }
    }
    throw error;
  }
}
