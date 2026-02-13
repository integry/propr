import { db } from '../db/connection.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
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
 * Build a user notes comment body with embedded attachments.
 * Images are embedded as base64 inline images in markdown.
 * Text files are included as code blocks.
 */
async function buildUserNotesCommentBody(
  notes: string | undefined,
  attachments: PlanTaskAttachment[] | undefined
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

    for (const attachment of attachments) {
      try {
        const filePath = path.join(process.cwd(), attachment.storedPath);
        const fileExists = await fs.pathExists(filePath);

        if (!fileExists) {
          parts.push(`- ⚠️ *${attachment.originalName}* (file not found)`);
          continue;
        }

        if (attachment.type === 'image') {
          // Embed image as base64 inline
          const imageBuffer = await fs.readFile(filePath);
          const base64Image = imageBuffer.toString('base64');
          const mimeType = attachment.mimeType || 'image/webp';
          parts.push(`**${attachment.originalName}:**`);
          parts.push(`![${attachment.originalName}](data:${mimeType};base64,${base64Image})`);
          parts.push('');
        } else {
          // Include text file content as a code block
          const content = await fs.readFile(filePath, 'utf-8');
          const ext = path.extname(attachment.originalName).slice(1) || 'txt';
          parts.push(`**${attachment.originalName}:**`);
          parts.push('```' + ext);
          parts.push(content);
          parts.push('```');
          parts.push('');
        }
      } catch (err) {
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

    let issueBody = task.body || '';

    issueBody += '\n\n---\n*Created by GitFix AI Planner*';

    correlatedLogger.info({
      draftId,
      taskIndex: i + 1,
      taskTitle: task.title
    }, 'Creating issue');

    const response = await octokit.request('POST /repos/{owner}/{repo}/issues', {
      owner,
      repo: repoName,
      title: task.title,
      body: issueBody,
      labels: ['gitfix-planned']
    });

    results.push({
      number: response.data.number,
      url: response.data.html_url,
      title: response.data.title
    });

    // Update the task with issue information
    planJson[i].issue_number = response.data.number;
    planJson[i].issue_url = response.data.html_url;

    correlatedLogger.info({
      draftId,
      issueNumber: response.data.number,
      issueUrl: response.data.html_url
    }, 'Issue created');

    // Create plan_issue record to track this issue
    try {
      await createPlanIssue({
        draft_id: draftId,
        repository: draft.repository,
        issue_number: response.data.number
      });
      correlatedLogger.info({
        draftId,
        issueNumber: response.data.number
      }, 'Plan issue record created');
    } catch (planIssueError) {
      correlatedLogger.warn({
        err: (planIssueError as Error).message,
        draftId,
        issueNumber: response.data.number
      }, 'Failed to create plan issue record, continuing');
    }

    // Post implementation as a separate comment if it exists
    if (task.implementation) {
      const commentBody = '**Suggested Implementation:**\n\n' + task.implementation;

      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: response.data.number,
        body: commentBody
      });

      correlatedLogger.info({
        draftId,
        issueNumber: response.data.number
      }, 'Implementation comment created');
    }

    // Post user notes and attachments as a separate comment if they exist
    const userNotesCommentBody = await buildUserNotesCommentBody(task.notes, task.attachments);
    if (userNotesCommentBody) {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: response.data.number,
        body: userNotesCommentBody
      });

      correlatedLogger.info({
        draftId,
        issueNumber: response.data.number,
        hasNotes: !!task.notes,
        attachmentCount: task.attachments?.length || 0
      }, 'User notes comment created');
    }

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
