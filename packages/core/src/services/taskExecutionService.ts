import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger, { type EnhancedLogger } from '../utils/logger.js';
import { type Logger } from 'pino';
import { createPlanIssue } from '../config/planIssueManager.js';
import { buildUserNotesCommentBody, generateAndSaveTaskTitle, type PlanTaskAttachment } from './taskExecutionHelpers.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';

// Re-export Epic PR functions from separate module
export {
  ensureEpicPR,
  generateEpicBranchName,
  isEpicBranch,
  EPIC_BRANCH_PATTERN,
  type EpicPRResult,
  type EnsureEpicPROptions
} from './epicPRService.js';

export interface IssueLink {
  number: number;
  url: string;
  title: string;
}

export interface ExecutionResult {
  success: boolean;
  alreadyExecuted?: boolean;
  results?: IssueLink[];
}

interface TaskDraft {
  draft_id: string;
  user_id: string;
  repository: string;
  name: string;
  initial_prompt: string;
  plan_json: string | PlanTask[];
  context_config: string | Record<string, unknown>;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface PlanTask {
  id?: string;
  title: string;
  body: string;
  implementation: string;
  notes?: string;
  attachments?: PlanTaskAttachment[];
  issue_number?: number;
  issue_url?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface CreateIssueOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  task: PlanTask;
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
}

interface CreatedIssue {
  number: number;
  url: string;
  title: string;
}

async function createGitHubIssue(options: CreateIssueOptions & { correlationId?: string }): Promise<CreatedIssue> {
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

interface PostIssueCommentsOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  issueNumber: number;
  task: PlanTask;
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
  correlationId?: string;
}

// Retry config for comments - GitHub can have propagation delays after issue creation
const commentRetryConfig = {
  ...retryConfigs.githubApi,
  maxAttempts: 4,
  baseDelay: 2000, // Start with 2s delay to allow GitHub propagation
};

async function postIssueComments(options: PostIssueCommentsOptions): Promise<void> {
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

interface ValidatedDraftData {
  draft: TaskDraft;
  planJson: PlanTask[];
  owner: string;
  repoName: string;
  isReFinalization: boolean;
}

const RE_FINALIZABLE_STATUSES = ['approved', 'executed', 'pr_created', 'merged', 'failed'];

async function validateAndPrepareDraft(
  draftId: string,
  userId: string,
  correlatedLogger: Logger | EnhancedLogger
): Promise<ValidatedDraftData> {
  if (!db) {
    throw new Error('Database not available');
  }

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();

  if (!draft) {
    throw new Error('Draft not found');
  }

  if (draft.user_id !== userId) {
    throw new Error('Unauthorized');
  }

  const isReFinalization = RE_FINALIZABLE_STATUSES.includes(draft.status);

  if (draft.status !== 'review' && !isReFinalization) {
    throw new Error(`Draft must be in 'review' status to execute. Current status: ${draft.status}`);
  }

  // For re-finalization, detach existing issues first
  if (isReFinalization) {
    correlatedLogger.info({ draftId, previousStatus: draft.status }, 'Re-finalizing draft, detaching existing issues');
    const deletedCount = await db('plan_issues').where({ draft_id: draftId }).delete();
    correlatedLogger.info({ draftId, deletedCount }, 'Detached existing plan issues');
  }

  const planJson: PlanTask[] = typeof draft.plan_json === 'string'
    ? JSON.parse(draft.plan_json)
    : draft.plan_json;

  if (!Array.isArray(planJson) || planJson.length === 0) {
    throw new Error('Draft has no tasks to execute');
  }

  // For re-finalization, clear old issue references from plan tasks
  if (isReFinalization) {
    for (const task of planJson) {
      delete task.issue_number;
      delete task.issue_url;
    }
  }

  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repository format: ${draft.repository}`);
  }

  return { draft, planJson, owner, repoName, isReFinalization };
}

interface ProcessTaskOptions {
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

interface ProcessTaskResult {
  success: boolean;
  issue?: CreatedIssue;
  error?: string;
}

async function processTaskAndCreateIssue(options: ProcessTaskOptions): Promise<ProcessTaskResult> {
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

export async function executeDraft(draftId: string, userId: string, correlationId?: string): Promise<ExecutionResult> {
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  correlatedLogger.info({ draftId }, 'Starting draft execution');

  const { draft, planJson, owner, repoName } = await validateAndPrepareDraft(draftId, userId, correlatedLogger);

  try {
    await generateAndSaveTaskTitle({
      draftId,
      planJson,
      owner,
      repoName,
      oldName: draft.name,
      correlationId,
      db
    });
  } catch (err) {
    correlatedLogger.warn({ err: (err as Error).message }, 'Failed to generate task title, keeping original name');
  }

  const octokit = await getAuthenticatedOctokit();
  const results: IssueLink[] = [];
  const failures: Array<{ taskIndex: number; title: string; error: string }> = [];

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const task = planJson[i];

    const result = await processTaskAndCreateIssue({
      octokit,
      owner,
      repoName,
      task,
      taskIndex: i,
      draftId,
      repository: draft.repository,
      correlatedLogger,
      correlationId
    });

    if (result.success && result.issue) {
      results.push(result.issue);
      // Update the task with issue information
      planJson[i].issue_number = result.issue.number;
      planJson[i].issue_url = result.issue.url;
    } else {
      failures.push({
        taskIndex: i,
        title: task.title,
        error: result.error || 'Unknown error'
      });
      correlatedLogger.warn({
        draftId,
        taskIndex: i + 1,
        taskTitle: task.title,
        error: result.error
      }, 'Task failed, continuing with remaining tasks');
    }

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  // Only avoid spreading context_config - extract specific fields safely
  let baseBranch: unknown, granularity: unknown, contextLevel: unknown, compress: unknown,
      manualFiles: unknown, autoFiles: unknown, contextRepositories: unknown, generationModel: unknown;

  if (typeof draft.context_config === 'string') {
    try {
      const parsed = JSON.parse(draft.context_config);
      baseBranch = parsed.baseBranch;
      granularity = parsed.granularity;
      contextLevel = parsed.contextLevel;
      compress = parsed.compress;
      manualFiles = parsed.manualFiles;
      autoFiles = parsed.autoFiles;
      contextRepositories = parsed.contextRepositories;
      generationModel = parsed.generationModel;
    } catch {
      // Ignore parse errors
    }
  } else if (draft.context_config) {
    const config = draft.context_config as Record<string, unknown>;
    baseBranch = config.baseBranch;
    granularity = config.granularity;
    contextLevel = config.contextLevel;
    compress = config.compress;
    manualFiles = config.manualFiles;
    autoFiles = config.autoFiles;
    contextRepositories = config.contextRepositories;
    generationModel = config.generationModel;
  }

  const updatedConfig: Record<string, unknown> = {
    baseBranch,
    granularity,
    contextLevel,
    compress,
    manualFiles,
    autoFiles,
    contextRepositories,
    generationModel,
    executionResults: results,
    executedAt: new Date().toISOString()
  };

  if (failures.length > 0) {
    updatedConfig.executionFailures = failures;
  }

  await db!('task_drafts')
    .where({ draft_id: draftId })
    .update({
      status: 'executed',
      plan_json: JSON.stringify(planJson),
      context_config: JSON.stringify(updatedConfig),
      updated_at: db!.fn.now()
    });

  correlatedLogger.info({
    draftId,
    issuesCreated: results.length,
    issuesFailed: failures.length
  }, 'Draft execution completed');

  return { success: results.length > 0, results };
}
