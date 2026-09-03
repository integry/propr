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
    authToken: options.authToken,
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
      authToken: options.authToken,
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

    return { html_url: commentUrl, body: response.data.body };
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
