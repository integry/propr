import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import type { Logger } from 'pino';
import type { EnhancedLogger } from '../utils/logger.js';
import { createPlanIssue } from '../config/planIssueManager.js';
import { buildUserNotesCommentBody, type PlanTaskAttachment } from './taskExecutionHelpers.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';

export interface PlanTask {
  id?: string;
  title: string;
  body: string;
  implementation: string;
  notes?: string;
  attachments?: PlanTaskAttachment[];
  issue_number?: number;
  issue_url?: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
  title: string;
}

export interface CreateIssueOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  task: PlanTask;
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
  correlationId?: string;
}

export interface PostIssueCommentsOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  issueNumber: number;
  task: PlanTask;
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
  correlationId?: string;
}

export interface ProcessTaskOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  task: PlanTask;
  taskIndex: number;
  draftId: string;
  repository: string;
  correlatedLogger: Logger | EnhancedLogger;
  correlationId?: string;
}

export interface ProcessTaskResult {
  success: boolean;
  issue?: CreatedIssue;
  error?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry config for comments - GitHub can have propagation delays after issue creation
const commentRetryConfig = {
  ...retryConfigs.githubApi,
  maxAttempts: 4,
  baseDelay: 2000, // Start with 2s delay to allow GitHub propagation
};

export async function createGitHubIssue(options: CreateIssueOptions): Promise<CreatedIssue> {
  const { octokit, owner, repoName, task, draftId, correlatedLogger, correlationId } = options;

  let issueBody = task.body || '';
  issueBody += '\n\n---\n*Created by ProPR AI Planner*';

  const response = await withRetry(
    () => octokit.request('POST /repos/{owner}/{repo}/issues', {
      owner,
      repo: repoName,
      title: task.title,
      body: issueBody,
      labels: ['propr-planned']
    }),
    { ...retryConfigs.githubApi, correlationId },
    `create_issue_${owner}/${repoName}`
  );

  correlatedLogger.info({
    draftId,
    issueNumber: response.data.number,
    issueUrl: response.data.html_url
  }, 'Issue created');

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title
  };
}

export async function postIssueComments(options: PostIssueCommentsOptions): Promise<void> {
  const { octokit, owner, repoName, issueNumber, task, draftId, correlatedLogger, correlationId } = options;

  // Post implementation as a separate comment if it exists
  if (task.implementation) {
    const commentBody = '**Suggested Implementation:**\n\n' + task.implementation;

    await withRetry(
      () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body: commentBody
      }),
      { ...commentRetryConfig, correlationId },
      `post_implementation_comment_${issueNumber}`
    );

    correlatedLogger.info({
      draftId,
      issueNumber
    }, 'Implementation comment created');
  }

  // Post user notes and attachments as a separate comment if they exist
  const hasNotes = task.notes && task.notes.trim();
  const hasAttachments = task.attachments && task.attachments.length > 0;

  if (hasNotes || hasAttachments) {
    // Build comment body with images using direct URLs and linked text files
    // Files remain on the server and are not committed to the repository
    const userNotesCommentBody = buildUserNotesCommentBody({
      notes: task.notes,
      attachments: task.attachments || [],
      draftId,
      correlatedLogger
    });

    if (userNotesCommentBody) {
      await withRetry(
        () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          owner,
          repo: repoName,
          issue_number: issueNumber,
          body: userNotesCommentBody
        }),
        { ...commentRetryConfig, correlationId },
        `post_notes_comment_${issueNumber}`
      );

      correlatedLogger.info({
        draftId,
        issueNumber,
        hasNotes: !!task.notes,
        attachmentCount: task.attachments?.length || 0
      }, 'User notes comment created');
    }
  }
}

export async function processTaskAndCreateIssue(options: ProcessTaskOptions): Promise<ProcessTaskResult> {
  const { octokit, owner, repoName, task, taskIndex, draftId, repository, correlatedLogger, correlationId } = options;

  correlatedLogger.info({
    draftId,
    taskIndex: taskIndex + 1,
    taskTitle: task.title
  }, 'Creating issue');

  let createdIssue: CreatedIssue;
  try {
    createdIssue = await createGitHubIssue({
      octokit,
      owner,
      repoName,
      task,
      draftId,
      correlatedLogger,
      correlationId
    });
  } catch (issueError) {
    correlatedLogger.error({
      draftId,
      taskIndex: taskIndex + 1,
      taskTitle: task.title,
      error: (issueError as Error).message
    }, 'Failed to create GitHub issue after retries');
    return { success: false, error: `Failed to create issue: ${(issueError as Error).message}` };
  }

  // Create plan_issue record to track this issue
  try {
    await createPlanIssue({
      draft_id: draftId,
      repository,
      issue_number: createdIssue.number
    });
    correlatedLogger.info({
      draftId,
      issueNumber: createdIssue.number
    }, 'Plan issue record created');
  } catch (planIssueError) {
    correlatedLogger.warn({
      err: (planIssueError as Error).message,
      draftId,
      issueNumber: createdIssue.number
    }, 'Failed to create plan issue record, continuing');
  }

  // Post implementation and user notes comments
  // Small delay to allow GitHub to propagate the issue
  await sleep(500);

  try {
    await postIssueComments({
      octokit,
      owner,
      repoName,
      issueNumber: createdIssue.number,
      task,
      draftId,
      correlatedLogger,
      correlationId
    });
  } catch (commentError) {
    // Issue was created successfully, but comments failed - log but don't fail the whole task
    correlatedLogger.warn({
      draftId,
      issueNumber: createdIssue.number,
      error: (commentError as Error).message
    }, 'Failed to post comments after retries, issue was created successfully');
  }

  return { success: true, issue: createdIssue };
}
