import type { Logger } from 'pino';
import type { EnhancedLogger } from '../utils/logger.js';

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
 * Falls back to WEB_UI_URL or FRONTEND_URL with /api prefix for backwards compatibility.
 */
function getAttachmentBaseUrl(): string {
  // API_PUBLIC_URL is the public URL for the API (e.g., https://pr-741-api.gitfix.dev)
  if (process.env.API_PUBLIC_URL) {
    return process.env.API_PUBLIC_URL;
  }
  // Fallback to frontend URL (for local development where API is proxied)
  return process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://api.gitfix.dev';
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
