import { db } from '../db/connection.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger, { type EnhancedLogger } from '../utils/logger.js';
import { type Logger } from 'pino';
import { ensureRepoCloned } from '../git/repoManager.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { createPlanIssue } from '../config/planIssueManager.js';
import fs from 'fs-extra';
import path from 'path';

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

interface PlanTaskAttachment {
  id: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  size: number;
  tokenEstimate: number;
  type: 'image' | 'text';
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

/**
 * Build a user notes comment body with attachments.
 * Images are embedded directly using markdown image syntax with the dashboard URL.
 * Text files are displayed as links to the dashboard.
 */
async function buildUserNotesCommentBody(
  notes: string | undefined,
  attachments: PlanTaskAttachment[] | undefined,
  draftId: string
): Promise<string | null> {
  if (!notes && (!attachments || attachments.length === 0)) {
    return null;
  }

  const parts: string[] = [];
  parts.push('## 📝 User Notes\n');

  if (notes && notes.trim()) {
    parts.push(notes.trim());
    parts.push('');
  }

  if (attachments && attachments.length > 0) {
    parts.push('### Attachments\n');

    // Get the base URL for attachment links
    const baseUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    const apiBaseUrl = process.env.API_BASE_URL || baseUrl.replace(/:\d+$/, ':4000');

    for (const attachment of attachments) {
      try {
        const filePath = path.join(process.cwd(), attachment.storedPath);
        const fileExists = await fs.pathExists(filePath);

        if (!fileExists) {
          parts.push(`- ⚠️ *${attachment.originalName}* (file not found)`);
          continue;
        }

        // Build the attachment URL
        const attachmentUrl = `${apiBaseUrl}/api/planner/drafts/${draftId}/attachments/${attachment.id}`;

        if (attachment.type === 'image') {
          // Embed image directly using markdown image syntax
          parts.push(`**${attachment.originalName}:**`);
          parts.push(`![${attachment.originalName}](${attachmentUrl})`);
          parts.push('');
        } else {
          // Display as a link for non-image files
          parts.push(`- 📄 [${attachment.originalName}](${attachmentUrl})`);
        }
      } catch {
        parts.push(`- ⚠️ *${attachment.originalName}* (error reading file)`);
      }
    }
  }

  const body = parts.join('\n').trim();
  return body || null;
}

interface GenerateTitleOptions {
  draftId: string;
  planJson: PlanTask[];
  owner: string;
  repoName: string;
  oldName: string;
  correlationId?: string;
}

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
  issueBody += '\n\n---\n*Created by GitFix AI Planner*';

  const response = await octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner,
    repo: repoName,
    title: task.title,
    body: issueBody,
    labels: ['gitfix-planned']
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
  const userNotesCommentBody = await buildUserNotesCommentBody(task.notes, task.attachments, draftId);
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

async function generateAndSaveTaskTitle(options: GenerateTitleOptions): Promise<void> {
  const { draftId, planJson, owner, repoName, oldName, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const githubToken = await getGitHubInstallationToken();
  const repoUrl = `https://github.com/${owner}/${repoName}.git`;

  const worktreePath = await ensureRepoCloned({
    repoUrl,
    owner,
    repoName,
    authToken: githubToken
  });

  const planSummary = JSON.stringify(planJson).substring(0, 3000);
  const prompt = `Generate a short, descriptive title (5-8 words) for this task based on the following plan:\n\n${planSummary}\n\nTitle:`;

  correlatedLogger.info({ draftId }, 'Generating task title via LLM');

  // Build metadata for LLM log tracking
  const titleGenerationMetadata = {
    planTaskCount: planJson.length,
    planSummaryLength: planSummary.length,
    oldName,
  };

  const generatedTitle = await runLightweightLLMAnalysis({
    prompt,
    model: 'haiku',
    correlationId: correlationId || 'finalize-title-gen',
    worktreePath,
    githubToken,
    issueRef: { number: 0, repoOwner: owner, repoName },
    executionType: 'title-generation',
    metadata: titleGenerationMetadata
  });

  const cleanTitle = generatedTitle.replace(/^"|"$/g, '').trim();
  if (cleanTitle && db) {
    await db('task_drafts')
      .where({ draft_id: draftId })
      .update({ name: cleanTitle });

    correlatedLogger.info({ draftId, oldName, newName: cleanTitle }, 'Updated task title');
  }
}

export async function executeDraft(draftId: string, userId: string, correlationId?: string): Promise<ExecutionResult> {
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) {
    throw new Error('Database not available');
  }

  correlatedLogger.info({ draftId }, 'Starting draft execution');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();

  if (!draft) {
    throw new Error('Draft not found');
  }

  if (draft.user_id !== userId) {
    throw new Error('Unauthorized');
  }

  if (draft.status === 'executed') {
    correlatedLogger.info({ draftId }, 'Draft already executed');
    return { success: true, alreadyExecuted: true };
  }

  if (draft.status !== 'review') {
    throw new Error(`Draft must be in 'review' status to execute. Current status: ${draft.status}`);
  }

  const planJson: PlanTask[] = typeof draft.plan_json === 'string'
    ? JSON.parse(draft.plan_json)
    : draft.plan_json;

  if (!Array.isArray(planJson) || planJson.length === 0) {
    throw new Error('Draft has no tasks to execute');
  }

  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repository format: ${draft.repository}`);
  }

  try {
    await generateAndSaveTaskTitle({
      draftId,
      planJson,
      owner,
      repoName,
      oldName: draft.name,
      correlationId
    });
  } catch (err) {
    correlatedLogger.warn({ err: (err as Error).message }, 'Failed to generate task title, keeping original name');
  }

  const octokit = await getAuthenticatedOctokit();
  const results: IssueLink[] = [];

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const task = planJson[i];

    correlatedLogger.info({
      draftId,
      taskIndex: i + 1,
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

    results.push(createdIssue);

    // Update the task with issue information
    planJson[i].issue_number = createdIssue.number;
    planJson[i].issue_url = createdIssue.url;

    // Create plan_issue record to track this issue
    try {
      await createPlanIssue({
        draft_id: draftId,
        repository: draft.repository,
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

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  const existingConfig = typeof draft.context_config === 'string'
    ? JSON.parse(draft.context_config)
    : (draft.context_config || {});

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update({
      status: 'executed',
      plan_json: JSON.stringify(planJson),
      context_config: JSON.stringify({
        ...existingConfig,
        executionResults: results,
        executedAt: new Date().toISOString()
      }),
      updated_at: db.fn.now()
    });

  correlatedLogger.info({ 
    draftId, 
    issuesCreated: results.length 
  }, 'Draft execution completed');

  return { success: true, results };
}
