import { execa } from 'execa';
import {
  appendVisualPreviewSection,
  renderVisualPreviewSection,
  type VisualPreviewEvidence
} from '@propr/core';

interface AttachmentCommandOptions {
  args: string[];
  authToken: string;
  cwd: string;
}

export type AttachmentCommandRunner = (options: AttachmentCommandOptions) => Promise<{ stdout: string }>;

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
    const wrappedError = new Error('GitHub CLI could not upload visual preview attachments') as Error & { stdout?: string };
    const stdout = (error as { stdout?: unknown })?.stdout;
    if (typeof stdout === 'string') wrappedError.stdout = stdout;
    throw wrappedError;
  }
};

interface BaseVisualPreviewPublicationOptions {
  owner: string;
  repo: string;
  commitHash: string;
  body: string;
  evidence: VisualPreviewEvidence;
  authToken: string;
  worktreePath: string;
  runCommand?: AttachmentCommandRunner;
}

function attachmentArguments(evidence: VisualPreviewEvidence): string[] {
  return evidence.assets.flatMap(asset => ['--attach', asset.absolutePath]);
}

function bodyWithLocalPreviews(options: BaseVisualPreviewPublicationOptions): string {
  const section = renderVisualPreviewSection(options.evidence, {
    owner: options.owner,
    repo: options.repo,
    commitHash: options.commitHash,
    useLocalPaths: true
  });
  return appendVisualPreviewSection(options.body, section);
}

export interface PublishPullRequestVisualPreviewOptions extends BaseVisualPreviewPublicationOptions {
  pullRequestNumber: number;
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
    authToken: options.authToken,
    cwd: options.worktreePath
  });
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
  let result: { stdout: string };
  try {
    result = await runner({
      args: [
        'pr', 'comment', String(options.pullRequestNumber),
        '--repo', `${options.owner}/${options.repo}`,
        '--body', bodyWithLocalPreviews(options),
        ...attachmentArguments(options.evidence)
      ],
      authToken: options.authToken,
      cwd: options.worktreePath
    });
  } catch (error) {
    const partialCommentId = parseCommentId(typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : '');
    if (partialCommentId) {
      try {
        await options.octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner: options.owner,
          repo: options.repo,
          comment_id: partialCommentId
        });
      } catch {
        // Best-effort cleanup; the caller still publishes the complete fallback.
      }
    }
    throw error;
  }

  const commentUrl = result.stdout.trim().split('\n').find(line => line.includes('#issuecomment-')) || result.stdout.trim();
  if (!commentUrl) throw new Error('GitHub CLI uploaded previews but did not return a comment URL');

  let publishedBody = options.body;
  const commentId = parseCommentId(commentUrl);
  if (commentId) {
    try {
      const response = await options.octokit.request<{ data: { body?: string } }>('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: options.owner,
        repo: options.repo,
        comment_id: commentId
      });
      publishedBody = response.data.body || publishedBody;
    } catch {
      // The attachment comment itself is authoritative; body retrieval is only
      // used to enrich task history with GitHub's rewritten attachment URLs.
    }
  }

  try {
    await options.octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: options.owner,
      repo: options.repo,
      comment_id: options.startingCommentId
    });
  } catch {
    // The attached completion comment is already published. Leaving the
    // transient work comment is preferable to posting the completion twice.
  }

  return { html_url: commentUrl, body: publishedBody };
}
