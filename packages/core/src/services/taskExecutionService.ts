import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger, { type EnhancedLogger } from '../utils/logger.js';
import { type Logger } from 'pino';
import { createPlanIssue } from '../config/planIssueManager.js';
import { buildUserNotesCommentBody, generateAndSaveTaskTitle, type PlanTaskAttachment } from './taskExecutionHelpers.js';

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

async function createGitHubIssue(options: CreateIssueOptions): Promise<CreatedIssue> {
  const { octokit, owner, repoName, task, draftId, correlatedLogger } = options;

  let issueBody = task.body || '';
  issueBody += '\n\n---\n*Created by ProPR AI Planner*';

  const response = await octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner,
    repo: repoName,
    title: task.title,
    body: issueBody,
    labels: ['propr-planned']
  });

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
}

async function postIssueComments(options: PostIssueCommentsOptions): Promise<void> {
  const { octokit, owner, repoName, issueNumber, task, draftId, correlatedLogger } = options;

  // Post implementation as a separate comment if it exists
  if (task.implementation) {
    const commentBody = '**Suggested Implementation:**\n\n' + task.implementation;

    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo: repoName,
      issue_number: issueNumber,
      body: commentBody
    });

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
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body: userNotesCommentBody
      });

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
}

async function processTaskAndCreateIssue(options: ProcessTaskOptions): Promise<CreatedIssue> {
  const { octokit, owner, repoName, task, taskIndex, draftId, repository, correlatedLogger } = options;

  correlatedLogger.info({
    draftId,
    taskIndex: taskIndex + 1,
    taskTitle: task.title
  }, 'Creating issue');

  const createdIssue = await createGitHubIssue({
    octokit,
    owner,
    repoName,
    task,
    draftId,
    correlatedLogger
  });

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
  await postIssueComments({
    octokit,
    owner,
    repoName,
    issueNumber: createdIssue.number,
    task,
    draftId,
    correlatedLogger
  });

  return createdIssue;
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

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const task = planJson[i];

    const createdIssue = await processTaskAndCreateIssue({
      octokit,
      owner,
      repoName,
      task,
      taskIndex: i,
      draftId,
      repository: draft.repository,
      correlatedLogger
    });

    results.push(createdIssue);

    // Update the task with issue information
    planJson[i].issue_number = createdIssue.number;
    planJson[i].issue_url = createdIssue.url;

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  const existingConfig = typeof draft.context_config === 'string'
    ? JSON.parse(draft.context_config)
    : (draft.context_config || {});

  await db!('task_drafts')
    .where({ draft_id: draftId })
    .update({
      status: 'executed',
      plan_json: JSON.stringify(planJson),
      context_config: JSON.stringify({
        ...existingConfig,
        executionResults: results,
        executedAt: new Date().toISOString()
      }),
      updated_at: db!.fn.now()
    });

  correlatedLogger.info({
    draftId,
    issuesCreated: results.length
  }, 'Draft execution completed');

  return { success: true, results };
}
