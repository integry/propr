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

interface UploadedAttachment {
  originalName: string;
  rawUrl: string;
  type: 'image' | 'text';
}

interface UploadAttachmentsOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  attachments: PlanTaskAttachment[];
  issueNumber: number;
  correlatedLogger: Logger | EnhancedLogger;
}

/**
 * Upload attachments to the repository in a .gitfix/attachments folder.
 * Returns the raw URLs for the uploaded files.
 */
async function uploadAttachmentsToRepo(options: UploadAttachmentsOptions): Promise<UploadedAttachment[]> {
  const { octokit, owner, repoName, attachments, issueNumber, correlatedLogger } = options;
  const uploaded: UploadedAttachment[] = [];

  // Get the default branch for constructing raw URLs
  let defaultBranch = 'main';
  try {
    const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo: repoName
    });
    defaultBranch = repoInfo.data.default_branch || 'main';
  } catch (err) {
    correlatedLogger.warn({ error: (err as Error).message }, 'Failed to get default branch, using "main"');
  }

  for (const attachment of attachments) {
    try {
      const filePath = path.join(process.cwd(), attachment.storedPath);
      const fileExists = await fs.pathExists(filePath);

      if (!fileExists) {
        correlatedLogger.warn({ attachmentId: attachment.id, originalName: attachment.originalName }, 'Attachment file not found');
        continue;
      }

      const fileBuffer = await fs.readFile(filePath);
      const base64Content = fileBuffer.toString('base64');

      // Generate a unique filename to avoid collisions
      const ext = path.extname(attachment.originalName) || (attachment.type === 'image' ? '.webp' : '.txt');
      const baseName = path.basename(attachment.originalName, ext);
      const uniqueFilename = `${baseName}-${attachment.id}${ext}`;
      const repoPath = `.gitfix/attachments/issue-${issueNumber}/${uniqueFilename}`;

      // Upload file to repository
      await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo: repoName,
        path: repoPath,
        message: `Add attachment ${attachment.originalName} for issue #${issueNumber} [skip ci]`,
        content: base64Content
      });

      // Construct raw URL for the uploaded file
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/${defaultBranch}/${repoPath}`;

      uploaded.push({
        originalName: attachment.originalName,
        rawUrl,
        type: attachment.type
      });

      correlatedLogger.info({
        attachmentId: attachment.id,
        originalName: attachment.originalName,
        repoPath,
        rawUrl
      }, 'Attachment uploaded to repository');

    } catch (err) {
      correlatedLogger.error({
        attachmentId: attachment.id,
        originalName: attachment.originalName,
        error: (err as Error).message
      }, 'Failed to upload attachment to repository');
    }
  }

  return uploaded;
}

/**
 * Build a user notes comment body with attachments.
 * Images are embedded using URLs pointing to files uploaded to the repository.
 * Text files are displayed with their content inline as code blocks.
 */
function buildUserNotesCommentBody(
  notes: string | undefined,
  uploadedAttachments: UploadedAttachment[],
  textAttachments: Array<{ originalName: string; content: string; ext: string }>
): string | null {
  if (!notes && uploadedAttachments.length === 0 && textAttachments.length === 0) {
    return null;
  }

  const parts: string[] = [];
  parts.push('## 📝 User Notes\n');

  if (notes && notes.trim()) {
    parts.push(notes.trim());
    parts.push('');
  }

  const hasAttachments = uploadedAttachments.length > 0 || textAttachments.length > 0;
  if (hasAttachments) {
    parts.push('### Attachments\n');

    // Add images (uploaded to repo)
    for (const attachment of uploadedAttachments) {
      if (attachment.type === 'image') {
        parts.push(`**${attachment.originalName}:**`);
        parts.push(`![${attachment.originalName}](${attachment.rawUrl})`);
        parts.push('');
      } else {
        // Non-image files uploaded to repo - show as links
        parts.push(`- 📄 [${attachment.originalName}](${attachment.rawUrl})`);
      }
    }

    // Add text file contents inline
    for (const textFile of textAttachments) {
      parts.push(`**${textFile.originalName}:**`);
      parts.push('```' + textFile.ext);
      parts.push(textFile.content.trim());
      parts.push('```');
      parts.push('');
    }
  }

  const body = parts.join('\n').trim();
  return body || null;
}

/**
 * Read text attachment contents for inline display.
 */
async function readTextAttachmentContents(
  attachments: PlanTaskAttachment[],
  correlatedLogger: Logger | EnhancedLogger
): Promise<Array<{ originalName: string; content: string; ext: string }>> {
  const textContents: Array<{ originalName: string; content: string; ext: string }> = [];

  for (const attachment of attachments) {
    if (attachment.type !== 'text') continue;

    try {
      const filePath = path.join(process.cwd(), attachment.storedPath);
      const fileExists = await fs.pathExists(filePath);

      if (!fileExists) {
        correlatedLogger.warn({ attachmentId: attachment.id, originalName: attachment.originalName }, 'Text attachment file not found');
        continue;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const ext = path.extname(attachment.originalName).toLowerCase().replace('.', '') || 'txt';

      textContents.push({
        originalName: attachment.originalName,
        content,
        ext
      });
    } catch (err) {
      correlatedLogger.error({
        attachmentId: attachment.id,
        originalName: attachment.originalName,
        error: (err as Error).message
      }, 'Failed to read text attachment');
    }
  }

  return textContents;
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
  const hasNotes = task.notes && task.notes.trim();
  const hasAttachments = task.attachments && task.attachments.length > 0;

  if (hasNotes || hasAttachments) {
    let uploadedAttachments: UploadedAttachment[] = [];
    let textAttachments: Array<{ originalName: string; content: string; ext: string }> = [];

    if (task.attachments && task.attachments.length > 0) {
      // Filter image attachments to upload to repository
      const imageAttachments = task.attachments.filter(a => a.type === 'image');

      if (imageAttachments.length > 0) {
        uploadedAttachments = await uploadAttachmentsToRepo({
          octokit,
          owner,
          repoName,
          attachments: imageAttachments,
          issueNumber,
          correlatedLogger
        });
      }

      // Read text file contents for inline display
      textAttachments = await readTextAttachmentContents(task.attachments, correlatedLogger);
    }

    const userNotesCommentBody = buildUserNotesCommentBody(
      task.notes,
      uploadedAttachments,
      textAttachments
    );

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
        attachmentCount: task.attachments?.length || 0,
        uploadedImageCount: uploadedAttachments.length,
        inlineTextFileCount: textAttachments.length
      }, 'User notes comment created');
    }
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
