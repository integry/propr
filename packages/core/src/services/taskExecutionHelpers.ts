import type { Logger } from 'pino';
import type { EnhancedLogger } from '../utils/logger.js';
import type { Knex } from 'knex';
import logger from '../utils/logger.js';
import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';

export interface PlanTaskAttachment {
  id: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  size: number;
  tokenEstimate: number;
  type: 'image' | 'text';
}

interface BuildUserNotesOptions {
  notes: string | undefined;
  attachments: PlanTaskAttachment[];
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
}

/**
 * Get the public base URL for attachments.
 * Uses API_PUBLIC_URL since attachments are served by the API.
 * Falls back to WEB_UI_URL or FRONTEND_URL for backwards compatibility.
 */
function getAttachmentBaseUrl(): string {
  if (process.env.API_PUBLIC_URL) {
    return process.env.API_PUBLIC_URL;
  }
  // Fallback to frontend URL (for local development where API is proxied)
  const fallbackUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL;
  if (fallbackUrl) return fallbackUrl;
  throw new Error('API_PUBLIC_URL, WEB_UI_URL, or FRONTEND_URL must be set to link attachments');
}

/**
 * Format an attachment as a download link.
 * Returns a markdown link to the attachment.
 * Note: Direct embedding of remote images doesn't work in GitHub, so all
 * attachments (including images) are rendered as download links.
 */
function linkAttachment(
  attachment: PlanTaskAttachment,
  draftId: string,
  correlatedLogger: Logger | EnhancedLogger
): string {
  const baseUrl = getAttachmentBaseUrl();
  const attachmentUrl = `${baseUrl}/api/planner/drafts/${draftId}/attachments/${attachment.id}`;

  correlatedLogger.info({
    attachmentId: attachment.id,
    originalName: attachment.originalName,
    attachmentUrl
  }, 'Linked attachment in comment');

  const lines = [
    `**${attachment.originalName}:** [Download](${attachmentUrl})`,
    ''
  ];
  return lines.join('\n');
}

/**
 * Process a single attachment and return its markdown representation.
 * All attachments are rendered as download links since GitHub doesn't
 * support direct embedding of remote images.
 */
function processAttachment(
  attachment: PlanTaskAttachment,
  draftId: string,
  correlatedLogger: Logger | EnhancedLogger
): string | null {
  try {
    return linkAttachment(attachment, draftId, correlatedLogger);
  } catch (err) {
    correlatedLogger.error({
      attachmentId: attachment.id,
      originalName: attachment.originalName,
      error: (err as Error).message
    }, 'Failed to process attachment');
    return null;
  }
}

/**
 * Cleans a generated title by removing markdown formatting, quotes, and prefixes.
 * Ensures the title is plain text suitable for display.
 */
export function cleanGeneratedTitle(title: string): string {
  let cleaned = title;
  cleaned = cleaned.replace(/^#+\s*/, '');
  cleaned = cleaned.replace(/^title:\s*/i, '');
  cleaned = cleaned.replace(/^["'`]|["'`]$/g, '');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');
  cleaned = cleaned.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');
  cleaned = cleaned.replace(/^[*_#`]+|[*_#`]+$/g, '');
  cleaned = cleaned.trim();
  return cleaned;
}

/**
 * Build a user notes comment body with attachments.
 * All attachments are rendered as download links to the attachment endpoint.
 * Note: Direct embedding of remote images doesn't work in GitHub.
 */
export function buildUserNotesCommentBody(options: BuildUserNotesOptions): string | null {
  const { notes, attachments, draftId, correlatedLogger } = options;

  if (!notes && attachments.length === 0) {
    return null;
  }

  const parts: string[] = [];
  parts.push('## 📝 User Notes\n');

  if (notes && notes.trim()) {
    parts.push(notes.trim());
    parts.push('');
  }

  if (attachments.length > 0) {
    parts.push('### Attachments\n');

    for (const attachment of attachments) {
      const attachmentMarkdown = processAttachment(attachment, draftId, correlatedLogger);
      if (attachmentMarkdown) {
        parts.push(attachmentMarkdown);
      }
    }
  }

  const body = parts.join('\n').trim();
  return body || null;
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

export interface GenerateTitleOptions {
  draftId: string;
  planJson: PlanTask[];
  owner: string;
  repoName: string;
  oldName: string;
  correlationId?: string;
  db: Knex | null;
}

/**
 * Build a title generation prompt that explicitly includes all task titles.
 * Extracted for testability.
 */
export function buildTitlePrompt(planJson: PlanTask[]): string {
  const taskTitles = planJson
    .map((task, index) => `${index + 1}. ${task.title}`)
    .join('\n');

  return `Generate a short, descriptive title (5-8 words) for this epic/plan that reflects ALL of the following task titles.

STRICT FORMATTING RULES:
- Output ONLY the title text, nothing else
- Do NOT use markdown formatting (no **, __, *, _, or # symbols)
- Do NOT wrap the title in quotes
- Do NOT prefix with "Title:" or any other label
- Plain text only

Task Titles:
${taskTitles}

Title (plain text only):`;
}

export async function generateAndSaveTaskTitle(options: GenerateTitleOptions): Promise<void> {
  const { draftId, planJson, owner, repoName, oldName, correlationId, db } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const githubToken = await getGitHubInstallationToken();
  const repoUrl = `https://github.com/${owner}/${repoName}.git`;

  const worktreePath = await ensureRepoCloned({
    repoUrl,
    owner,
    repoName,
    authToken: githubToken
  });

  const prompt = buildTitlePrompt(planJson);

  correlatedLogger.info({ draftId }, 'Generating task title via LLM');

  // Build metadata for LLM log tracking
  const titleGenerationMetadata = {
    planTaskCount: planJson.length,
    promptLength: prompt.length,
    oldName,
  };

  const generatedTitle = await runLightweightLLMAnalysis({
    prompt,
    model: 'haiku',
    correlationId: correlationId || 'finalize-title-gen',
    worktreePath,
    githubToken,
    issueRef: { number: 0, repoOwner: owner, repoName },
    taskId: draftId,
    executionType: 'title-generation',
    metadata: titleGenerationMetadata
  });

  const cleanTitle = cleanGeneratedTitle(generatedTitle);
  if (cleanTitle && db) {
    await db('task_drafts')
      .where({ draft_id: draftId })
      .update({ name: cleanTitle });

    correlatedLogger.info({ draftId, oldName, newName: cleanTitle }, 'Updated task title');
  }
}
